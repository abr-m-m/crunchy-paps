#!/usr/bin/env node
// tools/probar-reparto.mjs — Reparto P1 contra STAGING: bloques del día por alcance,
// salir a ruta en bloque, entregar con ubicación, paquetería y repartidor manual.
// Necesita `node tools/ver-en-staging.mjs`. Uso: node tools/probar-reparto.mjs [--sin-limpieza]
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging') { console.error('No es staging'); process.exit(1); }
const H = { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' };
const SIN_CONEXION = ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'];
const conReintento = async (fn) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 4 || !SIN_CONEXION.includes(e?.cause?.code)) throw e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); } } };
const rpc = async (n, b) => { const r = await conReintento(() => fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })); return { status: r.status, json: await r.json().catch(() => null) }; };
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };
const SIN_LIMPIEZA = process.argv.includes('--sin-limpieza');

const login = async (tel) => (await rpc('validar_vendedor_pin', { p_data: { telefono: tel, pin: '1234' } })).json;
const ana = await login('5500000001'), beto = await login('5500000002'), carla = await login('5500000003'), elsa = await login('5500000005');
const idCarla = carla?.vendedor?.id, idElsa = elsa?.vendedor?.id;
ok(!!(ana?.token && beto?.token && carla?.token && elsa?.token), 'sesiones de Ana (dueña), Beto (mostrador), Carla y Elsa (vendedoras)');

const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const hoyIso = hoy + 'T18:00:00.000Z';
const rutas = (await rpc('get_rutas', {})).json?.rutas || [];
const R = rutas.find(r => (r.cobertura || []).some(c => c.tipo === 'colonia' && c.valor === 'alamos')) || rutas[0];
const asignar = (b) => rpc('asignar_vendedor_ruta', { p_data: { token: ana?.token, ...b } });
for (const r of rutas) if (Number(r.idVendedor) === Number(idCarla)) await asignar({ idRuta: r.id, idVendedor: null });
await asignar({ idRuta: R?.id, idVendedor: idCarla });
ok(!!R, `ruta de prueba: ${R?.nombre} (Carla)`);

// Datos: una tienda de R con pedido, y tres pedidos de consumidor de Carla (domicilio ×2, paquetería ×1).
const prod = (await (await fetch(`${SUPABASE_URL}/rest/v1/productos?select=id,sabor,presentacion,precio_consumidor,precio_tienda&limit=1&order=id`, { headers: H })).json())[0];
const linea = (precio) => [{ idProducto: String(prod.id), sabor: prod.sabor, presentacion: prod.presentacion, tipoVenta: 'Por Pieza', cantidad: 1, gramos: 0, precio, subtotal: precio }];
const telT = '559' + String(Date.now()).slice(-7);
const alta = await rpc('registrar_o_actualizar_cliente', { p_data: { telefono: telT, nombre: 'Tienda Reparto Prueba', tipo: 'Tienda / Abarrotes', tipoId: 3, direccion: 'Calle 1', cp: '03400', colonia: 'alamos', municipio: 'Benito Juárez', estado: 'CDMX', coordenadas: '19.3950,-99.1300', aprobadoB2B: false, idVendedor: idCarla, nombreVendedor: 'Carla Ejemplo Nieto' } });
const cliT = ((await rpc('obtener_clientes', { p_data: { token: ana?.token, limit: 500 } })).json?.clientes || []).find(c => c.telefono === telT);
await rpc('aprobar_cliente_b2b', { p_id_cliente: Number(cliT?.id), p_aprobar: true, p_actor: 'probar-reparto', p_token: ana?.token });
const sesT = (await rpc('emitir_sesion_prueba', { p_telefono: telT })).json;
const pT = (await rpc('crear_pedido', { p_data: { tokenCliente: sesT?.token, idCliente: cliT?.id, nombre: 'Tienda Reparto Prueba', telefono: telT, cp: '03400', colonia: 'alamos', coordenadas: '19.3950,-99.1300', fechaEntrega: hoyIso, total: Number(prod.precio_tienda), metodoEntrega: 'coordinar', productos: linea(Number(prod.precio_tienda)), idempotencyKey: 'rep-t-' + telT } })).json;
ok(!!(alta.json && cliT && pT?.ok), `tienda de ${R?.nombre} con pedido ${pT?.consecutivo || JSON.stringify(pT).slice(0, 80)} para hoy`);

const telC = '558' + String(Date.now()).slice(-7);
const pc = Number(prod.precio_consumidor);
const mk = async (k, extra) => (await rpc('crear_pedido', { p_data: { token: carla?.token, canal: 'vendedor', tipoCliente: 'consumidor', nombre: 'Consumidor Reparto ' + k, telefono: telC, cp: '03400', colonia: 'Álamos', direccion: 'Calle ' + k, fechaEntrega: hoyIso, metodoEntrega: 'coordinar', total: pc, productos: linea(pc), idempotencyKey: 'rep-c-' + telC + k, ...extra } })).json;
const c1 = await mk('A', { coordenadas: '19.3909758,-99.1249345' });          // en la planta
const c2 = await mk('B', { coordenadas: '19.4000,-99.1400' });                // lejos
const c3 = await mk('C', { metodoEntrega: 'paqueteria', total: pc + 80, zonaEntrega: 'foraneo' });
ok(c1?.ok && c2?.ok && c3?.ok, `tres pedidos de consumidor de Carla: ${c1?.consecutivo}, ${c2?.consecutivo}, ${c3?.consecutivo} (paquetería)` + (c1?.ok && c2?.ok && c3?.ok ? '' : ' → ' + JSON.stringify([c1, c2, c3].find(c => !c?.ok)).slice(0, 120)));
// Confirmar los tres primeros (nacen Pendiente). c3 se queda Pendiente a propósito: cuenta como porConfirmar.
const confirmar = (id) => rpc('actualizar_estatus_pedido', { p_data: { token: ana?.token, idOrden: String(id), estatusPedido: 'En proceso', actualizadoPor: 'probar-reparto' } });
for (const id of [pT, c1, c2].map(p => p?.idOrden)) if (id) await confirmar(id);

// 1. Permisos.
const sinSec = (await rpc('reparto_del_dia', { p_data: { token: beto?.token } })).json;
ok(sinSec?.ok === false && /autorizado/i.test(sinSec?.error || ''), `Beto sin sección → ${sinSec?.error}`);

// 2. Ana ve todo: la ruta con la tienda, Carla en consumidores, porConfirmar ≥ 1.
const t0 = Date.now();
const A = (await rpc('reparto_del_dia', { p_data: { token: ana?.token, fecha: hoy } })).json;
console.log(`        (reparto_del_dia respondió en ${Date.now() - t0} ms)`);
const rutaA = (A?.rutas || []).find(r => r.id === R?.id);
const consCarla = (A?.consumidores || []).find(g => Number(g.idRepartidor) === Number(idCarla));
ok(A?.ok === true && A.todas === true && !!rutaA && rutaA.pedidos.some(p => p.id === pT?.idOrden), `Ana: ${R?.nombre} trae ${pT?.consecutivo}`);
ok(!!consCarla && [c1, c2].every(c => consCarla.pedidos.some(p => p.id === c?.idOrden)) && !consCarla.pedidos.some(p => p.id === c3?.idOrden), 'Ana: bloque de Carla con A y B, sin la paquetería');
ok(A?.porConfirmar >= 1, `porConfirmar = ${A?.porConfirmar}`);
ok(!!rutaA && rutaA.pedidos.every(p => p.metodoEntrega === 'domicilio'), 'los pedidos traen metodoEntrega');

// 3. Carla ve solo su ruta y sus consumidores; nada de paquetería ni sin ruta.
const C = (await rpc('reparto_del_dia', { p_data: { token: carla?.token, fecha: hoy } })).json;
ok(C?.ok === true && C.todas === false && (C.rutas || []).length === 1 && C.rutas[0].id === R?.id, `Carla: una ruta (${C?.rutas?.[0]?.nombre})`);
ok((C?.consumidores || []).length === 1 && C.consumidores[0].pedidos.length >= 2 && C.paqueteria.length === 0 && C.sinRuta.length === 0, 'Carla: solo su bloque de consumidores; paquetería y sin ruta vacíos');
const E = (await rpc('reparto_del_dia', { p_data: { token: elsa?.token, fecha: hoy } })).json;
ok(E?.ok === true && (E.rutas || []).length === 0 && !(E.consumidores || []).some(g => Number(g.idRepartidor) === Number(idCarla)), 'Elsa no ve lo de Carla');

// 4. Salir a ruta en bloque: tienda + A + uno ajeno → 2 cambiados, 1 rechazado.
const ajeno = (A?.sinRuta?.[0] || A?.consumidores?.find(g => Number(g.idRepartidor) !== Number(idCarla))?.pedidos?.[0])?.id;
const salir = (await rpc('salir_a_ruta', { p_data: { token: carla?.token, ids: [pT?.idOrden, c1?.idOrden, ...(ajeno ? [ajeno] : [])] } })).json;
ok(salir?.ok === true && salir.cambiados === 2 && (!ajeno || (salir.rechazados.length === 1 && /tuyo/i.test(salir.rechazados[0].motivo))), `salir a ruta → cambiados ${salir?.cambiados}, rechazados ${JSON.stringify(salir?.rechazados)}`);
const leer = async (id) => ((await rpc('obtener_pedidos', { p_data: { token: ana?.token, ids: [id] } })).json?.pedidos || [])[0];
ok((await leer(pT?.idOrden))?.estatus_pedido === 'En camino' && (await leer(c1?.idOrden))?.estatus_pedido === 'En camino', 'los dos quedaron En camino');
const otra = (await rpc('salir_a_ruta', { p_data: { token: carla?.token, ids: [c1?.idOrden] } })).json;
ok(otra?.cambiados === 0 && /En camino/.test(otra?.rechazados?.[0]?.motivo || ''), 'salir de nuevo no cambia nada');

// 5. Entregar: sin ubicación → error y 0 escrituras; en el punto → Entregado y distancia < 100.
const sinUbi = (await rpc('entregar_pedido', { p_data: { token: carla?.token, id: c1?.idOrden } })).json;
const c1a = await leer(c1?.idOrden);
ok(sinUbi?.ok === false && /ubicación/i.test(sinUbi?.error || '') && c1a?.estatus_pedido === 'En camino' && c1a?.entrega_lat == null, 'sin ubicación no se entrega ni se escribe nada');
const cerca = (await rpc('entregar_pedido', { p_data: { token: carla?.token, id: c1?.idOrden, lat: 19.3910, lng: -99.1249 } })).json;
const c1b = await leer(c1?.idOrden);
ok(cerca?.ok === true && cerca.estatus === 'Entregado' && cerca.distanciaM < 100 && cerca.fueraDelPunto === false && c1b?.estatus_pedido === 'Entregado' && !!c1b?.fecha_entrega_real, `entregado a ${cerca?.distanciaM} m, fecha real puesta`);
// Lejos: fuera del punto, pero entregado.
await rpc('salir_a_ruta', { p_data: { token: carla?.token, ids: [c2?.idOrden] } });
const lejos = (await rpc('entregar_pedido', { p_data: { token: carla?.token, id: c2?.idOrden, lat: 19.3909758, lng: -99.1249345 } })).json;
ok(lejos?.ok === true && lejos.fueraDelPunto === true && lejos.distanciaM > 100, `lejos: fuera del punto a ${lejos?.distanciaM} m`);
// Elsa no puede entregar lo de Carla.
const noSuyo = (await rpc('entregar_pedido', { p_data: { token: elsa?.token, id: pT?.idOrden, lat: 19.395, lng: -99.13 } })).json;
ok(noSuyo?.ok === false && /tuyo/i.test(noSuyo?.error || ''), `Elsa no entrega lo de Carla → ${noSuyo?.error}`);

// 6. Paquetería: confirmar, «Enviado» sin ubicación → En camino; «Enviado» en un domicilio no aplica.
await confirmar(c3?.idOrden);
const env = (await rpc('entregar_pedido', { p_data: { token: ana?.token, id: c3?.idOrden, enviado: true } })).json;
ok(env?.ok === true && env.estatus === 'En camino', `paquetería: Enviado → ${env?.estatus || env?.error}`);
const envDom = (await rpc('entregar_pedido', { p_data: { token: carla?.token, id: pT?.idOrden, enviado: true } })).json;
ok(envDom?.ok === false && /paqueter/i.test(envDom?.error || ''), `«Enviado» en un domicilio → ${envDom?.error}`);
const A2 = (await rpc('reparto_del_dia', { p_data: { token: ana?.token, fecha: hoy } })).json;
ok((A2?.paqueteria || []).some(p => p.id === c3?.idOrden) && (A2?.porConfirmar ?? 0) === (A?.porConfirmar - 1), `la paquetería aparece en su bloque y porConfirmar bajó en 1 (${A?.porConfirmar} → ${A2?.porConfirmar})`);

// 7. Repartidor manual: solo el dueño, solo consumidores.
const noDueno = (await rpc('asignar_repartidor', { p_data: { token: carla?.token, id: c3?.idOrden, idRepartidor: idElsa } })).json;
ok(noDueno?.ok === false && /autorizado/i.test(noDueno?.error || ''), 'Carla no asigna repartidor');
const tienda = (await rpc('asignar_repartidor', { p_data: { token: ana?.token, id: pT?.idOrden, idRepartidor: idElsa } })).json;
ok(tienda?.ok === false && /consumidor/i.test(tienda?.error || ''), `pedido de tienda → ${tienda?.error}`);
const c4 = await mk('D', { coordenadas: '19.3950,-99.1300' }); if (c4?.idOrden) await confirmar(c4.idOrden);
const asg = (await rpc('asignar_repartidor', { p_data: { token: ana?.token, id: c4?.idOrden, idRepartidor: idElsa } })).json;
const E2 = (await rpc('reparto_del_dia', { p_data: { token: elsa?.token, fecha: hoy } })).json;
const C2 = (await rpc('reparto_del_dia', { p_data: { token: carla?.token, fecha: hoy } })).json;
ok(asg?.ok === true && (E2?.consumidores || []).some(g => g.pedidos.some(p => p.id === c4?.idOrden)) && !(C2?.consumidores || []).some(g => g.pedidos.some(p => p.id === c4?.idOrden)), 'D pasa a Elsa: ella lo ve, Carla ya no');
await rpc('asignar_repartidor', { p_data: { token: ana?.token, id: c4?.idOrden, idRepartidor: null } });

// Limpieza: los pedidos de prueba se cancelan y Carla suelta la ruta (salvo --sin-limpieza, para mirarlos en el navegador).
if (!SIN_LIMPIEZA) {
  for (const id of [pT?.idOrden, c3?.idOrden, c4?.idOrden]) if (id) await rpc('actualizar_estatus_pedido', { p_data: { token: ana?.token, idOrden: String(id), estatusPedido: 'Cancelado', actualizadoPor: 'probar-reparto' } });
  await asignar({ idRuta: R?.id, idVendedor: null });
} else {
  console.log(`        (sin limpieza: Carla conserva ${R?.nombre}; pedidos ${pT?.consecutivo}, ${c3?.consecutivo}, ${c4?.consecutivo} siguen abiertos)`);
}

console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en orden.');
process.exitCode = fallos ? 1 : 0;
