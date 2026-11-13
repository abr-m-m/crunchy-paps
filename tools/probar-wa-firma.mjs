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
const { firmaValida, sacarMensaje } = require('../api/whatsapp.js');

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

// ── sacarMensaje: lo que manda Meta es dato ajeno, no una promesa ───────────
console.log('\nsacarMensaje con un mensaje de texto');
const conTexto = {
  entry: [{ changes: [{ value: {
    contacts: [{ profile: { name: 'Abarrotes Lupita' } }],
    messages: [{ id: 'wamid.ABC', from: '5215512345678', type: 'text',
                 text: { body: 'Mandame 6 cajas de 12' } }],
  } }] }],
};
const m = sacarMensaje(conTexto);
ok(m?.id === 'wamid.ABC', 'saca el id del mensaje (hace de clave idempotente)');
ok(m?.telefono === '5215512345678', 'saca el telefono');
ok(m?.texto === 'Mandame 6 cajas de 12', 'saca el texto');
ok(m?.nombrePerfil === 'Abarrotes Lupita', 'saca el nombre del perfil');

console.log('\nsacarMensaje devuelve null, sin lanzar, cuando no hay nada que atender');
for (const [cuerpo, como] of [
  [{ entry: [{ changes: [{ value: { statuses: [{ status: 'delivered' }] } }] }] }, 'un acuse de entrega'],
  [{ entry: [{ changes: [{ value: {} }] }] }, 'un value vacio'],
  [{ entry: [{ changes: [] }] }, 'sin changes'],
  [{ entry: [] }, 'sin entry'],
  [{}, 'un objeto vacio'],
  [null, 'null'],
  [{ entry: [{ changes: [{ value: { messages: [] } }] }] }, 'messages vacio'],
]) {
  let lanzo = false, r;
  try { r = sacarMensaje(cuerpo); } catch { lanzo = true; }
  ok(!lanzo && r === null, `${como} devuelve null sin lanzar`);
}

console.log('\nUn mensaje que NO es texto (audio, imagen, ubicacion)');
const audio = sacarMensaje({ entry: [{ changes: [{ value: {
  messages: [{ id: 'wamid.X', from: '5215599999999', type: 'audio', audio: { id: 'a1' } }],
} }] }] });
ok(audio !== null, 'no se descarta: hay alguien escribiendo');
ok(audio?.tipo === 'audio', 'el tipo viaja, para poder contestar que no se oyen audios');
ok(audio?.texto === '', 'el texto queda vacio, no undefined');

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
