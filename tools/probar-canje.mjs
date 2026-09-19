#!/usr/bin/env node
// tools/probar-canje.mjs — Tienda de canje del Crunchy Club contra STAGING (20260930000006).
// Reglas de Abraham: solo piezas canjeables, precio en puntos = precio_consumidor ÷ valor del punto hacia
// arriba a la decena; nunca un pedido solo de canje; máximo 5 piezas; el servidor decide los puntos; el
// asiento va en la misma transacción; al cancelar, lo generado se revierte solo y lo canjeado queda en
// una solicitud que solo el dueño (o el agente) resuelve.
// Necesita `node tools/ver-en-staging.mjs`. Uso: node tools/probar-canje.mjs
import { readFileSync } from 'node:fs';
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging') { console.error('No es staging: ' + SUPABASE_URL); process.exit(1); }
const H = { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' };
const SIN_CONEXION = ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET'];
const conReintento = async (fn) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 5 || !SIN_CONEXION.includes(e?.cause?.code)) throw e; await new Promise(r => setTimeout(r, 2000 * (i + 1))); } } };
const rpc = async (n, b) => { const r = await conReintento(() => fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })); return { status: r.status, json: await r.json().catch(() => null) }; };
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

const ana = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000001', pin: '1234' } })).json;
const carla = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000003', pin: '1234' } })).json;
const cfg = (await rpc('get_lealtad_config', {})).json;
const valor = Number(cfg?.redencion?.valor_punto_mxn);

// 1. Catálogo con la fórmula del servidor.
const cat = (await rpc('canje_catalogo', {})).json;
const prodsRaw = (await conReintento(async () => (await fetch(`${SUPABASE_URL}/rest/v1/productos?select=id,sabor,presentacion,precio_consumidor,canje_activo&order=id`, { headers: H })).json()));
const prods = Array.isArray(prodsRaw) ? prodsRaw : [];
const c0 = (cat?.productos || [])[0];
if (!c0 || !prods.length) {
  ok(false, `sin catálogo de canje: ${JSON.stringify(cat).slice(0, 90)} · productos: ${JSON.stringify(prodsRaw).slice(0, 90)}`);
  console.log(`
${fallos} fallo(s).`); process.exit(1);
}
const p0 = prods.find(p => p.id === c0?.id);
ok(cat?.ok === true && cat.maxPiezas === 5 && !!c0 && c0.puntos === Math.ceil(Number(p0.precio_consumidor) / valor / 10) * 10,
  `canje_catalogo: ${cat?.productos?.length} productos; ${c0?.sabor} ${c0?.presentacion} $${p0?.precio_consumidor} → ${c0?.puntos} pts (valor $${valor})`);
ok((cat?.productos || []).every(c => prods.find(p => p.id === c.id)?.canje_activo), 'todo lo del catálogo tiene canje_activo');

// Cliente con puntos: un pedido grande pagado.
const alta = async (tel, nombre) => {
  const ses = (await rpc('emitir_sesion_prueba', { p_telefono: tel })).json;
  const a = (await rpc('registrar_o_actualizar_cliente', { p_data: { telefono: tel, nombre, tipo: 'Consumidor', tipoId: 1, direccion: 'Calle 1', cp: '03400', colonia: 'Álamos', municipio: 'Benito Juárez', estado: 'CDMX', coordenadas: '' } })).json;
  return { tel, token: ses?.token, id: a?.idCliente };
};
const cli = await alta('554' + String(Date.now()).slice(-7), 'Consumidor Canje');
const prod = prods.find(p => p.id === c0?.id);
const precio = Number(prod.precio_consumidor);
const linea = (p, n) => ({ idProducto: String(p.id), sabor: p.sabor, presentacion: p.presentacion, tipoVenta: 'Por Pieza', cantidad: n, gramos: 0, precio: Number(p.precio_consumidor), subtotal: Number(p.precio_consumidor) * n });
const canje = (c, n) => ({ idProducto: String(c.id), sabor: c.sabor, presentacion: c.presentacion, tipoVenta: 'Por Pieza', cantidad: n, gramos: 0, precio: 0, subtotal: 0, canje: true, puntos: c.puntos });
const base = (c) => ({ tokenCliente: c.token, idCliente: c.id, nombre: 'Consumidor Canje', telefono: c.tel, cp: '03400', colonia: 'Álamos', direccion: 'Calle 1', metodoEntrega: 'coordinar' });
const saldo = async (c) => (await rpc('mis_puntos', { p_token: c.token })).json;
const pagar = (idOrden) => rpc('actualizar_estatus_pedido', { p_data: { token: ana?.token, idOrden: String(idOrden), estatusPago: 'Pagado', actualizadoPor: 'probar-canje' } });

const piezasFondo = Math.ceil((c0.puntos * 3) / (0.1 * precio)) + 1;
const fondo = (await rpc('crear_pedido', { p_data: { ...base(cli), total: precio * piezasFondo, productos: [linea(prod, piezasFondo)], idempotencyKey: 'canje-fondo-' + cli.tel } })).json;
await pagar(fondo?.idOrden);
const s0 = (await saldo(cli))?.saldo;
ok(fondo?.ok === true && s0 >= c0.puntos * 3, `cliente con saldo: ${fondo?.consecutivo} de ${piezasFondo} piezas pagado → ${s0} pts`);

// 2. Reglas que rechazan.
const solo = (await rpc('crear_pedido', { p_data: { ...base(cli), total: 0, puntosCanje: c0.puntos, productos: [canje(c0, 1)], idempotencyKey: 'canje-solo-' + cli.tel } })).json;
ok(solo?.ok === false && solo?.error === 'canje_sin_compra', `solo canje → ${solo?.error}`);
const seis = (await rpc('crear_pedido', { p_data: { ...base(cli), total: precio, puntosCanje: c0.puntos * 6, productos: [linea(prod, 1), canje(c0, 6)], idempotencyKey: 'canje-seis-' + cli.tel } })).json;
ok(seis?.ok === false && seis?.error === 'canje_maximo', `6 piezas de canje → ${seis?.error}`);
const trampa = (await rpc('crear_pedido', { p_data: { ...base(cli), total: precio, puntosCanje: 10, productos: [linea(prod, 1), { ...canje(c0, 1), puntos: 10 }], idempotencyKey: 'canje-trampa-' + cli.tel } })).json;
ok(trampa?.ok === false && trampa?.error === 'puntos_cambiados' && trampa?.puntosCorrectos === c0.puntos, `puntos manipulados (10) → ${trampa?.error}, correctos ${trampa?.puntosCorrectos}`);
const pobre = await alta('553' + String(Date.now()).slice(-7), 'Consumidor Sin Puntos');
const sinSaldo = (await rpc('crear_pedido', { p_data: { ...base(pobre), total: precio, puntosCanje: c0.puntos, productos: [linea(prod, 1), canje(c0, 1)], idempotencyKey: 'canje-pobre-' + pobre.tel } })).json;
ok(sinSaldo?.ok === false && sinSaldo?.error === 'saldo_insuficiente', `sin saldo → ${sinSaldo?.error} (saldo ${sinSaldo?.saldo}, pide ${sinSaldo?.puntos})`);
const s1 = (await saldo(cli))?.saldo;
ok(s1 === s0, `los rechazos no tocaron el saldo (${s1})`);

// 3. Canje válido: 1 pieza pagada + 2 canjeadas.
const key = 'canje-ok-' + cli.tel;
const bueno = (await rpc('crear_pedido', { p_data: { ...base(cli), total: precio, puntosCanje: c0.puntos * 2, productos: [linea(prod, 1), canje(c0, 2)], idempotencyKey: key } })).json;
const s2 = await saldo(cli);
const mov = (s2?.movimientos || []).find(m => m.tipo === 'canje' && m.consecutivo === bueno?.consecutivo);
ok(bueno?.ok === true && bueno.total === precio && bueno.puntosCanjeados === c0.puntos * 2 && s2?.saldo === s0 - c0.puntos * 2 && mov?.puntos === -c0.puntos * 2,
  `canje válido ${bueno?.consecutivo}: total $${bueno?.total} (solo lo pagado), −${bueno?.puntosCanjeados} pts, saldo ${s0} → ${s2?.saldo}`);
const doble = (await rpc('crear_pedido', { p_data: { ...base(cli), total: precio, puntosCanje: c0.puntos * 2, productos: [linea(prod, 1), canje(c0, 2)], idempotencyKey: key } })).json;
const s3 = (await saldo(cli))?.saldo;
ok(doble?.duplicado === true && s3 === s2?.saldo, `doble envío → duplicado, saldo sigue en ${s3}`);

// 4. Genera solo por lo pagado.
await pagar(bueno?.idOrden);
const s4 = (await saldo(cli))?.saldo;
ok(s4 === s3 + Math.floor(0.1 * precio), `al pagar genera ${s4 - s3} pts (solo la pieza pagada: ${Math.floor(0.1 * precio)})`);

// 5. Cancelar: lo generado se revierte solo; lo canjeado queda en revisión.
await rpc('actualizar_estatus_pedido', { p_data: { token: ana?.token, idOrden: String(bueno?.idOrden), estatusPedido: 'Cancelado', actualizadoPor: 'probar-canje' } });
const s5 = await saldo(cli);
const pend = (s5?.pendientes || []).find(p => p.consecutivo === bueno?.consecutivo);
ok(s5?.saldo === s3 && pend?.puntos === c0.puntos * 2, `cancelado: saldo ${s5?.saldo} (se quitó lo generado, el canje no regresó); en revisión ${pend?.puntos} pts`);

// 6. Resolver: solo el dueño; con motivo; una sola vez.
const lista = (await rpc('devoluciones_canje', { p_data: { token: ana?.token, estado: 'pendiente' } })).json;
const sol = (lista?.solicitudes || []).find(s => s.consecutivo === bueno?.consecutivo);
const listaCarla = (await rpc('devoluciones_canje', { p_data: { token: carla?.token } })).json;
ok(!!sol && listaCarla?.ok === false, `devoluciones_canje: la dueña ve la solicitud ${sol?.id}; Carla → ${listaCarla?.error}`);
const rc = (await rpc('resolver_devolucion_canje', { p_data: { token: carla?.token, id: sol?.id, aprobar: true, nota: 'x' } })).json;
const sinNota = (await rpc('resolver_devolucion_canje', { p_data: { token: ana?.token, id: sol?.id, aprobar: true, nota: '' } })).json;
ok(rc?.ok === false && sinNota?.ok === false && /motivo/i.test(sinNota?.error || ''), `Carla no resuelve (${rc?.error}); sin motivo → ${sinNota?.error}`);
const ap = (await rpc('resolver_devolucion_canje', { p_data: { token: ana?.token, id: sol?.id, aprobar: true, nota: 'Prueba: cancelado por la tienda' } })).json;
const s6 = await saldo(cli);
ok(ap?.ok === true && s6?.saldo === s3 + c0.puntos * 2 && !(s6?.pendientes || []).some(p => p.consecutivo === bueno?.consecutivo),
  `aprobada → +${ap?.puntos} pts, saldo ${s6?.saldo}, ya no está en revisión`);
const ap2 = (await rpc('resolver_devolucion_canje', { p_data: { token: ana?.token, id: sol?.id, aprobar: true, nota: 'otra vez' } })).json;
ok(ap2?.ok === false && (await saldo(cli))?.saldo === s6?.saldo, `aprobar otra vez → ${ap2?.error}`);

// 7. La app: tienda de canje, líneas y payload.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
ok(html.includes("rpc/canje_catalogo") && html.includes('id="s-club-canje"') && html.includes('puntosCanje:'), 'index.html: tienda de canje, líneas de canje y puntosCanje en el payload');

console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en orden.');
process.exitCode = fallos ? 1 : 0;
