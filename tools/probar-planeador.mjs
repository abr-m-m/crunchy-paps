#!/usr/bin/env node
// tools/probar-planeador.mjs — Planeador E3.1 contra STAGING: solo el dueño lee los datos,
// los conteos cuadran, set_rutas guarda días de preventa y ruta_del_dia visita por ellos.
// Necesita `node tools/ver-en-staging.mjs`. Uso: node tools/probar-planeador.mjs
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging') { console.error('No es staging'); process.exit(1); }
const H = { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' };
const SIN_CONEXION = ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'];
const conReintento = async (fn) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 4 || !SIN_CONEXION.includes(e?.cause?.code)) throw e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); } } };
const rpc = async (n, b) => { const r = await conReintento(() => fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })); return { status: r.status, json: await r.json().catch(() => null) }; };
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

const login = async (tel) => (await rpc('validar_vendedor_pin', { p_data: { telefono: tel, pin: '1234' } })).json;
const ana = await login('5500000001'), beto = await login('5500000002'), carla = await login('5500000003');
const idCarla = carla?.vendedor?.id;
ok(!!(ana?.token && beto?.token && carla?.token), 'sesiones de Ana (dueña), Beto y Carla');

// 1. Solo el dueño.
const b = (await rpc('planeador_datos', { p_data: { token: beto?.token } })).json;
const c = (await rpc('planeador_datos', { p_data: { token: carla?.token } })).json;
const s = (await rpc('planeador_datos', { p_data: {} })).json;
ok(b?.ok === false && c?.ok === false && s?.ok === false && [b, c, s].every(x => /autorizado/i.test(x?.error || '')), 'Beto, Carla y sin token → No autorizado');

// 2. Los datos del dueño: forma y consistencia.
const t0 = Date.now();
const D = (await rpc('planeador_datos', { p_data: { token: ana?.token } })).json;
console.log(`        (planeador_datos respondió en ${Date.now() - t0} ms)`);
const hayCps = Array.isArray(D?.cps) && D.cps.length > 0;   // sin datos, cada caso cuenta como fallo, no como éxito vacío
ok(D?.ok === true && Array.isArray(D.cps) && D.cps.length > 0 && D.sinCp && Array.isArray(D.rutas) && D.generado, `datos: ${D?.cps?.length} CP, ${D?.rutas?.length} rutas, sin CP ${JSON.stringify(D?.sinCp)}`);
ok(hayCps && D.cps.every(x => /^\d{5}$/.test(x.cp) && x.prospectos >= 0 && x.tiendas >= 0 && x.consumidores >= 0 && Array.isArray(x.colonias)), 'cada CP tiene 5 dígitos y conteos no negativos');
ok(hayCps && D.cps.every(x => x.prospectos + x.tiendas + x.consumidores > 0), 'ningún CP vacío');
ok(hayCps && D.cps.every(x => (x.lat == null) === (x.lng == null)), 'lat y lng van juntos');
const sinNombres = JSON.stringify(D).indexOf('telefono') === -1 && JSON.stringify(D).indexOf('nombre_negocio') === -1;
ok(hayCps && sinNombres, 'la respuesta no lleva teléfonos ni nombres de negocio');
// Los prospectos del CP 08300 (datos de prueba 2054-2066) existen y son activos: el planeador los cuenta.
const c08300 = (D?.cps || []).find(x => x.cp === '08300');
ok(!!c08300 && c08300.prospectos >= 5, `CP 08300 con ${c08300?.prospectos} prospectos activos`);
ok(Array.isArray(D?.rutas) && D.rutas.length > 0 && D.rutas.every(r => 'diasPreventa' in r && 'vendedor' in r && Array.isArray(r.cobertura)), 'las rutas traen diasPreventa, vendedor y cobertura');

// 3. set_rutas v3: diasPreventa se guarda; sin la clave se conserva; nulo la borra.
const rutasAntes = (await rpc('get_rutas', { p_data: { incluirInactivas: true } })).json?.rutas || [];
const activas = rutasAntes.filter(r => r.activa);
const R = activas.find(r => (r.cobertura || []).some(x => x.tipo === 'colonia' && x.valor === 'alamos')) || activas[0];
const hoy = new Date(); const dowHoy = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', weekday: 'short' }).format(hoy);
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }; const d = DOW[dowHoy];
const otro = (d + 3) % 7;                                         // un día que no es hoy
const payload = (rutas) => ({ p_data: { token: ana?.token, rutas: rutas.map(r => ({ id: r.id, nombre: r.nombre, color: r.color, dias: r.dias, activa: r.activa, cobertura: r.cobertura, ...(r.diasPreventa !== undefined ? { diasPreventa: r.diasPreventa } : {}) })) } });
// preventa = [hoy], reparto = [otro] en R: hoy se visita, no se entrega.
const conPreventa = activas.map(r => r.id === R.id ? { ...r, dias: [otro], diasPreventa: [d] } : { ...r, diasPreventa: undefined });
const g1 = (await rpc('set_rutas', payload(conPreventa))).json;
const R1 = ((await rpc('get_rutas', {})).json?.rutas || []).find(r => r.id === R.id);
ok(g1?.ok === true && JSON.stringify(R1?.diasPreventa) === JSON.stringify([d]) && JSON.stringify(R1?.dias) === JSON.stringify([otro]), `set_rutas guarda preventa [${d}] y reparto [${otro}] en ${R?.nombre}`);
// Sin la clave: se conserva.
const sinClave = activas.map(r => r.id === R.id ? { ...r, dias: [otro] } : r).map(r => ({ ...r, diasPreventa: undefined }));
await rpc('set_rutas', payload(sinClave));
const R2 = ((await rpc('get_rutas', {})).json?.rutas || []).find(r => r.id === R.id);
ok(JSON.stringify(R2?.diasPreventa) === JSON.stringify([d]), 'sin la clave diasPreventa, set_rutas conserva el valor');

// 4. ruta_del_dia visita por preventa: Carla con R hoy la ve; por reparto (otro día) no.
await rpc('asignar_vendedor_ruta', { p_data: { token: ana?.token, idRuta: R.id, idVendedor: idCarla } });
const hoyIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(hoy);
const v = (await rpc('ruta_del_dia', { p_data: { token: carla?.token, fecha: hoyIso } })).json;
ok(v?.ok === true && v.ruta?.id === R.id && JSON.stringify(v.ruta?.diasPreventa) === JSON.stringify([d]), `Mi ruta hoy (preventa): ${v?.ruta?.nombre}`);
const masDias = (n) => { const x = new Date(hoyIso + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const diaReparto = [1, 2, 3, 4, 5, 6].map(masDias).find(f => new Date(f + 'T12:00:00Z').getUTCDay() === otro);
const v2 = (await rpc('ruta_del_dia', { p_data: { token: carla?.token, fecha: diaReparto } })).json;
ok(v2?.ok === true && v2.ruta === null, `el día de reparto (${diaReparto}) no hay visita: la siguiente es ${v2?.proximaFecha}`);
// Nulo: vuelve a visitar por reparto.
const conNulo = activas.map(r => r.id === R.id ? { ...r, dias: R.dias, diasPreventa: null } : { ...r, diasPreventa: undefined });
await rpc('set_rutas', payload(conNulo));
const R3 = ((await rpc('get_rutas', {})).json?.rutas || []).find(r => r.id === R.id);
ok(R3?.diasPreventa === null && JSON.stringify(R3?.dias) === JSON.stringify(R.dias), 'diasPreventa nulo y reparto restaurado');
await rpc('asignar_vendedor_ruta', { p_data: { token: ana?.token, idRuta: R.id, idVendedor: null } });

console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en orden.');
process.exitCode = fallos ? 1 : 0;
