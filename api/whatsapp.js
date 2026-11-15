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

// Quien puede levantar un pedido se decide por el NIVEL, no por el flag
// aprobado_b2b. Los dos campos pueden contradecirse y de hecho se contradicen:
// el 14 nov 2026, el primer mensaje real llego de un cliente con
// tipo_id = 1 (Consumidor) y aprobado_b2b = true, y el agente le ofrecio
// levantarle un pedido. wa_identidad ya hacia lo correcto -devolvia
// nivel: 'consumidor'-; el error era mio, por mirar el flag en vez del nivel.
const NIVELES_QUE_PIDEN = ['tienda', 'restaurante', 'mayorista'];
function puedePedir(id) {
  return NIVELES_QUE_PIDEN.includes(String(id && id.nivel || '').toLowerCase());
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
    puedePedir(id)
      ? 'Es una tienda aprobada: puedes cotizar y levantar su pedido. El pedido queda PENDIENTE de que Abraham lo confirme, y se lo dices al cerrarlo.'
      : 'NO puedes crear pedidos para esta persona. Para comprar, mandale https://crunchypaps.mx',
    '',
    'Tienes tres herramientas y son tu unica fuente de datos:',
    '- catalogo: productos y precios. Usala ANTES de decir cualquier precio o de afirmar que un sabor existe.',
    '- fecha_entrega: cuando le toca la entrega a quien escribe.',
    '- mis_pedidos: sus ultimos pedidos, con folio y estatus.',
    '',
    'NUNCA inventes precios, sabores, existencias ni fechas. Si una herramienta falla, dilo:',
    'es mejor decir "no lo pude comprobar" que dar un dato que puede estar mal.',
    'Si no tienes herramienta para lo que piden, dilo y ofrece pasarlo con Abraham.',
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

// ── Las herramientas de lectura ─────────────────────────────────────────────
// Lista blanca cerrada: el modelo solo puede hacer lo que esta aqui. Nada de SQL
// libre, y ninguna escribe (tarea 7 trae la primera que escribe).
//
// El NIVEL de precio no es un parametro de ninguna herramienta: lo cierra el
// closure desde wa_identidad. Si fuera parametro, el modelo podria pedir precio
// de mayorista para un consumidor.
const COLUMNA_PRECIO = {
  consumidor: 'precio_consumidor',
  tienda: 'precio_tienda',
  restaurante: 'precio_restaurante',
  mayorista: 'precio_mayorista',
};

const HERRAMIENTAS = [
  {
    name: 'catalogo',
    description: 'Productos de Crunchy Paps con el precio que le toca a quien escribe. '
      + 'Usala SIEMPRE antes de decir un precio o afirmar que algo existe. Nunca cites precios de memoria.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        busca: { type: 'string', description: 'Filtra por sabor. Cadena vacia para traer todo.' },
      },
      required: ['busca'],
      additionalProperties: false,
    },
  },
  {
    name: 'fecha_entrega',
    description: 'La fecha de entrega que le corresponde a quien escribe, segun su ruta y la hora limite.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'mis_pedidos',
    description: 'Los ultimos pedidos de quien escribe, con folio, fecha, estatus y total.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

async function correrHerramienta(nombre, entrada, id) {
  if (nombre === 'catalogo') {
    const col = COLUMNA_PRECIO[id.nivel] || COLUMNA_PRECIO.consumidor;
    // `descontinuado` se filtra ademas de `activo`: cotizar_linea rechaza los
    // descontinuados, asi que ofrecerlos seria prometer algo que no se puede cobrar.
    let q = `productos?select=id,sabor,presentacion,gramos,tipo_venta,${col},precio_caja_3,precio_caja_6,precio_caja_12`
      + '&activo=eq.true&descontinuado=not.eq.true&order=orden.asc&limit=60';
    const busca = String((entrada && entrada.busca) || '').trim();
    if (busca) q += `&sabor=ilike.*${encodeURIComponent(busca)}*`;
    const r = await supa(q, 'GET');
    if (!r.ok) return 'No pude leer el catalogo. Dile que lo intentas en un momento y no inventes precios.';
    const filas = (Array.isArray(r.data) ? r.data : []).map((p) => ({
      id: p.id, sabor: p.sabor, presentacion: p.presentacion, gramos: p.gramos,
      tipoVenta: p.tipo_venta, precio: p[col],
      caja3: p.precio_caja_3, caja6: p.precio_caja_6, caja12: p.precio_caja_12,
    }));
    if (!filas.length) return 'No hay productos que coincidan con esa busqueda.';
    return JSON.stringify({ nivelDePrecio: id.nivel, productos: filas });
  }

  if (nombre === 'fecha_entrega') {
    const r = await supa('rpc/obtener_fecha_entrega', 'POST', { p_data: { telefono: id.telefono } });
    if (!r.ok || !r.data) return 'No pude calcular la fecha de entrega.';
    // OJO: `fechaDisplay` viene en espanglish ("Tuesday 17 de November"), asi que
    // NO se le pasa al modelo: diria eso tal cual a un cliente. Se manda la fecha
    // en ISO y el `msg`, que si esta bien escrito en espanol.
    return JSON.stringify({ fecha: r.data.fecha, explicacion: r.data.msg });
  }

  if (nombre === 'mis_pedidos') {
    if (!id.idCliente) return 'Esta persona no tiene pedidos: no esta registrada como cliente.';
    const r = await supa(
      'ordenes?select=consecutivo,fecha_orden,fecha_entrega,estatus_pedido,estatus_pago,total'
      + `&id_cliente=eq.${encodeURIComponent(id.idCliente)}&order=id.desc&limit=5`, 'GET');
    if (!r.ok) return 'No pude leer los pedidos.';
    if (!Array.isArray(r.data) || !r.data.length) return 'Todavia no tiene ningun pedido.';
    return JSON.stringify(r.data);
  }

  return 'Esa herramienta no existe.';
}

// ── El bucle ────────────────────────────────────────────────────────────────
// A mano y no con el toolRunner del SDK, a proposito: el runner devuelve el uso
// de la ULTIMA vuelta, y aqui hace falta sumar entrada y salida de TODAS para
// poder calcular el gasto de verdad. Tambien deja registrar que herramientas se
// usaron, que es lo que se guarda en `wa_mensajes.herramientas`.
const MAX_VUELTAS = 6;

async function responder(id, texto, hilo) {
  const mensajes = [...hilo, { role: 'user', content: texto }];
  const usadas = [];
  let entrada = 0, salida = 0;

  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    const r = await anthropic().beta.messages.create({
      model: MODELO,
      max_tokens: MAX_SALIDA,
      system: [{ type: 'text', text: sistema(id), cache_control: { type: 'ephemeral' } }],
      messages: mensajes,
      tools: HERRAMIENTAS,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
    });

    entrada += (r.usage && r.usage.input_tokens) || 0;
    salida  += (r.usage && r.usage.output_tokens) || 0;

    // stop_reason se mira ANTES de leer content: en una negativa el contenido no
    // es la respuesta que el cliente espera.
    if (r.stop_reason === 'refusal') {
      return { texto: 'Eso no lo puedo resolver por aqui. Le aviso a Abraham para que te escriba.',
               entrada, salida, usadas, negada: true };
    }

    if (r.stop_reason !== 'tool_use') {
      const dicho = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return {
        texto: dicho || 'Perdon, no te entendi. Me lo puedes decir de otra forma?',
        entrada, salida, usadas, negada: false,
      };
    }

    mensajes.push({ role: 'assistant', content: r.content });

    // Todos los resultados van en UN solo mensaje de usuario. Partirlos en varios
    // le ensena al modelo a dejar de pedir herramientas en paralelo.
    const resultados = [];
    for (const b of r.content.filter((x) => x.type === 'tool_use')) {
      usadas.push(b.name);
      let out;
      try {
        out = await correrHerramienta(b.name, b.input, id);
      } catch (e) {
        console.error('wa: herramienta fallo', b.name, e && e.message);
        out = 'Esa consulta fallo. No inventes el dato: dile que no lo pudiste comprobar.';
      }
      resultados.push({ type: 'tool_result', tool_use_id: b.id, content: String(out) });
    }
    mensajes.push({ role: 'user', content: resultados });
  }

  // Se acabaron las vueltas sin respuesta. Mejor decirlo que colgar la llamada.
  console.warn('wa: se agotaron las vueltas de herramientas', { usadas });
  return {
    texto: 'Se me complico consultar eso. Dejame avisarle a Abraham y te escribe.',
    entrada, salida, usadas, negada: false,
  };
}

// ── La salida ───────────────────────────────────────────────────────────────
// MEXICO: WhatsApp entrega el `from` de un numero mexicano como 52 + 1 + diez
// digitos (13 en total), pero el numero canonico —el que esta en la agenda, en
// la lista de destinatarios de prueba y en `clientes`— es 52 + diez (12). Si se
// contesta al de 13, Meta responde:
//
//   (#131030) Recipient phone number not in allowed list
//
// y el agente parece mudo: redacta la respuesta y nadie la recibe. Se vio el
// 14 nov 2026 con el primer mensaje real, llegado desde 5215540801794.
//
// Solo se toca el caso de Mexico. Otros paises con la misma mania —Argentina
// mete un 9— se arreglan cuando aparezcan, no antes.
function normalizarDestino(telefono) {
  const d = String(telefono || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('521')) return '52' + d.slice(3);
  return d;
}

async function enviarWA(telefono, texto) {
  const destino = normalizarDestino(telefono);
  const r = await fetch(`https://graph.facebook.com/${WA_GRAPH}/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: destino,
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

  // El resultado del envio se GUARDA. Antes la fila `sale` se escribia pasara
  // lo que pasara, asi que leerla parecia prueba de que el cliente recibio algo
  // y no lo era: el 14 nov hubo tres respuestas redactadas y cero entregadas,
  // con la fila puesta igual. Regla 14: el "hecho" de una herramienta no es
  // evidencia de que la accion ocurriera.
  const entregado = await enviarWA(msg.telefono, salida.texto);
  // `tokens` guarda la SUMA, por compatibilidad con lo ya escrito; el reparto va
  // aparte, porque entrada y salida cuestan distinto (4 y 20 dolares por millon)
  // y con el total sumado el gasto solo se puede estimar, no calcular.
  await registrarSaliente(msg.telefono, salida.texto, {
    entregado,
    usadas: salida.usadas,
    entrada: salida.entrada,
    salida: salida.salida,
  }, (salida.entrada || 0) + (salida.salida || 0));
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
module.exports.normalizarDestino = normalizarDestino;
module.exports.puedePedir = puedePedir;
module.exports.HERRAMIENTAS = HERRAMIENTAS;
module.exports.COLUMNA_PRECIO = COLUMNA_PRECIO;
