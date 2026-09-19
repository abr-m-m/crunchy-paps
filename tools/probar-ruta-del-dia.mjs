#!/usr/bin/env node
// tools/probar-ruta-del-dia.mjs — Entrega 2 de «Ruta del día» contra STAGING:
// vendedor por ruta, «Mi ruta de hoy» con tope de 60, orden por cercanía,
// check del día y visitas a clientes. Necesita `node tools/ver-en-staging.mjs`.
// Uso: node tools/probar-ruta-del-dia.mjs
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging') { console.error('No es staging'); process.exit(1); }
const H = { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' };
// Reintenta SOLO si la conexión no llegó a abrirse: la petición no salió y repetirla es seguro.
const SIN_CONEXION = ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'];
const conReintento = async (fn) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 4 || !SIN_CONEXION.includes(e?.cause?.code)) throw e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); } } };
const rpc = async (n, b) => { const r = await conReintento(() => fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })); return { status: r.status, json: await r.json().catch(() => null) }; };
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

const ana   = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000001', pin: '1234' } })).json;
const beto  = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000002', pin: '1234' } })).json;
const carla = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000003', pin: '1234' } })).json;
const idCarla = carla?.vendedor?.id;
ok(!!(ana?.token && beto?.token && carla?.token && idCarla), 'sesiones de Ana (dueña), Beto (sin la sección) y Carla (vendedora)');

// Ruta de prueba: la que cubre el CP 08300.
const rutas = (await rpc('get_rutas', {})).json?.rutas || [];
const R = rutas.find(r => (r.cobertura || []).some(c => c.tipo === 'cp' && '08300' >= c.valor && '08300' <= (c.cpHasta || c.valor)));
ok(!!R && Array.isArray(R.dias) && R.dias.length > 0 && R.dias.length < 7, `ruta del CP 08300: ${R?.nombre} (días ${R?.dias})`);

// Fechas en CDMX.
const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const masDias = (f, n) => { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = (f) => new Date(f + 'T12:00:00Z').getUTCDay();
const semana = [...Array(7).keys()].map(n => masDias(hoy, n));
const diaDeR = semana.find(f => R?.dias.includes(dow(f)));
const diaSinR = semana.find(f => !R?.dias.includes(dow(f)));
const asignar = (b) => rpc('asignar_vendedor_ruta', { p_data: { token: ana?.token, ...b } });

// 0. Limpieza: Carla sin rutas al empezar (por si una corrida anterior se cortó).
for (const r of rutas) if (idCarla && Number(r.idVendedor) === Number(idCarla)) await asignar({ idRuta: r.id, idVendedor: null });

// 1. Permisos.
const sinSec = (await rpc('ruta_del_dia', { p_data: { token: beto?.token } })).json;
ok(sinSec?.ok === false && /autorizado/i.test(sinSec?.error || ''), `Beto sin la sección → ${sinSec?.error}`);
const noDueno = (await rpc('asignar_vendedor_ruta', { p_data: { token: carla?.token, idRuta: R?.id, idVendedor: idCarla } })).json;
ok(noDueno?.ok === false && /autorizado/i.test(noDueno?.error || ''), `Carla no asigna rutas → ${noDueno?.error}`);

// 2. Sin ruta asignada, a Carla no le toca nada ni siquiera el día de R.
const sinAsignar = (await rpc('ruta_del_dia', { p_data: { token: carla?.token, fecha: diaDeR } })).json;
ok(sinAsignar?.ok === true && sinAsignar.ruta === null && sinAsignar.veTodas === false, `Carla sin ruta asignada el ${diaDeR} → ruta ${JSON.stringify(sinAsignar?.ruta)}`);

// 3. Ana asigna R a Carla y get_rutas lo refleja.
const asig = (await asignar({ idRuta: R?.id, idVendedor: idCarla })).json;
const R2 = ((await rpc('get_rutas', {})).json?.rutas || []).find(r => r.id === R?.id);
ok(asig?.ok === true && Number(R2?.idVendedor) === Number(idCarla), `Ana asigna ${R?.nombre} a Carla → idVendedor ${R2?.idVendedor}`);

// 4. Carla, el día de R: su ruta, con tope de 60 y numeración continua.
const t0 = Date.now();
const c1 = (await rpc('ruta_del_dia', { p_data: { token: carla?.token, fecha: diaDeR } })).json;
console.log(`        (ruta_del_dia respondió en ${Date.now() - t0} ms)`);
const paradas = c1?.paradas || [];
ok(c1?.ok === true && c1.ruta?.id === R?.id && paradas.length <= 60 && c1.avance?.programadas === paradas.length, `Carla el ${diaDeR}: ${c1?.ruta?.nombre}, ${paradas.length} paradas`);
ok(paradas.every(p => p.tipo === 'cliente' || !['descartado', 'convertido'].includes(p.estatus) || p.visitadaHoy), 'ningún prospecto descartado o convertido, salvo los visitados ese día');
ok(paradas.every((p, i) => p.orden === i + 1), 'paradas numeradas del 1 en adelante, sin huecos');

// 5. Una ruta que no es suya, y un día en que no le toca.
const otra = rutas.find(r => r.id !== R?.id);
const ajena = (await rpc('ruta_del_dia', { p_data: { token: carla?.token, idRuta: otra?.id } })).json;
ok(!otra || (ajena?.ok === false && /tu ruta/i.test(ajena?.error || '')), `ruta ajena → ${ajena?.error}`);
const libre = (await rpc('ruta_del_dia', { p_data: { token: carla?.token, fecha: diaSinR } })).json;
const esperada = [...Array(7).keys()].map(n => masDias(diaSinR, n + 1)).find(f => R?.dias.includes(dow(f)));
ok(libre?.ok === true && libre.ruta === null && libre.proximaFecha === esperada, `el ${diaSinR} no le toca; la siguiente es ${libre?.proximaFecha} (esperada ${esperada})`);

// 6. Orden por vecino más cercano desde la planta; sin coordenadas, al final.
const dist = (a, b) => { const rad = x => x * Math.PI / 180; const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2; return Math.round(2 * 6371000 * Math.asin(Math.sqrt(h))); };
const conCoords = paradas.filter(p => p.lat != null && p.lng != null);
let actual = [19.3909758, -99.1249345], vecinoOk = true;
for (let k = 0; k < conCoords.length; k++) {
  const minimo = Math.min(...conCoords.slice(k).map(p => dist(actual, [p.lat, p.lng])));
  if (dist(actual, [conCoords[k].lat, conCoords[k].lng]) > minimo + 1) { vecinoOk = false; break; }
  actual = [conCoords[k].lat, conCoords[k].lng];
}
const primeraSin = paradas.findIndex(p => p.lat == null);
const sinCoordsAlFinal = primeraSin === -1 || paradas.slice(primeraSin).every(p => p.lat == null);
ok(vecinoOk && sinCoordsAlFinal, `orden por cercanía en ${conCoords.length} paradas con coordenadas; las demás al final`);

// 7. Ana ve la misma ruta hoy aunque no le toque, con un cliente aprobado de la ruta.
const tel = '558' + String(Date.now()).slice(-7);
await rpc('registrar_o_actualizar_cliente', { p_data: { telefono: tel, nombre: 'Cliente ruta prueba', tipo: 'Tienda / Abarrotes', tipoId: 3, direccion: 'Calle 1', cp: '08300', colonia: 'Santa Anita', municipio: 'Iztacalco', estado: 'CDMX', coordenadas: '19.3990,-99.1120', aprobadoB2B: false } });
const leerClientes = async () => (await rpc('obtener_clientes', { p_data: { token: ana?.token, limit: 500 } })).json?.clientes || [];
const cli = (await leerClientes()).find(c => c.telefono === tel);
await rpc('aprobar_cliente_b2b', { p_id_cliente: Number(cli?.id), p_aprobar: true, p_actor: 'probar-ruta-del-dia', p_token: ana?.token });
// Un prospecto nuevo por corrida: cada corrida visita uno y el descanso de 6 días lo saca de la
// lista, así que con los del seed la prueba se quedaba sin prospectos que visitar.
const nuevo = (await rpc('crear_prospecto', { p_data: { token: ana?.token, nombre_negocio: 'Prospecto ruta prueba ' + tel, tipo_negocio: 'Tienda', codigo_postal: '08300', colonia: 'Santa Anita', municipio: 'Iztacalco', estado: 'CDMX', latitud: 19.3985, longitud: -99.1125, coordenadas: '19.3985,-99.1125', score: 5, estatus: 'pendiente', num_visitas: 0, origen: 'prueba' } })).json;
ok(nuevo?.ok === true && nuevo.id, `prospecto fresco de la corrida: ${nuevo?.id ?? nuevo?.error}`);
const a1 = (await rpc('ruta_del_dia', { p_data: { token: ana?.token, idRuta: R?.id, fecha: hoy } })).json;
const clientesDeR = (await leerClientes()).filter(c => Number(c.id_ruta) === Number(R?.id) && c.aprobado_b2b && [2, 3, 4].includes(Number(c.tipo_id))).length;
const cliEnLista = (a1?.paradas || []).filter(p => p.tipo === 'cliente');
ok(a1?.ok === true && a1.veTodas === true && a1.ruta?.id === R?.id, `Ana ve ${a1?.ruta?.nombre} el ${hoy}`);
ok(cliEnLista.length === Math.min(clientesDeR, 60) && cliEnLista.some(p => p.id === cli?.id), `clientes de la ruta en la lista: ${cliEnLista.length} de ${clientesDeR}, incluido el de prueba`);

// 8. Check del día: visitar un prospecto lo marca y no lo saca de la lista.
const objetivo = (a1?.paradas || []).find(p => p.tipo === 'prospecto' && Number(p.id) === Number(nuevo?.id));
ok(!!objetivo && !objetivo.visitadaHoy, `el prospecto fresco entra en la lista de ${R?.nombre}`);
const antes = a1?.avance?.visitadas ?? 0;
const vp = (await rpc('registrar_visita', { p_data: { token: ana?.token, idProspecto: objetivo?.id, resultado: 'no_estaba', lat: objetivo?.lat, lng: objetivo?.lng } })).json;
const a2 = (await rpc('ruta_del_dia', { p_data: { token: ana?.token, idRuta: R?.id, fecha: hoy } })).json;
const marcado = (a2?.paradas || []).find(p => p.tipo === 'prospecto' && p.id === objetivo?.id);
ok(vp?.ok === true && marcado?.visitadaHoy === true && marcado.etiquetaHoy === 'No estaba el encargado' && a2.avance.visitadas === antes + 1, `prospecto ${objetivo?.id} con check; visitadas ${antes} → ${a2?.avance?.visitadas}`);

// 9. Visitas a clientes, con su propio catálogo.
const malCli = (await rpc('registrar_visita', { p_data: { token: ana?.token, idCliente: cli?.id, resultado: 'convertido', lat: 19.399, lng: -99.112 } })).json;
ok(malCli?.ok === false && /cliente/i.test(malCli?.error || ''), `«Convertido» no vale para un cliente → ${malCli?.error}`);
const malPro = (await rpc('registrar_visita', { p_data: { token: ana?.token, idProspecto: objetivo?.id, resultado: 'pedido', lat: objetivo?.lat, lng: objetivo?.lng } })).json;
ok(malPro?.ok === false && /prospecto/i.test(malPro?.error || ''), `«Levantó pedido» no vale para un prospecto → ${malPro?.error}`);
const vc = (await rpc('registrar_visita', { p_data: { token: ana?.token, idCliente: cli?.id, resultado: 'pedido', lat: 19.399, lng: -99.112 } })).json;
const a3 = (await rpc('ruta_del_dia', { p_data: { token: ana?.token, idRuta: R?.id, fecha: hoy } })).json;
const cliMarcado = (a3?.paradas || []).find(p => p.tipo === 'cliente' && p.id === cli?.id);
ok(vc?.ok === true && vc.etiqueta === 'Levantó pedido' && cliMarcado?.visitadaHoy === true && cliMarcado.etiquetaHoy === 'Levantó pedido', `visita a cliente → «${vc?.etiqueta}», con check en la ruta`);

// 9b. Abrir un prospecto por id con la regla nueva: el de su ruta sí, Beto no, uno ajeno no.
const deSuRuta = (a1?.paradas || []).find(p => p.tipo === 'prospecto');
const abre = (await rpc('obtener_prospecto', { p_data: { token: carla?.token, id: deSuRuta?.id } })).json;
ok(abre?.ok === true && Number(abre.prospecto?.id) === Number(deSuRuta?.id), `Carla abre el prospecto ${deSuRuta?.id} de su ruta por id`);
const betoAbre = (await rpc('obtener_prospecto', { p_data: { token: beto?.token, id: deSuRuta?.id } })).json;
ok(betoAbre?.ok === false && /autorizado/i.test(betoAbre?.error || ''), `Beto no → ${betoAbre?.error}`);
const ajeno = (await rpc('ruta_del_dia', { p_data: { token: ana?.token, idRuta: otra?.id } })).json;
const pAjeno = (ajeno?.paradas || []).find(p => p.tipo === 'prospecto');
const carlaAjeno = pAjeno ? (await rpc('obtener_prospecto', { p_data: { token: carla?.token, id: pAjeno.id } })).json : null;
ok(!pAjeno || (carlaAjeno?.ok === false && /autorizado/i.test(carlaAjeno?.error || '')), `Carla no abre el ${pAjeno?.id ?? '(sin prospectos en la otra ruta)'} de otra ruta → ${carlaAjeno?.error ?? 'n/a'}`);

// 10. Sin asignación, a Carla ya no le toca.
await asignar({ idRuta: R?.id, idVendedor: null });
const fin = (await rpc('ruta_del_dia', { p_data: { token: carla?.token, fecha: diaDeR } })).json;
ok(fin?.ok === true && fin.ruta === null, 'al quitar la asignación, Carla deja de ver la ruta');

console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en orden.');
process.exitCode = fallos ? 1 : 0;
