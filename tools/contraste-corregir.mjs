#!/usr/bin/env node
// tools/contraste-corregir.mjs — Aplica el arreglo por PATRON, no por instancia.
//
// Uso:  node tools/contraste-corregir.mjs --seco   (dice que haria)
//       node tools/contraste-corregir.mjs          (lo hace)
//
// `tools/contraste.mjs` encontro 97 pares ilegibles en la piel clara y 54 en
// la oscura. No son 151 problemas: son unos pocos patrones repetidos, y cada
// uno tiene UNA causa. Arreglarlos a mano seria volver al ladrillo.
//
// LA CAUSA DE FONDO, y es la misma en casi todos: se estaba usando un color
// CONCRETO donde hacia falta un color con SIGNIFICADO. `color:var(--negro)`
// encima de amarillo no quiere decir «negro», quiere decir «la tinta que va
// sobre la marca» — y por eso se rompio al invertir --negro con la piel.
//
// Asi que este corrector no cambia colores: cambia un color concreto por el
// token que dice lo que ese texto ES. El token ya decide en cada piel.
//
// Solo toca pares que estan juntos en la misma declaracion, los mismos que
// `contraste.mjs` juzga. Lo que no se puede ver sin navegador, no se toca.

import { readFileSync, writeFileSync } from 'node:fs';

const SECO = process.argv.includes('--seco');
const ARCHIVOS = ['index.html', 'src/estilos.css', 'src/app.js', 'src/panel.js'];

// fondo (tal cual se escribe) → { texto que se encuentra : token que debe ir }
const REGLAS = {
  'var(--amarillo)': {
    'var(--negro)': 'var(--sobre-marca)',
    'var(--blanco)': 'var(--sobre-marca)',
    '#000': 'var(--sobre-marca)',
    '#0e0e0e': 'var(--sobre-marca)',
  },
  'var(--gris2)': { 'var(--amarillo)': 'var(--acento-txt)', 'var(--suave)': 'var(--suave2)' },
  'var(--gris)':  { 'var(--amarillo)': 'var(--acento-txt)', 'var(--suave)': 'var(--suave2)', '#ff6b6b': 'var(--error-txt)', 'var(--rojo)': 'var(--error-txt)',
                    '#666': 'var(--suave2)', '#888': 'var(--suave2)', '#555': 'var(--suave2)' },
  'var(--gris3)': { 'var(--amarillo)': 'var(--acento-txt)', 'var(--suave)': 'var(--suave2)', '#555': 'var(--suave2)',
                    '#eee': 'var(--suave2)', '#666': 'var(--suave2)', '#777': 'var(--suave2)',
                    '#888': 'var(--suave2)' },
  'var(--aviso-bg)': {
    'var(--amarillo)': 'var(--aviso-txt)',
    'rgba(255,210,0,0.8)': 'var(--aviso-txt)',
    '#ffa500': 'var(--aviso-txt)',
    '#ffd699': 'var(--aviso-txt)',
  },
  'var(--ok-bg)':    { '#4caf50': 'var(--ok-txt)', '#25D366': 'var(--ok-txt)', '#7ee787': 'var(--ok-txt)' },
  'var(--error-bg)': { 'var(--rojo)': 'var(--error-txt)', '#ff8a8a': 'var(--error-txt)', '#ff8888': 'var(--error-txt)' },
  'var(--error-br)': { 'var(--rojo)': 'var(--error-txt)', '#ff8888': 'var(--error-txt)', '#ff8a8a': 'var(--error-txt)' },
  'var(--info-bg)':  { '#4ab3ff': 'var(--info-txt)' },
  // El verde de WhatsApp con blanco da 1.98:1 en las DOS pieles: lleva anios
  // asi. Con tinta da 9.73, que es como lo pinta el propio WhatsApp.
  '#25D366':     { '#fff': 'var(--sobre-marca)', 'white': 'var(--sobre-marca)', '#ffffff': 'var(--sobre-marca)' },
  'var(--verde)':{ '#fff': 'var(--sobre-marca)', 'white': 'var(--sobre-marca)' },
  // Texto claro sobre el fondo de la app: --blanco se invierte con la piel,
  // #fff no. Por eso en claro desaparecia.
  'var(--negro)': { '#fff': 'var(--blanco)', 'white': 'var(--blanco)', '#ffffff': 'var(--blanco)' },
  // Sobre el rojo de marca el texto es blanco SIEMPRE: --blanco se invierte
  // con la piel y en claro dejaba tinta oscura sobre rojo.
  'var(--rojo)': { 'var(--blanco)': '#fff' },
  // El verde fuerte tambien pide tinta, no texto claro.
  '#4caf50': { 'var(--blanco)': 'var(--sobre-marca)', '#fff': 'var(--sobre-marca)', 'white': 'var(--sobre-marca)' },
  // Azul de sistema sobre blanco: 4.02:1. El mismo azul, un paso mas oscuro.
  '#fff':  { '#007AFF': '#0A5FC2' },
  '#ffffff': { '#007AFF': '#0A5FC2' },
};

const RE_FONDO = /(?:^|[;{\s])background(?:-color)?\s*:\s*([^;{}]+)/i;
const RE_TEXTO = /((?:^|[;{\s])color\s*:\s*)([^;{}]+)/i;

const norma = (s) => s.trim().replace(/\s+/g, '').toLowerCase();

function corregirDecl(decl) {
  const f = decl.match(RE_FONDO);
  if (!f) return null;
  const mapa = Object.entries(REGLAS).find(([k]) => norma(k) === norma(f[1]))?.[1];
  if (!mapa) return null;
  const t = decl.match(RE_TEXTO);
  if (!t) return null;
  const destino = Object.entries(mapa).find(([k]) => norma(k) === norma(t[2]))?.[1];
  if (!destino) return null;
  return decl.replace(RE_TEXTO, (_m, pre) => pre + destino);
}

let total = 0;
const detalle = {};
for (const archivo of ARCHIVOS) {
  let s = readFileSync(archivo, 'utf8');
  let n = 0;
  const reemplazar = (re) => {
    s = s.replace(re, (entero, cuerpo, ...resto) => {
      const nuevo = corregirDecl(cuerpo);
      if (!nuevo) return entero;
      n++;
      return entero.replace(cuerpo, nuevo);
    });
  };
  reemplazar(/\{([^{}]*)\}/g);                       // bloques CSS
  reemplazar(/style\s*=\s*["'`]([^"'`]*)["'`]/g);    // estilos en linea
  if (n && !SECO) writeFileSync(archivo, s, 'utf8');
  detalle[archivo] = n;
  total += n;
}

console.log(`\n  ${SECO ? 'HARIA' : 'HECHO'} — ${total} textos pasados a un token con significado\n`);
for (const [a, n] of Object.entries(detalle)) console.log(`    ${a.padEnd(18)} ${n}`);
console.log('');
