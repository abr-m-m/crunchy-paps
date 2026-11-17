// ============================================================================
//  Crunchy Paps — Radar de Instagram
//  Vercel Serverless Function · repo: /api/ig-radar.js
//
//  Diseno: cambios/2026-11-13-radar-instagram.md
//  Plan:   cambios/2026-11-13-radar-instagram-plan.md
//
//  Lee cuentas publicas del nicho, mide cuales reventaron contra lo normal de su
//  PROPIA cuenta, y escribe un informe. NO produce ni publica nada: el token de
//  Instagram es de lectura.
//
//  NOTA: `npm run validar` NO mira esta carpeta. La red de este archivo es
//  `node --check api/ig-radar.js`, y va en cada tarea que lo toque.
// ============================================================================

// ── Los umbrales ────────────────────────────────────────────────────────────
// Un reel destaca si tiene 2.5 veces la mediana de SU PROPIA cuenta.
const UMBRAL_RAZON = 2.5;
// Y se sospecha pagado si ademas su interaccion cae por debajo de la mitad de lo
// normal de esa cuenta.
//
// LOS DOS NACEN SIN CALIBRAR. Son numeros elegidos a ojo, y el unico caso real
// contra el que estan medidos son las VISTAS de los 8 reels de @crunchy.papsmx;
// de la sospecha de pago no tenemos ni un caso real, porque no tenemos los "me
// gusta" de esos reels. Se afinan mirando el primer informe y el reel de 1,533
// vistas del propio perfil (tarea 7 del plan), no antes.
const UMBRAL_TASA = 0.5;

// ── El calculo ──────────────────────────────────────────────────────────────
function mediana(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return 0;
  const v = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Mediana y no media, a proposito: a la media la arrastra hacia arriba el propio
// pico que queremos detectar, y entonces el hallazgo se ve mas chico de lo que
// es. Con los 8 reels de @crunchy.papsmx, el del anaquel sale en 3.200x contra
// la mediana (479) y en 2.557x contra la media (599.5), raspando el umbral.
// Es D5 del diseno, y la prueba lo cubre con esos numeros.
function analizarCuenta(medios, umbrales) {
  const U = Object.assign({ razon: UMBRAL_RAZON, tasa: UMBRAL_TASA }, umbrales || {});
  const lista = Array.isArray(medios) ? medios : [];

  const medianaVistas = mediana(lista.map((m) => Number(m && m.vistas) || 0));

  const medianaTasa = mediana(
    lista
      .filter((m) => (Number(m && m.vistas) || 0) > 0)
      .map((m) => (Number(m.meGusta) || 0) / (Number(m.vistas) || 1))
  );

  const salida = lista.map((m) => {
    const v = Number(m && m.vistas) || 0;
    const g = Number(m && m.meGusta) || 0;
    const razon = medianaVistas > 0 ? v / medianaVistas : 0;
    const tasa  = v > 0 ? g / v : 0;
    const destaca = razon >= U.razon;
    // Sin pico no hay sospecha: una cuenta con poca interaccion en TODO no es
    // una cuenta que compra vistas, es una cuenta con poca interaccion.
    const sospechaPago = destaca && medianaTasa > 0 && tasa < U.tasa * medianaTasa;
    return Object.assign({}, m, { vistas: v, meGusta: g, razon, tasa, destaca, sospechaPago });
  });

  return { medianaVistas, medianaTasa, medios: salida };
}

// ── El desmontaje ───────────────────────────────────────────────────────────
// Lo que convierte una lista de numeros en algo que se puede leer el lunes.
const MODELO = 'claude-opus-5-5';
const MAX_SALIDA = 8000;

// El cliente se construye AL USARLO, no al cargar el modulo: sin
// ANTHROPIC_API_KEY el constructor lanza, y eso tumbaria la prueba del calculo,
// que no toca la red. Mismo patron perezoso que api/whatsapp.js.
let _anthropic = null;
function anthropic() {
  if (!_anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    _anthropic = new Anthropic();
  }
  return _anthropic;
}

function promptDesmontaje(destacados) {
  return [
    'Eres el analista de contenido de Crunchy Paps: papas artesanales hechas por lote, CDMX,',
    'marca chica. Su mejor reel fueron fotos de telefono de sus bolsas en el anaquel de una',
    'tiendita: lo real le gana a lo producido.',
    '',
    'Abajo van los reels que esta semana superaron con claridad lo normal de SU PROPIA cuenta.',
    'Para cada uno escribe: el gancho (que promete en el primer segundo), el formato (que tipo',
    'de pieza es), por que funciono, y si Crunchy Paps puede copiarlo con un telefono y sin',
    'equipo. Esa ultima parte es la que importa.',
    '',
    'Reglas:',
    '- El campo "grupo" dice de quien es la cuenta. Una formula de una marca grande con agencia',
    '  detras NO es copiable: dilo en vez de disimularlo.',
    '- Si un reel viene marcado "puede estar pagado", trata sus numeros con pinzas y dilo.',
    '- Si esta semana no hay nada que valga la pena, DILO. Un informe que siempre encuentra algo',
    '  deja de leerse.',
    '- No inventes nada que no este en los datos. No tienes el video, solo el texto y las cifras.',
    '',
    JSON.stringify(destacados, null, 1),
  ].join('\n');
}

async function desmontar(destacados) {
  const r = await anthropic().beta.messages.create({
    model: MODELO,
    max_tokens: MAX_SALIDA,
    messages: [{ role: 'user', content: promptDesmontaje(destacados) }],
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium' },
  });
  // stop_reason se mira ANTES de leer content: en una negativa el contenido no
  // trae el analisis, y filtrarlo daria un informe vacio que parece correcto.
  if (r.stop_reason === 'refusal') {
    return { texto: 'El modelo no quiso analizar esto.', tokens: null };
  }
  return {
    texto: r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
    tokens: r.usage ? (r.usage.input_tokens + r.usage.output_tokens) : null,
  };
}

// ── El aviso por WhatsApp ───────────────────────────────────────────────────
// Tres lineas y el enlace, NO el informe entero (D3 del diseno): el informe se
// lee en /radar, donde cabe; un muro de texto en WhatsApp no se lee.
//
// `enviarWA` esta en api/whatsapp.js y NO se exporta de ahi. El spec de la
// tarea 6 lo previo: antes que tocar el agente de WhatsApp —que esta en
// produccion contestando a clientes— se COPIA la funcion. Son 20 lineas y el
// precio de duplicarlas es menor que el de arriesgar ese archivo.
const WA_TOKEN    = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID;
const WA_GRAPH    = process.env.WA_GRAPH_VERSION || 'v25.0';

function normalizarDestino(telefono) {
  const d = String(telefono || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('521')) return '52' + d.slice(3);
  return d;
}

async function enviarWA(telefono, texto) {
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.error('radar: sin WA_TOKEN o WA_PHONE_ID, no se avisa');
    return false;
  }
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
    const detalle = await r.text().catch(() => '');
    console.error('radar: envio fallo', r.status, detalle.slice(0, 500));
    return false;
  }
  // Meta acusa que ACEPTO el mensaje, no que lo entrego. No se promete mas.
  return true;
}

// Sin destacados no se manda nada. Un aviso semanal que dice "no hubo nada"
// entrena a no abrirlo, y entonces tampoco se abre el que si trae algo.
function textoAviso(informe) {
  const n = Number(informe && informe.cuantos) || 0;
  // Esta guarda hace dos cosas: evita el aviso vacio Y protege el acceso de
  // abajo, que con un informe null reventaria. Si se quita, se ve en la prueba.
  if (n === 0) return null;
  const cuentas = Array.isArray(informe.cuentas) ? informe.cuentas.slice(0, 2) : [];
  return [
    `Radar: ${n} ${n === 1 ? 'reel reventó' : 'reels reventaron'} esta semana.`,
    cuentas.length ? `De ${cuentas.join(' y ')}${n > cuentas.length ? ' y más' : ''}.` : '',
    'Lo copiable está en https://crunchypaps.mx/radar',
  ].filter(Boolean).join('\n');
}

async function avisar(telefono, informe) {
  const texto = textoAviso(informe);
  if (!texto) return false;
  return enviarWA(telefono, texto);
}

// ── El endpoint ─────────────────────────────────────────────────────────────
// Vercel trata CADA archivo de api/ como una funcion, asi que este archivo tiene
// que exportar un handler aunque por dentro solo haya cuentas: sin el, el
// despliegue falla o queda un endpoint que revienta al primer golpe.
//
// Hasta que existan el token de Meta y el resto de las tareas, contesta 503 y no
// hace nada. Un endpoint que dice "todavia no" es honesto; uno que da 500 parece
// roto, que es distinto.
//
// El modo ?dry=1 y la corrida de verdad entran en la tarea 3 del plan.
module.exports = async (req, res) => {
  return res.status(503).json({
    ok: false,
    error: 'no_configurado',
    mensaje: 'El radar todavia no esta terminado: faltan el token de Meta y las tareas 3 a 8.',
  });
};

module.exports.mediana = mediana;
module.exports.analizarCuenta = analizarCuenta;
module.exports.promptDesmontaje = promptDesmontaje;
module.exports.desmontar = desmontar;
module.exports.MODELO = MODELO;
module.exports.normalizarDestino = normalizarDestino;
module.exports.textoAviso = textoAviso;
module.exports.avisar = avisar;
module.exports.UMBRAL_RAZON = UMBRAL_RAZON;
module.exports.UMBRAL_TASA = UMBRAL_TASA;
