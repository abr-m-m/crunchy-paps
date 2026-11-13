#!/usr/bin/env node
// tools/probar-wa-identidad.mjs — wa_identidad (20261112000000).
//
// Lo que prueba de verdad: que el nivel de precio que devuelve wa_identidad es EL MISMO
// que usa crear_pedido. Por eso el caso 2 no compara contra un numero escrito a mano, sino
// contra cotizar_linea, que es de donde sale el precio que se cobra (regla 58: verificar con
// un metodo distinto del que hizo el cambio).
//
// Si estas dos verdades se separan, el agente cotiza a un nivel y el servidor crea el pedido
// a otro, en silencio. Esa es la razon de que wa_identidad exista como RPC y no como codigo
// JavaScript (D5 del diseno, cambios/2026-11-12-agente-whatsapp.md).
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

const dir = mkdtempSync(join(tmpdir(), 'wa-identidad-'));
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

const sufijo = String(Date.now()).slice(-6);
const tel = '555' + String(Date.now()).slice(-7);

// ── Fixtures ────────────────────────────────────────────────────────────────
// Un producto con un precio DISTINTO en cada canal: si el nivel se confunde, el precio canta.
const idProd = Number(uno(`insert into productos
  (sabor, presentacion, gramos, precio_consumidor, precio_tienda, precio_restaurante,
   precio_mostrador, precio_mayorista, tipo_venta, activo)
  values ('WA-${sufijo}', '100g', 100, 40, 25, 30, 40, 20, 1, true) returning id`).id);

const idCli = Number(uno(`insert into clientes (nombre, telefono, tipo, tipo_id, aprobado_b2b)
  values ('Tienda WA ${sufijo}', '${tel}', 'Tienda', 3, true) returning id`).id);

const limpiar = () => {
  try { sql(`delete from clientes where id = ${idCli}`); } catch {}
  try { sql(`delete from productos where id = ${idProd}`); } catch {}
};

try {
  console.log(`\nFixtures: cliente ${idCli} (tel ${tel}), producto ${idProd}\n`);

  console.log('Caso 1 — tienda aprobada');
  const r1 = uno(`select wa_identidad('${tel}') as j`).j;
  ok(r1?.ok === true, 'ok = true');
  ok(r1?.esCliente === true, 'esCliente = true');
  ok(Number(r1?.idCliente) === idCli, `idCliente = ${idCli} (devolvio: ${r1?.idCliente})`);
  ok(r1?.nivel === 'tienda', `nivel = tienda (devolvio: ${r1?.nivel})`);
  ok(r1?.aprobadoB2B === true, 'aprobadoB2B = true');
  ok(r1?.nombre === `Tienda WA ${sufijo}`, 'nombre');

  console.log('\nCaso 2 — el nivel coincide con el precio que cobra el servidor');
  const cot = uno(`select cotizar_linea(${idProd}, '${r1?.nivel}', 1, 0) as j`).j;
  ok(Number(cot?.subtotal) === 25,
    `cotizar_linea con el nivel devuelto cobra precio de tienda ($25, dio $${cot?.subtotal})`);

  console.log('\nCaso 3 — el telefono con formato humano empareja igual');
  const humano = `+52 55 ${tel.slice(0, 4)} ${tel.slice(4)}`;
  const r3 = uno(`select wa_identidad('${humano}') as j`).j;
  ok(Number(r3?.idCliente) === idCli, `empareja por los ultimos 10 digitos ("${humano}")`);

  console.log('\nCaso 4 — tienda NO aprobada cobra como consumidor');
  sql(`update clientes set aprobado_b2b = false where id = ${idCli}`);
  const r4 = uno(`select wa_identidad('${tel}') as j`).j;
  ok(r4?.nivel === 'consumidor', `sin aprobado_b2b, nivel = consumidor (dio: ${r4?.nivel})`);
  ok(r4?.aprobadoB2B === false, 'aprobadoB2B = false');
  const cot4 = uno(`select cotizar_linea(${idProd}, '${r4?.nivel}', 1, 0) as j`).j;
  ok(Number(cot4?.subtotal) === 40, `y el precio pasa a consumidor ($40, dio $${cot4?.subtotal})`);
  sql(`update clientes set aprobado_b2b = true where id = ${idCli}`);

  console.log('\nCaso 5 — numero desconocido');
  // El numero se comprueba libre ANTES de usarlo. La primera version de esta prueba
  // uso '5599999999' dandolo por inexistente y fallo: en staging es el cliente 301,
  // "Prueba Despliegue". El fallo era de la prueba, no de la funcion.
  const telLibre = '544' + String(Date.now()).slice(-7);
  const ocupado = Number(uno(`select count(*) as n from clientes
    where right(regexp_replace(coalesce(telefono,''), '\\D', '', 'g'), 10) = '${telLibre}'`).n);
  ok(ocupado === 0, `el numero ${telLibre} esta libre en staging (si no, la prueba no vale)`);
  const r5 = uno(`select wa_identidad('${telLibre}') as j`).j;
  ok(r5?.ok === true, 'ok = true (no es un error: es alguien nuevo)');
  ok(r5?.esCliente === false, 'esCliente = false');
  ok(r5?.nivel === 'consumidor', 'nivel = consumidor');
  ok(r5?.idCliente === null, 'idCliente = null');

  console.log('\nCaso 6 — telefono invalido');
  const r6 = uno(`select wa_identidad('123') as j`).j;
  ok(r6?.ok === false, 'ok = false');
  ok(r6?.error === 'telefono_invalido', `error = telefono_invalido (dio: ${r6?.error})`);
} finally {
  limpiar();
}

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
