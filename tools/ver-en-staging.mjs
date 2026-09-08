#!/usr/bin/env node
// tools/ver-en-staging.mjs — Levanta la app de ESTA rama, tal como está en el
// árbol de trabajo, apuntada a STAGING. Sirve para mirar un cambio de aspecto
// antes de desplegarlo.
//
//   node tools/ver-en-staging.mjs
//   → abre http://localhost:8794
//
// Para entrar al panel (informe, caja, gastos, producción, prospección…) hay que
// identificarse como vendedor. En staging está sembrada Ana:
//   teléfono 5500000001 · PIN 1234
// Son datos falsos de staging; no existen en producción.
//
// AL ENTRAR AL PIN: la pantalla tiene SEIS casillas porque el mínimo al CAMBIAR
// el PIN es de 6. Los PIN de 4 siguen sirviendo, pero NO se autoenvían: hay que
// teclear 1234 y pulsar «Entrar». Está escrito en la propia pantalla.
//
// POR QUÉ APUNTA A STAGING Y NO A PRODUCCIÓN
// Un cambio de aspecto no toca la lógica, pero al recorrerlo se abren cajas,
// se guardan gastos y se registran lotes. Eso no se hace contra la base real solo
// para mirar colores. La llave se pide al CLI de Supabase en el momento, así que
// no hay ningún secreto escrito en el repo.
//
// NO SIRVE PARA ENSEÑÁRSELO A ALGUIEN QUE NO ESTÉ EN ESTA MÁQUINA: escucha en
// localhost. Para eso hace falta un preview de Vercel, que es otra conversación
// (y depende del secreto de bypass que sigue pendiente).

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const STAGING = 'https://dkwatbsaidlfjqjnfyrk.supabase.co';
const PUERTO = 8794;

// La llave publishable no es un secreto —viaja al navegador por diseño— pero
// tampoco se guarda en el repo: se pide al CLI, que ya tiene sesión.
let LLAVE = process.env.SUPABASE_KEY;
if (!LLAVE) {
  try {
    const out = execFileSync('supabase',
      ['projects', 'api-keys', '--project-ref', 'dkwatbsaidlfjqjnfyrk'],
      { encoding: 'utf8' });
    LLAVE = JSON.parse(out).keys.find((k) => k.type === 'publishable')?.api_key;
  } catch {
    console.error('No pude pedirle la llave de staging al CLI de Supabase.');
    console.error('Alternativa:  SUPABASE_KEY=<llave publishable> node tools/ver-en-staging.mjs');
    process.exit(1);
  }
}
if (!LLAVE) { console.error('El CLI no devolvió una llave publishable.'); process.exit(1); }

const TIPOS = { '.html': 'text/html', '.js': 'application/javascript',
                '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

createServer((req, res) => {
  const ruta = req.url.split('?')[0];
  // Vercel sirve esto por entorno; aquí se fabrica apuntando a staging.
  if (ruta === '/api/config.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end(`window.__CP_CONFIG__ = ${JSON.stringify({
      SUPABASE_URL: STAGING, SUPABASE_ANON_KEY: LLAVE, ENTORNO: 'staging' })};`);
    return;
  }
  const p = join(REPO, ruta === '/' ? 'index.html' : ruta.slice(1));
  if (!existsSync(p)) { res.writeHead(404); res.end('no existe'); return; }
  res.writeHead(200, { 'content-type': TIPOS[extname(p)] || 'text/plain' });
  res.end(readFileSync(p));
}).listen(PUERTO, () => {
  console.log(`\n  Piel clara corriendo en  http://localhost:${PUERTO}`);
  console.log('  Base: STAGING (datos falsos)\n');
  console.log('  Para ver el panel, entra como vendedora:');
  console.log('    teléfono  5500000001');
  console.log('    PIN       1234\n');
  console.log('  Ctrl+C para pararlo.\n');
});
