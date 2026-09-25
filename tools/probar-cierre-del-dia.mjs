#!/usr/bin/env node
// tools/probar-cierre-del-dia.mjs — el cierre del día del vendedor.
// Spec: cambios/2026-09-24-motor-comercial/diseno.md §B.4.
//
// Las dos que cargan el peso son C3 y C4: que cuente SOLO lo de hoy y SOLO lo de ese vendedor.
// Un cierre del día que sume lo de ayer, o lo de otro, le dice a alguien que trabajó cuando no.
//
// Escribe en STAGING. Necesita `node tools/ver-en-staging.mjs`.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STG = 'dkwatbsaidlfjqjnfyrk';
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging' || !SUPABASE_URL.includes(STG)) { console.error('No es staging: ' + SUPABASE_URL); process.exit(1); }
const H = { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' };
const rpc = async (n, b) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }); return await r.json().catch(() => null); };
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };
const dir = mkdtempSync(join(tmpdir(), 'cierre-'));
const sql = (q) => { const f = join(dir, 'q.sql'); writeFileSync(f, q); const out = execSync(`supabase db query --linked --project-ref ${STG} -o json --file "${f}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); const i = out.indexOf('{'); return i < 0 ? [] : (JSON.parse(out.slice(i)).rows || []); };
const uno = (q) => (sql(q)[0] || {});
const sufijo = String(Date.now()).slice(-6);

const ana   = await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000001', pin: '1234' } });
const carla = await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000003', pin: '1234' } });
if (!ana?.token || !carla?.token) { ok(false, 'sesiones'); process.exit(1); }
const idAna = Number(ana.vendedor?.id), idCarla = Number(carla.vendedor?.id);

// Línea base ANTES de escribir nada: staging ya tiene actividad de otras corridas, así que lo que
// se comprueba es el DELTA, no un total absoluto. Un total absoluto haría que esta prueba pasara
// o fallara según lo que hubiera corrido antes.
const antes = await rpc('cierre_del_dia', { p_data: { token: ana.token } });
ok(antes?.ok === true, `Línea base: ${antes?.visitadas} visitas y ${antes?.pedidos} pedidos hoy (${antes?.error || 'ok'})`);
const v0 = Number(antes?.visitadas || 0), p0 = Number(antes?.pedidos || 0), m0 = Number(antes?.monto || 0);

// ── Fixture: un prospecto de Ana, visitado HOY; y una visita de AYER que no debe contar ──
const idProsp = Number(uno(`insert into prospectos (nombre_negocio, codigo_postal, colonia, estatus, score, latitud, longitud)
  values ('ZZ-cierre ${sufijo}', '08300', 'Santa Anita', 'pendiente', 3, 19.3985, -99.1125) returning id`).id);
const vHoy = await rpc('registrar_visita', { p_data: { token: ana.token, idProspecto: String(idProsp),
  resultado: 'interesado', nota: 'ZZ-cierre hoy', lat: 19.3985, lng: -99.1125, precision: 10 } });
ok(vHoy?.ok === true, `Fixture: visita de hoy registrada (${vHoy?.error || 'ok'})`);
sql(`insert into visitas (id_prospecto, id_vendedor, resultado, nota, lat, lng, creada_en)
     values (${idProsp}, ${idAna}, 'no_estaba', 'ZZ-cierre ayer', 19.3985, -99.1125, now() - interval '1 day')`);
// Y una visita de HOY de OTRO vendedor, que tampoco debe contar en el cierre de Ana.
sql(`insert into visitas (id_prospecto, id_vendedor, resultado, nota, lat, lng)
     values (${idProsp}, ${idCarla}, 'no_estaba', 'ZZ-cierre carla', 19.3985, -99.1125)`);

console.log('\nC1: el cierre suma la visita de hoy');
const d1 = await rpc('cierre_del_dia', { p_data: { token: ana.token } });
ok(d1?.ok === true, `C1 responde ok (${d1?.error || 'ok'})`);
ok(Number(d1?.visitadas) === v0 + 1,
   `C1 una visita más que la línea base (${v0} → ${d1?.visitadas})`);

console.log('\nC2: exige la sección `ruta`');
const sinSesion = await rpc('cierre_del_dia', { p_data: { token: 'no-existe-' + sufijo } });
ok(sinSesion?.ok !== true, `C2 un token inválido no obtiene el cierre (${sinSesion?.error})`);
const beto = await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000002', pin: '1234' } });
if (beto?.token) {
  const sinSec = await rpc('cierre_del_dia', { p_data: { token: beto.token } });
  ok(sinSec?.ok !== true, `C2 Beto, sin la sección, tampoco (${sinSec?.error})`);
} else { ok(true, 'C2 Beto no existe en este staging, se omite'); }

console.log('\nC3: NO cuenta la visita de ayer');
// La de ayer se insertó arriba. Si contara, el delta sería 2 y no 1.
ok(Number(d1?.visitadas) - v0 === 1,
   `C3 el delta es exactamente 1: la de ayer quedó fuera (${d1?.visitadas} - ${v0})`);

console.log('\nC4: NO cuenta lo de OTRO vendedor');
// La visita de Carla es de hoy y del mismo prospecto: solo las separa el vendedor.
const dCarla = await rpc('cierre_del_dia', { p_data: { token: carla.token } });
ok(dCarla?.ok === true && Number(dCarla?.visitadas) >= 1,
   `C4 Carla ve la suya (${dCarla?.visitadas})`);
ok(dCarla?.vendedor !== d1?.vendedor,
   `C4 y cada uno ve su propio nombre (${d1?.vendedor} / ${dCarla?.vendedor})`);

console.log('\nC5: la fecha se puede pedir explícita, y ayer da otra cosa');
const ayer = uno(`select (current_date - 1)::text d`).d;
const dAyer = await rpc('cierre_del_dia', { p_data: { token: ana.token, fecha: ayer } });
ok(dAyer?.ok === true && dAyer?.fecha === ayer, `C5 responde para ${ayer} (${dAyer?.fecha})`);
ok(Number(dAyer?.visitadas) !== Number(d1?.visitadas) || v0 === 0,
   `C5 y el número de ayer no es el de hoy (${dAyer?.visitadas} vs ${d1?.visitadas})`);

// Limpieza: las visitas no se borran (solo-INSERT). El prospecto se descarta.
sql(`update prospectos set estatus = 'descartado' where nombre_negocio like 'ZZ-cierre%'`);
ok(Number(uno(`select count(*) n from prospectos where nombre_negocio like 'ZZ-cierre%' and estatus <> 'descartado'`).n) === 0,
   'Limpieza: el prospecto de prueba queda descartado (las visitas no se borran, es solo-INSERT)');

console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
