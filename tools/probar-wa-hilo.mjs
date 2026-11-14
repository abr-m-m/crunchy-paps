#!/usr/bin/env node
// tools/probar-wa-hilo.mjs — podarHilo() y sistema(), las dos piezas del bucle del agente
// que se pueden probar sin red, sin base y sin gastar un token.
//
// Lo que NO prueba este archivo: que el modelo conteste bien. Eso solo se ve con el numero
// de Meta y la llave de Anthropic puestos, y esta declarado como hueco en el documento de
// cambios. Una prueba que no puede fallar por la razon que dice no es una prueba (regla 31).
//
// Plan: cambios/2026-11-12-agente-whatsapp-plan.md, tarea 4.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { podarHilo, sistema, MAX_TURNOS } = require('../api/whatsapp.js');

let fallos = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

const turno = (rol, n) => ({ role: rol, content: `mensaje ${n}` });
const hiloDe = (n) => Array.from({ length: n }, (_, i) =>
  turno(i % 2 === 0 ? 'user' : 'assistant', i));

console.log('\npodarHilo deja el hilo en pie');
ok(Array.isArray(podarHilo([], 4)), 'un hilo vacio no revienta');
ok(podarHilo([], 4).length === 0, 'un hilo vacio sigue vacio');
ok(podarHilo(null, 4).length === 0, 'null devuelve array vacio');
ok(podarHilo(undefined, 4).length === 0, 'undefined devuelve array vacio');
ok(podarHilo('no soy un array', 4).length === 0, 'una cadena devuelve array vacio');

console.log('\npodarHilo corta por el final, no por el principio');
const h10 = hiloDe(10);
const p = podarHilo(h10, 4);
ok(p.length === 4, `deja 4 de 10 (dejo ${p.length})`);
ok(p[p.length - 1].content === 'mensaje 9', 'conserva el ULTIMO turno, que es el reciente');
ok(p[0].content === 'mensaje 6', 'tira los viejos');

console.log('\nEl hilo podado SIEMPRE empieza por el usuario');
// La API rechaza un historial que empieza por el asistente. Si el corte cae en
// un turno del asistente, hay que tirar uno mas, no mandar el historial roto.
const cortaEnAsistente = podarHilo(hiloDe(10), 3);
ok(cortaEnAsistente[0]?.role === 'user',
  `empieza por user aunque el corte caiga en assistant (empezo por ${cortaEnAsistente[0]?.role})`);
ok(cortaEnAsistente.length === 2, `y por eso deja 2, no 3 (dejo ${cortaEnAsistente.length})`);

const soloAsistente = podarHilo([turno('assistant', 0)], 4);
ok(soloAsistente.length === 0, 'un hilo que es solo un turno del asistente queda vacio');

console.log('\npodarHilo no pierde turnos cuando caben todos');
ok(podarHilo(hiloDe(4), 10).length === 4, 'con sitio de sobra no tira nada');

console.log('\nMAX_TURNOS es un numero razonable');
ok(Number.isInteger(MAX_TURNOS) && MAX_TURNOS >= 4 && MAX_TURNOS <= 100,
  `MAX_TURNOS = ${MAX_TURNOS}`);

console.log('\nsistema() para una TIENDA aprobada');
const sTienda = sistema({
  esCliente: true, nombre: 'Abarrotes Lupita', nivel: 'tienda',
  aprobadoB2B: true, telefono: '5215512345678',
});
ok(sTienda.includes('Abarrotes Lupita'), 'dice quien escribe');
ok(sTienda.includes('tienda'), 'dice el nivel de precio');
ok(/pendiente/i.test(sTienda), 'avisa de que el pedido queda pendiente de confirmar');
ok(!sTienda.includes('crunchypaps.mx'), 'no la manda a la web: puede pedir por aqui');

console.log('\nsistema() para un CONSUMIDOR');
const sCons = sistema({
  esCliente: false, nombre: null, nivel: 'consumidor',
  aprobadoB2B: false, telefono: '5215599999999',
});
ok(sCons.includes('crunchypaps.mx'), 'lo manda al catalogo web');
ok(/no puedes crear pedidos/i.test(sCons), 'le dice al modelo que NO cree pedidos');

console.log('\nsistema() no filtra el nivel al reves');
// Una tienda aprobada que figura como mayorista debe decir mayorista, no "tienda"
// por descuido de redaccion: el nivel es el que manda el servidor, literal.
const sMay = sistema({
  esCliente: true, nombre: 'Mayoreo SA', nivel: 'mayorista',
  aprobadoB2B: true, telefono: '5215511112222',
});
ok(sMay.includes('mayorista') && !sMay.includes('Nivel de precio: tienda'),
  'un mayorista dice mayorista');

console.log('\nsistema() con los dos campos en CONTRADICCION (el bug del 14 nov 2026)');
// El primer mensaje real llego de un cliente con tipo_id = 1 (Consumidor) y
// aprobado_b2b = TRUE a la vez. wa_identidad devolvio nivel: 'consumidor', que es
// lo correcto, pero el prompt miraba el FLAG y le ofrecio levantarle un pedido a
// un consumidor. La puerta la decide el NIVEL.
const sContradictorio = sistema({
  esCliente: true, nombre: 'Ana Maria Mora', nivel: 'consumidor',
  aprobadoB2B: true, telefono: '5215540801794',
});
ok(/no puedes crear pedidos/i.test(sContradictorio),
  'con nivel consumidor y aprobadoB2B true, NO puede crear pedidos');
ok(sContradictorio.includes('crunchypaps.mx'),
  'y se le manda al catalogo web, como a cualquier consumidor');

console.log('\nsistema() nunca lleva un secreto dentro');
for (const s of [sTienda, sCons, sMay]) {
  ok(!/sk-ant|EAA[A-Za-z0-9]|service_role|eyJ[A-Za-z0-9]/.test(s),
    'el prompt no trae llaves ni tokens');
}

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
