// ============================================================================
//  Crunchy Paps — Recordatorios de PAGO por SMS (automático + manual)
//  Vercel Serverless Function · repo: /api/recordatorios-pago.js
//
//  Modos (GET):
//   - Automático (cron):  sin params -> ventanas 24h/48h/máx 3.
//   - Manual todos:       ?force=1   -> ignora ventanas.
//   - Individual:         ?solo=PED-00010 (o ?solo=<id>).
//   - Simulación:         ?dry=1     -> no envía, lista candidatos.
//
//  Copy editable (POST con ?secret=... o Bearer):
//   - { "accion": "get_copy" }                 -> { ok, plantilla }
//   - { "accion": "guardar_copy", "plantilla": "..." } -> { ok }
//   Placeholders: {nombre} {folio} {total} {link}
//
//  Auth: Bearer CRON_SECRET (cron) o ?secret=CRON_SECRET.
//  SQL requerido: recordatorios_pago_schema.sql + app_config.sql.
//  ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TWILIO_ACCOUNT_SID,
//       TWILIO_AUTH_TOKEN, TWILIO_PHONE, CRON_SECRET.
// ============================================================================

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_SR  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TW_SID   = process.env.TWILIO_ACCOUNT_SID;
const TW_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TW_FROM  = process.env.TWILIO_PHONE;
const CRON_SECRET = process.env.CRON_SECRET;

const HORAS_MIN_DESDE_CREADO    = 24;
const HORAS_ENTRE_RECORDATORIOS = 48;
const MAX_RECORDATORIOS         = 3;
const SITIO                     = 'https://crunchypaps.mx';
const COPY_KEY                  = 'recordatorio_pago_sms';
const PLANTILLA_DEFAULT = 'Hola {nombre}, tu pedido {folio} de Crunchy Paps por ${total} sigue pendiente de pago. Detalles aqui: {link}';

async function supa(path, method, body, prefer) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + path, {
    method,
    headers: {
      apikey: SUPA_SR,
      Authorization: 'Bearer ' + SUPA_SR,
      'Content-Type': 'application/json',
      Prefer: prefer || 'return=representation',
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

function getQuery(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  try {
    const u = new URL(req.url, 'http://localhost');
    return Object.fromEntries(u.searchParams.entries());
  } catch { return {}; }
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return await new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

async function getPlantilla() {
  try {
    const r = await supa(`app_config?clave=eq.${COPY_KEY}&select=valor&limit=1`, 'GET');
    if (Array.isArray(r.data) && r.data[0] && r.data[0].valor) return r.data[0].valor;
  } catch (e) {}
  return PLANTILLA_DEFAULT;
}

function renderPlantilla(tpl, v) {
  return String(tpl)
    .replace(/\{nombre\}/g, v.nombre)
    .replace(/\{folio\}/g, v.folio)
    .replace(/\{total\}/g, v.total)
    .replace(/\{link\}/g, v.link);
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const Q = getQuery(req);

  // Auth: Bearer CRON_SECRET (cron) o ?secret= (manual). Recorta espacios.
  if (CRON_SECRET) {
    const expected = String(CRON_SECRET).trim();
    const secretParam = String(Q.secret || '').trim();
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (secretParam !== expected && bearer !== expected) {
      res.status(401).json({ ok: false, error: 'No autorizado' }); return;
    }
  }
  if (!SUPA_URL || !SUPA_SR) {
    res.status(500).json({ ok: false, error: 'Faltan variables de Supabase' }); return;
  }

  try {
    // ── Gestión del copy editable ──
    const body = (req.method === 'POST') ? await readJsonBody(req) : {};
    const accion = String((body && body.accion) || Q.accion || '');

    if (accion === 'get_copy') {
      res.status(200).json({ ok: true, plantilla: await getPlantilla() }); return;
    }
    if (accion === 'guardar_copy') {
      const plantilla = String((body && body.plantilla) || '').trim();
      if (!plantilla) { res.status(400).json({ ok: false, error: 'Plantilla vacía' }); return; }
      const up = await supa('app_config?on_conflict=clave', 'POST',
        { clave: COPY_KEY, valor: plantilla, actualizado: new Date().toISOString() },
        'resolution=merge-duplicates,return=representation');
      if (!up.ok && !(Array.isArray(up.data))) {
        res.status(500).json({ ok: false, error: 'No se pudo guardar', detalle: up.data }); return;
      }
      res.status(200).json({ ok: true, plantilla }); return;
    }

    // ── Envío de recordatorios ──
    if (!TW_SID || !TW_TOKEN || !TW_FROM) {
      res.status(500).json({ ok: false, error: 'Faltan variables de Twilio' }); return;
    }

    const dryRun = ['1', 'true'].includes(String(Q.dry || ''));
    const force  = ['1', 'true'].includes(String(Q.force || ''));
    const solo   = String(Q.solo || '').trim();

    const sel = 'id,consecutivo,nombre_cliente,id_cliente,total,fecha_orden,estatus_pago,estatus_pedido,ultimo_recordatorio_pago,recordatorios_pago_enviados,tipo_interno';

    let path;
    if (solo) {
      const n = Number(solo);
      const cond = isNaN(n)
        ? `consecutivo.eq.${encodeURIComponent(solo)}`
        : `consecutivo.eq.${encodeURIComponent(solo)},id.eq.${n}`;
      path = `ordenes?or=(${cond})&select=${sel}&limit=1`;
    } else {
      path = `ordenes?or=(estatus_pago.neq.Pagado,estatus_pago.is.null)&estatus_pedido=neq.Cancelado&select=${sel}&order=fecha_orden.asc`;
    }

    const q = await supa(path, 'GET');
    if (!Array.isArray(q.data)) {
      res.status(500).json({ ok: false, error: 'Consulta inválida', detalle: q.data }); return;
    }

    const ahora = Date.now();
    const desdeMs = ahora - HORAS_MIN_DESDE_CREADO * 3600000;
    const corteMs = ahora - HORAS_ENTRE_RECORDATORIOS * 3600000;

    let lista = q.data.filter(o =>
      String(o.tipo_interno || '').trim() === '' &&
      String(o.estatus_pago || '') !== 'Pagado' &&
      String(o.estatus_pedido || '') !== 'Cancelado'
    );

    if (!force && !solo) {
      lista = lista.filter(o =>
        new Date(o.fecha_orden).getTime() < desdeMs &&
        (o.recordatorios_pago_enviados || 0) < MAX_RECORDATORIOS &&
        (!o.ultimo_recordatorio_pago || new Date(o.ultimo_recordatorio_pago).getTime() < corteMs)
      );
    }

    const mapaTel = {};
    const idsCli = [...new Set(lista.map(o => o.id_cliente).filter(v => v != null))];
    if (idsCli.length) {
      const cli = await supa(`clientes?id=in.(${idsCli.join(',')})&select=id,telefono`, 'GET');
      if (Array.isArray(cli.data)) cli.data.forEach(c => { mapaTel[c.id] = c.telefono; });
    }

    const plantilla = await getPlantilla();

    const out = {
      ok: true,
      modo: solo ? 'individual' : (force ? 'manual-todos' : 'automatico'),
      revisados: q.data.length, candidatos: lista.length,
      enviados: 0, fallidos: 0, detalle: [],
    };

    for (const o of lista) {
      const folio = o.consecutivo || ('#' + o.id);
      const to = fmtTel(mapaTel[o.id_cliente]);
      const dias = o.fecha_orden ? Math.floor((ahora - new Date(o.fecha_orden).getTime()) / 86400000) : null;
      const base = {
        id: o.id, folio, cliente: o.nombre_cliente || '',
        total: Number(o.total || 0), dias,
        recordatorios: o.recordatorios_pago_enviados || 0, to,
      };

      if (!to) { out.fallidos++; out.detalle.push({ ...base, error: 'sin teléfono' }); continue; }
      if (dryRun) { out.detalle.push({ ...base, dry: true }); continue; }

      const nombre = String(o.nombre_cliente || 'Cliente').split(' ')[0];
      const total = Number(o.total || 0).toLocaleString('es-MX');
      const link = `${SITIO}/?track=${encodeURIComponent(folio)}`;
      const sms = renderPlantilla(plantilla, { nombre, folio, total, link });

      const env = await enviarSMS(to, sms);
      if (env.ok) {
        await supa(`ordenes?id=eq.${o.id}`, 'PATCH', {
          ultimo_recordatorio_pago: new Date().toISOString(),
          recordatorios_pago_enviados: (o.recordatorios_pago_enviados || 0) + 1,
        });
        out.enviados++; out.detalle.push({ ...base, ok: true });
      } else {
        out.fallidos++; out.detalle.push({ ...base, error: env.data?.message || ('HTTP ' + env.status) });
      }
    }

    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
