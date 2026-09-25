#!/usr/bin/env node
// tools/probar-costo-en-venta.mjs — el costo se CONGELA al vender (D11).
// Spec: cambios/2026-09-23-costeo-y-margen/diseno.md, tarea 5 del plan.
//
// La aserción central es C2: subir el precio de la papa NO debe mover el costo de un pedido ya
// escrito. Si lo mueve, el margen se recalcula al vuelo y una compra de insumos reescribiría hacia
// atrás la historia de márgenes de todos los pedidos.
//
// C3 existe por la regla 59: aplicar la regla en un sitio y olvidarla en el de al lado. Las dos
// puertas que escriben líneas son crear_pedido y editar_pedido_interno, y se comprueban por
// separado. Se implementó con un trigger BEFORE INSERT justo para que no se puedan desincronizar,
// pero la prueba no da eso por hecho: comprueba el resultado en las dos.
//
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
const rpc = async (n, b) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }); return await r.json().catch(() => null); };
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };
const dir = mkdtempSync(join(tmpdir(), 'costo-venta-'));
const sql = (q) => { const f = join(dir, 'q.sql'); writeFileSync(f, q); const out = execSync(`supabase db query --linked --project-ref ${STG} -o json --file "${f}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); const i = out.indexOf('{'); return i < 0 ? [] : (JSON.parse(out.slice(i)).rows || []); };
const uno = (q) => (sql(q)[0] || {});
const sufijo = String(Date.now()).slice(-6);

// ── Fixture: una receta REAL para un producto real, con el prefijo barrible ──
const barrer = () => sql(`
  delete from recetas       where nota like 'prueba-costoventa%';
  delete from insumos_costos where id_insumo in (select id from insumos where nombre like 'ZZ-costoventa%');
  delete from receta_lineas  where id_insumo in (select id from insumos where nombre like 'ZZ-costoventa%');
  delete from insumos        where nombre like 'ZZ-costoventa%'`);
barrer();

const P100 = Number(uno(`select id from productos where activo and coalesce(descontinuado,false)=false
  and gramos = 100 order by id limit 1`).id);
const P250 = Number(uno(`select id from productos where activo and coalesce(descontinuado,false)=false
  and gramos = 250 order by id limit 1`).id);

const idPapa = Number(uno(`insert into insumos (nombre, unidad, activo, tipo)
  values ('ZZ-costoventa Papa ${sufijo}', 'kg', true, 'materia_prima') returning id`).id);
const idBolsa = Number(uno(`insert into insumos (nombre, unidad, activo, tipo)
  values ('ZZ-costoventa Bolsa ${sufijo}', 'pieza', true, 'empaque') returning id`).id);
sql(`insert into insumos_costos (id_insumo, costo_unidad, vigente_desde) values
  (${idPapa}, 20, '2026-01-01'), (${idBolsa}, 1.5, '2026-01-01')`);

const idBase = Number(uno(`insert into recetas (tipo, rinde_cantidad, rinde_unidad, vigente_desde, nota)
  values ('base', 1, 'kg', '2026-01-01', 'prueba-costoventa ${sufijo}') returning id`).id);
sql(`insert into receta_lineas (id_receta, id_insumo, cantidad, unidad) values (${idBase}, ${idPapa}, 4.25, 'kg')`);

for (const [prod, kg] of [[P100, 0.100], [P250, 0.250]]) {
  const r = Number(uno(`insert into recetas (tipo, id_producto, rinde_cantidad, rinde_unidad, kg_base, vigente_desde, nota)
    values ('sku', ${prod}, 1, 'pieza', ${kg}, '2026-01-01', 'prueba-costoventa ${sufijo}') returning id`).id);
  sql(`insert into receta_lineas (id_receta, id_insumo, cantidad, unidad) values (${r}, ${idBolsa}, 1, 'pieza')`);
}

// Base = 4.25 * 20 = 85 por kg. P100 = 0.100*85 + 1.5 = 10.00. P250 = 0.250*85 + 1.5 = 22.75.
const esperado100 = Number(uno(`select public.costo_sku(${P100}, current_date) c`).c);
const esperado250 = Number(uno(`select public.costo_sku(${P250}, current_date) c`).c);
ok(esperado100 === 10 && esperado250 === 22.75,
   `Fixture: costo_sku da 10.00 y 22.75 (dio ${esperado100} y ${esperado250})`);

// ── Sesión de la dueña y un cliente de prueba ───────────────────────────────
const ana = await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000001', pin: '1234' } });
if (!ana?.token) { ok(false, 'sesión de Ana'); process.exit(1); }
const tel = '55999' + sufijo;
const cli = await rpc('registrar_o_actualizar_cliente', { p_data: { telefono: tel, nombre: 'ZZ-costoventa ' + sufijo,
  tipo: 'Consumidor', tipoId: 1, direccion: 'Calle 1', cp: '03400', colonia: 'Álamos', municipio: 'Benito Juárez', estado: 'CDMX', coordenadas: '' } });

// El precio lo decide el SERVIDOR (regla 10). Inventarlo aqui devuelve `precio_cambiado` y la
// prueba fallaria por el motivo equivocado, no por el que se quiere medir (regla 53).
const prod = (id) => uno(`select sabor, presentacion, precio_consumidor p from productos where id = ${id}`);
const d100 = prod(P100), d250 = prod(P250);
const linea = (id, d, n) => ({ idProducto: String(id), sabor: d.sabor, presentacion: d.presentacion,
  tipoVenta: 'Por Pieza', cantidad: n, gramos: 0, precio: Number(d.p),
  subtotal: Math.round(Number(d.p) * n * 100) / 100 });

console.log('\nC1: crear_pedido escribe el costo al vender');
const ped = await rpc('crear_pedido', { p_data: { token: ana.token, idCliente: cli.idCliente, nombre: cli.nombre,
  telefono: tel, cp: '03400', colonia: 'Álamos', direccion: 'Calle 1', metodoEntrega: 'coordinar',
  tipoPagoId: 1, tipoPago: 'Efectivo', notas: '[costo] prueba', idempotencyKey: 'costo-' + sufijo,
  total: Math.round(Number(d100.p) * 2 * 100) / 100, productos: [linea(P100, d100, 2)] } });
ok(ped?.ok === true, `C1 pedido creado (${ped?.consecutivo || JSON.stringify(ped)?.slice(0, 120)})`);

const l1 = uno(`select id, costo_unitario, costo_origen from ordenes_detalle
                 where id_orden = ${Number(ped?.idOrden)} order by id limit 1`);
ok(Number(l1.costo_unitario) === 10, `C1 la línea nació con costo 10.00 (${l1.costo_unitario})`);
ok(l1.costo_origen === 'capturado', `C1 origen 'capturado' (${l1.costo_origen})`);

console.log('\nC2: subir el precio de la papa NO mueve el costo ya escrito');
sql(`insert into insumos_costos (id_insumo, costo_unidad, vigente_desde) values (${idPapa}, 99, current_date)
     on conflict (id_insumo, vigente_desde) do update set costo_unidad = 99`);
const recalculado = Number(uno(`select public.costo_sku(${P100}, current_date) c`).c);
ok(recalculado > 10, `C2 el costo NUEVO de ese SKU sí subió: ${recalculado} (la prueba sirve)`);
const l1b = uno(`select costo_unitario from ordenes_detalle where id = ${Number(l1.id)}`);
ok(Number(l1b.costo_unitario) === 10,
   `C2 el costo de la línea YA ESCRITA sigue en 10.00 (${l1b.costo_unitario}) — está congelado`);

console.log('\nC3: editar_pedido_interno también escribe el costo (regla 59)');
const ed = await rpc('editar_pedido', { p_data: { token: ana.token, idOrden: String(ped?.idOrden),
  actualizadoPor: 'probar-costo', modo: 'aplicar',
  lineas: [{ id: Number(l1.id) }, { idProducto: String(P250), cantidad: 1 }] } });
ok(ed?.ok === true, `C3 edición aplicada (${JSON.stringify(ed)?.slice(0, 140)})`);
const l2 = uno(`select costo_unitario, costo_origen from ordenes_detalle
                 where id_orden = ${Number(ped?.idOrden)} and id <> ${Number(l1.id)} order by id desc limit 1`);
ok(l2.costo_unitario !== null && l2.costo_unitario !== undefined,
   `C3 la línea añadida al EDITAR también nace con costo (${l2.costo_unitario})`);
// Se añadió después de subir la papa, así que cuesta lo NUEVO, no lo viejo: el congelado es por
// línea y al momento de escribirla, no un valor global del pedido.
const esperadoNuevo250 = Number(uno(`select public.costo_sku(${P250}, current_date) c`).c);
ok(Number(l2.costo_unitario) === esperadoNuevo250,
   `C3 y cuesta lo de HOY (${l2.costo_unitario} = ${esperadoNuevo250}), no lo de cuando nació el pedido`);

console.log('\nC4: una bebida no revienta el cast de id_producto');
const beb = uno(`select id, nombre from productos_bebidas where activo order by id limit 1`);
if (beb?.id) {
  const edB = await rpc('editar_pedido', { p_data: { token: ana.token, idOrden: String(ped?.idOrden),
    actualizadoPor: 'probar-costo', modo: 'aplicar',
    lineas: [{ id: Number(l1.id) }, { idProducto: 'b' + beb.id, cantidad: 1 }] } });
  const lB = uno(`select costo_unitario, costo_origen from ordenes_detalle
                   where id_orden = ${Number(ped?.idOrden)} and id_producto = 'b${beb.id}' limit 1`);
  ok(edB?.ok === true || !!lB, `C4 la línea de bebida se pudo escribir sin error de cast`);
} else {
  ok(true, 'C4 omitido: no hay bebidas activas en staging');
}

// ── Limpieza del fixture (el pedido se queda, marcado [costo] prueba) ───────
barrer();
ok(Number(uno(`select count(*) n from insumos where nombre like 'ZZ-costoventa%'`).n) === 0,
   'Limpieza: fixture de insumos y recetas fuera de staging');

console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
