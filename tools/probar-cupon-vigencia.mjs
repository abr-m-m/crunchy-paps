#!/usr/bin/env node
// tools/probar-cupon-vigencia.mjs — Contra STAGING: «Hasta el día X» incluye X entero
// (20260930000002). Crea tres cupones con guardar_cupon, como la app, y los valida:
//   vence hoy → vale · venció ayer → «Cupón expirado» · empieza mañana → «aún no vigente».
// Los cupones de prueba se desactivan al final.
// Necesita `node tools/ver-en-staging.mjs`. Uso: node tools/probar-cupon-vigencia.mjs
import { PANEL } from './fuentes.mjs';
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging') { console.error('No es staging: ' + SUPABASE_URL); process.exit(1); }
const H = { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' };
const rpc = async (n, b) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }); return { status: r.status, json: await r.json().catch(() => null) }; };
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };
const diaCDMX = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(d);

const hoy = diaCDMX(new Date());
const mas = (dias) => diaCDMX(new Date(new Date(hoy + 'T12:00:00-06:00').getTime() + dias * 864e5));
const ana = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000001', pin: '1234' } })).json;
ok(!!ana?.token, `sesión de Ana; hoy en CDMX es ${hoy}`);

const sufijo = String(Date.now()).slice(-6);
const CASOS = [
  { codigo: 'VIGHOY' + sufijo, inicio: mas(-5), fin: hoy, espera: null, que: 'vence hoy → vale todo el día' },
  { codigo: 'VIGAYER' + sufijo, inicio: mas(-5), fin: mas(-1), espera: 'Cupón expirado', que: 'venció ayer → expirado' },
  { codigo: 'VIGMAN' + sufijo, inicio: mas(1), fin: mas(5), espera: 'Cupón aún no vigente', que: 'empieza mañana → aún no vigente' },
];
const ids = [];
for (const c of CASOS) {
  const g = (await rpc('guardar_cupon', { p_data: { token: ana?.token, id: null, campos: { codigo: c.codigo, tipo: 'descuento_pct', valor: 5, descripcion: 'prueba de vigencia', vigencia_inicio: c.inicio, vigencia_fin: c.fin, usos_maximos: 0, compra_minima: 0, segmento: 'todos', activo: true } } })).json;
  if (g?.id) ids.push(g.id);
  const v = (await rpc('validar_cupon', { p_codigo: c.codigo, p_telefono: null, p_id_cliente: null, p_total_compra: 100, p_segmento_cliente: 'consumidor' })).json;
  const paso = c.espera === null ? v?.ok === true : (v?.ok === false && v?.error === c.espera);
  ok(g?.ok === true && paso, `${c.que} (${c.inicio} a ${c.fin}) → ${JSON.stringify(v).slice(0, 70)}`);
}

// La app marca EXPIRADO con la misma regla: se lee del archivo, no se supone.
ok(PANEL.includes('const expirado = vigFin && ahora.getTime() >= vigFin.getTime() + 864e5;'), 'panel.js: «EXPIRADO» hasta que termina el último día');

// Limpieza: desactivar los cupones de prueba.
const lista = (await rpc('obtener_cupones', { p_data: { token: ana?.token } })).json;
const mios = (lista?.cupones || (Array.isArray(lista) ? lista : [])).filter(c => CASOS.some(x => x.codigo === c.codigo));
for (const c of mios) await rpc('guardar_cupon', { p_data: { token: ana?.token, id: c.id, campos: { activo: false } } });
console.log(`  (desactivados ${mios.length} de ${CASOS.length} cupones de prueba)`);

console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en orden.');
process.exitCode = fallos ? 1 : 0;
