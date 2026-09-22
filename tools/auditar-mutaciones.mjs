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
//   3. ¿La llama la app? (index.html, src/, public/*.html y api/*.js)
//
// Una función que escribe, no comprueba nada y ES alcanzable por PostgREST es
// una mutación abierta: cualquiera con la llave anon la ejecuta. Así se
// encontró el hallazgo 20 (cambiar_pin_vendedor).
//
// ⚠️ LIMITACIÓN: lee un ARCHIVO de esquema, no la base viva. Después de
// aplicar migraciones, el reporte queda desactualizado hasta que se haga un
// `supabase db pull` nuevo. Para el estado real de los permisos, la consulta
// autorizada es:
//   select proname, has_function_privilege('anon', oid, 'execute')
//     from pg_proc where pronamespace = 'public'::regnamespace;
//
// Uso:  node tools/auditar-mutaciones.mjs [ruta/al/esquema.sql]

import { readFileSync, readdirSync } from 'node:fs';
import { HTML, APP, PANEL, leer } from './fuentes.mjs';

const rutaEsquema = process.argv[2] ||
  'supabase/migrations/20260830203059_remote_schema.sql';

const sql = readFileSync(rutaEsquema, 'utf8');

// ── ¿Quién llama a cada función? ───────────────────────────────────────────
// Esto se le preguntaba a index.html, que desde Vite (20 sep 2026) ya casi no
// tiene JS, y encima dentro de un try/catch que dejaba `app = ''`: TODAS las
// funciones salían como «no la llama nadie». Un falso «nadie la llama» aquí no
// es ruido, es el peor error posible: alimenta la lista de «se pueden blindar
// sin desplegar la app» y manda a cerrar una puerta que la app sí usa.
//
// Se leen TODAS las superficies que hablan con PostgREST, y sin try/catch: si
// una falta, esto tiene que romperse, no aprobar con ''.
//   index.html      los <script> clásicos (la pantalla de PIN/OTP)
//   src/app.js      supabaseCall('POST', 'rpc/x', …)
//   src/panel.js    ídem
//   public/*.html   páginas sueltas (retos, planeador): llaman con rpc('x')
//   api/*.js        funciones de Vercel (OTP, ticket, imagen de retos)
const deCarpeta = (dir, ext) => readdirSync(new URL('../' + dir, import.meta.url))
  .filter((f) => f.endsWith(ext)).map((f) => leer(dir + f));
const FUENTES = [HTML, APP, PANEL, ...deCarpeta('public/', '.html'), ...deCarpeta('api/', '.js')].join('\n');

// Dos maneras de nombrar la misma función: 'rpc/x' (supabaseCall y los fetch
// directos) y rpc('x') (el ayudante de las páginas de public/).
// Un nombre que es prefijo de otro (crear_pedido / crear_pedido_interno) puede
// darse por llamado de más. Es el lado seguro del error: acorta la lista de las
// que "se pueden blindar", no la alarga.
const laLlamaLaApp = (n) => FUENTES.includes('rpc/' + n) ||
  FUENTES.includes("rpc('" + n + "'") || FUENTES.includes('rpc("' + n + '"');

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
  const usadaPorApp = laLlamaLaApp(f.nombre);
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
  console.log(`\n💡 ${faciles.length} de esas no las llama NADIE: ni index.html, ni src/, ni public/, ni api/.`);
  console.log(`   Se pueden blindar sin desplegar la app, como se hizo con cambiar_pin_vendedor:`);
  console.log(`   ${faciles.map((f) => f.nombre).join(', ')}`);
}

console.log('');
process.exit(abiertas.length ? 1 : 0);
