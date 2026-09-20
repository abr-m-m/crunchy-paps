#!/usr/bin/env node
// tools/medir-arranque.mjs — Mide el arranque de la app en un Chrome controlado
// por agent-browser: documento (bytes, TTFB, interactiva, load), primer pintado,
// si config.js y las fuentes bloquean, y cada petición a Supabase con su
// inicio→fin en ms. Con `--lento` emula una red móvil floja (400 ms de ida y
// vuelta, 1.6 Mb/s de bajada) tanto en la página como en el service worker,
// que es por donde pasan todas las peticiones de una página controlada.
//
//   export AGENT_BROWSER_SESSION=perf            # una sesión propia
//   agent-browser open about:blank; agent-browser set viewport 390 844
//   node tools/medir-arranque.mjs [--lento] [--n 3] [--url http://localhost:8794/]
//
// Es la receta del diagnóstico del 19 sep 2026 (cambios/2026-09-19-rendimiento-
// diagnostico.md), hecha repetible. Solo mide: no cambia nada.

import { execSync } from 'node:child_process';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const LENTO = process.argv.includes('--lento');
const N = Number(arg('--n', 3));
const URL_APP = arg('--url', 'http://localhost:8794/');
const RED = { offline: false, latency: 400, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 };

let cdp = arg('--cdp', '');
if (!cdp) cdp = execSync('agent-browser get cdp-url', { encoding: 'utf8' }).trim().split(String.fromCharCode(10)).pop().trim();
if (!/^ws:/.test(cdp)) { console.error('No tengo URL CDP:', cdp); process.exit(1); }

const ws = new WebSocket(cdp);
await new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = ko; });
let seq = 0; const pendientes = new Map(); const oyentes = [];
ws.onmessage = (m) => {
  const j = JSON.parse(m.data);
  if (j.id && pendientes.has(j.id)) { const { ok, ko } = pendientes.get(j.id); pendientes.delete(j.id); j.error ? ko(new Error(j.error.message)) : ok(j.result); }
  else if (j.method) oyentes.forEach((f) => f(j));
};
const enviar = (method, params = {}, sessionId) => new Promise((ok, ko) => {
  const id = ++seq; pendientes.set(id, { ok, ko }); ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const esperar = (method, sessionId, ms = 30000) => new Promise((ok, ko) => {
  const t = setTimeout(() => ko(new Error('esperando ' + method)), ms);
  oyentes.push(function f(j) { if (j.method === method && (!sessionId || j.sessionId === sessionId)) { clearTimeout(t); oyentes.splice(oyentes.indexOf(f), 1); ok(j.params); } });
});
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Red lenta también en los workers: se aplican al engancharse (los que ya existen
// y los que nazcan).
let avisadoWorker = false;
async function prepararSesion(sid, tipo) {
  try {
    await enviar('Network.enable', {}, sid);
    if (LENTO) await enviar('Network.emulateNetworkConditions', RED, sid);
  } catch (e) {
    if (!avisadoWorker) { avisadoWorker = true; console.error(`(aviso) no pude poner red lenta en un target ${tipo}: ${e.message})`); }
  }
}

const { targetInfos } = await enviar('Target.getTargets');
// La pestaña de la app, no la «nueva pestaña» de Chrome ni las internas.
const pagina = targetInfos.find((t) => t.type === 'page' && /^https?:/.test(t.url));
if (!pagina) { console.error('No hay pestaña con una URL http en esa sesión de agent-browser: abre la app primero.'); process.exit(1); }
const { sessionId: sid } = await enviar('Target.attachToTarget', { targetId: pagina.targetId, flatten: true });
await enviar('Page.enable', {}, sid);
await enviar('Runtime.enable', {}, sid);
await prepararSesion(sid, 'page');
// Workers (service worker sobre todo): se enganchan ya corriendo, sin pausarlos, y
// se les pone la misma red lenta. Se buscan cada 250 ms porque nacen durante la
// medición (el worker se registra al 'load' de la primera apertura). Con
// Target.setAutoAttach + waitForDebuggerOnStart el worker quedaba pausado y
// nunca se instalaba: la medición decía «sin worker» (19 sep 2026).
const vistos = new Set();
async function engancharWorkers() {
  const { targetInfos } = await enviar('Target.getTargets');
  for (const t of targetInfos.filter((t) => t.type === 'service_worker' && !vistos.has(t.targetId))) {
    vistos.add(t.targetId);
    try { const { sessionId } = await enviar('Target.attachToTarget', { targetId: t.targetId, flatten: true }); await prepararSesion(sessionId, t.type); } catch (_e) {}
  }
}
await engancharWorkers();
const vigia = setInterval(() => { engancharWorkers().catch(() => {}); }, 250);

// String.raw: las barras invertidas de las expresiones regulares llegan tal cual a la página.
const MEDIR = String.raw`(() => {
  const n = performance.getEntriesByType('navigation')[0];
  const rs = performance.getEntriesByType('resource');
  const sb = rs.filter(r => /supabase\.co/.test(r.name));
  const rpc = sb.map(r => r.name.replace(/^.*\/rest\/v1\//,'').replace(/^.*\/storage\/v1\//,'storage/').replace(/\?.*$/,'').slice(0,34) + ' ' + Math.round(r.startTime) + '>' + Math.round(r.responseEnd));
  const paint = performance.getEntriesByType('paint').map(p => p.name.replace('first-','') + ' ' + Math.round(p.startTime));
  const cfg = rs.find(r => /api\/config\.js/.test(r.name));
  const fonts = rs.filter(r => /fonts\.g/.test(r.name)).map(f => (f.name.includes('gstatic') ? 'woff' : 'css') + ' ' + Math.round(f.responseEnd) + ' ' + (f.renderBlockingStatus||''));
  return {
    doc: { transfer: n.transferSize, ttfb: Math.round(n.responseStart), respEnd: Math.round(n.responseEnd), domInteractive: Math.round(n.domInteractive), load: Math.round(n.loadEventEnd), delivery: n.deliveryType || '' },
    paint, config: cfg ? Math.round(cfg.startTime) + '>' + Math.round(cfg.responseEnd) + ' ' + (cfg.renderBlockingStatus||'') : null,
    fonts, rpc, catalogoActivo: !!document.querySelector('#s-catalogo.active'), sw: !!(navigator.serviceWorker && navigator.serviceWorker.controller)
  };
})()`;

console.log(`Midiendo ${URL_APP} · ${N} muestras · red ${LENTO ? 'LENTA (400 ms RTT, 1.6 Mb/s)' : 'normal'}`);
const filas = [];
for (let i = 1; i <= N; i++) {
  const cargado = esperar('Page.loadEventFired', sid, 90000);
  await enviar('Page.navigate', { url: URL_APP }, sid);
  await cargado;
  await dormir(1500);
  // Si la página registró un worker, se espera a que quede ACTIVO (instalación
  // incluida: con red lenta vuelve a bajar index.html) para que la siguiente
  // apertura ya lo tenga. Sin worker, se sigue a los 20 s.
  await enviar('Runtime.evaluate', { expression: `('serviceWorker' in navigator) ? Promise.race([navigator.serviceWorker.ready.then(() => 'listo'), new Promise((r) => setTimeout(() => r('sin worker'), 20000))]) : 'sin soporte'`, awaitPromise: true, returnByValue: true }, sid);
  const ev = await enviar('Runtime.evaluate', { expression: MEDIR, returnByValue: true, awaitPromise: true }, sid);
  if (ev.exceptionDetails || !ev.result || ev.result.value === undefined) { console.error('La medición falló en la página:', JSON.stringify(ev).slice(0, 600)); process.exit(1); }
  const r = ev.result.value;
  filas.push(r);
  const fcp = (r.paint.find((p) => p.startsWith('contentful')) || '? ?').split(' ')[1];
  const ultimoRpc = Math.max(0, ...r.rpc.filter((x) => !/^productos/.test(x)).map((x) => Number(x.split('>').pop())));
  console.log(`#${i}  doc ${r.doc.transfer} B ${r.doc.delivery || 'red'} · ttfb ${r.doc.ttfb} · respEnd ${r.doc.respEnd} · FCP ${fcp} · interactiva ${r.doc.domInteractive} · load ${r.doc.load} · último RPC ${ultimoRpc} · config ${r.config} · fuentes ${r.fonts.join(', ')} · sw ${r.sw}`);
  if (process.argv.includes('--detalle')) console.log('   rpc:', r.rpc.join(' | '));
}
const med = (k) => { const v = filas.map(k).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
console.log(`mediana  FCP ${med((r) => Number((r.paint.find((p) => p.startsWith('contentful')) || '0 0').split(' ')[1]))} · interactiva ${med((r) => r.doc.domInteractive)} · load ${med((r) => r.doc.load)} · último RPC ${med((r) => Math.max(0, ...r.rpc.filter((x) => !/^productos/.test(x)).map((x) => Number(x.split('>').pop()))))}`);
clearInterval(vigia);
ws.close();
