// ============================================================================
//  Crunchy Paps — Agente contador
//  Vercel Serverless Function · repo: /api/contador.js
//
//  Diseno: cambios/2026-11-20-el-equipo-completo.md
//  Migracion: supabase/migrations/20261120000000_agentes_y_contador.sql
//
//  Cruza la app contra la caja, los puntos y lo que Stripe dejo anotado, y
//  avisa SOLO cuando algo no cuadra. Lo despierta un cron de Vercel.
//
//  NO LLAMA A NINGUN MODELO, y es una decision, no una limitacion. Las siete
//  revisiones son SQL: **este agente cuesta cero**. Explicar los hallazgos en
//  prosa necesitaria un modelo, y hoy no hace falta — un folio con su monto y
//  su fecha se entiende solo. Si algun dia los hallazgos se vuelven sutiles, la
//  V2 agrega el modelo; hasta entonces, no se paga por adornar una lista.
//
//  ES EL PRIMERO DEL ESPINAZO COMUN. Toda la parte que no es «qué revisar»
//  -despertar, mirar si el agente esta encendido, componer el aviso, dejar
//  constancia de la corrida- es la que van a reusar los demas agentes de
//  operacion. Por eso `agente_registrar_corrida` es generica y no del contador.
//
//  ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET,
//       WA_TOKEN, WA_PHONE_ID, WA_GRAPH_VERSION (opcional)
//
//  NOTA: `npm run validar` NO mira esta carpeta. La red de este archivo es
//  `node --check api/contador.js` y `node tools/probar-contador.mjs`.
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;
const WA_TOKEN     = process.env.WA_TOKEN;
const WA_PHONE_ID  = process.env.WA_PHONE_ID;
const WA_GRAPH     = process.env.WA_GRAPH_VERSION || 'v25.0';

// El aviso es un aviso, no el informe. 1,200 caracteres es como media pantalla
// de telefono: lo que no cabe se mira en /agente, que es donde cabe.
const AVISO_MAX = 1200;
const CLAVE = 'contador';

// ── La puerta ───────────────────────────────────────────────────────────────
// Pura a proposito: recibe el secreto en vez de leer process.env, para que la
// prueba pueda comprobar el caso que importa sin tocar el entorno.
//
// SIN `CRON_SECRET` CONFIGURADO NO SE ABRE. Es la mitad que se olvida: una
// comparacion contra undefined deja pasar a cualquiera que mande undefined, y
// entonces el endpoint queda publico sin que nadie lo note.
function autorizado(headers, query, secreto) {
  if (!secreto) return false;
  const h = String((headers && (headers.authorization || headers.Authorization)) || '');
  if (h === 'Bearer ' + secreto) return true;
  return String((query && query.secret) || '') === secreto;
}

// ── Supabase ────────────────────────────────────────────────────────────────
// Copiado de api/whatsapp.js a proposito: en este proyecto cada archivo de
// api/ es autocontenido (CLAUDE.md §2). Son 12 lineas.
async function supaReal(path, method, body, prefer) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: Object.assign({
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
    }, prefer ? { Prefer: prefer } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* 204 sin cuerpo */ }
  return { ok: r.ok, status: r.status, data };
}

// EL UNICO punto por donde una prueba puede sustituir el transporte. Existe por
// la misma razon que su gemelo en api/whatsapp.js: la llave de servicio no se
// puede sacar del CLI de Supabase, asi que sin esto el endpoint entero no se
// puede correr en local sin meter un secreto en el disco.
//
// Y SE CIERRA CON LLAVE EN PRODUCCION: en Vercel, llamarlo lanza. Un gancho de
// pruebas que en produccion sigue abierto no es un gancho, es una puerta.
let supa = supaReal;
function usarTransporteDePrueba(f) {
  if (process.env.VERCEL) throw new Error('el transporte no se sustituye en produccion');
  supa = f || supaReal;
}

// ── El aviso ────────────────────────────────────────────────────────────────
// Un ejemplo se pinta con las claves que traiga, sin saber cuales son. Eso NO
// es pereza: es lo que permite que una revision nueva se agregue en el SQL y
// aparezca aqui sin tocar este archivo. Un agente nuevo tampoco lo toca.
// Unas pocas claves conocidas se pintan legibles; CUALQUIER OTRA sale tal cual,
// que es lo que mantiene la extensibilidad. Salio de mirar el mensaje: sin esto
// una fila terminaba en «· 2», y un 2 suelto no dice nada.
const dinero = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '$' + v;
  // Dos decimales solo si los tiene: «$530.1» no parece dinero y «$70.00» sobra.
  return '$' + (Number.isInteger(n) ? n : n.toFixed(2));
};
const COMO_SE_PINTA = {
  monto:      dinero,
  puntos:     (v) => v + ' pts',
  diasTarde:  (v) => v + (Number(v) === 1 ? ' dia tarde' : ' dias tarde'),
  prometida:  (v) => 'prometido ' + v,
  cliente:    (v) => 'cliente ' + v,
  id:         (v) => '#' + v,
};
// EL ORDEN IMPORTA Y NO VIENE DADO: `jsonb` no conserva el orden en que se
// construyo un objeto -Postgres ordena las claves por longitud y alfabeto-, asi
// que sin esto el folio salia en un sitio distinto en cada revision y el
// mensaje no se podia barrer con la vista. Salio de mirar la demo.
// Lo que no este en esta lista va al final, en el orden que traiga: una
// revision nueva sigue pintandose sola.
const ORDEN = ['folio', 'id', 'cliente', 'monto', 'puntos', 'fecha', 'prometida',
               'diasTarde', 'estatus'];
function lineaEjemplo(e) {
  if (!e || typeof e !== 'object') return String(e);
  const peso = (k) => { const i = ORDEN.indexOf(k); return i === -1 ? ORDEN.length : i; };
  return Object.entries(e)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .sort((a, b) => peso(a[0]) - peso(b[0]))
    .map(([k, v]) => (COMO_SE_PINTA[k] ? COMO_SE_PINTA[k](v) : `${v}`))
    .join(' · ');
}

// SILENCIO CUANDO TODO CUADRA. Si cada mañana llegara un «hoy no hubo nada»,
// en dos semanas nadie abriria el mensaje — y el dia que trajera algo, tampoco.
// Devolver null es lo que apaga el envio; la corrida SI queda registrada, asi
// que «no aviso» nunca se confunde con «no corrio».
function textoAviso(informe) {
  const n = Number(informe && informe.cuantos) || 0;
  const revs = (informe && Array.isArray(informe.revisiones)) ? informe.revisiones : [];
  if (n === 0 || revs.length === 0) return null;

  const cabeza = `Contador: ${n} ${n === 1 ? 'cosa no cuadra' : 'cosas no cuadran'}.`;
  const cola = 'Detalle en https://crunchypaps.mx/agente';
  const bloques = revs.map((r) => {
    const g = String(r.gravedad || '').toUpperCase();
    const ej = (Array.isArray(r.ejemplos) ? r.ejemplos : []).slice(0, 3).map(lineaEjemplo);
    return [`${g} · ${r.titulo} (${r.cuantos})`, ...ej].join('\n');
  });

  // Se recortan BLOQUES enteros, no caracteres: media linea de un folio es
  // peor que no tenerla. El conteo de la cabeza sigue siendo el TOTAL, no el
  // de lo que se alcanzo a mostrar.
  const partes = [];
  let largo = cabeza.length + cola.length + 4;
  for (const b of bloques) {
    if (largo + b.length + 2 > AVISO_MAX) break;
    partes.push(b);
    largo += b.length + 2;
  }
  return [cabeza, ...partes, cola].join('\n\n').slice(0, AVISO_MAX);
}

// ── Mandarlo ────────────────────────────────────────────────────────────────
function normalizarDestino(telefono) {
  const d = String(telefono || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('521')) return '52' + d.slice(3);
  return d;
}

async function enviarWA(telefono, texto) {
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.error('contador: sin WA_TOKEN o WA_PHONE_ID, no se avisa');
    return false;
  }
  const r = await fetch(`https://graph.facebook.com/${WA_GRAPH}/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: normalizarDestino(telefono),
      type: 'text', text: { body: String(texto).slice(0, 4000) },
    }),
  });
  if (!r.ok) {
    console.error('contador: envio fallo', r.status, (await r.text().catch(() => '')).slice(0, 300));
    return false;
  }
  // Meta acusa que ACEPTO el mensaje, no que lo entrego. No se promete mas.
  return true;
}

// ── El endpoint ─────────────────────────────────────────────────────────────
// GET, lo llama el cron de Vercel. `?dry=1` corre las revisiones y devuelve el
// informe SIN avisar y SIN registrar la corrida: sirve para mirarlo a mano sin
// ensuciar la bitacora ni despertar a nadie.
module.exports = async (req, res) => {
  const q = (req && req.query) || {};
  if (!autorizado(req && req.headers, q, CRON_SECRET)) {
    return res.status(403).json({ ok: false, error: 'no_autorizado' });
  }

  const seco = q.dry === '1' || q.dry === 'true';
  const dias = Math.min(Math.max(parseInt(q.dias, 10) || 365, 1), 3650);
  const t0 = Date.now();

  // El interruptor vive en la BASE, no aqui: apagar un agente que se desmadra
  // un sabado tiene que ser un UPDATE y no un despliegue.
  const reg = await supa(`agentes?select=activo,avisar_a&clave=eq.${CLAVE}`, 'GET');
  const fila = reg.ok && Array.isArray(reg.data) ? reg.data[0] : null;
  if (!fila) {
    console.error('contador: no esta registrado en `agentes`');
    return res.status(503).json({ ok: false, error: 'no_registrado' });
  }
  if (fila.activo === false) {
    // No se registra corrida: no corrio. Una fila con cuantos 0 diria que
    // reviso y no encontro nada, que es otra cosa.
    return res.status(200).json({ ok: true, apagado: true });
  }

  let informe = null, error = null;
  try {
    const r = await supa('rpc/contador_revisar', 'POST', { p_dias: dias });
    if (!r.ok) throw new Error(`contador_revisar ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    informe = r.data;
  } catch (e) {
    error = (e && e.message) || String(e);
    console.error('contador:', error);
  }

  const cuantos = Number(informe && informe.cuantos) || 0;
  let avisado = false;

  if (!seco && !error) {
    const texto = textoAviso(informe);
    const destinos = Array.isArray(fila.avisar_a) ? fila.avisar_a.filter(Boolean) : [];
    if (texto && !destinos.length) {
      // Se dice en el log en vez de callarlo: un contador que encuentra algo y
      // no tiene a quien decirselo es un contador que no sirve.
      console.warn(`contador: ${cuantos} hallazgos y nadie a quien avisar (agentes.avisar_a vacio)`);
    }
    for (const d of destinos) {
      if (texto && await enviarWA(d, texto)) avisado = true;
    }
  }

  if (!seco) {
    // Se registra SIEMPRE, haya hallazgos o no, y tambien si fallo: la fila es
    // lo unico que distingue «corrio y todo cuadraba» de «no corrio».
    const reg2 = await supa('rpc/agente_registrar_corrida', 'POST', {
      p_data: {
        agente: CLAVE, duracion_ms: Date.now() - t0, ok: !error,
        cuantos, hallazgos: informe, aviso_enviado: avisado, error,
      },
    });
    if (!reg2.ok) console.error('contador: no se pudo registrar la corrida', reg2.status);
  }

  if (error) return res.status(500).json({ ok: false, error });
  return res.status(200).json({ ok: true, seco, cuantos, avisado, informe });
};

module.exports.usarTransporteDePrueba = usarTransporteDePrueba;
module.exports.autorizado = autorizado;
module.exports.textoAviso = textoAviso;
module.exports.lineaEjemplo = lineaEjemplo;
module.exports.normalizarDestino = normalizarDestino;
module.exports.AVISO_MAX = AVISO_MAX;
