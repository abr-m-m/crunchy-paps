#!/usr/bin/env node
// tools/probar-costeo.mjs — costeo estándar (20261013000000 en adelante).
// `productos` tiene siete columnas de precio y cero de costo; `insumos`, `uso_insumos`,
// `gastos_insumos` e `insumos_estado` estaban las cuatro vacías en producción el 23 sep 2026.
// Estas pruebas cubren que el costo se resuelva por VIGENCIA (D15), que un costo ausente se
// propague como NULL y nunca como 0 (D12), y —cuando llegue la tarea 5— que el costo congelado
// en la venta no se mueva al subir el precio de la papa (D11).
// Diseño y plan: cambios/2026-09-23-costeo-y-margen/.
// Escribe en STAGING. Necesita `node tools/ver-en-staging.mjs`.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STG = 'dkwatbsaidlfjqjnfyrk';
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging' || !SUPABASE_URL.includes(STG)) { console.error('No es staging: ' + SUPABASE_URL); process.exit(1); }
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };
const dir = mkdtempSync(join(tmpdir(), 'costeo-'));
const sql = (q) => { const f = join(dir, 'q.sql'); writeFileSync(f, q); const out = execSync(`supabase db query --linked --project-ref ${STG} -o json --file "${f}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); const i = out.indexOf('{'); return i < 0 ? [] : (JSON.parse(out.slice(i)).rows || []); };
const uno = (q) => (sql(q)[0] || {});
const sufijo = String(Date.now()).slice(-6);

// Barrido de entrada, ANTES del primer insert. Una corrida que muera a mitad deja fixture vivo, y
// `ux_recetas_base_vigencia` —único por fecha para tipo='base'— bloquearía la siguiente. Se lleva
// los restos de CUALQUIER corrida anterior, y por eso los nombres llevan el prefijo ZZ-prueba-costeo.
// Va aquí arriba a propósito: puesto más abajo se llevaría por delante el insumo que los casos 3 en
// adelante necesitan, y el fallo saldría como violación de clave ajena en otro sitio.
const barrer = () => sql(`
  delete from recetas       where nota like 'prueba-costeo%';
  delete from insumos_costos where id_insumo in (select id from insumos where nombre like 'ZZ-prueba-costeo%');
  delete from receta_lineas  where id_insumo in (select id from insumos where nombre like 'ZZ-prueba-costeo%');
  delete from insumos        where nombre like 'ZZ-prueba-costeo%'`);
barrer();

// ── Fixture: un insumo con TRES costos vigentes en fechas distintas ──────────
const idPapa = Number(uno(`insert into insumos (nombre, unidad, activo, tipo)
  values ('ZZ-prueba-costeo Papa ${sufijo}', 'kg', true, 'materia_prima') returning id`).id);
sql(`insert into insumos_costos (id_insumo, costo_unidad, vigente_desde, fuente) values
  (${idPapa}, 15, '2026-06-01', 'reconstruido'),
  (${idPapa}, 20, '2026-07-01', 'reconstruido'),
  (${idPapa}, 25, '2026-09-01', 'capturado')`);

console.log('\nCaso 1: costo_insumo resuelve por vigencia, no por el último cargado');
ok(Number(uno(`select public.costo_insumo(${idPapa}, '2026-06-15') c`).c) === 15, 'C1 el 15 jun vale 15');
ok(Number(uno(`select public.costo_insumo(${idPapa}, '2026-07-01') c`).c) === 20, 'C1 el 1 jul vale 20 (el borde entra)');
ok(Number(uno(`select public.costo_insumo(${idPapa}, '2026-08-31') c`).c) === 20, 'C1 el 31 ago sigue en 20');
ok(Number(uno(`select public.costo_insumo(${idPapa}, '2026-09-23') c`).c) === 25, 'C1 hoy vale 25');

console.log('\nCaso 2: antes del primer costo es NULL, nunca 0');
ok(uno(`select public.costo_insumo(${idPapa}, '2026-05-31') c`).c === null,
   'C2 el 31 may devuelve NULL (no hay costo vigente todavía)');

// ── Fixture de recetas ───────────────────────────────────────────────────────
const idAceite = Number(uno(`insert into insumos (nombre, unidad, activo, tipo)
  values ('ZZ-prueba-costeo Aceite ${sufijo}', 'L', true, 'materia_prima') returning id`).id);
sql(`insert into insumos_costos (id_insumo, costo_unidad, vigente_desde) values (${idAceite}, 40, '2026-06-01')`);

// Receta de base: 4.25 kg de papa + 0.2 L de aceite rinden 1 kg de base.
const idRecBase = Number(uno(`insert into recetas (tipo, rinde_cantidad, rinde_unidad, vigente_desde, nota)
  values ('base', 1, 'kg', '2026-06-01', 'prueba-costeo ${sufijo}') returning id`).id);
sql(`insert into receta_lineas (id_receta, id_insumo, cantidad, unidad) values
  (${idRecBase}, ${idPapa}, 4.25, 'kg'), (${idRecBase}, ${idAceite}, 0.2, 'L')`);

console.log('\nCaso 3: costo_base_kg da el número calculado a mano');
ok(Number(uno(`select public.costo_base_kg('2026-09-23') c`).c) === 114.25,
   'C3 el 23 sep, con la papa a 25: 4.25*25 + 0.2*40 = 114.25');
ok(Number(uno(`select public.costo_base_kg('2026-06-15') c`).c) === 71.75,
   'C3 el 15 jun, con la papa a 15: 4.25*15 + 0.2*40 = 71.75');
// La fecha se movió el 21 nov 2026, y el motivo vale: hasta entonces no había
// ninguna receta real y el 31 may servía. Ahora SÍ la hay, vigente desde el
// 9 ene 2026 —el primer día del cuaderno—, así que esa fecha ya devuelve un
// número y la prueba empezó a fallar. Falló bien: el mundo cambió. Para probar
// «antes de que exista ninguna receta» hay que irse antes de enero.
ok(uno(`select public.costo_base_kg('2025-12-31') c`).c === null,
   'C3 antes de que exista NINGUNA receta: NULL, no 0');

console.log('\nCaso 4: un insumo SIN costo hace NULL toda la receta, no la ignora');
// LA TRAMPA: sum() de Postgres salta los NULL en silencio y daría 114.25 igual, ocultando que
// falta el costo de un insumo. Ese número es MENOR que el real y tiene cara de bueno.
const idSal = Number(uno(`insert into insumos (nombre, unidad, activo, tipo)
  values ('ZZ-prueba-costeo Sal sin costo ${sufijo}', 'kg', true, 'materia_prima') returning id`).id);
sql(`insert into receta_lineas (id_receta, id_insumo, cantidad, unidad) values (${idRecBase}, ${idSal}, 0.01, 'kg')`);
ok(uno(`select public.costo_base_kg('2026-09-23') c`).c === null,
   'C4 con un insumo sin costo, la receta entera es NULL (y NO 114.25)');
sql(`delete from receta_lineas where id_receta = ${idRecBase} and id_insumo = ${idSal}`);

console.log('\nCaso 5: costo_sku suma la base más el empaque de su propia receta');
const idBolsa = Number(uno(`insert into insumos (nombre, unidad, activo, tipo)
  values ('ZZ-prueba-costeo Bolsa 100g ${sufijo}', 'pieza', true, 'empaque') returning id`).id);
sql(`insert into insumos_costos (id_insumo, costo_unidad, vigente_desde) values (${idBolsa}, 1.5, '2026-06-01')`);
const idProd = Number(uno(`select id from productos where activo and coalesce(descontinuado,false)=false
  and gramos = 100 order by id limit 1`).id);
const idRecSku = Number(uno(`insert into recetas (tipo, id_producto, rinde_cantidad, rinde_unidad, kg_base, vigente_desde, nota)
  values ('sku', ${idProd}, 1, 'pieza', 0.100, '2026-06-01', 'prueba-costeo ${sufijo}') returning id`).id);
sql(`insert into receta_lineas (id_receta, id_insumo, cantidad, unidad) values (${idRecSku}, ${idBolsa}, 1, 'pieza')`);
ok(Number(uno(`select public.costo_sku(${idProd}, '2026-09-23') c`).c) === 12.925,
   'C5 una pieza de 100 g: 0.100*114.25 + 1*1.5 = 12.925');

console.log('\nCaso 6: un SKU sin receta sale SIN COSTEAR, no con margen del 100%');
const idSinReceta = Number(uno(`select p.id from productos p where p.activo
  and not exists (select 1 from recetas r where r.tipo='sku' and r.id_producto = p.id)
  order by p.id limit 1`).id);
ok(uno(`select public.costo_sku(${idSinReceta}, '2026-09-23') c`).c === null,
   `C6 el producto ${idSinReceta} no tiene receta: NULL, no 0`);

console.log('\nCaso 7: si la BASE no se puede costear, el SKU tampoco');
sql(`insert into receta_lineas (id_receta, id_insumo, cantidad, unidad) values (${idRecBase}, ${idSal}, 0.01, 'kg')`);
ok(uno(`select public.costo_sku(${idProd}, '2026-09-23') c`).c === null,
   'C7 con la base en NULL, el SKU también es NULL (no solo el empaque)');

// ── Casos 8-10: el DISPARADOR, que hasta hoy no probaba nadie ───────────────
// La cabecera de este archivo decía «y —cuando llegue la tarea 5— que el costo
// congelado en la venta no se mueva al subir el precio de la papa (D11)». La
// tarea 5 llegó: el disparador existe desde octubre y la siembra del 21 nov le
// dio de comer. Estos tres casos son esa deuda, pagada.
//
// Los siete de arriba prueban las FUNCIONES llamándolas a mano. Ninguno metía
// una línea de pedido, que es por donde entra el costo de verdad.
barrer();   // de aquí en adelante se usan los insumos SEMBRADOS, no el fixture

console.log('\nCaso 8: al escribir una línea, el disparador la costea solo');
const costoHoy = Number(uno(`select public.costo_base_kg(current_date) c`).c);
ok(costoHoy > 0, `C8 la base vale ${costoHoy} hoy, con papa, aceite, gas y otros`);
const idP100 = Number(uno(`select p.id from productos p
   where p.activo and p.gramos = 100 and p.sabor not like 'EDIT-%' limit 1`).id);
const idOrden = Number(uno(`insert into ordenes (consecutivo, estatus_pedido, tipo_interno)
   values ('ZZ-COSTEO-' || substr(md5(random()::text),1,6), 'Pendiente', 'prueba') returning id`).id);
const l1 = uno(`insert into ordenes_detalle (id_orden, id_producto, cantidad, subtotal, tipo_venta)
   values (${idOrden}, '${idP100}', 2, 64, 'Por Pieza')
   returning costo_unitario::numeric cu, coalesce(costo_origen,'') co`);
ok(Math.abs(Number(l1.cu) - costoHoy * 0.1) < 0.01,
   `C8 la línea quedó costeada sola en ${l1.cu} (un décimo del kilo)`);
ok(l1.co === 'capturado', 'C8 y marcada como capturado, no como reconstruido');

console.log('\nCaso 9: el granel se costea por lo que PESÓ, no por una receta fija');
// Sus líneas llevan cantidad = 1 y el peso aparte: comprobado en producción,
// cinco líneas con gramos de 136 a 1000. Sin esta rama todas costarían igual.
const idGranel = Number(uno(`select p.id from productos p
   where p.activo and coalesce(p.gramos,0) = 0 limit 1`).id || 0);
if (idGranel) {
  const g1 = uno(`insert into ordenes_detalle (id_orden, id_producto, cantidad, gramos_vendidos, subtotal, tipo_venta)
     values (${idOrden}, '${idGranel}', 1, 136, 30, 'A granel') returning costo_unitario::numeric cu`);
  const g2 = uno(`insert into ordenes_detalle (id_orden, id_producto, cantidad, gramos_vendidos, subtotal, tipo_venta)
     values (${idOrden}, '${idGranel}', 1, 1000, 220, 'A granel') returning costo_unitario::numeric cu`);
  ok(Math.abs(Number(g1.cu) - costoHoy * 0.136) < 0.01, `C9 136 g cuestan ${g1.cu}`);
  ok(Math.abs(Number(g2.cu) - costoHoy) < 0.01, `C9 y 1 kg cuesta ${g2.cu}, no lo mismo`);
  ok(Number(g2.cu) > Number(g1.cu) * 7, 'C9 manda el peso, no una receta fija');
} else {
  ok(false, 'C9 no hay producto a granel en staging para probarlo');
}

console.log('\nCaso 10: EL COSTO SE CONGELA — subir la papa no reescribe el pasado');
// Es la razón de ser del diseño (D11): si el margen se recalculara al vuelo,
// una compra cara de papa cambiaría hacia atrás el margen de todo lo vendido.
const antesDeSubir = Number(l1.cu);
const idPapaSembrada = Number(uno(`select id from insumos where nombre = 'Papa' limit 1`).id);
sql(`insert into insumos_costos (id_insumo, costo_unidad, vigente_desde, fuente, nota)
     values (${idPapaSembrada}, 999, current_date + 1, 'capturado', 'ZZ-prueba-costeo subida')`);
ok(Number(uno(`select public.costo_base_kg(current_date + 1) c`).c) > costoHoy * 2,
   'C10 lo que se venda MAÑANA sí cuesta más');
const vieja = uno(`select costo_unitario::numeric cu from ordenes_detalle
   where id_orden = ${idOrden} and tipo_venta = 'Por Pieza' limit 1`);
ok(Math.abs(Number(vieja.cu) - antesDeSubir) < 0.001,
   `C10 y la línea ya vendida sigue en ${vieja.cu}: el pasado no se movió`);
sql(`delete from insumos_costos where nota = 'ZZ-prueba-costeo subida'`);

sql(`delete from ordenes_detalle where id_orden = ${idOrden}; delete from ordenes where id = ${idOrden}`);
ok(Number(uno(`select count(*) n from ordenes where consecutivo like 'ZZ-COSTEO-%'`).n) === 0,
   'Limpieza: no quedó ningún pedido de prueba');

console.log('\nCaso 11: un ticket de compra pone el precio, para que no envejezca');
// El costo sembrado el 21 nov ($23 la papa) envejece: en dos meses nadie se
// acuerda de venir a cambiarlo y el margen que enseñe el sistema será falso
// sin avisar. Un dato que hay que mantener a mano no se mantiene — lo probó
// `gastos`, con tres filas en un año. Así que lo pone la compra misma.
const c11 = uno(`select public.registrar_costo_insumo(
   ('{"insumo":"PAPA","cantidad":60,"importe":1500,"fecha":"' || (current_date + 3)::text || '","quien":"prueba"}')::jsonb) j`).j;
ok(c11.ok === true, 'C11 acepta la compra');
ok(Number(c11.unitario) === 25, `C11 EL SERVIDOR hace la división: 1500/60 = ${c11.unitario}`);
ok(c11.insumo === 'Papa', "C11 'PAPA' en mayúsculas encuentra a 'Papa'");
ok(Number(c11.cambio_pct) > 0, `C11 y avisa de cuánto subió: ${c11.cambio_pct}%`);
ok(Number(c11.costoBaseKg) > costoHoy,
   `C11 el kilo de base sube solo, de ${costoHoy} a ${c11.costoBaseKg}`);

console.log('\nCaso 12: el modelo NO puede inventar insumos');
// Que la papa sea un insumo es una DECISIÓN y se toma en la app. Que hoy valga
// 23 es un HECHO. El agente captura hechos; si además crea catálogo, en un mes
// hay cuatro «papas» distintas y ningún costo sirve.
const c12 = uno(`select public.registrar_costo_insumo(
   '{"insumo":"papa morada que no existe","cantidad":5,"importe":100}'::jsonb) j`).j;
ok(c12.ok === false, 'C12 un insumo fuera del catálogo se rechaza');
ok(Array.isArray(c12.insumos) && c12.insumos.length > 0,
   `C12 y le dice cuáles sí hay, para que pueda decirlo: ${JSON.stringify(c12.insumos)}`);
ok(Number(uno(`select count(*) n from insumos where nombre ilike '%morada%'`).n) === 0,
   'C12 no se creó nada');

console.log('\nCaso 13: sin cantidad o sin importe no se inventa un precio');
ok(uno(`select public.registrar_costo_insumo('{"insumo":"Papa","importe":100}'::jsonb) j`).j.ok === false,
   'C13 sin cantidad, no');
ok(uno(`select public.registrar_costo_insumo('{"insumo":"Papa","cantidad":10}'::jsonb) j`).j.ok === false,
   'C13 sin importe, tampoco');
ok(uno(`select public.registrar_costo_insumo('{"insumo":"Papa","cantidad":0,"importe":100}'::jsonb) j`).j.ok === false,
   'C13 y cantidad cero se rechaza antes de dividir entre cero');
console.log('\nCaso 14: DE PUNTA A PUNTA — un ticket por WhatsApp, dos hechos');
// La primera vez que se probó así falló: la herramienta del agente manda
// `nombre` dentro del bloque y la función leía `insumo`. El gasto se guardó
// igual —que es lo correcto— y el costo se perdió en silencio. Probar las
// piezas por separado no lo habría encontrado nunca: las dos estaban bien.
sql(`update vendedores set secciones = array_append(coalesce(secciones,array[]::text[]),'gastos')
      where id=1 and not ('gastos' = any(coalesce(secciones,array[]::text[])))`);
const e2e = uno(`select public.wa_registrar_gasto(('{
   "telefono":"5500000001",
   "idMensaje":"ZZ-prueba-costeo-e2e-' || substr(md5(random()::text),1,8) || '",
   "campos":{"monto":1500,"categoria":"Materia Prima","area":"Producción",
             "fecha":"' || (current_date + 4)::text || '"},
   "insumo":{"nombre":"papa","cantidad":60,"importe":1500}
 }')::jsonb) j`).j;
ok(e2e.ok === true && e2e.creado === true, 'C14 el gasto queda guardado');
const ci14 = e2e.costoInsumo || {};
ok(ci14.ok === true, `C14 y el costo del insumo también: ${JSON.stringify(ci14.error || '')}`);
ok(Number(ci14.unitario) === 25, `C14 'papa' en minúsculas dio con 'Papa' y salió a ${ci14.unitario}`);
ok(Number(ci14.costoBaseKg) > 0, `C14 el kilo de base ya refleja la compra: ${ci14.costoBaseKg}`);
sql(`delete from gastos where wa_mensaje_id like 'ZZ-prueba-costeo-e2e%'`);
sql(`update vendedores set secciones = array_remove(secciones,'gastos') where id = 1`);

sql(`delete from insumos_costos where vigente_desde > current_date`);

console.log('\nCaso 15: la línea POR PIEZA se costea por su RECETA, el granel por su PESO');
// EL CASO QUE FALTABA, y el defecto que encontró. Hasta el 21 nov el disparador
// abría con `if gramos_vendidos > 0 then` creyendo que solo el granel llena ese
// campo. No: TODA línea por pieza de papa lo lleva con el peso de su
// presentación -65 líneas de 100 g, 49 de 250 g, medido en producción-, así que
// la rama de granel se comía las de pieza y `costo_sku` no se llamaba NUNCA.
//
// No se vio porque hoy los dos caminos dan el MISMO número: la receta de un SKU
// es kg de base y nada más. El caso 8 lo comprueba contra `costoHoy * 0.1`, que
// es justo lo que no distingue un camino del otro (regla 53: una aserción que
// mira la FORMA y no la propiedad que importa).
//
// Este caso rompe el empate: le mete una BOLSA a la receta del SKU. Si manda la
// receta, la pieza encarece 1.50 y el granel no se mueve. Con el disparador
// viejo los dos salían iguales -y el empaque desaparecía en silencio-.
const idP15 = Number(uno(`select p.id from productos p
   where p.activo and p.gramos = 100 and p.sabor not like 'EDIT-%' limit 1`).id);
const idRec15 = Number(uno(`select r.id from recetas r
   where r.tipo='sku' and r.id_producto = ${idP15} and r.activa
   order by r.vigente_desde desc limit 1`).id || 0);
const idBolsa15 = Number(uno(`insert into insumos (nombre, unidad, activo, tipo)
   values ('ZZ-prueba-costeo Bolsa ${sufijo}', 'pieza', true, 'empaque') returning id`).id);
sql(`insert into insumos_costos (id_insumo, costo_unidad, vigente_desde, fuente)
     values (${idBolsa15}, 1.50, '2026-01-01', 'capturado')`);

const sinBolsa = Number(uno(`select public.costo_sku(${idP15}, current_date) c`).c);
sql(`insert into receta_lineas (id_receta, id_insumo, cantidad, unidad)
     values (${idRec15}, ${idBolsa15}, 1, 'pieza')`);
const conBolsa = Number(uno(`select public.costo_sku(${idP15}, current_date) c`).c);
ok(Math.abs(conBolsa - sinBolsa - 1.50) < 0.001,
   `C15 la receta ya cuesta 1.50 más: ${sinBolsa} → ${conBolsa}`);

const idOrd15 = Number(uno(`insert into ordenes (consecutivo, estatus_pedido, tipo_interno)
   values ('ZZ-COSTEO-' || substr(md5(random()::text),1,6), 'Pendiente', 'prueba') returning id`).id);
// La línea se escribe COMO LA ESCRIBE LA APP: por pieza y con los gramos de su
// presentación puestos, que es el dato que engañaba al disparador (regla 55).
const pz15 = uno(`insert into ordenes_detalle
   (id_orden, id_producto, cantidad, gramos_vendidos, subtotal, tipo_venta, presentacion)
   values (${idOrd15}, '${idP15}', 1, 100, 32, 'Por Pieza', '100g')
   returning costo_unitario::numeric cu`);
ok(Math.abs(Number(pz15.cu) - conBolsa) < 0.001,
   `C15 la pieza costó ${pz15.cu}: pasó por la receta y LLEVA la bolsa`);
ok(Number(pz15.cu) > sinBolsa + 1.0,
   'C15 con el disparador viejo habría costado ' + sinBolsa + ' y la bolsa se habría perdido');

const idGr15 = Number(uno(`select p.id from productos p
   where p.activo and coalesce(p.gramos,0) = 0 limit 1`).id || 0);
if (idGr15) {
  const gr15 = uno(`insert into ordenes_detalle
     (id_orden, id_producto, cantidad, gramos_vendidos, subtotal, tipo_venta, presentacion)
     values (${idOrd15}, '${idGr15}', 1, 100, 32, 'A granel', 'Granel')
     returning costo_unitario::numeric cu`);
  ok(Math.abs(Number(gr15.cu) - costoHoy * 0.1) < 0.01,
     `C15 y 100 g a granel siguen en ${gr15.cu}: base pura, SIN bolsa`);
  ok(Number(pz15.cu) > Number(gr15.cu) + 1.0,
     'C15 el mismo peso cuesta más en bolsa que a granel, que es la verdad');
} else {
  ok(false, 'C15 no hay producto a granel en staging para contrastar');
}

sql(`delete from receta_lineas where id_insumo = ${idBolsa15}`);
sql(`delete from ordenes_detalle where id_orden = ${idOrd15}; delete from ordenes where id = ${idOrd15}`);
ok(Number(uno(`select public.costo_sku(${idP15}, current_date) c`).c) === sinBolsa,
   'C15 limpieza: la receta volvió a su costo de antes');

// ── Limpieza: el fixture no se queda en staging ──────────────────────────────
barrer();
const resto = Number(uno(`select count(*) n from insumos where nombre like 'ZZ-prueba-costeo%'`).n);
ok(resto === 0, `Limpieza: no quedó ningún insumo de prueba en staging (${resto})`);

console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
