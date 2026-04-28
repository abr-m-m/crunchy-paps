// api/sheets.js — Vercel Serverless Function
// Maneja: proxy a Google Sheets + envío de SMS via Twilio

const https = require('https');

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzrXmjKr_Bp1JiqCtjB3Vu7yHnG2Clh_iMj7CLZt9dGslcBKSslC5sH6OKEQQSYIEwetw/exec';

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

    // ── PROXY A GOOGLE SHEETS ──
    const params = encodeURIComponent(JSON.stringify(payload));
    const url    = `${APPS_SCRIPT_URL}?data=${params}`;
    const text   = await httpsGet(url);

    return res.status(200).json(JSON.parse(text));

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
