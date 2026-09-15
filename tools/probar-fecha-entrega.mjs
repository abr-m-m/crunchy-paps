#!/usr/bin/env node
// tools/probar-fecha-entrega.mjs — Comprueba contra STAGING que obtener_fecha_entrega
// respeta la hora límite configurable (cambios/2026-09-14-cola-de-pedidos.md, entrega 1).
//
//   1. get_hora_limite_config() responde ok con hora, diasNormal, diasTarde.
//   2. obtener_fecha_entrega() devuelve hoy+diasNormal antes de la hora y
//      hoy+diasTarde después (hora de CDMX), saltando domingo si evitar_domingos.
//   3. msg menciona la hora límite («Pedidos antes de las 18:00 …»).
//
// Necesita `node tools/ver-en-staging.mjs` corriendo (sirve la llave de staging).
// Uso: node tools/probar-fecha-entrega.mjs

const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging') { console.error('No es staging: ' + SUPABASE_URL); process.exit(1); }

const rpc = async (nombre, body) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${nombre}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

let fallos = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok    ' : '  FALLA ') + msg); if (!cond) fallos++; };

// 1. Configuración
const cfg = await rpc('get_hora_limite_config', {});
ok(cfg.status === 200 && cfg.json?.ok === true, `get_hora_limite_config responde ok (HTTP ${cfg.status})`);
const hora = cfg.json?.hora, dN = Number(cfg.json?.diasNormal), dT = Number(cfg.json?.diasTarde);
ok(/^\d{2}:\d{2}$/.test(hora || ''), `hora con forma HH:MM (${hora})`);
ok(Number.isInteger(dN) && Number.isInteger(dT) && dT >= dN, `diasNormal ${dN} ≤ diasTarde ${dT}`);

// 2. Fecha esperada, calculada aquí con la hora de CDMX
const ahoraCdmx = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
const [hh, mm] = String(hora || '18:00').split(':').map(Number);
const antesDeLaHora = ahoraCdmx.getHours() < hh || (ahoraCdmx.getHours() === hh && ahoraCdmx.getMinutes() < mm);
const esperada = new Date(ahoraCdmx); esperada.setHours(12, 0, 0, 0);
esperada.setDate(esperada.getDate() + (antesDeLaHora ? dN : dT));
if (cfg.json?.evitarDomingos !== false && esperada.getDay() === 0) esperada.setDate(esperada.getDate() + 1);
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fe = await rpc('obtener_fecha_entrega', { p_data: {} });
ok(fe.status === 200 && fe.json?.ok === true, `obtener_fecha_entrega responde ok (HTTP ${fe.status})`);
ok(fe.json?.fecha === iso(esperada), `fecha ${fe.json?.fecha} = esperada ${iso(esperada)} (${antesDeLaHora ? 'antes' : 'después'} de las ${hora}, CDMX ${ahoraCdmx.toTimeString().slice(0, 5)})`);
ok(typeof fe.json?.msg === 'string' && fe.json.msg.includes(hora || '18:00'), `msg menciona la hora límite: «${fe.json?.msg}»`);
ok(typeof fe.json?.fechaDisplay === 'string' && fe.json.fechaDisplay.length > 0, 'fechaDisplay sigue viniendo (el checkout lo usa de respaldo)');

console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en orden.');
process.exit(fallos ? 1 : 0);
