#!/usr/bin/env node
// tools/probar-cola-armado.mjs — Cola de pedidos, entrega 2. Contra STAGING:
//   1. Sin la sección «armado» (Carla, Vendedor) → No autorizado, sin filas.
//   2. Con Ana (Admin): cola_armado(fecha) devuelve resumen y pedidos; el total
//      de pedidos se coteja contra obtener_pedidos (otro método) y los kg
//      cuadran entre líneas, resumen y totales.
//   3. marcar_armado marca y desmarca PED-00037; Carla no puede; sobre un
//      Pendiente responde ok:false.
// Necesita `node tools/ver-en-staging.mjs` arriba.
// Uso: node tools/probar-cola-armado.mjs [YYYY-MM-DD]   (por defecto 2026-09-17)

const FECHA = process.argv[2] || '2026-09-17';
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging') { console.error('No es staging: ' + SUPABASE_URL); process.exit(1); }
const rpc = async (n, b) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
let fallos = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

const ana   = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000001', pin: '1234' } })).json;
const carla = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000003', pin: '1234' } })).json;
ok(!!(ana?.token && carla?.token), 'sesiones de Ana (Admin) y Carla (Vendedor)');

// 1. Sin sección
const sin = await rpc('cola_armado', { p_data: { token: carla?.token, fecha: FECHA } });
ok(sin.status === 200 && sin.json?.ok === false && /autorizado/i.test(sin.json?.error || ''), `Carla sin sección → ${JSON.stringify(sin.json).slice(0, 80)}`);
ok(!Array.isArray(sin.json?.pedidos), 'Carla no recibe pedidos');

// 2. Con sección: valor que vuelve + denominador por otro método
const cola = await rpc('cola_armado', { p_data: { token: ana?.token, fecha: FECHA } });
ok(cola.status === 200 && cola.json?.ok === true, `cola_armado responde ok (HTTP ${cola.status})`);
const c = cola.json || {};
ok(c.fecha === FECHA && typeof c.horaLimite === 'string', `fecha ${c.fecha} · horaLimite ${c.horaLimite}`);
ok(Array.isArray(c.resumen) && Array.isArray(c.pedidos) && Array.isArray(c.porConfirmar) && Array.isArray(c.nuevos), 'trae resumen, pedidos, porConfirmar y nuevos');
const pedidos = Array.isArray(c.pedidos) ? c.pedidos : [];
const resumen = Array.isArray(c.resumen) ? c.resumen : [];

const todos = (await rpc('obtener_pedidos', { p_data: { token: ana?.token, limit: 500 } })).json?.pedidos || [];
const enProceso = todos.filter(p => p.estatus_pedido === 'En proceso' && String(p.fecha_entrega || '').slice(0, 10) === FECHA);
const pendientes = todos.filter(p => p.estatus_pedido === 'Pendiente' && String(p.fecha_entrega || '').slice(0, 10) === FECHA);
ok(pedidos.length === enProceso.length, `pedidos En proceso con entrega ${FECHA}: cola ${pedidos.length} = obtener_pedidos ${enProceso.length} (de ${todos.length} pedidos)`);
ok((c.porConfirmar || []).length === pendientes.length, `porConfirmar: cola ${(c.porConfirmar || []).length} = obtener_pedidos ${pendientes.length}`);
const kgLineas = pedidos.flatMap(p => p.lineas || []).reduce((s, l) => s + Number(l.kg || 0), 0);
const kgResumen = resumen.reduce((s, r) => s + Number(r.kg || 0), 0);
ok(Math.abs(kgLineas - kgResumen) < 0.001 && Math.abs(kgResumen - Number(c.totales?.kg || 0)) < 0.001, `kg cuadran: líneas ${kgLineas.toFixed(3)} = resumen ${kgResumen.toFixed(3)} = totales ${c.totales?.kg}`);
ok(pedidos.length > 0 && pedidos.every(p => (p.lineas || []).every(l => Number(l.kg) > 0 || !/\d+\s*g$/i.test(l.presentacion || ''))), 'toda línea de papa trae kg > 0 (fórmula si el lote no descontó)');
ok(pedidos.every(p => p.consecutivo && p.canal && Array.isArray(p.lineas) && 'armadoEn' in p), 'cada pedido trae consecutivo, canal, lineas y armadoEn');

// 3. Marcar / desmarcar
const obj = pedidos.find(p => p.consecutivo === 'PED-00037') || pedidos[0];
ok(!!obj, `hay un pedido para marcar (${obj?.consecutivo})`);
if (obj) {
  const m1 = await rpc('marcar_armado', { p_data: { token: ana?.token, id: obj.id, armado: true } });
  ok(m1.json?.ok === true && !!m1.json?.armadoEn && /Ana/.test(m1.json?.armadoPor || ''), `marcar → ${JSON.stringify(m1.json).slice(0, 120)}`);
  const relee = await rpc('cola_armado', { p_data: { token: ana?.token, fecha: FECHA } });
  const p2 = (relee.json?.pedidos || []).find(p => p.id === obj.id);
  ok(!!p2?.armadoEn && Number(relee.json?.totales?.armados) >= 1, `releído: armadoEn ${p2?.armadoEn} · totales.armados ${relee.json?.totales?.armados}`);
  const m0 = await rpc('marcar_armado', { p_data: { token: ana?.token, id: obj.id, armado: false } });
  ok(m0.json?.ok === true && m0.json?.armadoEn === null, `desmarcar → armadoEn ${m0.json?.armadoEn}`);
  const sinSec = await rpc('marcar_armado', { p_data: { token: carla?.token, id: obj.id, armado: true } });
  ok(sinSec.json?.ok === false, `Carla no puede marcar → ${sinSec.json?.error}`);
}
const pend = todos.find(p => p.estatus_pedido === 'Pendiente');
if (pend) {
  const mp = await rpc('marcar_armado', { p_data: { token: ana?.token, id: pend.id, armado: true } });
  ok(mp.json?.ok === false && /Pendiente/.test(mp.json?.motivo || mp.json?.error || ''), `marcar un Pendiente (${pend.consecutivo}) → ${JSON.stringify(mp.json).slice(0, 100)}`);
} else console.log('  (sin Pendientes en staging: no se probó el rechazo por estatus)');

console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en orden.');
process.exit(fallos ? 1 : 0);
