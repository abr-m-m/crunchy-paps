// api/sheets.js — Vercel Serverless Function v2
// Maneja: proxy a Google Sheets + envío de SMS/WhatsApp via Twilio
// Cambios v2: parseo robusto de body, logs informativos, manejo de errores

const https = require('https');

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzrXmjKr_Bp1JiqCtjB3Vu7yHnG2Clh_iMj7CLZt9dGslcBKSslC5sH6OKEQQSYIEwetw/exec';

// ── Supabase (service_role) ─────────────────────────────────────────────────
// Necesario para emitir la sesión de cliente tras verificar el OTP por SMS.
// `emitir_sesion_cliente` no es invocable con la llave anon: solo con
// service_role. Ambas variables ya existen en el entorno de Vercel.
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_SR  = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function emitirSesionCliente(telefono) {
  if (!SUPA_URL || !SUPA_SR) return null;
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/rpc/emitir_sesion_cliente', {
      method: 'POST',
      headers: {
        apikey: SUPA_SR,
        Authorization: 'Bearer ' + SUPA_SR,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_telefono: telefono }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return (d && d.ok) ? d : null;
  } catch (_e) {
    return null;
  }
}

// ── HTTP helper con seguimiento de redirects ──
function httpsGet(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Demasiados redirects'));
    https.get(url, (res) => {
      if ([301, 302, 303].includes(res.statusCode)) {
        const loc = res.headers.location;
        if (!loc) return reject(new Error('Redirect sin location'));
        return httpsGet(loc, redirectCount + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ── Twilio SMS ──
function sendTwilioSMS(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_PHONE;

  if (!accountSid || !authToken || !from) {
    throw new Error('Twilio SMS no configurado (faltan variables)');
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

  if (!accountSid || !authToken) {
    throw new Error('Twilio WhatsApp no configurado (faltan SID/TOKEN)');
  }

  const toWpp = String(to).startsWith('whatsapp:') ? to : `whatsapp:${to}`;

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
          else reject(new Error(json.message || 'Error WhatsApp: ' + JSON.stringify(json)));
        } catch(e) { reject(new Error('Respuesta inválida WhatsApp: ' + data.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── OTP Store en memoria ──
const otpStore = new Map();
function generarOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ── Parseo robusto del body (Vercel a veces no lo parsea) ──
function parseBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      return resolve(req.body);
    }
    if (req.body && typeof req.body === 'string') {
      try { return resolve(JSON.parse(req.body)); }
      catch(e) { return resolve({}); }
    }
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch(e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  try {
    // Parseo robusto
    const payload = await parseBody(req);
    const accion  = payload?.accion;

    // Log para debugging (visible en Vercel Logs)
    console.log('[sheets.js] accion recibida:', accion, 'payload keys:', Object.keys(payload || {}));

    // ── ENVIAR OTP via Twilio SMS ──
    if (accion === 'enviar_otp') {
      const telefono = String(payload.telefono || '').replace(/\D/g, '');
      if (!telefono || telefono.length < 10) {
        return res.status(200).json({ ok: false, error: 'Número inválido' });
      }
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

      // Emitir la sesión de cliente: es el único punto donde queda acreditado
      // que alguien controla ese teléfono. Si falla, se responde verificado
      // igualmente — el código era correcto y negar el acceso por un fallo
      // ajeno al cliente sería peor. Sin token verá menos, no lo de otros.
      const _sesion = await emitirSesionCliente(telefono);
      return res.status(200).json({
        ok: true, verificado: true,
        token:    _sesion ? _sesion.token    : null,
        expiraEn: _sesion ? _sesion.expiraEn : null,
      });
    }

    // ── ENVIAR WHATSAPP (soporta múltiples destinos en TWILIO_WHATSAPP_TO con comas) ──
    if (accion === 'enviar_whatsapp') {
      const body = payload.body;
      if (!body) return res.status(400).json({ ok: false, error: 'Falta body del mensaje' });

      const to = payload.to || process.env.TWILIO_WHATSAPP_TO;
      if (!to) return res.status(400).json({ ok: false, error: 'Falta destino (to o TWILIO_WHATSAPP_TO)' });

      const destinos = String(to).split(',').map(s => s.trim()).filter(Boolean);
      const resultados = [];
      for (const dest of destinos) {
        try {
          const r = await sendWhatsApp(dest, body);
          resultados.push({ to: dest, ok: true, sid: r.sid });
          console.log('[whatsapp] enviado a', dest, 'sid:', r.sid);
        } catch(e) {
          resultados.push({ to: dest, ok: false, error: e.message });
          console.error('[whatsapp] error a', dest, ':', e.message);
        }
      }
      const okCount = resultados.filter(r => r.ok).length;
      return res.status(200).json({
        ok: okCount > 0,
        msg: `WhatsApp: ${okCount}/${destinos.length} enviados`,
        resultados
      });
    }

    // ── PROXY A GOOGLE SHEETS (cualquier otra accion) ──
    const params = encodeURIComponent(JSON.stringify(payload));
    const url    = `${APPS_SCRIPT_URL}?data=${params}`;
    const text   = await httpsGet(url);
    try {
      return res.status(200).json(JSON.parse(text));
    } catch(e) {
      console.error('[sheets.js] respuesta no-JSON de Apps Script:', text.slice(0, 200));
      return res.status(500).json({
        ok: false,
        error: 'Apps Script devolvió respuesta inválida',
        primeros200: text.slice(0, 200)
      });
    }

  } catch (err) {
    console.error('[sheets.js] error general:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
