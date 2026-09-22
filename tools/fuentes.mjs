// tools/fuentes.mjs — Los archivos del frontend, para las pruebas que leen el
// código REAL en vez de suponerlo.
//
// Desde el 20 sep 2026 (CLAUDE.md §2) `index.html` es solo HTML: el JS del
// consumidor vive en `src/app.js`, el del panel en `src/panel.js`, y las
// páginas sueltas (retos, planeador, privacidad) en `public/`. Las aserciones
// que seguían leyendo `index.html` buscaban cadenas de JavaScript en un archivo
// que ya no las tiene: fallaban todas juntas en cada corrida y tapaban los
// fallos de verdad.
//
// `HTML`, `APP` y `PANEL` son cada archivo por su nombre. `TODO` es la unión de
// los tres y existe para las aserciones NEGATIVAS («este texto ya no está»):
// buscar una ausencia en un solo archivo la aprueba por vacío en cuanto el
// texto se muda al de al lado, que es exactamente lo que pasó aquí.

import { readFileSync } from 'node:fs';

export const leer = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

export const HTML  = leer('index.html');
export const APP   = leer('src/app.js');
export const PANEL = leer('src/panel.js');
export const TODO  = [HTML, APP, PANEL].join('\n');
