#!/usr/bin/env node
// tools/probar-alta-b2b.mjs — Un alta B2B no se aprueba a sí misma
// (migración 20261002000000_alta_b2b_no_autoaprobada).
//
// `registrar_o_actualizar_cliente` es SECURITY DEFINER y `anon` tiene EXECUTE,
// así que se alcanza con la llave publishable. Hasta el 21 sep 2026 el NIVEL DE
// APROBACIÓN venía en el payload: `{"tipoId": 3, "aprobadoB2B": true}` creaba
// una tienda ya aprobada, y `crear_pedido` le cobraba a precio de mayoreo.
//
// Esta prueba llama por HTTP con la MISMA llave pública que usaría cualquiera
// —no por el CLI, que entra como postgres y no probaría la puerta— y luego lee
// la fila con `supabase db query`, porque `anon` no tiene SELECT sobre
// `clientes`: comprobar lo que devuelve el RPC no basta, hay que mirar lo que
// quedó escrito.
//
// Escribe en STAGING (crea clientes de prueba y los borra al final): con
// permiso de Abraham. Necesita `node tools/ver-en-staging.mjs`.
// Uso: node tools/probar-alta-b2b.mjs

import { writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STG = 'dkwatbsaidlfjqjnfyrk';
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging' || !SUPABASE_URL.includes(STG)) { console.error('No es staging: ' + SUPABASE_URL); process.exit(1); }
const H = { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' };
const rpc = async (n, b) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }); return { status: r.status, json: await r.json().catch(() => null) }; };
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

const dir = mkdtempSync(join(tmpdir(), 'altab2b-'));
const sql = (q) => { const f = join(dir, 'q.sql'); writeFileSync(f, q); const out = execSync(`supabase db query --linked --project-ref ${STG} -o json --file "${f}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return JSON.parse(out.slice(out.indexOf('{'))).rows || []; };

// Teléfonos de 10 dígitos únicos por corrida, para no chocar con nada sembrado.
const suf = String(Date.now()).slice(-6);
const TEL_B2B  = '5590' + suf;
const TEL_CONS = '5591' + suf;
const TELS = [TEL_B2B, TEL_CONS];
const fila = (tel) => sql(`select id, tipo_id, aprobado_b2b from public.clientes
  where right(regexp_replace(telefono, '\\D', '', 'g'), 10) = '${tel}' limit 1`)[0] || null;

console.log(`\nAlta B2B que no se aprueba sola — staging (${STG})\n`);

// 1. Lo que hacía el agujero: tienda pidiendo nacer aprobada.
const b2b = (await rpc('registrar_o_actualizar_cliente', { p_data: {
  telefono: TEL_B2B, nombre: 'Prueba Alta B2B', tipo: 'Tienda / Abarrotes', tipoId: 3, aprobadoB2B: true } })).json;
const fB2B = fila(TEL_B2B);
ok(b2b?.ok === true && b2b?.esNuevo === true, `alta de tienda: ${JSON.stringify(b2b).slice(0, 80)}`);
ok(fB2B?.tipo_id === 3 && fB2B?.aprobado_b2b === false,
  `tienda pidiendo aprobadoB2B:true nace SIN aprobar → tipo ${fB2B?.tipo_id}, aprobado_b2b ${fB2B?.aprobado_b2b} (esperado false)`);

// 2. El consumidor no pasa por ninguna puerta: sigue naciendo aprobado.
const cons = (await rpc('registrar_o_actualizar_cliente', { p_data: {
  telefono: TEL_CONS, nombre: 'Prueba Alta Consumidor', tipo: 'Consumidor', tipoId: 1 } })).json;
const fCons = fila(TEL_CONS);
ok(cons?.ok === true && fCons?.aprobado_b2b === true,
  `consumidor sigue naciendo aprobado → aprobado_b2b ${fCons?.aprobado_b2b} (esperado true)`);

// 3. Aprobar por la puerta buena y comprobar que actualizar NO la tira: si el
//    UPDATE tocara aprobado_b2b, arreglar el alta habría roto a los clientes
//    ya aprobados, que es el daño colateral que hay que descartar.
sql(`update public.clientes set aprobado_b2b = true where id = ${fB2B?.id}`);
const upd = (await rpc('registrar_o_actualizar_cliente', { p_data: {
  telefono: TEL_B2B, direccion: 'Calle Nueva 123', aprobadoB2B: false } })).json;
const fTras = fila(TEL_B2B);
ok(upd?.ok === true && upd?.esNuevo === false && fTras?.aprobado_b2b === true,
  `actualizar una tienda YA aprobada no la desaprueba → esNuevo ${upd?.esNuevo}, aprobado_b2b ${fTras?.aprobado_b2b} (esperado true)`);

// 4. El error no le entrega el interior de Postgres a quien llama: `tipoId`
//    basura revienta el cast y cae en el EXCEPTION.
const err = (await rpc('registrar_o_actualizar_cliente', { p_data: {
  telefono: '5592' + suf, nombre: 'x', tipoId: 'abc' } })).json;
const filtra = /invalid input syntax|integer|SQLSTATE|pg_|::/i.test(String(err?.error || ''));
ok(err?.ok === false && !filtra, `tipoId basura → ${JSON.stringify(err)} (sin SQLERRM crudo)`);

// Limpieza: los clientes de prueba se borran; son altas nuevas sin pedidos.
const borrados = sql(`delete from public.clientes
  where right(regexp_replace(telefono, '\\D', '', 'g'), 10) in (${TELS.map((t) => `'${t}'`).join(', ')})
  returning id`);
console.log(`  (borrados ${borrados.length} clientes de prueba)`);

console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en orden.');
process.exitCode = fallos ? 1 : 0;
