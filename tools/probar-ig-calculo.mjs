#!/usr/bin/env node
// tools/probar-ig-calculo.mjs — el calculo del radar: mediana, razon, tasa y sospecha de pago.
// Sin red, sin base y sin gastar un token.
//
// El caso 1 usa los OCHO reels reales de @crunchy.papsmx, con las vistas anotadas en
// Instagram/2026-10-26-analisis-del-perfil.md. No es un ejemplo inventado: es el unico caso
// donde sabemos de antemano que respuesta queremos, y por eso calibra (regla 60).
//
// Plan: cambios/2026-11-13-radar-instagram-plan.md, tarea 1.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  mediana, analizarCuenta, UMBRAL_RAZON, UMBRAL_TASA,
  promptDesmontaje, desmontar, MODELO,
  normalizarDestino, textoAviso,
} = require('../api/ig-radar.js');

let fallos = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };
const casi = (a, b, t = 0.001) => Math.abs(a - b) < t;

// Los 8 reels reales, en el orden en que estan anotados en el analisis.
const VISTAS_CP = [223, 432, 1533, 526, 389, 635, 421, 637];
const reelsCP = VISTAS_CP.map((v, i) => ({
  id: 'r' + i, vistas: v, meGusta: Math.round(v * 0.05), comentarios: 1,
}));

console.log('\nmediana');
ok(mediana([1, 2, 3]) === 2, 'impar: el de en medio');
ok(mediana([1, 2, 3, 4]) === 2.5, 'par: promedio de los dos de en medio');
ok(mediana([3, 1, 2]) === 2, 'no depende del orden de entrada');
ok(mediana([5]) === 5, 'un solo elemento');
ok(mediana([]) === 0, 'vacio devuelve 0 y no NaN');
ok(mediana(null) === 0, 'null devuelve 0');

console.log('\nCaso 1 — los 8 reels reales de @crunchy.papsmx');
const r = analizarCuenta(reelsCP);
ok(r.medianaVistas === 479, `la mediana es 479 (dio ${r.medianaVistas})`);

const elDelAnaquel = r.medios.find((m) => m.vistas === 1533);
ok(casi(elDelAnaquel.razon, 3.2, 0.01),
  `el reel del anaquel sale en 3.20x (dio ${elDelAnaquel.razon.toFixed(3)})`);
ok(elDelAnaquel.destaca === true, 'y destaca');

const destacados = r.medios.filter((m) => m.destaca);
ok(destacados.length === 1, `destaca UNO solo de los ocho (destacaron ${destacados.length})`);

const segundo = r.medios.find((m) => m.vistas === 637);
ok(casi(segundo.razon, 1.33, 0.01),
  `el segundo mas visto sale en 1.33x (dio ${segundo.razon.toFixed(3)})`);
ok(segundo.destaca === false, 'y no destaca');

console.log('\nCaso 2 — por que mediana y no media (D5 del spec)');
// La media de esos ocho es 599.5, y la arrastra hacia arriba el propio reel que
// queremos detectar: contra la media sale en 2.557x, raspando el umbral de 2.5.
// Contra la mediana sale en 3.200x. Si alguien cambia mediana por media, este
// caso es el que lo caza.
const media = VISTAS_CP.reduce((a, b) => a + b, 0) / VISTAS_CP.length;
ok(casi(media, 599.5, 0.01), 'la media es 599.5 (coincide con el "~600" del analisis de octubre)');
ok(1533 / media < 1533 / r.medianaVistas,
  `contra la media el hallazgo se ve MAS chico (${(1533 / media).toFixed(3)}x) que contra la mediana (${(1533 / r.medianaVistas).toFixed(3)}x)`);
ok(r.medianaVistas < media, 'la mediana es menor que la media: a la media la arrastra el pico');

console.log('\nCaso 3 — la sospecha de pago');
// Misma cuenta, dos reels disparados: uno con interaccion normal y otro con
// interaccion hundida. Solo el segundo se marca.
const base = [100, 110, 90, 105, 95].map((v, i) => ({
  id: 'b' + i, vistas: v, meGusta: Math.round(v * 0.10), comentarios: 2,
}));
const organico = { id: 'org', vistas: 500, meGusta: 50, comentarios: 10 };   // tasa 0.10, la normal
const pagado   = { id: 'pag', vistas: 500, meGusta: 10, comentarios: 1 };    // tasa 0.02, hundida
const r3 = analizarCuenta([...base, organico, pagado]);
const o = r3.medios.find((m) => m.id === 'org');
const p = r3.medios.find((m) => m.id === 'pag');
ok(o.destaca === true && p.destaca === true, 'los dos destacan por vistas');
ok(o.sospechaPago === false, 'el de interaccion normal NO se marca');
ok(p.sospechaPago === true, 'el de interaccion hundida SI se marca');

console.log('\nCaso 4 — sin pico no hay sospecha');
const r4 = analizarCuenta(base.map((m) => ({ ...m, meGusta: 0 })));
ok(r4.medios.every((m) => m.sospechaPago === false),
  'una cuenta entera sin me gusta no produce sospechas: es una cuenta con poca interaccion, no una que compra vistas');

console.log('\nCaso 5 — lo que no debe reventar');
for (const [entrada, como] of [
  [[], 'una cuenta sin medios'],
  [null, 'null'],
  [undefined, 'undefined'],
  [[{ id: 'x', vistas: 0, meGusta: 0, comentarios: 0 }], 'un medio con 0 vistas (division por cero)'],
  [[{ id: 'y' }], 'un medio sin campos'],
  [[{ id: 'z', vistas: 'muchas', meGusta: null }], 'un medio con basura en los numeros'],
]) {
  let lanzo = false, res;
  try { res = analizarCuenta(entrada); } catch { lanzo = true; }
  ok(!lanzo && res && Array.isArray(res.medios), `${como} no revienta`);
}

// ── Tarea 4: el desmontaje ──────────────────────────────────────────────────
// No se llama a la API: eso costaria dinero en cada corrida. Se comprueba lo
// unico que se puede comprobar gratis y que de verdad importa — que el prompt
// dice lo que debe y no lleva nada que no deba.
console.log('\nTarea 4 — el prompt del desmontaje');
{
  const p = promptDesmontaje([{ usuario: 'papassabritas', razon: 3.2, grupo: 'grande' }]);
  ok(!/sk-ant|EAA[A-Za-z0-9]|service_role|eyJ[A-Za-z0-9]/.test(p), 'el prompt no trae llaves');
  ok(/no hay nada que valga la pena/i.test(p), 'el prompt permite decir que no hubo nada');
  ok(/copiarlo con un telefono/i.test(p), 'el prompt pide la columna accionable');
  ok(/marca grande con agencia/i.test(p), 'el prompt avisa de lo que no es copiable');
  ok(/puede estar pagado/i.test(p), 'el prompt manda tratar con pinzas lo sospechoso');
  ok(/No inventes nada/i.test(p), 'el prompt prohibe inventar');
  // Sin esto el prompt podria estar perfecto y no llevar los datos.
  ok(p.includes('papassabritas'), 'los destacados llegan dentro del prompt');
  ok(p.includes('"grupo"') || p.includes('grande'), 'el grupo viaja con cada cuenta');
}

console.log('\nTarea 4 — el modulo carga sin ANTHROPIC_API_KEY');
// Si el cliente se construyera al cargar el modulo, el require de arriba habria
// lanzado y esta prueba no existiria. Llegar hasta aqui ES la comprobacion.
ok(typeof desmontar === 'function', 'desmontar se exporta y el modulo cargo sin la llave');
ok(MODELO === 'claude-opus-5-5', `el modelo es ${MODELO}`);

// ── Tarea 6: el aviso por WhatsApp ──────────────────────────────────────────
console.log('\nTarea 6 — el destino se normaliza igual que en el agente');
ok(normalizarDestino('5215512345678') === '525512345678', 'quita el 1 del 521 de Mexico');
ok(normalizarDestino('525512345678') === '525512345678', 'un numero ya bueno no se toca');
ok(normalizarDestino('+52 55 1234 5678') === '525512345678', 'quita espacios y el mas');
ok(normalizarDestino(null) === '', 'null no revienta');

console.log('\nTarea 6 — el texto del aviso');
ok(textoAviso({ cuantos: 0 }) === null, 'sin destacados NO se manda nada');
ok(textoAviso(null) === null, 'un informe vacio no manda nada');
{
  const t = textoAviso({ cuantos: 3, cuentas: ['papassabritas', 'barcel'] });
  ok(typeof t === 'string' && t.length > 0, 'con destacados si hay texto');
  ok(t.includes('/radar'), 'el aviso lleva el enlace al informe');
  ok(t.length < 500, `son tres lineas, no el informe entero (${t.length} caracteres)`);
  ok(!/sk-ant|EAA[A-Za-z0-9]|service_role/.test(t), 'el aviso no trae llaves');
  ok(/3 reels/.test(t), 'dice cuantos fueron');
}
ok(/1 reel reventó/.test(textoAviso({ cuantos: 1, cuentas: ['x'] })), 'singular con uno solo');

console.log('\nLos umbrales son los del spec');
ok(UMBRAL_RAZON === 2.5, `UMBRAL_RAZON = ${UMBRAL_RAZON}`);
ok(UMBRAL_TASA === 0.5, `UMBRAL_TASA = ${UMBRAL_TASA}`);

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
