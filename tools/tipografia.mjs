#!/usr/bin/env node
// tools/tipografia.mjs — La dirección de diseño, aplicada por regla.
//
// Uso:  node tools/tipografia.mjs --seco   (dice qué haría)
//       node tools/tipografia.mjs          (lo hace)
//
// LO QUE PIDE `material/Design_reference/DIRECCION-DE-DISENO.md`, §3.1:
//   «Títulos grandes en peso LIGERO (300-400), no bold. El contraste se logra
//    con TAMAÑO, no con grosor. Debajo, cuerpo en regular y etiquetas en
//    11-12px con letter-spacing y mayúsculas.»
//
// Y la deuda que medía ese documento en septiembre, vuelta a medir el 23 nov
// 2026 sobre los cuatro archivos: **806 declaraciones de font-weight, 721 en
// 700 o más (89 %), 95 en 900**. Casi toda la app está en negrita, así que la
// negrita no distingue nada: cuando todo pesa, nada pesa.
//
// POR QUÉ UNA HERRAMIENTA Y NO 721 EDICIONES. Porque son CUATRO reglas
// repetidas, y porque esto se va a volver a correr: cada pantalla nueva trae
// sus pesos. Una lista de 721 sitios caduca en cuanto alguien escribe el 722.
//
// LA REGLA, que mira el TAMAÑO de la misma declaración:
//   · con font-size >= 1.4rem (display)        -> 400
//   · con font-size <= 0.75rem (etiqueta)      -> 600
//   · el resto de los >= 700                   -> 600
//   · sin font-size al lado, >= 800            -> 700
// La última es deliberadamente tímida: sin saber de qué tamaño es el texto, no
// se puede decidir si es un título o una etiqueta, así que solo se le quita el
// extremo (800/900) y se deja en 700. Lo que no se puede resolver, no se toca.

import { readFileSync, writeFileSync } from 'node:fs';

const SECO = process.argv.includes('--seco');
const ARCHIVOS = ['index.html', 'src/estilos.css', 'src/app.js', 'src/panel.js'];

const RE_PESO = /font-weight\s*:\s*(\d{3})/i;
const RE_TAM  = /font-size\s*:\s*([0-9.]+)rem/i;

function pesoNuevo(decl) {
  const p = decl.match(RE_PESO);
  if (!p) return null;
  const peso = +p[1];
  if (peso < 700) return null;
  const t = decl.match(RE_TAM);
  if (!t) return peso >= 800 ? 700 : null;
  const rem = +t[1];
  if (rem >= 1.4) return 400;
  if (rem <= 0.75) return 600;
  return 600;
}

function corregir(decl) {
  const nuevo = pesoNuevo(decl);
  if (nuevo === null) return null;
  const actual = +decl.match(RE_PESO)[1];
  if (actual === nuevo) return null;
  return decl.replace(RE_PESO, (m) => m.replace(/\d{3}/, String(nuevo)));
}

let total = 0;
const detalle = {};
const cuenta = { 400: 0, 600: 0, 700: 0 };

for (const archivo of ARCHIVOS) {
  let s = readFileSync(archivo, 'utf8');
  let n = 0;
  const pasar = (re) => {
    s = s.replace(re, (entero, cuerpo) => {
      const nuevo = corregir(cuerpo);
      if (!nuevo) return entero;
      n++;
      cuenta[+nuevo.match(RE_PESO)[1]]++;
      return entero.replace(cuerpo, nuevo);
    });
  };
  pasar(/\{([^{}]*)\}/g);                 // bloques CSS
  pasar(/style\s*=\s*"([^"]*)"/g);        // estilos en línea con comillas dobles
  pasar(/style\s*=\s*'([^']*)'/g);        // …y con simples (el punto ciego viejo)
  if (n && !SECO) writeFileSync(archivo, s, 'utf8');
  detalle[archivo] = n;
  total += n;
}

console.log(`\n  TIPOGRAFÍA — ${SECO ? 'haría' : 'hechos'} ${total} cambios de peso\n`);
for (const [a, n] of Object.entries(detalle)) console.log(`    ${a.padEnd(18)} ${n}`);
console.log(`\n    a 400 (display) ${cuenta[400]}   a 600 ${cuenta[600]}   a 700 ${cuenta[700]}\n`);
