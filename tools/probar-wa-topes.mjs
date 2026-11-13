#!/usr/bin/env node
// tools/probar-wa-topes.mjs — wa_entrante (20261113000001): registra el mensaje que entra
// y dice si cabe dentro de los dos topes.
//
// Dos topes, no uno: uno por numero no protege la factura, porque cien numeros hacen cien
// veces el tope (regla 45). Aqui se ven disparar los dos — un tope que nunca se ha visto
// disparar no es un tope (regla 54).
//
// Los topes son PARAMETROS con valor por defecto, no constantes dentro de la funcion. Por eso
// esta prueba puede dispararlos con 2 en vez de insertar 40 filas, y por eso afinarlos no
// necesita una migracion.
//
// Escribe en STAGING. Necesita `node tools/ver-en-staging.mjs` levantado.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STG = 'dkwatbsaidlfjqjnfyrk';

const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, ENTORNO } = JSON.parse(
  cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging' || !SUPABASE_URL.includes(STG)) {
  console.error('No es staging: ' + SUPABASE_URL);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'wa-topes-'));
const sql = (q) => {
  const f = join(dir, 'q.sql');
  writeFileSync(f, q);
  const out = execSync(`supabase db query --linked --project-ref ${STG} -o json --file "${f}"`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const i = out.indexOf('{');
  return i < 0 ? [] : (JSON.parse(out.slice(i)).rows || []);
};
const uno = (q) => (sql(q)[0] || {});

let fallos = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

const tel = '533' + String(Date.now()).slice(-7);
const entra = (t, topeN, topeG) =>
  uno(`select wa_entrante('${t}', 'texto de prueba', ${topeN}, ${topeG}) as j`).j;

const limpiar = () => {
  try { sql(`delete from wa_mensajes where telefono like '533%' or telefono like '534%'`); } catch {}
};

try {
  limpiar();
  console.log(`\nTelefono de prueba: ${tel}\n`);

  console.log('Tope por numero (tope 2, global holgado)');
  const a = entra(tel, 2, 9999);
  ok(a?.permitido === true, `1er mensaje pasa (cuenta ${a?.cuenta})`);
  const b = entra(tel, 2, 9999);
  ok(b?.permitido === true, `2o mensaje pasa (cuenta ${b?.cuenta})`);
  const c = entra(tel, 2, 9999);
  ok(c?.permitido === false, `3er mensaje NO pasa (cuenta ${c?.cuenta})`);
  ok(c?.motivo === 'numero', `motivo = numero (dio: ${c?.motivo})`);

  console.log('\nEl mensaje se registra aunque NO pase');
  const n = Number(uno(`select count(*) as n from wa_mensajes
    where telefono = '${tel}' and direccion = 'entra'`).n);
  ok(n === 3, `hay 3 filas, incluida la del mensaje bloqueado (hay ${n})`);
  // Que el bloqueado tambien cuente es a proposito: si no contara, quien se pasa
  // del tope lo volveria a pasar en cada mensaje, para siempre.

  console.log('\nOtro numero no hereda el tope del primero');
  const otro = '534' + String(Date.now()).slice(-7);
  const d = entra(otro, 2, 9999);
  ok(d?.permitido === true, 'un numero distinto empieza de cero');

  console.log('\nTope global (global 0: tiene que cortar a cualquiera)');
  const e = entra('535' + String(Date.now()).slice(-7), 9999, 0);
  ok(e?.permitido === false, 'no pasa');
  ok(e?.motivo === 'global', `motivo = global (dio: ${e?.motivo})`);

  console.log('\nCuando los dos topes se pasan a la vez, manda el del numero');
  const f = entra(tel, 2, 0);
  ok(f?.permitido === false, 'no pasa');
  ok(f?.motivo === 'numero', `motivo = numero, no global (dio: ${f?.motivo})`);
  // Importa para el aviso: "este numero se paso" se le dice al numero;
  // "nos pasamos todos" es un problema de Abraham, no suyo.

  console.log('\nLos mensajes viejos no cuentan: la ventana es de 24 h');
  sql(`update wa_mensajes set fecha = now() - interval '25 hours' where telefono = '${tel}'`);
  const g = entra(tel, 2, 9999);
  ok(g?.permitido === true, `vuelve a pasar cuando los viejos salen de la ventana (cuenta ${g?.cuenta})`);

  console.log('\nLas salidas no cuentan para el tope de entrada');
  sql(`delete from wa_mensajes where telefono = '${tel}'`);
  sql(`insert into wa_mensajes (telefono, direccion, texto)
       select '${tel}', 'sale', 'respuesta' from generate_series(1, 5)`);
  const h = entra(tel, 2, 9999);
  ok(h?.permitido === true && Number(h?.cuenta) === 0,
    `5 mensajes de salida no llenan el tope (cuenta ${h?.cuenta})`);
} finally {
  limpiar();
}

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
