#!/usr/bin/env node
// tools/ver-en-staging.mjs — Levanta la app de ESTA rama, tal como está en el
// árbol de trabajo, apuntada a STAGING. Sirve para mirar un cambio de aspecto
// antes de desplegarlo.
//
//   node tools/ver-en-staging.mjs
//   → abre http://localhost:8794
//
// Para entrar al panel (informe, caja, gastos, producción, prospección…) hay que
// identificarse como vendedor. En staging está sembrada Ana:
//   teléfono 5500000001 · PIN 1234
// Son datos falsos de staging; no existen en producción.
//
// AL ENTRAR AL PIN: la pantalla tiene SEIS casillas porque el mínimo al CAMBIAR
// el PIN es de 6. Los PIN de 4 siguen sirviendo, pero NO se autoenvían: hay que
// teclear 1234 y pulsar «Entrar». Está escrito en la propia pantalla.
//
// POR QUÉ APUNTA A STAGING Y NO A PRODUCCIÓN
// Un cambio de aspecto no toca la lógica, pero al recorrerlo se abren cajas,
// se guardan gastos y se registran lotes. Eso no se hace contra la base real solo
// para mirar colores. La llave se pide al CLI de Supabase en el momento, así que
// no hay ningún secreto escrito en el repo.
//
// DESDE EL TELÉFONO (13 sep 2026): escucha en todas las interfaces, así que con
// el teléfono en el mismo Wi-Fi basta abrir http://<IP de esta PC>:8794 (la IP
// la da `ipconfig`; el firewall ya deja pasar a node.exe). Es la misma app
// contra la misma base de staging.
//
// ENTRAR COMO CONSUMIDOR SIN SMS: aquí no hay /api/sheets ni /api/otp-email,
// así que el OTP del cliente no se puede completar. Para probar lo que ve un
// consumidor con sesión (Mi cuenta, Pedidos, Club, checkout sin OTP):
//   http://<IP>:8794/entrar-como-consumidor
//   http://<IP>:8794/entrar-como?tipo=tienda      (o restaurante | mayorista)
// Pide a staging una sesión de prueba (`emitir_sesion_prueba`, el mismo RPC que
// usa tools/probar-perfiles.mjs; solo existe en staging) para el perfil sembrado
// («Consumidor Prueba» 5591000001, «Tienda Prueba» 5591000003…), la guarda en
// el navegador y manda al catálogo. Tienda, restaurante y mayorista pasan por la
// misma puerta B2B que un cliente real: si no están aprobados, verán «Validando».

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const STAGING = 'https://dkwatbsaidlfjqjnfyrk.supabase.co';
const PUERTO = 8794;

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

const TIPOS = { '.html': 'text/html', '.js': 'application/javascript',
                '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

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

createServer((req, res) => {
  const [ruta, query = ''] = req.url.split('?');
  // /entrar-como-consumidor  ·  /entrar-como?tipo=tienda|restaurante|mayorista
  if (ruta === '/entrar-como-consumidor' || ruta === '/entrar-como') {
    const q = new URLSearchParams(query);
    const tipo = ruta === '/entrar-como-consumidor' ? 'consumidor' : (q.get('tipo') || 'consumidor');
    sesionPruebaHTML(tipo, q.get('tel')).then(({ status, html }) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    }).catch((e) => { res.writeHead(502); res.end('staging no responde: ' + (e && e.name)); });
    return;
  }
  // /api/imagen-reto: la función de Vercel, en proceso, con la llave secreta de staging (solo para probar /retos).
  if (ruta === '/api/imagen-reto') {
    if (!LLAVE_SECRETA) { res.writeHead(503); res.end('sin llave secreta de staging'); return; }
    process.env.SUPABASE_URL = STAGING; process.env.SUPABASE_SERVICE_ROLE_KEY = LLAVE_SECRETA;
    const handler = require('../api/imagen-reto.js');
    const shim = { setHeader: (k, v) => res.setHeader(k, v), status(s) { res.statusCode = s; return this; }, json(o) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); } };
    handler(req, shim).catch((e) => { res.writeHead(500); res.end(String(e && e.message)); });
    return;
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
    return;
  }
  const p = join(REPO, ruta === '/' ? 'index.html' : ruta.slice(1));
  if (!existsSync(p)) { res.writeHead(404); res.end('no existe'); return; }
  res.writeHead(200, { 'content-type': TIPOS[extname(p)] || 'text/plain' });
  res.end(readFileSync(p));
}).listen(PUERTO, () => {
  console.log('');
  console.log(`  Crunchy Paps corriendo en  http://localhost:${PUERTO}`);
  console.log('  Base: STAGING (datos falsos, no produccion)');
  console.log('');
  console.log('  Para ver el panel, entra como vendedora:');
  console.log('    telefono  5500000001');
  console.log('    PIN       1234   tecléalo y pulsa «Entrar»');
  console.log('                     (son 6 casillas; los de 4 no se autoenvian)');
  console.log('');
  console.log('  Como consumidor con sesion (sin SMS):');
  console.log(`    http://localhost:${PUERTO}/entrar-como-consumidor`);
  console.log('  Desde el telefono: misma URL con la IP de esta PC (ipconfig).');
  console.log('');
  console.log('  Ctrl+C para pararlo.');
  console.log('');
});
