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
//  ENV: WA_VERIFY_TOKEN, WA_APP_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//       WA_TOKEN, WA_PHONE_ID, ANTHROPIC_API_KEY, WA_GRAPH_VERSION (opcional)
//       (las herramientas y WA_VENDEDOR_TOKEN llegan con las tareas 5 a 7)
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

const WA_TOKEN    = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID;
// v25.0 es la que usa la documentacion de Meta en noviembre de 2026. Cada version
// vive unos dos anos. Esta en una variable para poder subirla sin tocar codigo, y
// hay que comprobarla contra el endpoint /versions antes de desplegar.
const WA_GRAPH = process.env.WA_GRAPH_VERSION || 'v25.0';

const MODELO = 'claude-opus-5-5';
const MAX_TURNOS = 24;         // turnos de texto que se guardan del hilo
const MAX_SALIDA = 4096;       // una respuesta de WhatsApp es corta: esto es tope, no meta

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

// ── El hilo ─────────────────────────────────────────────────────────────────
// Se guardan SOLO los turnos de texto, no las llamadas a herramientas. Dos
// razones: un historial con un tool_use sin su tool_result al lado lo rechaza la
// API, y podar por la mitad de un par es facilisimo; y lo que el agente necesita
// recordar de un mensaje al siguiente ("te cotice 6 cajas en $1,240") esta en su
// propio texto. Antes de crear un pedido vuelve a cotizar de todas formas.
function podarHilo(hilo, maxTurnos) {
  if (!Array.isArray(hilo)) return [];
  const n = Math.max(0, Number(maxTurnos) || 0);
  let p = hilo.slice(-n);
  // La API rechaza un historial que empiece por el asistente. Si el corte cayo
  // ahi, se tira uno mas: mejor un turno menos que un 400 en cada mensaje.
  while (p.length && p[0].role !== 'user') p = p.slice(1);
  return p;
}

async function leerHilo(telefono) {
  const r = await supa(
    `wa_conversaciones?select=hilo,bloqueado&telefono=eq.${encodeURIComponent(telefono)}`, 'GET');
  const fila = r.ok && Array.isArray(r.data) ? r.data[0] : null;
  return {
    hilo: podarHilo(fila && fila.hilo, MAX_TURNOS),
    bloqueado: Boolean(fila && fila.bloqueado),
  };
}

async function guardarHilo(telefono, hilo) {
  const r = await supa('wa_conversaciones', 'POST', {
    telefono,
    hilo: podarHilo(hilo, MAX_TURNOS),
    actualizado_en: new Date().toISOString(),
  }, 'resolution=merge-duplicates,return=minimal');
  if (!r.ok) console.error('wa: no se pudo guardar el hilo', r.status);
}

async function registrarSaliente(telefono, texto, herramientas, tokens) {
  const r = await supa('wa_mensajes', 'POST', {
    telefono, direccion: 'sale', texto,
    herramientas: herramientas || null,
    tokens: tokens || null,
  }, 'return=minimal');
  // Que falle el registro no impide contestarle al cliente, pero no se traga en
  // silencio: sin esta fila, lo que dijo el agente no existe en ningun sitio.
  if (!r.ok) console.error('wa: no se pudo registrar la salida', r.status);
}

// ── El prompt ───────────────────────────────────────────────────────────────
// El nivel de precio entra como DATO YA RESUELTO por el servidor. El modelo no
// lo elige y no tiene ninguna herramienta para cambiarlo (D6 del diseno).
function sistema(id) {
  return [
    'Eres el asistente de WhatsApp de Crunchy Paps: papas y snacks saborizados, en CDMX.',
    'Hablas espanol de Mexico. Breve y directo, sin emoji. Si te preguntan, di que eres un asistente.',
    '',
    id.esCliente
      ? `Escribe ${id.nombre}. Nivel de precio: ${id.nivel}.`
      : 'Escribe alguien que no esta en la base. Tratalo como consumidor.',
    '',
    id.aprobadoB2B
      ? 'Es una tienda aprobada: puedes cotizar y levantar su pedido. El pedido queda PENDIENTE de que Abraham lo confirme, y se lo dices al cerrarlo.'
      : 'NO puedes crear pedidos para esta persona. Para comprar, mandale https://crunchypaps.mx',
    '',
    'Nunca inventes precios, existencias ni fechas: salen de las herramientas.',
    'Si no tienes una herramienta para lo que piden, dilo y ofrece pasarlo con Abraham.',
    'No prometas nada que no puedas comprobar.',
  ].join('\n');
}

// ── El modelo ───────────────────────────────────────────────────────────────
// El cliente se construye al usarlo, no al cargar el modulo: sin
// ANTHROPIC_API_KEY el constructor lanza, y eso tumbaria hasta las pruebas que
// solo tocan podarHilo().
let _anthropic = null;
function anthropic() {
  if (!_anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    _anthropic = new Anthropic();
  }
  return _anthropic;
}

async function responder(id, texto, hilo) {
  const mensajes = [...hilo, { role: 'user', content: texto }];
  const r = await anthropic().beta.messages.create({
    model: MODELO,
    max_tokens: MAX_SALIDA,
    system: [{ type: 'text', text: sistema(id), cache_control: { type: 'ephemeral' } }],
    messages: mensajes,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium' },
  });

  // stop_reason se mira ANTES de leer content: en una negativa el contenido no
  // es la respuesta que el cliente espera.
  if (r.stop_reason === 'refusal') {
    return { texto: 'Eso no lo puedo resolver por aqui. Le aviso a Abraham para que te escriba.',
             tokens: r.usage ? r.usage.output_tokens : null, negada: true };
  }

  const salida = r.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return {
    texto: salida || 'Perdon, no te entendi. Me lo puedes decir de otra forma?',
    tokens: r.usage ? (r.usage.input_tokens + r.usage.output_tokens) : null,
    negada: false,
  };
}

// ── La salida ───────────────────────────────────────────────────────────────
async function enviarWA(telefono, texto) {
  const r = await fetch(`https://graph.facebook.com/${WA_GRAPH}/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'text',
      text: { body: String(texto).slice(0, 4000) },
    }),
  });
  if (!r.ok) {
    // Un catch vacio aqui dejaria al cliente esperando sin rastro de por que.
    const detalle = await r.text().catch(() => '');
    console.error('wa: envio fallo', r.status, detalle.slice(0, 500));
    return false;
  }
  // Meta acusa que ACEPTO el mensaje, no que lo entrego. No se promete mas.
  return true;
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

  // Identidad: el `from` del webhook ya prueba posesion del numero, asi que el
  // nivel de precio sale de aqui y NUNCA del modelo ni del cliente (D6).
  const ident = (await supa('rpc/wa_identidad', 'POST', { p_telefono: msg.telefono })).data;
  if (!ident || ident.ok !== true) {
    console.error('wa: wa_identidad no contesto', JSON.stringify(ident).slice(0, 200));
    await enviarWA(msg.telefono, 'Ahorita no puedo consultar tus datos. Intenta en un momento.');
    return res.status(200).json({ ok: true });
  }
  const id = { ...ident, telefono: msg.telefono, idMensaje: msg.id };

  const { hilo, bloqueado } = await leerHilo(msg.telefono);
  if (bloqueado) {
    console.warn('wa: conversacion bloqueada', msg.telefono);
    return res.status(200).json({ ok: true, bloqueado: true });
  }

  // De momento solo texto. Un audio o una foto no se ignoran —hay alguien del
  // otro lado— pero tampoco se inventan: se dice lo que hay.
  if (msg.tipo !== 'text' || !msg.texto) {
    const aviso = 'Por aqui solo leo mensajes de texto. Me lo escribes?';
    await enviarWA(msg.telefono, aviso);
    await registrarSaliente(msg.telefono, aviso, null, 0);
    return res.status(200).json({ ok: true });
  }

  let salida;
  try {
    salida = await responder(id, msg.texto, hilo);
  } catch (e) {
    console.error('wa: el modelo fallo', e && e.message);
    await enviarWA(msg.telefono, 'Se me trabo el sistema. Lo intento de nuevo en un momento.');
    return res.status(200).json({ ok: true, error: 'modelo' });
  }

  await enviarWA(msg.telefono, salida.texto);
  await registrarSaliente(msg.telefono, salida.texto, null, salida.tokens);
  await guardarHilo(msg.telefono, [
    ...hilo,
    { role: 'user', content: msg.texto },
    { role: 'assistant', content: salida.texto },
  ]);

  // Meta reintenta si no recibe un 200 rapido, y un reintento es otro mensaje.
  return res.status(200).json({ ok: true });
};

module.exports.firmaValida = firmaValida;
module.exports.leerCrudo = leerCrudo;
module.exports.sacarMensaje = sacarMensaje;
module.exports.podarHilo = podarHilo;
module.exports.sistema = sistema;
module.exports.MAX_TURNOS = MAX_TURNOS;
