// ============================================================================
//  Crunchy Paps — OTP por EMAIL (canal alterno al SMS/WhatsApp)
//  Vercel Serverless Function · colócalo en el repo como  /api/otp-email.js
//
//  El código se GENERA y VERIFICA aquí (no en Twilio), se guarda en la tabla
//  Supabase `otp_codigos` y se envía con Resend. La identidad sigue siendo el
//  teléfono (igual que el flujo SMS), así el resto del login no cambia.
//
//  Variables de entorno requeridas en Vercel:
//    SUPABASE_URL                 (ya existe en el proyecto)
//    SUPABASE_SERVICE_ROLE_KEY    (Service role — SECRETO, solo backend)
//    RESEND_API_KEY               (de resend.com)
//    OTP_FROM_EMAIL  (opcional)   ej. "Crunchy Paps <no-reply@crunchypaps.mx>"
//                                 Si no se define, usa el remitente de prueba.
//
//  Acciones (POST JSON):
//    { accion:'enviar',   telefono, email }          -> envía el código
//    { accion:'verificar', telefono, codigo }         -> { ok, verificado }
// ============================================================================

const crypto = require('crypto');

const SUPA_URL   = process.env.SUPABASE_URL;
const SUPA_SR    = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM       = process.env.OTP_FROM_EMAIL || 'Crunchy Paps <onboarding@resend.dev>';

const CODE_TTL_MIN   = 10;  // minutos de vigencia
const MAX_INTENTOS   = 5;   // intentos de verificación por código

function hashCode(code, tel) {
  return crypto.createHash('sha256').update(code + '|' + tel).digest('hex');
}

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

function emailHTML(code) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:0 auto;border:1px solid #eee;border-radius:14px;overflow:hidden;">
    <div style="background:#FFD200;padding:16px 20px;font-weight:900;font-size:18px;color:#111;">🍟 Crunchy Paps</div>
    <div style="padding:24px 20px;color:#222;">
      <p style="margin:0 0 8px;font-size:15px;">Tu código de verificación es:</p>
      <div style="font-size:34px;font-weight:900;letter-spacing:8px;color:#111;background:#f5f5f5;border-radius:10px;padding:14px;text-align:center;">${code}</div>
      <p style="margin:16px 0 0;font-size:13px;color:#666;">Válido por ${CODE_TTL_MIN} minutos. Si no lo solicitaste, ignora este correo.</p>
    </div>
  </div>`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Método no permitido' }); return; }
  if (!SUPA_URL || !SUPA_SR || !RESEND_KEY) {
    res.status(500).json({ ok: false, error: 'Faltan variables de entorno (Supabase/Resend)' }); return;
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const accion = body.accion;
    const telefono = (body.telefono || '').toString().replace(/\D/g, '');
    if (telefono.length < 10) { res.status(400).json({ ok: false, error: 'Teléfono inválido' }); return; }

    // ── ENVIAR ──────────────────────────────────────────────────────────
    if (accion === 'enviar') {
      const email = (body.email || '').toString().trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        res.status(400).json({ ok: false, error: 'Correo inválido' }); return;
      }
      // Límite de envíos. Sustituye al anti-spam de 30 s que había aquí: aquel
      // funcionaba (vivía en la base, no en memoria) pero solo miraba ESTE
      // teléfono, y sin tope global. Quien manda una vez a mil correos no lo
      // notaba. `registrar_envio_otp` aplica ambos límites y es el mismo
      // control que usa el canal SMS.
      //
      // Si la comprobación falla por red, se deja pasar: dejar sin código a un
      // cliente legítimo por una caída interna es peor que un correo de más.
      try {
        const lim = await supa('rpc/registrar_envio_otp', 'POST',
          { p_telefono: telefono, p_canal: 'email' });
        if (lim.ok && lim.data && lim.data.ok === false) {
          res.status(429).json({ ok: false, error: lim.data.error || 'Demasiados intentos' });
          return;
        }
      } catch (_e) { /* sin control: se continúa */ }
      // Invalidar códigos previos no usados de este teléfono
      await supa(`otp_codigos?telefono=eq.${encodeURIComponent(telefono)}&usado=eq.false`, 'PATCH', { usado: true });

      // §3.8: era Math.random(), que NO es criptográficamente seguro para un
      // código de acceso. crypto.randomInt sí lo es.
      const code = String(crypto.randomInt(100000, 1000000));
      const ins = await supa('otp_codigos', 'POST', {
        telefono,
        email,
        codigo_hash: hashCode(code, telefono),
        expira_en: new Date(Date.now() + CODE_TTL_MIN * 60000).toISOString(),
        usado: false,
        intentos: 0,
      });
      if (!ins.ok) { res.status(500).json({ ok: false, error: 'No se pudo registrar el código' }); return; }

      const er = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM,
          to: [email],
          subject: `Tu código Crunchy Paps: ${code}`,
          html: emailHTML(code),
        }),
      });
      if (!er.ok) {
        const et = await er.text();
        res.status(502).json({ ok: false, error: 'No se pudo enviar el correo', detalle: et.slice(0, 200) }); return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    // ── VERIFICAR ───────────────────────────────────────────────────────
    if (accion === 'verificar') {
      const codigo = (body.codigo || '').toString().trim();
      if (!/^\d{6}$/.test(codigo)) { res.status(400).json({ ok: false, error: 'Código inválido' }); return; }

      const q = await supa(
        `otp_codigos?telefono=eq.${encodeURIComponent(telefono)}&usado=eq.false&order=creado.desc&limit=1`,
        'GET'
      );
      const row = Array.isArray(q.data) && q.data[0];
      if (!row) { res.status(200).json({ ok: true, verificado: false, error: 'No hay código vigente' }); return; }
      if (new Date(row.expira_en).getTime() < Date.now()) {
        res.status(200).json({ ok: true, verificado: false, error: 'El código expiró' }); return;
      }
      if ((row.intentos || 0) >= MAX_INTENTOS) {
        res.status(200).json({ ok: true, verificado: false, error: 'Demasiados intentos, pide otro código' }); return;
      }
      if (row.codigo_hash !== hashCode(codigo, telefono)) {
        await supa(`otp_codigos?id=eq.${row.id}`, 'PATCH', { intentos: (row.intentos || 0) + 1 });
        res.status(200).json({ ok: true, verificado: false, error: 'Código incorrecto' }); return;
      }
      await supa(`otp_codigos?id=eq.${row.id}`, 'PATCH', { usado: true });

      // ── Emitir la sesión de cliente ───────────────────────────────────────
      // Este es el único punto del sistema donde queda acreditado que alguien
      // controla ese teléfono. Hasta ahora el navegador solo recibía
      // { verificado: true } y después mandaba el teléfono como parámetro en
      // cada consulta, así que cualquiera podía pedir los datos de cualquiera.
      //
      // `emitir_sesion_cliente` NO es invocable con la llave anon: solo con
      // service_role, que es lo que tiene esta función. Por eso el token se
      // emite aquí y no en el navegador.
      let sesion = null;
      try {
        const r = await supa('rpc/emitir_sesion_cliente', 'POST', { p_telefono: telefono });
        if (r.ok && r.data && r.data.ok) sesion = r.data;
      } catch (_e) { /* sin token: se responde verificado igualmente */ }

      // Se responde verificado aunque el token falle. El código OTP era
      // correcto, y negar el acceso por un fallo que no es del cliente sería
      // peor: sin token verá menos cosas, no cosas de otros.
      res.status(200).json({
        ok: true, verificado: true,
        token:    sesion ? sesion.token    : null,
        expiraEn: sesion ? sesion.expiraEn : null,
      });
      return;
    }

    res.status(400).json({ ok: false, error: 'Acción no soportada' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
