// ============================================================================
//  Crunchy Paps — Agente de WhatsApp (Meta Cloud API)
//  Vercel Serverless Function · repo: /api/whatsapp.js
//
//  Diseno: cambios/2026-11-12-agente-whatsapp.md
//  Plan:   cambios/2026-11-12-agente-whatsapp-plan.md
//
//  GET  -> verificacion del webhook de Meta (hub.challenge). Meta la hace una
//          vez, al conectar el numero.
//  POST -> mensaje entrante, firmado con X-Hub-Signature-256.
//
//  ENV: WA_VERIFY_TOKEN, WA_APP_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//       (las demas llegan con las tareas 4 y siguientes)
//
//  NOTA: `npm run validar` NO mira esta carpeta — ninguno de sus tres pasos abre
//  api/. La red de este archivo es `node --check api/whatsapp.js`, y va en cada
//  tarea del plan que lo toque.
// ============================================================================
const { createHmac, timingSafeEqual } = require('crypto');

const WA_VERIFY = process.env.WA_VERIFY_TOKEN;
const WA_SECRET = process.env.WA_APP_SECRET;
const SUPA_URL  = process.env.SUPABASE_URL;
const SUPA_SR   = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Los dos topes viven aqui, no en la base: afinarlos no deberia costar una
// migracion. La funcion wa_entrante los recibe como parametros.
const TOPE_POR_NUMERO = 40;    // mensajes entrantes por numero, en 24 h
const TOPE_GLOBAL     = 400;   // mensajes entrantes de todos, en 24 h

// ── La puerta ───────────────────────────────────────────────────────────────
// Compara en tiempo constante y NUNCA lanza: una firma con basura devuelve
// false, no un 500. Un 500 le diria a quien esta probando que acerto el formato
// y fallo por otra cosa; un 403 no le dice nada.
function firmaValida(crudo, firma, secreto) {
  if (typeof firma !== 'string' || typeof secreto !== 'string') return false;
  if (!firma || !secreto) return false;
  if (!firma.startsWith('sha256=')) return false;

  const esperada = 'sha256=' + createHmac('sha256', secreto).update(crudo, 'utf8').digest('hex');
  const a = Buffer.from(firma, 'utf8');
  const b = Buffer.from(esperada, 'utf8');
  if (a.length !== b.length) return false;   // timingSafeEqual lanza si difieren
  return timingSafeEqual(a, b);
}

// ── El cuerpo, byte a byte ──────────────────────────────────────────────────
// La firma se calcula sobre los BYTES que mando Meta. Reconstruir el JSON con
// JSON.stringify(req.body) funciona por suerte hasta que Meta cambia un espacio
// o el orden de una clave, y entonces falla sin explicacion. Asi que: el crudo
// o nada.
//
// Si el runtime ya consumio el stream, esto devuelve cadena vacia y la firma
// falla con 403 — que es ruidoso y se ve en el primer POST real, no silencioso.
// El arreglo entonces es apagar el parseo del body, no serializar req.body.
function leerCrudo(req) {
  if (typeof req.rawBody === 'string') return Promise.resolve(req.rawBody);
  if (Buffer.isBuffer(req.rawBody)) return Promise.resolve(req.rawBody.toString('utf8'));
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body.toString('utf8'));

  return new Promise((resolve, reject) => {
    let d = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { d += c; });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

// ── Supabase ────────────────────────────────────────────────────────────────
// El mismo helper que api/recordatorios-pago.js:36. Copiado a proposito y no
// extraido a un modulo: cada archivo de api/ es autocontenido en este proyecto.
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

// ── Los topes ───────────────────────────────────────────────────────────────
// Registra el mensaje que entra y dice si cabe. El conteo y el registro van en
// la misma llamada (wa_entrante), asi que no hay hueco entre contar y registrar.
async function registrarEntrante(telefono, texto) {
  const r = await supa('rpc/wa_entrante', 'POST', {
    p_telefono: telefono,
    p_texto: texto,
    p_tope_numero: TOPE_POR_NUMERO,
    p_tope_global: TOPE_GLOBAL,
  });
  // Si la base no contesta, se para. Un contador que falla abierto no es un tope:
  // justo el dia que Supabase va lento seria el dia sin limite de gasto.
  if (!r.ok || !r.data || typeof r.data.permitido !== 'boolean') {
    console.error('wa: wa_entrante no contesto', r.status, JSON.stringify(r.data).slice(0, 300));
    return { permitido: false, motivo: 'sin_base' };
  }
  return r.data;
}

// ── El mensaje que manda Meta ───────────────────────────────────────────────
// Meta tambien manda acuses de entrega y lecturas, que vienen sin `messages`.
// Devuelve null cuando no hay nada que atender.
function sacarMensaje(cuerpo) {
  try {
    const v = cuerpo.entry[0].changes[0].value;
    const m = v.messages && v.messages[0];
    if (!m) return null;
    return {
      id: m.id,
      telefono: m.from,
      tipo: m.type,
      texto: m.type === 'text' ? m.text.body : '',
      nombrePerfil: (v.contacts && v.contacts[0] && v.contacts[0].profile
        && v.contacts[0].profile.name) || '',
    };
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q['hub.mode'] === 'subscribe' && WA_VERIFY && q['hub.verify_token'] === WA_VERIFY) {
      return res.status(200).send(q['hub.challenge']);
    }
    return res.status(403).send('no');
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  let crudo;
  try {
    crudo = await leerCrudo(req);
  } catch (e) {
    console.error('wa: no se pudo leer el cuerpo', e && e.message);
    return res.status(403).json({ ok: false });
  }

  if (!firmaValida(crudo, req.headers['x-hub-signature-256'], WA_SECRET)) {
    // Sin detalle en la respuesta, con detalle en el registro.
    console.warn('wa: firma invalida', {
      bytes: crudo ? crudo.length : 0,
      traeFirma: Boolean(req.headers['x-hub-signature-256']),
      haySecreto: Boolean(WA_SECRET),
    });
    return res.status(403).json({ ok: false });
  }

  let cuerpo;
  try {
    cuerpo = JSON.parse(crudo);
  } catch {
    console.warn('wa: cuerpo firmado pero no es JSON');
    return res.status(200).json({ ok: true });   // firmado por Meta: no se discute
  }

  const msg = sacarMensaje(cuerpo);
  // Sin mensaje es un acuse de entrega o de lectura. 200 y a otra cosa: si no se
  // acusa recibo, Meta reintenta, y el reintento cuesta lo mismo que un mensaje.
  if (!msg) return res.status(200).json({ ok: true });

  const tope = await registrarEntrante(msg.telefono, msg.texto);
  if (!tope.permitido) {
    // Se calla. No se le contesta "te pasaste del limite" porque esa respuesta
    // tambien cuesta, y quien esta dando lata seguiria escribiendo.
    console.warn('wa: tope alcanzado', { motivo: tope.motivo, cuenta: tope.cuenta });
    return res.status(200).json({ ok: true, tope: tope.motivo });
  }

  // El trabajo de verdad —identidad, modelo, herramientas— entra en la tarea 4.
  // Meta reintenta si no recibe un 200 rapido, y un reintento es otro mensaje.
  return res.status(200).json({ ok: true });
};

module.exports.firmaValida = firmaValida;
module.exports.leerCrudo = leerCrudo;
module.exports.sacarMensaje = sacarMensaje;
