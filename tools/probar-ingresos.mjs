#!/usr/bin/env node
// tools/probar-ingresos.mjs — Ingreso bruto y neto en el tablero (20260930000008). Spec:
// cambios/2026-09-19-ingreso-bruto-neto.md. Mide la DIFERENCIA de dashboard_resumen (Ana, rango = hoy) antes y
// después de crear sus pedidos: el tablero de staging suma también otros datos de prueba del día. Los montos
// esperados salen de los precios del catálogo y de los cupones que crea, no de leer lo que escribió el servidor.
// Escribe en STAGING (pedidos, cupones que desactiva al final, un asiento de puntos): con permiso de Abraham.
// Necesita `node tools/ver-en-staging.mjs`. Uso: node tools/probar-ingresos.mjs
import { writeFileSync, mkdtempSync } from 'node:fs';
import { PANEL, TODO } from './fuentes.mjs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STG = 'dkwatbsaidlfjqjnfyrk';
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging' || !SUPABASE_URL.includes(STG)) { console.error('No es staging: ' + SUPABASE_URL); process.exit(1); }
const H = { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' };
const SIN_CONEXION = ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET'];
const conReintento = async (fn) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 5 || !SIN_CONEXION.includes(e?.cause?.code)) throw e; await new Promise(r => setTimeout(r, 2000 * (i + 1))); } } };
const rpc = async (n, b) => { const r = await conReintento(() => fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })); return { status: r.status, json: await r.json().catch(() => null) }; };
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };
const dir = mkdtempSync(join(tmpdir(), 'ingresos-'));
const sql = (q) => {
  const f = join(dir, 'q.sql'); writeFileSync(f, q);
  const out = execSync(`supabase db query --linked --project-ref ${STG} -o json --file "${f}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.slice(out.indexOf('{'))).rows || [];
};
const sqlOVacio = (q) => { try { return sql(q); } catch (_e) { return null; } };
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const igual = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

const ana = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000001', pin: '1234' } })).json;
const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const tablero = async () => (await rpc('dashboard_resumen', { p_data: { token: ana?.token, desde: hoy, hasta: hoy } })).json?.data;
const valorPunto = Number((await rpc('get_lealtad_config', {})).json?.redencion?.valor_punto_mxn);

// Catálogo: una pieza para consumidor, el producto 1 para la caja, y la primera pieza canjeable.
const prods = await conReintento(async () => (await fetch(`${SUPABASE_URL}/rest/v1/productos?select=id,sabor,presentacion,precio_consumidor,precio_tienda,precio_caja_12&order=id`, { headers: H })).json());
const pc = prods.find(p => Number(p.precio_consumidor) > 0);
const pcaja = prods.find(p => Number(p.precio_caja_12) > 0 && Number(p.precio_tienda) > 0);
const c0 = ((await rpc('canje_catalogo', {})).json?.productos || [])[0];
const pCanje = prods.find(p => p.id === c0?.id);
if (!pc || !pcaja || !c0 || !pCanje || !(valorPunto > 0)) {
  ok(false, `preparación: consumidor ${!!pc}, caja_12 ${!!pcaja}, canje ${!!c0}, valor del punto ${valorPunto}`);
  console.log(`\n${fallos} fallo(s).`); process.exit(1);
}
const P = Number(pc.precio_consumidor);

// Cupones propios, con código único; se desactivan al final.
const sufijo = String(Date.now()).slice(-6);
const CUP_PCT = 'ING10P' + sufijo, CUP_ENVIO = 'INGENV' + sufijo;
for (const [codigo, tipo, valor] of [[CUP_PCT, 'descuento_pct', 10], [CUP_ENVIO, 'envio_gratis', 0]]) {
  await rpc('guardar_cupon', { p_data: { token: ana?.token, id: null, campos: { codigo, tipo, valor, descripcion: 'prueba de ingresos', vigencia_inicio: '2026-01-01', vigencia_fin: '2027-12-31', usos_maximos: 0, compra_minima: 0, segmento: 'todos', activo: true } } });
}

const alta = async (nombre, extra = {}) => {
  const tel = '551' + String(Date.now()).slice(-7); await new Promise(r => setTimeout(r, 5));
  const a = (await rpc('registrar_o_actualizar_cliente', { p_data: { telefono: tel, nombre, tipo: 'Consumidor', tipoId: 1, direccion: 'Calle 1', cp: '03400', colonia: 'Álamos', municipio: 'Benito Juárez', estado: 'CDMX', coordenadas: '', ...extra } })).json;
  const ses = (await rpc('emitir_sesion_prueba', { p_telefono: tel })).json;
  return { tel, token: ses?.token, id: a?.idCliente, nombre };
};
const linea = (p, n, precio) => ({ idProducto: String(p.id), sabor: p.sabor, presentacion: p.presentacion, tipoVenta: 'Por Pieza', cantidad: n, gramos: 0, precio, subtotal: r2(precio * n) });
const pedido = async (c, extra) => (await rpc('crear_pedido', { p_data: { tokenCliente: c.token, idCliente: c.id, nombre: c.nombre, telefono: c.tel, cp: '03400', colonia: 'Álamos', direccion: 'Calle 1', metodoEntrega: 'coordinar', idempotencyKey: 'ing-' + c.tel + '-' + Math.random(), ...extra } })).json;

const d0 = await tablero();
ok(!!d0, `tablero de Ana para ${hoy}: ${d0 ? 'responde' : 'sin datos'}`);

// A. Consumidor, paquetería, 2 piezas, cupón 10%.
const cA = await alta('Ingresos A');
const descA = r2(2 * P * 0.10);
const pedA = await pedido(cA, { metodoEntrega: 'paqueteria', cuponCodigo: CUP_PCT, total: r2(2 * P - descA + 80), productos: [linea(pc, 2, P)] });
// B. Consumidor, paquetería, 1 pieza, envío gratis.
const cB = await alta('Ingresos B');
const pedB = await pedido(cB, { metodoEntrega: 'paqueteria', cuponCodigo: CUP_ENVIO, total: P, productos: [linea(pc, 1, P)] });
// T. Tienda aprobada, una caja de 12.
const cT = await alta('Ingresos Tienda', { tipo: 'Tienda / Abarrotes', tipoId: 3, aprobadoB2B: false });
await rpc('aprobar_cliente_b2b', { p_id_cliente: Number(cT.id), p_aprobar: true, p_actor: 'probar-ingresos', p_token: ana?.token });
const cajaPrecio = Number(pcaja.precio_caja_12), descT = r2(12 * Number(pcaja.precio_tienda) - cajaPrecio);
const pedT = await pedido(cT, { total: cajaPrecio, productos: [{ ...linea(pcaja, 12, r2(cajaPrecio / 12)), caja: 12, subtotal: cajaPrecio }] });
// C. Canje: 1 pieza pagada + 1 canjeada; los puntos vienen de un asiento de staging.
const cC = await alta('Ingresos Canje');
sql(`insert into public.lealtad_movimientos (id_cliente, tipo, puntos, nota, actor) values (${Number(cC.id)}, 'ajuste', ${c0.puntos}, 'prueba de ingresos', 'probar-ingresos') returning id`);
const Pc = Number(pCanje.precio_consumidor), descC = r2(c0.puntos * valorPunto);
const pedC = await pedido(cC, { total: Pc, puntosCanje: c0.puntos, productos: [linea(pCanje, 1, Pc), { ...linea(pCanje, 1, 0), subtotal: 0, canje: true, puntos: c0.puntos }] });
// X. Un pedido que se cancela: no debe sumar.
const cX = await alta('Ingresos Cancelado');
const pedX = await pedido(cX, { total: P, productos: [linea(pc, 1, P)] });
await rpc('actualizar_estatus_pedido', { p_data: { token: ana?.token, idOrden: String(pedX?.idOrden), estatusPedido: 'Cancelado', actualizadoPor: 'probar-ingresos' } });

ok([pedA, pedB, pedT, pedC, pedX].every(p => p?.ok === true),
  `pedidos: A ${pedA?.consecutivo || pedA?.error} · B ${pedB?.consecutivo || pedB?.error} · T ${pedT?.consecutivo || pedT?.error} · C ${pedC?.consecutivo || pedC?.error} · X ${pedX?.consecutivo || pedX?.error}`);

// Lo que el servidor guardó, leído aparte.
const ids = [pedA, pedB, pedT, pedC].map(p => Number(p?.idOrden) || 0).join(',');
// El total no depende de la migración; el envío sí (antes de ella, esa lectura falla y queda vacía).
const tot = sql(`select id, total from ordenes where id in (${ids})`);
const env = sqlOVacio(`select id, envio, descuento_envio from ordenes where id in (${ids})`) || [];
const cab = tot.map(o => ({ ...o, ...(env.find(e => e.id == o.id) || {}) }));
const lin = sqlOVacio(`select id_orden, subtotal, descuento, puntos_canje from ordenes_detalle where id_orden in (${ids}) order by id`) || [];
const deA = cab.find(o => o.id == pedA?.idOrden), deB = cab.find(o => o.id == pedB?.idOrden);
ok(igual(deA?.envio, 80) && igual(deA?.descuento_envio, 0) && igual(deB?.envio, 80) && igual(deB?.descuento_envio, 80),
  `envío guardado: A ${deA?.envio}/${deA?.descuento_envio} (80/0), B ${deB?.envio}/${deB?.descuento_envio} (80/80)`);
const lA = lin.filter(l => l.id_orden == pedA?.idOrden), lT = lin.filter(l => l.id_orden == pedT?.idOrden), lC = lin.filter(l => l.id_orden == pedC?.idOrden);
ok(lA.length === 1 && igual(lA[0].descuento, 0), `línea normal sin descuento: ${lA.map(l => l.descuento).join(',')}`);
ok(lT.length === 1 && igual(lT[0].descuento, descT), `caja: descuento ${lT[0]?.descuento} (esperado 12 × ${pcaja.precio_tienda} − ${cajaPrecio} = ${descT})`);
const canjeL = lC.find(l => Number(l.puntos_canje) > 0);
ok(!!canjeL && igual(canjeL.subtotal, 0) && igual(canjeL.descuento, descC), `canje: subtotal ${canjeL?.subtotal}, descuento ${canjeL?.descuento} (esperado ${c0.puntos} × ${valorPunto} = ${descC})`);

// El tablero, por diferencia.
const d1 = await tablero();
const I0 = d0?.ingresos, I1 = d1?.ingresos;
const dI = (k) => I0 && I1 ? r2(Number(I1[k]) - Number(I0[k])) : NaN;
const esp = {
  bruto: r2(2 * P + P + 12 * Number(pcaja.precio_tienda) + Pc + descC),
  desc_producto: descT, cupones: descA, canje: descC,
  envio_tarifa: 160, envio_absorbido: 80, envio_cobrado: 80,
};
esp.neto = r2(esp.bruto - esp.desc_producto - esp.cupones - esp.canje);
esp.cobrado = r2(esp.neto + esp.envio_cobrado);
for (const k of Object.keys(esp)) ok(igual(dI(k), esp[k]), `ingresos.${k}: +${dI(k)} (esperado +${esp[k]})`);
ok(I1 && igual(Number(I1.bruto) - Number(I1.desc_producto) - Number(I1.cupones) - Number(I1.canje), I1.neto)
      && igual(Number(I1.envio_tarifa) - Number(I1.envio_absorbido), I1.envio_cobrado)
      && igual(Number(I1.neto) + Number(I1.envio_cobrado), I1.cobrado) && I1.con_filtro === false,
  `cuadre del día: ${JSON.stringify(I1)}`);
const totalPedidos = r2([pedA, pedB, pedT, pedC].reduce((s, p) => s + Number(cab.find(o => o.id == p?.idOrden)?.total || 0), 0));
ok(igual(dI('cobrado'), totalPedidos), `cobrado sube lo mismo que el total de los pedidos (${totalPedidos})`);

// «Ventas» es el neto: número grande, día de hoy y vendedores.
const dMtd = r2(Number(d1?.mtd_actual) - Number(d0?.mtd_actual));
const dia = (d) => Number((d?.ventas_dia || []).find(x => String(x.fecha).slice(0, 10) === hoy)?.monto || 0);
const vend = (d) => (d?.por_vendedor || []).reduce((s, v) => s + Number(v.ventas || 0), 0);
ok(igual(dMtd, esp.neto) && igual(r2(dia(d1) - dia(d0)), esp.neto) && igual(r2(vend(d1) - vend(d0)), esp.neto),
  `ventas en neto: mtd +${dMtd}, día +${r2(dia(d1) - dia(d0))}, vendedores +${r2(vend(d1) - vend(d0))} (esperado +${esp.neto}, no +${totalPedidos})`);

// Con filtro de producto: cupones y envío no se reparten.
const dF = (await rpc('dashboard_resumen', { p_data: { token: ana?.token, desde: hoy, hasta: hoy, sabor: pc.sabor } })).json?.data?.ingresos;
ok(dF?.con_filtro === true && igual(dF?.cupones, 0) && igual(dF?.envio_tarifa, 0), `con filtro de sabor: ${JSON.stringify(dF)}`);

// La app.
ok(PANEL.includes('Ingreso neto del mes') && PANEL.includes("card('Bruto y neto'") && !TODO.includes('Ventas del mes')
   && PANEL.includes('ventasMes += neto;'), 'panel.js: «Ingreso neto del mes», tarjeta «Bruto y neto», vendedor en neto; «Ventas del mes» en ningún archivo');

// Limpieza: desactivar los cupones de prueba.
const lista = (await rpc('obtener_cupones', { p_data: { token: ana?.token } })).json;
const mios = (lista?.cupones || (Array.isArray(lista) ? lista : [])).filter(c => [CUP_PCT, CUP_ENVIO].includes(c.codigo));
for (const c of mios) await rpc('guardar_cupon', { p_data: { token: ana?.token, id: c.id, campos: { activo: false } } });
await rpc('aprobar_cliente_b2b', { p_id_cliente: Number(cT.id), p_aprobar: false, p_actor: 'probar-ingresos', p_token: ana?.token });
console.log(`  (desactivados ${mios.length} de 2 cupones de prueba)`);

console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en orden.');
process.exitCode = fallos ? 1 : 0;
