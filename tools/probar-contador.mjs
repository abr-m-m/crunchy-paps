#!/usr/bin/env node
// tools/probar-contador.mjs — el agente contador (20261120000000).
//
// Sin red, sin base y sin gastar un token: lo que se prueba aqui es la PUERTA y
// el AVISO, que son puras. Las siete revisiones son SQL y se calibraron contra
// los dos entornos el 20 nov 2026 (staging dispara, produccion no grita en
// falso); eso se comprueba corriendo la funcion, no desde aqui.
//
// Lo que vigila, y por que:
//
//   - QUE EL SILENCIO SEA SILENCIO. Si el contador avisara «hoy todo cuadra»
//     cada mañana, en dos semanas nadie abriria el mensaje — y el dia que
//     trajera algo, tampoco. Es la misma regla del radar. Por eso `textoAviso`
//     devuelve null con cero hallazgos, y hay una asercion por cada forma de
//     informe vacio que se nos ocurrio.
//
//   - QUE LA PUERTA ESTE CERRADA. El endpoint lo despierta un cron de Vercel
//     con `Bearer CRON_SECRET`. Sin secreto configurado NO se abre sola: una
//     puerta que se abre cuando falta la llave no es una puerta.
//
//   - QUE EL AVISO NO LLEVE LLAVES y quepa en un WhatsApp.
//
// Diseño: cambios/2026-11-20-el-equipo-completo.md
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { textoAviso, autorizado, normalizarDestino, AVISO_MAX } = require('../api/contador.js');

let fallos = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

const INFORME = {
  revisado_en: '2026-11-20T21:00:00Z',
  cuantos: 3,
  revisiones: [
    { clave: 'pagado_sin_caja', gravedad: 'alta', titulo: 'Cobrado y sin asiento de caja',
      cuantos: 1, ejemplos: [{ folio: 'PED-00075', monto: '880.00', fecha: '2026-10-13' }] },
    { clave: 'puntos_negativos', gravedad: 'media', titulo: 'Cliente con saldo de puntos negativo',
      cuantos: 2, ejemplos: [{ cliente: 7, puntos: -5 }, { cliente: 9, puntos: -1 }] },
  ],
};

console.log('\nEl silencio es silencio');
for (const vacio of [
  null, undefined, {}, { cuantos: 0 }, { cuantos: 0, revisiones: [] },
  { cuantos: '0', revisiones: [] }, { revisiones: [] },
]) {
  ok(textoAviso(vacio) === null, `${JSON.stringify(vacio)} no manda nada`);
}

console.log('\nCon hallazgos SI avisa, y dice lo necesario');
{
  const t = textoAviso(INFORME);
  ok(typeof t === 'string' && t.length > 0, 'hay texto');
  ok(t.includes('PED-00075'), 'nombra el folio, que es por donde se empieza a buscar');
  ok(t.includes('880'), 'y el monto');
  ok(/alta/i.test(t), 'marca la gravedad');
  ok(t.includes('/agente'), 'lleva a donde esta el detalle');
  ok(t.length <= AVISO_MAX, `cabe en un WhatsApp (${t.length} de ${AVISO_MAX})`);
  ok(!/sk-ant|eyJ[A-Za-z0-9]|service_role|CRON_SECRET|Bearer /.test(t), 'no lleva llaves');
}

console.log('\nUn informe con MUCHOS hallazgos no revienta el mensaje');
{
  const gordo = {
    cuantos: 900,
    revisiones: Array.from({ length: 7 }, (_, i) => ({
      clave: 'r' + i, gravedad: i < 4 ? 'alta' : 'media', titulo: 'Revision numero ' + i,
      cuantos: 128,
      ejemplos: Array.from({ length: 5 }, (_, j) => ({ folio: `PED-${1000 + j}`, monto: '999.00' })),
    })),
  };
  const t = textoAviso(gordo);
  ok(t.length <= AVISO_MAX, `se recorta a ${AVISO_MAX} (quedo en ${t.length})`);
  ok(t.includes('900'), 'pero el TOTAL real sigue estando, no el de la muestra');
}

console.log('\nLa puerta');
// `autorizado(headers, query, secreto)` es pura: no mira process.env.
ok(autorizado({ authorization: 'Bearer abc' }, {}, 'abc') === true, 'Bearer correcto pasa');
ok(autorizado({}, { secret: 'abc' }, 'abc') === true, 'el parametro ?secret= tambien');
ok(autorizado({ authorization: 'Bearer otro' }, {}, 'abc') === false, 'Bearer equivocado no pasa');
ok(autorizado({}, { secret: 'otro' }, 'abc') === false, 'secreto equivocado no pasa');
ok(autorizado({}, {}, 'abc') === false, 'sin credencial no pasa');
// Esta es la que importa: una puerta que se abre cuando falta la llave no es
// una puerta. Si `CRON_SECRET` no esta configurado, NADIE entra.
for (const sinLlave of [undefined, null, '']) {
  ok(autorizado({ authorization: 'Bearer loquesea' }, {}, sinLlave) === false,
    `sin CRON_SECRET configurado (${JSON.stringify(sinLlave)}) NO se abre`);
  ok(autorizado({}, { secret: '' }, sinLlave) === false,
    'ni con un secreto vacio por querystring');
}

console.log('\nEl destino del aviso');
ok(normalizarDestino('5215540801794') === '525540801794', 'quita el 1 del 521 de Mexico');
ok(normalizarDestino('+52 55 7365 4109') === '525573654109', 'limpia espacios y el mas');
ok(normalizarDestino(null) === '', 'null no revienta');

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
