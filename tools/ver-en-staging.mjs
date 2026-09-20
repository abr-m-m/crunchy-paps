#!/usr/bin/env node
// tools/ver-en-staging.mjs — Levanta la app de ESTA rama, tal como está en el
// árbol de trabajo (o `dist/` si ya se corrió `npm run build`), apuntada a
// STAGING, en el puerto 8794. Sirve para mirar un cambio de aspecto antes de
// desplegarlo. Las rutas de sesión de prueba (`/entrar-como*`), `/api/config.js`
// y `/api/imagen-reto`, junto con las llaves que necesitan, viven en
// `manejarStaging()` de `tools/staging-middleware.mjs` (compartido con
// `npm run dev`): este archivo solo levanta el servidor HTTP y le delega esas
// rutas antes de caer al estático.
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
import { manejarStaging } from './staging-middleware.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const PUERTO = 8794;

const TIPOS = { '.html': 'text/html', '.js': 'application/javascript',
                '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
                '.css': 'text/css' };

// Fase 0: si `dist/` existe (npm run build ya corrió) se sirve el artefacto de
// Vite, igual que Vercel; `--fuente` fuerza servir el árbol de trabajo sin
// construir (para mirar index.html/src/ tal cual, sin pasar por Vite).
const RAIZ = process.argv.includes('--fuente') ? REPO : (existsSync(join(REPO, 'dist', 'index.html')) ? join(REPO, 'dist') : REPO);

createServer((req, res) => {
  manejarStaging(req, res).then((atendida) => {
    if (atendida) return;
    const [ruta] = req.url.split('?');
    const p = join(RAIZ, ruta === '/' ? 'index.html' : ruta.slice(1));
    if (!existsSync(p)) { res.writeHead(404); res.end('no existe'); return; }
    res.writeHead(200, { 'content-type': TIPOS[extname(p)] || 'text/plain' });
    res.end(readFileSync(p));
  }).catch((e) => { res.writeHead(500); res.end(String(e && e.message)); });
}).listen(PUERTO, () => {
  console.log('');
  console.log(`  Crunchy Paps (${RAIZ === REPO ? 'FUENTE sin construir' : 'dist/'}) en http://localhost:${PUERTO}`);
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
