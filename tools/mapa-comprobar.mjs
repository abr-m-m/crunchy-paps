#!/usr/bin/env node
// tools/mapa-comprobar.mjs — las 8 comprobaciones de cambios/2026-09-23-mapa-visual/diseno.md §6.1.
// Un mapa sin comprobación es CLAUDE.md antes de la regla 1: empieza a mentir en la dirección
// más cómoda. Esto falla si el documento afirma algo que el árbol real no respalda.
// Uso: node tools/mapa-comprobar.mjs [docs/mapa]
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const raiz = process.argv[2] || 'docs/mapa';
const PERFILES = ['consumidor', 'tienda', 'restaurante', 'mayorista', 'vendedor', 'mostrador', 'administrador'];
const MADUREZ = ['completo', 'parcial', 'esqueleto'];
const CLASES = ['producto', 'operacion', 'datos', 'permisos', 'seguridad'];
const FRECUENCIAS = ['diario', 'semanal', 'ocasional', 'todavia-no'];
const SEVERIDADES = ['alta', 'media', 'baja'];
const ESFUERZOS = ['una-linea', 'una-migracion', 'una-sesion', 'varias-sesiones'];
const CAMPOS_PENDIENTE = ['id', 'ficha', 'clase', 'titulo', 'detalle', 'evidencia', 'hallado',
                          'impacto', 'bloquea', 'frecuencia', 'severidad', 'esfuerzo'];

const fallos = [];
const oks = [];
const mal = (m) => fallos.push(m);
const bien = (m) => oks.push(m);

// 1. Cargar los datos. Son `window.MAPA.x = {…}`, así que basta con un window de mentira.
const win = {};
const dirDatos = join(raiz, 'datos');
if (!existsSync(dirDatos)) { console.error(`No existe ${dirDatos}`); process.exit(1); }
for (const f of readdirSync(dirDatos).filter(f => f.endsWith('.js')).sort()) {
  new Function('window', readFileSync(join(dirDatos, f), 'utf8'))(win);
}
const M = win.MAPA || {};
const catalogoSecciones = (M.permisos && M.permisos.catalogo) || [];
const familias = Object.entries(M).filter(([k, v]) => v && Array.isArray(v.fichas));
const fichas = familias.flatMap(([, v]) => v.fichas);

// Los pendientes de las dos listas, juntos: una ficha puede apuntar a cualquiera.
const pendientes = [...(M.pendientes || []), ...(M.auditoria || [])];

// 2. Los ids de pantalla que existen de verdad.
const html = existsSync('index.html') ? readFileSync('index.html', 'utf8') : '';
const idsReales = new Set([...html.matchAll(/id="([a-z0-9-]+)"/g)].map(m => m[1]));

const vistos = new Set();
for (const f of fichas) {
  const q = `ficha ${f.id}`;

  if (vistos.has(f.id)) mal(`${q}: id repetido`); else vistos.add(f.id);

  if (f.tipo !== 'pagina' && html && !idsReales.has(f.id)) {
    mal(`${q}: no existe en index.html`);
  }
  if (f.seccion && catalogoSecciones.length && !catalogoSecciones.includes(f.seccion)) {
    mal(`${q}: sección "${f.seccion}" no está en el catálogo de secciones`);
  }
  for (const p of f.ven || []) if (!PERFILES.includes(p)) mal(`${q}: perfil desconocido "${p}"`);
  if (!MADUREZ.includes(f.madurez)) mal(`${q}: madurez "${f.madurez}" no es una de ${MADUREZ.join('/')}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.verificado || '')) mal(`${q}: sin fecha de verificación`);
  if (f.madurez === 'completo' && !f.entrada) mal(`${q}: madurez "completo" sin "entrada"`);

  const numeros = new Set((f.elementos || []).map(e => e.n));
  for (const c of f.capturas || []) {
    const ruta = join(raiz, c.archivo);
    if (!existsSync(ruta)) mal(`${q}: la captura ${c.archivo} no existe en disco`);
    if (c.entorno === 'produccion' && c.pii !== 'tapada' && c.pii !== 'sin-datos-personales') {
      mal(`${q}: la captura ${c.archivo} es de producción y no declara qué pasó con los datos personales`);
    }
    for (const pin of c.pines || []) {
      if (!numeros.has(pin.n)) mal(`${q}: el pin ${pin.n} de ${c.archivo} no tiene fila en elementos`);
      if (!(pin.x >= 0 && pin.x <= 1 && pin.y >= 0 && pin.y <= 1)) {
        mal(`${q}: el pin ${pin.n} tiene coordenadas fuera de 0..1`);
      }
    }
  }
  const conPin = new Set((f.capturas || []).flatMap(c => (c.pines || []).map(p => p.n)));
  for (const e of f.elementos || []) {
    if (!conPin.has(e.n)) mal(`${q}: el elemento ${e.n} no tiene pin en ninguna captura`);
    for (const r of e.reglas || []) {
      if (!Number.isInteger(r) || r < 1 || r > 62) mal(`${q}: regla ${r} fuera de 1..62`);
    }
    for (const p of e.ven || []) if (!PERFILES.includes(p)) mal(`${q}: elemento ${e.n}, perfil desconocido "${p}"`);
  }
  for (const id of f.pendientes || []) {
    if (!pendientes.some(p => p.id === id)) mal(`${q}: el pendiente ${id} no está en pendientes.js ni en auditoria.js`);
  }
  if (!fallos.some(x => x.startsWith(q))) bien(`${q} — ${(f.elementos || []).length} elementos, ${(f.pendientes || []).length} pendientes`);
}

const idsP = new Set();
for (const p of pendientes) {
  const q = `pendiente ${p.id}`;
  if (idsP.has(p.id)) mal(`${q}: id repetido`); else idsP.add(p.id);
  for (const campo of CAMPOS_PENDIENTE) {
    if (p[campo] === undefined || p[campo] === '') mal(`${q}: le falta "${campo}"`);
  }
  if (p.clase && !CLASES.includes(p.clase)) mal(`${q}: clase "${p.clase}" desconocida`);
  if (p.frecuencia && !FRECUENCIAS.includes(p.frecuencia)) mal(`${q}: frecuencia "${p.frecuencia}" desconocida`);
  if (p.severidad && !SEVERIDADES.includes(p.severidad)) mal(`${q}: severidad "${p.severidad}" desconocida`);
  if (p.esfuerzo && !ESFUERZOS.includes(p.esfuerzo)) mal(`${q}: esfuerzo "${p.esfuerzo}" desconocido`);
  if (p.estado !== undefined && p.estado !== 'abierto' && p.estado !== 'cerrado') {
    mal(`${q}: estado "${p.estado}" no es "abierto" ni "cerrado"`);
  }
  if (p.estado === 'cerrado') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.cerrado || '')) mal(`${q}: estado "cerrado" sin fecha "cerrado" válida (AAAA-MM-DD)`);
    if (!p.comoSeCerro) mal(`${q}: estado "cerrado" sin "comoSeCerro"`);
  }
  // La pregunta correcta no es «¿ya se escribió esa ficha?» (el mapa se escribe en fases, y un
  // pendiente puede apuntar legítimamente a una pantalla cuya ficha llega en una fase posterior):
  // es «¿apunta a una pantalla real de la app?». Mismo criterio que la comprobación 1 con `idsReales`,
  // y la misma excepción para `tipo: 'pagina'` (esas no están en index.html).
  if (p.ficha && html) {
    const fichaCorrespondiente = fichas.find(f => f.id === p.ficha);
    const esPagina = fichaCorrespondiente && fichaCorrespondiente.tipo === 'pagina';
    if (!esPagina && !idsReales.has(p.ficha)) {
      mal(`${q}: apunta a la ficha "${p.ficha}", que no existe en index.html`);
    }
  }
}

// Los de permisos y seguridad NO pueden estar en pendientes.js: ese archivo se publica (D8).
for (const p of M.pendientes || []) {
  if (p.clase === 'permisos' || p.clase === 'seguridad') {
    mal(`pendiente ${p.id}: clase "${p.clase}" va en auditoria.js, que no se publica`);
  }
}

console.log(`\nComprobando ${raiz} — ${fichas.length} fichas, ${pendientes.length} pendientes\n`);
for (const o of oks) console.log(`  ok    ${o}`);
for (const f of fallos) console.log(`  FALLA ${f}`);
console.log(fallos.length ? `\n${fallos.length} problema(s). El mapa miente.\n` : `\nTodo en orden.\n`);
process.exit(fallos.length ? 1 : 0);
