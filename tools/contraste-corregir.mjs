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
    '#ffd24d': 'var(--aviso-txt)',
    'var(--amarillo)': 'var(--aviso-txt)',
    'rgba(255,210,0,0.8)': 'var(--aviso-txt)',
    '#ffa500': 'var(--aviso-txt)',
    '#ffd699': 'var(--aviso-txt)',
  },
  'var(--ok-bg)':    { '#4caf50': 'var(--ok-txt)', '#25D366': 'var(--ok-txt)', '#7ee787': 'var(--ok-txt)' },
  // Las insignias del resumen: el tinte de estado como FONDO con el mismo
  // tinte como texto. Daban 1.08:1 -- el peor par de toda la app.
  'var(--ok-br)':    { '#7fe0a0': 'var(--ok-txt)', '#7ee787': 'var(--ok-txt)', '#4caf50': 'var(--ok-txt)' },
  'var(--aviso-br)': { '#ffd24d': 'var(--aviso-txt)', 'var(--amarillo)': 'var(--aviso-txt)' },
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

// ── El otro patron: texto de marca SIN fondo al lado ───────────────────────
// `color: var(--amarillo)` a secas no dice «amarillo»: dice «este texto
// destaca». Mientras la app era solo oscura daba igual; con la piel clara el
// mismo token cae sobre hueso y da 1.73:1 — es el «PEDIDOS RECIENTES» que no
// se lee. El token con significado es --acento-txt, que en oscuro sigue siendo
// el amarillo y en claro es tinta.
//
// Solo se toca si NO hay fondo en la misma declaracion: si lo hay, ese par ya
// lo juzga (y lo corrige) la tabla de arriba, que sabe sobre que va.
const SOSPECHA = {
  'var(--amarillo)': 'var(--acento-txt)',
  'var(--amarillo-dark)': 'var(--acento-txt)',
  // Ambar y amarillos a pelo: 32 cifras de la caja en #ffc107 sobre blanco.
  '#ffc107': 'var(--acento-txt)',
  '#ffd24d': 'var(--acento-txt)',
  '#ffd200': 'var(--acento-txt)',
  '#ffa500': 'var(--acento-txt)',
  // Grises de la paleta oscura: sobre blanco se quedan entre 3.5 y 4.5.
  '#888': 'var(--suave)',  '#888888': 'var(--suave)',
  '#777': 'var(--suave)',  '#777777': 'var(--suave)',
  '#aaa': 'var(--suave)',  '#aaaaaa': 'var(--suave)',
  '#999': 'var(--suave)',  '#999999': 'var(--suave)',
  '#666': 'var(--suave)',  '#666666': 'var(--suave)',
  // Verdes y rojos de estado.
  '#4caf50': 'var(--ok-txt)',  '#7ee787': 'var(--ok-txt)',
  '#7fe0a0': 'var(--ok-txt)',  '#25d366': 'var(--ok-txt)',
  '#ff6b6b': 'var(--error-txt)', '#ff8a8a': 'var(--error-txt)',
  '#4ab3ff': 'var(--info-txt)',
};

const SIN_FONDO = /^(transparent|none|inherit|initial|unset|rgba\([^)]*,\s*0(?:\.0+)?\s*\))$/i;
const hayFondo = (decl) => {
  const f = decl.match(RE_FONDO);
  return !!f && !SIN_FONDO.test(f[1].trim());
};

function corregirSospecha(decl) {
  if (hayFondo(decl)) return null;
  const t = decl.match(RE_TEXTO);
  if (!t) return null;
  const destino = Object.entries(SOSPECHA).find(([k]) => norma(k) === norma(t[2]))?.[1];
  if (!destino) return null;
  return decl.replace(RE_TEXTO, (_m, pre) => pre + destino);
}

// ── Tercera pasada: el color que elige JavaScript ──────────────────────────
// `st.style.color = '#4caf50'` y `color:${pct>80?'#4caf50':'#ff6b6b'}` no son
// declaraciones que se puedan leer: el color lo decide un ternario en tiempo
// de ejecucion. Ninguna prueba estatica los puede resolver — los encontro el
// auditor que corre DENTRO del navegador, midiendo el fondo real.
//
// Aqui no se parsea CSS: se mira el literal y lo que tiene DELANTE. Si la
// palabra mas cercana es `color`, es texto y se cambia; si es `background`,
// se deja -- un hex de fondo no es un problema de legibilidad, y cambiarlo
// pintaria una barra de progreso de tinta negra.
const JS_TEXTO = {
  '#4caf50': 'var(--ok-txt)',  '#7ee787': 'var(--ok-txt)',
  '#7fe0a0': 'var(--ok-txt)',  '#25D366': 'var(--ok-txt)',
  '#ff6b6b': 'var(--error-txt)', '#ff8a8a': 'var(--error-txt)',
  '#ffd24d': 'var(--acento-txt)', '#ffc107': 'var(--acento-txt)',
  '#ffa500': 'var(--acento-txt)',
  // El token de marca cuando viaja dentro de un ternario de color.
  'var(--amarillo)': 'var(--acento-txt)',
};

function corregirJS(texto) {
  let n = 0;
  const escapar = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp("(['\"])(" + Object.keys(JS_TEXTO).map(escapar).join('|') + ")\\1", 'gi');
  const fuera = texto.replace(re, (entero, comilla, hex, pos) => {
    const antes = texto.slice(Math.max(0, pos - 60), pos);
    const iColor = antes.toLowerCase().lastIndexOf('color');
    const iFondo = antes.toLowerCase().lastIndexOf('background');
    // `background-color` lleva las dos: gana la que empieza, no la que acaba.
    if (iColor < 0 || iFondo > iColor - 'background-'.length) return entero;
    if (iColor > 0 && antes[iColor - 1] === '-') return entero;   // border-color, outline-color
    const destino = Object.entries(JS_TEXTO)
      .find(([k]) => k.toLowerCase() === hex.toLowerCase())?.[1];
    if (!destino) return entero;
    n++;
    return comilla + destino + comilla;
  });
  return { texto: fuera, n };
}

let total = 0;
const detalle = {};
for (const archivo of ARCHIVOS) {
  let s = readFileSync(archivo, 'utf8');
  let n = 0;
  const reemplazar = (re) => {
    s = s.replace(re, (entero, cuerpo, ...resto) => {
      const nuevo = corregirDecl(cuerpo) ?? corregirSospecha(cuerpo);
      if (!nuevo) return entero;
      n++;
      return entero.replace(cuerpo, nuevo);
    });
  };
  reemplazar(/\{([^{}]*)\}/g);                       // bloques CSS

  // Las dos formas por separado: un `style="..."` puede llevar comillas SIMPLES
  // dentro (`font-family:'Inter'`), y una sola clase ["'`] para abrir y cerrar
  // las daba por invisibles. Eran 30 botones del panel.
  reemplazar(/style\s*=\s*"([^"]*)"/g);
  reemplazar(/style\s*=\s*'([^']*)'/g);
  const js = corregirJS(s);
  s = js.texto; n += js.n;
  if (n && !SECO) writeFileSync(archivo, s, 'utf8');
  detalle[archivo] = n;
  total += n;
}

console.log(`\n  ${SECO ? 'HARIA' : 'HECHO'} — ${total} textos pasados a un token con significado\n`);
for (const [a, n] of Object.entries(detalle)) console.log(`    ${a.padEnd(18)} ${n}`);
console.log('');
