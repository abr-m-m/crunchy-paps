#!/usr/bin/env node
// tools/probar-ruta-prioridad.mjs — piezas en anaquel y recompra visible en la ruta.
// Spec: cambios/2026-09-24-motor-comercial/diseno.md §B.1 y §B.2.
//
// CORRECCION AL PLAN, hallada al leer el codigo: `ruta_del_dia` arma los candidatos por prioridad
// pero DESPUES los reordena geograficamente por vecino mas cercano (bloque A3). Asi que la
// prioridad no decide el orden de visita, solo QUIEN entra cuando hay mas candidatos que el tope
// de 60 —y con 5 tiendas hoy entran todas—. Por eso estas pruebas NO afirman nada sobre la
// posicion de una parada: afirman que el dato de recompra LLEGA a la parada, que es lo que el
// vendedor va a ver al caminar. Una asercion sobre el orden pasaria o fallaria por la geografia
// del fixture, no por la prioridad (regla 53).
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
const dir = mkdtempSync(join(tmpdir(), 'prio-'));
const sql = (q) => { const f = join(dir, 'q.sql'); writeFileSync(f, q); const out = execSync(`supabase db query --linked --project-ref ${STG} -o json --file "${f}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); const i = out.indexOf('{'); return i < 0 ? [] : (JSON.parse(out.slice(i)).rows || []); };
const uno = (q) => (sql(q)[0] || {});
const sufijo = String(Date.now()).slice(-6);

// ── Fixture: una ruta PROPIA, para no tocar la cobertura de una ruta viva ───
// LAS VISITAS NO SE BORRAN: `visitas` es solo-INSERT y `trg_visitas_solo_insert` lo impide. No se
// rodea la guardia —protege el registro de trabajo de un vendedor—, así que el fixture de visitas se
// queda en staging con su prefijo ZZ-prio. Y como las visitas apuntan a los prospectos y clientes de
// prueba, esos tampoco se pueden borrar: se DESACTIVAN para que no vuelvan a salir en ninguna ruta.
// Cada corrida crea filas nuevas con sufijo propio, así que no colisionan.
const barrer = () => sql(`
  delete from ordenes_detalle where id_orden in (select id from ordenes where consecutivo like 'ZZ-PRIO%');
  delete from ordenes         where consecutivo like 'ZZ-PRIO%';
  update prospectos set estatus = 'descartado' where nombre_negocio like 'ZZ-prio%';
  update clientes   set aprobado_b2b = false, id_ruta = null where nombre like 'ZZ-prio%';
  delete from prospectos      where nombre_negocio like 'ZZ-prio%'
    and not exists (select 1 from visitas v where v.id_prospecto = prospectos.id);
  delete from clientes        where nombre like 'ZZ-prio%'
    and not exists (select 1 from visitas v where v.id_cliente = clientes.id);
  delete from rutas_cobertura where id_ruta in (select id from rutas where nombre like 'ZZ-prio%');
  update rutas set activa = false where nombre like 'ZZ-prio%';
  delete from rutas           where nombre like 'ZZ-prio%'
    and not exists (select 1 from visitas v where v.id_ruta = rutas.id)`);
barrer();

const ana = await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000001', pin: '1234' } });
if (!ana?.token) { ok(false, 'sesión de Ana'); process.exit(1); }
// validar_vendedor_pin devuelve {ok, token, expiraEn, vendedor}: el id va DENTRO de `vendedor`.
const idVend = Number(ana.vendedor?.id);
if (!idVend) { ok(false, `no salió el id del vendedor (${JSON.stringify(ana.vendedor)})`); process.exit(1); }

// Activa todos los días, para que ruta_del_dia la elija sea hoy lunes o domingo.
const idRuta = Number(uno(`insert into rutas (nombre, dias, dias_preventa, activa, orden, id_vendedor)
  values ('ZZ-prio ${sufijo}', '{0,1,2,3,4,5,6}', '{0,1,2,3,4,5,6}', true, 999, ${idVend}) returning id`).id);
// rutas_cobertura NO tiene columnas `colonia`/`cp`: tiene `tipo` ('colonia'|'cp') y `valor`.
sql(`insert into rutas_cobertura (id_ruta, tipo, valor) values (${idRuta}, 'colonia', 'ZZ-PRIO-COLONIA')`);

// Un CLIENTE que compró hace 30 días.
const idCli = Number(uno(`insert into clientes
  (nombre, nombre_comercial, telefono, tipo, tipo_id, colonia, cp, aprobado_b2b, id_ruta, latitud, longitud)
  values ('ZZ-prio Dormida ${sufijo}', 'ZZ-prio Dormida', '5591${sufijo}', 'Tienda / Abarrotes', 3,
          'ZZ-PRIO-COLONIA', '08930', true, ${idRuta}, 19.391, -99.125) returning id`).id);
sql(`insert into ordenes (consecutivo, canal, id_cliente, id_vendedor, fecha_orden, estatus_pedido,
                          estatus_pago, subtotal, total, tipo_interno)
     values ('ZZ-PRIO-${sufijo}', 'b2b', ${idCli}, ${idVend}, current_date - 30, 'Entregado',
             'Pagado', 500, 500, '')`);

// Un PROSPECTO nunca visitado y otro visitado AYER (que debe descansar).
const idProsp = Number(uno(`insert into prospectos
  (nombre_negocio, codigo_postal, colonia, estatus, score, latitud, longitud)
  values ('ZZ-prio Nuevo ${sufijo}', '08930', 'ZZ-PRIO-COLONIA', 'pendiente', 5, 19.392, -99.126) returning id`).id);
const idAyer = Number(uno(`insert into prospectos
  (nombre_negocio, codigo_postal, colonia, estatus, score, latitud, longitud)
  values ('ZZ-prio Ayer ${sufijo}', '08930', 'ZZ-PRIO-COLONIA', 'pendiente', 5, 19.393, -99.127) returning id`).id);
sql(`insert into visitas (id_prospecto, id_vendedor, resultado, nota, lat, lng, creada_en)
     values (${idAyer}, ${idVend}, 'no_estaba', 'ZZ-prio ayer', 19.393, -99.127, now() - interval '1 day')`);

const ruta = await rpc('ruta_del_dia', { p_data: { token: ana.token, idRuta: String(idRuta) } });
const paradas = ruta?.paradas || [];
ok(ruta?.ok === true && paradas.length > 0, `Fixture: ruta del día con ${paradas.length} paradas`);

console.log('\nC1: la parada del cliente trae su etapa y sus días sin comprar');
const pCli = paradas.find(p => p.tipo === 'cliente' && Number(p.id) === idCli);
ok(!!pCli, `C1 el cliente ${idCli} aparece en la ruta`);
ok(pCli?.etapa === 'dormido', `C1 la parada dice etapa 'dormido' (${pCli?.etapa})`);
ok(Number(pCli?.diasSinComprar) === 30, `C1 y 30 días sin comprar (${pCli?.diasSinComprar})`);

console.log('\nC2: registrar_visita guarda piezasEnAnaquel — en las DOS ramas (regla 59)');
const vCli = await rpc('registrar_visita', { p_data: { token: ana.token, idCliente: String(idCli),
  resultado: 'pedido', nota: 'ZZ-prio cliente', lat: 19.391, lng: -99.125, precision: 10, piezasEnAnaquel: 7 } });
ok(vCli?.ok === true, `C2 visita a cliente registrada (${vCli?.error || 'ok'})`);
ok(Number(uno(`select piezas_en_anaquel n from visitas where id = ${Number(vCli?.idVisita)}`).n) === 7,
   'C2 rama CLIENTE: guardó 7 piezas');

const vPro = await rpc('registrar_visita', { p_data: { token: ana.token, idProspecto: String(idProsp),
  resultado: 'interesado', nota: 'ZZ-prio prospecto', lat: 19.392, lng: -99.126, precision: 10, piezasEnAnaquel: 3 } });
ok(vPro?.ok === true, `C2 visita a prospecto registrada (${vPro?.error || 'ok'})`);
ok(Number(uno(`select piezas_en_anaquel n from visitas where id = ${Number(vPro?.idVisita)}`).n) === 3,
   'C2 rama PROSPECTO: guardó 3 piezas — la regla se aplicó en los dos sitios');

console.log('\nC3: un valor basura no tumba la visita, solo deja el dato en NULL');
const vMal = await rpc('registrar_visita', { p_data: { token: ana.token, idProspecto: String(idProsp),
  resultado: 'no_estaba', nota: 'ZZ-prio basura', lat: 19.392, lng: -99.126, precision: 10, piezasEnAnaquel: 'muchas' } });
ok(vMal?.ok === true, `C3 la visita se registra igual (${vMal?.error || 'ok'})`);
ok(uno(`select piezas_en_anaquel n from visitas where id = ${Number(vMal?.idVisita)}`).n === null,
   'C3 y el dato queda NULL, no 0 — «no lo preguntaron» no es «anaquel vacío»');

console.log('\nC4: las garantías viejas de ruta_del_dia siguen en pie');
ok(paradas.length <= 60, `C4 el tope sigue en 60 (${paradas.length})`);
ok(!paradas.some(p => p.tipo === 'prospecto' && Number(p.id) === idAyer),
   'C4 el prospecto visitado ayer sigue descansando y no aparece');
ok(paradas.some(p => p.tipo === 'prospecto' && Number(p.id) === idProsp),
   'C4 el prospecto nunca visitado sí aparece');

console.log('\nC5: sin ubicación no se registra la visita');
const vSinGps = await rpc('registrar_visita', { p_data: { token: ana.token, idProspecto: String(idProsp),
  resultado: 'interesado', nota: 'ZZ-prio sin gps', piezasEnAnaquel: 1 } });
ok(vSinGps?.ok !== true, `C5 rechazada sin lat/lng (${vSinGps?.error})`);

barrer();
// Una ruta que ya tiene visitas NO se puede borrar: el DELETE propaga un UPDATE a `visitas.id_ruta`
// y `trg_visitas_solo_insert` lo bloquea. Es la misma conducta que `set_rutas`, que desactiva en vez
// de borrar. Así que se comprueba que quede DESACTIVADA, no ausente.
ok(Number(uno(`select count(*) n from rutas where nombre like 'ZZ-prio%' and activa`).n) === 0,
   'Limpieza: ninguna ruta de prueba queda activa');
ok(Number(uno(`select count(*) n from prospectos where nombre_negocio like 'ZZ-prio%' and estatus <> 'descartado'`).n) === 0,
   'Limpieza: los prospectos que no se pueden borrar quedan descartados y fuera de ruta');
console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
