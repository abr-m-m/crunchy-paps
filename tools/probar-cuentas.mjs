#!/usr/bin/env node
// tools/probar-cuentas.mjs — la vista `cuentas` y la etapa CALCULADA (D7).
// Spec: cambios/2026-09-24-motor-comercial/diseno.md §A.
//
// La aserción central es C2: la etapa cambia sola por una visita, sin que nadie escriba un estado.
// Si hiciera falta escribirlo a mano, D7 no se cumplió y la etapa se desincronizaría de los pedidos
// en cuanto alguien olvide tocar el botón — que es justo lo que pasa hoy con `prospectos.estatus`,
// donde 1,129 filas dicen `pendiente` sin que nadie lo haya comprobado.
//
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
const dir = mkdtempSync(join(tmpdir(), 'cuentas-'));
const sql = (q) => { const f = join(dir, 'q.sql'); writeFileSync(f, q); const out = execSync(`supabase db query --linked --project-ref ${STG} -o json --file "${f}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); const i = out.indexOf('{'); return i < 0 ? [] : (JSON.parse(out.slice(i)).rows || []); };
const uno = (q) => (sql(q)[0] || {});
const sufijo = String(Date.now()).slice(-6);

const barrer = () => sql(`
  delete from visitas    where nota like 'ZZ-cuentas%';
  delete from prospectos where nombre_negocio like 'ZZ-cuentas%'`);
barrer();

console.log('\nC1: un prospecto sin visitas está en `pendiente`');
const idP = Number(uno(`insert into prospectos (nombre_negocio, codigo_postal, colonia, estatus, score)
  values ('ZZ-cuentas Tienda ${sufijo}', '08930', 'Agricola Oriental', 'pendiente', 3) returning id`).id);
ok(uno(`select etapa from cuentas where id_cuenta = 'p${idP}'`).etapa === 'pendiente',
   `C1 el prospecto ${idP} nace en pendiente`);

console.log('\nC2: una visita lo mueve sin que nadie escriba el estado');
sql(`insert into visitas (id_prospecto, id_vendedor, resultado, nota, lat, lng)
     values (${idP}, 1, 'interesado', 'ZZ-cuentas prueba', 19.39, -99.12)`);
const etapaTrasVisita = uno(`select etapa from cuentas where id_cuenta = 'p${idP}'`).etapa;
const estatusEnTabla  = uno(`select estatus from prospectos where id = ${idP}`).estatus;
ok(etapaTrasVisita === 'interesado',
   `C2 pasa a interesado solo por la visita (${etapaTrasVisita})`);
ok(estatusEnTabla === 'pendiente',
   `C2 y prospectos.estatus NO se tocó: sigue en '${estatusEnTabla}' — la etapa es calculada`);

console.log('\nC3: la última visita manda, y descartado tiene precedencia');
sql(`insert into visitas (id_prospecto, id_vendedor, resultado, nota, lat, lng)
     values (${idP}, 1, 'no_le_interesa', 'ZZ-cuentas prueba', 19.39, -99.12)`);
ok(uno(`select etapa from cuentas where id_cuenta = 'p${idP}'`).etapa === 'descartado',
   'C3 tras no_le_interesa queda descartado');

console.log('\nC4: un cliente con 1 pedido es `cliente`; con 2, `activo`; y si calla, `dormido`');
const conUno = uno(`select 'c'||o.id_cliente c from ordenes o
  where coalesce(o.tipo_interno,'')='' and o.estatus_pedido<>'Cancelado' and o.id_cliente is not null
    and o.id_cliente <> 999999 group by o.id_cliente having count(*) = 1 limit 1`).c;
const conDos = uno(`select 'c'||o.id_cliente c from ordenes o
  where coalesce(o.tipo_interno,'')='' and o.estatus_pedido<>'Cancelado' and o.id_cliente is not null
    and o.id_cliente <> 999999 group by o.id_cliente having count(*) >= 2 limit 1`).c;
const e1 = uno(`select etapa, pedidos::text p, dias_sin_comprar::text d from cuentas where id_cuenta = '${conUno}'`);
const e2 = uno(`select etapa, pedidos::text p, dias_sin_comprar::text d from cuentas where id_cuenta = '${conDos}'`);
ok(['cliente','dormido'].includes(e1.etapa), `C4 ${conUno}: ${e1.p} pedido, ${e1.d} días → ${e1.etapa}`);
ok(['activo','dormido'].includes(e2.etapa), `C4 ${conDos}: ${e2.p} pedidos, ${e2.d} días → ${e2.etapa}`);
// La precedencia de D8: dormido gana a activo. Lo que importa de una tienda que compró dos veces
// y lleva un mes callada es que está callada.
ok(Number(e2.d) <= 21 ? e2.etapa === 'activo' : e2.etapa === 'dormido',
   `C4 la precedencia dormido>activo se respeta (${e2.d} días → ${e2.etapa})`);

console.log('\nC5: los CP quedaron limpios');
const sucios = Number(uno(`select count(*) n from prospectos where codigo_postal ~ '[^0-9]'`).n);
ok(sucios === 0, `C5 no quedan CP con caracteres no numéricos (${sucios})`);
// Y que no vuelvan a entrar sucios.
const idSucio = Number(uno(`insert into prospectos (nombre_negocio, codigo_postal, colonia, estatus)
  values ('ZZ-cuentas Sucio ${sufijo}', '''08930', 'Agricola Oriental', 'pendiente') returning id`).id);
ok(uno(`select codigo_postal cp from prospectos where id = ${idSucio}`).cp === '08930',
   'C5 un alta con apóstrofo se limpia al entrar');

console.log('\nC6: `estatus` ya no acepta cualquier cosa');
let colado = false;
try { sql(`update prospectos set estatus = 'inventado' where id = ${idP}`); colado = true; } catch (e) { /* esperado */ }
ok(!colado, 'C6 el CHECK rechaza un estatus fuera del catálogo');

barrer();
ok(Number(uno(`select count(*) n from prospectos where nombre_negocio like 'ZZ-cuentas%'`).n) === 0,
   'Limpieza: fixture fuera de staging');
console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
