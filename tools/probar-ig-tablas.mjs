#!/usr/bin/env node
// tools/probar-ig-tablas.mjs — las tres tablas del radar, la lista semilla y radar_informe.
//
// Lo que prueba de verdad:
//  · que la llave publica NO alcanza ninguna de las tres tablas (las dos cerraduras, regla 41),
//  · que radar_informe no suelta nada sin la sesion del dueno,
//  · que la lista semilla entro ENTERA y en `por_comprobar` (D7: nadie la ha verificado),
//  · y que ig_medios guarda DOS lecturas del mismo reel sin pisarse, que es de lo que depende
//    poder comparar con la semana pasada.
//
// Escribe en STAGING. Necesita `node tools/ver-en-staging.mjs` levantado.
// Plan: cambios/2026-11-13-radar-instagram-plan.md, tarea 2.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STG = 'dkwatbsaidlfjqjnfyrk';

const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(
  cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging' || !SUPABASE_URL.includes(STG)) {
  console.error('No es staging: ' + SUPABASE_URL);
  process.exit(1);
}

const H = {
  apikey: SUPABASE_ANON_KEY,
  authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  'content-type': 'application/json',
};
const rest = (ruta, opts) => fetch(`${SUPABASE_URL}/rest/v1/${ruta}`, { headers: H, ...opts });
const rpc = async (n, b) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, {
    method: 'POST', headers: H, body: JSON.stringify(b ?? {}),
  });
  return r.json().catch(() => null);
};

const dir = mkdtempSync(join(tmpdir(), 'ig-tablas-'));
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

try {
  console.log('\nLas tres tablas estan cerradas a la llave publica');
  // El cuerpo del POST tiene que ser VALIDO para cada tabla. La primera version
  // mandaba {usuario:'colado'} a las tres, y en ig_informes daba 400 (columna
  // que no existe) antes de llegar a la comprobacion de permisos: el 401 nunca
  // se probaba ahi. Un 400 no dice nada sobre si la puerta esta cerrada.
  const CUERPO = {
    ig_cuentas:  { usuario: 'colado', grupo: 'local' },
    ig_medios:   { usuario: 'colado', id_medio: 'X' },
    ig_informes: { fecha: '2026-01-01' },
  };
  for (const t of ['ig_cuentas', 'ig_medios', 'ig_informes']) {
    const g = await rest(`${t}?select=*&limit=1`);
    ok(g.status === 401, `${t}: GET da 401 (dio ${g.status})`);
    const p = await rest(t, { method: 'POST', body: JSON.stringify(CUERPO[t]) });
    ok(p.status === 401, `${t}: POST con cuerpo valido da 401 (dio ${p.status})`);
  }

  console.log('\nradar_informe no suelta nada sin la sesion del dueno');
  const sinToken = await rpc('radar_informe', { p_data: {} });
  ok(sinToken && sinToken.ok === false, 'sin token: ok = false');
  ok(sinToken && sinToken.error === 'No autorizado', `error = No autorizado (dio: ${sinToken && sinToken.error})`);
  ok(!JSON.stringify(sinToken || {}).includes('papassabritas'),
    'y no se le escapa ni un nombre de cuenta en el mensaje de error');

  const tokenFalso = await rpc('radar_informe', { p_data: { token: 'no-soy-un-token' } });
  ok(tokenFalso && tokenFalso.error === 'No autorizado', 'un token inventado tampoco pasa');

  console.log('\nradar_informe con la sesion del dueno');
  const ana = await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000001', pin: '1234' } });
  ok(Boolean(ana && ana.token), 'la sesion de Ana (duena en staging) se abre');
  const conToken = await rpc('radar_informe', { p_data: { token: ana && ana.token } });
  ok(conToken && conToken.ok === true,
    conToken && conToken.ok ? 'ok = true' : `ok = true (fallo con: ${conToken && conToken.error})`);
  ok(Array.isArray(conToken && conToken.cuentas), 'devuelve la lista de cuentas');

  console.log('\nLa lista semilla entro entera y sin verificar');
  const c = uno(`select
      count(*)::int                                            as total,
      count(*) filter (where estado = 'por_comprobar')::int     as sin_verificar,
      count(*) filter (where grupo = 'grande')::int             as grandes,
      count(*) filter (where grupo = 'local')::int              as locales,
      count(*) filter (where grupo = 'propia')::int             as propias,
      count(*) filter (where grupo = 'artesanal')::int          as artesanales
    from ig_cuentas`);
  ok(Number(c.total) === 22, `22 cuentas (hay ${c.total})`);
  ok(Number(c.sin_verificar) === 22, `las 22 en por_comprobar: nadie las ha verificado (hay ${c.sin_verificar})`);
  ok(Number(c.grandes) === 1, `1 marca grande (hay ${c.grandes})`);
  ok(Number(c.locales) === 20, `20 de comida CDMX (hay ${c.locales})`);
  ok(Number(c.propias) === 1, `1 propia (hay ${c.propias})`);
  ok(Number(c.artesanales) === 0,
    `0 artesanales, y eso es el hueco real de la lista, no un error (hay ${c.artesanales})`);

  const cp = uno(`select grupo from ig_cuentas where usuario = 'crunchy.papsmx'`);
  ok(cp.grupo === 'propia', 'la cuenta propia esta y esta bien etiquetada');
  const sab = uno(`select nota from ig_cuentas where usuario = 'papassabritas'`);
  ok(Boolean(sab.nota), 'cada cuenta trae de donde salio, para poder dudar de ella despues');

  console.log('\nVolver a aplicar la migracion no duplica ni pisa');
  sql(`update ig_cuentas set estado = 'ok' where usuario = 'papassabritas'`);
  sql(`insert into ig_cuentas (usuario, grupo, estado, nota)
       values ('papassabritas', 'grande', 'por_comprobar', 'duplicada')
       on conflict (usuario) do nothing`);
  const tras = uno(`select estado, count(*) over ()::int as n from ig_cuentas where usuario = 'papassabritas'`);
  ok(Number(tras.n) === 1, 'sigue habiendo una sola fila');
  ok(tras.estado === 'ok', 'y el estado ya comprobado NO se pisa');
  sql(`update ig_cuentas set estado = 'por_comprobar' where usuario = 'papassabritas'`);

  console.log('\nig_medios guarda el historico: dos lecturas del mismo reel no se pisan');
  sql(`delete from ig_medios where usuario = 'prueba.radar'`);
  sql(`insert into ig_medios (usuario, id_medio, tipo, vistas, me_gusta, comentarios, leido_en)
       values ('prueba.radar', 'MEDIO-1', 'REELS', 500, 50, 5, now() - interval '7 days'),
              ('prueba.radar', 'MEDIO-1', 'REELS', 900, 70, 8, now())`);
  const h = sql(`select vistas from ig_medios where usuario = 'prueba.radar' and id_medio = 'MEDIO-1' order by leido_en`);
  ok(h.length === 2, `hay 2 lecturas del mismo reel (hay ${h.length})`);
  ok(Number(h[0].vistas) === 500 && Number(h[1].vistas) === 900,
    'y se ve crecer de 500 a 900, que es de lo que depende comparar semanas');
  sql(`delete from ig_medios where usuario = 'prueba.radar'`);
} finally {
  try { sql(`delete from ig_medios where usuario = 'prueba.radar'`); } catch {}
}

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
