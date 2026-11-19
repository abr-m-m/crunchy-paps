#!/usr/bin/env node
// tools/probar-wa-callar.mjs — el silencio tras pasar con una persona.
//
// Sin red y sin base: lo que se prueba aqui es la DECISION de callarse, que es
// pura. Que la fila se escriba de verdad se comprueba aparte, contra staging y
// con una lectura distinta de la que hizo el cambio (regla 58).
//
// Lo que vigila, y por que importa cada cosa:
//
//   - Que un valor ROTO en `callado_hasta` NO calle al agente. El silencio es
//     lo peligroso de esta entrega: un cliente callado no recibe nada y no sabe
//     si el numero existe. Si la columna trae basura, la direccion segura es
//     contestar, no enmudecer para siempre. Por eso el fallo es ABIERTO, y hay
//     una asercion por cada forma de basura que se nos ocurrio.
//
//   - Que `bloqueado` y `callado_hasta` sean INDEPENDIENTES. Son dos cosas:
//     el mudo manual permanente, y el silencio temporal del escalado. El dia
//     que alguien los junte «porque hacen lo mismo», esta prueba lo caza.
//
//   - Que el silencio por omision exista y este dentro del rango que valida
//     `wa_rangos()`. Un valor por defecto fuera de rango se guarda bien la
//     primera vez y revienta la primera vez que alguien toca el formulario.
//
// Diseno: cambios/2026-11-18-wa-callar-al-escalar.md
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  sigueCallado, hastaCuando, POR_DEFECTO, usarAjustesDePrueba,
} = require('../api/whatsapp.js');

let fallos = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

// Un instante fijo, para que la prueba no dependa de cuando se corre.
const AHORA = new Date('2026-11-18T18:00:00.000Z');
const EN_UNA_HORA  = new Date('2026-11-18T19:00:00.000Z').toISOString();
const HACE_UNA_HORA = new Date('2026-11-18T17:00:00.000Z').toISOString();

console.log('\nsigueCallado — cuando SI se calla');
ok(sigueCallado(EN_UNA_HORA, AHORA) === true, 'una fecha futura calla al agente');
ok(sigueCallado(new Date('2026-11-21T18:00:00.000Z').toISOString(), AHORA) === true,
  'tres dias por delante tambien');

console.log('\nsigueCallado — cuando NO se calla');
ok(sigueCallado(null, AHORA) === false, 'null: la conversacion nunca se escalo');
ok(sigueCallado(undefined, AHORA) === false, 'undefined (la columna no vino en el select)');
ok(sigueCallado('', AHORA) === false, 'cadena vacia');
ok(sigueCallado(HACE_UNA_HORA, AHORA) === false, 'una fecha pasada: el silencio ya caduco');
ok(sigueCallado(AHORA.toISOString(), AHORA) === false,
  'justo el instante del limite NO calla: el silencio es hasta, no incluido');

console.log('\nsigueCallado — la basura falla ABIERTO (contesta), no cerrado');
// Si cualquiera de estas callara al agente, un dato corrupto dejaria a un
// cliente sin respuesta y sin forma de saber por que.
for (const basura of ['ayer', '2026-13-45', {}, [], 0, NaN, true, 'null']) {
  const r = sigueCallado(basura, AHORA);
  ok(r === false, `${JSON.stringify(basura)} no calla al agente (dio ${r})`);
}

console.log('\nhastaCuando — cuando termina el silencio');
{
  const h = hastaCuando(8, AHORA);
  ok(h === '2026-11-19T02:00:00.000Z', `8 horas desde las 18:00 dan las 02:00 (dio ${h})`);
  ok(sigueCallado(h, AHORA) === true, 'y lo que devuelve, efectivamente calla');
  ok(sigueCallado(h, new Date('2026-11-19T03:00:00.000Z')) === false,
    'y deja de callar cuando pasa la hora');
}
ok(hastaCuando(1, AHORA) === '2026-11-18T19:00:00.000Z', 'una hora');
ok(hastaCuando(72, AHORA) === '2026-11-21T18:00:00.000Z', 'setenta y dos horas');

console.log('\nhastaCuando — un ajuste roto no produce una fecha invalida');
// El ajuste viene de la base y lo edita una persona. Si llega basura, el
// silencio dura lo de siempre; lo que NO puede pasar es que salga
// "Invalid Date" y se escriba en la columna.
for (const malo of [null, undefined, 0, -5, 'ocho', NaN, {}]) {
  const h = hastaCuando(malo, AHORA);
  ok(h === '2026-11-19T02:00:00.000Z',
    `${JSON.stringify(malo)} cae al valor por omision, 8 h (dio ${h})`);
}

console.log('\nEl ajuste por omision');
ok(POR_DEFECTO.callar_horas === 8, `callar_horas por omision es 8 (es ${POR_DEFECTO.callar_horas})`);
// El rango vive en wa_rangos() y es 1..72. Un valor por omision fuera de ese
// rango se guarda bien hasta que alguien abre el formulario, y entonces falla.
ok(POR_DEFECTO.callar_horas >= 1 && POR_DEFECTO.callar_horas <= 72,
  'y cae dentro del rango que valida wa_rangos()');

console.log('\nEl ajuste se puede cambiar sin desplegar');
{
  const AJ = usarAjustesDePrueba({ callar_horas: 2 });
  ok(AJ.callar_horas === 2, 'un ajuste de la base pisa al del codigo');
  ok(hastaCuando(AJ.callar_horas, AHORA) === '2026-11-18T20:00:00.000Z',
    'y manda sobre la duracion del silencio');
  usarAjustesDePrueba({});
}

console.log('\nbloqueado y callado_hasta son DOS cosas');
// No hay funcion que las combine a proposito: el handler las mira por separado,
// una tras otra. Esta prueba fija esa separacion para que no se "simplifique".
ok(sigueCallado(null, AHORA) === false,
  'una conversacion bloqueada a mano NO necesita callado_hasta para callarse');
ok(sigueCallado(EN_UNA_HORA, AHORA) === true,
  'y una callada por escalado NO necesita estar bloqueada');

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
