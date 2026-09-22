#!/usr/bin/env node
// tools/probar-club.mjs — Crunchy Club fase 1 contra STAGING (20260930000004):
//   - reglas: base 'neto', 0.1 puntos por peso, 1 punto = $0.30;
//   - consumidor: un pedido de producto + $80 de envío genera floor(0.1 × producto) al pasar a Pagado,
//     entregado o no; repetir no vuelve a sumar; «Cancelado» revierte todo lo generado;
//   - tienda: Pagado no genera; Entregado sí (no pagan en línea; la entrega va con el pago);
//   - el panel de reglas de la app guarda base 'neto'.
// El saldo se lee como la app: obtener_cliente_con_stats con la sesión del cliente.
// Necesita `node tools/ver-en-staging.mjs`. Uso: node tools/probar-club.mjs
import { HTML, APP, PANEL } from './fuentes.mjs';
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging') { console.error('No es staging: ' + SUPABASE_URL); process.exit(1); }
const H = { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' };
const SIN_CONEXION = ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'];
const conReintento = async (fn) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 4 || !SIN_CONEXION.includes(e?.cause?.code)) throw e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); } } };
const rpc = async (n, b) => { const r = await conReintento(() => fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })); return { status: r.status, json: await r.json().catch(() => null) }; };
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

// 1. Reglas.
const cfg = (await rpc('get_lealtad_config', {})).json;
ok(cfg?.generacion?.base === 'neto' && Number(cfg?.generacion?.puntos_por_peso) === 0.1 && Number(cfg?.redencion?.valor_punto_mxn) === 0.3,
  `reglas: base ${cfg?.generacion?.base}, ${cfg?.generacion?.puntos_por_peso} puntos por peso, punto a $${cfg?.redencion?.valor_punto_mxn}`);

// 2. Pedido de consumidor con envío de paquetería.
const ana = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000001', pin: '1234' } })).json;
const tel = '556' + String(Date.now()).slice(-7);
const ses = (await rpc('emitir_sesion_prueba', { p_telefono: tel })).json;
// crear_pedido no da de alta al cliente: sin id_cliente, el pedido nunca genera puntos.
const alta = (await rpc('registrar_o_actualizar_cliente', { p_data: { telefono: tel, nombre: 'Consumidor Club', tipo: 'Consumidor', tipoId: 1, direccion: 'Calle 1', cp: '03400', colonia: 'Álamos', municipio: 'Benito Juárez', estado: 'CDMX', coordenadas: '' } })).json;
const prod = (await (await fetch(`${SUPABASE_URL}/rest/v1/productos?select=id,sabor,presentacion,precio_consumidor&limit=1&order=id`, { headers: H })).json())[0];
const precio = Number(prod.precio_consumidor), esperados = Math.floor(0.1 * precio);
const ped = (await rpc('crear_pedido', { p_data: { tokenCliente: ses?.token, idCliente: alta?.idCliente, nombre: 'Consumidor Club', telefono: tel, cp: '03400', colonia: 'Álamos', direccion: 'Calle 1', zonaEntrega: 'foraneo', metodoEntrega: 'paqueteria', total: precio + 80,
  productos: [{ idProducto: String(prod.id), sabor: prod.sabor, presentacion: prod.presentacion, tipoVenta: 'Por Pieza', cantidad: 1, gramos: 0, precio, subtotal: precio }], idempotencyKey: 'club-' + tel } })).json;
ok(!!ana?.token && !!alta?.idCliente && ped?.ok === true, `pedido ${ped?.consecutivo}: producto $${precio} + envío $80 = $${precio + 80}; se esperan ${esperados} puntos`);

const saldo = async () => {
  const r = (await rpc('obtener_cliente_con_stats', { p_telefono: tel, p_token: ses?.token })).json;
  return r?.existe === true && typeof r.puntos === 'number' ? r.puntos : NaN;   // NaN = no se pudo leer: falla
};
const estatus = (campos) => rpc('actualizar_estatus_pedido', { p_data: { token: ana?.token, idOrden: String(ped?.idOrden ?? ped?.id ?? ped?.consecutivo), actualizadoPor: 'probar-club', ...campos } });

ok((await saldo()) === 0, 'cliente nuevo con saldo 0');
await estatus({ estatusPago: 'Pagado' });
const s1 = await saldo(); ok(s1 === esperados, `consumidor Pagado sin entregar → ${s1} puntos (esperado ${esperados}, sin el envío)`);
await estatus({ estatusPedido: 'Entregado' });
const s2 = await saldo(); ok(s2 === esperados, `y luego Entregado → ${s2} (no vuelve a sumar)`);
await estatus({ estatusPago: 'Pagado' });
const s3 = await saldo(); ok(s3 === esperados, `«Pagado» otra vez → ${s3} (no vuelve a sumar)`);
await estatus({ estatusPedido: 'Cancelado' });
const s4 = await saldo(); ok(s4 === 0, `Cancelado → ${s4} puntos (se revierte todo)`);

// Historial que ve el cliente en Crunchy Club (mis_puntos).
const mp = (await rpc('mis_puntos', { p_token: ses?.token })).json;
const gen = (mp?.movimientos || []).find(m => m.tipo === 'generacion' && m.consecutivo === ped?.consecutivo);
const rev = (mp?.movimientos || []).find(m => m.tipo === 'reversion' && m.consecutivo === ped?.consecutivo);
ok(mp?.ok === true && mp.saldo === s4 && gen?.puntos === esperados && Number(gen?.monto) === precio && rev?.puntos === -esperados,
  `mis_puntos: saldo ${mp?.saldo} = ${s4}; ${ped?.consecutivo} +${gen?.puntos} sobre $${gen?.monto}, cancelación ${rev?.puntos}`);
const ajena = (await rpc('mis_puntos', { p_token: 'token-que-no-existe' })).json;
ok(ajena?.ok === false && /Sesión/.test(ajena?.error || '') && !ajena?.movimientos, `sesión inválida → ${ajena?.error}`);

// Tienda aprobada: puntos al entregar, no al pagar.
const telT = '555' + String(Date.now()).slice(-7);
const altaT = (await rpc('registrar_o_actualizar_cliente', { p_data: { telefono: telT, nombre: 'Tienda Club', tipo: 'Tienda / Abarrotes', tipoId: 3, direccion: 'Calle 1', cp: '03400', colonia: 'Álamos', municipio: 'Benito Juárez', estado: 'CDMX', coordenadas: '', aprobadoB2B: false } })).json;
const apr = (await rpc('aprobar_cliente_b2b', { p_id_cliente: Number(altaT?.idCliente), p_aprobar: true, p_actor: 'probar-club', p_token: ana?.token })).json;
const sesT = (await rpc('emitir_sesion_prueba', { p_telefono: telT })).json;
const prodT = (await (await fetch(`${SUPABASE_URL}/rest/v1/productos?select=id,sabor,presentacion,precio_tienda&limit=1&order=id`, { headers: H })).json())[0];
const precioT = Number(prodT.precio_tienda), esperadosT = Math.floor(0.1 * precioT);
const pedT = (await rpc('crear_pedido', { p_data: { tokenCliente: sesT?.token, idCliente: altaT?.idCliente, nombre: 'Tienda Club', telefono: telT, cp: '03400', colonia: 'Álamos', total: precioT, metodoEntrega: 'coordinar',
  productos: [{ idProducto: String(prodT.id), sabor: prodT.sabor, presentacion: prodT.presentacion, tipoVenta: 'Por Pieza', cantidad: 1, gramos: 0, precio: precioT, subtotal: precioT }], idempotencyKey: 'clubt-' + telT } })).json;
ok(!!altaT?.idCliente && !apr?.error && pedT?.ok === true, `tienda ${pedT?.consecutivo || JSON.stringify(pedT).slice(0, 60)}: $${precioT}; se esperan ${esperadosT} puntos al entregar`);
const saldoT = async () => { const r = (await rpc('obtener_cliente_con_stats', { p_telefono: telT, p_token: sesT?.token })).json; return r?.existe === true && typeof r.puntos === 'number' ? r.puntos : NaN; };
const estatusT = (campos) => rpc('actualizar_estatus_pedido', { p_data: { token: ana?.token, idOrden: String(pedT?.idOrden), actualizadoPor: 'probar-club', ...campos } });
await estatusT({ estatusPago: 'Pagado' });
const t1 = await saldoT(); ok(t1 === 0, `tienda Pagado sin entregar → ${t1} puntos (esperado 0)`);
await estatusT({ estatusPedido: 'Entregado' });
const t2 = await saldoT(); ok(t2 === esperadosT, `tienda Entregado → ${t2} puntos (esperado ${esperadosT})`);
await rpc('aprobar_cliente_b2b', { p_id_cliente: Number(altaT?.idCliente), p_aprobar: false, p_actor: 'probar-club', p_token: ana?.token });

// 3. El panel de reglas de la app guarda la base neta: se lee del archivo, no se supone.
ok(PANEL.includes("generacion: { activo: true, base: 'neto', puntos_por_peso: num('cfg-ppp') },"), "panel.js: el panel de reglas guarda base 'neto'");
ok(APP.includes("supabaseCall('POST', 'rpc/mis_puntos', { p_token: tokenCliente() })") && HTML.includes('id="club-movs"'), 'app.js: Crunchy Club pide mis_puntos con la sesión del cliente; index.html: dónde pintarlo');

console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en orden.');
process.exitCode = fallos ? 1 : 0;
