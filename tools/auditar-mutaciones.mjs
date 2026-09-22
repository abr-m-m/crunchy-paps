#!/usr/bin/env node
// tools/auditar-mutaciones.mjs — Audita qué funciones de la base ESCRIBEN,
// cuáles de esas comprueban alguna credencial, y cuáles son alcanzables de
// verdad con la llave pública.
//
// Para cada función de `public` responde cuatro preguntas:
//
//   1. ¿Escribe? (INSERT / UPDATE / DELETE sobre tablas de negocio)
//   2. ¿Es alcanzable? (¿anon o authenticated tienen EXECUTE?)
//   3. ¿Comprueba algo? (token de sesión, funciones de sesión, PIN comparado)
//   4. ¿La llama la app? (index.html, src/, public/*.html y api/*.js)
//
// Una función que escribe, no comprueba nada y ES alcanzable por PostgREST es
// una mutación abierta: cualquiera con la llave publishable la ejecuta. Así se
// encontró el hallazgo 20 (cambiar_pin_vendedor).
//
// ── POR QUÉ PREGUNTA A LA BASE VIVA (21 sep 2026) ──────────────────────────
// Hasta hoy leía un VOLCADO del esquema, `*_remote_schema.sql`. El volcado que
// usaba era del 30 ago 2026 y ahí seguían los `GRANT ALL … TO anon` de
// entonces, revocados después. El reporte acusaba de abiertas a seis funciones
// que hoy solo puede ejecutar `service_role`, y la lista de «se pueden blindar»
// mandaba a cerrar puertas que ya estaban cerradas. La limitación estaba escrita
// en esta misma cabecera y aun así el reporte se leyó como el estado de hoy.
//
// Ahora se le pregunta a `pg_proc` y a `has_function_privilege`. El modo archivo
// se quitó a propósito: mientras exista, alguien lo va a correr.
//
// Uso:
//   node tools/auditar-mutaciones.mjs              → PRODUCCIÓN (xbyzarzyxiugrucyjwfn)
//   node tools/auditar-mutaciones.mjs --staging    → staging (dkwatbsaidlfjqjnfyrk)
//
// Es SOLO LECTURA: una consulta a los catálogos, ni una escritura.

import { readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HTML, APP, PANEL, leer } from './fuentes.mjs';

const PROD = 'xbyzarzyxiugrucyjwfn';
const STG  = 'dkwatbsaidlfjqjnfyrk';
const REF  = process.argv.includes('--staging') ? STG : PROD;

// ── La base viva ───────────────────────────────────────────────────────────
// Mismo ayudante que probar-vencimiento.mjs y probar-retos.mjs. Sin try/catch:
// si el CLI no contesta, esto se rompe. Un reporte de seguridad que se degrada
// en silencio es peor que no tenerlo.
// maxBuffer explícito: los cuerpos de ~200 funciones pasan del megabyte que
// execSync trae por omisión, y ahí la salida no se trunca, revienta.
const dir = mkdtempSync(join(tmpdir(), 'auditar-'));
const sql = (q) => {
  const f = join(dir, 'q.sql');
  writeFileSync(f, q);
  const out = execSync(`supabase db query --linked --project-ref ${REF} -o json --file "${f}"`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.slice(out.indexOf('{'))).rows || [];
};

// `prosrc` es el CUERPO, sin la firma; por eso «es trigger» y los permisos
// vienen como columnas y no se adivinan del texto.
const funciones = sql(`
  select p.proname                                          as nombre,
         pg_get_function_identity_arguments(p.oid)          as args,
         p.prosrc                                           as cuerpo,
         p.prorettype = 'trigger'::regtype                  as trigger,
         has_function_privilege('anon', p.oid, 'execute')          as anon,
         has_function_privilege('authenticated', p.oid, 'execute') as auth
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
   order by p.proname
`);

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
const deCarpeta = (carpeta, ext) => readdirSync(new URL('../' + carpeta, import.meta.url))
  .filter((f) => f.endsWith(ext)).map((f) => leer(carpeta + f));
const FUENTES = [HTML, APP, PANEL, ...deCarpeta('public/', '.html'), ...deCarpeta('api/', '.js')].join('\n');

// Dos maneras de nombrar la misma función: 'rpc/x' (supabaseCall y los fetch
// directos) y rpc('x') (el ayudante de las páginas de public/).
// Un nombre que es prefijo de otro (crear_pedido / crear_pedido_interno) puede
// darse por llamado de más. Es el lado seguro del error: acorta la lista de las
// que "se pueden blindar", no la alarga.
const laLlamaLaApp = (n) => FUENTES.includes('rpc/' + n) ||
  FUENTES.includes("rpc('" + n + "'") || FUENTES.includes('rpc("' + n + '"');

// ── Clasificación ──────────────────────────────────────────────────────────
// El nombre de la tabla puede venir calificado con el esquema, y con comillas:
//   update public.clientes set …      update "public"."clientes" set …
// La primera versión de este patrón no aceptaba el punto ([a-z_"]+), así que
// TODO UPDATE que nombrara el esquema era invisible: la función no contaba
// como escritura y desaparecía del reporte ENTERO, ni roja ni verde. Ocho
// funciones alcanzables por anon se caían por ahí, entre ellas
// fn_reconciliar_pedido y set_ubicacion_cliente. Se vio al hacer la misma
// pregunta en SQL, donde el patrón sí aceptaba el punto, y dar otro número:
// una herramienta sola no se puede auditar a sí misma (regla 58).
const ESCRIBE = /\b(insert\s+into|update\s+(?:only\s+)?[a-z0-9_."]+\s+set|delete\s+from)\b/i;

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

// Lo que NO se hizo: meter `->>'token'` y `sesion_es_dueno` en COMPRUEBA.
// Habría vaciado la lista roja de golpe, y también habría absuelto a cualquiera
// que mencione la palabra «token» en un comentario. Un patrón de seguridad que
// se amplía absuelve; el error se va al lado cómodo, que es justo cómo llegamos
// hasta aquí. Van en un tercer cubo, AMARILLO, que dice «míralo a mano».
const SOSPECHA = /token|sesion_es_dueno|\bes_dueno\b|resolver_sesion_cliente/i;

const filas = funciones.map((f) => {
  const escribe = ESCRIBE.test(f.cuerpo);
  const comprueba = COMPRUEBA.test(f.cuerpo);
  const sospecha = SOSPECHA.test(f.cuerpo);
  // Un trigger no es alcanzable por PostgREST: lo invoca la tabla, no una
  // petición. Los permisos de anon sobre él son irrelevantes.
  const alcanzable = !f.trigger && (f.anon || f.auth);
  const tablas = [...new Set(
    // El grupo opcional se come el esquema, para que la columna diga «clientes»
    // y no «public», que es lo que imprimía con los UPDATE calificados.
    [...f.cuerpo.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+(?:only\s+)?"?(?:[a-z0-9_]+"?\."?)?([a-z0-9_]+)"?/gi)]
      .map((x) => x[1].toLowerCase())
      .filter((t) => !['set', 'from', 'into', 'only'].includes(t))
  )];
  return { ...f, escribe, comprueba, sospecha, alcanzable, usadaPorApp: laLlamaLaApp(f.nombre), tablas };
});

const mutaciones = filas.filter((f) => f.escribe && !f.trigger);
const expuestas  = mutaciones.filter((f) => f.alcanzable && !f.comprueba);
const rojas      = expuestas.filter((f) => !f.sospecha);
const amarillas  = expuestas.filter((f) => f.sospecha);
const verdes     = mutaciones.filter((f) => !f.alcanzable || f.comprueba);

// ── Calibrar antes de creerle ──────────────────────────────────────────────
// Regla 60: una herramienta de medición se calibra contra un hecho ya sabido
// antes de creerle. Se calibra el INSTRUMENTO, no la política: cada punto de
// abajo es una propiedad que, si falla, significa que el clasificador está
// roto — no que alguien cambió un permiso a propósito.
//
// La primera versión de esta calibración solo miraba cambiar_pin_vendedor, y
// no cazó nada: al romper a mano dos de los cinco patrones de COMPRUEBA siguió
// diciendo «ok», porque a esa función la salvaba un tercer patrón. Mientras
// tanto crear_pedido y aplicar_cupon se habían caído a amarillo sin que nadie
// se enterara. Una calibración de un solo punto no calibra: confirma.
const problemas = [];
const busca = (n) => filas.find((f) => f.nombre === n);
const exige = (n, prop, esperado, porque) => {
  const f = busca(n);
  if (!f) { problemas.push(`no encontré ${n}`); return; }
  if (f[prop] !== esperado) problemas.push(`${n}.${prop} = ${f[prop]}, esperaba ${esperado} — ${porque}`);
};

// 1. La consulta trajo algo parecido a la base entera.
if (funciones.length < 50) problemas.push(`solo ${funciones.length} funciones: la consulta volvió casi vacía`);
if (mutaciones.length < 20) problemas.push(`solo ${mutaciones.length} escrituras: el patrón ESCRIBE se encogió`);

// 2. La columna de permisos VARÍA. Si sale constante, miente en algún sentido
//    y todo el reporte se va con ella.
if (!filas.some((f) => f.alcanzable)) problemas.push('ninguna función sale alcanzable: los permisos vienen en blanco');
if (!filas.some((f) => !f.alcanzable)) problemas.push('TODAS salen alcanzables: los permisos vienen en blanco');

// 3. Dos comprobaciones reconocidas que no pueden dejar de reconocerse:
//    cambiar_pin_vendedor compara el PIN (hallazgo 20, migración 20260901040000)
//    y crear_pedido resuelve sesión. Cubren dos patrones distintos de COMPRUEBA.
exige('cambiar_pin_vendedor', 'alcanzable', true, 'tiene anon y nunca se le revocó');
exige('cambiar_pin_vendedor', 'comprueba', true, 'compara el PIN desde la migración del hallazgo 20');
exige('crear_pedido', 'comprueba', true, 'resuelve la sesión del cliente');

// 4. La cicatriz del 21 sep 2026: set_ubicacion_cliente escribe con
//    `update public.clientes set`, calificado con el esquema. El patrón ESCRIBE
//    no aceptaba el punto y esta función —y otras siete alcanzables por anon—
//    desaparecían del reporte entero, ni rojas ni verdes.
exige('set_ubicacion_cliente', 'escribe', true, 'escribe con el esquema calificado; si falla, ESCRIBE volvió a no aceptar el punto');
if (problemas.length) {
  console.error(`\n❌ La herramienta no pasó su propia calibración contra ${REF}:`);
  for (const p of problemas) console.error('   · ' + p);
  console.error('\nNo te fíes del reporte hasta arreglar esto.\n');
  process.exit(2);
}

// ── Reporte ────────────────────────────────────────────────────────────────
const entorno = REF === PROD ? 'PRODUCCIÓN' : 'staging';
console.log(`\nAuditoría de mutaciones — base viva de ${entorno} (${REF})`);
console.log(`${funciones.length} funciones · ${mutaciones.length} escriben (sin contar triggers) · calibración ok\n`);

const tabla = (lista) => {
  console.log(`  ${'FUNCIÓN'.padEnd(34)} ${'APP'.padEnd(5)} ESCRIBE EN`);
  console.log(`  ${'-'.repeat(34)} ${'-'.repeat(5)} ${'-'.repeat(40)}`);
  for (const f of lista.sort((a, b) => a.nombre.localeCompare(b.nombre))) {
    console.log(`  ${f.nombre.padEnd(34)} ${(f.usadaPorApp ? 'sí' : 'NO').padEnd(5)} ${f.tablas.slice(0, 4).join(', ')}`);
  }
};

console.log(`🔴 ALCANZABLES, ESCRIBEN Y SIN NINGUNA SEÑAL DE CREDENCIAL: ${rojas.length}\n`);
tabla(rojas);

console.log(`\n🟡 ALCANZABLES Y ESCRIBEN; nombran token o un guardia, pero el patrón no lo confirma: ${amarillas.length}`);
console.log(`   No están absueltas: hay que LEERLAS. El patrón no se amplió a propósito.\n`);
tabla(amarillas);

console.log(`\n✅ CON COMPROBACIÓN RECONOCIDA O FUERA DEL ALCANCE DE LA LLAVE PÚBLICA: ${verdes.length}`);
console.log(`   ${verdes.filter((f) => !f.alcanzable).length} de ellas ni siquiera son alcanzables (solo service_role).`);

// Las que NO usa la app son las más fáciles de blindar: no rompen pantallas.
const faciles = rojas.filter((f) => !f.usadaPorApp);
if (faciles.length) {
  console.log(`\n💡 ${faciles.length} de las rojas no las llama NADIE: ni index.html, ni src/, ni public/, ni api/.`);
  console.log(`   Se pueden blindar sin desplegar la app, como se hizo con cambiar_pin_vendedor:`);
  console.log(`   ${faciles.map((f) => f.nombre).join(', ')}`);
}

console.log('');
process.exit(rojas.length ? 1 : 0);
