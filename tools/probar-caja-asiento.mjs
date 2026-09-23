#!/usr/bin/env node
// tools/probar-caja-asiento.mjs — caja_generar_movimiento_al_confirmar (20261002000000).
// Bug: NEW.estatus_caja es NULL en todo pedido recien creado; `NULL <> 'confirmado'` es NULL
// (no TRUE), asi que la guarda no frenaba nada y el trigger escribia la fila venta_* AL CREARSE
// el pedido, pagado o no. Casos 1 y 2 deben dar RED antes de la migracion (la fila prematura ya
// esta ahi) y GREEN despues.
// Escribe en STAGING. Necesita `node tools/ver-en-staging.mjs`.
import { writeFileSync, mkdtempSync } from 'node:fs';
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
const dir = mkdtempSync(join(tmpdir(), 'caja-asiento-'));
const sql = (q) => { const f = join(dir, 'q.sql'); writeFileSync(f, q); const out = execSync(`supabase db query --linked --project-ref ${STG} -o json --file "${f}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); const i = out.indexOf('{'); return i < 0 ? [] : (JSON.parse(out.slice(i)).rows || []); };
const uno = (q) => (sql(q)[0] || {});

// ── Fixtures ────────────────────────────────────────────────────────────────
const sufijo = String(Date.now()).slice(-6);
const ana = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000001', pin: '1234' } })).json;   // dueña: secciones caja/pedidos
if (!ana?.token) { ok(false, 'sesión de Ana'); process.exit(1); }

const alta = async (nombre) => {
  const tel = '555' + String(Date.now()).slice(-7); await new Promise(r => setTimeout(r, 5));
  const a = (await rpc('registrar_o_actualizar_cliente', { p_data: { telefono: tel, nombre, tipo: 'Consumidor', tipoId: 1, direccion: 'Calle 1', cp: '03400', colonia: 'Álamos', municipio: 'Benito Juárez', estado: 'CDMX', coordenadas: '' } })).json;
  const ses = (await rpc('emitir_sesion_prueba', { p_telefono: tel })).json;
  return { tel, token: ses?.token, id: a?.idCliente, nombre };
};

const idProd = Number(uno(`insert into productos (sabor, presentacion, gramos, precio_consumidor, precio_tienda, precio_restaurante, precio_mostrador, precio_mayorista, tipo_venta, activo)
  values ('CAJA-${sufijo}', '100g', 100, 35, 25, 25, 35, 0, 1, true) returning id`).id);
const idLote = `LOTE-CAJA-${sufijo}`;
sql(`insert into lotes_produccion (id_lote, fecha, kilos_totales, kilos_vendidos, estatus) values ('${idLote}', current_date, 100, 0, 'Activo')`);

const linea = (n, precio = 35) => ({ idProducto: String(idProd), sabor: 'CAJA-' + sufijo, presentacion: '100g', tipoVenta: 'Por Pieza', cantidad: n, gramos: 0, precio, subtotal: Math.round(precio * n * 100) / 100 });
const pedidoCli = async (c, productos, total) => (await rpc('crear_pedido', { p_data: { tokenCliente: c.token, idCliente: c.id, nombre: c.nombre, telefono: c.tel, cp: '03400', colonia: 'Álamos', direccion: 'Calle 1', metodoEntrega: 'coordinar', tipoPagoId: 1, tipoPago: 'Efectivo', notas: '[caja] prueba', idempotencyKey: 'caja-' + c.tel + '-' + Math.random(), total, productos } })).json;
const pedidoVend = async (quien, c, tipoCliente, productos, total, extra = {}) => (await rpc('crear_pedido', { p_data: { token: quien.token, idCliente: c.id, nombre: c.nombre, telefono: c.tel, tipoCliente, canal: tipoCliente === 'tienda' ? 'b2b' : 'web', cp: '03400', colonia: 'Álamos', direccion: 'Calle 1', metodoEntrega: 'coordinar', tipoPagoId: 1, tipoPago: 'Efectivo', notas: '[caja] prueba', idempotencyKey: 'caja-v-' + c.tel + '-' + Math.random(), total, productos, ...extra } })).json;
const estatus = (idOrden, campos) => rpc('actualizar_estatus_pedido', { p_data: { token: ana.token, idOrden: String(idOrden), actualizadoPor: 'probar-caja', ...campos } });
const creados = [];

// ── Caja del día: usar la abierta de hoy en punto_venta, o abrirla ──────────
const idPuntoVenta = Number(uno(`select id from caja_puntos where codigo = 'punto_venta' limit 1`).id || 0);
if (!idPuntoVenta) { ok(false, 'falta caja_puntos.codigo = punto_venta en staging (fixture esperada)'); process.exit(1); }
let idCajaHoy = uno(`select id from caja_dias where id_punto = ${idPuntoVenta} and fecha = current_date and estatus = 'abierta'`).id;
let cajaAbiertaPorNosotros = false;
if (!idCajaHoy) {
  const rAbrir = await rpc('abrir_caja_dia', { p_data: { token: ana.token, idPunto: idPuntoVenta, actor: 'probar-caja' } });
  idCajaHoy = rAbrir?.json?.idCajaDia;
  cajaAbiertaPorNosotros = true;
}
idCajaHoy = Number(idCajaHoy);
ok(idCajaHoy > 0, `Fixture: caja del día ${idCajaHoy} abierta en punto_venta (${cajaAbiertaPorNosotros ? 'la abrimos' : 'ya estaba abierta'})`);

// ── Caso 1: pedido creado sin pagar no debe escribir venta_* ────────────────
console.log('\nCaso 1: pedido creado sin pagar no escribe venta_*');
const cUno = await alta('Caja Uno');
const p1 = await pedidoCli(cUno, [linea(2)], 70);
ok(p1?.ok === true, `C1 pedido creado (${p1?.consecutivo}, ${p1?.error})`);
creados.push(p1?.idOrden);
const n1 = Number(uno(`select count(*)::int n from caja_movimientos where id_orden = ${p1.idOrden}`).n);
ok(n1 === 0, `C1 sin pagar: 0 filas venta_* en caja_movimientos (${n1})`);

// ── Caso 2: pagarlo después escribe UNA fila, con la fecha de hoy ──────────
console.log('\nCaso 2: pagarlo después escribe exactamente una fila, con la fecha de hoy');
const cDos = await alta('Caja Dos');
// Pedido de consumidor puesto por un vendedor (id_vendedor queda NO NULO): al pagar en efectivo,
// caja_movimiento_por_pedido lo manda a 'pendiente_entrega' (no 'confirmado' directo, eso es solo
// para mostrador o venta sin vendedor) — así se ejercita confirmar_caja_pedido, como hace la app.
const p2 = await pedidoVend(ana, cDos, 'consumidor', [linea(3)], 105);
ok(p2?.ok === true, `C2 pedido creado (${p2?.consecutivo})`);
creados.push(p2?.idOrden);
const n2a = Number(uno(`select count(*)::int n from caja_movimientos where id_orden = ${p2.idOrden}`).n);
ok(n2a === 0, `C2a recién creado (sin pagar): 0 filas (${n2a})`);

const actorConfirma = 'probar-caja-confirma-' + sufijo;
const rPago = await rpc('actualizar_estatus_pedido', { p_data: { token: ana.token, idOrden: String(p2.idOrden), actualizadoPor: actorConfirma, estatusPago: 'Pagado' } });
ok(rPago?.json?.ok === true, `C2 actualizar_estatus_pedido a Pagado (${JSON.stringify(rPago.json)})`);
let estCaja2 = uno(`select estatus_caja from ordenes where id = ${p2.idOrden}`).estatus_caja;
if (estCaja2 !== 'confirmado') {
  // Nota: actualizar_estatus_pedido nunca menciona estatus_caja en su propio UPDATE — lo cambia
  // el trigger BEFORE como efecto lateral, así que «UPDATE OF estatus_caja» no dispara aquí (Postgres
  // decide por la lista de columnas del UPDATE emitido, no por si el valor cambió). Confirmar en caja
  // es un paso aparte, con su propio UPDATE que sí menciona la columna — como hace la app.
  const rConf = await rpc('confirmar_caja_pedido', { p_data: { token: ana.token, idOrden: String(p2.idOrden), actor: actorConfirma } });
  ok(rConf?.json?.ok === true, `C2 confirmar_caja_pedido (venía en '${estCaja2}') (${JSON.stringify(rConf.json)})`);
  estCaja2 = uno(`select estatus_caja from ordenes where id = ${p2.idOrden}`).estatus_caja;
}
ok(estCaja2 === 'confirmado', `C2 estatus_caja terminó en 'confirmado' (${estCaja2})`);

const filas2 = sql(`select tipo, monto, fecha::date::text as fecha_dia, id_caja_dia, actor from caja_movimientos where id_orden = ${p2.idOrden}`);
ok(filas2.length === 1, `C2 exactamente 1 fila tras pagar (${filas2.length})`);
const f2 = filas2[0] || {};
ok(f2.tipo === 'venta_efectivo', `C2 tipo = venta_efectivo (${f2.tipo})`);
ok(Number(f2.monto) === 105, `C2 monto = total del pedido (${f2.monto} = 105)`);
const hoy = uno(`select current_date::text as hoy`).hoy;
ok(f2.fecha_dia === hoy, `C2 fecha::date = hoy (${f2.fecha_dia} = ${hoy})`);
ok(Number(f2.id_caja_dia) === idCajaHoy, `C2 id_caja_dia apunta al día abierto (${f2.id_caja_dia} = ${idCajaHoy})`);
ok(f2.actor === actorConfirma, `C2 actor es quien confirmó, no 'sistema' de una fila prematura (${f2.actor})`);

// ── Caso 3: mostrador pagado en la creación sigue escribiendo su fila en el mismo INSERT ──
console.log('\nCaso 3: pedido de mostrador (nace Pagado) escribe su fila en el mismo INSERT');
const cTres = await alta('Caja Mostrador');
const p3 = await pedidoVend(ana, cTres, 'mostrador', [linea(4)], 140, { canal: 'mostrador' });
ok(p3?.ok === true, `C3 pedido de mostrador creado (${p3?.consecutivo}, ${p3?.error})`);
creados.push(p3?.idOrden);
const cab3 = uno(`select estatus_pedido, estatus_pago, estatus_caja from ordenes where id = ${p3.idOrden}`);
ok(cab3.estatus_pago === 'Pagado' && cab3.estatus_caja === 'confirmado', `C3 nace Pagado y confirmado (${cab3.estatus_pago}, ${cab3.estatus_caja})`);
const filas3 = sql(`select tipo, monto from caja_movimientos where id_orden = ${p3.idOrden}`);
ok(filas3.length === 1, `C3 exactamente 1 fila en el mismo INSERT (${filas3.length})`);
ok(filas3[0]?.tipo === 'venta_efectivo' && Number(filas3[0]?.monto) === 140, `C3 tipo/monto correctos (${filas3[0]?.tipo}, ${filas3[0]?.monto})`);

// ── Caso 4: idempotencia — reconfirmar no duplica ───────────────────────────
console.log('\nCaso 4: reconfirmar no duplica (idempotencia)');
sql(`update ordenes set estatus_caja = 'confirmado' where id = ${p3.idOrden}`);   // fuerza que el trigger vuelva a disparar
const n4a = Number(uno(`select count(*)::int n from caja_movimientos where id_orden = ${p3.idOrden}`).n);
ok(n4a === 1, `C4a reconfirmar el pedido de mostrador no agrega una segunda fila (${n4a})`);

sql(`update ordenes set estatus_caja = 'confirmado' where id = ${p2.idOrden}`);
const n4b = Number(uno(`select count(*)::int n from caja_movimientos where id_orden = ${p2.idOrden}`).n);
ok(n4b === 1, `C4b pagar y luego reconfirmar tampoco duplica (${n4b})`);

// ── Caso 5: pedido interno y pedido en $0 no escriben nada ──────────────────
console.log('\nCaso 5: pedido interno y pedido en $0 no escriben nada');
const cCinco = await alta('Caja Interno');
const p5 = await pedidoVend(ana, cCinco, 'consumidor', [linea(2)], 0, { tipoInterno: 'sampling' });
ok(p5?.ok === true, `C5a pedido interno creado (${p5?.consecutivo}, ${p5?.error})`);
creados.push(p5?.idOrden);
const n5a = Number(uno(`select count(*)::int n from caja_movimientos where id_orden = ${p5.idOrden}`).n);
ok(n5a === 0, `C5a interno: 0 filas (${n5a})`);

const consecZero = 'CAJA-TEST-0-' + sufijo;
const cero = uno(`insert into ordenes (consecutivo, total, estatus_caja) values ('${consecZero}', 0, 'confirmado') returning id`);
creados.push(cero.id);
const n5b = Number(uno(`select count(*)::int n from caja_movimientos where id_orden = ${cero.id}`).n);
ok(n5b === 0, `C5b total 0: 0 filas (${n5b})`);

// ── Limpieza ────────────────────────────────────────────────────────────────
for (const id of creados) { if (!id) continue; try { await estatus(id, { estatusPedido: 'Cancelado' }); } catch (_e) {} }
sql(`update lotes_produccion set estatus = 'Cerrado', fecha_cierre = now() where id_lote = '${idLote}'`);
sql(`update productos set activo = false where sabor = 'CAJA-${sufijo}'`);
console.log(`\n${fallos} fallo(s).`);
process.exit(fallos ? 1 : 0);
