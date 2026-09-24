#!/usr/bin/env node
// tools/probar-mapa-comprobar.mjs — comprueba que mapa-comprobar.mjs FALLA cuando debe.
// Regla 54: una prueba que no se ha visto fallar no prueba nada. Cada caso rompe el mapa de UNA
// manera y exige que salga el mensaje de esa comprobación, no solo que el código de salida sea 1.
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fallos = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

const base = () => ({
  permisos: { generado: '2026-09-23', catalogo: ['catalogo'], porRol: {}, efectivo: [], alcance: { catalogo: ['x'] }, muertas: [] },
  pendientes: [{ id: 'MAP-900', ficha: 's-catalogo', clase: 'producto', titulo: 't', detalle: 'd',
                 evidencia: 'e', hallado: '2026-09-23', impacto: 'i', bloquea: 'nada',
                 frecuencia: 'ocasional', severidad: 'baja', esfuerzo: 'una-linea' }],
  auditoria: [],
  comprar: { familia: { id: 'comprar', nombre: 'Comprar', orden: 2 }, fichas: [{
    id: 's-catalogo', nombre: 'Catálogo', tipo: 'pantalla', ruta: '#s-catalogo', seccion: 'catalogo',
    codigo: [{ archivo: 'src/app.js', desde: 1, hasta: 2 }], ven: ['consumidor'], madurez: 'completo',
    verificado: '2026-09-23', resumen: 'r',
    capturas: [{ archivo: 'capturas/x.webp', perfil: 'consumidor', entorno: 'produccion',
                 pii: 'tapada', pines: [{ n: 1, x: 0.1, y: 0.1 }] }],
    elementos: [{ n: 1, nombre: 'e', hace: 'h', lee: [], escribe: [], rpc: [], reglas: [10],
                  ven: ['consumidor'], notas: '' }],
    diferencias: [], flujo: { pasos: ['pantalla'] }, pendientes: ['MAP-900'] }] },
});

const montar = (mapa, conCaptura = true) => {
  const d = mkdtempSync(join(tmpdir(), 'mapa-test-'));
  mkdirSync(join(d, 'datos')); mkdirSync(join(d, 'capturas'));
  if (conCaptura) writeFileSync(join(d, 'capturas', 'x.webp'), 'no es una imagen de verdad');
  for (const [k, v] of Object.entries(mapa)) {
    writeFileSync(join(d, 'datos', `${k}.js`),
      `window.MAPA = window.MAPA || {};\nwindow.MAPA.${k} = ${JSON.stringify(v)};\n`);
  }
  return d;
};
const correr = (d) => {
  try { return { codigo: 0, salida: execSync(`node tools/mapa-comprobar.mjs "${d}"`, { encoding: 'utf8' }) }; }
  catch (e) { return { codigo: e.status, salida: (e.stdout || '') + (e.stderr || '') }; }
};

console.log('Caso 0: un mapa correcto pasa');
let d = montar(base());
let r = correr(d);
ok(r.codigo === 0, `mapa correcto: código ${r.codigo}`);
rmSync(d, { recursive: true, force: true });

const casos = [
  ['ficha con id que no existe en index.html', (m) => { m.comprar.fichas[0].id = 's-inventado'; }, /no existe en index\.html/i],
  ['sección que no está en el catálogo',       (m) => { m.comprar.fichas[0].seccion = 'inventada'; }, /secci[oó]n/i],
  ['perfil inventado en ven',                   (m) => { m.comprar.fichas[0].ven = ['marciano']; },   /perfil/i],
  ['pin sin fila en elementos',                 (m) => { m.comprar.fichas[0].capturas[0].pines.push({ n: 9, x: 0.5, y: 0.5 }); }, /pin 9/i],
  ['elemento sin pin',                          (m) => { m.comprar.fichas[0].elementos.push({ n: 7, nombre: 'z', hace: 'h', lee: [], escribe: [], rpc: [], reglas: [], ven: ['consumidor'], notas: '' }); }, /elemento 7/i],
  ['regla fuera de 1..62',                      (m) => { m.comprar.fichas[0].elementos[0].reglas = [99]; }, /regla 99/i],
  ['id de ficha repetido',                      (m) => { m.comprar.fichas.push({ ...m.comprar.fichas[0] }); }, /repetid/i],
  ['pendiente que no existe',                   (m) => { m.comprar.fichas[0].pendientes = ['MAP-404']; }, /MAP-404/],
  ['pendiente sin impacto',                     (m) => { delete m.pendientes[0].impacto; },            /impacto/i],
  ['captura de producción sin pii declarado',   (m) => { delete m.comprar.fichas[0].capturas[0].pii; }, /datos personales/i],
];

for (const [nombre, romper, patron] of casos) {
  const m = base(); romper(m);
  const dd = montar(m);
  const rr = correr(dd);
  ok(rr.codigo === 1 && patron.test(rr.salida), `caza: ${nombre}`);
  rmSync(dd, { recursive: true, force: true });
}

console.log('Caso 10: captura que no existe en disco');
const dd = montar(base(), false);
const rr = correr(dd);
ok(rr.codigo === 1 && /capturas\/x\.webp/.test(rr.salida), 'caza: captura que falta');
rmSync(dd, { recursive: true, force: true });

console.log(fallos ? `\n${fallos} problema(s).\n` : `\nTodo en orden.\n`);
process.exit(fallos ? 1 : 0);
