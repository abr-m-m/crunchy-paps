#!/usr/bin/env node
// tools/probar-editar-pedido.mjs — editar_pedido (20261001000000). Spec: cambios/2026-09-20-editar-pedido/diseno.md.
// Escribe en STAGING (autorizado por Abraham el 20 sep 2026). Necesita `node tools/ver-en-staging.mjs`.
// Uso: node tools/probar-editar-pedido.mjs [A|B|C|D|E|F]   (sin argumento corre todo)
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
const dir = mkdtempSync(join(tmpdir(), 'editar-'));
const sql = (q) => { const f = join(dir, 'q.sql'); writeFileSync(f, q); const out = execSync(`supabase db query --linked --project-ref ${STG} -o json --file "${f}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); const i = out.indexOf('{'); return i < 0 ? [] : (JSON.parse(out.slice(i)).rows || []); };
const uno = (q) => (sql(q)[0] || {});
const seccion = (process.argv[2] || 'ABCDEF').toUpperCase();
const corre = (s) => seccion.includes(s);

// ── Fixtures ────────────────────────────────────────────────────────────────
const sufijo = String(Date.now()).slice(-6);
const ana = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000001', pin: '1234' } })).json;   // dueña
const carla = (await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000003', pin: '1234' } })).json; // vendedora sin admin
if (!ana?.token || !carla?.token) { ok(false, 'sesiones de Ana y Carla'); process.exit(1); }

// Productos con presentación '100g'/'250g' (la fórmula de kg no entiende «Bolsa 100g», que es lo que hay en staging).
const prod = (pres, gramos, pc, pt, extra = '') => Number(uno(`insert into productos (sabor, presentacion, gramos, precio_consumidor, precio_tienda, precio_restaurante, precio_mostrador, precio_mayorista, tipo_venta, activo ${extra ? ', ' + extra.split('=')[0] : ''})
  values ('EDIT-${sufijo}', '${pres}', ${gramos}, ${pc}, ${pt}, ${pt}, ${pc}, 0, 1, true ${extra ? ', ' + extra.split('=')[1] : ''}) returning id`).id);
const P100 = prod('100g', 100, 35, 25);                                   // pieza
const P250 = prod('250g', 250, 70, 50, 'precio_caja_6=270');               // caja de 6 a $270 (6 × 50 = 300 → ahorro 30)
const P100b = Number(uno(`insert into productos (sabor, presentacion, gramos, precio_consumidor, precio_tienda, precio_restaurante, precio_mostrador, precio_mayorista, tipo_venta, activo, descuento_pct)
  values ('EDIT-${sufijo}-B', '100g', 100, 40, 30, 30, 40, 0, 1, true, 10) returning id`).id);   // 10 % → consumidor $36
const idLote = `LOTE-EDIT-${sufijo}`;
sql(`insert into lotes_produccion (id_lote, fecha, kilos_totales, kilos_vendidos, estatus) values ('${idLote}', current_date, 100, 0, 'Activo')`);
const kgLote = () => Number(uno(`select kilos_vendidos from lotes_produccion where id_lote = '${idLote}'`).kilos_vendidos);
const lineasDe = (id) => sql(`select id, sabor, presentacion, cantidad, gramos_vendidos, subtotal, descuento, kg_descontado_lote, id_lote_descontado, piezas_por_caja, puntos_canje from ordenes_detalle where id_orden = ${id} order by id`);
const cab = (id) => uno(`select id, consecutivo, subtotal, descuento, envio, descuento_envio, total, estatus_pedido, estatus_pago, armado_en, editado_en, editado_por, actualizado_por, fecha_actualizacion, cupon_codigo from ordenes where id = ${id}`);

const alta = async (nombre, tipoId = 1) => {
  const tel = '554' + String(Date.now()).slice(-7); await new Promise(r => setTimeout(r, 5));
  const a = (await rpc('registrar_o_actualizar_cliente', { p_data: { telefono: tel, nombre, tipo: tipoId === 3 ? 'Tienda' : 'Consumidor', tipoId, direccion: 'Calle 1', cp: '03400', colonia: 'Álamos', municipio: 'Benito Juárez', estado: 'CDMX', coordenadas: '' } })).json;
  if (tipoId === 3) sql(`update clientes set aprobado_b2b = true where id = ${a?.idCliente}`);
  const ses = (await rpc('emitir_sesion_prueba', { p_telefono: tel })).json;
  return { tel, token: ses?.token, id: a?.idCliente, nombre };
};
const linea = (id, pres, n, precio, caja = 0) => ({ idProducto: String(id), sabor: 'EDIT-' + sufijo, presentacion: pres, tipoVenta: 'Por Pieza', cantidad: n, gramos: 0, precio, subtotal: Math.round(precio * n * 100) / 100, ...(caja ? { caja } : {}) });
const pedidoCli = async (c, productos, total, extra = {}) => (await rpc('crear_pedido', { p_data: { tokenCliente: c.token, idCliente: c.id, nombre: c.nombre, telefono: c.tel, cp: '03400', colonia: 'Álamos', direccion: 'Calle 1', metodoEntrega: 'coordinar', tipoPagoId: 1, tipoPago: 'Efectivo', notas: '[edit] prueba', idempotencyKey: 'edit-' + c.tel + '-' + Math.random(), total, productos, ...extra } })).json;
const pedidoVend = async (quien, c, tipoCliente, productos, total, extra = {}) => (await rpc('crear_pedido', { p_data: { token: quien.token, idCliente: c.id, nombre: c.nombre, telefono: c.tel, tipoCliente, canal: tipoCliente === 'tienda' ? 'b2b' : 'web', cp: '03400', colonia: 'Álamos', direccion: 'Calle 1', metodoEntrega: 'coordinar', tipoPagoId: 1, tipoPago: 'Efectivo', notas: '[edit] prueba', idempotencyKey: 'edit-v-' + c.tel + '-' + Math.random(), total, productos, ...extra } })).json;
const estatus = (idOrden, campos, quien = ana) => rpc('actualizar_estatus_pedido', { p_data: { token: quien.token, idOrden: String(idOrden), actualizadoPor: 'probar-editar', ...campos } });
const confirmar = (p) => estatus(p?.idOrden, { estatusPedido: 'En proceso' });
const pagar = (p) => estatus(p?.idOrden, { estatusPago: 'Pagado' });
const cancelar = (p) => estatus(p?.idOrden, { estatusPedido: 'Cancelado' });
const editar = (quien, idOrden, lineas, modo = 'aplicar', extra = {}) => rpc('editar_pedido', { p_data: { token: quien.token, idOrden: String(idOrden), actualizadoPor: quien === ana ? 'Ana' : 'Carla', modo, lineas, ...extra } });
const editarCli = (c, idOrden, lineas, modo = 'aplicar') => rpc('editar_mi_pedido', { p_data: { token: c.token, idOrden: String(idOrden), modo, lineas } });
const cerca = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const creados = [];

// ── A. kg_de_linea y triggers de lote (T1) ──────────────────────────────────
if (corre('A')) {
  console.log('\nA. kg_de_linea y triggers');
  // A1. Equivalencia con lo que fn_reconciliar_pedido ya escribió: 0 diferencias.
  const dif = uno(`select count(*)::int n from ordenes_detalle where kg_descontado_lote > 0
    and abs(kg_descontado_lote - public.kg_de_linea(tipo_venta, presentacion, cantidad, gramos_vendidos)) > 0.0005`).n;
  ok(dif === 0, `A1 kg_de_linea ≡ fórmula de fn_reconciliar_pedido en las líneas descontadas (${dif} diferencias)`);
  ok(cerca(uno(`select public.kg_de_linea('Por Pieza','250g',4,0) kg`).kg, 1) && cerca(uno(`select public.kg_de_linea('A granel','Granel',0,750) kg`).kg, 0.75) && cerca(uno(`select public.kg_de_linea('Por Pieza','Bolsa 100g',3,0) kg`).kg, 0), 'A1b pieza 4×250g = 1 kg, granel 750 g = 0.75, «Bolsa 100g» = 0 (como hoy)');
  // A2. DELETE devuelve los kg al lote.
  const cA = await alta('Edit A');
  const pA = await pedidoCli(cA, [linea(P100, '100g', 2, 35), linea(P250, '250g', 2, 70)], 210); creados.push(pA?.idOrden);
  await confirmar(pA);
  const antes = kgLote(); const lA = lineasDe(pA.idOrden);
  ok(cerca(antes, 0.7) && lA.every(l => l.id_lote_descontado === idLote), `A2 confirmado: lote ${antes} kg (0.7), líneas con id_lote (${lA.map(l => l.kg_descontado_lote).join(', ')})`);
  sql(`delete from ordenes_detalle where id = ${lA[1].id}`);   // la de 250 g × 2 = 0.5 kg
  ok(cerca(kgLote(), 0.2), `A2 tras DELETE de la línea de 0.5 kg: lote ${kgLote()} kg (0.2)`);
  // A3. UPDATE de cantidad ajusta la diferencia y deja kg_descontado_lote en el valor nuevo.
  sql(`update ordenes_detalle set cantidad = 5 where id = ${lA[0].id}`);   // 2 → 5 piezas de 100 g: +0.3
  const l0 = lineasDe(pA.idOrden)[0];
  ok(cerca(kgLote(), 0.5) && cerca(l0.kg_descontado_lote, 0.5), `A3 2→5 piezas: lote ${kgLote()} kg (0.5), línea ${l0.kg_descontado_lote} (0.5)`);
  sql(`update ordenes_detalle set cantidad = 1 where id = ${lA[0].id}`);
  ok(cerca(kgLote(), 0.1), `A3 5→1: lote ${kgLote()} kg (0.1)`);
  // A4. Pendiente: sin descuento, el UPDATE no toca el lote.
  const pP = await pedidoCli(cA, [linea(P100, '100g', 2, 35)], 70); creados.push(pP?.idOrden);
  const lP = lineasDe(pP.idOrden)[0]; const kAntes = kgLote();
  sql(`update ordenes_detalle set cantidad = 9 where id = ${lP.id}`);
  ok(cerca(kgLote(), kAntes) && Number(lineasDe(pP.idOrden)[0].kg_descontado_lote) === 0, `A4 Pendiente: el UPDATE no toca el lote (${kgLote()} = ${kAntes})`);
  await confirmar(pP);
  ok(cerca(kgLote(), kAntes + 0.9), `A4 al confirmar descuenta lo nuevo: ${kgLote()} (${kAntes + 0.9})`);
  // A5. La rama «devolver» de fn_reconciliar_pedido (cancelar) no dispara el trigger de UPDATE (no toca cantidad).
  await cancelar(pP);
  ok(cerca(kgLote(), kAntes), `A5 cancelar devuelve 0.9 sin doble conteo: ${kgLote()} (${kAntes})`);
  // A6. Columnas nuevas existen.
  ok(uno(`select count(*)::int n from information_schema.columns where table_name = 'ordenes' and column_name in ('editado_en','editado_por')`).n === 2, 'A6 ordenes.editado_en / editado_por');
}

// ── Limpieza ────────────────────────────────────────────────────────────────
for (const id of creados) { try { await cancelar({ idOrden: id }); } catch (_e) {} }
sql(`update lotes_produccion set estatus = 'Cerrado', fecha_cierre = now() where id_lote = '${idLote}'`);
sql(`update productos set activo = false where sabor like 'EDIT-${sufijo}%'`);
console.log(`\n${fallos} fallo(s).`);
process.exit(fallos ? 1 : 0);
