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

import { readFileSync, readdirSync } from 'node:fs';

const ARCHIVOS = ['index.html', 'src/estilos.css', 'src/app.js', 'src/panel.js'];

// Las pantallas de `public/` NO comparten el CSS de la app: cada una trae su
// propio `:root`. Se escaparon de esta prueba desde que nacio -y ya son cinco,
// con la consola y los precios-, asi que se juzgan tambien, pero con SUS
// tokens. Resolverlas contra src/estilos.css daria un verde falso, que es peor
// que no comprobar (regla 31: una prueba que no puede decirte si llego al
// codigo que prueba no es una prueba).
const PAGINAS = readdirSync('public')
  .filter((f) => f.endsWith('.html'))
  .map((f) => `public/${f}`);
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
  // Estilos en linea. OJO con las comillas: un `style="..."` puede llevar comillas
  // SIMPLES dentro (`font-family:'Inter'`). La primera version usaba UNA clase
  // ["'`] para abrir y para cerrar, asi que cualquier estilo con una fuente
  // entre comillas simples era INVISIBLE. Eran justo los botones del panel: 20
  // botones amarillos con letra clara (1.73:1) pasaron el CI en verde, y los
  // encontro un auditor que corre DENTRO del navegador. Esta prueba los daba por
  // buenos sin haberlos mirado nunca, que es peor que no comprobarlos (regla 31).
  for (const m of texto.matchAll(/style\s*=\s*"([^"]*)"|style\s*=\s*'([^']*)'/g)) {
    const linea = texto.slice(0, m.index).split('\n').length;
    empuja(m[1] ?? m[2], `linea ${linea}`);
  }
  return pares;
}

// ── Correr ─────────────────────────────────────────────────────────────────
const css = readFileSync('src/estilos.css', 'utf8');
const PIELES = [
  ['oscura', leerTokens(css, ':root')],
  ['clara', { ...leerTokens(css, ':root'), ...leerTokens(css, 'body.piel-clara') }],
];

// Un ambito es un grupo de archivos con los tokens que los resuelven. La app
// es uno (dos pieles, un CSS); cada pagina de `public/` es el suyo.
const AMBITOS = [{ archivos: ARCHIVOS, pieles: PIELES, propia: false }];
for (const pagina of PAGINAS) {
  const texto = readFileSync(pagina, 'utf8');
  const raiz = leerTokens(texto, ':root');
  if (!Object.keys(raiz).length) continue;      // pagina sin tokens: nada que resolver
  const pieles = [['propia', raiz]];
  const oscuro = leerTokens(texto, ':root[data-theme="dark"]');
  if (Object.keys(oscuro).length) pieles.push(['oscura', { ...raiz, ...oscuro }]);
  AMBITOS.push({ archivos: [pagina], pieles, propia: true });
}

const fallos = [];
let revisados = 0, sinResolver = 0;

for (const { archivos, pieles } of AMBITOS)
for (const archivo of archivos) {
  for (const p of paresDe(readFileSync(archivo, 'utf8'), archivo)) {
    for (const [piel, tokens] of pieles) {
      const bg = resolver(p.fondo, tokens), fg = resolver(p.texto, tokens);
      if (!bg || !fg) { sinResolver++; continue; }
      revisados++;
      const r = contraste(bg, fg);
      const minimo = p.grande ? MINIMO_GRANDE : MINIMO;
      if (r < minimo) fallos.push({ ...p, piel, r: r.toFixed(2), minimo, bg, fg });
    }
  }
}

// ── SEGUNDA COMPROBACION: texto claro o amarillo escrito a pelo ───────────
// El punto ciego de la primera es que solo juzga pares que estan JUNTOS. Un
// `color:#fff` cuyo fondo lo pone un ancestro no se puede RESOLVER... pero si
// se puede SOSPECHAR: un texto blanco a pelo solo funciona si el fondo es
// oscuro, y en una app con dos pieles el fondo cambia debajo.
//
// Esto se escapo TRES veces -el logo, el saludo y la ficha de producto- y las
// tres las vio Abraham en una captura. La tercera convencio de arreglar la
// herramienta en vez de arreglar otra pantalla.
//
// Un texto claro declarado JUNTO a un fondo oscuro no se marca: ese par se ve
// entero y ya lo juzga la primera comprobacion.
// En las paginas de `public/` la sospecha va mas lejos: ahi SI se puede
// resolver un token contra el `:root` de la propia pagina, asi que un
// `color: var(--papel)` sin fondo al lado se marca igual que un `#fff` a pelo.
// En la app no: con dos pieles, la mitad de los tokens resuelven claro en una
// y oscuro en la otra, y marcarlos todos daria cientos de avisos -una
// herramienta ruidosa se ignora, que es el punto de toda esta prueba.
const CLARO = /^(#fff|#ffffff|white|rgba?\(\s*255\s*,\s*255\s*,\s*255)/i;
const sospechosos = [];
for (const { archivos, pieles, propia } of AMBITOS)
for (const archivo of archivos) {
  const texto = readFileSync(archivo, 'utf8');
  const mirar = (decl, donde) => {
    const t = decl.match(RE_TEXTO);
    if (!t) return;
    const v = t[1].trim();   // en ESTE archivo el valor es el grupo 1
    let esClaro = CLARO.test(v);
    const esMarca = /var\(--amarillo\b/.test(v);
    if (!esClaro && propia) {
      const rgb = resolver(v, pieles[0][1]);
      if (rgb && luminancia(rgb) > 0.5) esClaro = true;
    }
    if (!esClaro && !esMarca) return;
    if (decl.match(RE_FONDO)) return;     // hay fondo al lado: lo juzga la otra
    sospechosos.push({ archivo, donde, valor: v, tipo: esClaro ? 'texto claro' : 'amarillo de marca' });
  };
  for (const m of texto.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().split('\n').pop().trim();
    if (sel.startsWith('@') || sel.startsWith(':root') || sel.includes('piel-clara')) continue;
    mirar(m[2], sel.slice(0, 70));
  }
  for (const m of texto.matchAll(/style\s*=\s*"([^"]*)"|style\s*=\s*'([^']*)'/g)) {
    mirar(m[1] ?? m[2], `linea ${texto.slice(0, m.index).split('\n').length}`);
  }
}

console.log(`\n  CONTRASTE — ${revisados} pares comprobados en las dos pieles`);
console.log(`  (${sinResolver} pares con un color que no se puede resolver sin navegador: no se juzgan)\n`);

if (sospechosos.length) {
  console.log(`  TEXTO QUE DEPENDE DE UN FONDO QUE PUEDE CAMBIAR — ${sospechosos.length}:`);
  for (const s of sospechosos) {
    console.log(`    ${s.tipo.padEnd(18)} ${s.valor.padEnd(26)} ${s.archivo} · ${s.donde}`);
  }
  console.log('\n  Ninguno dice sobre QUE fondo va. Si la piel lo vuelve claro, desaparecen.\n');
}

if (!fallos.length && !sospechosos.length) {
  console.log('  Ningun par de fondo+texto baja del minimo legible.\n');
  process.exit(0);
}
if (!fallos.length) process.exit(1);

const porPiel = {};
for (const f of fallos) (porPiel[f.piel] ||= []).push(f);
for (const piel of Object.keys(porPiel)) {
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
