#!/usr/bin/env node
// tools/probar-rls.mjs — Comprueba el estado del RLS golpeando la API REST
// exactamente como lo haría el navegador: con la llave anon y nada más.
//
// No consulta pg_policies: eso diría lo que la base CREE que hace. Esto mide
// lo que un atacante con la llave pública realmente consigue.
//
// Uso:
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<llave> \
//     node tools/probar-rls.mjs
//
// Sale con código 1 si algún caso falla.

const URL_BASE = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;

const args = process.argv.slice(2);
const VERBOSO = args.includes('-v');
// --solo-lectura omite los casos que ESCRIBEN (grupos C y E). Es el único modo
// admitido contra producción: el caso E hace PATCH sobre una orden real.
const SOLO_LECTURA = args.includes('--solo-lectura');

if (!URL_BASE || !ANON) {
  console.error('Faltan SUPABASE_URL y/o SUPABASE_ANON_KEY en el entorno.');
  process.exit(1);
}
if (URL_BASE.includes('xbyzarzyxiugrucyjwfn') && !SOLO_LECTURA) {
  console.error('ABORTADO: esto apunta a PRODUCCIÓN y hay casos que escriben.');
  console.error('Contra producción, usa:  node tools/probar-rls.mjs --solo-lectura');
  process.exit(1);
}

const cab = {
  apikey: ANON,
  Authorization: 'Bearer ' + ANON,
  'Content-Type': 'application/json'
};

async function pedir(metodo, ruta, cuerpo, extra) {
  const res = await fetch(URL_BASE + '/rest/v1/' + ruta, {
    method: metodo,
    headers: { ...cab, ...(extra || {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  let datos = null;
  try { datos = await res.json(); } catch (_e) { datos = null; }
  return { estado: res.status, datos, rango: res.headers.get('content-range') };
}

// Un recurso está CERRADO si niega (401/403/404) o si devuelve cero filas.
function cerrado(r) {
  if (r.estado === 401 || r.estado === 403 || r.estado === 404) return true;
  if (r.estado === 200 && Array.isArray(r.datos) && r.datos.length === 0) return true;
  return false;
}
const abierto = (r) => !cerrado(r);
const escrituraNegada = (r) => r.estado >= 400;

const casos = [];
const agregar = (grupo, nombre, fn, espera, escribe) => casos.push({ grupo, nombre, fn, espera, escribe: !!escribe });

// ── A. Debe estar CERRADO: tablas que el navegador nunca toca ──────────────
for (const t of ['vendedores', 'caja_movimientos', 'caja_dias', 'caja_puntos',
                 'lealtad_movimientos', 'insumos', 'uso_insumos',
                 'inventario_fisico', 'cuotas_vendedor', 'config_secciones']) {
  agregar('A. Tablas solo-RPC (deben negar lectura)', `GET ${t}`,
    () => pedir('GET', `${t}?select=*&limit=1`), cerrado);
}

// ── B. Vistas: saltan RLS, se cierran por GRANT ────────────────────────────
for (const v of ['vendedores_publico', 'saldo_caja_actual', 'saldos_lealtad', 'pasivo_lealtad']) {
  agregar('B. Vistas sensibles (deben negar)', `GET ${v}`,
    () => pedir('GET', `${v}?select=*&limit=1`), cerrado);
}
// Accesible = HTTP 200. No se mide por número de filas: la vista puede venir
// vacía legítimamente (produccion_diaria sin datos) y eso no es un cierre.
agregar('B. Vistas sensibles (deben negar)', 'GET vista_inventario (la app SÍ la usa)',
  () => pedir('GET', 'vista_inventario?select=*&limit=1'), (r) => r.estado === 200);

// ── C. Escritura sobre lo cerrado ──────────────────────────────────────────
agregar('C. Escritura bloqueada', 'POST caja_movimientos',
  () => pedir('POST', 'caja_movimientos', { monto: 1, concepto: 'intrusion' }), escrituraNegada, true);
agregar('C. Escritura bloqueada', 'DELETE vendedores',
  () => pedir('DELETE', 'vendedores?id=eq.999999'), escrituraNegada, true);
agregar('C. Escritura bloqueada', 'PATCH vendedores (pin_hash)',
  () => pedir('PATCH', 'vendedores?id=eq.1', { pin_hash: 'secuestrado' }), escrituraNegada, true);

// ── D. Los RPCs deben seguir funcionando ───────────────────────────────────
// Se comprueba que el RPC EJECUTA (responde 200 con su forma { ok: ... }), no
// que un vendedor concreto exista: los teléfonos de staging no están en
// producción, y este script debe servir en ambos entornos.
agregar('D. RPCs (deben funcionar)', 'rpc/validar_vendedor_pin',
  () => pedir('POST', 'rpc/validar_vendedor_pin',
    { p_data: { telefono: '5500000001', pin: '1234' } }),
  (r) => r.estado === 200 && r.datos && typeof r.datos.ok === 'boolean');

agregar('D. RPCs (deben funcionar)', 'rpc/obtener_vendedores',
  () => pedir('POST', 'rpc/obtener_vendedores', { p_data: {} }),
  (r) => r.estado === 200);

agregar('D. RPCs (deben funcionar)', 'rpc/get_estado_tienda',
  () => pedir('POST', 'rpc/get_estado_tienda', { p_telefono: '5510000001' }),
  (r) => r.estado === 200);

agregar('D. RPCs (deben funcionar)', 'rpc/dashboard_resumen',
  () => pedir('POST', 'rpc/dashboard_resumen', { p_data: {} }),
  (r) => r.estado === 200);

// obtener_cliente_con_stats lee `clientes`, que sigue abierta (Etapa B). Se
// prueba igual para que, cuando se cierre, sepamos de inmediato si el RPC
// dejó de funcionar.
agregar('D. RPCs (deben funcionar)', 'rpc/obtener_cliente_con_stats',
  () => pedir('POST', 'rpc/obtener_cliente_con_stats', { p_telefono: '5510000001' }),
  (r) => r.estado === 200);

// ── E. Regresión: el camino de triggers sigue vivo ─────────────────────────
// PATCH sobre ordenes dispara trg_caja_mov_pedido y trg_caja_confirmar_pedido,
// que escriben en caja_movimientos — la tabla que acabamos de cerrar. Si los
// triggers no fueran SECURITY DEFINER, esto fallaría. Es LA prueba de la
// Etapa A.
agregar('E. Regresión de triggers', 'PATCH ordenes (dispara escritura en caja_movimientos)',
  async () => {
    const pend = await pedir('GET', 'ordenes?estatus_pago=eq.Pendiente&select=id&limit=1');
    if (!Array.isArray(pend.datos) || !pend.datos.length) return { estado: 0, datos: 'sin órdenes pendientes' };
    return pedir('PATCH', `ordenes?id=eq.${pend.datos[0].id}`, { estatus_pago: 'Pagado' });
  },
  (r) => r.estado >= 200 && r.estado < 300,
  true);

// ── F. Lo que sigue abierto (Etapa B) — se mide, no se celebra ─────────────
for (const t of ['clientes', 'ordenes', 'prospectos']) {
  agregar('F. Aún ABIERTO — pendiente Etapa B', `GET ${t}`,
    () => pedir('GET', `${t}?select=*&limit=1`), abierto);
}

// ── Ejecución ──────────────────────────────────────────────────────────────

console.log(`\nProbando RLS contra ${URL_BASE}${SOLO_LECTURA ? '   [solo lectura]' : ''}\n`);
let fallos = 0;
let corridos = 0;
let grupoActual = '';

for (const c of casos) {
  if (SOLO_LECTURA && c.escribe) continue;
  corridos++;
  if (c.grupo !== grupoActual) { grupoActual = c.grupo; console.log(`  ${grupoActual}`); }
  let r, paso;
  try {
    r = await c.fn();
    paso = c.espera(r);
  } catch (e) {
    r = { estado: -1, datos: e.message };
    paso = false;
  }
  if (!paso) fallos++;
  const detalle = r.estado === 200 && Array.isArray(r.datos)
    ? `HTTP 200, ${r.datos.length} fila(s)`
    : `HTTP ${r.estado}`;
  console.log(`    ${paso ? 'ok   ' : 'FALLA'} ${c.nombre.padEnd(52)} ${detalle}`);
  if (!paso && VERBOSO) console.log(`           ${JSON.stringify(r.datos).slice(0, 220)}`);
}

console.log(fallos ? `\n${fallos} de ${corridos} caso(s) fallando.\n` : `\nLos ${corridos} casos pasan.\n`);
process.exit(fallos ? 1 : 0);
