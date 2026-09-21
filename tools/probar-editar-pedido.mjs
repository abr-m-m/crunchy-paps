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
const lineasDe = (id) => sql(`select id, id_producto, sabor, presentacion, cantidad, gramos_vendidos, subtotal, descuento, kg_descontado_lote, id_lote_descontado, piezas_por_caja, puntos_canje from ordenes_detalle where id_orden = ${id} order by id`);
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

// ── B. cotizar_linea ≡ crear_pedido (T2) ────────────────────────────────────
if (corre('B')) {
  console.log('\nB. cotizar_linea');
  const cB = await alta('Edit B'); const tB = await alta('Edit B tienda', 3);
  // Consumidor: pieza normal, pieza con descuento_pct.
  const pB = await pedidoCli(cB, [linea(P100, '100g', 3, 35), linea(P100b, '100g', 2, 36)], 177); creados.push(pB?.idOrden);
  // Tienda por Ana: caja de 6 con precio propio, y pieza suelta.
  const pT = await pedidoVend(ana, tB, 'tienda', [linea(P250, '250g', 12, 45, 6), linea(P100, '100g', 4, 25)], 640); creados.push(pT?.idOrden);
  ok(pB?.ok === true && pT?.ok === true, `B0 pedidos creados por crear_pedido (${pB?.consecutivo}, ${pT?.consecutivo})`);
  // Nota (adaptación mínima): `linea()` manda siempre `sabor: 'EDIT-' + sufijo` sin importar qué
  // producto es (P100 y P100b comparten esa etiqueta), así que resolver el producto por
  // `sabor` + `presentacion` es ambiguo cuando dos productos distintos comparten presentación
  // en el mismo pedido (caso pB: P100 y P100b, ambos '100g'). Se usa `id_producto` — que sí
  // guarda `ordenes_detalle` por línea — y un set de líneas ya emparejadas para no reusar la misma.
  const compara = (idOrden, nivel, casos) => {
    const ls = lineasDe(idOrden);
    const usados = new Set();
    for (const [pres, caja, esperadoDescr] of casos) {
      const l = ls.find(x => !usados.has(x.id) && x.presentacion === pres && Number(x.piezas_por_caja || 0) === caja);
      if (l) usados.add(l.id);
      const c = uno(`select public.cotizar_linea(${l ? l.id_producto : 0}, '${nivel}', ${l?.cantidad || 0}, ${caja}) c`).c;
      const igual = l && c?.ok === true && cerca(c.subtotal, l.subtotal) && cerca(c.descuento, l.descuento) && (Number(c.piezasPorCaja || 0) === caja);
      ok(igual, `B1 ${nivel} ${esperadoDescr}: cotizar ${c?.subtotal}/${c?.descuento} = línea ${l?.subtotal}/${l?.descuento}`);
    }
  };
  compara(pB.idOrden, 'consumidor', [['100g', 0, 'pieza 3 × $35'], ['100g', 0, 'pieza con 10 % (2 × $36)']]);
  compara(pT.idOrden, 'tienda', [['250g', 6, 'caja de 6 (2 cajas × $270)'], ['100g', 0, 'pieza suelta 4 × $25']]);
  const cInv = uno(`select public.cotizar_linea(${P100}, 'consumidor', 0, 0) c`).c;
  const cIna = uno(`select public.cotizar_linea(999999999, 'consumidor', 1, 0) c`).c;
  ok(cInv?.error === 'cantidad_invalida' && cIna?.error === 'producto_no_disponible', `B2 rechazos: ${cInv?.error}, ${cIna?.error}`);
  const cCons = uno(`select public.cotizar_linea(${P250}, 'consumidor', 12, 6) c`).c;
  ok(cCons?.ok && cerca(cCons.subtotal, 12 * 70) && cCons.piezasPorCaja == null, `B3 consumidor con caja:6 paga por pieza (${cCons?.subtotal} = 840) y sin piezasPorCaja`);
}

// ── C. editar_pedido: cotizar, aplicar, rechazos (T3) ───────────────────────
if (corre('C')) {
  console.log('\nC. editar_pedido');
  const cC = await alta('Edit C'); const tC = await alta('Edit C tienda', 3);
  // C1. Quitar una línea de un pedido En proceso: kg, líneas, cabecera, rastro.
  const p1 = await pedidoCli(cC, [linea(P100, '100g', 2, 35), linea(P250, '250g', 2, 70)], 210); creados.push(p1?.idOrden);
  await confirmar(p1); const k0 = kgLote(); const l1 = lineasDe(p1.idOrden);
  const r1 = (await editar(ana, p1.idOrden, [{ id: l1[0]?.id }])).json;
  const c1 = cab(p1.idOrden);
  ok(r1?.ok === true && lineasDe(p1.idOrden).length === 1 && cerca(kgLote(), k0 - 0.5) && cerca(c1.subtotal, 70) && cerca(c1.total, 70) && c1.editado_por === 'Ana' && c1.editado_en && c1.actualizado_por === 'Ana',
     `C1 quitar 250g×2: líneas 1, lote −0.5 (${kgLote()} vs ${k0}), total ${c1.total} (70), editado_por ${c1.editado_por}`);
  ok(cerca(r1?.pedido?.total, 70) && Array.isArray(r1?.lineas) && r1.lineas.length === 1, `C1 la respuesta trae pedido.total ${r1?.pedido?.total} y ${r1?.lineas?.length} línea`);
  // C2. Bajar y subir cantidad: diferencia de kg en el mismo lote; subtotal proporcional al precio pactado.
  const r2 = (await editar(ana, p1.idOrden, [{ id: l1[0]?.id, cantidad: 5 }])).json; const l2 = lineasDe(p1.idOrden)[0] || {};
  ok(r2?.ok && Number(l2.cantidad) === 5 && cerca(l2.subtotal, 175) && cerca(l2.kg_descontado_lote, 0.5) && l2.id_lote_descontado === idLote && cerca(kgLote(), k0 - 0.5 + 0.3),
     `C2 2→5 piezas: subtotal ${l2.subtotal} (175), kg ${l2.kg_descontado_lote} (0.5), lote ${kgLote()}`);
  const r2b = (await editar(ana, p1.idOrden, [{ id: l1[0]?.id, cantidad: 1 }])).json;
  ok(r2b?.ok && cerca(cab(p1.idOrden).total, 35) && cerca(kgLote(), k0 - 0.5 - 0.1), `C2 5→1: total ${cab(p1.idOrden).total} (35), lote ${kgLote()}`);
  // C3. Línea de caja: 2 → 3 cajas.
  const pT = await pedidoVend(ana, tC, 'tienda', [linea(P250, '250g', 12, 45, 6)], 540); creados.push(pT?.idOrden);
  await confirmar(pT); const lT = lineasDe(pT.idOrden)[0] || {};
  const r3 = (await editar(ana, pT.idOrden, [{ id: lT?.id, cajas: 3 }])).json; const lT2 = lineasDe(pT.idOrden)[0] || {};
  ok(r3?.ok && Number(lT2.cantidad) === 18 && Number(lT2.piezas_por_caja) === 6 && cerca(lT2.subtotal, 810) && cerca(lT2.descuento, 90) && cerca(lT2.kg_descontado_lote, 4.5),
     `C3 caja 2→3: cantidad ${lT2.cantidad} (18), subtotal ${lT2.subtotal} (810), descuento ${lT2.descuento} (90), kg ${lT2.kg_descontado_lote} (4.5)`);
  // C4. Agregar línea: precio del canal de hoy, kg por el trigger de INSERT.
  const k4 = kgLote();
  const r4 = (await editar(ana, pT.idOrden, [{ id: lT?.id, cajas: 3 }, { idProducto: String(P100), cantidad: 4 }])).json;
  const l4 = lineasDe(pT.idOrden).find(l => String(l.id_producto) === String(P100));
  ok(r4?.ok && l4 && cerca(l4.subtotal, 100) && cerca(l4.kg_descontado_lote, 0.4) && l4.id_lote_descontado === idLote && cerca(kgLote(), k4 + 0.4) && cerca(cab(pT.idOrden).total, 910),
     `C4 agregar 4 × 100g a tienda: subtotal ${l4?.subtotal} (100 = 4 × $25), kg ${l4?.kg_descontado_lote}, total ${cab(pT.idOrden).total} (910)`);
  const r4b = (await editar(ana, pT.idOrden, [{ id: lT?.id, cajas: 3 }, { id: l4?.id }, { idProducto: String(P250), cajas: 1, caja: 6 }])).json;
  const l4b = lineasDe(pT.idOrden).filter(l => l.presentacion === '250g');
  ok(r4b?.ok && l4b.length === 2 && l4b.some(l => Number(l.cantidad) === 6 && cerca(l.subtotal, 270) && Number(l.piezas_por_caja) === 6), `C4b agregar 1 caja de 6: nueva línea 6 pz $270`);
  // C5. Pendiente: líneas cambian, lote no; al confirmar descuenta lo nuevo.
  const p5 = await pedidoCli(cC, [linea(P100, '100g', 2, 35)], 70); creados.push(p5?.idOrden); const k5 = kgLote();
  const r5 = (await editar(ana, p5.idOrden, [{ id: lineasDe(p5.idOrden)[0]?.id, cantidad: 6 }])).json;
  ok(r5?.ok && cerca(kgLote(), k5) && cerca(cab(p5.idOrden).total, 210), `C5 Pendiente editado: lote igual (${kgLote()}), total 210`);
  await confirmar(p5);
  ok(cerca(kgLote(), k5 + 0.6), `C5 confirmar descuenta 0.6: ${kgLote()}`);
  // C6. Cupón %: recalculado sobre el subtotal nuevo.
  const cod = 'EDIT' + sufijo;
  sql(`insert into cupones (codigo, descripcion, tipo, valor, vigencia_inicio, vigencia_fin, usos_maximos, usos_actuales, compra_minima, activo, un_uso_por_usuario) values ('${cod}', 'prueba', 'descuento_pct', 10, now() - interval '1 day', now() + interval '7 day', 0, 0, 100, true, true)`);
  const p6 = await pedidoCli(cC, [linea(P100, '100g', 4, 35)], 126, { cuponCodigo: cod }); creados.push(p6?.idOrden);
  ok(p6?.ok && cerca(cab(p6.idOrden).descuento, 14), `C6 pedido con cupón 10 %: descuento ${cab(p6?.idOrden).descuento} (14)`);
  const r6 = (await editar(ana, p6.idOrden, [{ id: lineasDe(p6.idOrden)[0]?.id, cantidad: 6 }])).json; const c6 = cab(p6.idOrden);
  ok(r6?.ok && cerca(c6.subtotal, 210) && cerca(c6.descuento, 21) && cerca(c6.total, 189), `C6 6 piezas: sub ${c6.subtotal}, desc ${c6.descuento} (21), total ${c6.total} (189)`);
  // C7. Cupón con mínimo que deja de cumplirse: descuento 0, aviso, cupones_uso intacto.
  const usos0 = uno(`select count(*)::int n from cupones_uso where id_orden = '${p6.idOrden}'`).n;
  const r7 = (await editar(ana, p6.idOrden, [{ id: lineasDe(p6.idOrden)[0]?.id, cantidad: 2 }])).json; const c7 = cab(p6.idOrden);
  ok(r7?.ok && cerca(c7.descuento, 0) && cerca(c7.total, 70) && (r7.avisos || []).includes('cupon_retirado') && uno(`select count(*)::int n from cupones_uso where id_orden = '${p6.idOrden}'`).n === usos0,
     `C7 bajo el mínimo: descuento ${c7.descuento} (0), aviso ${JSON.stringify(r7?.avisos)}, cupones_uso intacto`);
  // C8. Canje intacto / tocado / omitido.
  const pc = (await rpc('canje_catalogo', {})).json?.productos?.[0];
  if (pc) {
    sql(`insert into lealtad_movimientos (id_cliente, tipo, puntos, nota, actor) values (${cC.id}, 'ajuste', 5000, '[edit] saldo de prueba', 'probar-editar')`);
    const p8 = await pedidoCli(cC, [linea(P100, '100g', 2, 35), { idProducto: String(pc.id), sabor: pc.sabor, presentacion: pc.presentacion, tipoVenta: 'Por Pieza', cantidad: 1, gramos: 0, precio: 0, subtotal: 0, canje: true }], 70, { puntosCanje: pc.puntos }); creados.push(p8?.idOrden);
    const l8 = lineasDe(p8?.idOrden || 0); const canje = l8.find(l => Number(l.puntos_canje) > 0) || {}; const compra = l8.find(l => Number(l.puntos_canje) === 0) || {};
    ok(p8?.ok && canje?.id && compra?.id, `C8 pedido con canje creado (${p8?.consecutivo})`);
    const r8a = (await editar(ana, p8.idOrden, [{ id: compra?.id, cantidad: 3 }, { id: canje?.id }])).json;
    const r8b = (await editar(ana, p8.idOrden, [{ id: compra?.id }, { id: canje?.id, cantidad: 2 }])).json;
    const r8c = (await editar(ana, p8.idOrden, [{ id: compra?.id }])).json;
    ok(r8a?.ok === true && r8b?.error === 'canje_bloqueado' && r8c?.error === 'canje_bloqueado' && lineasDe(p8.idOrden).length === 2, `C8 canje intacto ok; tocado → ${r8b?.error}; omitido → ${r8c?.error}`);
    const r8d = (await editar(ana, p8.idOrden, [{ id: canje?.id }])).json;
    ok(r8d?.error === 'pedido_vacio', `C8 quitar la única línea comprada con canje → ${r8d?.error}`);
  } else ok(false, 'C8 no hay producto canjeable en staging');
  // C9. Dejar el pedido sin líneas.
  const r9 = (await editar(ana, p5.idOrden, [])).json;
  ok(r9?.error === 'pedido_vacio' && lineasDe(p5.idOrden).length === 1, `C9 sin líneas → ${r9?.error}, nada cambió`);
  // C10. Rechazos por estado.
  const pE = await pedidoCli(cC, [linea(P100, '100g', 1, 35)], 35); creados.push(pE?.idOrden); await confirmar(pE); await estatus(pE.idOrden, { estatusPedido: 'Entregado' });
  const rE = (await editar(ana, pE.idOrden, [{ id: lineasDe(pE.idOrden)[0]?.id, cantidad: 2 }])).json;
  const pX = await pedidoCli(cC, [linea(P100, '100g', 1, 35)], 35); creados.push(pX?.idOrden); await cancelar(pX);
  const rX = (await editar(ana, pX.idOrden, [{ id: lineasDe(pX.idOrden)[0]?.id, cantidad: 2 }])).json;
  const pS = await pedidoCli(cC, [linea(P100, '100g', 1, 35)], 35); creados.push(pS?.idOrden);
  sql(`update ordenes set estado_pago = 'pagado', stripe_payment_intent = 'pi_edit_${sufijo}' where id = ${pS.idOrden}`);
  const rS = (await editar(ana, pS.idOrden, [{ id: lineasDe(pS.idOrden)[0]?.id, cantidad: 2 }])).json;
  const pSp = await pedidoCli(cC, [linea(P100, '100g', 1, 35)], 35); creados.push(pSp?.idOrden);
  sql(`update ordenes set estado_pago = 'pendiente', stripe_session_id = 'cs_edit_${sufijo}' where id = ${pSp.idOrden}`);
  const rSp = (await editar(ana, pSp.idOrden, [{ id: lineasDe(pSp.idOrden)[0]?.id, cantidad: 2 }])).json;
  ok(rE?.error === 'no_editable' && rE?.motivo === 'entregado' && rX?.motivo === 'cancelado' && rS?.motivo === 'pagado_en_linea' && rSp?.motivo === 'pago_en_linea_pendiente',
     `C10 entregado ${rE?.motivo}, cancelado ${rX?.motivo}, stripe ${rS?.motivo}, stripe pendiente ${rSp?.motivo}`);
  // C11. Vendedor ajeno vs dueño.
  const rAj = (await editar(carla, p5.idOrden, [{ id: lineasDe(p5.idOrden)[0]?.id, cantidad: 7 }])).json;
  ok(rAj?.error === 'no_editable' && rAj?.motivo === 'no_es_tu_pedido' && Number(lineasDe(p5.idOrden)[0]?.cantidad) === 6, `C11 Carla en pedido ajeno → ${rAj?.motivo}; cantidad sigue 6`);
  // C12. Cliente: suyo y Pendiente/En proceso sin armar → sí; armado → no; en camino → no; ajeno → no_encontrado.
  const rC1 = (await editarCli(cC, p5.idOrden, [{ id: lineasDe(p5.idOrden)[0]?.id, cantidad: 4 }])).json;
  ok(rC1?.ok === true && Number(lineasDe(p5.idOrden)[0]?.cantidad) === 4 && cab(p5.idOrden).editado_por === 'cliente', `C12 cliente edita el suyo: cantidad 4, editado_por ${cab(p5.idOrden).editado_por}`);
  sql(`update ordenes set armado_en = now(), armado_por = 'probar' where id = ${p5.idOrden}`);
  const rC2 = (await editarCli(cC, p5.idOrden, [{ id: lineasDe(p5.idOrden)[0]?.id, cantidad: 5 }])).json;
  sql(`update ordenes set armado_en = null, armado_por = null, estatus_pedido = 'En camino' where id = ${p5.idOrden}`);
  const rC3 = (await editarCli(cC, p5.idOrden, [{ id: lineasDe(p5.idOrden)[0]?.id, cantidad: 5 }])).json;
  sql(`update ordenes set estatus_pedido = 'En proceso' where id = ${p5.idOrden}`);
  const otro = await alta('Edit C otro');
  const rC4 = (await editarCli(otro, p5.idOrden, [{ id: lineasDe(p5.idOrden)[0]?.id, cantidad: 5 }])).json;
  ok(rC2?.motivo === 'ya_armado' && rC3?.motivo === 'en_camino' && rC4?.error === 'no_encontrado' && Number(lineasDe(p5.idOrden)[0]?.cantidad) === 4,
     `C12 armado ${rC2?.motivo}, en camino ${rC3?.motivo}, ajeno ${rC4?.error}; cantidad sigue 4`);
  // C13. modo cotizar no escribe.
  const antes13 = JSON.stringify([cab(p5.idOrden).fecha_actualizacion, lineasDe(p5.idOrden), kgLote()]);
  const r13 = (await editar(ana, p5.idOrden, [{ id: lineasDe(p5.idOrden)[0]?.id, cantidad: 9 }], 'cotizar')).json;
  ok(r13?.ok && cerca(r13?.cotizacion?.total, 315) && cerca(r13?.cotizacion?.total_anterior, 140) && JSON.stringify([cab(p5.idOrden).fecha_actualizacion, lineasDe(p5.idOrden), kgLote()]) === antes13,
     `C13 cotizar: total ${r13?.cotizacion?.total} (315) desde ${r13?.cotizacion?.total_anterior} (140); nada cambió`);
  // C14. Cuatro ediciones concurrentes sobre la MISMA línea, con cantidades absolutas distintas
  // (2, 3, 5, 7): con el candado (`for update` sobre `ordenes`) se serializan, así que las cuatro
  // deben responder ok y la cabecera/el lote deben cuadrar con lo que quedó escrito — no basta con
  // "+1 concurrente" (dos clientes que leen 4 y mandan 5 acaban en 5 con o sin candado).
  const idLinea14 = lineasDe(p5.idOrden)[0]?.id;
  const cuatro = await Promise.all([2, 3, 5, 7].map(n => editar(ana, p5.idOrden, [{ id: idLinea14, cantidad: n }])));
  const l14 = lineasDe(p5.idOrden);
  const c14 = cab(p5.idOrden);
  const sumaLineas14 = l14.filter(l => !(Number(l.puntos_canje) > 0)).reduce((s, l) => s + Number(l.subtotal || 0), 0);
  const totalFormula14 = Math.max(0, Number(c14.subtotal || 0) - Number(c14.descuento || 0) + Number(c14.envio || 0) - Number(c14.descuento_envio || 0));
  const sumaLote14 = Number(uno(`select coalesce(sum(kg_descontado_lote),0) s from ordenes_detalle d join ordenes o on o.id = d.id_orden where d.id_lote_descontado = '${idLote}' and o.estatus_pedido not in ('Pendiente','Cancelado')`).s);
  ok(cuatro.every(r => r.json?.ok === true) && l14.length === 1 && [2, 3, 5, 7].includes(Number(l14[0]?.cantidad)) && cerca(Number(c14.subtotal), sumaLineas14) && cerca(Number(c14.total), totalFormula14) && cerca(kgLote(), sumaLote14),
     `C14 4 concurrentes (2,3,5,7) todas ok; cantidad final ${l14[0]?.cantidad}; subtotal cabecera ${c14.subtotal} = Σ líneas ${sumaLineas14}; total ${c14.total} (fórmula ${totalFormula14}); lote ${kgLote()} = Σ kg (${sumaLote14})`);
  // C14b. Guardarraíl de forma (no de comportamiento): si el `for update` desaparece de
  // editar_pedido_interno por accidente, esto lo detecta aunque C14 arriba no pueda distinguirlo
  // (el valor final de una cantidad absoluta es el mismo con o sin candado).
  const defC14 = uno(`select pg_get_functiondef('public.editar_pedido_interno'::regproc) d`).d;
  ok(typeof defC14 === 'string' && /for update/i.test(defC14), 'C14b editar_pedido_interno conserva "for update" (chequeo de forma)');
  // C15. Interno: se edita, total 0.
  const pI = await pedidoVend(ana, cC, 'consumidor', [linea(P100, '100g', 2, 35)], 0, { tipoInterno: 'sampling' }); creados.push(pI?.idOrden);
  const rI = (await editar(ana, pI.idOrden, [{ id: lineasDe(pI.idOrden)[0]?.id, cantidad: 5 }])).json; const cI = cab(pI.idOrden);
  ok(rI?.ok && Number(lineasDe(pI.idOrden)[0]?.cantidad) === 5 && Number(cI.total) === 0 && Number(cI.subtotal) === 0, `C15 interno: cantidad 5, total ${cI.total} (0)`);
  // C15b. La excepción de C15 es SOLO para la puerta del vendedor: el cliente dueño de ese mismo
  // pedido interno (nace Entregado) no puede editarlo — si pudiera, movería kg reales para siempre.
  const rI2 = (await editarCli(cC, pI.idOrden, [{ id: lineasDe(pI.idOrden)[0]?.id, cantidad: 6 }])).json;
  ok(rI2?.error === 'no_editable' && rI2?.motivo === 'entregado' && Number(lineasDe(pI.idOrden)[0]?.cantidad) === 5,
     `C15b cliente no puede editar el interno (nace Entregado) → ${rI2?.error}/${rI2?.motivo}; cantidad sigue 5`);
  // C16. Rechazos de forma.
  const rF1 = (await editar(ana, p5.idOrden, [{ id: 999999999 }])).json;
  const rF2 = (await editar(ana, p5.idOrden, [{ id: l14[0]?.id, cantidad: 0 }])).json;
  const rF3 = (await editar(ana, p5.idOrden, [{ id: l14[0]?.id }, { idProducto: '999999999', cantidad: 1 }])).json;
  const rF4 = (await rpc('editar_pedido', { p_data: { idOrden: String(p5.idOrden), modo: 'aplicar', lineas: [] } })).json;
  ok(rF1?.error === 'linea_ajena' && rF2?.error === 'cantidad_invalida' && rF3?.error === 'producto_no_disponible' && rF4?.error === 'no_autorizado', `C16 ${rF1?.error}, ${rF2?.error}, ${rF3?.error}, sin token ${rF4?.error}`);
  // C16b. Topes de cantidad por línea: cantidad ≤ 1000 piezas, cajas ≤ 100, gramos ≤ 50000.
  const pCap = await pedidoCli(cC, [linea(P100, '100g', 1, 35)], 35); creados.push(pCap?.idOrden); await confirmar(pCap);
  const lCap = lineasDe(pCap.idOrden)[0] || {};
  const rCap1 = (await editar(ana, pCap.idOrden, [{ id: lCap?.id, cantidad: 1001 }])).json;
  ok(rCap1?.error === 'cantidad_invalida' && Number(lineasDe(pCap.idOrden)[0]?.cantidad) === 1, `C16b cantidad 1001 → ${rCap1?.error}, sigue 1`);
  const pCapCaja = await pedidoVend(ana, tC, 'tienda', [linea(P250, '250g', 12, 45, 6)], 540); creados.push(pCapCaja?.idOrden); await confirmar(pCapCaja);
  const lCapCaja = lineasDe(pCapCaja.idOrden)[0] || {};
  const rCap2 = (await editar(ana, pCapCaja.idOrden, [{ id: lCapCaja?.id, cajas: 101 }])).json;
  ok(rCap2?.error === 'cantidad_invalida' && Number(lineasDe(pCapCaja.idOrden)[0]?.cantidad) === 12, `C16b cajas 101 → ${rCap2?.error}, sigue 12 piezas (2 cajas)`);
  const pCapGranel = await pedidoCli(cC, [linea(P100, '100g', 1, 35)], 35); creados.push(pCapGranel?.idOrden); await confirmar(pCapGranel);
  const lCapGranel = lineasDe(pCapGranel.idOrden)[0] || {};
  sql(`update ordenes_detalle set tipo_venta = 'A granel', presentacion = 'Granel', gramos_vendidos = 500, cantidad = 1 where id = ${lCapGranel?.id}`);
  const rCap3 = (await editar(ana, pCapGranel.idOrden, [{ id: lCapGranel?.id, gramos: 50001 }])).json;
  ok(rCap3?.error === 'cantidad_invalida' && Number(lineasDe(pCapGranel.idOrden)[0]?.gramos_vendidos) === 500, `C16b gramos 50001 → ${rCap3?.error}, sigue 500`);
  // C16b bonus: el mismo tope de cantidad aplica también a una línea NUEVA (no solo a una que cambia).
  const rCap4 = (await editar(ana, pCap.idOrden, [{ id: lCap?.id }, { idProducto: String(P100), cantidad: 1001 }])).json;
  ok(rCap4?.error === 'cantidad_invalida', `C16b línea nueva con cantidad 1001 → ${rCap4?.error}`);
  // C16c. Granel no soportado como línea nueva (cotizar_linea lo rechaza antes de cotizar).
  const idGranel = Number(uno(`insert into productos (sabor, presentacion, gramos, precio_consumidor, precio_tienda, precio_restaurante, precio_mostrador, precio_mayorista, tipo_venta, precio_granel_kg, activo)
    values ('EDIT-${sufijo}-G', 'Granel', 0, 0, 0, 0, 0, 0, 2, 220, true) returning id`).id);
  const rGranel = (await editar(ana, pCap.idOrden, [{ id: lCap?.id }, { idProducto: String(idGranel), cantidad: 1 }])).json;
  ok(rGranel?.error === 'granel_no_soportado', `C16c producto Granel como línea nueva → ${rGranel?.error}`);
  // C17. Sin lote activo, agregar a un pedido confirmado se revierte entero.
  sql(`update lotes_produccion set estatus = 'Cerrado' where id_lote = '${idLote}'`);
  const antes17 = JSON.stringify([lineasDe(p5.idOrden), cab(p5.idOrden).total]);
  const r17 = (await editar(ana, p5.idOrden, [{ id: l14[0]?.id, cantidad: 8 }, { idProducto: String(P250), cantidad: 1 }])).json;
  sql(`update lotes_produccion set estatus = 'Activo' where id_lote = '${idLote}'`);
  ok(r17?.error === 'sin_lote' && JSON.stringify([lineasDe(p5.idOrden), cab(p5.idOrden).total]) === antes17, `C17 sin lote: ${r17?.error}, y la cantidad 8 tampoco se aplicó`);
}

// ── D. compensaciones, desarmado, cola (T4) ─────────────────────────────────
if (corre('D')) {
  console.log('\nD. caja, puntos, armado');
  // Fixtures de caja: punto 'punto_venta' (staging no lo tiene) y caja del día abierta.
  // Nota: caja_puntos.tipo es NOT NULL sin default (staging: CENTRAL/MOSTRAD 'fijo', RUTA01 'movil');
  // se inserta con tipo='fijo'.
  let idPunto = Number(uno(`select id from caja_puntos where codigo = 'punto_venta'`).id || 0);
  if (!idPunto) idPunto = Number(uno(`insert into caja_puntos (codigo, nombre, activo, tipo) values ('punto_venta', 'Punto de venta (prueba edit)', true, 'fijo') returning id`).id);
  // Nota: caja_dias tiene unique (id_punto, fecha) — reabrir un día ya usado hoy es UPDATE, no INSERT
  // (el brief original insertaba a ciegas y chocaba tras el primer cerrarCaja() de D2).
  const abrirCaja = () => {
    if (uno(`select id from caja_dias where id_punto = ${idPunto} and fecha = current_date and estatus = 'abierta'`).id) return;
    const existente = uno(`select id from caja_dias where id_punto = ${idPunto} and fecha = current_date`).id;
    if (existente) sql(`update caja_dias set estatus = 'abierta', abierta_por = 'probar-editar', fecha_apertura = now(), cerrada_por = null, fecha_cierre = null where id = ${existente}`);
    else sql(`insert into caja_dias (id_punto, fecha, saldo_apertura, estatus, abierta_por, fecha_apertura) values (${idPunto}, current_date, 0, 'abierta', 'probar-editar', now())`);
  };
  const cerrarCaja = () => sql(`update caja_dias set estatus = 'cerrada', cerrada_por = 'probar-editar', fecha_cierre = now() where id_punto = ${idPunto} and fecha = current_date and estatus = 'abierta'`);
  const movs = (id) => sql(`select id, tipo, monto, id_mov_pareja, descripcion from caja_movimientos where id_orden = ${id} order by id`);
  abrirCaja();
  const cD = await alta('Edit D');
  // D1. Pagado en efectivo (mostrador por Ana → caja 'confirmado' al pagar), total baja: asiento negativo emparejado.
  const p1 = await pedidoVend(ana, cD, 'mostrador', [linea(P100, '100g', 4, 35)], 140, { canal: 'mostrador' }); creados.push(p1?.idOrden);
  await confirmar(p1); await pagar(p1);
  const m0 = movs(p1.idOrden);
  ok(m0.length === 1 && m0[0].tipo === 'venta_efectivo' && cerca(m0[0].monto, 140), `D1 venta asentada: ${m0[0]?.tipo} ${m0[0]?.monto} (140)`);
  const r1 = (await editar(ana, p1.idOrden, [{ id: lineasDe(p1.idOrden)[0].id, cantidad: 3 }])).json; const m1 = movs(p1.idOrden);
  ok(r1?.ok && m1.length === 2 && m1[1].tipo === 'venta_efectivo' && cerca(m1[1].monto, -35) && Number(m1[1].id_mov_pareja) === Number(m0[0].id) && /edici/i.test(m1[1].descripcion) && cerca(m1[0].monto, 140) && cerca(r1?.caja?.monto, -35),
     `D1 4→3: asiento ${m1[1]?.tipo} ${m1[1]?.monto} (−35) pareja ${m1[1]?.id_mov_pareja}=${m0[0]?.id}; original intacto; respuesta caja.monto ${r1?.caja?.monto}`);
  const r1b = (await editar(ana, p1.idOrden, [{ id: lineasDe(p1.idOrden)[0].id, cantidad: 3 }, { idProducto: String(P100), cantidad: 1 }])).json; const m1b = movs(p1.idOrden);
  ok(r1b?.ok && m1b.length === 3 && cerca(m1b[2].monto, 35), `D1b subir el total: asiento +35 (${m1b[2]?.monto})`);
  const r1c = (await editar(ana, p1.idOrden, lineasDe(p1.idOrden).map(l => ({ id: l.id })))).json;
  ok(r1c?.ok && movs(p1.idOrden).length === 3, `D1c editar sin cambiar el total: sin asiento nuevo (${movs(p1.idOrden).length})`);
  // D2. Caja cerrada: caja_cerrada y nada cambia.
  cerrarCaja();
  const antes2 = JSON.stringify([lineasDe(p1.idOrden), cab(p1.idOrden).total, movs(p1.idOrden).length]);
  const r2 = (await editar(ana, p1.idOrden, [{ id: lineasDe(p1.idOrden)[0].id, cantidad: 1 }, { id: lineasDe(p1.idOrden)[1].id }])).json;
  ok(r2?.error === 'caja_cerrada' && JSON.stringify([lineasDe(p1.idOrden), cab(p1.idOrden).total, movs(p1.idOrden).length]) === antes2, `D2 caja cerrada: ${r2?.error}, nada cambió`);
  abrirCaja();
  // D3. Consumidor pagado con puntos dados: ajuste por la diferencia; saldo cuadra.
  const p3 = await pedidoCli(cD, [linea(P100, '100g', 10, 35)], 350); creados.push(p3?.idOrden); await confirmar(p3); await pagar(p3);
  const gen = uno(`select coalesce(sum(puntos),0)::int s from lealtad_movimientos where id_orden = ${p3.idOrden} and tipo = 'generacion'`).s;
  ok(gen === 35, `D3 pagado: generación ${gen} (35 = floor(350 × 0.1))`);
  const r3 = (await editar(ana, p3.idOrden, [{ id: lineasDe(p3.idOrden)[0].id, cantidad: 4 }])).json;
  const aj = sql(`select puntos, nota from lealtad_movimientos where id_orden = ${p3.idOrden} and tipo = 'ajuste'`);
  const saldo = (await rpc('mis_puntos', { p_token: cD.token })).json?.saldo;
  ok(r3?.ok && aj.length === 1 && Number(aj[0].puntos) === -21 && cerca(r3?.puntos?.puntos, -21) && Number(saldo) === Number(uno(`select coalesce(sum(puntos),0) s from lealtad_movimientos where id_cliente = ${cD.id}`).s),
     `D3 350→140: ajuste ${aj[0]?.puntos} (−21), saldo ${saldo} = Σ ledger`);
  const r3b = (await editar(ana, p3.idOrden, [{ id: lineasDe(p3.idOrden)[0].id, cantidad: 4 }, { idProducto: String(P100), cantidad: 6 }])).json;
  const aj2 = uno(`select coalesce(sum(puntos),0)::int s from lealtad_movimientos where id_orden = ${p3.idOrden} and tipo in ('generacion','reversion','ajuste')`).s;
  ok(r3b?.ok && aj2 === 35, `D3b vuelve a 350: neto de puntos del pedido ${aj2} (35)`);
  // D4. Reto que deja de cumplirse: el bono se compensa.
  const reto = (await rpc('guardar_reto', { p_data: { token: ana.token, reto: { nombre: 'Monto edit ' + sufijo, descripcion: 'p', tipo: 'monto', meta: 300, bono: 40, desde: new Date(Date.now() - 864e5).toISOString().slice(0, 10), hasta: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), publico: 'consumidores', activo: true } } })).json;
  const cR = await alta('Edit D reto');
  const p4 = await pedidoCli(cR, [linea(P100, '100g', 10, 35)], 350); creados.push(p4?.idOrden); await confirmar(p4); await pagar(p4);
  const bono = () => Number(uno(`select coalesce(sum(puntos),0)::int s from lealtad_movimientos where id_cliente = ${cR.id} and tipo = 'reto' and id_premio = ${reto?.reto?.id || 0}`).s);
  ok(bono() === 40, `D4 reto de monto 300 cumplido con 350: bono ${bono()} (40)`);
  const r4 = (await editar(ana, p4.idOrden, [{ id: lineasDe(p4.idOrden)[0].id, cantidad: 5 }])).json;
  ok(r4?.ok && bono() === 0, `D4 baja a 175: bono compensado (${bono()})`);
  if (reto?.reto?.id) await rpc('guardar_reto', { p_data: { token: ana.token, reto: { ...reto.reto, activo: false } } });
  // D5. Vendedor edita un pedido armado: vuelve a Por armar con editadoEn en la cola.
  // marcar_armado y cola_armado (20260921000000_cola_armado.sql / 20260923000000_rutas.sql) usan
  // 'id' (no 'idOrden') y la cola responde en la clave 'pedidos' (para estatus 'En proceso').
  const fechaP5 = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const p5 = await pedidoCli(cD, [linea(P100, '100g', 2, 35)], 70, { fechaEntrega: fechaP5 }); creados.push(p5?.idOrden); await confirmar(p5);
  const rm = (await rpc('marcar_armado', { p_data: { token: ana.token, id: String(p5.idOrden), armado: true, actor: 'probar' } })).json;
  ok(rm?.ok !== false && cab(p5.idOrden).armado_en, `D5 marcado armado (${cab(p5.idOrden).armado_en})`);
  const r5 = (await editar(ana, p5.idOrden, [{ id: lineasDe(p5.idOrden)[0].id, cantidad: 3 }])).json; const c5 = cab(p5.idOrden);
  const cola = (await rpc('cola_armado', { p_data: { token: ana.token, fecha: fechaP5 } })).json;
  ok(r5?.ok && c5.armado_en === null && (r5.avisos || []).includes('ya_armado') && JSON.stringify(cola).includes('"editadoEn"'), `D5 tras editar: armado_en ${c5.armado_en} (null), aviso ya_armado, cola_armado trae editadoEn`);
  cerrarCaja();
}

// (las secciones E-F van aquí)

// ── Limpieza ────────────────────────────────────────────────────────────────
for (const id of creados) { try { await cancelar({ idOrden: id }); } catch (_e) {} }
sql(`update lotes_produccion set estatus = 'Cerrado', fecha_cierre = now() where id_lote = '${idLote}'`);
sql(`update productos set activo = false where sabor like 'EDIT-${sufijo}%'`);
console.log(`\n${fallos} fallo(s).`);
process.exit(fallos ? 1 : 0);
