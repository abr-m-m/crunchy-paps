// tools/staging-middleware.mjs — Lo que ver-en-staging.mjs y `vite dev` comparten: llaves de staging
// pedidas al CLI, sesión de prueba (/entrar-como*), /api/config.js apuntando a staging y
// /api/imagen-reto en proceso. Devuelve true si atendió la petición.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
export const STAGING = 'https://dkwatbsaidlfjqjnfyrk.supabase.co';

// La llave publishable no es un secreto —viaja al navegador por diseño— pero
// tampoco se guarda en el repo: se pide al CLI, que ya tiene sesión.
// Push (entrega 4): la llave pública VAPID sale de .env.push si existe. Solo
// esa línea; la privada y el secreto del webhook nunca llegan al navegador.
try {
  const envPush = readFileSync(join(REPO, '.env.push'), 'utf8');
  const m = envPush.match(/^\s*VAPID_PUBLIC_KEY\s*=\s*(\S+)/m);
  if (m && !process.env.VAPID_PUBLIC_KEY) process.env.VAPID_PUBLIC_KEY = m[1];
} catch (_e) { /* sin .env.push no hay push en staging, y está bien */ }

// Se lee en cada petición, no al arrancar: así se puede pegar una llave nueva
// en .env.push sin reiniciar el servidor.
function deEnvPush(clave) {
  try {
    const txt = readFileSync(join(REPO, '.env.push'), 'utf8');
    const lin = txt.split(String.fromCharCode(10)).map(l => l.trim()).find(l => l.startsWith(clave + '='));
    const m = lin ? [lin, lin.slice(lin.indexOf('=') + 1).trim()] : null;
    return m ? m[1] : '';
  } catch (_e) { return ''; }   // sin .env.push, cada cosa se degrada sola
}

let LLAVE = process.env.SUPABASE_KEY;
let LLAVE_SECRETA = process.env.SUPABASE_SECRET_KEY;
if (!LLAVE) {
  try {
    // `--output-format json` explicito: sin el, el CLI decide el formato segun
    // si cree que lo llama un agente, y el 7 sep eso dejo al script sin llave.
    // Ademas el CLI mezcla avisos («A new version...») con la respuesta, asi
    // que se recorta desde el primer `{` o `[`.
    const out = execFileSync('supabase',
      ['projects', 'api-keys', '--project-ref', 'dkwatbsaidlfjqjnfyrk',
       '--reveal', '--output-format', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const ini = out.search(/[\[{]/);
    const j = JSON.parse(ini >= 0 ? out.slice(ini) : out);
    const lista = Array.isArray(j) ? j : (j.keys || j.data || []);
    LLAVE = lista.find((k) => k.type === 'publishable' || k.name === 'publishable' ||
                              String(k.api_key || '').startsWith('sb_publishable_'))?.api_key;
    // La secreta solo sirve para correr /api/imagen-reto en proceso (probar /retos en local). Nunca se imprime.
    LLAVE_SECRETA = LLAVE_SECRETA || lista.find((k) => k.type === 'secret' || String(k.api_key || '').startsWith('sb_secret_'))?.api_key;
  } catch (e) {
    // Solo el tipo de error: el mensaje de un JSON.parse fallido trae un trozo
    // de la salida, y ahi puede ir una llave.
    console.error('No pude pedirle la llave de staging al CLI de Supabase (' + (e && e.name) + ').');
    console.error('Alternativa:  SUPABASE_KEY=<llave publishable> node tools/ver-en-staging.mjs');
    process.exit(1);
  }
}
if (!LLAVE) { console.error('El CLI no devolvió una llave publishable.'); process.exit(1); }

export function llaveStaging() { return LLAVE; }

// Sesión de consumidor de prueba: la forma es la misma que guarda guardarSesion()
// en index.html (cp_session). Solo funciona contra staging: producción no tiene
// el RPC.
// Los cuatro perfiles sembrados en staging (los mismos de tools/probar-perfiles.mjs).
const PERFILES = {
  consumidor:  { tel: '5591000001', nombre: 'Consumidor Prueba' },
  restaurante: { tel: '5591000002', nombre: 'Restaurante Prueba' },
  tienda:      { tel: '5591000003', nombre: 'Tienda Prueba' },
  mayorista:   { tel: '5591000004', nombre: 'Mayorista Prueba' },
};
async function sesionPruebaHTML(tipo, telPedido) {
  // ?tipo=tienda-nueva (o restaurante-nueva, mayorista-nueva): un teléfono que no
  // existe en staging, para recorrer el alta desde cero (datos de la tienda →
  // «Validando» → aprobación en B2B → catálogo). Cada visita es una tienda distinta;
  // para volver a la MISMA tienda: ?tipo=tienda&tel=<los 10 dígitos que salieron>.
  let perfil = PERFILES[tipo];
  const mNueva = /^(tienda|restaurante|mayorista)-nueva$/.exec(tipo);
  if (!perfil && mNueva) {
    tipo = mNueva[1];
    const tel = '559' + String(Date.now()).slice(-7);
    perfil = { tel, nombre: `${tipo} nueva (${tel})` };
  }
  if (perfil && /^\d{10}$/.test(telPedido || '')) perfil = { tel: telPedido, nombre: `${tipo} ${telPedido}` };
  if (!perfil) return { status: 400, html: `<meta charset="utf-8"><p style="font-family:sans-serif">Perfil desconocido. Usa ?tipo=${Object.keys(PERFILES).join(' | ')} | tienda-nueva | restaurante-nueva | mayorista-nueva</p>` };
  const TEL_PRUEBA = perfil.tel;
  const r = await fetch(`${STAGING}/rest/v1/rpc/emitir_sesion_prueba`, {
    method: 'POST',
    headers: { apikey: LLAVE, authorization: `Bearer ${LLAVE}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_telefono: TEL_PRUEBA }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok || !j.token) {
    return { status: 502, html: `<meta charset="utf-8"><p style="font-family:sans-serif">Staging no emitió la sesión de prueba (HTTP ${r.status}): <code>${String(JSON.stringify(j)).slice(0, 200)}</code></p>` };
  }
  const sesion = {
    tipoCliente: tipo, telefonoVerif: TEL_PRUEBA, esVendedor: false,
    clienteToken: j.token, clienteTokenExp: j.expiraEn || null,
    vendedorInfo: null, clienteActual: null, puntos: 0, carrito: {},
    modoVenta: 'pieza', canalVenta: tipo, expira: Date.now() + 24 * 3600 * 1000,
  };
  return { status: 200, html: `<!doctype html><meta charset="utf-8"><title>Entrando…</title>
<script>
try { localStorage.setItem('cp_session', ${JSON.stringify(JSON.stringify(sesion))}); } catch (e) {}
location.replace('/');
</script><p style="font-family:sans-serif">Entrando como ${perfil.nombre}…</p>` };
}

export async function manejarStaging(req, res) {
  const [ruta, query = ''] = req.url.split('?');
  // /entrar-como-consumidor  ·  /entrar-como?tipo=tienda|restaurante|mayorista
  if (ruta === '/entrar-como-consumidor' || ruta === '/entrar-como') {
    const q = new URLSearchParams(query);
    const tipo = ruta === '/entrar-como-consumidor' ? 'consumidor' : (q.get('tipo') || 'consumidor');
    sesionPruebaHTML(tipo, q.get('tel')).then(({ status, html }) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    }).catch((e) => { res.writeHead(502); res.end('staging no responde: ' + (e && e.name)); });
    return true;
  }
  // /api/imagen-reto: la función de Vercel, en proceso, con la llave secreta de staging (solo para probar /retos).
  if (ruta === '/api/imagen-reto') {
    if (!LLAVE_SECRETA) { res.writeHead(503); res.end('sin llave secreta de staging'); return true; }
    process.env.SUPABASE_URL = STAGING; process.env.SUPABASE_SERVICE_ROLE_KEY = LLAVE_SECRETA;
    const handler = require('../api/imagen-reto.js');
    const shim = { setHeader: (k, v) => res.setHeader(k, v), status(s) { res.statusCode = s; return this; }, json(o) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); } };
    handler(req, shim).catch((e) => { res.writeHead(500); res.end(String(e && e.message)); });
    return true;
  }
  // Vercel sirve esto por entorno; aquí se fabrica apuntando a staging.
  if (ruta === '/api/config.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end(`window.__CP_CONFIG__ = ${JSON.stringify({
      SUPABASE_URL: STAGING, SUPABASE_ANON_KEY: LLAVE, ENTORNO: 'staging',
      // Push (entrega 4): la pública sale de .env.push si está cargada; sin
      // ella la pantalla Armado no ofrece avisos, que es lo correcto.
      VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || deEnvPush('VAPID_PUBLIC_KEY'),
      // Llave de Maps propia de staging, restringida a localhost. Sin ella la app
      // cae en la de index.html, que solo acepta crunchypaps.mx: el mapa no carga
      // y sale RefererNotAllowedMapError, que es lo que pasaba hasta hoy.
      GOOGLE_MAPS_KEY: process.env.GOOGLE_MAPS_KEY || deEnvPush('GOOGLE_MAPS_KEY') })};`);
    return true;
  }
  return false;
}
