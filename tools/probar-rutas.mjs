#!/usr/bin/env node
// tools/probar-rutas.mjs — R1 contra STAGING: rutas como dato, asignación por
// trigger, fecha de entrega por ruta. Comprueba el valor que vuelve y su denominador.
// Necesita `node tools/ver-en-staging.mjs`. Uso: node tools/probar-rutas.mjs
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging') { console.error('No es staging'); process.exit(1); }
const rpc = async (n, b) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }); return { status: r.status, json: await r.json().catch(() => null) }; };
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };
const ana = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000001', pin: '1234' } })).json;
const carla = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000003', pin: '1234' } })).json;
ok(!!(ana?.token && carla?.token), 'sesiones de Ana (Admin) y Carla (Vendedor)');

// 1. set_rutas solo dueño; cobertura repetida rechazada; get_rutas público.
const RUTAS = [
  { nombre: 'Álamos', color: '#ffd200', dias: [1, 4], cobertura: [{ tipo: 'colonia', valor: 'Álamos' }, { tipo: 'colonia', valor: 'Postal' }, { tipo: 'cp', valor: '03400', cpHasta: '03440' }] },
  { nombre: 'Narvarte', color: '#7fd48c', dias: [2, 5], cobertura: [{ tipo: 'colonia', valor: 'Narvarte' }, { tipo: 'cp', valor: '03020', cpHasta: '03023' }] },
  { nombre: 'Iztacalco', color: '#9fd3f5', dias: [3, 6], cobertura: [{ tipo: 'cp', valor: '08200', cpHasta: '08500' }] },
];
const sinDueno = await rpc('set_rutas', { p_data: { token: carla?.token, rutas: RUTAS } });
ok(sinDueno.status === 200 && sinDueno.json?.ok === false && /autorizado/i.test(sinDueno.json?.error || ''), `Carla no fija rutas → ${JSON.stringify(sinDueno.json).slice(0, 70)}`);
const dup = await rpc('set_rutas', { p_data: { token: ana?.token, rutas: [RUTAS[0], { ...RUTAS[1], cobertura: [{ tipo: 'colonia', valor: 'alamos' }] }] } });
ok(dup.json?.ok === false && /dos rutas/i.test(dup.json?.error || ''), `colonia en dos rutas → rechazada: ${dup.json?.error}`);
const set = await rpc('set_rutas', { p_data: { token: ana?.token, rutas: RUTAS } });
ok(set.json?.ok === true && set.json?.rutas === 3, `Ana fija 3 rutas → ${JSON.stringify(set.json)}`);
const get = await rpc('get_rutas', {});
const rutas = get.json?.rutas || [];
ok(get.json?.ok === true && rutas.length === 3 && rutas.every(r => Array.isArray(r.dias) && Array.isArray(r.cobertura)), `get_rutas público: ${rutas.length} rutas con días y cobertura`);
const idAlamos = rutas.find(r => r.nombre === 'Álamos')?.id, idNarvarte = rutas.find(r => r.nombre === 'Narvarte')?.id;

// 2. Trigger en clientes: alta con colonia «alamos» (minúsculas, sin acento) → ruta Álamos.
const tel = '559' + String(Date.now()).slice(-7);
const ficha = { telefono: tel, nombre: 'Tienda Ruta Prueba', tipo: 'Tienda / Abarrotes', tipoId: 3, direccion: 'Calle 1', cp: '03400', colonia: 'alamos', municipio: 'Benito Juárez', estado: 'CDMX', coordenadas: '', aprobadoB2B: false, idVendedor: 3, nombreVendedor: 'Carla Ejemplo Nieto' };
const alta = await rpc('registrar_o_actualizar_cliente', { p_data: ficha });
ok(!!(alta.json?.ok || alta.json?.idCliente), `alta de prueba ${tel} → ${JSON.stringify(alta.json).slice(0, 80)}`);
// La ficha se lee con obtener_clientes (select c.*: trae id_ruta), no con
// obtener_cliente_con_stats, que enumera sus claves y no conoce la ruta.
const leerCliente = async (telefono) => ((await rpc('obtener_clientes', { p_data: { token: ana?.token, limit: 500 } })).json?.clientes || []).find(c => c.telefono === telefono) || null;
const cliRaw = await leerCliente(tel); const cli = cliRaw ? { id: cliRaw.id, idRuta: cliRaw.id_ruta } : null;
ok(!!cli && Number(cli.idRuta) === Number(idAlamos), `trigger asignó la ruta Álamos (idRuta ${cli?.idRuta} = ${idAlamos})`);

// 3. Reasignar a mano y que el trigger no la pise al re-guardar la ficha.
const re = await rpc('reasignar_ruta_cliente', { p_data: { token: ana?.token, idCliente: cli?.id, idRuta: idNarvarte } });
ok(re.json?.ok === true && re.json?.ruta === 'Narvarte', `reasignar a Narvarte → ${JSON.stringify(re.json)}`);
await rpc('registrar_o_actualizar_cliente', { p_data: { ...ficha, direccion: 'Calle 2', idVendedor: undefined, nombreVendedor: undefined } });
const cli2Raw = await leerCliente(tel); const cli2 = cli2Raw ? { idRuta: cli2Raw.id_ruta } : null;
ok(Number(cli2?.idRuta) === Number(idNarvarte), `tras re-guardar la ficha sigue en Narvarte (${cli2?.idRuta})`);
const sinSec = await rpc('reasignar_ruta_cliente', { p_data: { token: carla?.token, idCliente: cli?.id, idRuta: idAlamos } });
ok(sinSec.json?.ok === false, `Carla (sin sección b2b) no reasigna → ${sinSec.json?.error}`);

// 4. Fecha de entrega por ruta: Narvarte = martes (2) y viernes (5).
const fe = (await rpc('obtener_fecha_entrega', { p_data: { telefono: tel } })).json;
const dow = fe?.fecha ? new Date(fe.fecha + 'T12:00:00').getDay() : -1;
ok(!!fe?.ok && [2, 5].includes(dow), `fecha por ruta ${fe?.fecha} cae en martes o viernes (dow ${dow}) · «${fe?.msg}»`);
const feCons = (await rpc('obtener_fecha_entrega', { p_data: {} })).json;
ok(!!feCons?.ok && /18:00/.test(feCons?.msg || '') && !/ruta/i.test(feCons?.msg || ''), `sin teléfono sigue la regla de la hora límite: «${feCons?.msg}»`);

// 5. Trigger en ordenes: el pedido guarda la ruta del cliente y cola_armado la enseña.
// Sin aprobar, crear_pedido cobra precio de consumidor y rechazaría precio_tienda (precio_cambiado).
const apr = await rpc('aprobar_cliente_b2b', { p_id_cliente: Number(cli?.id), p_aprobar: true, p_actor: 'probar-rutas', p_token: ana?.token });
ok(apr.status === 200 && !apr.json?.error, `tienda aprobada para cobrar precio_tienda → ${JSON.stringify(apr.json).slice(0, 60)}`);
const ses = (await rpc('emitir_sesion_prueba', { p_telefono: tel })).json;
const prod = (await (await fetch(`${SUPABASE_URL}/rest/v1/productos?select=id,sabor,presentacion,precio_tienda&limit=1&order=id`, { headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}` } })).json())[0];
const precio = Number(prod.precio_tienda);
const ped = (await rpc('crear_pedido', { p_data: { tokenCliente: ses?.token, idCliente: cli?.id, nombre: 'Tienda Ruta Prueba', telefono: tel, cp: ficha.cp, colonia: ficha.colonia, total: precio, metodoEntrega: 'coordinar', productos: [{ idProducto: String(prod.id), sabor: prod.sabor, presentacion: prod.presentacion, tipoVenta: 'Por Pieza', cantidad: 1, gramos: 0, precio, subtotal: precio }], idempotencyKey: 'ruta-' + Date.now() } })).json;
ok(!!ped?.ok, `pedido de prueba → ${ped?.consecutivo || JSON.stringify(ped).slice(0, 80)}`);
const cola = (await rpc('cola_armado', { p_data: { token: ana?.token, desde: new Date(Date.now() - 120000).toISOString() } })).json;
const nuevo = (cola?.nuevos || []).find(p => p.consecutivo === ped?.consecutivo);
ok(!!nuevo && Number(nuevo.idRuta) === Number(idNarvarte) && nuevo.ruta === 'Narvarte', `cola_armado trae la ruta del pedido: ${nuevo?.ruta} (${nuevo?.idRuta})`);

console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en orden.');
process.exitCode = fallos ? 1 : 0;
