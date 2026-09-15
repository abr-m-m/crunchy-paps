// ============================================================================
//  Crunchy Paps — Push «Pedido nuevo» al personal · /api/push-enviar.js
//
//  Lo llama un Database Webhook de Supabase (producción) en cada INSERT de
//  public.ordenes, con `Authorization: Bearer <PUSH_WEBHOOK_SECRET>`. Lee las
//  suscripciones de push_suscripciones con service_role, firma con VAPID y
//  envía. Borra las suscripciones que el navegador ya dio de baja (404/410).
//  Sin reintentos: el panel Armado en vivo es la fuente de verdad; esto avisa.
//
//  ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY,
//       VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:…), PUSH_WEBHOOK_SECRET.
//  Nunca escribe suscripciones ni llaves en los logs.
// ============================================================================
const webpush = require('web-push');

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_SR  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET   = process.env.PUSH_WEBHOOK_SECRET;

function leerCuerpo(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return {};
}
async function supa(path, init) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + path, {
    ...init,
    headers: { apikey: SUPA_SR, Authorization: 'Bearer ' + SUPA_SR, 'Content-Type': 'application/json', ...(init && init.headers) },
  });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
}
function pesos(n) { return '$' + Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 0 }); }

// Exportado también para el arnés local (tools/probar-push.mjs).
async function enviarPedidoNuevo(record) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:hola@crunchypaps.mx',
    process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const quien = record.nombre_cliente || 'Sin nombre';
  const interno = record.tipo_interno ? ' · interno' : '';
  const payload = JSON.stringify({
    titulo: 'Pedido nuevo ' + (record.consecutivo || ''),
    cuerpo: quien + ' · ' + (record.canal || '') + interno + ' · ' + pesos(record.total),
    tag: record.consecutivo || String(record.id),
    url: '/?ir=armado',
  });
  const subs = (await supa('push_suscripciones?select=id,endpoint,p256dh,auth', { method: 'GET' })).json || [];
  let enviadas = 0, borradas = 0, fallidas = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600 });
      enviadas++;
      await supa('push_suscripciones?id=eq.' + s.id, { method: 'PATCH', body: JSON.stringify({ ultima_ok: new Date().toISOString() }), headers: { Prefer: 'return=minimal' } });
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        await supa('push_suscripciones?id=eq.' + s.id, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
        borradas++;
      } else {
        fallidas++;
        // id numérico y código o motivo; nunca el endpoint ni las claves.
        console.error('[push] fallo', s.id, (e && e.statusCode) || String(e && e.message || e).slice(0, 80));
      }
    }
  }
  return { ok: true, suscripciones: subs.length, enviadas, borradas, fallidas };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!SECRET || bearer !== String(SECRET).trim()) { res.status(401).end(); return; }
  if (!SUPA_URL || !SUPA_SR || !process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    res.status(500).json({ ok: false, error: 'Faltan variables de entorno' }); return;
  }
  const b = leerCuerpo(req);
  if (b.type !== 'INSERT' || b.table !== 'ordenes' || !b.record) {
    res.status(200).json({ ok: true, ignorado: true }); return;
  }
  try {
    res.status(200).json(await enviarPedidoNuevo(b.record));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e).slice(0, 200) });
  }
};
module.exports.enviarPedidoNuevo = enviarPedidoNuevo;
