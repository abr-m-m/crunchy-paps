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

// OJO: `obtener_vendedores` y `dashboard_resumen` YA NO van aquí. Desde que
// exigen sesión (grupo H) devuelven HTTP 200 con ok:false, así que comprobar
// solo el código de estado pasaría siempre — un caso que nunca falla no prueba
// nada. Su verificación real vive en el grupo H, que sí mira `ok`.

agregar('D. RPCs abiertos a propósito (deben funcionar)', 'rpc/get_estado_tienda',
  () => pedir('POST', 'rpc/get_estado_tienda', { p_telefono: '5510000001' }),
  (r) => r.estado === 200 && r.datos && r.datos.ok !== false);

// ⚠️ HUECO CONOCIDO: `obtener_cliente_con_stats` entrega el historial de
// compras de cualquiera que conozca un teléfono, sin credencial. La tabla
// `clientes` ya está cerrada, pero este RPC la lee como DEFINER. Cerrarlo
// necesita sesión de CLIENTE (OTP), que todavía no existe. Se prueba para
// dejar constancia de que el hueco sigue ahí.
agregar('D. RPCs abiertos a propósito (deben funcionar)', 'rpc/obtener_cliente_con_stats  [HUECO CONOCIDO]',
  () => pedir('POST', 'rpc/obtener_cliente_con_stats', { p_telefono: '5510000001' }),
  (r) => r.estado === 200);

// ── E. Regresión: el camino de triggers sigue vivo ─────────────────────────
// PATCH sobre ordenes dispara trg_caja_mov_pedido y trg_caja_confirmar_pedido,
// que escriben en caja_movimientos — la tabla que acabamos de cerrar. Si los
// triggers no fueran SECURITY DEFINER, esto fallaría. Es LA prueba de la
// Etapa A.
// Antes este caso hacía `PATCH ordenes` directo. Desde que se revocó UPDATE a
// anon (Etapa B), ese camino ya no existe: ahora la actualización pasa por
// rpc/actualizar_campos_pedido con sesión. La INTENCIÓN del caso no cambia —
// comprobar que los triggers siguen pudiendo escribir en caja_movimientos —,
// solo el camino por el que se llega.
agregar('E. Regresión de triggers', 'actualizar pedido dispara escritura en caja_movimientos',
  async () => {
    const t = await entrar('5500000001');          // Admin: tiene la sección `pedidos`
    if (!t) return { estado: 0, datos: 'sin token' };
    // Cualquier UPDATE sobre `ordenes` dispara trg_caja_mov_pedido,
    // trg_caja_confirmar_pedido, trg_otorgar_puntos y trg_ordenes_reconciliar.
    // Si alguno no fuera SECURITY DEFINER, la actualización entera fallaría.
    return pedir('POST', 'rpc/actualizar_campos_pedido', {
      p_data: { token: t, idOrden: '1',
                campos: { fecha_pago: new Date().toISOString(), actualizado_por: 'prueba-rls' } }
    });
  },
  (r) => r.datos?.ok === true,
  true);

// ── F. Lo que sigue abierto (Etapa B) — se mide, no se celebra ─────────────
// Accesible = HTTP 200. Una tabla vacía responde 200 con [] y sigue estando
// ABIERTA: contar filas confundiría "sin datos" con "cerrada".
for (const t of ['ordenes', 'prospectos', 'ordenes_detalle', 'gastos']) {
  agregar('F. Aún ABIERTO — pendiente Etapa B', `GET ${t}`,
    () => pedir('GET', `${t}?select=*&limit=1`), (r) => r.estado === 200);
}

// ── G. clientes: cerrado, y accesible solo con sesión de vendedor ──────────
// Estos casos ABREN SESIÓN (escriben en sesiones_vendedor) y dependen de los
// vendedores ficticios del seed con PIN 1234. Por eso se marcan como
// escritura: no corren en --solo-lectura ni contra producción.
agregar('G. clientes (Etapa B)', 'GET clientes directo',
  () => pedir('GET', 'clientes?select=*&limit=1'), cerrado);

agregar('G. clientes (Etapa B)', 'obtener_clientes SIN token',
  () => pedir('POST', 'rpc/obtener_clientes', { p_data: {} }),
  (r) => r.estado === 200 && r.datos && r.datos.ok === false);

agregar('G. clientes (Etapa B)', 'obtener_clientes con token INVENTADO',
  () => pedir('POST', 'rpc/obtener_clientes', { p_data: { token: 'f'.repeat(64) } }),
  (r) => r.estado === 200 && r.datos && r.datos.ok === false);

async function entrar(telefono) {
  const r = await pedir('POST', 'rpc/validar_vendedor_pin',
    { p_data: { telefono, pin: '1234' } });
  return (r.datos && r.datos.token) || null;
}

agregar('G. clientes (Etapa B)', 'admin ve TODOS los clientes',
  async () => {
    const t = await entrar('5500000001');           // vendedor 1 = Admin
    if (!t) return { estado: 0, datos: 'sin token' };
    return pedir('POST', 'rpc/obtener_clientes', { p_data: { token: t, limit: 5 } });
  },
  (r) => r.estado === 200 && r.datos && r.datos.ok === true && r.datos.total > 100,
  true);

agregar('G. clientes (Etapa B)', 'vendedor ve SOLO los suyos',
  async () => {
    const t = await entrar('5500000003');           // vendedor 3 = Vendedor
    if (!t) return { estado: 0, datos: 'sin token' };
    const r = await pedir('POST', 'rpc/obtener_clientes', { p_data: { token: t, limit: 200 } });
    // La comprobación de fondo: ninguna fila puede ser de otro vendedor.
    const ajenos = (r.datos?.clientes || []).filter((c) => c.id_vendedor !== 3).length;
    return { ...r, ajenos };
  },
  (r) => r.estado === 200 && r.datos?.ok === true && r.datos.total > 0 &&
         r.datos.total < 100 && r.ajenos === 0,
  true);

agregar('G. clientes (Etapa B)', 'vendedor NO alcanza cliente ajeno',
  async () => {
    const t = await entrar('5500000003');
    if (!t) return { estado: 0, datos: 'sin token' };
    // El cliente 300 es del vendedor 7 (seed: id_vendedor = 1 + i % 7).
    return pedir('POST', 'rpc/obtener_telefono_cliente',
      { p_data: { token: t, idCliente: 300 } });
  },
  (r) => r.estado === 200 && r.datos && r.datos.ok === false,
  true);

agregar('G. clientes (Etapa B)', 'token revocado deja de servir',
  async () => {
    const t = await entrar('5500000001');
    if (!t) return { estado: 0, datos: 'sin token' };
    await pedir('POST', 'rpc/cerrar_sesion_vendedor', { p_data: { token: t } });
    return pedir('POST', 'rpc/obtener_clientes', { p_data: { token: t } });
  },
  (r) => r.estado === 200 && r.datos && r.datos.ok === false,
  true);

agregar('G. clientes (Etapa B)', 'sesiones_vendedor cerrada a anon',
  () => pedir('GET', 'sesiones_vendedor?select=*&limit=1'), cerrado);

agregar('G. clientes (Etapa B)', 'resolver_sesion_vendedor no invocable',
  () => pedir('POST', 'rpc/resolver_sesion_vendedor', { p_token: 'x'.repeat(64) }),
  (r) => r.estado === 401 || r.estado === 404);

// ── H. RPCs de finanzas y personal: exigen sesión (hallazgo 19) ────────────
// Eran el agujero que anulaba la Etapa A: la tabla `vendedores` quedó cerrada
// pero obtener_vendedores seguía entregando el padrón con correos.
const sinSesion = (r) => r.estado === 200 && r.datos && r.datos.ok === false;

for (const [nombre, cuerpo] of [
  ['dashboard_resumen',       { p_data: {} }],
  ['resumen_gastos',          { p_data: {} }],
  ['obtener_vendedores',      { p_data: {} }],
  ['obtener_pendientes_caja', {}],
  ['metricas_regalo_mes',     { p_anio: 2026, p_mes: 8 }],
]) {
  agregar('H. Finanzas/personal SIN sesión (deben negar)', `rpc/${nombre}`,
    () => pedir('POST', `rpc/${nombre}`, cuerpo), sinSesion);
}

// Las funciones _interno guardan la lógica original y no deben ser alcanzables.
// reporte_cobros no la usa la app: se retiró de la API (hallazgo 22), así que
// responde 401 y no 'ok:false'. Se comprueba como retirada, no como protegida.
agregar('H. Finanzas/personal SIN sesión (deben negar)', 'rpc/reporte_cobros (retirada de la API)',
  () => pedir('POST', 'rpc/reporte_cobros', { p_data: {} }),
  (r) => r.estado === 401 || r.estado === 404);

for (const f of ['dashboard_resumen_interno', 'obtener_vendedores_interno',
                 'reporte_cobros_interno', 'resumen_gastos_interno']) {
  agregar('H. Finanzas/personal SIN sesión (deben negar)', `rpc/${f} (interna)`,
    () => pedir('POST', `rpc/${f}`, { p_data: {} }),
    (r) => r.estado === 401 || r.estado === 404);
}

// ── I. Permisos por sección: cada perfil ve lo suyo y nada más ─────────────
// El modelo de permisos (config_secciones + vendedores.secciones) existía pero
// solo se aplicaba en el navegador: esconder un botón no es un permiso.
// Estos casos comprueban que ahora lo aplica el servidor.
//
// Perfiles del seed:  1 Admin (dueño) · 2 Mostrador · 3 Vendedor
//                     4 Administrador2 = SOCIO con finanzas PARCIALES
const MATRIZ = [
  // telefono,       perfil,               dashboard, gastos, caja,   vendedores
  ['5500000001', 'Admin (dueño)',            true,  true,  true,  true],
  ['5500000002', 'Mostrador',                false, true,  true,  true],
  ['5500000003', 'Vendedor',                 false, false, false, false],
  ['5500000004', 'Socio (administrador2)',   true,  true,  false, true],
];

for (const [tel, perfil, dash, gast, cob, vend] of MATRIZ) {
  agregar('I. Permisos por sección', `${perfil}`,
    async () => {
      const t = await entrar(tel);
      if (!t) return { estado: 0, datos: 'sin token' };
      const [d, g, c, v] = await Promise.all([
        pedir('POST', 'rpc/dashboard_resumen',  { p_data: { token: t } }),
        pedir('POST', 'rpc/resumen_gastos',     { p_data: { token: t } }),
        pedir('POST', 'rpc/obtener_pendientes_caja', { p_token: t }),
        pedir('POST', 'rpc/obtener_vendedores', { p_data: { token: t } }),
      ]);
      const real = [d, g, c, v].map((r) => r.datos?.ok === true);
      return { estado: 200, datos: { esperado: [dash, gast, cob, vend], real }, real };
    },
    (r) => r.real && r.real[0] === dash && r.real[1] === gast &&
           r.real[2] === cob && r.real[3] === vend,
    true);
}

// ── K. Mutaciones de personal: exigen sesión y sección (hallazgo 22) ───────
// La auditoría encontró 32 funciones que escribían sin comprobar nada. Las 10
// sin uso se retiraron de la API; estas 22 las usa la app y llevan envoltura.
const MUTACIONES = [
  'set_secciones_vendedor', 'set_config_secciones', 'set_cuota_vendedor',
  'set_lealtad_config', 'set_mayoreo_config', 'aprobar_gasto', 'rechazar_gasto',
  'abrir_caja_dia', 'cerrar_caja_dia', 'registrar_movimiento_caja',
  'confirmar_caja_pedido', 'actualizar_estatus_pedido',
  'corregir_metodo_pago_pedido', 'actualizar_tipo_cliente', 'registrar_lote',
  'registrar_produccion_sabor', 'importar_prospectos_bulk',
  'convertir_prospecto_a_cliente', 'registrar_prospecto_desde_interno',
];
agregar('K. Mutaciones sin sesión (deben negar)', `las ${MUTACIONES.length} con p_data`,
  async () => {
    const res = await Promise.all(MUTACIONES.map((f) =>
      pedir('POST', `rpc/${f}`, { p_data: {} })));
    const permisivas = res
      .map((r, i) => (r.datos?.ok !== false ? MUTACIONES[i] : null))
      .filter(Boolean);
    return { estado: 200, datos: { permisivas }, permisivas };
  },
  (r) => r.permisivas && r.permisivas.length === 0);

agregar('K. Mutaciones sin sesión (deben negar)', 'las 3 con argumentos posicionales',
  async () => {
    const res = await Promise.all([
      pedir('POST', 'rpc/aprobar_cliente_b2b', { p_id_cliente: 1, p_aprobar: true }),
      pedir('POST', 'rpc/reasignar_lote_pedido', { p_id_orden: 1, p_id_lote: 'X' }),
      pedir('POST', 'rpc/reasignar_vendedor_cliente',
        { p_id_cliente: 1, p_id_vendedor: 1, p_nombre_vendedor: 'X' }),
    ]);
    const malas = res.filter((r) => r.datos?.ok !== false).length;
    return { estado: 200, datos: res.map((r) => r.datos), malas };
  },
  (r) => r.malas === 0);

// Las 10 sin uso deben haber desaparecido de la API.
agregar('K. Mutaciones sin sesión (deben negar)', 'las 10 sin uso, fuera de la API',
  async () => {
    const fs = ['agregar_punto', 'agregar_movimiento_lealtad', 'canjear_premio',
                'crear_caja_vendedor', 'registrar_entrega_vendedor',
                'buscar_cliente_telefono', 'obtener_cajas_vendedores',
                'get_cuota_vendedor', 'obtener_vendedor_por_cp'];
    const res = await Promise.all(fs.map((f) => pedir('POST', `rpc/${f}`, { p_data: {} })));
    // No alcanzable = 401 (permiso retirado) o 404 (ninguna firma encaja).
    // Son dos negativas distintas y ambas valen; exigir solo 404 daba un
    // falso rojo en las que sí estaban revocadas.
    const vivas = res.map((r, i) => (![401, 404].includes(r.estado) ? fs[i] : null)).filter(Boolean);
    return { estado: 200, datos: { vivas }, vivas };
  },
  (r) => r.vivas && r.vivas.length === 0);

// ESCALADA DE PRIVILEGIOS: nadie que no sea dueño puede concederse secciones.
agregar('K. Mutaciones sin sesión (deben negar)', 'un vendedor no puede concederse secciones',
  async () => {
    const t = await entrar('5500000003');            // Vendedor puro
    if (!t) return { estado: 0, datos: 'sin token' };
    const intento = await pedir('POST', 'rpc/set_secciones_vendedor',
      { p_data: { token: t, idVendedor: 3, secciones: ['caja', 'gastos', 'resumen'] } });
    const despues = await pedir('POST', 'rpc/mis_secciones', { p_token: t });
    const secs = despues.datos?.secciones || [];
    return { estado: 200, datos: intento.datos,
             bloqueado: intento.datos?.ok === false,
             limpio: !secs.includes('caja') && !secs.includes('resumen') };
  },
  (r) => r.bloqueado === true && r.limpio === true,
  true);

// ── L. ordenes y prospectos: escrituras cerradas ───────────────────────────
// Producción no tiene respaldos automáticos (plan gratuito). Que `anon` pudiera
// BORRAR órdenes y prospectos era el riesgo irreversible del proyecto.
agregar('L. ordenes/prospectos (Etapa B)', 'DELETE bloqueado en 9 tablas',
  async () => {
    const ts = ['ordenes', 'ordenes_detalle', 'prospectos', 'lotes_produccion',
                'productos', 'jornadas', 'cupones', 'produccion_diaria',
                'productos_bebidas'];
    const res = await Promise.all(ts.map((t) => pedir('DELETE', `${t}?id=eq.999999`)));
    const abiertas = res.map((r, i) => (r.estado < 400 ? ts[i] : null)).filter(Boolean);
    return { estado: 200, datos: { abiertas }, abiertas };
  },
  (r) => r.abiertas && r.abiertas.length === 0);

agregar('L. ordenes/prospectos (Etapa B)', 'no se puede alterar el total de un pedido',
  () => pedir('PATCH', 'ordenes?id=eq.1', { total: 1 }),
  (r) => r.estado >= 400);

agregar('L. ordenes/prospectos (Etapa B)', 'no se pueden insertar prospectos directo',
  () => pedir('POST', 'prospectos', { nombre_negocio: 'intruso' }),
  (r) => r.estado >= 400);

for (const f of ['actualizar_campos_pedido', 'crear_prospecto', 'actualizar_prospecto']) {
  agregar('L. ordenes/prospectos (Etapa B)', `rpc/${f} sin sesión`,
    () => pedir('POST', `rpc/${f}`, { p_data: { idOrden: '1', id: 1, campos: {} } }),
    (r) => r.estado === 200 && r.datos && r.datos.ok === false);
}

// La lista blanca importa tanto como la sesión: ni un admin debe poder cambiar
// el importe de un pedido por esta vía.
agregar('L. ordenes/prospectos (Etapa B)', 'ni con sesión de admin se toca el total',
  async () => {
    const t = await entrar('5500000001');
    if (!t) return { estado: 0, datos: 'sin token' };
    return pedir('POST', 'rpc/actualizar_campos_pedido',
      { p_data: { token: t, idOrden: '1', campos: { total: 1 } } });
  },
  (r) => r.datos?.ok === false && /Campo no permitido/.test(r.datos?.error || ''),
  true);

// El vendedor de un prospecto lo fija el servidor desde el token, no el payload.
agregar('L. ordenes/prospectos (Etapa B)', 'el vendedor sale de la sesión, no del payload',
  async () => {
    const t = await entrar('5500000003');
    if (!t) return { estado: 0, datos: 'sin token' };
    const r = await pedir('POST', 'rpc/crear_prospecto', {
      p_data: { token: t, nombre_negocio: 'Prueba automatizada',
                tipo_negocio: 'abarrotes', id_vendedor: 99, nombre_vendedor: 'Falso' }
    });
    return { estado: 200, datos: r.datos, creado: r.datos?.ok === true };
  },
  (r) => r.creado === true,
  true);

// ── M. Fuerza bruta contra el PIN ──────────────────────────────────────────
// El PIN son 4 dígitos: 10.000 combinaciones. Desde la Etapa B emite un token
// que abre finanzas y el padrón de clientes, así que dejarlo sin freno era
// dejar la puerta principal entornada.
//
// Se usa un teléfono ALEATORIO INEXISTENTE por dos motivos: no deja bloqueado a
// ningún vendedor real, y evita que la escalada de bloqueos (15→30→60…) haga
// fallar la prueba en ejecuciones sucesivas.
agregar('M. Límite de intentos de PIN', 'bloquea tras 5 fallos',
  async () => {
    const tel = '55' + String(Date.now()).slice(-8);
    const fallar = (pin) => pedir('POST', 'rpc/validar_vendedor_pin',
      { p_data: { telefono: tel, pin } });

    const previos = [];
    for (let i = 1; i <= 5; i++) previos.push(await fallar('000' + i));
    const sexto = await fallar('0006');

    // Los cinco primeros NO deben bloquear; el sexto sí.
    const algunoBloqueadoAntes = previos.some((r) => r.datos?.bloqueado === true);
    return { estado: 200, datos: sexto.datos,
             algunoBloqueadoAntes, bloqueadoAlSexto: sexto.datos?.bloqueado === true };
  },
  (r) => r.algunoBloqueadoAntes === false && r.bloqueadoAlSexto === true,
  true);

// La tabla de control no debe ser visible ni tocable desde fuera: revela qué
// teléfonos se están atacando y permitiría borrar los bloqueos.
agregar('M. Límite de intentos de PIN', 'intentos_pin cerrada a anon',
  () => pedir('GET', 'intentos_pin?select=*&limit=1'), cerrado);

agregar('M. Límite de intentos de PIN', 'registrar_fallo_pin no invocable',
  () => pedir('POST', 'rpc/registrar_fallo_pin', { p_telefono: '5500000001' }),
  (r) => r.estado === 401 || r.estado === 404);

// ── N. Cambio y restablecimiento de PIN ────────────────────────────────────
// La pantalla es nueva; el RPC ya existía protegido. Lo que se comprueba aquí
// es la autorización, que es donde un error se paga caro: quien pueda
// restablecer PINes ajenos puede suplantar a cualquiera.
agregar('N. Cambio de PIN', 'sin sesión no se cambia nada',
  () => pedir('POST', 'rpc/cambiar_pin_vendedor',
    { p_data: { idVendedor: 1, pinNuevo: '999999' } }),
  (r) => r.estado === 200 && r.datos?.ok === false);

agregar('N. Cambio de PIN', 'el PIN actual equivocado no pasa',
  async () => {
    const t = await entrar('5500000005');
    if (!t) return { estado: 0, datos: 'sin token' };
    return pedir('POST', 'rpc/cambiar_pin_vendedor',
      { p_data: { token: t, pinActual: '0000', pinNuevo: '999999' } });
  },
  (r) => r.datos?.ok === false && /PIN actual incorrecto/.test(r.datos?.error || ''),
  true);

agregar('N. Cambio de PIN', 'un vendedor no restablece el de otro',
  async () => {
    const t = await entrar('5500000005');
    if (!t) return { estado: 0, datos: 'sin token' };
    return pedir('POST', 'rpc/cambiar_pin_vendedor',
      { p_data: { token: t, idVendedor: 7, pinNuevo: '999999' } });
  },
  (r) => r.datos?.ok === false && /No autorizado/.test(r.datos?.error || ''),
  true);

agregar('N. Cambio de PIN', 'un socio administrador2 tampoco',
  async () => {
    const t = await entrar('5500000004');
    if (!t) return { estado: 0, datos: 'sin token' };
    return pedir('POST', 'rpc/cambiar_pin_vendedor',
      { p_data: { token: t, idVendedor: 7, pinNuevo: '999999' } });
  },
  (r) => r.datos?.ok === false && /No autorizado/.test(r.datos?.error || ''),
  true);

// Ciclo completo del dueño: restablece, comprueba que el PIN nuevo entra, que
// el token anterior murió, y deja el PIN como estaba.
agregar('N. Cambio de PIN', 'el dueño restablece y revoca sesiones',
  async () => {
    const admin = await entrar('5500000001');
    if (!admin) return { estado: 0, datos: 'sin token admin' };
    const tokenVictima = await entrar('5500000007');

    const reset = await pedir('POST', 'rpc/cambiar_pin_vendedor',
      { p_data: { token: admin, idVendedor: 7, pinNuevo: '778899' } });

    const conNuevo = await pedir('POST', 'rpc/validar_vendedor_pin',
      { p_data: { telefono: '5500000007', pin: '778899' } });

    // El token que tenía la víctima antes del cambio debe estar muerto.
    const viejo = await pedir('POST', 'rpc/obtener_clientes',
      { p_data: { token: tokenVictima } });

    // Restaurar para no dejar staging alterado.
    const vuelta = await pedir('POST', 'rpc/cambiar_pin_vendedor',
      { p_data: { token: admin, idVendedor: 7, pinNuevo: '1234' } });

    return { estado: 200,
             datos: { reset: reset.datos, restaurado: vuelta.datos?.ok },
             ok: reset.datos?.ok === true &&
                 conNuevo.datos?.ok === true &&
                 viejo.datos?.ok === false &&
                 vuelta.datos?.ok === true };
  },
  (r) => r.ok === true,
  true);

// ── J. Hallazgo 20: toma de control por cambiar_pin_vendedor ───────────────
// Sonda NO destructiva: se usa un idVendedor inexistente, así que no se toca
// ninguna cuenta real. Lo que distingue una base parcheada de una vulnerable es
// el MENSAJE:
//   "Vendedor no encontrado"  -> VULNERABLE: llegó a intentar el UPDATE sin
//                                pedir credencial. Con un id real habría
//                                cambiado el PIN.
//   "PIN actual incorrecto"   -> parcheada: pide el PIN actual antes de nada.
// Por eso sirve igual en staging y en producción.
agregar('J. cambiar_pin_vendedor (hallazgo 20)', 'exige el PIN actual [sonda inocua]',
  () => pedir('POST', 'rpc/cambiar_pin_vendedor',
    { p_data: { idVendedor: 999999, pinNuevo: '123456' } }),
  (r) => r.estado === 200 && r.datos &&
         /PIN actual incorrecto|Sesión inválida/.test(r.datos.error || ''));

// Y el ataque completo contra una cuenta real, solo en staging.
agregar('J. cambiar_pin_vendedor (hallazgo 20)', 'no se puede secuestrar la cuenta 5',
  async () => {
    const r = await pedir('POST', 'rpc/cambiar_pin_vendedor',
      { p_data: { idVendedor: 5, pinNuevo: '9999' } });
    // Comprobar que el PIN original sigue sirviendo: si el ataque hubiera
    // funcionado, este login fallaría.
    const login = await pedir('POST', 'rpc/validar_vendedor_pin',
      { p_data: { telefono: '5500000005', pin: '1234' } });
    return { estado: 200, datos: r.datos, intacto: login.datos?.ok === true };
  },
  (r) => r.datos?.ok !== true && r.intacto === true,
  true);

// mis_secciones deriva del token: no se pueden pedir los permisos de otro.
agregar('I. Permisos por sección', 'mis_secciones sin token no revela nada',
  () => pedir('POST', 'rpc/mis_secciones', { p_token: 'a'.repeat(64) }),
  (r) => r.estado === 200 && r.datos && r.datos.ok === false);

// Y con sesión válida deben seguir devolviendo lo de siempre.
agregar('H. Finanzas/personal SIN sesión (deben negar)', 'con sesión: los 5 en uso responden ok',
  async () => {
    const t = await entrar('5500000001');
    if (!t) return { estado: 0, datos: 'sin token' };
    const res = await Promise.all([
      pedir('POST', 'rpc/dashboard_resumen',       { p_data: { token: t } }),
      pedir('POST', 'rpc/resumen_gastos',          { p_data: { token: t } }),
      pedir('POST', 'rpc/obtener_vendedores',      { p_data: { token: t } }),
      pedir('POST', 'rpc/obtener_pendientes_caja', { p_token: t }),
      pedir('POST', 'rpc/metricas_regalo_mes',     { p_anio: 2026, p_mes: 8, p_token: t }),
    ]);
    const malos = res.filter((r) => !(r.estado === 200 && r.datos?.ok === true)).length;
    return { estado: 200, datos: { malos }, malos };
  },
  (r) => r.malos === 0,
  true);

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
