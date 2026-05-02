// api/sheets.js — Vercel Serverless Function
// Maneja: proxy a Google Sheets + envío de SMS via Twilio
//
// v2.3.2 — Fix de payload grande:
//   - El proxy ahora hace POST al Apps Script (no GET) para soportar payloads >16 KB.
//   - maxDuration aumentado a 60s (máximo en Vercel Hobby) para imports masivos.

const https = require('https');

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzrXmjKr_Bp1JiqCtjB3Vu7yHnG2Clh_iMj7CLZt9dGslcBKSslC5sH6OKEQQSYIEwetw/exec';

// ── Config Vercel: extender timeout (Hobby permite hasta 60s) ──
module.exports.config = {
  maxDuration: 60,
};

// ── HTTP helper que SIGUE redirects automáticamente, soporta GET y POST ──
function httpsRequest(url, options = {}, body = null, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Demasiados redirects'));

    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   options.method || 'GET',
      headers:  options.headers || {},
    };

    const req = https.request(reqOptions, (res) => {
      // Apps Script suele redirigir 301/302/303 al googleusercontent.com
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const loc = res.headers.location;
        if (!loc) return reject(new Error('Redirect sin location'));
        // Para 307/308 mantener método; 301/302/303 cambian a GET por convención
        const newOptions = { ...options };
        if ([301, 302, 303].includes(res.statusCode)) {
          newOptions.method = 'GET';
          body = null; // no reenviar body en redirect a GET
        }
        return httpsRequest(loc, newOptions, body, redirectCount + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Helper simple para GET (compatibilidad con código viejo)
function httpsGet(url) {
  return httpsRequest(url, { method: 'GET' }).then(r => r.body);
}

// Helper para POST con body (acepta payloads grandes)
function httpsPost(url, body) {
  return httpsRequest(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
}

// ── Twilio SMS ──
function sendTwilioSMS(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_PHONE;

  if (!accountSid || !authToken || !from) {
    throw new Error('Twilio no configurado');
  }

  const postData = new URLSearchParams({ To: to, From: from, Body: body }).toString();

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.sid) resolve({ ok: true, sid: json.sid });
          else reject(new Error(json.message || 'Error Twilio: ' + JSON.stringify(json)));
        } catch(e) { reject(new Error('Respuesta inválida de Twilio')); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── Twilio WhatsApp ──
function sendWhatsApp(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

  const toWpp = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

  const postData = new URLSearchParams({
    To: toWpp, From: from, Body: body
  }).toString();

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.sid) resolve({ ok: true, sid: json.sid });
          else reject(new Error(json.message || 'Error WhatsApp'));
        } catch(e) { reject(new Error('Respuesta inválida')); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── OTP Store en memoria (suficiente para este volumen) ──
const otpStore = new Map();

function generarOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

module.exports = async function(req, res) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  try {
    const payload = req.body;
    const accion  = payload?.accion;

    // ── ENVIAR OTP via Twilio ──
    if (accion === 'enviar_otp') {
      const telefono = String(payload.telefono || '').replace(/\D/g, '');
      if (!telefono || telefono.length < 10) {
        return res.status(200).json({ ok: false, error: 'Número inválido' });
      }

      // Rate limiting: máximo 3 intentos por número cada 5 minutos
      const entry = otpStore.get(telefono);
      if (entry && entry.intentosEnvio >= 3 && Date.now() < entry.bloqueadoHasta) {
        const mins = Math.ceil((entry.bloqueadoHasta - Date.now()) / 60000);
        return res.status(200).json({ ok: false, error: `Demasiados intentos. Espera ${mins} minuto(s).` });
      }

      const codigo = generarOTP();
      otpStore.set(telefono, {
        codigo,
        expira: Date.now() + 10 * 60 * 1000,
        intentosVerif: 0,
        intentosEnvio: (entry?.intentosEnvio || 0) + 1,
        bloqueadoHasta: (entry?.intentosEnvio || 0) >= 2 ? Date.now() + 5 * 60 * 1000 : 0,
      });

      const numero  = `+52${telefono}`;
      const mensaje = `Tu código Crunchy Paps: ${codigo}. Válido 10 min. No lo compartas.`;
      await sendTwilioSMS(numero, mensaje);

      return res.status(200).json({ ok: true, msg: 'SMS enviado' });
    }

    // ── VERIFICAR OTP ──
    if (accion === 'verificar_otp') {
      const telefono = String(payload.telefono || '').replace(/\D/g, '');
      const codigo   = String(payload.codigo || '').trim();

      const entry = otpStore.get(telefono);
      if (!entry) {
        return res.status(200).json({ ok: false, error: 'Código expirado. Solicita uno nuevo.' });
      }
      if (Date.now() > entry.expira) {
        otpStore.delete(telefono);
        return res.status(200).json({ ok: false, error: 'Código expirado. Solicita uno nuevo.' });
      }

      entry.intentosVerif++;
      if (entry.intentosVerif > 5) {
        otpStore.delete(telefono);
        return res.status(200).json({ ok: false, error: 'Demasiados intentos. Solicita un nuevo código.' });
      }

      if (entry.codigo !== codigo) {
        return res.status(200).json({ ok: false, error: 'Código incorrecto.' });
      }

      otpStore.delete(telefono);
      return res.status(200).json({ ok: true, verificado: true });
    }

    // ── ENVIAR WHATSAPP ──
    if (accion === 'enviar_whatsapp') {
      const to   = payload.to || process.env.TWILIO_WHATSAPP_TO;
      const body = payload.body;
      if (!to || !body) return res.status(400).json({ ok: false, error: 'Faltan parámetros' });
      await sendWhatsApp(to, body);
      return res.status(200).json({ ok: true, msg: 'WhatsApp enviado' });
    }

    // ── RESUMEN DIARIO ──
    if (accion === 'resumen_diario') {
      // Obtener datos de Sheets (payload chico, GET con query funciona)
      const paramsSheets = encodeURIComponent(JSON.stringify({ accion: 'get_resumen_diario' }));
      const urlSheets    = `${APPS_SCRIPT_URL}?data=${paramsSheets}`;
      const textSheets   = await httpsGet(urlSheets);
      const dataSheets   = JSON.parse(textSheets);

      if (!dataSheets.ok) return res.status(200).json({ ok: false, error: 'Sin datos' });

      const r   = dataSheets.resumen;
      const hoy = new Date().toLocaleDateString('es-MX', { weekday:'long', day:'numeric', month:'long' });

      const msg = `🍟 *RESUMEN DIARIO — Crunchy Paps*
📅 ${hoy}
━━━━━━━━━━━━━━━━━━
📦 *Pedidos:* ${r.totalPedidos}
💰 *Total vendido:* $${r.totalVentas}
⏳ *Pendientes de entrega:* ${r.pendientes}
━━━━━━━━━━━━━━━━━━
${r.porCanal || ''}
━━━━━━━━━━━━━━━━━━
📊 *Inventario disponible:*
${r.inventario || 'Sin datos de inventario'}
━━━━━━━━━━━━━━━━━━
_Crunchy Paps App_`;

      const destinos = (process.env.TWILIO_WHATSAPP_TO || '').split(',');
      for (const dest of destinos) {
        if (dest.trim()) await sendWhatsApp(dest.trim(), msg);
      }

      return res.status(200).json({ ok: true, msg: 'Resumen enviado' });
    }

    // ── PROXY A GOOGLE SHEETS ──
    // FIX v2.3.2: usar POST con body en lugar de GET con query string
    // para soportar payloads grandes (importación masiva, etc.)
    // Apps Script acepta el body via e.postData.contents en doPost.
    const bodyJson = JSON.stringify(payload);
    const respuesta = await httpsPost(APPS_SCRIPT_URL, bodyJson);

    // Apps Script devuelve siempre HTTP 200 con JSON dentro (incluso en errores)
    // Si recibimos algo distinto a JSON parseable, lo propagamos como error visible
    try {
      const parsed = JSON.parse(respuesta.body);
      return res.status(200).json(parsed);
    } catch(parseErr) {
      // El backend no devolvió JSON. Probablemente HTML de error de Google.
      // Devolver respuesta estructurada para que el frontend la muestre legible.
      const preview = String(respuesta.body || '').slice(0, 200);
      return res.status(200).json({
        ok: false,
        error: `Apps Script devolvió respuesta no-JSON (status ${respuesta.statusCode}). Preview: ${preview}`
      });
    }

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
