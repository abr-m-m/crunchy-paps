#!/usr/bin/env node
// tools/auditar-mutaciones.mjs — Audita qué funciones de la base ESCRIBEN y
// cuáles de esas comprueban alguna credencial.
//
// Lee el volcado del esquema (supabase/migrations/*_remote_schema.sql) y, para
// cada función, responde tres preguntas:
//
//   1. ¿Escribe? (INSERT / UPDATE / DELETE sobre tablas de negocio)
//   2. ¿Comprueba algo? (PIN con crypt, token de sesión, o llamada a las
//      funciones de sesión de la Etapa B)
//   3. ¿La llama la app? (grep en index.html)
//
// Una función que escribe, no comprueba nada y ES alcanzable por PostgREST es
// una mutación abierta: cualquiera con la llave anon la ejecuta. Así se
// encontró el hallazgo 20 (cambiar_pin_vendedor).
//
// Uso:  node tools/auditar-mutaciones.mjs [ruta/al/esquema.sql]

import { readFileSync } from 'node:fs';

const rutaEsquema = process.argv[2] ||
  'supabase/migrations/20260830203059_remote_schema.sql';

const sql = readFileSync(rutaEsquema, 'utf8');
let app = '';
try { app = readFileSync('index.html', 'utf8'); } catch (_e) { app = ''; }

// ── Trocear el volcado en funciones ────────────────────────────────────────
// Los cuerpos vienen entre $$ ... $$; que es como los escribe pg_dump.
const re = /CREATE OR REPLACE FUNCTION "public"\."([a-z0-9_]+)"\(([^)]*)\)[\s\S]*?\n\$\$;/gi;
const funciones = [];
let m;
while ((m = re.exec(sql)) !== null) {
  funciones.push({ nombre: m[1], args: m[2], cuerpo: m[0] });
}

// ── Clasificación ──────────────────────────────────────────────────────────
const ESCRIBE = /\b(insert\s+into|update\s+[a-z_"]+\s+set|delete\s+from)\b/i;

// OJO — la primera versión de esta heurística daba `crypt(` por buena, y por eso
// marcaba `cambiar_pin_vendedor` como protegida: justo la función con el peor
// agujero del proyecto. Usaba crypt para ESCRIBIR el hash nuevo, no para
// verificar nada. Presencia de crypt != comprobación.
//
// Verificar es COMPARAR contra el hash guardado (`hash <> crypt(...)`) o
// resolver una sesión. Escribir es `SET pin_hash = crypt(...)`.
const COMPRUEBA = new RegExp([
  'resolver_sesion_vendedor',
  'sesion_exige_seccion',
  'sesion_secciones',
  '\\bp_token\\b',
  '[<>!]=?\\s*crypt\\s*\\(',        // comparación: hash <> crypt(...)
].join('|'), 'i');

// Los triggers no son alcanzables por PostgREST: reciben NEW/OLD.
// pg_dump los escribe como RETURNS "trigger", con comillas.
const ES_TRIGGER = (f) => /returns\s+"?trigger"?/i.test(f.cuerpo);

const filas = funciones.map((f) => {
  const escribe = ESCRIBE.test(f.cuerpo);
  const comprueba = COMPRUEBA.test(f.cuerpo);
  const trigger = ES_TRIGGER(f);
  const usadaPorApp = app.includes(`rpc/${f.nombre}`);
  // Qué tablas toca al escribir (aproximación por nombre)
  const tablas = [...new Set(
    [...f.cuerpo.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+"?([a-z_]+)"?/gi)]
      .map((x) => x[1].toLowerCase())
      .filter((t) => !['set', 'from', 'into'].includes(t))
  )];
  return { ...f, escribe, comprueba, trigger, usadaPorApp, tablas };
});

const mutaciones = filas.filter((f) => f.escribe && !f.trigger);
const abiertas = mutaciones.filter((f) => !f.comprueba);
const protegidas = mutaciones.filter((f) => f.comprueba);

// ── Reporte ────────────────────────────────────────────────────────────────
console.log(`\nAuditoría de mutaciones — ${rutaEsquema}`);
console.log(`${funciones.length} funciones · ${mutaciones.length} escriben (sin contar triggers)\n`);

console.log(`🔴 MUTACIONES SIN NINGUNA COMPROBACIÓN DE CREDENCIAL: ${abiertas.length}\n`);
console.log(`  ${'FUNCIÓN'.padEnd(34)} ${'APP'.padEnd(5)} ESCRIBE EN`);
console.log(`  ${'-'.repeat(34)} ${'-'.repeat(5)} ${'-'.repeat(40)}`);
for (const f of abiertas.sort((a, b) => a.nombre.localeCompare(b.nombre))) {
  console.log(`  ${f.nombre.padEnd(34)} ${(f.usadaPorApp ? 'sí' : 'NO').padEnd(5)} ${f.tablas.slice(0, 4).join(', ')}`);
}

console.log(`\n✅ CON ALGUNA COMPROBACIÓN: ${protegidas.length}`);
for (const f of protegidas.sort((a, b) => a.nombre.localeCompare(b.nombre))) {
  console.log(`  ${f.nombre}`);
}

// Las que NO usa la app son las más fáciles de blindar: no rompen pantallas.
const faciles = abiertas.filter((f) => !f.usadaPorApp);
if (faciles.length) {
  console.log(`\n💡 ${faciles.length} de esas NO las llama index.html.`);
  console.log(`   Se pueden blindar sin desplegar la app, como se hizo con cambiar_pin_vendedor:`);
  console.log(`   ${faciles.map((f) => f.nombre).join(', ')}`);
}

console.log('');
process.exit(abiertas.length ? 1 : 0);
