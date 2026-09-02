// ════════════════════════════════════════════════════════════════════════════
// Tickets de gasto — URLs firmadas contra Supabase Storage
//
// Este endpoint NO recibe archivos. Solo firma permisos de corta vida y el
// navegador sube o descarga directo contra Storage.
//
// Por qué así: el selector admite 5 MB, que en base64 son ~6.7 MB, muy por
// encima del límite de cuerpo de una función serverless. Ese era el "bug del
// proxy >16KB" que mantuvo esta acción en Apps Script. Si el archivo no pasa
// por aquí, el límite deja de existir.
//
// La autorización vive en Postgres (autorizar_ticket_gasto), que comprueba
// sesión, sección `gastos` y que el gasto sea del vendedor o que quien pide sea
// admin. Aquí no se decide nada: se pregunta y se obedece.
// ════════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_SR  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET   = 'tickets';

// Segundos que vive un enlace de lectura. Corto a propósito: se pide al hacer
// clic, así que no hace falta que sobreviva a la sesión.
const VIDA_ENLACE = 300;

// Extensiones admitidas y su tipo. La extensión acaba en la RUTA del objeto,
// así que se toma de esta lista y nunca del nombre que manda el navegador.
const TIPOS = {
  'image/jpeg':       'jpg',
  'image/png':        'png',
  'image/webp':       'webp',
  'image/heic':       'heic',
  'application/pdf':  'pdf',
};

async function supa(ruta, metodo, cuerpo) {
  const r = await fetch(SUPA_URL + ruta, {
    method: metodo,
    headers: {
      apikey: SUPA_SR,
      Authorization: 'Bearer ' + SUPA_SR,
      'Content-Type': 'application/json',
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const txt = await r.text();
  let datos; try { datos = JSON.parse(txt); } catch { datos = txt; }
  return { ok: r.ok, estado: r.status, datos };
}

function leerCuerpo(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      return resolve(req.body);
    }
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  if (!SUPA_URL || !SUPA_SR) {
    console.error('[ticket.js] faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
    return res.status(500).json({ ok: false, error: 'Backend no configurado' });
  }

  try {
    const payload = await leerCuerpo(req);
    const accion  = payload.accion;
    const token   = typeof payload.token === 'string' ? payload.token : '';

    if (accion !== 'firmar_subida' && accion !== 'firmar_descarga') {
      return res.status(403).json({ ok: false, error: 'Acción no permitida' });
    }
    if (!token) {
      return res.status(401).json({ ok: false, error: 'Sesión requerida' });
    }

    // Autorizar ANTES de mirar nada más del payload.
    const permiso = await supa('/rest/v1/rpc/autorizar_ticket_gasto', 'POST', {
      p_data: { token, idGasto: payload.idGasto },
    });
    const p = permiso.datos;
    if (!permiso.ok || !p || p.ok !== true) {
      // Se devuelve el mensaje de Postgres tal cual: ya está redactado para no
      // distinguir "sin sesión" de "no es tuyo".
      return res.status(403).json({ ok: false, error: (p && p.error) || 'No autorizado' });
    }

    // ── VER UN TICKET ────────────────────────────────────────────────────────
    if (accion === 'firmar_descarga') {
      const ruta = p.ticketUrl;
      if (!ruta) return res.status(404).json({ ok: false, error: 'Este gasto no tiene ticket' });

      // Los tickets viejos de Drive son URLs completas, no rutas del bucket.
      // Se devuelven tal cual: no hay nada que firmar en Storage.
      if (/^https?:\/\//i.test(ruta)) {
        return res.status(200).json({ ok: true, url: ruta, externa: true });
      }

      const f = await supa(`/storage/v1/object/sign/${BUCKET}/${ruta}`, 'POST',
        { expiresIn: VIDA_ENLACE });
      if (!f.ok || !f.datos || !f.datos.signedURL) {
        console.error('[ticket.js] no se pudo firmar la lectura:', f.estado, f.datos);
        return res.status(500).json({ ok: false, error: 'No se pudo abrir el ticket' });
      }
      return res.status(200).json({
        ok: true,
        url: SUPA_URL + '/storage/v1' + f.datos.signedURL,
      });
    }

    // ── SUBIR UN TICKET ──────────────────────────────────────────────────────
    const ext = TIPOS[payload.mimeType];
    if (!ext) {
      return res.status(400).json({
        ok: false,
        error: 'Formato no admitido. Usa JPG, PNG, WEBP, HEIC o PDF.',
      });
    }

    // La ruta la arma el servidor. El nombre que manda el navegador no se usa
    // para nada: viene del disco de alguien y acabaría dentro de una URL.
    const ruta = `gastos/${p.idGasto}/${crypto.randomUUID()}.${ext}`;

    const f = await supa(`/storage/v1/object/upload/sign/${BUCKET}/${ruta}`, 'POST', {});
    if (!f.ok || !f.datos || !f.datos.url) {
      console.error('[ticket.js] no se pudo firmar la subida:', f.estado, f.datos);
      return res.status(500).json({ ok: false, error: 'No se pudo preparar la subida' });
    }

    return res.status(200).json({
      ok: true,
      ruta,                                        // esto es lo que se guarda en gastos.ticket_url
      url: SUPA_URL + '/storage/v1' + f.datos.url, // aquí sube el navegador
    });
  } catch (e) {
    console.error('[ticket.js] error:', e.message);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
};
