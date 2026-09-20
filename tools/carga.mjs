#!/usr/bin/env node
// tools/carga.mjs — Prueba de carga contra STAGING (punto 6 del diagnóstico de rendimiento,
// cambios/2026-09-19-rendimiento-diagnostico.md). Solo Node: sin k6 ni Docker.
//
//   node tools/carga.mjs                       # escalones 100,300,600,1000 · 60 s cada uno · hasta 300 pedidos
//   node tools/carga.mjs --humo                # 5 usuarios, 15 s, 3 pedidos: para ver que el script funciona
//   node tools/carga.mjs --escalones 50,200 --seg 30 --pedidos-max 40 --salida resultado.json
//
// Qué simula, con las MISMAS peticiones que hace la app (regla 55, payload real del front):
//   · abrir anónimo:     GET productos, GET productos_bebidas, POST get_mayoreo_config (en paralelo)
//   · abrir con sesión:  lo anterior + obtener_cliente_con_stats + obtener_encuestas_cliente
//                        (sesión de «Consumidor Prueba» 5591000001, emitida con emitir_sesion_prueba,
//                        que solo existe en staging)
//   · pedir:             crear_pedido con 1 pieza, entrega a coordinar, idempotencyKey único,
//                        notas «[carga]». Descuenta lote y avanza el consecutivo de staging.
// Cada usuario virtual abre, a veces pide (hasta el tope, repartido por escalón) y espera 1–3 s.
//
// Qué mide: por RPC y por escalón, p50/p95/p99/máx y errores separados por clase: 429 y 5xx son del
// servidor; timeout (15 s) y conexión cortada son de la RED de esta máquina, que a ratos corta
// (PROGRESO.md, 18-19 sep 2026). Cada 15 s lee pg_stat_activity de staging por el CLI de Supabase
// (API de administración: no pasa por el pooler ni suma carga): conexiones y consultas activas.
//
// Guardarraíl: solo staging. Con la URL de producción se niega.

import { execSync, exec } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const HUMO = process.argv.includes('--humo');
const ESCALONES = String(arg('--escalones', HUMO ? '5' : '100,300,600,1000')).split(',').map(Number);
const SEG = Number(arg('--seg', HUMO ? 15 : 60));
const PEDIDOS_MAX = Number(arg('--pedidos-max', HUMO ? 3 : 300));
const SALIDA = arg('--salida', '');
const TIMEOUT_MS = 15000;

const REF_STAGING = 'dkwatbsaidlfjqjnfyrk';
const URL_BASE = 'https://' + REF_STAGING + '.supabase.co';
if ((process.env.SUPABASE_URL || '').includes('xbyzarzyxiugrucyjwfn')) { console.error('NO: esto es una prueba de carga y solo corre contra staging.'); process.exit(1); }

// Llave publishable: al CLI, como ver-en-staging.mjs. No se guarda en el repo.
let LLAVE = process.env.SUPABASE_KEY;
if (!LLAVE) {
  const out = execSync('supabase projects api-keys --project-ref ' + REF_STAGING + ' --output-format json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const ini = out.search(/[\[{]/);
  const j = JSON.parse(ini >= 0 ? out.slice(ini) : out);
  const lista = Array.isArray(j) ? j : (j.keys || j.data || []);
  LLAVE = lista.find((k) => String(k.api_key || '').startsWith('sb_publishable_'))?.api_key;
}
if (!LLAVE) { console.error('Sin llave publishable de staging.'); process.exit(1); }
const H = { apikey: LLAVE, authorization: 'Bearer ' + LLAVE, 'content-type': 'application/json' };

// ── medición ──────────────────────────────────────────────────────────────
const muestras = [];            // { esc, rpc, ms, clase }  clase: ok | 4xx | 429 | 5xx | red
let escalonActual = 0;
async function pedir_(rpc, metodo, ruta, body) {
  const t0 = performance.now();
  let clase = 'ok', status = 0, json = null;
  try {
    const r = await fetch(URL_BASE + '/rest/v1/' + ruta, { method: metodo, headers: H, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    status = r.status;
    json = await r.json().catch(() => null);
    clase = r.ok ? 'ok' : (status === 429 ? '429' : status >= 500 ? '5xx' : '4xx');
  } catch (_e) { clase = 'red'; }
  muestras.push({ esc: escalonActual, rpc, ms: performance.now() - t0, clase });
  return { status, json, clase };
}
const GET = (rpc, ruta) => pedir_(rpc, 'GET', ruta);
const RPC = (n, b) => pedir_(n, 'POST', 'rpc/' + n, b ?? {});
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ── preparación (fuera de la medición) ────────────────────────────────────
console.log('Preparando contra ' + URL_BASE + ' …');
const prods = (await GET('productos', 'productos?select=id,sabor,presentacion,precio_consumidor&order=id')).json || [];
const pc = prods.find((p) => p.presentacion === '100g' && Number(p.precio_consumidor) > 0) || prods.find((p) => Number(p.precio_consumidor) > 0);
if (!pc) { console.error('Catálogo de staging sin productos con precio.'); process.exit(1); }
const ses = (await RPC('emitir_sesion_prueba', { p_telefono: '5591000001' })).json;
if (!ses || !ses.ok || !ses.token) { console.error('Staging no emitió la sesión de prueba:', JSON.stringify(ses).slice(0, 200)); process.exit(1); }
const rc = (await RPC('obtener_cliente_con_stats', { p_telefono: '5591000001', p_token: ses.token })).json;
if (!rc || !rc.ok || !rc.existe) { console.error('No pude leer al Consumidor Prueba:', JSON.stringify(rc).slice(0, 200)); process.exit(1); }
const CLIENTE = { token: ses.token, id: rc.cliente.id, nombre: rc.cliente.nombre, tel: '5591000001' };
const PRECIO = Number(pc.precio_consumidor);
muestras.length = 0;
console.log(`Listo: producto ${pc.sabor} ${pc.presentacion} $${PRECIO} · cliente ${CLIENTE.nombre} (id ${CLIENTE.id})`);
console.log(`Escalones ${ESCALONES.join(' → ')} usuarios · ${SEG} s cada uno · tope ${PEDIDOS_MAX} pedidos (${Math.floor(PEDIDOS_MAX / ESCALONES.length)} por escalón)\n`);

// ── acciones ──────────────────────────────────────────────────────────────
async function abrir(conSesion) {
  const base = [
    GET('productos', 'productos?select=*&order=sabor.asc,presentacion.asc'),
    GET('productos_bebidas', 'productos_bebidas?select=*&order=id.asc'),
    RPC('get_mayoreo_config', {}),
  ];
  if (conSesion) {
    base.push(RPC('obtener_cliente_con_stats', { p_telefono: CLIENTE.tel, p_token: CLIENTE.token }));
    base.push(RPC('obtener_encuestas_cliente', { p_data: { telefono: CLIENTE.tel } }));
  }
  await Promise.all(base);
}
let pedidosCreados = 0, pedidosOk = 0, pedidosFallidos = 0, ultimoError = '';
const pedidosPorEscalon = Math.floor(PEDIDOS_MAX / ESCALONES.length);
const pedidosEnEscalon = ESCALONES.map(() => 0);
async function pedir() {
  pedidosCreados++; pedidosEnEscalon[escalonActual]++;
  const r = await RPC('crear_pedido', { p_data: {
    tokenCliente: CLIENTE.token, idCliente: CLIENTE.id, nombre: CLIENTE.nombre, telefono: CLIENTE.tel,
    cp: '03400', colonia: 'Álamos', direccion: 'Calle 1', metodoEntrega: 'coordinar',
    notas: '[carga] prueba de carga 19 sep 2026',
    idempotencyKey: 'carga-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
    total: PRECIO,
    productos: [{ idProducto: String(pc.id), sabor: pc.sabor, presentacion: pc.presentacion, tipoVenta: 'Por Pieza', cantidad: 1, gramos: 0, precio: PRECIO, subtotal: PRECIO }],
  } });
  if (r.json && r.json.ok === true) pedidosOk++; else { pedidosFallidos++; ultimoError = r.clase === 'ok' ? JSON.stringify(r.json).slice(0, 120) : r.clase + ' ' + r.status; }
}

// ── usuarios virtuales ────────────────────────────────────────────────────
let corriendo = true;
async function usuario(n) {
  const conSesion = n % 2 === 0;
  while (corriendo) {
    await abrir(conSesion);
    if (!corriendo) break;
    if (pedidosEnEscalon[escalonActual] < pedidosPorEscalon && Math.random() < 0.1) await pedir();
    await dormir(1000 + Math.random() * 2000);
  }
}

// ── muestreo de la base por el CLI (API de administración, no el pooler) ──
const execP = promisify(exec);
const dirTmp = mkdtempSync(join(tmpdir(), 'carga-'));
const sqlActividad = join(dirTmp, 'actividad.sql');
writeFileSync(sqlActividad, "select count(*) as total, count(*) filter (where state = 'active') as activas, count(*) filter (where state = 'active' and wait_event_type is not null) as esperando from pg_stat_activity where backend_type = 'client backend';");
const bd = [];   // { esc, t, total, activas, esperando }
async function muestrearBD() {
  try {
    const { stdout } = await execP('supabase db query --linked --project-ref ' + REF_STAGING + ' --file "' + sqlActividad + '"', { encoding: 'utf8', timeout: 20000 });
    const m = /"activas":\s*(\d+)[\s\S]*?"esperando":\s*(\d+)[\s\S]*?"total":\s*(\d+)/.exec(stdout) || /"total":\s*(\d+)/.exec(stdout);
    if (m && m.length === 4) bd.push({ esc: escalonActual, t: Date.now(), activas: +m[1], esperando: +m[2], total: +m[3] });
  } catch (_e) { /* la muestra se pierde, la prueba sigue */ }
}

// ── escalones ─────────────────────────────────────────────────────────────
const pct = (v, p) => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
function resumen(esc) {
  const m = muestras.filter((x) => x.esc === esc);
  const porRpc = {};
  for (const x of m) { (porRpc[x.rpc] ||= []).push(x); }
  const filas = Object.entries(porRpc).map(([rpc, xs]) => {
    const oks = xs.filter((x) => x.clase === 'ok').map((x) => x.ms);
    const cuenta = (c) => xs.filter((x) => x.clase === c).length;
    return { rpc, n: xs.length, p50: Math.round(pct(oks, 0.5)), p95: Math.round(pct(oks, 0.95)), p99: Math.round(pct(oks, 0.99)), max: Math.round(Math.max(0, ...oks)), e429: cuenta('429'), e5xx: cuenta('5xx'), e4xx: cuenta('4xx'), red: cuenta('red') };
  }).sort((a, b) => b.n - a.n);
  const muestrasBD = bd.filter((x) => x.esc === esc);
  return { usuarios: ESCALONES[esc], seg: SEG, peticiones: m.length, filas, bd: muestrasBD.length ? { total: Math.max(...muestrasBD.map((x) => x.total)), activas: Math.max(...muestrasBD.map((x) => x.activas)), esperando: Math.max(...muestrasBD.map((x) => x.esperando)), muestras: muestrasBD.length } : null, pedidos: pedidosEnEscalon[esc] };
}
function imprimir(r) {
  console.log(`\n═══ ${r.usuarios} usuarios · ${r.seg} s · ${r.peticiones} peticiones (${(r.peticiones / r.seg).toFixed(1)}/s) · pedidos en el escalón ${r.pedidos} ═══`);
  console.log('rpc'.padEnd(28) + 'n'.padStart(6) + 'p50'.padStart(7) + 'p95'.padStart(7) + 'p99'.padStart(7) + 'máx'.padStart(7) + '  429  5xx  4xx  red');
  for (const f of r.filas) console.log(f.rpc.padEnd(28) + String(f.n).padStart(6) + String(f.p50).padStart(7) + String(f.p95).padStart(7) + String(f.p99).padStart(7) + String(f.max).padStart(7) + String(f.e429).padStart(5) + String(f.e5xx).padStart(5) + String(f.e4xx).padStart(5) + String(f.red).padStart(5));
  if (r.bd) console.log(`base (máx de ${r.bd.muestras} muestras): ${r.bd.total} conexiones · ${r.bd.activas} activas · ${r.bd.esperando} esperando`);
}

const usuarios = [];
const resultados = [];
const t0 = Date.now();
const sampler = setInterval(muestrearBD, 15000);
muestrearBD();
for (let e = 0; e < ESCALONES.length; e++) {
  escalonActual = e;
  while (usuarios.length < ESCALONES[e]) { const n = usuarios.length; usuarios.push(usuario(n)); if (n % 25 === 24) await dormir(50); }   // arranque escalonado
  const fin = Date.now() + SEG * 1000;
  while (Date.now() < fin) { await dormir(1000); process.stdout.write(`\r  ${ESCALONES[e]} usuarios · ${Math.round((fin - Date.now()) / 1000)} s · ${muestras.filter((x) => x.esc === e).length} peticiones · pedidos ok ${pedidosOk} / fallidos ${pedidosFallidos}   `); }
  const r = resumen(e); resultados.push(r); imprimir(r);
}
corriendo = false;
clearInterval(sampler);
await Promise.race([Promise.allSettled(usuarios), dormir(TIMEOUT_MS + 2000)]);

// Resumen de toda la prueba: incluye las peticiones que terminaron después del cierre de su escalón.
{
  const porRpc = {}; for (const x of muestras) (porRpc[x.rpc] ||= []).push(x);
  const filas = Object.entries(porRpc).map(([rpc, xs]) => {
    const oks = xs.filter((x) => x.clase === 'ok').map((x) => x.ms);
    const c = (k) => xs.filter((x) => x.clase === k).length;
    return { rpc, n: xs.length, p50: Math.round(pct(oks, 0.5)), p95: Math.round(pct(oks, 0.95)), p99: Math.round(pct(oks, 0.99)), max: Math.round(Math.max(0, ...oks)), e429: c('429'), e5xx: c('5xx'), e4xx: c('4xx'), red: c('red') };
  }).sort((a, b) => b.n - a.n);
  const todo = { usuarios: 'TOTAL', seg: Math.round((Date.now() - t0) / 1000), peticiones: muestras.length, pedidos: pedidosCreados, bd: null, filas };
  imprimir(todo); resultados.push(todo);
}

console.log(`\nPedidos: ${pedidosOk} ok · ${pedidosFallidos} fallidos${ultimoError ? ' (último error: ' + ultimoError + ')' : ''} · duración ${Math.round((Date.now() - t0) / 1000)} s`);
if (SALIDA) { writeFileSync(SALIDA, JSON.stringify({ fecha: new Date().toISOString(), escalones: ESCALONES, seg: SEG, resultados, pedidosOk, pedidosFallidos, bd }, null, 2)); console.log('Guardado en ' + SALIDA); }
process.exit(0);
