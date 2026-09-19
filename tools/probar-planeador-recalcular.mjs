#!/usr/bin/env node
// tools/probar-planeador-recalcular.mjs — Planeador E3.2 contra STAGING: ruta fijada a mano,
// simulación y aplicación del recálculo de tiendas por cobertura. Deja las rutas como estaban.
// Necesita `node tools/ver-en-staging.mjs`. Uso: node tools/probar-planeador-recalcular.mjs
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging') { console.error('No es staging'); process.exit(1); }
const H = { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' };
const SIN_CONEXION = ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'];
const conReintento = async (fn) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 4 || !SIN_CONEXION.includes(e?.cause?.code)) throw e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); } } };
const rpc = async (n, b) => { const r = await conReintento(() => fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })); return { status: r.status, json: await r.json().catch(() => null) }; };
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

const login = async (tel) => (await rpc('validar_vendedor_pin', { p_data: { telefono: tel, pin: '1234' } })).json;
const ana = await login('5500000001'), carla = await login('5500000003');
ok(!!(ana?.token && carla?.token), 'sesiones de Ana (dueña) y Carla');

// Foto de las rutas para restaurarlas al final.
const rutasIni = (await rpc('get_rutas', {})).json?.rutas || [];
const payload = (rutas) => ({ p_data: { token: ana?.token, rutas: rutas.map(r => ({ id: r.id, nombre: r.nombre, color: r.color, dias: r.dias, activa: true, cobertura: r.cobertura })) } });
const A = rutasIni.find(r => (r.cobertura || []).some(c => c.tipo === 'cp' && '03400' >= c.valor && '03400' <= (c.cpHasta || c.valor)));
const B = rutasIni.find(r => r.id !== A?.id);
ok(!!A && !!B, `rutas de prueba: A=${A?.nombre} (cubre 03400), B=${B?.nombre}`);

// Dos tiendas en 03400: T1 queda automática, T2 se fija a mano en B.
const alta = async (sufijo) => {
  const tel = '557' + String(Date.now()).slice(-6) + sufijo;
  await rpc('registrar_o_actualizar_cliente', { p_data: { telefono: tel, nombre: 'Tienda Recalcular ' + sufijo, tipo: 'Tienda / Abarrotes', tipoId: 3, direccion: 'Calle 1', cp: '03400', colonia: 'Zona Prueba ' + sufijo, municipio: 'Benito Juárez', estado: 'CDMX', coordenadas: '', aprobadoB2B: false } });
  const c = ((await rpc('obtener_clientes', { p_data: { token: ana?.token, limit: 1000 } })).json?.clientes || []).find(x => x.telefono === tel);
  await rpc('aprobar_cliente_b2b', { p_id_cliente: Number(c?.id), p_aprobar: true, p_actor: 'probar-recalcular', p_token: ana?.token });
  return c;
};
const t1 = await alta('1'), t2 = await alta('2');
ok(!!(t1?.id && t2?.id) && Number(t1.id_ruta) === Number(A?.id), `dos tiendas en 03400; el trigger las puso en ${A?.nombre}`);
const fij = (await rpc('reasignar_ruta_cliente', { p_data: { token: ana?.token, idCliente: t2.id, idRuta: B.id } })).json;
ok(fij?.ok === true, `T2 fijada a mano en ${B?.nombre}`);

// 1. Solo el dueño.
const noDueno = (await rpc('planeador_recalcular', { p_data: { token: carla?.token, simular: true } })).json;
ok(noDueno?.ok === false && /autorizado/i.test(noDueno?.error || ''), 'Carla → No autorizado');

// 2. Con la cobertura de hoy: T1 no aparece (coincide); T2 aparece, fijada, de B a A.
const s1 = (await rpc('planeador_recalcular', { p_data: { token: ana?.token, simular: true } })).json;
const e1 = (s1?.tiendas || []).find(x => x.id === t1.id), e2 = (s1?.tiendas || []).find(x => x.id === t2.id);
ok(s1?.ok === true && !e1 && e2?.fijada === true && e2?.rutaActual?.id === B.id && e2?.rutaNueva?.id === A.id, `simulación: T1 fuera, T2 fijada ${e2?.rutaActual?.nombre} → ${e2?.rutaNueva?.nombre}`);

// 3. Se mueve 03400 de A a B en la cobertura: ahora T1 aparece (sin fijar) y T2 ya no (coincide con B).
const expandir = (r) => r.cobertura.flatMap(c => c.tipo === 'cp' && c.cpHasta && c.cpHasta !== c.valor ? [{ tipo: 'cp', valor: c.valor, cpHasta: c.cpHasta }] : [c]);
const sinCp = (cob) => cob.flatMap(c => (c.tipo === 'cp' && '03400' >= c.valor && '03400' <= (c.cpHasta || c.valor))
  ? (c.cpHasta && c.cpHasta !== c.valor ? [{ tipo: 'cp', valor: '03401', cpHasta: c.cpHasta }].filter(x => x.valor <= x.cpHasta) : [])
  : [c]);
const movidas = rutasIni.map(r => r.id === A.id ? { ...r, cobertura: sinCp(expandir(r)) } : r.id === B.id ? { ...r, cobertura: [...r.cobertura, { tipo: 'cp', valor: '03400' }] } : r);
const g = (await rpc('set_rutas', payload(movidas))).json;
const s2 = (await rpc('planeador_recalcular', { p_data: { token: ana?.token, simular: true } })).json;
const f1 = (s2?.tiendas || []).find(x => x.id === t1.id), f2 = (s2?.tiendas || []).find(x => x.id === t2.id);
ok(g?.ok === true && f1?.fijada === false && f1?.rutaActual?.id === A.id && f1?.rutaNueva?.id === B.id && !f2, `tras mover 03400: T1 sin fijar ${f1?.rutaActual?.nombre} → ${f1?.rutaNueva?.nombre}; T2 fuera`);

// 4. Simular no escribe.
const t1b = ((await rpc('obtener_clientes', { p_data: { token: ana?.token, limit: 1000 } })).json?.clientes || []).find(x => x.id === t1.id);
ok(Number(t1b?.id_ruta) === Number(A.id), 'simular no cambió la ruta de T1');

// 5. Aplicar solo a T1.
const ap = (await rpc('planeador_recalcular', { p_data: { token: ana?.token, simular: false, ids: [t1.id] } })).json;
const t1c = ((await rpc('obtener_clientes', { p_data: { token: ana?.token, limit: 1000 } })).json?.clientes || []).find(x => x.id === t1.id);
ok(ap?.ok === true && ap.cambiadas === 1 && Number(t1c?.id_ruta) === Number(B.id) && t1c?.ruta_fijada === false, `aplicar a T1 → cambiadas ${ap?.cambiadas}, ahora en ${B.nombre}, sin fijar`);
const ap2 = (await rpc('planeador_recalcular', { p_data: { token: ana?.token, simular: false, ids: [t1.id] } })).json;
ok(ap2?.cambiadas === 0, 'aplicar otra vez no cambia nada');

// 6. «Sin ruta» en la tarjeta suelta la fijación.
await rpc('reasignar_ruta_cliente', { p_data: { token: ana?.token, idCliente: t2.id, idRuta: null } });
const t2b = ((await rpc('obtener_clientes', { p_data: { token: ana?.token, limit: 1000 } })).json?.clientes || []).find(x => x.id === t2.id);
ok(t2b?.id_ruta == null && t2b?.ruta_fijada === false, '«Sin ruta» en la tarjeta deja la tienda sin fijar');

// Limpieza: rutas como estaban; las dos tiendas de prueba se desaprueban.
await rpc('set_rutas', payload(rutasIni));
for (const t of [t1, t2]) await rpc('aprobar_cliente_b2b', { p_id_cliente: Number(t.id), p_aprobar: false, p_actor: 'probar-recalcular', p_token: ana?.token });
const fin = (await rpc('get_rutas', {})).json?.rutas || [];
const foto = (rs) => JSON.stringify(rs.map(r => [r.nombre, r.dias, r.cobertura.map(c => c.tipo + c.valor + (c.cpHasta || '')).sort()]));
ok(foto(fin) === foto(rutasIni), 'las rutas quedaron como estaban');

console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en orden.');
process.exitCode = fallos ? 1 : 0;
