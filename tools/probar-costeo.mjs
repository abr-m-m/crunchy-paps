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

// ── Fixture: un insumo con TRES costos vigentes en fechas distintas ──────────
const idPapa = Number(uno(`insert into insumos (nombre, unidad, activo, tipo)
  values ('Papa prueba ${sufijo}', 'kg', true, 'materia_prima') returning id`).id);
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

// ── Limpieza: el fixture no se queda en staging ──────────────────────────────
sql(`delete from insumos_costos where id_insumo = ${idPapa}; delete from insumos where id = ${idPapa}`);
console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
