// api/sheets.js — Vercel Serverless Function v2
// Maneja: proxy a Google Sheets + envío de SMS/WhatsApp via Twilio
// Cambios v2: parseo robusto de body, logs informativos, manejo de errores

const https  = require('https');
const crypto = require('crypto');

// Qué sección de permisos exige cada acción. Es lista blanca, no lista
// negra: una acción nueva en el Apps Script queda cerrada por omisión en
// vez de abierta por olvido.
const SECCION_POR_ACCION = {
  lookup_producto_externo: 'productos',
};

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
// SIN LLAMADORES a propósito. El endpoint que lo usaba (accion enviar_whatsapp)
// se retiró: no lo invocaba nadie en el repo y mandaba WhatsApp por la cuenta de
// Twilio a cualquier número que le pasaran, sin credencial. Se conserva el
// helper porque es la pieza que hará falta si algún día se quiere el resumen
// diario automático, que hoy se comparte a mano desde copiarResumenDia().
// eslint-disable-next-line no-unused-vars
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

// ── Open Food Facts ─────────────────────────────────────────────────────────
// Esto daba la vuelta por Apps Script sin ninguna razón: es una API pública de
// solo lectura. Se llama directo y se acaba el rodeo.
async function lookupProductoExterno(codigoBarras) {
  // El código se interpola en la RUTA de la URL, así que se reduce a dígitos
  // antes de tocarla.
  const codigo = String(codigoBarras || '').replace(/D/g, '');
  if (codigo.length < 8 || codigo.length > 14) {
    return { ok: false, error: 'Código de barras inválido' };
  }

  const campos = 'product_name,product_name_es,brands,image_front_url,image_url';
  const url = `https://world.openfoodfacts.org/api/v2/product/${codigo}.json?fields=${campos}`;

  const ctrl   = new AbortController();
  const alarma = setTimeout(() => ctrl.abort(), 8000);
  let json;
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // Open Food Facts pide identificarse; sin User-Agent propio responde 403.
        'User-Agent': 'CrunchyPaps/1.0 (https://crunchypaps.mx)',
        Accept: 'application/json',
      },
    });
    if (!r.ok) return { ok: true, encontrado: false };
    json = await r.json();
  } catch (e) {
    // Que la base externa no conteste no es un fallo de la app: el usuario
    // captura el producto a mano, que es el camino de siempre.
    console.warn('[sheets.js] Open Food Facts no respondió:', e.message);
    return { ok: true, encontrado: false };
  } finally {
    clearTimeout(alarma);
  }

  const prod = json && json.product;
  if (!prod || json.status !== 1) return { ok: true, encontrado: false };

  const nombre = String(prod.product_name_es || prod.product_name || '').trim();
  if (!nombre) return { ok: true, encontrado: false };
  const marca = String(prod.brands || '').split(',')[0].trim();

  return {
    ok: true,
    encontrado: true,
    producto: {
      nombre: (marca && !nombre.toLowerCase().includes(marca.toLowerCase()))
        ? `${marca} ${nombre}` : nombre,
      imagen_url: prod.image_front_url || prod.image_url || '',
    },
  };
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

    // ── AUTORIZACIÓN ────────────────────────────────────────────────────
    // Todo lo que sigue exige sesión. Enviar y verificar OTP quedan arriba,
    // sin credencial, porque son justamente los que la emiten.
    const seccionRequerida = SECCION_POR_ACCION[accion];
    if (!seccionRequerida) {
      console.warn('[sheets.js] accion no permitida:', accion);
      return res.status(403).json({ ok: false, error: 'Acción no permitida' });
    }

    const _token = typeof payload.token === 'string' ? payload.token : '';
    if (!_token) {
      return res.status(401).json({ ok: false, error: 'Sesión requerida' });
    }

    let _sesion = null;
    try {
      const rs = await supa('rpc/sesion_exige_seccion', 'POST',
        { p_token: _token, p_seccion: seccionRequerida });
      // Devuelve cero filas tanto si el token no sirve como si el rol no
      // tiene la sección. No distingue: quien llama no aprende cuál falló.
      if (rs.ok && Array.isArray(rs.data) && rs.data.length) _sesion = rs.data[0];
    } catch (e) {
      console.error('[sheets.js] error validando sesion:', e.message);
      return res.status(500).json({ ok: false, error: 'No se pudo validar la sesión' });
    }
    if (!_sesion) {
      return res.status(403).json({ ok: false, error: 'Sin permiso para esta acción' });
    }
    console.log('[sheets.js] autorizado:', accion, '-> vendedor', _sesion.id_vendedor, _sesion.rol);

    // El token no sigue hacia Apps Script: no tiene por qué verlo.
    delete payload.token;

    // ── LOOKUP DE PRODUCTO POR CÓDIGO DE BARRAS ──
    if (accion === 'lookup_producto_externo') {
      return res.status(200).json(await lookupProductoExterno(payload.codigo_barras));
    }

    // Ya no hay proxy a Google Apps Script. Cada acción se atiende arriba, y
    // la lista blanca rechaza lo que no reconoce, así que llegar hasta aquí
    // significa que alguien añadió una acción a la lista y olvidó su manejador.
    console.error('[sheets.js] accion en la lista blanca sin manejador:', accion);
    return res.status(500).json({ ok: false, error: 'Acción no implementada' });

  } catch (err) {
    console.error('[sheets.js] error general:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
