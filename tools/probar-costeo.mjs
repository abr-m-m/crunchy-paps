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
ok(uno(`select public.costo_base_kg('2026-05-31') c`).c === null,
   'C3 antes de que la receta exista: NULL, no 0');

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

// ── Limpieza: el fixture no se queda en staging ──────────────────────────────
barrer();
const resto = Number(uno(`select count(*) n from insumos where nombre like 'ZZ-prueba-costeo%'`).n);
ok(resto === 0, `Limpieza: no quedó ningún insumo de prueba en staging (${resto})`);

console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
