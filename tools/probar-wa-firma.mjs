#!/usr/bin/env node
// tools/probar-wa-firma.mjs — la puerta de entrada del webhook de WhatsApp.
//
// Sin red y sin base: solo firmaValida(). Si esta puerta se abre, el endpoint es publico,
// cualquiera le escribe al agente y la factura de la API es de quien quiera.
//
// Plan: cambios/2026-11-12-agente-whatsapp-plan.md, tarea 2.
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { firmaValida } = require('../api/whatsapp.js');

let fallos = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

const SECRETO = 'secreto-de-prueba';
const cuerpo = JSON.stringify({ entry: [{ changes: [{ value: { messages: [] } }] }] });
const buena = 'sha256=' + createHmac('sha256', SECRETO).update(cuerpo).digest('hex');

console.log('\nLa firma buena');
ok(firmaValida(cuerpo, buena, SECRETO) === true, 'pasa');

console.log('\nLo que NO debe pasar');
ok(firmaValida(cuerpo, buena.replace(/.$/, buena.endsWith('0') ? '1' : '0'), SECRETO) === false,
  'un byte cambiado en la firma');
ok(firmaValida(cuerpo + ' ', buena, SECRETO) === false, 'el cuerpo alterado');
ok(firmaValida(cuerpo, '', SECRETO) === false, 'firma vacia');
ok(firmaValida(cuerpo, undefined, SECRETO) === false, 'firma ausente');
ok(firmaValida(cuerpo, null, SECRETO) === false, 'firma null');
ok(firmaValida(cuerpo, buena.slice(7), SECRETO) === false, 'sin el prefijo sha256=');
ok(firmaValida(cuerpo, buena, 'otro-secreto') === false, 'firmada con otro secreto');
ok(firmaValida(cuerpo, buena, '') === false, 'sin secreto configurado');
ok(firmaValida(cuerpo, buena, undefined) === false, 'secreto ausente');
ok(firmaValida('', buena, SECRETO) === false, 'cuerpo vacio con firma de otro cuerpo');

console.log('\nLo que no debe REVENTAR (devolver false, no lanzar)');
for (const [valor, como] of [
  ['sha256=zz', 'una firma corta'],
  ['sha256=' + 'f'.repeat(200), 'una firma larguisima'],
  ['sha256=' + 'ñ'.repeat(64), 'una firma con bytes raros'],
  [{}, 'un objeto en vez de una cadena'],
  [123, 'un numero'],
]) {
  let lanzo = false, r;
  try { r = firmaValida(cuerpo, valor, SECRETO); } catch { lanzo = true; }
  ok(!lanzo && r === false, `${como} devuelve false sin lanzar`);
}

console.log('\nEl mismo cuerpo con acentos y emoji (WhatsApp los trae)');
const cuerpoUtf = JSON.stringify({ texto: 'Mándame 6 cajas 🙂 de sal de mar' });
const buenaUtf = 'sha256=' + createHmac('sha256', SECRETO).update(cuerpoUtf, 'utf8').digest('hex');
ok(firmaValida(cuerpoUtf, buenaUtf, SECRETO) === true, 'pasa con UTF-8');

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
