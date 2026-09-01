// api/sheets.js — Vercel Serverless Function v2
// Maneja: proxy a Google Sheets + envío de SMS/WhatsApp via Twilio
// Cambios v2: parseo robusto de body, logs informativos, manejo de errores

const https  = require('https');
const crypto = require('crypto');

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzrXmjKr_Bp1JiqCtjB3Vu7yHnG2Clh_iMj7CLZt9dGslcBKSslC5sH6OKEQQSYIEwetw/exec';

// ── Supabase (service_role) ─────────────────────────────────────────────────
// Necesario para emitir la sesión de cliente tras verificar el OTP por SMS.
// `emitir_sesion_cliente` no es invocable con la llave anon: solo con
// service_role. Ambas variables ya existen en el entorno de Vercel.
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_SR  = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ¿Se puede mandar un OTP a este número ahora mismo?
// El control vive en Postgres, no aquí: `otpStore` es un Map en memoria y en
// serverless se reinicia con cada arranque en frío, así que su límite de 3
// envíos nunca llegó a existir. Además hay un tope GLOBAL, que es el que de
// verdad acota la factura: limitar por teléfono no estorba a quien manda una
// vez a mil números distintos.
//
// Si la comprobación falla por un problema de red, se deja pasar: dejar sin
// código a un cliente legítimo por una caída interna es peor que un SMS de
// más. El tope global sigue puesto para el caso sostenido.
async function puedeEnviarOtp(telefono, canal) {
  if (!SUPA_URL || !SUPA_SR) return { ok: true };
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/rpc/registrar_envio_otp', {
      method: 'POST',
      headers: {
        apikey: SUPA_SR,
        Authorization: 'Bearer ' + SUPA_SR,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_telefono: telefono, p_canal: canal || 'sms' }),
    });
    if (!r.ok) return { ok: true };
    const d = await r.json();
    return d || { ok: true };
  } catch (_e) {
    return { ok: true };
  }
}

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

// ── OTP: código en la BASE, no en memoria ───────────────────────────────────
// Antes vivía en un Map en memoria. En serverless eso significaba que un
// usuario podía recibir el SMS y que la verificación cayera en OTRA instancia
// que no conocía el código — un "código incorrecto" sin explicación. Ahora se
// guarda en `otp_codigos`, exactamente como ya hacía api/otp-email.js.
//
// Del código solo se guarda su SHA-256 con el teléfono como sal, así que leer
// la tabla no permite iniciar sesión como nadie.
const CODE_TTL_MIN = 10;   // minutos de vigencia
const MAX_INTENTOS = 5;    // intentos de verificación por código

function hashCode(code, tel) {
  return crypto.createHash('sha256').update(code + '|' + tel).digest('hex');
}

// §3.8: era Math.random(), que NO es criptográficamente seguro. Para un código
// de acceso hay que usar el generador criptográfico: Math.random() es
// predecible si se conocen suficientes salidas anteriores.
function generarOTP() {
  return String(crypto.randomInt(100000, 1000000));
}

// Helper REST con service_role, igual que el de api/otp-email.js.
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
      // El límite REAL vive en Postgres. El bloque de otpStore que había aquí
      // no llegaba a aplicarse nunca: el Map se reinicia en cada arranque en
      // frío y cada instancia tiene el suyo.
      const _limite = await puedeEnviarOtp(telefono, 'sms');
      if (!_limite.ok) {
        return res.status(200).json({ ok: false, error: _limite.error || 'Demasiados intentos.' });
      }

      const codigo = generarOTP();

      // Invalidar códigos previos no usados: pedir uno nuevo debe anular el
      // anterior, o convivirían dos válidos a la vez.
      await supa(`otp_codigos?telefono=eq.${encodeURIComponent(telefono)}&usado=eq.false`,
                 'PATCH', { usado: true });

      const ins = await supa('otp_codigos', 'POST', {
        telefono,
        codigo_hash: hashCode(codigo, telefono),
        expira_en: new Date(Date.now() + CODE_TTL_MIN * 60000).toISOString(),
        usado: false,
        intentos: 0,
      });

      // Si no se pudo registrar, NO se manda el SMS: mandarlo sin poder
      // verificarlo después es gastar un mensaje para nada y dejar al cliente
      // esperando un código que no va a servir.
      if (!ins.ok) {
        return res.status(500).json({ ok: false, error: 'No se pudo registrar el código' });
      }

      const numero  = `+52${telefono}`;
      const mensaje = `Tu código Crunchy Paps: ${codigo}. Válido 10 min. No lo compartas.`;
      await sendTwilioSMS(numero, mensaje);
      return res.status(200).json({ ok: true, msg: 'SMS enviado' });
    }

    // ── VERIFICAR OTP ──
    if (accion === 'verificar_otp') {
      const telefono = String(payload.telefono || '').replace(/\D/g, '');
      const codigo   = String(payload.codigo || '').trim();
      if (!/^\d{6}$/.test(codigo)) {
        return res.status(200).json({ ok: false, error: 'Código inválido.' });
      }

      // El código vive en la base, así que da igual qué instancia atienda esta
      // petición. Antes, con el Map en memoria, un cliente podía recibir el SMS
      // desde una instancia y verificar contra otra que no lo conocía.
      const q = await supa(
        `otp_codigos?telefono=eq.${encodeURIComponent(telefono)}&usado=eq.false&order=creado.desc&limit=1`,
        'GET'
      );
      const row = Array.isArray(q.data) && q.data[0];
      if (!row) {
        return res.status(200).json({ ok: false, error: 'Código expirado. Solicita uno nuevo.' });
      }
      if (new Date(row.expira_en).getTime() < Date.now()) {
        return res.status(200).json({ ok: false, error: 'Código expirado. Solicita uno nuevo.' });
      }
      if ((row.intentos || 0) >= MAX_INTENTOS) {
        return res.status(200).json({ ok: false, error: 'Demasiados intentos. Solicita un nuevo código.' });
      }
      if (row.codigo_hash !== hashCode(codigo, telefono)) {
        // El contador se guarda en la base: en memoria se reiniciaba solo y el
        // límite de 5 intentos no llegaba a aplicarse.
        await supa(`otp_codigos?id=eq.${row.id}`, 'PATCH', { intentos: (row.intentos || 0) + 1 });
        return res.status(200).json({ ok: false, error: 'Código incorrecto.' });
      }
      await supa(`otp_codigos?id=eq.${row.id}`, 'PATCH', { usado: true });

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
