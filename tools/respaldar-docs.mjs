#!/usr/bin/env node
// tools/respaldar-docs.mjs — Copia los documentos internos al repo PRIVADO.
//
// Los cuatro archivos viven en esta carpeta, que es donde Claude Code los lee,
// y están fuera del repositorio público a propósito. Hasta que existió el repo
// privado, existían SOLO en esta máquina: un disco que fallara se llevaba toda
// la memoria del proyecto.
//
// Uso:  node tools/respaldar-docs.mjs
//       node tools/respaldar-docs.mjs --revisar    (solo dice qué cambió)
//
// Correrlo al terminar una sesión de trabajo.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ORIGEN  = 'C:\\Proyectos\\crunchy-paps';
const DESTINO = 'C:\\Proyectos\\crunchy-paps-docs';
const DOCS    = ['PLAN.md', 'PROGRESO.md', 'ACCESOS.md', 'DESPLIEGUE.md', 'CLAUDE.md'];

const soloRevisar = process.argv.includes('--revisar');

if (!existsSync(DESTINO)) {
  console.error(`No existe ${DESTINO}.`);
  console.error('Clónalo primero:  git clone https://github.com/abr-m-m/crunchy-paps-docs.git');
  process.exit(1);
}

const git = (...args) =>
  execFileSync('git', args, { cwd: DESTINO, encoding: 'utf8' }).trim();

// Salvaguarda: si el repo de destino no fuera privado, esto publicaría el
// inventario de seguridad y la bitácora de vulnerabilidades.
try {
  const url = git('remote', 'get-url', 'origin');
  if (!url.includes('crunchy-paps-docs')) {
    console.error('ABORTADO: el remoto de destino no es crunchy-paps-docs.');
    console.error('  ' + url);
    process.exit(1);
  }
} catch {
  console.error('ABORTADO: el destino no tiene remoto configurado.');
  process.exit(1);
}

let copiados = 0;
const cambios = [];
for (const doc of DOCS) {
  const origen = join(ORIGEN, doc);
  if (!existsSync(origen)) { console.log(`  ${doc.padEnd(16)} no está en el origen, se omite`); continue; }
  const nuevo = readFileSync(origen);
  const destino = join(DESTINO, doc);
  const viejo = existsSync(destino) ? readFileSync(destino) : null;
  if (viejo && viejo.equals(nuevo)) { console.log(`  ${doc.padEnd(16)} sin cambios`); continue; }
  const lineas = nuevo.toString('utf8').split('\n').length;
  const antes  = viejo ? viejo.toString('utf8').split('\n').length : 0;
  const delta  = viejo ? (lineas - antes >= 0 ? '+' : '') + (lineas - antes) : 'nuevo';
  cambios.push(`${doc} (${delta} líneas)`);
  console.log(`  ${doc.padEnd(16)} ${delta} líneas`);
  if (!soloRevisar) { writeFileSync(destino, nuevo); copiados++; }
}

if (!cambios.length) { console.log('\n  Todo al día. Nada que respaldar.'); process.exit(0); }
if (soloRevisar)     { console.log(`\n  ${cambios.length} archivo(s) cambiarían. Corre sin --revisar para subirlos.`); process.exit(0); }

git('add', '-A');
// Fecha LOCAL (CDMX), no UTC. `toISOString()` fechaba los respaldos hechos de
// noche en el día siguiente: así nacieron los "Respaldo 2026-09-02" de commits
// del 1 de septiembre, y de ahí los encabezados equivocados de PROGRESO.md.
const d = new Date();
const fecha = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
git('-c', 'user.email=abraham.mmora@gmail.com', '-c', 'user.name=Abraham',
    'commit', '-q', '-m', `Respaldo ${fecha}: ${cambios.join(', ')}`);
execFileSync('git', ['push', '-q'], { cwd: DESTINO, stdio: 'inherit' });

console.log(`\n  ${copiados} archivo(s) respaldados y subidos a crunchy-paps-docs (privado).`);
