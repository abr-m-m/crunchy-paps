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
module.exports.UMBRAL_RAZON = UMBRAL_RAZON;
module.exports.UMBRAL_TASA = UMBRAL_TASA;
