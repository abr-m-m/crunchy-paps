// ============================================================================
//  Crunchy Paps — Los banners del catálogo
//  Vercel Serverless Function · /api/banners
//
//  POST {token, banners:[...]} → valida y escribe contenido/banner/banners.json.
//  El carrusel del consumidor lee ese archivo tal cual (src/app.js), así que
//  este endpoint es la única puerta por la que se escribe.
//
//  POR QUÉ VALIDA EL SERVIDOR, Y NO LA PANTALLA
//  --------------------------------------------
//  Los destinos de un banner son NOMBRES que tienen que existir en la base:
//  un sabor, una presentación, un id de producto. CLAUDE.md §4 ya avisaba de
//  que debían coincidir EXACTO, y el 24 nov 2026 se midió lo que pasa cuando
//  no coinciden: `banners.json` en producción pedía el sabor «Natural», la
//  base tiene «Naturales», y `renderTabs` —que se cura solo— dejaba al cliente
//  en «Adobada Hot». El banner de las papas naturales llevaba a las picantes,
//  en silencio y desde el 7 de junio.
//
//  Un desplegable en la pantalla ayuda, pero no es la garantía: el navegador
//  no decide (regla 10). Aquí se comprueba contra la base y contra Storage, y
//  lo que no cuadra NO se guarda, diciendo cuál y por qué.
// ============================================================================
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_SR  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET   = 'contenido';
const CARPETA  = 'banner';
const RUTA_JSON = `${CARPETA}/banners.json`;
const MAX = 8;

// Cerrado por omisión (regla 37). 'catalogo' y 'producto' los interpreta
// `aplicarDestinoBanner`; el resto son secciones que entiende `navegar`.
const DESTINOS = ['', 'catalogo', 'producto', 'premia', 'pedidos', 'cuenta'];

async function supa(ruta, metodo, cuerpo, extra) {
  const r = await fetch(SUPA_URL + ruta, {
    method: metodo,
    headers: Object.assign(
      { apikey: SUPA_SR, Authorization: 'Bearer ' + SUPA_SR, 'Content-Type': 'application/json' },
      extra || {}),
    body: cuerpo === undefined ? undefined : (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)),
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

// El nombre del archivo, tal como lo guarda el JSON: SIN la carpeta, porque
// el carrusel arma la URL como BASE + 'banner/' + img. Se acepta que llegue
// con la carpeta delante (es lo que devuelve /api/imagen) y se le quita.
function nombreImagen(v) {
  const s = String(v || '').trim().replace(/^\/+/, '');
  const sin = s.startsWith(CARPETA + '/') ? s.slice(CARPETA.length + 1) : s;
  return /^[A-Za-z0-9._-]+$/.test(sin) && !sin.startsWith('.') ? sin : null;
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, error: 'Método no permitido' }); }
  if (!SUPA_URL || !SUPA_SR) return res.status(500).json({ ok: false, error: 'Faltan variables de Supabase' });

  try {
    const payload = await leerCuerpo(req);
    const token = typeof payload.token === 'string' ? payload.token : '';
    if (!token) return res.status(401).json({ ok: false, error: 'Sesión requerida' });

    // Autorizar ANTES de mirar nada más del payload (regla 36).
    const dueno = await supa('/rest/v1/rpc/sesion_es_dueno', 'POST', { p_token: token });
    if (!dueno.ok || dueno.datos !== true) return res.status(403).json({ ok: false, error: 'No autorizado' });

    const lista = Array.isArray(payload.banners) ? payload.banners : null;
    if (!lista) return res.status(400).json({ ok: false, error: 'Falta la lista de banners' });
    if (lista.length > MAX) return res.status(400).json({ ok: false, error: `Como mucho ${MAX} banners` });

    // ── Lo que la base dice que existe ─────────────────────────────────────
    const prods = await supa('/rest/v1/productos?select=id,sabor,presentacion&activo=is.true&descontinuado=is.false', 'GET');
    if (!prods.ok || !Array.isArray(prods.datos)) {
      console.error('[banners.js] no se pudo leer productos:', prods.estado, prods.datos);
      return res.status(500).json({ ok: false, error: 'No se pudo comprobar el catálogo' });
    }
    const sabores = new Set(prods.datos.map((p) => p.sabor).filter(Boolean));
    const presentaciones = new Set(prods.datos.map((p) => p.presentacion).filter(Boolean));
    const ids = new Set(prods.datos.map((p) => Number(p.id)));

    // ── Lo que Storage dice que existe ─────────────────────────────────────
    // Un banner que apunta a una imagen que no está se ve como un hueco; y el
    // hueco sale en la PRIMERA pantalla del cliente.
    const obj = await supa(`/storage/v1/object/list/${BUCKET}`, 'POST', { prefix: CARPETA, limit: 200 });
    const archivos = new Set((Array.isArray(obj.datos) ? obj.datos : []).map((o) => o.name));

    // ── Validar una por una, y no guardar nada si alguna falla ─────────────
    const limpios = [];
    for (let i = 0; i < lista.length; i++) {
      const b = lista[i] || {};
      const donde = `Banner ${i + 1}`;

      const img = nombreImagen(b.img);
      if (!img) return res.status(400).json({ ok: false, error: `${donde}: falta la imagen.` });
      if (archivos.size && !archivos.has(img)) {
        return res.status(400).json({ ok: false, error: `${donde}: la imagen «${img}» no está en Storage.` });
      }

      const destino = typeof b.destino === 'string' ? b.destino.trim() : '';
      if (DESTINOS.indexOf(destino) === -1) {
        return res.status(400).json({ ok: false, error: `${donde}: destino «${destino}» desconocido.` });
      }

      const salida = { img };
      if (!destino) { limpios.push(salida); continue; }
      salida.destino = destino;

      if (destino === 'producto') {
        const id = Number(b.productoId);
        if (!ids.has(id)) return res.status(400).json({ ok: false, error: `${donde}: ese producto ya no existe o está dado de baja.` });
        salida.productoId = id;
      } else if (destino === 'catalogo') {
        const sabor = typeof b.sabor === 'string' ? b.sabor.trim() : '';
        const pres  = typeof b.presentacion === 'string' ? b.presentacion.trim() : '';
        if (sabor) {
          if (!sabores.has(sabor)) {
            return res.status(400).json({ ok: false, error: `${donde}: el sabor «${sabor}» no existe en el catálogo.` });
          }
          salida.sabor = sabor;
        }
        if (pres) {
          if (!presentaciones.has(pres)) {
            return res.status(400).json({ ok: false, error: `${donde}: la presentación «${pres}» no existe en el catálogo.` });
          }
          salida.presentacion = pres;
        }
        if (!sabor && !pres) {
          return res.status(400).json({ ok: false, error: `${donde}: «ir al catálogo» necesita un sabor, una presentación o las dos.` });
        }
      }
      limpios.push(salida);
    }

    // ── Escribir. `x-upsert` porque el archivo ya existe ───────────────────
    const w = await supa(`/storage/v1/object/${BUCKET}/${RUTA_JSON}`, 'POST',
      JSON.stringify(limpios, null, 2) + '\n',
      { 'Content-Type': 'application/json', 'x-upsert': 'true', 'Cache-Control': 'no-store' });
    if (!w.ok) {
      console.error('[banners.js] no se pudo escribir:', w.estado, w.datos);
      return res.status(500).json({ ok: false, error: 'No se pudo guardar' });
    }

    return res.status(200).json({ ok: true, banners: limpios });
  } catch (e) {
    console.error('[banners.js] error:', e.message);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
};
