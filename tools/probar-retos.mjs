#!/usr/bin/env node
// tools/probar-retos.mjs — Retos de compra del Crunchy Club (20260930000009). Spec: cambios/2026-09-19-retos.md.
// Ana (dueña) crea los retos; clientes de prueba hacen pedidos; el bono es un asiento 'reto' que escriben los
// triggers de puntos. Los retos de prueba se pausan al final. Escribe en STAGING: con permiso de Abraham.
// Necesita `node tools/ver-en-staging.mjs`. Uso: node tools/probar-retos.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STG = 'dkwatbsaidlfjqjnfyrk';
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging' || !SUPABASE_URL.includes(STG)) { console.error('No es staging: ' + SUPABASE_URL); process.exit(1); }
const H = { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' };
const SIN_CONEXION = ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET'];
const conReintento = async (fn) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 5 || !SIN_CONEXION.includes(e?.cause?.code)) throw e; await new Promise(r => setTimeout(r, 2000 * (i + 1))); } } };
const rpc = async (n, b) => { const r = await conReintento(() => fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })); return { status: r.status, json: await r.json().catch(() => null) }; };
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };
const dir = mkdtempSync(join(tmpdir(), 'retos-'));
const sql = (q) => { const f = join(dir, 'q.sql'); writeFileSync(f, q); const out = execSync(`supabase db query --linked --project-ref ${STG} -o json --file "${f}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return JSON.parse(out.slice(out.indexOf('{'))).rows || []; };
const sqlOVacio = (q) => { try { return sql(q); } catch (_e) { return null; } };

const ana = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000001', pin: '1234' } })).json;
const carla = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000003', pin: '1234' } })).json;
const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const enDias = (n) => { const d = new Date(Date.now() + n * 864e5); return d.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }); };
const sufijo = String(Date.now()).slice(-5);

const prods = await conReintento(async () => (await fetch(`${SUPABASE_URL}/rest/v1/productos?select=id,sabor,presentacion,precio_consumidor,precio_tienda,canje_activo&order=id`, { headers: H })).json());
const porSabor = {}; for (const p of prods) if (Number(p.precio_consumidor) > 0) (porSabor[p.sabor] ||= []).push(p);
const sabores = Object.keys(porSabor);
const pA = porSabor[sabores[0]][0], pB = porSabor[sabores[1]]?.[0];
const c0 = ((await rpc('canje_catalogo', {})).json?.productos || [])[0];
const pCanje = prods.find(p => p.id === c0?.id);
if (!ana?.token || !pA || !pB || !c0 || !pCanje) { ok(false, `preparación: ana ${!!ana?.token}, sabores ${sabores.length}, canje ${!!c0}`); console.log(`\n${fallos} fallo(s).`); process.exit(1); }

const alta = async (nombre, extra = {}) => {
  const tel = '553' + String(Date.now()).slice(-7); await new Promise(r => setTimeout(r, 5));
  const a = (await rpc('registrar_o_actualizar_cliente', { p_data: { telefono: tel, nombre, tipo: 'Consumidor', tipoId: 1, direccion: 'Calle 1', cp: '03400', colonia: 'Álamos', municipio: 'Benito Juárez', estado: 'CDMX', coordenadas: '', ...extra } })).json;
  const ses = (await rpc('emitir_sesion_prueba', { p_telefono: tel })).json;
  return { tel, token: ses?.token, id: a?.idCliente, nombre };
};
const linea = (p, n, precio) => ({ idProducto: String(p.id), sabor: p.sabor, presentacion: p.presentacion, tipoVenta: 'Por Pieza', cantidad: n, gramos: 0, precio, subtotal: Math.round(precio * n * 100) / 100 });
const pedido = async (c, extra) => (await rpc('crear_pedido', { p_data: { tokenCliente: c.token, idCliente: c.id, nombre: c.nombre, telefono: c.tel, cp: '03400', colonia: 'Álamos', direccion: 'Calle 1', metodoEntrega: 'coordinar', idempotencyKey: 'reto-' + c.tel + '-' + Math.random(), ...extra } })).json;
const estatus = (idOrden, campos) => rpc('actualizar_estatus_pedido', { p_data: { token: ana?.token, idOrden: String(idOrden), actualizadoPor: 'probar-retos', ...campos } });
const pagar = (p) => estatus(p?.idOrden, { estatusPago: 'Pagado' });
const entregar = (p) => estatus(p?.idOrden, { estatusPedido: 'Entregado' });
const cancelar = (p) => estatus(p?.idOrden, { estatusPedido: 'Cancelado' });
const mis = async (c) => (await rpc('mis_puntos', { p_token: c.token })).json;
const bonos = (m, idReto) => (m?.movimientos || []).filter(x => x.tipo === 'reto' && x.premio && String(x.premio).includes(idReto)).reduce((s, x) => s + Number(x.puntos), 0);
const retoDe = (m, id) => (m?.retos || []).find(r => r.id === id);
const crearReto = async (reto) => (await rpc('guardar_reto', { p_data: { token: ana?.token, reto } })).json;
const P = Number(pA.precio_consumidor);
const creados = [];

// 1. Frecuencia: meta 2, bono 50, todos.
const rF = await crearReto({ nombre: 'Frecuencia ' + sufijo, descripcion: 'Dos pedidos', tipo: 'frecuencia', meta: 2, bono: 50, desde: enDias(-1), hasta: enDias(7), publico: 'todos', activo: true });
creados.push(rF?.reto?.id);
ok(rF?.ok === true && rF.reto?.id > 0, `guardar_reto frecuencia → ${rF?.ok ? 'id ' + rF.reto.id : JSON.stringify(rF).slice(0, 80)}`);
const cF = await alta('Reto Frecuencia');
const f1 = await pedido(cF, { total: P, productos: [linea(pA, 1, P)] }); await pagar(f1);
const m1 = await mis(cF);
ok(bonos(m1, rF?.reto?.nombre) === 0 && retoDe(m1, rF?.reto?.id)?.avance == 1 && retoDe(m1, rF?.reto?.id)?.cumplido === false, `1 pedido pagado: sin bono, avance ${retoDe(m1, rF?.reto?.id)?.avance} de 2`);
const f2 = await pedido(cF, { total: P, productos: [linea(pA, 1, P)] }); await pagar(f2);
const m2 = await mis(cF);
ok(bonos(m2, rF?.reto?.nombre) === 50 && retoDe(m2, rF?.reto?.id)?.cumplido === true, `2.º pedido pagado: bono +${bonos(m2, rF?.reto?.nombre)} (50), cumplido`);
const f3 = await pedido(cF, { total: P, productos: [linea(pA, 1, P)] }); await pagar(f3);
ok(bonos(await mis(cF), rF?.reto?.nombre) === 50, `3.º pedido: el bono no se repite (${bonos(await mis(cF), rF?.reto?.nombre)})`);

// 2. Cancelar uno de los tres deja 2 (sigue cumplido); cancelar otro deja 1 → se quita; pagar otro → vuelve.
await cancelar(f3);
ok(bonos(await mis(cF), rF?.reto?.nombre) === 50, 'cancelar el 3.º: quedan 2, el bono se queda');
await cancelar(f2);
const m4 = await mis(cF);
ok(bonos(m4, rF?.reto?.nombre) === 0 && retoDe(m4, rF?.reto?.id)?.cumplido === false && (m4?.movimientos || []).some(x => x.tipo === 'reto' && Number(x.puntos) === -50), `cancelar el 2.º: −50, ya no cumplido (neto ${bonos(m4, rF?.reto?.nombre)})`);
const f4 = await pedido(cF, { total: P, productos: [linea(pA, 1, P)] }); await pagar(f4);
ok(bonos(await mis(cF), rF?.reto?.nombre) === 50, `pagar otro: vuelve el bono (${bonos(await mis(cF), rF?.reto?.nombre)})`);

// 3. Producto: 3 piezas del sabor A; 2 compradas + 1 canjeada no cumple; 3 compradas sí.
const rP = await crearReto({ nombre: 'Producto ' + sufijo, descripcion: 'Tres de ' + pCanje.sabor, tipo: 'producto', meta: 3, sabor: pCanje.sabor, bono: 30, desde: enDias(-1), hasta: enDias(7), publico: 'consumidores', activo: true });
creados.push(rP?.reto?.id);
const cP = await alta('Reto Producto');
sql(`insert into public.lealtad_movimientos (id_cliente, tipo, puntos, nota, actor) values (${Number(cP.id)}, 'ajuste', ${c0.puntos}, 'prueba de retos', 'probar-retos') returning id`);
const Pc = Number(pCanje.precio_consumidor);
const p1 = await pedido(cP, { total: Pc * 2, puntosCanje: c0.puntos, productos: [linea(pCanje, 2, Pc), { ...linea(pCanje, 1, 0), subtotal: 0, canje: true, puntos: c0.puntos }] }); await pagar(p1);
const mp1 = await mis(cP);
ok(p1?.ok === true && retoDe(mp1, rP?.reto?.id)?.avance == 2 && bonos(mp1, rP?.reto?.nombre) === 0, `producto: 2 compradas + 1 canjeada → avance ${retoDe(mp1, rP?.reto?.id)?.avance} (2), sin bono`);
const p2 = await pedido(cP, { total: Pc, productos: [linea(pCanje, 1, Pc)] }); await pagar(p2);
ok(bonos(await mis(cP), rP?.reto?.nombre) === 30, `producto: 3 compradas → +${bonos(await mis(cP), rP?.reto?.nombre)} (30)`);

// 4. Monto: meta $100 neto; con cupón del 10% el neto es lo que cuenta.
const CUP = 'RETO10' + sufijo;
await rpc('guardar_cupon', { p_data: { token: ana?.token, id: null, campos: { codigo: CUP, tipo: 'descuento_pct', valor: 10, descripcion: 'prueba de retos', vigencia_inicio: '2026-01-01', vigencia_fin: '2027-12-31', usos_maximos: 0, compra_minima: 0, segmento: 'todos', activo: true } } });
const nPiezas = Math.ceil(100 / (P * 0.9));               // con cupón, neto ≥ 100
const nJusto = Math.ceil(100 / P);                         // sin cupón bastaría con menos
const rM = await crearReto({ nombre: 'Monto ' + sufijo, descripcion: 'Cien pesos', tipo: 'monto', meta: 100, bono: 20, desde: enDias(-1), hasta: enDias(7), publico: 'todos', activo: true });
creados.push(rM?.reto?.id);
const cM = await alta('Reto Monto');
const netoJusto = Math.round(nJusto * P * 0.9 * 100) / 100;
const mm0 = await pedido(cM, { total: Math.round((nJusto * P - nJusto * P * 0.10) * 100) / 100, cuponCodigo: CUP, productos: [linea(pA, nJusto, P)] }); await pagar(mm0);
const mmA = await mis(cM);
if (netoJusto < 100) ok(bonos(mmA, rM?.reto?.nombre) === 0 && Number(retoDe(mmA, rM?.reto?.id)?.avance) === netoJusto, `monto: ${nJusto} piezas con cupón → neto ${retoDe(mmA, rM?.reto?.id)?.avance} < 100, sin bono (el total bruto sí llegaba)`);
else ok(true, `monto: (${nJusto} piezas con cupón ya llegan a $100 neto; se omite el caso «bruto sí, neto no»)`);
const mm1 = await pedido(cM, { total: nPiezas * P, productos: [linea(pA, nPiezas, P)] }); await pagar(mm1);
ok(bonos(await mis(cM), rM?.reto?.nombre) === 20, `monto: neto ≥ 100 → +${bonos(await mis(cM), rM?.reto?.nombre)} (20)`);

// 5. Surtido: 2 sabores en dos pedidos.
const rS = await crearReto({ nombre: 'Surtido ' + sufijo, descripcion: 'Dos sabores', tipo: 'surtido', meta: 2, bono: 15, desde: enDias(-1), hasta: enDias(7), publico: 'todos', activo: true });
creados.push(rS?.reto?.id);
const cS = await alta('Reto Surtido');
const s1 = await pedido(cS, { total: P, productos: [linea(pA, 1, P)] }); await pagar(s1);
const ms1 = await mis(cS);
const PB = Number(pB.precio_consumidor);
const s2 = await pedido(cS, { total: PB, productos: [linea(pB, 1, PB)] }); await pagar(s2);
ok(retoDe(ms1, rS?.reto?.id)?.avance == 1 && bonos(await mis(cS), rS?.reto?.nombre) === 15, `surtido: 1 sabor → avance 1; 2 sabores → +${bonos(await mis(cS), rS?.reto?.nombre)} (15)`);

// 6. Público tiendas: consumidor no; tienda sí, al entregar.
const rT = await crearReto({ nombre: 'Tiendas ' + sufijo, descripcion: 'Un pedido', tipo: 'frecuencia', meta: 1, bono: 40, desde: enDias(-1), hasta: enDias(7), publico: 'tiendas', activo: true });
creados.push(rT?.reto?.id);
const cC = await alta('Reto Consumidor');
const t0 = await pedido(cC, { total: P, productos: [linea(pA, 1, P)] }); await pagar(t0);
const mc = await mis(cC);
ok(bonos(mc, rT?.reto?.nombre) === 0 && !retoDe(mc, rT?.reto?.id), 'tiendas: el consumidor ni lo ve ni recibe bono');
const cT = await alta('Reto Tienda', { tipo: 'Tienda / Abarrotes', tipoId: 3, aprobadoB2B: false });
await rpc('aprobar_cliente_b2b', { p_id_cliente: Number(cT.id), p_aprobar: true, p_actor: 'probar-retos', p_token: ana?.token });
const PT = Number(pA.precio_tienda);
const t1 = await pedido(cT, { total: PT, productos: [linea(pA, 1, PT)] });
await pagar(t1);
const mt1 = await mis(cT);
await entregar(t1);
const mt2 = await mis(cT);
ok(t1?.ok === true && bonos(mt1, rT?.reto?.nombre) === 0 && bonos(mt2, rT?.reto?.nombre) === 40, `tienda: pagado → ${bonos(mt1, rT?.reto?.nombre)}; entregado → +${bonos(mt2, rT?.reto?.nombre)} (40)`);
await rpc('aprobar_cliente_b2b', { p_id_cliente: Number(cT.id), p_aprobar: false, p_actor: 'probar-retos', p_token: ana?.token });

// 7. Pausado: ni bono ni aparece.
const rX = await crearReto({ nombre: 'Pausado ' + sufijo, descripcion: 'No debe verse', tipo: 'frecuencia', meta: 1, bono: 99, desde: enDias(-1), hasta: enDias(7), publico: 'todos', activo: false });
creados.push(rX?.reto?.id);
const cX = await alta('Reto Pausado');
const x1 = await pedido(cX, { total: P, productos: [linea(pA, 1, P)] }); await pagar(x1);
const mx = await mis(cX);
ok(bonos(mx, rX?.reto?.nombre) === 0 && !retoDe(mx, rX?.reto?.id), 'pausado: sin bono y no aparece en mis_puntos');

// 8. Fechas: un pedido de antes del periodo no cuenta.
const rD = await crearReto({ nombre: 'Fechas ' + sufijo, descripcion: 'Solo hoy', tipo: 'frecuencia', meta: 1, bono: 10, desde: hoy, hasta: enDias(3), publico: 'todos', activo: true });
creados.push(rD?.reto?.id);
const cD = await alta('Reto Fechas');
const d1 = await pedido(cD, { total: P, productos: [linea(pA, 1, P)] });
sql(`update public.ordenes set fecha_orden = fecha_orden - interval '3 days' where id = ${Number(d1?.idOrden)} returning id`);
await pagar(d1);
const md = await mis(cD);
ok(bonos(md, rD?.reto?.nombre) === 0 && retoDe(md, rD?.reto?.id)?.avance == 0, `fechas: pedido de hace 3 días → avance ${retoDe(md, rD?.reto?.id)?.avance}, sin bono`);

// 9. Guardas.
const gC = (await rpc('guardar_reto', { p_data: { token: carla?.token, reto: { nombre: 'x', tipo: 'frecuencia', meta: 1, bono: 1, desde: hoy, hasta: hoy, publico: 'todos' } } })).json;
const gAnon = await rpc('evaluar_retos', { p_cliente: cF.id });
const gMal = (await rpc('guardar_reto', { p_data: { token: ana?.token, reto: { nombre: 'x', tipo: 'producto', meta: 1, bono: 1, desde: hoy, hasta: hoy, publico: 'todos' } } })).json;
const gBorrar = (await rpc('borrar_reto', { p_data: { token: ana?.token, id: rF?.reto?.id } })).json;
const gBorrarX = (await rpc('borrar_reto', { p_data: { token: ana?.token, id: rX?.reto?.id } })).json;
const priv = sqlOVacio(`select has_function_privilege('anon', 'public.evaluar_retos(bigint)', 'execute') as e, has_function_privilege('anon', 'public.avance_reto(bigint,bigint)', 'execute') as a`);
ok(gC?.ok === false && gAnon.status >= 400 && gMal?.error === 'sabor_requerido' && gBorrar?.error === 'tiene_bonos' && gBorrarX?.ok === true && priv?.[0]?.e === false && priv?.[0]?.a === false,
  `guardas: Carla ${gC?.error}; anon evaluar_retos ${gAnon.status}; producto sin sabor ${gMal?.error}; borrar con bonos ${gBorrar?.error}; borrar pausado ${gBorrarX?.ok}; privilegios ${JSON.stringify(priv?.[0] ?? 'sin funciones')}`);
if (gBorrarX?.ok) creados.splice(creados.indexOf(rX?.reto?.id), 1);

// 10. retos_admin y retos_avance.
const adm = (await rpc('retos_admin', { p_data: { token: ana?.token } })).json;
const fila = (adm?.retos || []).find(r => r.id === rF?.reto?.id);
const av = (await rpc('retos_avance', { p_data: { token: ana?.token, id: rF?.reto?.id } })).json;
const cli = (av?.clientes || []).find(c => c.id === cF.id);
// El reto es para «todos»: lo cumplen también los otros clientes de esta corrida con 2 pedidos pagados.
ok(adm?.ok === true && fila?.cumplidos >= 1 && fila?.puntos_dados === fila?.cumplidos * 50 && Array.isArray(adm?.sabores) && cli?.cumplido === true && Number(cli?.avance) === 2,
  `retos_admin: cumplidos ${fila?.cumplidos}, puntos ${fila?.puntos_dados}; retos_avance: ${cli?.nombre} ${cli?.avance}/${cli?.meta} cumplido ${cli?.cumplido}`);

// 11. Archivos.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
let retosHtml = ''; try { retosHtml = readFileSync(new URL('../retos.html', import.meta.url), 'utf8'); } catch (_e) {}
const vercel = readFileSync(new URL('../vercel.json', import.meta.url), 'utf8');
ok(html.includes('id="club-retos"') && html.includes("reto: 'Reto'") && html.includes('<option value="reto">Retos</option>'), 'index.html: sección Retos, tipo reto y filtro');
ok(retosHtml.includes('function leerFilasPlantilla') && retosHtml.includes("rpc('guardar_reto'") && /"source": "\/retos"/.test(vercel), 'retos.html con leerFilasPlantilla y guardar_reto; vercel.json con /retos');

// Limpieza: pausar los retos de prueba y desactivar el cupón.
for (const id of creados.filter(Boolean)) await rpc('guardar_reto', { p_data: { token: ana?.token, reto: { id, activo: false } } });
const lista = (await rpc('obtener_cupones', { p_data: { token: ana?.token } })).json;
for (const c of (lista?.cupones || (Array.isArray(lista) ? lista : [])).filter(c => c.codigo === CUP)) await rpc('guardar_cupon', { p_data: { token: ana?.token, id: c.id, campos: { activo: false } } });
console.log(`  (pausados ${creados.filter(Boolean).length} retos de prueba)`);

console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en orden.');
process.exitCode = fallos ? 1 : 0;
