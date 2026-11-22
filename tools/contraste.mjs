#!/usr/bin/env node
// tools/contraste.mjs — La regla de color de Abraham, convertida en una prueba.
//
// Uso:  node tools/contraste.mjs          (falla si hay pares ilegibles)
//       node tools/contraste.mjs --todo   (lista tambien los que pasan)
//
// LA REGLA, dicha por Abraham el 23 nov 2026:
//   «Si el fondo es oscuro, no usar color de letra oscura: blanco o amarillo.
//    Si el fondo es blanco, no usar amarillo porque tampoco se distingue.»
//
// POR QUE EXISTE ESTE ARCHIVO. Esa regla la estuve comprobando MIRANDO, y por
// eso se escaparon cuatro fugas en una sola pantalla: el antetitulo
// «VENDEDOR» y el nombre del saludo en amarillo (1.29:1), la insignia del
// vendedor en claro sobre amarillo (1.45:1), y el «+» del contador que salia
// gris. Las cuatro las vio Abraham o las vi yo en una captura, ninguna
// leyendo el codigo. Con 86 pantallas por convertir, mirar no escala.
//
// QUE COMPRUEBA, Y QUE NO. Solo pares que estan JUNTOS en la misma
// declaracion: un bloque CSS o un style="" que fije fondo Y texto a la vez.
// Es deliberado. Un `color` cuyo fondo viene heredado de un ancestro no se
// puede resolver sin un navegador, y una herramienta que adivina produce
// ruido, y una herramienta ruidosa se ignora. Prefiero comprobar menos y que
// cada rojo sea de verdad.
//
// Y lo comprueba EN LAS DOS PIELES: resuelve los var(--x) con los tokens de
// `:root` y otra vez con los de `body.piel-clara`. Un par puede ser legible
// en oscuro e ilegible en claro -justo lo que paso con --negro, que se
// invierte-, y asi no hace falta acordarse.

import { readFileSync } from 'node:fs';

const ARCHIVOS = ['index.html', 'src/estilos.css', 'src/app.js', 'src/panel.js'];
const MINIMO = 4.5;          // AA para texto normal
const MINIMO_GRANDE = 3.0;   // AA para >=24px o >=18.66px en negrita

// ── Color ──────────────────────────────────────────────────────────────────
const NOMBRES = { white: '#ffffff', black: '#000000', transparent: null, inherit: null, currentcolor: null };

function aRGB(c) {
  if (!c) return null;
  c = c.trim().toLowerCase();
  if (c in NOMBRES) return NOMBRES[c] ? aRGB(NOMBRES[c]) : null;
  const rgba = c.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (rgba) return [+rgba[1], +rgba[2], +rgba[3]];
  let h = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!h) return null;
  h = h[1];
  if (h.length === 3) h = [...h].map((x) => x + x).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function luminancia([r, g, b]) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contraste(a, b) {
  const la = luminancia(a), lb = luminancia(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ── Tokens: se leen del CSS, no se copian aqui (regla 63) ──────────────────
function leerTokens(css, selector) {
  const i = css.indexOf(selector);
  if (i < 0) return {};
  const ini = css.indexOf('{', i), fin = css.indexOf('}', ini);
  const tokens = {};
  for (const m of css.slice(ini, fin).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens[m[1]] = m[2].trim();
  }
  return tokens;
}

function resolver(valor, tokens, saltos = 0) {
  if (!valor || saltos > 6) return null;
  const v = valor.trim();
  const m = v.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]+))?\)$/i);
  if (m) {
    const t = tokens[m[1]];
    if (t !== undefined) return resolver(t, tokens, saltos + 1);
    return m[2] ? resolver(m[2], tokens, saltos + 1) : null;
  }
  return aRGB(v);
}

// ── Extraer los pares que SI estan juntos ──────────────────────────────────
const RE_FONDO = /(?:^|[;{\s])background(?:-color)?\s*:\s*([^;{}]+)/i;
const RE_TEXTO = /(?:^|[;{\s])color\s*:\s*([^;{}]+)/i;
const RE_GRANDE = /font-size\s*:\s*(?:([2-9]\d|\d{3})px|([1-9]\d*(?:\.\d+)?)rem)/i;

function esGrande(decl) {
  const m = decl.match(RE_GRANDE);
  if (!m) return false;
  if (m[1]) return +m[1] >= 24;
  return +m[2] >= 1.5;   // 1.5rem = 24px
}

function paresDe(texto, archivo) {
  const pares = [];
  const empuja = (decl, donde) => {
    const f = decl.match(RE_FONDO), t = decl.match(RE_TEXTO);
    if (!f || !t) return;
    if (/gradient/i.test(f[1])) return;   // un degradado no tiene UN color
    pares.push({ archivo, donde, fondo: f[1].trim(), texto: t[1].trim(), grande: esGrande(decl) });
  };
  // Bloques CSS: `selector { ... }`
  for (const m of texto.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().split('\n').pop().trim();
    if (sel.startsWith('@') || sel.startsWith(':root') || sel.includes('piel-clara')) continue;
    empuja(m[2], sel.slice(0, 70));
  }
  // Estilos en linea: style="..." y style=`...`
  for (const m of texto.matchAll(/style\s*=\s*["'`]([^"'`]*)["'`]/g)) {
    const linea = texto.slice(0, m.index).split('\n').length;
    empuja(m[1], `linea ${linea}`);
  }
  return pares;
}

// ── Correr ─────────────────────────────────────────────────────────────────
const css = readFileSync('src/estilos.css', 'utf8');
const PIELES = [
  ['oscura', leerTokens(css, ':root')],
  ['clara', { ...leerTokens(css, ':root'), ...leerTokens(css, 'body.piel-clara') }],
];

const fallos = [];
let revisados = 0, sinResolver = 0;

for (const archivo of ARCHIVOS) {
  for (const p of paresDe(readFileSync(archivo, 'utf8'), archivo)) {
    for (const [piel, tokens] of PIELES) {
      const bg = resolver(p.fondo, tokens), fg = resolver(p.texto, tokens);
      if (!bg || !fg) { sinResolver++; continue; }
      revisados++;
      const r = contraste(bg, fg);
      const minimo = p.grande ? MINIMO_GRANDE : MINIMO;
      if (r < minimo) fallos.push({ ...p, piel, r: r.toFixed(2), minimo, bg, fg });
    }
  }
}

console.log(`\n  CONTRASTE — ${revisados} pares comprobados en las dos pieles`);
console.log(`  (${sinResolver} pares con un color que no se puede resolver sin navegador: no se juzgan)\n`);

if (!fallos.length) {
  console.log('  Ningun par de fondo+texto baja del minimo legible.\n');
  process.exit(0);
}

const porPiel = { oscura: [], clara: [] };
for (const f of fallos) porPiel[f.piel].push(f);
for (const piel of ['clara', 'oscura']) {
  if (!porPiel[piel].length) continue;
  console.log(`  PIEL ${piel.toUpperCase()} — ${porPiel[piel].length} pares ilegibles:`);
  for (const f of porPiel[piel]) {
    console.log(`    ${f.r}:1 (min ${f.minimo})  ${f.archivo} · ${f.donde}`);
    console.log(`              fondo ${f.fondo}  texto ${f.texto}`);
  }
  console.log('');
}
console.log('  Un texto que no se puede leer no es un detalle de estilo.\n');
process.exit(1);
