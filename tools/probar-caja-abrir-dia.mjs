#!/usr/bin/env node
// tools/probar-caja-abrir-dia.mjs — abrir_cajas_del_dia (20261005000000).
// Producción tenía UNA caja de día (9 jun 2026) y 75 asientos huérfanos en 31 días: la búsqueda
// es `fecha = CURRENT_DATE and estatus = 'abierta'` y no había ninguna. Ahora un cron la abre
// cada día a las 00:05 CDMX, con saldo 0, y `abrir_caja_dia_interno` adopta los huérfanos del día.
// Escribe en STAGING. Necesita `node tools/ver-en-staging.mjs`.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STG = 'dkwatbsaidlfjqjnfyrk';
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging' || !SUPABASE_URL.includes(STG)) { console.error('No es staging: ' + SUPABASE_URL); process.exit(1); }
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };
const dir = mkdtempSync(join(tmpdir(), 'caja-abrir-'));
const sql = (q) => { const f = join(dir, 'q.sql'); writeFileSync(f, q); const out = execSync(`supabase db query --linked --project-ref ${STG} -o json --file "${f}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); const i = out.indexOf('{'); return i < 0 ? [] : (JSON.parse(out.slice(i)).rows || []); };
const uno = (q) => (sql(q)[0] || {});

const sufijo = String(Date.now()).slice(-6);
const hoy = uno(`select current_date::text d`).d;
const cajasDeHoy = () => sql(`select d.id, d.id_punto, p.codigo, d.saldo_apertura, d.estatus, d.abierta_por
                                from caja_dias d join caja_puntos p on p.id = d.id_punto
                               where d.fecha = current_date order by d.id_punto`);
const abrir = () => uno(`select public.abrir_cajas_del_dia() r`).r;

// ── Fixtures: un punto activo nuevo y uno INACTIVO, para probar el filtro ────
const idAct = Number(uno(`insert into caja_puntos (codigo, nombre, activo, tipo)
  values ('prueba_act_${sufijo}', 'Punto activo prueba', true, 'fijo') returning id`).id);
const idIna = Number(uno(`insert into caja_puntos (codigo, nombre, activo, tipo)
  values ('prueba_ina_${sufijo}', 'Punto inactivo prueba', false, 'fijo') returning id`).id);
ok(idAct > 0 && idIna > 0, `Fixture: punto activo ${idAct} y punto inactivo ${idIna}`);

// Un huérfano de HOY en el punto activo: debe quedar adoptado al abrir.
const idHuerfano = Number(uno(`insert into caja_movimientos (id_caja_dia, id_punto, tipo, monto, descripcion, actor)
  values (null, ${idAct}, 'venta_efectivo', 77, 'Huérfano de prueba ${sufijo}', 'probar-abrir') returning id`).id);
// Y uno de AYER en el mismo punto: NO debe tocarse.
const idAyer = Number(uno(`insert into caja_movimientos (id_caja_dia, id_punto, tipo, monto, fecha, descripcion, actor)
  values (null, ${idAct}, 'venta_efectivo', 55, current_date - 1, 'Huérfano de ayer ${sufijo}', 'probar-abrir') returning id`).id);

console.log('\nCaso 1: abre una caja por punto activo, con saldo 0');
const r1 = abrir();
const c1 = cajasDeHoy();
const mia = c1.find(c => Number(c.id_punto) === idAct) || {};
ok(r1?.ok === true, `C1 responde ok (abiertas ${r1?.abiertas}, ya estaban ${r1?.ya_estaban})`);
ok(!!mia.id, `C1 el punto activo nuevo tiene caja de hoy (${mia.id})`);
ok(Number(mia.saldo_apertura) === 0, `C1 saldo de apertura 0 (${mia.saldo_apertura})`);
ok(mia.estatus === 'abierta', `C1 queda abierta (${mia.estatus})`);
ok(mia.abierta_por === 'cron', `C1 actor 'cron', distinguible de una apertura humana (${mia.abierta_por})`);
ok(!c1.some(c => Number(c.id_punto) === idIna), `C1 el punto INACTIVO no recibe caja`);

console.log('\nCaso 2: adopta los huérfanos de HOY, y solo los de hoy');
const ad = uno(`select id_caja_dia from caja_movimientos where id = ${idHuerfano}`).id_caja_dia;
ok(Number(ad) === Number(mia.id), `C2 el huérfano de hoy quedó enganchado a la caja (${ad} = ${mia.id})`);
const ay = uno(`select id_caja_dia from caja_movimientos where id = ${idAyer}`).id_caja_dia;
ok(ay === null, `C2 el huérfano de AYER sigue suelto (${ay})`);

console.log('\nCaso 3: el movimiento de apertura');
const ap = uno(`select tipo, monto, descripcion from caja_movimientos
                 where id_caja_dia = ${mia.id} and tipo = 'apertura'`);
ok(ap.tipo === 'apertura' && Number(ap.monto) === 0, `C3 movimiento de apertura en 0 (${ap.tipo}, ${ap.monto})`);
ok(/autom/i.test(ap.descripcion || ''), `C3 la descripción dice que fue automática ("${ap.descripcion}")`);

console.log('\nCaso 4: correrla dos veces no duplica');
const antes = Number(uno(`select count(*)::int n from caja_dias where fecha = current_date`).n);
const r4 = abrir();
const despues = Number(uno(`select count(*)::int n from caja_dias where fecha = current_date`).n);
ok(antes === despues, `C4 mismas cajas tras la 2.ª corrida (${antes} = ${despues})`);
ok(Number(r4?.abiertas) === 0, `C4 la 2.ª corrida no abre ninguna (abiertas ${r4?.abiertas}, ya estaban ${r4?.ya_estaban})`);
const nAp = Number(uno(`select count(*)::int n from caja_movimientos where id_caja_dia = ${mia.id} and tipo = 'apertura'`).n);
ok(nAp === 1, `C4 un solo movimiento de apertura (${nAp})`);

console.log('\nCaso 5: no cierra nada');
ok(Number(uno(`select count(*)::int n from caja_dias where fecha = current_date and estatus <> 'abierta'`).n) === 0,
   `C5 ninguna caja de hoy quedó cerrada`);

console.log('\nCaso 6: el cron está programado');
const j = uno(`select schedule, active, command from cron.job where jobname = 'caja-abrir-dia'`);
ok(j.schedule === '5 6 * * *', `C6 horario 5 6 * * * = 00:05 CDMX (${j.schedule})`);
ok(j.active === true || j.active === 't', `C6 activo (${j.active})`);
ok(/abrir_cajas_del_dia/.test(j.command || ''), `C6 llama a abrir_cajas_del_dia`);

// ── Limpieza ────────────────────────────────────────────────────────────────
// Solo se desactivan los puntos de prueba. Las filas de caja_dias NO se borran:
// los movimientos de la prueba ya quedaron enganchados a ellas, y el libro es
// solo-altas. Con el punto inactivo nadie las vuelve a mirar ni el cron las abre.
sql(`update caja_puntos set activo = false where id in (${idAct}, ${idIna})`);
console.log(`\n${fallos} fallo(s).`);
process.exit(fallos ? 1 : 0);
