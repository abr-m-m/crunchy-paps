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

const WA_TOKEN    = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID;
// v25.0 es la que usa la documentacion de Meta en noviembre de 2026. Cada version
// vive unos dos anos. Esta en una variable para poder subirla sin tocar codigo, y
// hay que comprobarla contra el endpoint /versions antes de desplegar.
const WA_GRAPH = process.env.WA_GRAPH_VERSION || 'v25.0';

const MAX_SALIDA = 4096;       // tope duro de una respuesta; el largo lo fija el prompt

// ── Los ajustes ─────────────────────────────────────────────────────────────
// Los numeros y los interruptores viven en la BASE, clave `agente_whatsapp` de
// config_produccion (migracion 20261115000000). Decision de Abraham el 14 nov
// 2026, y lo que de verdad compra es `activo`: si el agente se desmadra un
// sabado, callarlo es un UPDATE y no un despliegue.
//
// Lo de aqui abajo son los MISMOS valores, y son la red. Si la base no contesta
// o devuelve basura, se usan estos: un ajuste que falla abierto no es un ajuste,
// porque justo el dia que Supabase va lento seria el dia sin topes.
//
// El prompt NO esta en la base, a proposito: es logica, pasa por seis pruebas y
// por el CI, y un parrafo mal escrito ahi llega a un cliente sin que nadie lo
// mire.
const POR_DEFECTO = {
  activo: true,
  modelo: 'claude-opus-5-5',
  effort: 'medium',
  tope_por_numero: 40,      // mensajes entrantes por numero, en 24 h
  tope_global: 400,         // mensajes entrantes de todos, en 24 h
  max_turnos: 24,           // turnos de texto que se guardan del hilo
  max_vueltas: 6,           // herramientas encadenadas antes de rendirse
  max_lineas: 20,
  max_piezas_linea: 2000,
  avisar_a: [],
  avisos_por_dia: 2,
  // Cuanto se calla el agente tras pasar una conversacion con una persona.
  // Ocho horas es tambien lo que trae por omision el bot de la ferreteria del
  // reel que trajo Abraham el 18 nov; se cambia en /agente sin desplegar.
  callar_horas: 8,
  // Cuanto espera antes de contestar, para juntar los mensajes que la gente
  // manda partidos en dos o tres. 0 lo apaga y contesta al instante, que es el
  // comportamiento de siempre.
  juntar_segundos: 6,
  mensaje_apagado: 'Ahorita no te puedo atender por aqui. Escribenos en crunchypaps.mx y te respondemos.',
};

// Estado de modulo, refrescado al principio de CADA peticion. En serverless no
// hay memoria entre invocaciones (regla 44), asi que esto no es una cache: es
// una variable que se llena al empezar. Si Vercel reutiliza el contenedor para
// dos peticiones a la vez, las dos leen los mismos ajustes globales -no hay nada
// por usuario aqui-, asi que compartirla no cambia ninguna respuesta.
let AJ = { ...POR_DEFECTO };

async function cargarAjustes() {
  AJ = { ...POR_DEFECTO };
  try {
    const r = await supa('rpc/wa_ajustes', 'POST', {});
    if (r.ok && r.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
      // Clave a clave y por TIPO: una clave con el tipo cambiado -un tope que
      // llega como texto- haria algo peor que fallar, haria algo raro.
      for (const [k, def] of Object.entries(POR_DEFECTO)) {
        const v = r.data[k];
        if (v === undefined || v === null) continue;
        if (typeof def === 'number' && Number.isFinite(Number(v))) AJ[k] = Number(v);
        else if (typeof def === 'boolean' && typeof v === 'boolean') AJ[k] = v;
        else if (typeof def === 'string' && typeof v === 'string' && v) AJ[k] = v;
        else if (Array.isArray(def) && Array.isArray(v)) AJ[k] = v;
      }
    } else {
      console.warn('wa: wa_ajustes no contesto, van los valores del codigo', r.status);
    }
  } catch (e) {
    console.warn('wa: wa_ajustes fallo, van los valores del codigo', e && e.message);
  }
  return AJ;
}

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

// El UNICO punto por donde una prueba puede sustituir el transporte de la
// cotizacion. Existe porque la llave de servicio no se puede obtener del CLI de
// Supabase -solo entrega las legacy, apagadas el 18 sep 2026, y trunca las
// nuevas-, asi que sin esto la parte del dinero no se puede probar en local sin
// meter un secreto en el disco.
//
// Lo que compra: la prueba puede ESPIAR con que `p_nivel` se llama al servidor,
// que es exactamente la propiedad de D6 y se ve mejor espiando la llamada que
// mirando el total.
//
// Y se cierra con llave en produccion: en Vercel, llamarlo lanza. Un gancho de
// pruebas que en produccion sigue abierto no es un gancho, es una puerta.
// (se exporta al final del archivo: `module.exports = handler` reemplaza el objeto
// entero, asi que cualquier cosa colgada de module.exports ANTES de esa linea se
// pierde sin avisar. node --check no lo ve y comprobar-libres.mjs tampoco.)
let transporte = (...a) => supa(...a);
function usarTransporteDePrueba(f) {
  if (process.env.VERCEL) throw new Error('el transporte de prueba no se sustituye en produccion');
  transporte = typeof f === 'function' ? f : ((...a) => supa(...a));
}

// ── Los topes ───────────────────────────────────────────────────────────────
// Registra el mensaje que entra y dice si cabe. El conteo y el registro van en
// la misma llamada (wa_entrante), asi que no hay hueco entre contar y registrar.
async function registrarEntrante(telefono, texto) {
  const r = await supa('rpc/wa_entrante', 'POST', {
    p_telefono: telefono,
    p_texto: texto,
    p_tope_numero: AJ.tope_por_numero,
    p_tope_global: AJ.tope_global,
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
    `wa_conversaciones?select=hilo,bloqueado,callado_hasta&telefono=eq.${encodeURIComponent(telefono)}`,
    'GET');
  const fila = r.ok && Array.isArray(r.data) ? r.data[0] : null;
  return {
    hilo: podarHilo(fila && fila.hilo, AJ.max_turnos),
    bloqueado: Boolean(fila && fila.bloqueado),
    // Crudo, sin interpretar: quien decide es `sigueCallado`, que es pura y se
    // prueba sola. Aqui solo se trae lo que dijo la base.
    calladoHasta: (fila && fila.callado_hasta) || null,
  };
}

async function guardarHilo(telefono, hilo) {
  const r = await supa('wa_conversaciones', 'POST', {
    telefono,
    hilo: podarHilo(hilo, AJ.max_turnos),
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

// ── Los temas ───────────────────────────────────────────────────────────────
// De que habla el agente y hasta donde. Vive en la base (`wa_temas`, migracion
// 20261115000003) y Abraham lo edita en /agente; esto es la red para cuando la
// base no contesta, y dice EXACTAMENTE lo que decia el prompt antes de que la
// tabla existiera, para que el agente se comporte igual que ayer en vez de
// quedarse sin criterio.
//
// El alcance es lista cerrada de cuatro valores, no texto libre, y la traduccion
// de cada uno vive AQUI, en el repo: asi un tema nuevo no puede meter un parrafo
// sin revisar en lo que lee un cliente.
const COMO_SE_TRATA = {
  responde: 'contesta normal, usando las herramientas que haga falta',
  breve: 'contesta en 2 o 3 frases COMO MUCHO y vuelve al negocio; nada de listas de pasos ni recetas completas',
  deriva: 'no lo resuelvas tu: recoge los datos y pasalo con el equipo',
  no: 'no entres en el tema; dilo con amabilidad y ofrece el catalogo',
};

// SIN tema de recetas, y es correccion de Abraham del 15 nov 2026: las recetas
// fueron un EJEMPLO DE PRUEBA, no un caso real. Nadie le pregunta al agente de
// una marca de papas por cocina, viajes ni como arreglar un refrigerador, y
// darles tratamiento propio era convertir mi caso de medicion en politica del
// negocio. Todo eso cae en el ultimo tema: no entra.
const TEMAS_POR_DEFECTO = [
  { tema: 'Precios, sabores, pedidos y entregas', alcance: 'responde' },
  { tema: 'Dudas sueltas del producto (si pican, alergenos)', alcance: 'breve' },
  { tema: 'Quejas, cancelaciones y cambios', alcance: 'deriva' },
  { tema: 'Cualquier cosa ajena al negocio', alcance: 'no' },
];

let TEMAS = TEMAS_POR_DEFECTO;

async function cargarTemas() {
  TEMAS = TEMAS_POR_DEFECTO;
  try {
    const r = await supa('rpc/wa_temas_vigentes', 'POST', {});
    const lista = r.ok && Array.isArray(r.data) ? r.data : null;
    // Una lista VACIA no se acepta: que no haya temas configurados no significa
    // que el agente deba quedarse sin criterio, significa que nadie los puso.
    if (lista && lista.length) {
      TEMAS = lista.filter((t) => t && t.tema && COMO_SE_TRATA[t.alcance]);
    } else {
      console.warn('wa: sin temas en la base, van los del codigo', r.status);
    }
  } catch (e) {
    console.warn('wa: wa_temas_vigentes fallo, van los del codigo', e && e.message);
  }
  return TEMAS;
}

function textoDeTemas() {
  const lineas = ['DE QUE HABLAS Y HASTA DONDE:'];
  for (const t of TEMAS) {
    let l = `- ${t.tema}: ${COMO_SE_TRATA[t.alcance] || COMO_SE_TRATA.responde}`;
    if (t.nota) l += `. ${t.nota}`;
    if (t.ejemplos) l += ` (p. ej. "${String(t.ejemplos).split('|').join('", "')}")`;
    lineas.push(l);
  }
  lineas.push('Si lo que preguntan no encaja en ninguno, tratalo como el tema mas parecido.');
  return lineas.join('\n');
}

// ── Juntar lo que llego partido ─────────────────────────────────────────────
// WhatsApp manda de vez en cuando textos vacios, y un mensaje con solo espacios
// no aporta nada al modelo: se tiran aqui en vez de mandarselos.
function juntarPendientes(lista) {
  if (!Array.isArray(lista)) return '';
  return lista.map((t) => String(t == null ? '' : t).trim()).filter(Boolean).join('\n');
}

// ── El prompt ───────────────────────────────────────────────────────────────
// El nivel de precio entra como DATO YA RESUELTO por el servidor. El modelo no
// lo elige y no tiene ninguna herramienta para cambiarlo (D6 del diseno).
function sistema(id) {
  return [
    'Eres el asistente de WhatsApp de Crunchy Paps: papas y snacks saborizados, en CDMX.',
    'Hablas espanol de Mexico. Breve y directo, sin emoji. Si te preguntan, di que eres un asistente.',
    '',
    // EL ORDEN DE ESTAS RAMAS IMPORTA, y no es cosmetico: `esCliente` va ANTES
    // que `esVendedor` porque es la rama que lleva el NIVEL DE PRECIO. Alguien
    // del equipo que ademas sea tendero tiene que seguir viendo su precio de
    // tienda; si `esVendedor` fuera primero, lo perderia en silencio.
    id.esDueno
      ? `Escribe ${id.nombre || 'el dueno'}, el DUENO de Crunchy Paps. No le vendas ni le `
        + 'ofrezcas el catalogo: es quien manda. Contesta lo que te pregunte del negocio con las '
        + 'herramientas que tengas, y si no tienes herramienta para algo, dilo claro en vez de '
        + 'rodearlo.'
      : id.esCliente
      ? `Escribe ${id.nombre}. Nivel de precio: ${id.nivel}.`
        + (id.esVendedor ? ` Ademas es del equipo (${id.rol}).` : '')
      : id.esVendedor
      ? `Escribe ${id.nombre || 'alguien'} del equipo de Crunchy Paps (${id.rol}), que no esta `
        + 'dado de alta como cliente. No le ofrezcas comprar.'
      : 'Escribe alguien que no esta en la base. Tratalo como consumidor.',
    '',
    // Al dueño no se le dan instrucciones de venta: acabamos de decirle al
    // modelo que no le venda. Salio de MIRAR el prompt armado (regla 30): decia
    // «no le ofrezcas el catalogo» y tres lineas despues «para comprar, mandale
    // crunchypaps.mx».
    id.esDueno ? '' :
    puedePedir(id)
      ? 'Es una tienda aprobada: puedes cotizar y levantar su pedido. Antes de crearlo, el cliente '
        + 'tiene que CONFIRMAR el total con sus palabras; no lo des por confirmado porque te haya '
        + 'dicho que sabores quiere. El pedido queda PENDIENTE de que lo confirme el equipo, y eso se '
        + 'lo dices siempre al cerrarlo.'
      : 'NO puedes crear pedidos para esta persona. Para comprar, mandale https://crunchypaps.mx',
    '',
    // Esta linea existe porque cotizar_linea solo aplica el precio de caja si la
    // cantidad es MULTIPLO EXACTO de la caja. Sin decirselo, el agente ofrece
    // "12 piezas por $x la caja de 6" y el servidor cobra otra cosa.
    id.esDueno ? '' :
    NIVELES_CON_CAJA.includes(id.nivel)
      ? 'Si el catalogo trae caja3, caja6 o caja12, ese precio SOLO aplica a multiplos exactos de esa caja y de un solo sabor: 12 piezas con caja de 6 son 2 cajas, pero 7 piezas se cobran por pieza.'
      : 'Esta persona no compra por caja: cotiza siempre por pieza.',
    '',
    'Tus herramientas son tu unica fuente de datos:',
    '- catalogo: productos y precios. Usala ANTES de decir cualquier precio o de afirmar que un sabor existe.',
    '- fecha_entrega: cuando le toca la entrega a quien escribe.',
    '- mis_pedidos: sus ultimos pedidos, con folio y estatus.',
    '- cotizar: el total de una lista de lineas.',
    puedePedir(id)
      ? '- crear_pedido: lo registra. Solo despues de cotizar Y de que el cliente confirme ese total.'
      : '',
    (!id.esDueno && Array.isArray(AJ.avisar_a) && AJ.avisar_a.filter(Boolean).length)
      ? '- pasar_con_una_persona: avisa al equipo. Si piden hablar con alguien, si no puedes hacer algo, o si hay un reclamo.'
      : '',
    // Al dueño no se le dice que puede escalar -no tiene a quien- sino que lo
    // que no puedas contestar se APUNTA. Es la diferencia entre pasar el
    // problema y reconocerlo.
    id.esDueno
      ? '- ventas: lo que vendio el NEGOCIO en un periodo, y cuando fue el ultimo dia con ventas. No la confundas con mis_pedidos, que solo ve los de quien escribe.'
      : '',
    id.esDueno
      ? '- registrar_hueco: cuando te pregunte algo del negocio y NO tengas herramienta para '
        + 'contestarlo, dilo claro y apuntalo con esta. No le digas que se lo pasas a alguien: '
        + 'el ES el equipo.'
      : '',
    // Cancelar mueve lote, caja, puntos y, con Stripe, un reembolso real. No es
    // una accion de chat.
    'NO puedes cancelar ni modificar un pedido ya hecho, ni cambiar una direccion, ni devolver dinero.',
    id.esDueno
      ? 'Si te lo pide, recoge el folio y dile que lo haga el mismo en crunchypaps.mx: cancelar mueve el lote, la caja, los puntos y, con Stripe, un reembolso de verdad.'
      : 'Si te lo piden, no digas que esta hecho: recoge el folio y el motivo y pasalo con el equipo.',
    '',
    // El modelo suma bien casi siempre, y ese "casi" es el problema: 12 x 27 lo
    // hace de memoria sin llamar a nada, y el dia que falle nadie lo revisa.
    'NUNCA calcules un total tu. Ni una multiplicacion, ni una suma, ni un redondeo, ni "mas o',
    'menos". Aunque sea una sola bolsa y la cuenta sea obvia: el total sale de cotizar o no se dice.',
    'Si no has llamado a cotizar, no tienes total.',
    '',
    'NUNCA inventes precios, sabores, existencias ni fechas. Si una herramienta falla, dilo:',
    'es mejor decir "no lo pude comprobar" que dar un dato que puede estar mal.',
    'Si no tienes herramienta para lo que piden, dilo con naturalidad.',
    'No prometas nada que no puedas comprobar.',
    '',
    // LARGO. Esto no es estilo: es dinero y es WhatsApp. La salida cuesta cinco
    // veces la entrada ($20 contra $4 por millon), y en un telefono una respuesta
    // de 900 tokens es una pared de texto que nadie lee. El 14 nov 2026 la
    // primera respuesta con herramientas gasto 895 tokens de salida -una lista de
    // 7 sabores y 5 pedidos, completa y correcta, pero ilegible-.
    'LARGO: contesta en 6 lineas o menos. Es WhatsApp, no un correo.',
    'Responde lo que preguntaron y nada mas: si piden precios, no listes tambien sus pedidos.',
    'Si hay mucho que decir, da lo esencial y ofrece el resto ("te paso el resto si quieres").',
    'Listas: como mucho 7 renglones, de una linea cada uno.',
    'Nada de titulos en negrita ni encabezados de seccion.',
    '',
    // El 14 nov el agente abrio con "Te debo una disculpa: antes te dije que no
    // tenia acceso a nada y no era cierto". Era verdad -el codigo viejo no tenia
    // herramientas- y el hilo se lo recordaba, pero un cliente no quiere la
    // historia interna del sistema: quiere su respuesta.
    'No te disculpes por lo que dijiste antes ni expliques cambios del sistema. Contesta y ya.',
    '',
    // LOS TEMAS vienen de la base (`wa_temas`) y Abraham los edita en /agente.
    // Lo que NO viene de la base son las reglas de arriba -el total lo pone el
    // servidor, el nivel sale del telefono, no inventes precios-: eso es
    // seguridad, y lo que se puede editar desde una pantalla se puede romper
    // desde una pantalla. Los temas van ENCIMA, nunca en lugar de ellas.
    //
    // Si la base no contesta, TEMAS_POR_DEFECTO dice exactamente lo que decia
    // esta funcion antes de existir la tabla, asi que el agente se comporta
    // igual que ayer en vez de quedarse sin criterio.
    // El bloque de temas es sobre COMO TRATAR CLIENTES: «no lo resuelvas tu,
    // pasalo con el equipo», «ofrece el catalogo». Al dueño le contradice las dos
    // cosas que acabamos de decirle -no le vendas, y tu ERES el equipo-, asi que
    // no se le pone. Salio de MIRAR el prompt armado, no de leer el codigo.
    id.esDueno ? '' : textoDeTemas(),
    '',
    // Esto se queda fuera de los temas a proposito: vale para TODOS, y es la
    // leccion del 15 nov, cuando dio recetas de pozole llamando a `catalogo` y
    // `cotizar` —que no sirven para una receta— a $0.059 cada una.
    'Para cualquier tema que no sea del negocio NO llames a ninguna herramienta:',
    'no hace falta ninguna para eso, y cuestan.',
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

// REGLA DE ORO: el precio, y el si-se-puede-vender, los decide `cotizar_linea` en
// el servidor. Lo de abajo es una COPIA de sus reglas, y se copia por una sola
// razon: el catalogo trae las 35 filas de golpe, y cotizarlas una por una en cada
// mensaje serian 35 llamadas. Lo que impide que la copia se separe del original NO
// es la buena voluntad: es `tools/probar-wa-catalogo.mjs`, que cotiza producto por
// producto contra la base de verdad y falla si el catalogo ofrece algo que el
// servidor no cobra, o si esconde algo que si cobraria. Regla 63: una copia que
// nadie compara no mide, repite.
//
// Las tres reglas copiadas, textuales de cotizar_linea:
//   presentacion = 'Granel' or tipo_venta = 2   -> granel_no_soportado
//   mayorista: coalesce(nullif(precio_mayorista, 0), precio_tienda)
//   precio de caja: solo si nivel in ('tienda','mayorista') Y mod(cantidad, caja) = 0
//
// Y UNA REGLA PROPIA, que el servidor no tiene: un producto a $0 no se ofrece.
// `cotizar_linea` lo cotiza (0 no es null: devuelve ok:true con subtotal 0), pero
// decirle a un cliente "Natural a granel, $0" por WhatsApp es peor que no
// mencionarlo. Hoy son los 6 granel, que ya salen por la primera regla; esta es
// el seguro para el dia que una pieza se quede sin precio de su canal.
const NIVELES_CON_CAJA = ['tienda', 'mayorista'];

function clasificarProducto(p, nivel, col) {
  if (p.presentacion === 'Granel' || Number(p.tipo_venta) === 2) return { fuera: 'granel' };

  let precio = p[col];
  if (nivel === 'mayorista' && !Number(precio)) precio = p.precio_tienda;
  if (precio === null || precio === undefined) return { fuera: 'sin_precio' };
  if (!Number(precio)) return { fuera: 'precio_en_cero' };

  // Las cajas se omiten enteras si el nivel no las puede usar. Mandarlas igual
  // haria que el agente le ofreciera a un restaurante un precio de caja que
  // cotizar_linea nunca le va a cobrar.
  const cajas = NIVELES_CON_CAJA.includes(nivel)
    ? { caja3: p.precio_caja_3 || null, caja6: p.precio_caja_6 || null, caja12: p.precio_caja_12 || null }
    : null;

  return { precio, cajas };
}

// ── Cotizar ─────────────────────────────────────────────────────────────────
// LA REGLA QUE NO SE NEGOCIA (D6 del diseno): el total lo suma el SERVIDOR. El
// modelo dice que lineas quiere, y nada mas. No multiplica, no suma, no redondea,
// y el `nivel` que decide el precio no le pasa ni por delante: entra aqui como
// argumento, resuelto por wa_identidad desde el telefono que Meta ya verifico.
//
// Una sola implementacion, usada por la herramienta `cotizar` y -en la tarea 7-
// por `crear_pedido`. Si fueran dos, el total que ve el cliente y el que se
// escribe en la base podrian separarse, y nadie lo notaria hasta la factura.
//
// El modelo aporta TRES datos por linea: idProducto, cantidad y caja. Ni sabor ni
// presentacion, aunque el plan los pedia: el servidor los devuelve, asi que
// pedirlos solo anade sitios donde el modelo puede equivocarse sin que se note.
// De hecho sale mejor asi: si el modelo pide el id equivocado, lee "Natural" en
// la respuesta y se da cuenta antes de decirselo al cliente.
// OJO AL ESQUEMA DE `lineas`: NO lleva minItems ni maxItems. Con `strict: true`
// la API los rechaza -"For 'array' type, property 'maxItems' is not supported"- y
// la peticion entera se cae con un 400, asi que el agente contesta "se me trabo"
// a TODO. Paso en produccion el 14 nov 2026, entre las 22:23 y las 22:30.
//
// Lo mismo vale para minimum, maximum, minLength, maxLength y los demas limites:
// strict acepta tipos, enum, const, anyOf, $ref y additionalProperties:false, y
// nada mas. Los helpers tipados del SDK (betaZodTool) los quitan solos; aqui el
// esquema va a mano, asi que no hay quien los quite. El tope de verdad vive en
// cotizarLineas, que es donde tiene que estar: un limite que solo existe en el
// esquema es una sugerencia al modelo, no un limite.

async function cotizarLineas(lineas, nivel) {
  if (!Array.isArray(lineas) || !lineas.length) return { ok: false, error: 'sin_lineas' };
  if (lineas.length > AJ.max_lineas) return { ok: false, error: 'demasiadas_lineas' };

  for (const l of lineas) {
    const n = Number(l && l.cantidad);
    if (!Number.isFinite(n) || n <= 0 || n !== Math.trunc(n)) {
      return { ok: false, error: 'cantidad_invalida', linea: l };
    }
    if (n > AJ.max_piezas_linea) return { ok: false, error: 'cantidad_enorme', linea: l };
  }

  // Un mismo producto en dos lineas se rechaza en vez de sumarse solo: juntarlas
  // por mi cuenta cambiaria lo que el cliente pidio sin que nadie lo dijera.
  const ids = lineas.map((l) => Number(l.idProducto));
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'producto_repetido' };

  // En PARALELO, no en serie como decia el plan: veinte llamadas encadenadas son
  // unos dos segundos de reloj dentro de un webhook que Meta reintenta si tarda,
  // y un reintento cuesta otro mensaje. Son lecturas puras: el orden no importa,
  // y Promise.all conserva el de la lista.
  const rs = await Promise.all(lineas.map((l) => transporte('rpc/cotizar_linea', 'POST', {
    p_id_producto: Number(l.idProducto),
    p_nivel: nivel,
    p_cantidad: Number(l.cantidad),
    p_caja: Number(l.caja || 0),
  })));

  const detalle = [];
  let total = 0;
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i];
    if (!r.ok || !r.data || r.data.ok !== true) {
      // El status se REGISTRA. Sin esto, un 401 por una llave caducada y un
      // producto que de verdad no se puede vender se ven exactamente igual desde
      // fuera: "no_cotiza". Paso media hora con eso el 14 nov 2026.
      if (!r.ok) console.error('wa: cotizar_linea no contesto', r.status,
        JSON.stringify(r.data).slice(0, 200));
      return {
        ok: false,
        error: (r.data && r.data.error) || (r.ok ? 'no_cotiza' : 'base_' + r.status),
        linea: lineas[i],
      };
    }
    // Solo lo que devolvio el servidor. Nada de `{ ...l, ...r.data }`: lo que
    // dijo el modelo no entra en el detalle que la tarea 7 va a escribir.
    detalle.push(r.data);
    total += Number(r.data.subtotal || 0);
  }

  return { ok: true, total: Math.round(total * 100) / 100, detalle };
}

// ── Crear el pedido ─────────────────────────────────────────────────────────
// EL AGENTE NO LLEVA CREDENCIAL. Va por `wa_crear_pedido`
// (20261114000000_wa_crear_pedido.sql), que abre una sesion de vendedor DENTRO de
// su transaccion, crea el pedido y la borra. El token no existe fuera de la base:
// no esta en Vercel, ni en el repo, ni en un log.
//
// La alternativa era WA_VENDEDOR_TOKEN, y no vale: `crear_pedido` lo resuelve
// contra sesiones_vendedor con `expira_en > now()`, y esas sesiones duran DOCE
// HORAS (medido en produccion el 14 nov 2026: 4 en total, cero vivas, la ultima
// caducada en octubre). Habria funcionado media jornada. La misma trampa del
// token de Meta, que tambien parecia resuelto y caducaba en una hora.
//
// Y D6 ya no depende de este archivo: el nivel de precio lo resuelve el RPC desde
// el telefono con wa_identidad, y PISA lo que se mande aqui. `tipoCliente`,
// `idCliente`, `canal` y el telefono ni se envian: los pone el servidor. Lo que
// se manda abajo es solo lo que el servidor no puede saber.
//
// El pedido nace 'Pendiente' porque lo decide `crear_pedido` para todo canal que
// no sea mostrador: aqui no se elige, se hereda.
//
// `cotizar_linea` devuelve `piezasPorCaja`; `crear_pedido` lee `caja`. NO son la
// misma clave, y el plan pasaba el detalle tal cual. Con eso, toda linea por caja
// se habria cobrado por pieza: 72 piezas a 28 son 2,016 en vez de los 1,800 de 6
// cajas. No se habria cobrado de mas -el cuadre de crear_pedido tolera $1 y habria
// saltado `precio_cambiado`- pero NINGUN pedido por caja se habria podido crear
// jamas, que es justo lo que pide un tendero. Se traduce aqui, en un sitio.
function detalleParaPedido(detalle) {
  return detalle.map((d) => ({ ...d, caja: Number(d.piezasPorCaja) || 0 }));
}

async function crearPedidoConfirmado(entrada, id) {
  // El permiso lo decide el NIVEL, no el flag aprobado_b2b. El plan decia
  // `if (!id.aprobadoB2B)`, que es exactamente el bug del 14 nov: hay clientes
  // con tipo_id = 1 y aprobado_b2b = true, y a esos el agente les habria
  // levantado un pedido a precio de consumidor.
  if (!puedePedir(id)) {
    return 'Esta persona no es una tienda aprobada: NO puedes crear pedidos. '
      + 'Mandale https://crunchypaps.mx para que compre ahi.';
  }

  const fecha = String((entrada && entrada.fechaEntrega) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return 'La fecha de entrega tiene que ser AAAA-MM-DD. Llama a fecha_entrega y usa esa.';
  }

  // SE VUELVE A COTIZAR AQUI, con el nivel del servidor. Lo que el modelo haya
  // dicho antes en la conversacion no se usa: el hilo guarda texto, y un texto
  // que dice "son $1,800" no es un precio, es un recuerdo.
  const c = await cotizarLineas((entrada && entrada.lineas) || [], id.nivel);
  if (!c.ok) return `NO crees el pedido ni digas que quedo hecho. No pude cotizar (${c.error}).`;

  const r = await transporte('rpc/wa_crear_pedido', 'POST', {
    // El telefono va APARTE del p_data, y es de donde el servidor saca la
    // identidad y el nivel. Lo verifico Meta al firmar el webhook.
    p_telefono: id.telefono,
    p_data: {
      metodoEntrega: 'domicilio',
      fechaEntrega: fecha,
      tipoPagoId: 1,
      tipoPago: 'Efectivo',
      notas: '[wa] ' + String((entrada && entrada.notas) || '').slice(0, 300),
      total: c.total,
      productos: detalleParaPedido(c.detalle),
      // El id del mensaje de Meta: si Meta reintenta el webhook, la clave es la
      // misma y crear_pedido devuelve el pedido que ya existe en vez de otro.
      idempotencyKey: 'wa-' + id.telefono + '-' + id.idMensaje,
    },
  });

  const j = r.data;
  if (!r.ok || !j) {
    console.error('wa: wa_crear_pedido no contesto', r.status, JSON.stringify(j).slice(0, 300));
    return 'NO le digas que el pedido quedo hecho. No pude registrarlo; dile que el equipo le confirma.';
  }

  if (j.ok === false) {
    if (j.error === 'no_puede_pedir') {
      // El servidor lo rechazo aunque puedePedir(id) dijo que si. Si pasa, es que
      // este archivo y wa_identidad no ven lo mismo, y manda wa_identidad.
      console.error('wa: el servidor dice no_puede_pedir y el codigo decia que si', id.nivel);
      return 'NO puedes crear pedidos para esta persona. Mandale https://crunchypaps.mx';
    }
    if (j.error === 'precio_cambiado') {
      // NO se reintenta solo con el total corregido: seria cobrarle algo que no
      // vio. Se le dice y se le vuelve a preguntar. Regla 11.
      return `El precio cambio: ahora son $${j.totalCorrecto}, no $${c.total}. `
        + 'Diselo al cliente con los dos numeros y pregunta si lo confirma asi. NO lo des por hecho.';
    }
    if (j.error === 'sesion_requerida') {
      // El caso de los doce meses... o de las doce horas. Se registra para que en
      // Vercel se vea la causa, y al cliente no se le cuenta el problema interno.
      console.error('wa: credencial del agente invalida o caducada');
      return 'NO le digas que quedo hecho. Dile que lo revisa el equipo y le confirman.';
    }
    return `NO le digas que quedo hecho. El pedido no se pudo crear (${j.error}).`;
  }

  if (j.duplicado === true) {
    return `Ese pedido ya estaba creado: ${j.consecutivo}. No lo crees otra vez; confirmaselo.`;
  }

  return `Pedido ${j.consecutivo} creado por $${c.total}, para entregar el ${fecha}. `
    + 'Queda PENDIENTE de que lo confirme el equipo, y eso hay que decirselo al cliente.';
}

// ── Pasar con una persona ───────────────────────────────────────────────────
// Esta herramienta existe porque el prompt llevaba desde el 14 nov 2026
// ofreciendo "te lo paso con el equipo" SIN QUE HUBIERA forma de pasarlo. El
// agente se saltaba su propia regla de no prometer lo que no puede cumplir, y
// nadie se enteraba: los avisos no llegaban a ningun sitio.
//
// Los tres escenarios son decision de Abraham (15 nov 2026), y estan en la
// descripcion porque es lo unico que el modelo lee para decidir cuando usarla:
//   1. el cliente pide hablar con una persona,
//   2. el agente no puede resolverlo (cancelar, cambiar direccion, devolver),
//   3. huele a reclamo o el cliente esta molesto.
// Lo que NO escala: dudas de producto, precios y fechas, que para eso estan las
// otras herramientas, y pedidos normales.
//
// CANCELAR NO LO HACE EL AGENTE, y no es prudencia: cancelar mueve el lote, la
// caja, los puntos y -si fue Stripe- un reembolso de verdad. El 14 nov
// aparecieron tres pedidos cancelados cuyo reembolso real nadie sabe si ocurrio.
// Asi que recoge el folio y el motivo, avisa, y se lo dice al cliente.
const AVISO_MAX = 600;

async function avisosDeHoy(telefono) {
  const desde = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const r = await supa('wa_mensajes?select=id'
    + `&telefono=eq.${encodeURIComponent(telefono)}&direccion=eq.sale`
    + `&fecha=gte.${encodeURIComponent(desde)}&herramientas->>tipo=eq.aviso`, 'GET');
  return r.ok && Array.isArray(r.data) ? r.data.length : 0;
}

// Hasta cuando dura el silencio. `horas` viene de la base y lo edita una
// persona, asi que un valor roto NO puede producir "Invalid Date" y acabar
// escrito en la columna: cae al valor del codigo.
function hastaCuando(horas, ahora) {
  const h = Number(horas);
  const n = Number.isFinite(h) && h > 0 ? h : POR_DEFECTO.callar_horas;
  const base = ahora instanceof Date ? ahora.getTime() : Date.now();
  return new Date(base + n * 3600 * 1000).toISOString();
}

// FALLA ABIERTO, A PROPOSITO. Si `callado_hasta` trae basura, el agente
// CONTESTA. El silencio es lo peligroso de esta pieza: un cliente callado no
// recibe nada y no sabe si el numero existe. Entre un robot que contesta de mas
// y un cliente que habla con una pared, se elige el primero.
function sigueCallado(calladoHasta, ahora) {
  if (!calladoHasta || typeof calladoHasta !== 'string') return false;
  const t = Date.parse(calladoHasta);
  if (!Number.isFinite(t)) return false;
  return t > (ahora instanceof Date ? ahora.getTime() : Date.now());
}

async function pasarConUnaPersona(entrada, id) {
  const destinos = Array.isArray(AJ.avisar_a) ? AJ.avisar_a.filter(Boolean) : [];
  if (!destinos.length) {
    // No deberia llegar aqui: sin destinos, la herramienta no se ofrece. Si
    // llega, se dice la verdad en vez de fingir que se aviso.
    return 'No tengo a quien avisar ahora mismo. Dile que escriba a crunchypaps.mx.';
  }

  // El tope vive aqui y no en el prompt: un limite que se le pide al modelo es
  // una sugerencia. Sin el, una conversacion mala llena el telefono de alguien.
  const ya = await avisosDeHoy(id.telefono);
  if (ya >= AJ.avisos_por_dia) {
    console.warn('wa: tope de avisos alcanzado', { telefono: id.telefono, ya });
    return 'De esta conversacion ya avisamos hoy. Dile que siguen en ello y que le escriben.';
  }

  const motivo = String((entrada && entrada.motivo) || '').trim().slice(0, AVISO_MAX);
  if (!motivo) return 'Dime en una frase que quiere y por que no lo resolviste, y lo paso.';

  const quien = id.nombre ? `${id.nombre} (${id.telefono})` : id.telefono;
  const texto = `Crunchy Paps - WhatsApp\n\nDe: ${quien}\nNivel: ${id.nivel}\n\n${motivo}`;

  let entregados = 0;
  for (const destino of destinos) {
    if (await enviarWA(destino, texto)) entregados++;
  }

  // Se registra SIEMPRE, entregado o no: la fila es lo que cuenta el tope, y es
  // el unico rastro de que esta conversacion pidio ayuda.
  await supa('wa_mensajes', 'POST', {
    telefono: id.telefono, direccion: 'sale', texto,
    herramientas: { tipo: 'aviso', entregados, destinos: destinos.length, motivo },
    tokens: null,
  }, 'return=minimal');

  if (!entregados) {
    console.error('wa: ningun aviso se pudo entregar');
    return 'No pude avisar ahora mismo. Dile que escriba a crunchypaps.mx y no prometas que ya avisaste.';
  }
  // EL SILENCIO EMPIEZA AQUI, y solo si el aviso SALIO: avisar y callarse son
  // una sola cosa. Callarse sin que nadie se entere deja al cliente sin agente
  // Y sin persona, que es el peor de los dos mundos — por eso va despues del
  // `if (!entregados)` de arriba y no antes.
  //
  // Esta respuesta todavia le llega al cliente: el handler lee `callado_hasta`
  // AL ENTRAR, asi que el silencio aplica a los mensajes siguientes. Si
  // aplicara ya, el cliente pediria hablar con alguien y no recibiria ni la
  // confirmacion de que se le paso.
  //
  // El POST manda SOLO estas dos columnas: con merge-duplicates, PostgREST
  // actualiza unicamente las que van en el cuerpo, asi que el `hilo` no se
  // pisa. Y si la fila no existia, nace con el `hilo` POR OMISION de la tabla,
  // que es `'[]'::jsonb` y no nulo: comprobado en staging el 18 nov 2026, una
  // conversacion creada solo con telefono y callado_hasta sale con 0 turnos y
  // `bloqueado` en false. (Aqui yo habia escrito "nace con hilo nulo" sin
  // mirarlo; el `not null default '[]'` de la tabla dice otra cosa.)
  const hasta = hastaCuando(AJ.callar_horas);
  const rc = await supa('wa_conversaciones', 'POST', {
    telefono: id.telefono, callado_hasta: hasta,
  }, 'resolution=merge-duplicates,return=minimal');
  if (!rc.ok) {
    // Al modelo no se le miente: el aviso si salio, asi que lo que tiene que
    // decirle al cliente no cambia. Lo que fallo es el silencio, y se grita en
    // el log en vez de tragarselo (regla 27).
    console.error('wa: aviso entregado pero NO se pudo callar la conversacion', rc.status);
  }

  return 'Avisado. Dile que una persona del equipo le escribe en cuanto pueda, sin prometer hora.';
}

// ── La lista blanca, por identidad ──────────────────────────────────────────
// Deja de ser una constante: lo que el agente PUEDE hacer depende de quien
// escribe, y se decide en el servidor antes de armar la peticion. Un permiso que
// se le pide al modelo en el prompt no es un permiso (regla 35): lo que no esta
// en esta lista no existe para el, no es que exista y se niegue.
//
// Hoy las cuatro son de lectura y las tiene todo el mundo. La estructura se monta
// ahora porque la tarea 7 (crear_pedido, que escribe) y las herramientas de
// negocio para Abraham y el equipo se cuelgan exactamente de aqui.
function herramientasPara(id) {
  const lista = [
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
  {
    name: 'cotizar',
    description: 'Suma una lista de lineas con los precios del servidor y devuelve el total. '
      + 'Usala SIEMPRE antes de decir un total, aunque sea una sola linea y la cuenta te parezca facil. '
      + 'NUNCA multipliques ni sumes tu: el precio y el total los pone el servidor.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        lineas: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              idProducto: { type: 'integer', description: 'El id tal como lo dio la herramienta catalogo. No lo adivines.' },
              cantidad: { type: 'integer', description: 'PIEZAS, no cajas. Seis cajas de 12 son 72 piezas.' },
              caja: { type: 'integer', description: 'Piezas por caja: 3, 6 o 12. Cero si va por pieza.' },
            },
            required: ['idProducto', 'cantidad', 'caja'],
            additionalProperties: false,
          },
        },
      },
      required: ['lineas'],
      additionalProperties: false,
    },
  },
  ];

  // AQUI se cierra el permiso de escribir. Para un consumidor, `crear_pedido` no
  // existe: no le llega en la peticion, asi que no es que el modelo "decida no
  // usarla". Un permiso que vive en una frase del prompt no es un permiso
  // (regla 35), y esta es la primera herramienta que escribe en la base.
  // Solo si hay a quien avisar. Si la lista esta vacia, la herramienta no
  // existe para el modelo y el prompt tampoco la menciona: asi no puede
  // prometer un aviso que no va a salir de aqui.
  // AL DUEÑO NO SE LE OFRECE ESCALAR, y la razon es un error real del 20 nov
  // 2026 a las 18:17: Abraham pregunto algo que el agente no sabia, el agente
  // escalo, el aviso salio a SU PROPIO numero -porque `avisar_a` es el suyo- y
  // escalar ademas CALLA la conversacion 8 horas. Pregunto, se lo reenviaron a
  // el mismo, y luego el agente dejo de hablarle.
  //
  // El dueño ES el equipo: no hay a quien pasarle nada. Lo suyo es decir que no
  // puede y apuntar el hueco, que es la herramienta de abajo.
  if (!id.esDueno && Array.isArray(AJ.avisar_a) && AJ.avisar_a.filter(Boolean).length) {
    lista.push({
      name: 'pasar_con_una_persona',
      description: 'Avisa al equipo de esta conversacion. Usala en TRES casos: '
        + '(1) el cliente pide hablar con una persona; '
        + '(2) te piden algo que no puedes hacer -cancelar un pedido, cambiar una direccion, '
        + 'devolver dinero, un cobro que no cuadra-; '
        + '(3) es un reclamo o el cliente esta molesto. '
        + 'NO la uses para dudas de producto, precios o fechas: para eso tienes las otras.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          motivo: {
            type: 'string',
            description: 'Una o dos frases: que quiere exactamente y por que no lo resolviste. '
              + 'Si hay un folio de pedido, ponlo.',
          },
        },
        required: ['motivo'],
        additionalProperties: false,
      },
    });
  }

  if (puedePedir(id)) {
    lista.push({
      name: 'crear_pedido',
      description: 'Crea el pedido en el sistema. Usala SOLO cuando ya cotizaste y el cliente '
        + 'confirmo ese total con sus palabras. El pedido queda PENDIENTE de que el equipo lo '
        + 'confirme, y eso se le dice al cliente. No la uses para "apartar" ni para probar.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          lineas: {
            type: 'array',
            description: 'Las MISMAS lineas que cotizaste y el cliente confirmo.',
            items: {
              type: 'object',
              properties: {
                idProducto: { type: 'integer', description: 'El id tal como lo dio catalogo.' },
                cantidad: { type: 'integer', description: 'PIEZAS, no cajas. Seis cajas de 12 son 72 piezas.' },
                caja: { type: 'integer', description: 'Piezas por caja: 3, 6 o 12. Cero si va por pieza.' },
              },
              required: ['idProducto', 'cantidad', 'caja'],
              additionalProperties: false,
            },
          },
          fechaEntrega: {
            type: 'string',
            description: 'AAAA-MM-DD. La que dio fecha_entrega, o una POSTERIOR que el cliente pidio.',
          },
          notas: { type: 'string', description: 'Lo que el cliente pidio aparte. Cadena vacia si no hay.' },
        },
        required: ['lineas', 'fechaEntrega', 'notas'],
        additionalProperties: false,
      },
    });
  }

  // Las ventas del negocio son del dueño, no de quien escribe. `mis_pedidos` ya
  // existe y solo ve los de uno: esa es exactamente la distincion que el propio
  // agente apunto al no poder contestar, el 20 nov a las 19:07.
  if (id.esDueno) {
    lista.push({
      name: 'ventas',
      description: 'Las ventas del NEGOCIO (todos los pedidos, no solo los de quien escribe): '
        + 'cuanto se vendio en un periodo y CUANDO FUE EL ULTIMO DIA CON VENTAS. '
        + 'El ultimo dia no depende del periodo que pidas. Sin fechas, toma los ultimos 90 dias. '
        + 'OJO A LOS CAMPOS: `neto` es subtotal menos descuento y NO lleva envio; `cobrado` SI lo '
        + 'lleva, asi que `cobrado = neto + envioCobrado`. Si el dueño pregunta por que no cuadran, '
        + 'esa es la razon y la puedes explicar.',
      input_schema: {
        type: 'object',
        properties: {
          desde: { type: 'string', description: 'AAAA-MM-DD. Cadena vacia para los ultimos 90 dias.' },
          hasta: { type: 'string', description: 'AAAA-MM-DD. Cadena vacia para hoy.' },
        },
        required: ['desde', 'hasta'],
        additionalProperties: false,
      },
      strict: true,
    });
  }

  // Solo el dueño. Para un cliente, lo que no se puede contestar se ESCALA; para
  // el dueño, se APUNTA. Son dos cosas distintas y por eso son dos herramientas.
  if (id.esDueno) {
    lista.push({
      name: 'registrar_hueco',
      description: 'Apunta una pregunta del dueño que NO pudiste contestar por falta de '
        + 'herramienta, para que quede como pendiente de construir. Usala SOLO cuando te '
        + 'falte la herramienta, no cuando la tengas y el dato no exista: si `catalogo` '
        + 'contesta que no hay un sabor, eso NO es un hueco, es la respuesta. '
        + 'Despues de llamarla, dile que quedo apuntado.',
      input_schema: {
        type: 'object',
        properties: {
          pregunta: { type: 'string', description: 'Lo que pregunto, con sus palabras.' },
          queFalta: { type: 'string',
            description: 'Que herramienta o dato haria falta para contestarlo. Concreto.' },
        },
        required: ['pregunta', 'queFalta'],
        additionalProperties: false,
      },
      strict: true,
    });
  }

  return lista;
}

async function correrHerramienta(nombre, entrada, id) {
  if (nombre === 'catalogo') {
    const col = COLUMNA_PRECIO[id.nivel] || COLUMNA_PRECIO.consumidor;
    // `descontinuado` se filtra ademas de `activo`: cotizar_linea rechaza los
    // descontinuados, asi que ofrecerlos seria prometer algo que no se puede cobrar.
    // El resto del filtrado va en clasificarProducto, con su prueba cruzada.
    //
    // precio_tienda entra SIEMPRE en el select aunque no sea la columna del nivel,
    // porque el mayorista cae a ella cuando su precio es 0. Sin repetirla: para
    // nivel tienda, `col` ya es esa.
    const cols = [...new Set(['id', 'sabor', 'presentacion', 'gramos', 'tipo_venta',
      col, 'precio_tienda', 'precio_caja_3', 'precio_caja_6', 'precio_caja_12'])].join(',');
    let q = `productos?select=${cols}`
      + '&activo=eq.true&descontinuado=not.eq.true&order=orden.asc&limit=60';
    const busca = String((entrada && entrada.busca) || '').trim();
    if (busca) q += `&sabor=ilike.*${encodeURIComponent(busca)}*`;
    const r = await transporte(q, 'GET');
    if (!r.ok) return 'No pude leer el catalogo. Dile que lo intentas en un momento y no inventes precios.';
    const filas = [];
    for (const p of (Array.isArray(r.data) ? r.data : [])) {
      const c = clasificarProducto(p, id.nivel, col);
      if (c.fuera) continue;
      filas.push({
        id: p.id, sabor: p.sabor, presentacion: p.presentacion, gramos: p.gramos,
        precio: c.precio, ...(c.cajas || {}),
      });
    }
    if (!filas.length) return 'No hay productos que coincidan con esa busqueda.';

    // TABLA, NO JSON, y es dinero. Medido el 15 nov 2026 sobre los 28 productos
    // reales: en JSON ocupa 2,925 caracteres y en tabla 705. Cuatro veces menos,
    // y el catalogo viaja en DOS O TRES vueltas de cada conversacion, asi que de
    // ahi salia que la entrada pasara de 5,000 a 12,500 tokens en un rato. Para
    // dar la escala: el prompt entero son ~508 tokens y las definiciones de las
    // herramientas ~470; el catalogo en JSON pesaba mas que los dos juntos.
    //
    // Cambia COMO se escribe, no QUE se ofrece: clasificarProducto decide lo
    // mismo y probar-wa-catalogo.mjs sigue cotizando cada fila contra el servidor.
    const conCaja = filas.some((f) => f.caja3 || f.caja6 || f.caja12);
    const cab = conCaja
      ? 'id|sabor|presentacion|pieza|caja3|caja6|caja12'
      : 'id|sabor|presentacion|precio';
    const cuerpo = filas.map((f) => {
      const base = `${f.id}|${f.sabor}|${f.presentacion}|${f.precio}`;
      // Guion y no hueco: una columna vacia se lee como "no se", y un guion como
      // "no hay". Son cosas distintas cuando lo que falta es un precio.
      return conCaja ? `${base}|${f.caja3 || '-'}|${f.caja6 || '-'}|${f.caja12 || '-'}` : base;
    }).join('\n');

    return `Precios para nivel ${id.nivel}, en pesos.\n${cab}\n${cuerpo}`;
  }

  if (nombre === 'fecha_entrega') {
    const r = await transporte('rpc/obtener_fecha_entrega', 'POST', { p_data: { telefono: id.telefono } });
    if (!r.ok || !r.data) return 'No pude calcular la fecha de entrega.';
    // OJO: `fechaDisplay` viene en espanglish ("Tuesday 17 de November"), asi que
    // NO se le pasa al modelo: diria eso tal cual a un cliente. Se manda la fecha
    // en ISO y el `msg`, que si esta bien escrito en espanol.
    return JSON.stringify({ fecha: r.data.fecha, explicacion: r.data.msg });
  }

  if (nombre === 'cotizar') {
    const c = await cotizarLineas((entrada && entrada.lineas) || [], id.nivel);
    if (!c.ok) {
      // El error se traduce a una INSTRUCCION, no a un codigo. "granel_no_soportado"
      // le deja al modelo inventarse que hacer; "quita esa linea" no.
      const comoSalir = {
        sin_lineas: 'No mandaste ninguna linea. Pregunta que quiere y cuanto.',
        demasiadas_lineas: `No puedo cotizar mas de ${AJ.max_lineas} lineas de golpe. Pidele que lo parta en dos pedidos.`,
        producto_repetido: 'Mandaste el mismo producto dos veces. Juntalo en una sola linea con la cantidad sumada y vuelve a cotizar.',
        cantidad_invalida: 'Una cantidad no es un numero entero de piezas. Corrigela y vuelve a cotizar.',
        cantidad_enorme: `Son mas de ${AJ.max_piezas_linea} piezas en una linea. Eso lo tiene que ver una persona del equipo: dile que se lo pasas.`,
        granel_no_soportado: 'Por aqui no se vende granel, solo bolsas. Ofrecele presentaciones de 100, 250, 500 g o 1 kg.',
        producto_no_disponible: 'Ese producto no esta disponible. Vuelve a mirar el catalogo y ofrece otro.',
      };
      const salida = comoSalir[c.error] || `No pude cotizar (${c.error}). Dile que no se lo pudiste calcular y que el equipo le confirma.`;
      return 'NO le des ningun total al cliente. ' + salida;
    }
    return JSON.stringify({ nivelDePrecio: id.nivel, total: c.total, lineas: c.detalle });
  }

  if (nombre === 'crear_pedido') return crearPedidoConfirmado(entrada, id);

  if (nombre === 'pasar_con_una_persona') return pasarConUnaPersona(entrada, id);

  if (nombre === 'ventas') {
    const lim = (v) => (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(v || '')) ? String(v) : null);
    const r = await supa('rpc/wa_ventas', 'POST', {
      p_desde: lim(entrada && entrada.desde), p_hasta: lim(entrada && entrada.hasta),
    });
    if (!r.ok || !r.data || r.data.ok !== true) {
      console.error('wa: wa_ventas fallo', r.status);
      return 'No pude consultar las ventas. Dilo asi en vez de dar un numero.';
    }
    return JSON.stringify(r.data);
  }

  if (nombre === 'registrar_hueco') {
    const r = await supa('rpc/wa_registrar_hueco', 'POST', {
      p_data: {
        agente: 'whatsapp', telefono: id.telefono, quien: id.nombre,
        pregunta: String((entrada && entrada.pregunta) || '').slice(0, 500),
        queFalta: String((entrada && entrada.queFalta) || '').slice(0, 500),
      },
    });
    if (!r.ok || !r.data || r.data.ok !== true) {
      console.error('wa: no se pudo apuntar el hueco', r.status);
      // No se le miente: si no quedo apuntado, no se le dice que si.
      return 'No pude apuntarlo. Dile que lo tienes presente pero que no quedo registrado.';
    }
    return 'Apuntado. Dile que no tienes esa herramienta todavia y que queda anotado '
      + 'para construirla. No le prometas cuando.';
  }

  if (nombre === 'mis_pedidos') {
    if (!id.idCliente) return 'Esta persona no tiene pedidos: no esta registrada como cliente.';
    const r = await transporte(
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

async function responder(id, texto, hilo) {
  const mensajes = [...hilo, { role: 'user', content: texto }];
  const usadas = [];
  let entrada = 0, salida = 0, cacheLeido = 0, cacheEscrito = 0;

  for (let vuelta = 0; vuelta < AJ.max_vueltas; vuelta++) {
    const r = await anthropic().beta.messages.create({
      model: AJ.modelo,
      max_tokens: MAX_SALIDA,
      system: [{ type: 'text', text: sistema(id), cache_control: { type: 'ephemeral' } }],
      messages: mensajes,
      tools: herramientasPara(id),
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: AJ.effort },
    });

    entrada += (r.usage && r.usage.input_tokens) || 0;
    salida  += (r.usage && r.usage.output_tokens) || 0;
    // El CACHE se registra porque hoy no sabemos si funciona. El prefijo que se
    // cachea es `tools` + `system`; en Opus 5.5 el minimo para que se cachee son
    // 512 tokens, y una lectura cacheada cuesta $0.20 por millon en vez de $4
    // —VEINTE veces menos—. Si estos dos salen siempre en cero, el
    // `cache_control` de abajo no esta haciendo nada y hay que mirarlo; si
    // `leido` sube en las vueltas 2 y 3, esta pagando. Sin medirlo era una
    // creencia (regla 26: afirmar donde esta el coste antes de medirlo sale caro).
    cacheLeido  += (r.usage && r.usage.cache_read_input_tokens) || 0;
    cacheEscrito += (r.usage && r.usage.cache_creation_input_tokens) || 0;

    // stop_reason se mira ANTES de leer content: en una negativa el contenido no
    // es la respuesta que el cliente espera.
    if (r.stop_reason === 'refusal') {
      return { texto: 'Eso no lo puedo resolver por aqui. Lo paso con el equipo para que te escriban.',
               entrada, salida, cacheLeido, cacheEscrito, usadas, negada: true };
    }

    if (r.stop_reason !== 'tool_use') {
      const dicho = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return {
        texto: dicho || 'Perdon, no te entendi. Me lo puedes decir de otra forma?',
        entrada, salida, cacheLeido, cacheEscrito, usadas, negada: false,
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
    texto: 'Se me complico consultar eso. Lo paso con el equipo y te escriben.',
    entrada, salida, cacheLeido, cacheEscrito, usadas, negada: false,
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

  // Los ajustes se cargan ANTES de los topes, porque los topes son uno de ellos.
  // Los temas van en la misma vuelta: son dos lecturas pequeñas y en paralelo no
  // cuestan mas que una.
  await Promise.all([cargarAjustes(), cargarTemas()]);

  // El interruptor. Se mira antes de gastar un peso en el modelo, y se contesta
  // en vez de callar: un cliente que escribe y no recibe nada no sabe si el
  // numero existe. Cuesta un mensaje de WhatsApp y vale la pena.
  if (AJ.activo === false) {
    console.warn('wa: agente apagado por ajustes');
    await enviarWA(msg.telefono, AJ.mensaje_apagado);
    return res.status(200).json({ ok: true, apagado: true });
  }

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

  // Quien escribe y NO es cliente queda registrado como prospecto. Antes moria
  // aqui: `wa_identidad` devolvia `esCliente: false` y se acababa. Los mensajes
  // si quedaban en `wa_mensajes`, pero eso es un log — nadie lo abre para
  // decidir a quien visitar, y el plan del negocio es llegar a tienditas.
  //
  // `wa_prospecto` es idempotente y NO duplica: si el telefono ya es prospecto
  // -el caso que mas vale, una de las 1,129 de la lista fria levantando la
  // mano- solo le estampa las dos fechas y no toca nada mas suyo.
  //
  // NO PUEDE TUMBAR LA CONVERSACION, y por eso va en su propio try: perder un
  // prospecto es malo, dejar a alguien sin respuesta por no poder anotarlo es
  // peor. Al fallar grita en el log y sigue.
  //
  // El nombre sale del perfil de WhatsApp, que Meta manda en el webhook y
  // `sacarMensaje` ya extrae. Va antes de la puerta del silencio a proposito:
  // un escalado no deja de ser un lead.
  if (ident.esCliente === false) {
    try {
      const rp = await supa('rpc/wa_prospecto', 'POST', {
        p_telefono: msg.telefono, p_nombre: msg.nombrePerfil || '',
      });
      if (!rp.ok || !rp.data || rp.data.ok !== true) {
        console.error('wa: no se pudo registrar el prospecto', rp.status,
          JSON.stringify(rp.data).slice(0, 200));
      } else if (rp.data.nuevo) {
        console.log('wa: prospecto nuevo', rp.data.idProspecto);
      }
    } catch (e) {
      console.error('wa: wa_prospecto lanzo', e && e.message);
    }
  }

  const { hilo, bloqueado, calladoHasta } = await leerHilo(msg.telefono);
  if (bloqueado) {
    console.warn('wa: conversacion bloqueada', msg.telefono);
    return res.status(200).json({ ok: true, bloqueado: true });
  }

  // Ya se paso con una persona: el agente no se mete. Va DESPUES de
  // `registrarEntrante`, a proposito: lo que el cliente escriba mientras el
  // agente calla queda en `wa_mensajes`, que es lo que Abraham necesita leer
  // antes de contestarle. Lo que NO entra es el hilo del modelo — cuando el
  // silencio caduque, el agente no sabra lo que se dijo en medio.
  if (sigueCallado(calladoHasta)) {
    console.warn('wa: conversacion callada hasta', calladoHasta);
    return res.status(200).json({ ok: true, callado: true });
  }

  // De momento solo texto. Un audio o una foto no se ignoran —hay alguien del
  // otro lado— pero tampoco se inventan: se dice lo que hay.
  if (msg.tipo !== 'text' || !msg.texto) {
    const aviso = 'Por aqui solo leo mensajes de texto. Me lo escribes?';
    await enviarWA(msg.telefono, aviso);
    await registrarSaliente(msg.telefono, aviso, null, 0);
    return res.status(200).json({ ok: true });
  }

  // ── EL TURNO ──────────────────────────────────────────────────────────────
  // Cada mensaje de WhatsApp dispara su propia invocacion. El 20 nov 2026
  // Abraham mando «La última producción» y «?» en el mismo segundo y el agente
  // contesto DOS veces, 17:40:41 y 17:40:42: dos modelos pensando a la vez
  // sobre medias preguntas. En una cotizacion eso es un precio equivocado.
  //
  // `wa_tomar_turno` encola el texto SIEMPRE y solo le da el turno a una. Las
  // demas se van sin contestar, tranquilas: su texto ya esta en la cola.
  const espera = Math.max(0, Number(AJ.juntar_segundos) || 0);
  const turno = await supa('rpc/wa_tomar_turno', 'POST', {
    p_telefono: msg.telefono, p_texto: msg.texto, p_segundos: 60,
  });
  if (!turno.ok || !turno.data || turno.data.tomado !== true) {
    console.log('wa: encolado, otro tiene el turno', msg.telefono);
    return res.status(200).json({ ok: true, encolado: true });
  }

  let hiloVivo = hilo;
  let vueltas = 0;
  try {
    for (;;) {
      // La espera va SOLO en la primera vuelta: es la que atrapa la rafaga. En
      // las siguientes se mira la cola al instante, porque lo que interesa es
      // lo que entro MIENTRAS el modelo pensaba.
      if (espera > 0 && vueltas === 0) {
        await new Promise((r) => setTimeout(r, espera * 1000));
      }

      const pend = await supa('rpc/wa_tomar_pendientes', 'POST', {
        p_telefono: msg.telefono, p_segundos: 60,
      });
      const lista = (pend.ok && pend.data && Array.isArray(pend.data.pendientes))
        ? pend.data.pendientes : [];
      const texto = juntarPendientes(lista);
      // Sin nada que contestar se sale: en la primera vuelta no deberia pasar
      // -el mensaje propio ya esta encolado- y en la segunda es lo normal.
      if (!texto) break;

      let salida;
      try {
        salida = await responder(id, texto, hiloVivo);
      } catch (e) {
        console.error('wa: el modelo fallo', e && e.message);
        await enviarWA(msg.telefono, 'Se me complico el sistema. Lo paso con el equipo y te escriben.');
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
    // El MODELO se guarda con cada mensaje. Sin esto, cualquier cuenta de gasto
    // tiene que suponer uno, y desde que el modelo es un ajuste de /agente esa
    // suposicion es falsa en cuanto alguien lo baja a Sonnet o Haiku: el panel
    // enseñaria precio de Opus para mensajes que costaron una veintava parte.
    modelo: AJ.modelo,
    entrada: salida.entrada,
    salida: salida.salida,
    cacheLeido: salida.cacheLeido,
    cacheEscrito: salida.cacheEscrito,
  }, (salida.entrada || 0) + (salida.salida || 0));
      hiloVivo = [
        ...hiloVivo,
        { role: 'user', content: texto },
        { role: 'assistant', content: salida.texto },
      ];
      await guardarHilo(msg.telefono, hiloVivo);

      // DOS vueltas como mucho. Si siguen entrando mensajes, el webhook del
      // siguiente tomara el turno cuando lo soltemos: no hace falta -ni cabe-
      // quedarse aqui. Un bucle sin tope se come los 60 s de la funcion.
      if (++vueltas >= 2) break;
    }
  } finally {
    // SIEMPRE, incluso si el modelo fallo y salimos por el `return` de arriba.
    // Un turno que no se suelta deja la conversacion muda hasta que caduque.
    await supa('rpc/wa_soltar_turno', 'POST', { p_telefono: msg.telefono });
  }

  // Meta reintenta si no recibe un 200 rapido, y un reintento es otro mensaje.
  return res.status(200).json({ ok: true, vueltas });
};

module.exports.firmaValida = firmaValida;
module.exports.leerCrudo = leerCrudo;
module.exports.sacarMensaje = sacarMensaje;
module.exports.podarHilo = podarHilo;
module.exports.juntarPendientes = juntarPendientes;
module.exports.sistema = sistema;
module.exports.POR_DEFECTO = POR_DEFECTO;
module.exports.cargarAjustes = cargarAjustes;
module.exports.cargarTemas = cargarTemas;
module.exports.textoDeTemas = textoDeTemas;
module.exports.COMO_SE_TRATA = COMO_SE_TRATA;
module.exports.TEMAS_POR_DEFECTO = TEMAS_POR_DEFECTO;
module.exports.usarTemasDePrueba = (lista) => {
  if (process.env.VERCEL) throw new Error('los temas de prueba no se sustituyen en produccion');
  TEMAS = Array.isArray(lista) && lista.length ? lista : TEMAS_POR_DEFECTO;
  return TEMAS;
};
// Mismo trato que el transporte de prueba: un gancho para poder probar los dos
// estados de `avisar_a` sin base, y cerrado con llave en produccion. Un gancho
// que en produccion sigue abierto no es un gancho, es una puerta.
module.exports.usarAjustesDePrueba = (obj) => {
  if (process.env.VERCEL) throw new Error('los ajustes de prueba no se sustituyen en produccion');
  AJ = { ...POR_DEFECTO, ...(obj || {}) };
  return AJ;
};
module.exports.ajustes = () => AJ;
module.exports.sigueCallado = sigueCallado;
module.exports.hastaCuando = hastaCuando;
module.exports.normalizarDestino = normalizarDestino;
module.exports.puedePedir = puedePedir;
module.exports.herramientasPara = herramientasPara;
module.exports.COLUMNA_PRECIO = COLUMNA_PRECIO;
module.exports.NIVELES_CON_CAJA = NIVELES_CON_CAJA;
module.exports.clasificarProducto = clasificarProducto;
module.exports.cotizarLineas = cotizarLineas;
module.exports.detalleParaPedido = detalleParaPedido;
module.exports.crearPedidoConfirmado = crearPedidoConfirmado;
module.exports.correrHerramienta = correrHerramienta;
module.exports.usarTransporteDePrueba = usarTransporteDePrueba;
