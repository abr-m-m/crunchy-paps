#!/usr/bin/env node
// tools/probar-vencimiento.mjs — Los puntos del Crunchy Club vencen 12 meses después de ganarse (20260930000007).
// Spec: cambios/2026-09-19-club-vencimiento.md. FIFO por signo: todo positivo es un paquete con fecha; todo
// negativo consume los más viejos. Una RPC anónima no fabrica puntos de hace un año, así que los datos de
// prueba se escriben en STAGING con `supabase db query` (escritura: con permiso de Abraham por ejecución).
// Necesita `node tools/ver-en-staging.mjs`. Uso: node tools/probar-vencimiento.mjs
import { writeFileSync, mkdtempSync } from 'node:fs';
import { HTML, TODO } from './fuentes.mjs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STG = 'dkwatbsaidlfjqjnfyrk';
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging' || !SUPABASE_URL.includes(STG)) { console.error('No es staging: ' + SUPABASE_URL); process.exit(1); }
const H = { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' };
const SIN_CONEXION = ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET'];
const conReintento = async (fn) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 5 || !SIN_CONEXION.includes(e?.cause?.code)) throw e; await new Promise(r => setTimeout(r, 2000 * (i + 1))); } } };
const rpc = async (n, b) => { const r = await conReintento(() => fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })); return { status: r.status, json: await r.json().catch(() => null) }; };
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

// SQL directo a STAGING (nunca a otro ref). Devuelve las filas; si la consulta falla, lanza.
const dir = mkdtempSync(join(tmpdir(), 'vence-'));
const sql = (q) => {
  const f = join(dir, 'q.sql'); writeFileSync(f, q);
  const out = execSync(`supabase db query --linked --project-ref ${STG} -o json --file "${f}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.slice(out.indexOf('{'))).rows || [];
};
const sqlOVacio = (q) => { try { return sql(q); } catch (_e) { return null; } };
// Un asiento con fecha en el pasado. `hace` es un intervalo de Postgres ('13 months').
const asiento = (id, tipo, puntos, hace) => sql(
  `insert into public.lealtad_movimientos (id_cliente, tipo, puntos, nota, actor, fecha)
   values (${Number(id)}, '${tipo}', ${Number(puntos)}, 'prueba de vencimiento', 'probar-vencimiento', now() - interval '${hace}')
   returning id, fecha`)[0];
const vencer = (id) => { const r = sqlOVacio(`select public.vencer_puntos(${Number(id)}) as n`); return r ? Number(r[0].n) : null; };
const diaCDMX = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

const alta = async (nombre) => {
  const tel = '552' + String(Date.now()).slice(-7); await new Promise(r => setTimeout(r, 5));
  const ses = (await rpc('emitir_sesion_prueba', { p_telefono: tel })).json;
  const a = (await rpc('registrar_o_actualizar_cliente', { p_data: { telefono: tel, nombre, tipo: 'Consumidor', tipoId: 1, direccion: 'Calle 1', cp: '03400', colonia: 'Álamos', municipio: 'Benito Juárez', estado: 'CDMX', coordenadas: '' } })).json;
  return { tel, token: ses?.token, id: a?.idCliente };
};
const misPuntos = async (c) => (await rpc('mis_puntos', { p_token: c.token })).json;

// 1. FIFO: +100 hace 13 meses, +40 hace 2 meses, −30 de canje hace 1 mes → vencen 70, saldo 40.
const a = await alta('Vence FIFO');
asiento(a.id, 'generacion', 100, '13 months'); asiento(a.id, 'generacion', 40, '2 months'); asiento(a.id, 'canje', -30, '1 month');
const v1 = vencer(a.id);
const ma = await misPuntos(a);
const movA = (ma?.movimientos || []).filter(m => m.tipo === 'vencimiento');
ok(v1 === 70 && ma?.saldo === 40 && movA.length === 1 && movA[0].puntos === -70,
  `FIFO: vence ${v1} (esperado 70), saldo ${ma?.saldo} (40), asientos vencimiento ${movA.map(m => m.puntos).join(',')}`);
ok(/^Ganados hasta el \d{2}\/\d{2}\/\d{2}$/.test(movA[0]?.nota || ''), `nota del asiento: «${movA[0]?.nota}»`);

// 2. Idempotencia: otra corrida no vence nada más.
const v2 = vencer(a.id);
ok(v2 === 0 && (await misPuntos(a))?.saldo === 40, `segunda corrida: vence ${v2} (esperado 0)`);

// 3. Todo reciente: nada vence y no hay aviso.
const b = await alta('Vence Reciente');
asiento(b.id, 'generacion', 40, '2 months');
const v3 = vencer(b.id); const mb = await misPuntos(b);
ok(v3 === 0 && mb?.saldo === 40 && mb?.por_vencer == null, `reciente: vence ${v3}, saldo ${mb?.saldo}, por_vencer ${JSON.stringify(mb?.por_vencer)}`);

// 4. Aviso: +50 que cumplen 12 meses dentro de 10 días → por_vencer {50, esa fecha}, no vence todavía.
const d = await alta('Vence Pronto');
const lote = asiento(d.id, 'generacion', 50, '12 months - 10 days');
const esperada = sql(`select to_char((timestamptz '${lote.fecha}' + interval '12 months') at time zone 'America/Mexico_City', 'YYYY-MM-DD') as f`)[0].f;
const md = await misPuntos(d);
ok(md?.saldo === 50 && md?.por_vencer?.puntos === 50 && md?.por_vencer?.fecha && diaCDMX(md.por_vencer.fecha) === esperada,
  `aviso: saldo ${md?.saldo}, por_vencer ${JSON.stringify(md?.por_vencer)} (fecha esperada ${esperada})`);

// 5. mis_puntos vence por sí sola (sin cron): +20 hace 13 meses → saldo 0 y el movimiento aparece.
const f = await alta('Vence Solo');
asiento(f.id, 'generacion', 20, '13 months');
const mf = await misPuntos(f);
ok(mf?.saldo === 0 && (mf?.movimientos || []).some(m => m.tipo === 'vencimiento' && m.puntos === -20), `mis_puntos vence sola: saldo ${mf?.saldo}`);

// 6. crear_pedido no deja gastar lo vencido (payload real del front, como probar-canje).
const cat = (await rpc('canje_catalogo', {})).json;
const c0 = (cat?.productos || [])[0];
const prodsRaw = await conReintento(async () => (await fetch(`${SUPABASE_URL}/rest/v1/productos?select=id,sabor,presentacion,precio_consumidor&order=id`, { headers: H })).json());
const prod = (Array.isArray(prodsRaw) ? prodsRaw : []).find(p => p.id === c0?.id);
if (!c0 || !prod) { ok(false, 'sin catálogo de canje en staging'); }
else {
  const e = await alta('Vence Canje');
  asiento(e.id, 'generacion', c0.puntos * 2, '13 months');
  const precio = Number(prod.precio_consumidor);
  const r = (await rpc('crear_pedido', { p_data: {
    tokenCliente: e.token, idCliente: e.id, nombre: 'Vence Canje', telefono: e.tel, cp: '03400', colonia: 'Álamos', direccion: 'Calle 1', metodoEntrega: 'coordinar',
    total: precio, puntosCanje: c0.puntos,
    productos: [
      { idProducto: String(prod.id), sabor: prod.sabor, presentacion: prod.presentacion, tipoVenta: 'Por Pieza', cantidad: 1, gramos: 0, precio, subtotal: precio },
      { idProducto: String(c0.id), sabor: c0.sabor, presentacion: c0.presentacion, tipoVenta: 'Por Pieza', cantidad: 1, gramos: 0, precio: 0, subtotal: 0, canje: true, puntos: c0.puntos },
    ], idempotencyKey: 'vence-canje-' + e.tel } })).json;
  ok(r?.ok === false && r?.error === 'saldo_insuficiente', `canje con puntos vencidos → ${r?.error || (r?.ok ? 'ACEPTADO ' + r?.consecutivo : JSON.stringify(r).slice(0, 80))}`);
}

// 7. No es un endpoint: la llave anónima no ejecuta ni cuenta.
const antes = sql(`select count(*)::int as n from public.lealtad_movimientos where id_cliente = ${Number(a.id)}`)[0].n;
const anonV = await rpc('vencer_puntos', { p_cliente: a.id });
const anonP = await rpc('puntos_por_vencer', { p_cliente: a.id, p_corte: new Date().toISOString() });
const despues = sql(`select count(*)::int as n from public.lealtad_movimientos where id_cliente = ${Number(a.id)}`)[0].n;
const priv = sqlOVacio(`select has_function_privilege('anon', 'public.vencer_puntos(bigint)', 'execute') as v,
                               has_function_privilege('anon', 'public.puntos_por_vencer(bigint,timestamptz)', 'execute') as p,
                               has_function_privilege('authenticated', 'public.vencer_puntos(bigint)', 'execute') as va`);
ok(anonV.status >= 400 && anonP.status >= 400 && antes === despues && priv?.[0]?.v === false && priv?.[0]?.p === false && priv?.[0]?.va === false,
  `anon: vencer_puntos → ${anonV.status}, puntos_por_vencer → ${anonP.status}; privilegios ${JSON.stringify(priv?.[0] ?? 'sin funciones')}`);

// 8. La tarea nocturna existe.
const job = sqlOVacio(`select schedule, command, active from cron.job where jobname = 'club-vencer-puntos'`);
ok(job?.length === 1 && job[0].schedule === '10 6 * * *' && /vencer_puntos\(null\)/.test(job[0].command) && job[0].active === true,
  `cron: ${JSON.stringify(job ?? 'sin pg_cron')}`);

// 9. La app: aviso, filtro, y ningún «no caducan».
ok(HTML.includes('id="p-vence"') && HTML.includes('<option value="vencimiento">Vencidos</option>') && !/no caducan/i.test(TODO) && HTML.includes('vencen a los 12 meses'),
  'index.html: #p-vence, filtro Vencidos, «Cómo ganar puntos» avisa; «no caducan» en ningún archivo');

console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en orden.');
process.exitCode = fallos ? 1 : 0;
