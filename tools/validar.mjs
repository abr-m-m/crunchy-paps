#!/usr/bin/env node
// tools/validar.mjs — Reemplaza el ritual manual de CLAUDE.md §3.
// Uso:  node tools/validar.mjs [ruta/al/index.html]
// Sale con código 1 si algo falla, para poder usarse en CI o en un hook de git.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const archivo = process.argv[2] || 'index.html';
const src = readFileSync(archivo, 'utf8');
const fallos = [];
const ok = [];

// ── 1. Balance de <div> ────────────────────────────────────────────
const abre  = (src.match(/<div\b/gi)  || []).length;
const cierra = (src.match(/<\/div>/gi) || []).length;
if (abre === cierra) ok.push(`Balance de <div>: ${abre}/${cierra}`);
else fallos.push(`Balance de <div>: ${abre} abren, ${cierra} cierran (difieren en ${Math.abs(abre - cierra)})`);

// ── 2. Balance de otras etiquetas que suelen romperse ──────────────
for (const tag of ['section', 'span', 'button', 'form', 'table', 'select', 'textarea']) {
  const a = (src.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length;
  const c = (src.match(new RegExp(`</${tag}>`, 'gi')) || []).length;
  if (a !== c) fallos.push(`Balance de <${tag}>: ${a} abren, ${c} cierran`);
}
if (!fallos.some(f => f.startsWith('Balance de <') && !f.includes('<div>'))) {
  ok.push('Balance de section/span/button/form/table/select/textarea');
}

// ── 3. Sintaxis de cada bloque <script> ────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'cp-validar-'));
const bloques = [...src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
let n = 0, revisados = 0;

for (const [, attrs, cuerpo] of bloques) {
  n++;
  if (/\bsrc\s*=/.test(attrs)) continue;              // script externo, nada que revisar
  if (/type\s*=\s*["'](?!module|text\/javascript)/i.test(attrs)) continue; // json-ld, plantillas, etc.
  if (!cuerpo.trim()) continue;

  const esModulo = /type\s*=\s*["']module["']/i.test(attrs);
  const ruta = join(tmp, `bloque-${n}.${esModulo ? 'mjs' : 'js'}`);
  writeFileSync(ruta, cuerpo, 'utf8');
  revisados++;
  try {
    execFileSync(process.execPath, ['--check', ruta], { stdio: 'pipe' });
    ok.push(`Sintaxis del bloque ${n} (${esModulo ? 'module' : 'clásico'}, ${cuerpo.split('\n').length} líneas)`);
  } catch (e) {
    const msg = (e.stderr?.toString() || e.message)
      .split('\n').filter(l => l.trim()).slice(0, 4).join('\n    ');
    fallos.push(`Sintaxis del bloque ${n} (${esModulo ? 'module' : 'clásico'}):\n    ${msg}`);
  }
}
rmSync(tmp, { recursive: true, force: true });

// ── 4. Reporte ─────────────────────────────────────────────────────
const total = src.split('\n').length;
console.log(`\nValidando ${archivo} — ${total.toLocaleString('es-MX')} líneas, ${bloques.length} bloques <script> (${revisados} revisados)\n`);
for (const o of ok) console.log(`  ok    ${o}`);
for (const f of fallos) console.log(`  FALLA ${f}`);
console.log(fallos.length ? `\n${fallos.length} problema(s). No desplegar.\n` : `\nTodo en orden.\n`);
process.exit(fallos.length ? 1 : 0);
