#!/usr/bin/env node
// tools/probar-visitas.mjs — Entrega 1 de «Ruta del día» contra STAGING:
// visitas con resultado de catálogo, ubicación obligatoria, 100 m e historial.
// Necesita `node tools/ver-en-staging.mjs`. Uso: node tools/probar-visitas.mjs
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging') { console.error('No es staging'); process.exit(1); }
const H = { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' };
// Reintenta SOLO si la conexión no llegó a abrirse: la petición no salió y repetirla es seguro.
// Un tiempo muerto esperando respuesta NO se reintenta: la visita pudo quedar registrada.
const SIN_CONEXION = ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'];
const conReintento = async (fn) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 4 || !SIN_CONEXION.includes(e?.cause?.code)) throw e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); } } };
const rpc = async (n, b) => { const r = await conReintento(() => fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })); return { status: r.status, json: await r.json().catch(() => null) }; };
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

const ana  = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000001', pin: '1234' } })).json;
const beto = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000002', pin: '1234' } })).json;
ok(!!(ana?.token && beto?.token), 'sesiones de Ana (con prospección) y Beto (sin prospección)');

// Prospectos de prueba: P1 con coordenadas, P2 para convertir, P3 sin coordenadas.
const LAT = 19.3990, LNG = -99.1120;
const sufijo = String(Date.now()).slice(-7);
const crear = async (extra) => (await rpc('crear_prospecto', { p_data: { token: ana?.token, nombre_negocio: 'Visita prueba ' + sufijo, tipo_negocio: 'Tienda / Abarrotes', codigo_postal: '08300', colonia: 'Santa Anita', notas: 'Nota original', ...extra } })).json;
const p1 = await crear({ latitud: LAT, longitud: LNG });
const p2 = await crear({ latitud: LAT, longitud: LNG, contacto_telefono: '559' + sufijo });
const p3 = await crear({});
ok(!!(p1?.id && p2?.id && p3?.id), `prospectos de prueba ${p1?.id}, ${p2?.id}, ${p3?.id}`);
const reg = (b) => rpc('registrar_visita', { p_data: { token: ana?.token, ...b } });
const hist = async (id) => (await rpc('obtener_visitas', { p_data: { token: ana?.token, idProspecto: id } })).json;

// 1. Permisos y validaciones: nada de esto escribe.
const sinSec = await rpc('registrar_visita', { p_data: { token: beto?.token, idProspecto: p1?.id, resultado: 'no_estaba', lat: LAT, lng: LNG } });
ok(sinSec.json?.ok === false && /autorizado/i.test(sinSec.json?.error || ''), `Beto no registra visitas → ${sinSec.json?.error}`);
const sinUbic = await reg({ idProspecto: p1?.id, resultado: 'no_estaba' });
ok(sinUbic.json?.ok === false && /ubicación/i.test(sinUbic.json?.error || ''), `sin ubicación no se registra → ${sinUbic.json?.error}`);
const malRes = await reg({ idProspecto: p1?.id, resultado: 'cerrado', lat: LAT, lng: LNG });
ok(malRes.json?.ok === false && /resultado/i.test(malRes.json?.error || ''), `resultado fuera de catálogo → ${malRes.json?.error}`);
const malUbic = await reg({ idProspecto: p1?.id, resultado: 'no_estaba', lat: 200, lng: LNG });
ok(malUbic.json?.ok === false && /ubicación/i.test(malUbic.json?.error || ''), `latitud imposible → ${malUbic.json?.error}`);
const h0 = await hist(p1?.id);
ok(h0?.ok === true && Array.isArray(h0.visitas) && h0.visitas.length === 0, `sin visitas todavía: ${h0?.visitas?.length}`);

// 2. En el punto: 0 m, dentro, contactado, contador +1, la nota del prospecto intacta.
const v1 = (await reg({ idProspecto: p1?.id, resultado: 'no_estaba', nota: 'Volver por la tarde', lat: LAT, lng: LNG, precision: 12 })).json;
ok(v1?.ok === true && v1.distanciaMetros === 0 && v1.fueraDelPunto === false && v1.estatus === 'contactado', `visita en el punto → ${JSON.stringify(v1)}`);
// 3. Unos 300 m al norte: se registra, marcada fuera del punto.
const v2 = (await reg({ idProspecto: p1?.id, resultado: 'interesado', lat: LAT + 0.0027, lng: LNG })).json;
ok(v2?.ok === true && v2.distanciaMetros >= 280 && v2.distanciaMetros <= 320 && v2.fueraDelPunto === true, `visita a ${v2?.distanciaMetros} m → fuera del punto`);
// Unos 90 m: sigue dentro, y «Le pareció caro» no descarta.
const v3 = (await reg({ idProspecto: p1?.id, resultado: 'caro', lat: LAT + 0.0008, lng: LNG })).json;
ok(v3?.ok === true && v3.distanciaMetros < 100 && v3.fueraDelPunto === false && v3.estatus === 'contactado', `a ${v3?.distanciaMetros} m sigue dentro y «Le pareció caro» no descarta`);
const h1 = await hist(p1?.id);
ok(h1?.visitas?.length === 3 && h1.visitas[0].id === v3?.idVisita && h1.visitas[2].id === v1?.idVisita, 'historial: 3 visitas, la más reciente primero');
// crear_prospecto hace nacer el contador en 1 (crearlo en campo cuenta como contacto): se mide contra el inicial.
ok(h1?.prospecto?.numVisitas === (h0?.prospecto?.numVisitas ?? 0) + 3 && h1.prospecto.notas === 'Nota original', `contador ${h0?.prospecto?.numVisitas} → ${h1?.prospecto?.numVisitas} (+3) y nota del prospecto intacta: «${h1?.prospecto?.notas}»`);
ok(h1?.visitas?.[2]?.nota === 'Volver por la tarde' && h1.visitas[2].etiqueta === 'No estaba el encargado', 'la nota de la visita vive en la visita, con su etiqueta');

// 4. «No le interesa» descarta con motivo; un descartado no admite otra visita.
const v4 = (await reg({ idProspecto: p1?.id, resultado: 'no_le_interesa', lat: LAT, lng: LNG })).json;
const h2 = await hist(p1?.id);
ok(v4?.estatus === 'descartado' && h2?.prospecto?.motivoDescarte === 'No le interesa' && !!h2.prospecto.fechaDescarte, `«No le interesa» descarta: ${h2?.prospecto?.motivoDescarte}`);
const v5 = await reg({ idProspecto: p1?.id, resultado: 'no_estaba', lat: LAT, lng: LNG });
ok(v5.json?.ok === false && /descartado/i.test(v5.json?.error || ''), `visita a un descartado → ${v5.json?.error}`);

// 5. Convertido: exige el cliente que devolvió la conversión.
const sinCli = await reg({ idProspecto: p2?.id, resultado: 'convertido', lat: LAT, lng: LNG });
ok(sinCli.json?.ok === false && /cliente/i.test(sinCli.json?.error || ''), `convertido sin cliente → ${sinCli.json?.error}`);
const conv = (await rpc('convertir_prospecto_a_cliente', { p_data: { token: ana?.token, id: p2?.id, telefono: '559' + sufijo } })).json;
ok(conv?.ok === true && !!conv.idCliente, `conversión → cliente ${conv?.idCliente}`);
const v6 = (await reg({ idProspecto: p2?.id, resultado: 'convertido', idCliente: conv?.idCliente, lat: LAT, lng: LNG })).json;
const h3 = await hist(p2?.id);
ok(v6?.ok === true && v6.estatus === 'convertido' && h3?.visitas?.[0]?.idCliente === conv?.idCliente, `visita «Convertido» ligada al cliente ${h3?.visitas?.[0]?.idCliente}`);

// 6. Tienda sin coordenadas: se registra, sin distancia ni marca.
const v7 = (await reg({ idProspecto: p3?.id, resultado: 'ya_tiene_proveedor', lat: LAT, lng: LNG })).json;
ok(v7?.ok === true && v7.distanciaMetros === null && v7.fueraDelPunto === null && v7.estatus === 'contactado', `tienda sin coordenadas → ${JSON.stringify(v7)}`);

// 7. La ruta de la visita sale del CP limpio del prospecto.
const rutas = (await rpc('get_rutas', {})).json?.rutas || [];
const esperada = rutas.find(r => (r.cobertura || []).some(c => c.tipo === 'cp' && '08300' >= c.valor && '08300' <= (c.cpHasta || c.valor)));
ok(v1?.idRuta === (esperada?.id ?? null), `ruta de la visita ${v1?.idRuta} = ruta del CP 08300 (${esperada?.nombre ?? 'ninguna'})`);

// 8. Cerrada: la tabla no se lee con la llave pública.
const directo = await conReintento(() => fetch(`${SUPABASE_URL}/rest/v1/visitas?select=id&limit=1`, { headers: H }));
const filas = directo.status === 200 ? await directo.json() : [];
ok(directo.status !== 200 || filas.length === 0, `visitas cerrada a la llave pública (HTTP ${directo.status}, ${filas.length} filas)`);

console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en orden.');
process.exitCode = fallos ? 1 : 0;
