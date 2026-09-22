#!/usr/bin/env node
// tools/probar-fecha-de-dia.mjs — Contra STAGING: la fecha de entrega que elige el cliente es la
// que ven armado, reparto y la app, con la base en hora de CDMX (20260930000001).
//
//   1. Un pedido con fechaEntrega a medianoche UTC (lo que mandaba la app hasta el 18 sep, y lo
//      que manda una app vieja en caché) y otro a mediodía de CDMX (la app nueva).
//   2. Los dos salen en cola_armado del día elegido, no del anterior.
//   3. obtener_pedidos devuelve una fecha_entrega que, leída en CDMX, es el día elegido.
//   4. src/app.js manda la fecha a mediodía de CDMX.
//
// Necesita `node tools/ver-en-staging.mjs`. Uso: node tools/probar-fecha-de-dia.mjs
import { APP } from './fuentes.mjs';
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging') { console.error('No es staging: ' + SUPABASE_URL); process.exit(1); }
const H = { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' };
const rpc = async (n, b) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }); return { status: r.status, json: await r.json().catch(() => null) }; };
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };
const diaCDMX = (v) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date(v));

// Un martes lejano, para no mezclarse con pedidos de otras pruebas.
const FECHA = '2026-10-06';
const ana = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000001', pin: '1234' } })).json;
const tel = '557' + String(Date.now()).slice(-7);
const ses = (await rpc('emitir_sesion_prueba', { p_telefono: tel })).json;
const prod = (await (await fetch(`${SUPABASE_URL}/rest/v1/productos?select=id,sabor,presentacion,precio_consumidor&limit=1&order=id`, { headers: H })).json())[0];
const precio = Number(prod.precio_consumidor);
ok(!!ana?.token && !!ses?.token && precio > 0, `sesiones de Ana y del consumidor ${tel}; producto a $${precio}`);
const base = { tokenCliente: ses?.token, nombre: 'Consumidor Fecha', telefono: tel, cp: '03400', colonia: 'Álamos', direccion: 'Calle 1', metodoEntrega: 'coordinar', total: precio,
  productos: [{ idProducto: String(prod.id), sabor: prod.sabor, presentacion: prod.presentacion, tipoVenta: 'Por Pieza', cantidad: 1, gramos: 0, precio, subtotal: precio }] };

const FORMAS = [
  ['app vieja (medianoche UTC)', new Date(FECHA).toISOString()],
  ['app nueva (mediodía CDMX)', new Date(FECHA + 'T12:00:00-06:00').toISOString()],
];
const peds = [];
for (const [i, [nombre, fe]] of FORMAS.entries()) {
  const p = (await rpc('crear_pedido', { p_data: { ...base, fechaEntrega: fe, idempotencyKey: 'fdd-' + tel + '-' + i } })).json;
  ok(p?.ok === true, `${nombre}: ${fe} → ${p?.consecutivo || JSON.stringify(p).slice(0, 80)}`);
  peds.push({ nombre, consecutivo: p?.consecutivo });
}

// 2. cola_armado del día elegido (los Pendiente van en porConfirmar) y la del día anterior.
const cola = (await rpc('cola_armado', { p_data: { token: ana?.token, fecha: FECHA } })).json;
const antes = (await rpc('cola_armado', { p_data: { token: ana?.token, fecha: '2026-10-05' } })).json;
ok(cola?.ok === true && Array.isArray(cola?.porConfirmar), `cola_armado ${FECHA} responde (porConfirmar ${cola?.porConfirmar?.length})`);
for (const p of peds) {
  const en = (cola?.porConfirmar || []).find(x => x.consecutivo === p.consecutivo);
  const enAntes = (antes?.porConfirmar || []).some(x => x.consecutivo === p.consecutivo);
  ok(!!en && !enAntes, `${p.nombre}: ${p.consecutivo} en la cola del ${FECHA}${enAntes ? ', pero SALE en la del 2026-10-05' : en ? '' : ' → NO está'}`);
}

// 3. La fecha guardada, leída en CDMX como la lee la app.
const lista = (await rpc('obtener_pedidos', { p_data: { token: ana?.token, limit: 500 } })).json;
const filas = lista?.pedidos || lista?.ordenes || (Array.isArray(lista) ? lista : []);
for (const p of peds) {
  const f = filas.find(x => x.consecutivo === p.consecutivo);
  const fe = f?.fecha_entrega ?? f?.fechaEntrega;
  ok(!!fe && diaCDMX(fe) === FECHA, `${p.nombre}: guardada ${fe} → en CDMX ${fe ? diaCDMX(fe) : '—'}`);
}

// 4. La app manda mediodía de CDMX: se lee del archivo, no se supone.
ok(APP.includes("new Date(fechaEntregaFinal + 'T12:00:00-06:00').toISOString()"), 'app.js: el checkout manda la fecha a mediodía de CDMX');

console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en orden.');
process.exitCode = fallos ? 1 : 0;
