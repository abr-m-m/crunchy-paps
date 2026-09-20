// ============================================================================
//  Crunchy Paps — Imagen de un reto del Club
//  Vercel Serverless Function · /api/imagen-reto
//
//  POST {token, mimeType} → {ok, ruta, url}. Valida que el token sea del dueño
//  (sesion_es_dueno, con la llave de servicio) y emite una URL firmada de
//  subida a contenido/retos/<uuid>.<ext>; el navegador sube directo a Storage
//  con PUT. Mismo patrón que api/ticket.js. La ruta la arma el servidor: el
//  nombre del archivo del navegador no se usa. 20 sep 2026.
// ============================================================================
const crypto = require('crypto');

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_SR  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET   = 'contenido';
const TIPOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

async function supa(ruta, metodo, cuerpo) {
  const r = await fetch(SUPA_URL + ruta, {
    method: metodo,
    headers: { apikey: SUPA_SR, Authorization: 'Bearer ' + SUPA_SR, 'Content-Type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const txt = await r.text();
  let datos; try { datos = JSON.parse(txt); } catch { datos = txt; }
  return { ok: r.ok, estado: r.status, datos };
}

function leerCuerpo(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) return resolve(req.body);
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, error: 'Método no permitido' }); }
  if (!SUPA_URL || !SUPA_SR) return res.status(500).json({ ok: false, error: 'Faltan variables de Supabase' });
  try {
    const payload = await leerCuerpo(req);
    const token = typeof payload.token === 'string' ? payload.token : '';
    if (!token) return res.status(401).json({ ok: false, error: 'Sesión requerida' });

    // Autorizar ANTES de mirar nada más del payload.
    const d = await supa('/rest/v1/rpc/sesion_es_dueno', 'POST', { p_token: token });
    if (!d.ok || d.datos !== true) return res.status(403).json({ ok: false, error: 'No autorizado' });

    const ext = TIPOS[payload.mimeType];
    if (!ext) return res.status(400).json({ ok: false, error: 'Formato no admitido. Usa JPG, PNG o WEBP.' });

    const ruta = `retos/${crypto.randomUUID()}.${ext}`;
    const f = await supa(`/storage/v1/object/upload/sign/${BUCKET}/${ruta}`, 'POST', {});
    if (!f.ok || !f.datos || !f.datos.url) {
      console.error('[imagen-reto.js] no se pudo firmar la subida:', f.estado, f.datos);
      return res.status(500).json({ ok: false, error: 'No se pudo preparar la subida' });
    }
    return res.status(200).json({ ok: true, ruta, url: SUPA_URL + '/storage/v1' + f.datos.url });
  } catch (e) {
    console.error('[imagen-reto.js] error:', e.message);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
};
