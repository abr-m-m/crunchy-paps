#!/usr/bin/env node
// tools/probar-wa-juntar.mjs — juntar los mensajes que llegan de golpe.
//
// ESCRIBE EN STAGING (dkwatbsaidlfjqjnfyrk) y limpia lo suyo.
//
// EL PROBLEMA QUE ARREGLA, visto en produccion el 20 nov 2026: Abraham mando
// «La última producción» y «?» en el MISMO segundo, y el agente contesto DOS
// veces, 17:40:41 y 17:40:42. Cada mensaje de WhatsApp dispara su propia
// invocacion, asi que dos modelos pensaron a la vez sobre medias preguntas.
// En una cotizacion eso no es una rareza: es un precio equivocado.
//
// Lo que vigila, y por que:
//
//   - QUE SOLO UNO TOME EL TURNO. Es la propiedad entera. Si dos lo tomaran,
//     seguiriamos con dos respuestas; si ninguno lo tomara, el cliente se
//     quedaria sin ninguna.
//
//   - QUE NINGUN MENSAJE SE PIERDA. El que no toma el turno NO contesta, pero
//     su texto tiene que quedar en la cola para que lo lea el que si lo tomo.
//     Esta es la mitad que se olvida, y la que convierte el arreglo en un bug
//     peor que el original.
//
//   - QUE EL CANDADO CADUQUE. Si la invocacion muere a medias -timeout, crash-
//     la conversacion no puede quedarse muda para siempre. Se prueba con un
//     turno de cero segundos, que es un candado ya vencido.
//
//   - QUE LO QUE LLEGA DESPUES DE CONTESTAR NO SE QUEDE AHI. El caso que mata
//     a esta clase de arreglos: msg2 entra mientras el modelo piensa en msg1,
//     y nadie vuelve a mirar la cola.
//
// Diseño: cambios/2026-11-20-juntar-mensajes.md
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { juntarPendientes } = require('../api/whatsapp.js');

const STG = 'dkwatbsaidlfjqjnfyrk';
const TEL = '5215599700001';
const COLA = '5599700001';
const dir = mkdtempSync(join(tmpdir(), 'wa-juntar-'));
let fallos = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

function sql(q) {
  const f = join(dir, 'q.sql');
  writeFileSync(f, q, 'utf8');
  const out = execFileSync('supabase',
    ['db', 'query', '--linked', '--project-ref', STG, '-f', f],
    { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const c = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1).replace(/,\s*\n\}/, '\n}'));
  if (c.error) throw new Error(JSON.stringify(c.error));
  return c.rows || [];
}
const una = (q) => sql(q)[0];
const limpiar = () => sql(`delete from wa_conversaciones where telefono = '${TEL}';`);

try {
  limpiar();

  console.log('\nDos mensajes a la vez: solo UNO toma el turno');
  {
    // Las dos llamadas en la MISMA sentencia, para que compitan de verdad.
    const r = una(`select
      public.wa_tomar_turno('${TEL}', 'La ultima produccion', 60) as a,
      public.wa_tomar_turno('${TEL}', '?', 60)                    as b;`);
    const tomados = [r.a.tomado, r.b.tomado].filter(Boolean).length;
    ok(tomados === 1, `exactamente uno toma el turno (tomaron ${tomados})`);
  }

  console.log('\nY NINGUNO de los dos textos se pierde');
  {
    const p = una(`select public.wa_tomar_pendientes('${TEL}', 60) as j;`).j;
    ok(Array.isArray(p.pendientes), 'devuelve una lista');
    ok(p.pendientes.length === 2, `los DOS textos estan en la cola (hay ${p.pendientes.length})`);
    ok(p.pendientes[0] === 'La ultima produccion', 'y en el orden en que llegaron');
    ok(p.pendientes[1] === '?', 'el segundo tambien');
  }

  console.log('\nTomarlos los VACIA: no se contestan dos veces');
  {
    const p = una(`select public.wa_tomar_pendientes('${TEL}', 60) as j;`).j;
    ok(p.pendientes.length === 0, `la segunda vez ya no hay nada (hay ${p.pendientes.length})`);
  }

  console.log('\nLo que llega DESPUES queda en la cola para la siguiente vuelta');
  {
    // El caso que mata a esta clase de arreglos: entra mientras el modelo
    // piensa, y nadie vuelve a mirar.
    const r = una(`select public.wa_tomar_turno('${TEL}', 'tarde', 60) as j;`).j;
    ok(r.tomado === false, 'no toma el turno, porque ya esta tomado');
    const p = una(`select public.wa_tomar_pendientes('${TEL}', 60) as j;`).j;
    ok(p.pendientes.length === 1 && p.pendientes[0] === 'tarde',
      'pero su texto SI quedo, y el que tiene el turno lo encuentra');
  }

  console.log('\nSoltar el turno lo deja libre');
  {
    sql(`select public.wa_soltar_turno('${TEL}');`);
    const r = una(`select public.wa_tomar_turno('${TEL}', 'otro dia', 60) as j;`).j;
    ok(r.tomado === true, 'ahora si lo toma');
  }

  console.log('\nEl candado CADUCA: una invocacion muerta no deja muda la conversacion');
  {
    // SOLTAR PRIMERO. La primera version no lo hacia, y el caso anterior dejaba
    // el turno tomado por 60 s: la llamada con 0 segundos ni siquiera llegaba a
    // escribir su candado, asi que la prueba fallaba por su propio estado y no
    // por el codigo. Segunda vez hoy que una prueba se cae por no limpiar entre
    // casos; queda escrito para no repetirlo una tercera.
    sql(`select public.wa_soltar_turno('${TEL}');`);
    // Turno de 0 segundos = candado ya vencido en cuanto se escribe.
    sql(`select public.wa_tomar_turno('${TEL}', 'el que murio', 0);`);
    const r = una(`select public.wa_tomar_turno('${TEL}', 'el siguiente', 60) as j;`).j;
    ok(r.tomado === true, 'otro puede tomarlo cuando el anterior vencio');
  }

  console.log('\nUna conversacion que no existia se crea sola');
  {
    sql(`delete from wa_conversaciones where telefono = '${TEL}';`);
    const r = una(`select public.wa_tomar_turno('${TEL}', 'primer mensaje de mi vida', 60) as j;`).j;
    ok(r.tomado === true, 'el primer mensaje de una conversacion nueva SI toma turno');
    const f = una(`select jsonb_array_length(hilo) as turnos, bloqueado
                     from wa_conversaciones where telefono='${TEL}';`);
    ok(Number(f.turnos) === 0 && f.bloqueado === false,
      'y la fila nace sana: hilo vacio, sin bloquear');
  }

  console.log('\nJuntar los textos (puro, sin base)');
  ok(juntarPendientes(['uno', 'dos']) === 'uno\ndos', 'dos mensajes se pegan con salto de linea');
  ok(juntarPendientes(['solo']) === 'solo', 'uno solo queda igual');
  ok(juntarPendientes([]) === '', 'vacio da cadena vacia');
  ok(juntarPendientes(null) === '', 'null no revienta');
  ok(juntarPendientes(['  hola  ', '', '  que tal']) === 'hola\nque tal',
    'recorta y tira los vacios, que WhatsApp manda de vez en cuando');
} finally {
  limpiar();
  const n = una(`select count(*)::int n from wa_conversaciones where telefono='${TEL}';`).n;
  console.log(`\nlimpieza: quedan ${n} filas de prueba`);
  if (n !== 0) fallos++;
  rmSync(dir, { recursive: true, force: true });
}

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
