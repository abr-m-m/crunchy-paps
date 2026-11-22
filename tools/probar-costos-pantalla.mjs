#!/usr/bin/env node
// tools/probar-costos-pantalla.mjs — Las tres preguntas del frente A
// (migraciones 20261121000008 y 20261121000009).
//
// `costos_resumen`, `margen_resumen` y `punto_equilibrio` son del DUEÑO y las
// llama el navegador con la llave publishable. Por eso esta prueba llama por
// HTTP con esa misma llave —no por el CLI, que entra como postgres y no
// probaría ni el GRANT ni la puerta de `sesion_es_dueno`— (reglas 41 y 58).
//
// LO QUE ESTAS ASERCIONES NO HACEN: recalcular el costo con la misma fórmula y
// comparar. Eso solo demostraría que la copia funciona (regla 4). Comprueban
// PROPIEDADES que tienen que cumplirse pase lo que pase:
//
//   · el desglose SUMA el total (si un concepto se cae, la suma lo delata)
//   · el empaque está DENTRO del costo de la bolsa, no al lado
//   · los cuatro agrupamientos de margen cuadran ENTRE SÍ (un WHERE distinto
//     en uno de los cuatro sale aquí, y es el defecto que la función
//     `margen_lineas` existe para evitar)
//   · mover un lever mueve el resultado EN LA DIRECCIÓN correcta
//   · piezas_equilibrio × margen_contribucion cubre los fijos (definición)
//
// Escribe en STAGING: crea una sesión de vendedor de prueba y la borra.
// Necesita `node tools/ver-en-staging.mjs`.
// Uso: node tools/probar-costos-pantalla.mjs

import { writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STG = 'dkwatbsaidlfjqjnfyrk';
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging' || !SUPABASE_URL.includes(STG)) { console.error('No es staging: ' + SUPABASE_URL); process.exit(1); }
const H = { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' };
const rpc = async (n, b) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }); return { status: r.status, json: await r.json().catch(() => null) }; };
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };
const dir = mkdtempSync(join(tmpdir(), 'costospant-'));
const sql = (q) => { const f = join(dir, 'q.sql'); writeFileSync(f, q); const out = execSync(`supabase db query --linked --project-ref ${STG} -o json --file "${f}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); const i = out.indexOf('{'); return i < 0 ? [] : (JSON.parse(out.slice(i)).rows || []); };
const uno = (q) => (sql(q)[0] || {});
const num = (x) => (x === null || x === undefined ? NaN : Number(x));

// ── Una sesión de dueño de verdad, con el token hasheado como lo hace la app ──
// `resolver_sesion_vendedor` busca por sha256(token) y exige ≥32 caracteres.
sql(`delete from sesiones_vendedor where user_agent = 'ZZ-prueba-costos-pantalla'`);
const token = randomBytes(24).toString('hex');
const hash = createHash('sha256').update(token).digest('hex');
const rolDueno = (uno(`select lower(trim(rol)) r from vendedores where id = 1`).r || '');
sql(`insert into sesiones_vendedor (token_hash, id_vendedor, rol, expira_en, revocada, user_agent)
     values ('${hash}', 1, '${rolDueno}', now() + interval '1 hour', false, 'ZZ-prueba-costos-pantalla')`);

console.log('\nCaso 1: sin token de dueño, las tres dicen no');
// Regla 35: esconder un botón no es un permiso. La puerta está en el servidor,
// así que se prueba llamando sin credencial, no mirando si el botón se ve.
for (const f of ['costos_resumen', 'margen_resumen', 'punto_equilibrio']) {
  const r = await rpc(f, { p_data: {} });
  ok(r.status === 200 && r.json && r.json.ok === false,
     `C1 ${f} sin token: ${JSON.stringify(r.json && r.json.error || r.status)}`);
}
const basura = await rpc('costos_resumen', { p_data: { token: 'x'.repeat(40) } });
ok(basura.json && basura.json.ok === false, 'C1 y con un token inventado de 40 caracteres, tampoco');

console.log('\nCaso 2: el desglose de la base SUMA el costo por kilo');
// Si un concepto se cayera del desglose —o se contara dos veces— el total y la
// suma dejarían de cuadrar. Es la aserción que no se puede pasar copiando.
const cr = (await rpc('costos_resumen', { p_data: { token } })).json;
ok(cr && cr.ok === true, `C2 costos_resumen responde: ${cr && cr.ok}`);
const porKg = num(cr.base.por_kg), rinde = num(cr.base.rinde);
ok(porKg > 0 && rinde > 0, `C2 la base vale ${porKg} por kg y la tanda rinde ${rinde} kg`);
const sumaTanda = cr.base.lineas.reduce((a, l) => a + num(l.por_tanda), 0);
ok(Math.abs(sumaTanda / rinde - porKg) < 0.01,
   `C2 los ${cr.base.lineas.length} conceptos suman ${(sumaTanda / rinde).toFixed(4)} por kg`);
const pcts = cr.base.lineas.reduce((a, l) => a + num(l.pct), 0);
ok(Math.abs(pcts - 100) < 0.5, `C2 y sus porcentajes suman ${pcts.toFixed(1)} %`);

console.log('\nCaso 3: el empaque está DENTRO del costo de la bolsa');
// El defecto del disparador de esta misma mañana era exactamente este: la
// bolsa entraba en la receta y el costo no se movía.
const p100 = cr.presentaciones.find((p) => num(p.gramos) === 100);
ok(!!p100, 'C3 hay una presentación de 100 g en el resumen');
if (p100) {
  ok(num(p100.costo) > num(p100.base),
     `C3 la bolsa de 100 g cuesta ${p100.costo}, y su base sola ${p100.base}`);
  ok(Math.abs(num(p100.base) + num(p100.empaque) - num(p100.costo)) < 0.02,
     `C3 base ${p100.base} + empaque ${p100.empaque} = ${p100.costo}`);
  ok(num(p100.empaque) > 0, `C3 el empaque no es cero: ${p100.empaque}`);
}

console.log('\nCaso 4: el margen de consumidor es mayor que el de tienda');
// Propiedad del negocio, no de la fórmula: el consumidor paga más por la misma
// bolsa. Si saliera al revés, el costo se estaría aplicando a un precio que no
// le toca.
if (p100) {
  const mt = num(p100.margenes.tienda), mc = num(p100.margenes.consumidor);
  ok(mc > mt, `C4 consumidor ${mc} % > tienda ${mt} %`);
  const pt = num(p100.precios.tienda);
  ok(Math.abs((1 - num(p100.costo) / pt) * 100 - mt) < 0.15,
     `C4 y el margen de tienda es el del precio de tienda (${pt})`);
}

console.log('\nCaso 5: los avisos viajan CON el número');
// Un costo reconstruido que no se anuncia se usa como si fuera exacto.
ok(Array.isArray(cr.avisos) && cr.avisos.length > 0,
   `C5 ${cr.avisos.length} conceptos avisan de dónde salen`);
ok(cr.avisos.some((a) => /TECHO/i.test(a.nota || '')),
   'C5 y al menos uno dice que es un TECHO declarado, no una medida');
ok(cr.lever && num(cr.lever.valor) > 0,
   `C5 el lever está dicho donde se ve el número: ${cr.lever && cr.lever.valor} días por tanda`);

console.log('\nCaso 6: los cuatro agrupamientos del margen cuadran entre sí');
// EL CASO QUE JUSTIFICA `margen_lineas`. Los cuatro agregados salían de cuatro
// consultas con el mismo WHERE copiado; el día que una se desincronice, los
// totales dejan de cuadrar y sale aquí. Con una sola definición, no puede pasar.
const mr = (await rpc('margen_resumen', { p_data: { token } })).json;
ok(mr && mr.ok === true, `C6 margen_resumen responde: ${mr && mr.ok}`);
const tot = num(mr.total.neto);
for (const g of ['por_canal', 'por_mes', 'por_presentacion']) {
  const s = (mr[g] || []).reduce((a, x) => a + num(x.neto), 0);
  ok(Math.abs(s - tot) < 0.02, `C6 ${g} suma ${s.toFixed(2)} y el total es ${tot.toFixed(2)}`);
}
const costoTot = (mr.por_canal || []).reduce((a, x) => a + num(x.costo), 0);
ok(Math.abs(costoTot - num(mr.total.costo)) < 0.02,
   `C6 y el costo también: ${costoTot.toFixed(2)}`);
ok(num(mr.total.margen) === Math.round((num(mr.total.neto) - num(mr.total.costo)) * 100) / 100,
   `C6 el margen es neto − costo, no otra cosa: ${mr.total.margen}`);

console.log('\nCaso 7: mover un lever mueve el resultado, y en la dirección correcta');
const base2 = (await rpc('punto_equilibrio', { p_data: { token, gramos: 100, canal: 'tienda' } })).json;
ok(base2 && base2.ok === true, `C7 punto_equilibrio responde: ${base2 && base2.ok}`);
const unDia = (await rpc('punto_equilibrio', { p_data: { token, gramos: 100, canal: 'tienda', dias_por_tanda: 1 } })).json;
ok(num(unDia.costo) < num(base2.costo),
   `C7 embolsar el mismo día baja el costo: ${base2.costo} → ${unDia.costo}`);
ok(Math.abs(num(unDia.mano_obra_por_kg) * 2 - num(base2.mano_obra_por_kg)) < 0.02,
   `C7 y la mano de obra por kilo se parte justo a la mitad: ${base2.mano_obra_por_kg} → ${unDia.mano_obra_por_kg}`);
const papaCara = (await rpc('punto_equilibrio', { p_data: { token, gramos: 100, canal: 'tienda', precio_papa: 60 } })).json;
ok(num(papaCara.costo) > num(base2.costo),
   `C7 la papa a $60 encarece la bolsa: ${base2.costo} → ${papaCara.costo}`);
ok(num(papaCara.piezas_equilibrio) > num(base2.piezas_equilibrio) || papaCara.pierde === true,
   'C7 y hay que vender más piezas para cubrir los fijos (o ya se pierde)');

console.log('\nCaso 8: el punto de equilibrio CUBRE los fijos, por definición');
// No se compara contra una fórmula copiada: se comprueba la definición.
// piezas × margen de contribución tiene que cubrir los fijos, y una pieza
// menos ya no.
if (!base2.pierde) {
  const piezas = num(base2.piezas_equilibrio), mc = num(base2.margen_contribucion), fj = num(base2.fijos_mes);
  ok(piezas * mc >= fj - 0.01, `C8 ${piezas} piezas × ${mc} cubren los ${fj} de fijos`);
  ok((piezas - 1) * mc < fj, 'C8 y con una pieza menos ya no: es el punto, no un número de más');
  ok(num(base2.tiendas) > 0 && num(base2.kg_mes) > 0,
     `C8 traduce a ${base2.tiendas} tiendas y ${base2.kg_mes} kg al mes`);
}

console.log('\nCaso 9: a un precio por debajo del costo, dice que se pierde');
// Y NO devuelve un punto de equilibrio: con margen negativo no hay volumen que
// lo arregle, y dar un número ahí sería invitar a vender más para perder más.
const perder = (await rpc('punto_equilibrio', { p_data: { token, gramos: 100, canal: 'tienda', precio: 5 } })).json;
ok(perder.pierde === true, `C9 a $5 la bolsa: pierde = ${perder.pierde}`);
ok(perder.piezas_equilibrio === undefined || perder.piezas_equilibrio === null,
   'C9 y no inventa un punto de equilibrio');

console.log('\nCaso 10: la fecha manda — el costo de mayo no es el de hoy');
// El costo de la papa cambió 31 veces. Pedir el resumen a una fecha vieja tiene
// que dar el costo de ENTONCES, o el margen histórico sería falso.
const mayo = (await rpc('costos_resumen', { p_data: { token, fecha: '2026-05-31' } })).json;
ok(mayo && mayo.ok === true, 'C10 costos_resumen acepta una fecha');
ok(num(mayo.base.por_kg) !== num(cr.base.por_kg),
   `C10 el kilo de base en mayo (${mayo.base.por_kg}) no es el de hoy (${cr.base.por_kg})`);

// ── Limpieza ────────────────────────────────────────────────────────────────
sql(`delete from sesiones_vendedor where user_agent = 'ZZ-prueba-costos-pantalla'`);
ok(Number(uno(`select count(*) n from sesiones_vendedor where user_agent = 'ZZ-prueba-costos-pantalla'`).n) === 0,
   'Limpieza: no quedó la sesión de prueba');
const muerta = await rpc('costos_resumen', { p_data: { token } });
ok(muerta.json && muerta.json.ok === false, 'Limpieza: y el token borrado ya no abre nada');

console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
