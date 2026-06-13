// ============================================================================
//  Crunchy Paps — Recordatorios automáticos de PAGO por SMS (puente)
//  Vercel Serverless Function · repo: /api/recordatorios-pago.js
//  Se dispara con Vercel Cron (ver vercel.json) una vez al día.
//
//  Lógica: pedidos pendientes de pago, no cancelados, no internos, creados hace
//  > 24h, no recordados en las últimas 48h, con menos de 3 recordatorios.
//  Envía SMS vía Twilio y registra el envío en `ordenes`.
//
//  Variables de entorno (Vercel):
//    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (ya existen)
//    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN     (ya existen)
//    TWILIO_PHONE   -> número Twilio HABILITADO PARA SMS hacia México (+52)
//    CRON_SECRET    -> secreto; Vercel lo manda como Authorization: Bearer ...
//
//  Requiere antes: correr recordatorios_pago_schema.sql (columnas de control).
// ============================================================================

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_SR  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TW_SID   = process.env.TWILIO_ACCOUNT_SID;
const TW_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TW_FROM  = process.env.TWILIO_PHONE;
const CRON_SECRET = process.env.CRON_SECRET;

const HORAS_MIN_DESDE_CREADO    = 24;  // no molestar antes de 24h
const HORAS_ENTRE_RECORDATORIOS = 48;  // máximo un recordatorio cada 48h
const MAX_RECORDATORIOS         = 3;   // tope por pedido
const SITIO                     = 'https://crunchypaps.mx';

async function supa(path, method, body) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + path, {
    method,
    headers: {
      apikey: SUPA_SR,
      Authorization: 'Bearer ' + SUPA_SR,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  return { ok: r.ok, status: r.status, data };
}

function fmtTel(t) {
  const d = String(t || '').replace(/\D/g, '');
  return d.length >= 10 ? '+52' + d.slice(-10) : null;
}

// Lee los query params de forma robusta (Vercel da req.query; si no, parsea req.url)
function getQuery(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  try {
    const u = new URL(req.url, 'http://localhost');
    return Object.fromEntries(u.searchParams.entries());
  } catch { return {}; }
}

async function enviarSMS(to, body) {
  const params = new URLSearchParams({ To: to, From: TW_FROM, Body: body });
  const auth = Buffer.from(`${TW_SID}:${TW_TOKEN}`).toString('base64');
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  let data; try { data = await r.json(); } catch { data = {}; }
  return { ok: r.ok, status: r.status, data };
}

module.exports = async (req, res) => {
  const Q = getQuery(req);

  // Auth: solo el cron de Vercel (Bearer CRON_SECRET) o prueba manual con ?secret=
  if (CRON_SECRET) {
    const expected = String(CRON_SECRET).trim();
    const secretParam = String(Q.secret || '').trim();
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const okAuth = secretParam === expected || bearer === expected;
    if (!okAuth) { res.status(401).json({ ok: false, error: 'No autorizado' }); return; }
  }
  if (!SUPA_URL || !SUPA_SR || !TW_SID || !TW_TOKEN || !TW_FROM) {
    res.status(500).json({ ok: false, error: 'Faltan variables de entorno (Supabase/Twilio)' }); return;
  }
  try {
    const desde = new Date(Date.now() - HORAS_MIN_DESDE_CREADO * 3600000).toISOString();
    const q = await supa(
      'ordenes?' +
      'or=(estatus_pago.neq.Pagado,estatus_pago.is.null)' +
      '&estatus_pedido=neq.Cancelado' +
      `&fecha_orden=lt.${desde}` +
      `&recordatorios_pago_enviados=lt.${MAX_RECORDATORIOS}` +
      '&select=id,consecutivo,nombre_cliente,id_cliente,total,fecha_orden,ultimo_recordatorio_pago,recordatorios_pago_enviados,tipo_interno' +
      '&order=fecha_orden.asc',
      'GET'
    );
    if (!Array.isArray(q.data)) {
      res.status(500).json({ ok: false, error: 'Consulta inválida', detalle: q.data }); return;
    }

    const corte = Date.now() - HORAS_ENTRE_RECORDATORIOS * 3600000;
    const candidatos = q.data.filter(o =>
      String(o.tipo_interno || '').trim() === '' &&
      (!o.ultimo_recordatorio_pago || new Date(o.ultimo_recordatorio_pago).getTime() < corte)
    );

    // El teléfono no está en `ordenes`: se resuelve desde `clientes` por id_cliente.
    const mapaTel = {};
    const idsCli = [...new Set(candidatos.map(o => o.id_cliente).filter(v => v != null))];
    if (idsCli.length) {
      const cli = await supa(`clientes?id=in.(${idsCli.join(',')})&select=id,telefono`, 'GET');
      if (Array.isArray(cli.data)) cli.data.forEach(c => { mapaTel[c.id] = c.telefono; });
    }

    const out = { ok: true, revisados: q.data.length, candidatos: candidatos.length, enviados: 0, fallidos: 0, detalle: [] };

    // ?dry=1 => simula sin enviar (útil para probar el filtro)
    const dryRun = String(Q.dry || '') === '1' || String(Q.dry || '') === 'true';

    for (const o of candidatos) {
      const to = fmtTel(mapaTel[o.id_cliente]);
      const folio = o.consecutivo || ('#' + o.id);
      if (!to) { out.fallidos++; out.detalle.push({ id: o.id, folio, error: 'teléfono inválido' }); continue; }

      const nombre = String(o.nombre_cliente || 'Cliente').split(' ')[0];
      const total = Number(o.total || 0).toLocaleString('es-MX');
      const link = `${SITIO}/?track=${encodeURIComponent(folio)}`;
      const body = `Hola ${nombre}, tu pedido ${folio} de Crunchy Paps por $${total} sigue pendiente de pago. Detalles aqui: ${link}`;

      if (dryRun) { out.detalle.push({ id: o.id, folio, to, dry: true }); continue; }

      const env = await enviarSMS(to, body);
      if (env.ok) {
        await supa(`ordenes?id=eq.${o.id}`, 'PATCH', {
          ultimo_recordatorio_pago: new Date().toISOString(),
          recordatorios_pago_enviados: (o.recordatorios_pago_enviados || 0) + 1,
        });
        out.enviados++;
        out.detalle.push({ id: o.id, folio, to, ok: true });
      } else {
        out.fallidos++;
        out.detalle.push({ id: o.id, folio, to, error: env.data?.message || ('HTTP ' + env.status) });
      }
    }

    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
