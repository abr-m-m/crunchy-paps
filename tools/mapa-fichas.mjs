#!/usr/bin/env node
// tools/mapa-fichas.mjs — genera una ficha ESQUELETO por sección, leyendo el código.
//
// POR QUÉ EXISTE. El mapa visual lleva 1 ficha de 36 en dos meses, y no por
// desidia: una ficha completa son ~360 líneas y sus pines se miden uno a uno
// contra la imagen real. A ese ritmo faltan 35 sesiones, así que el mapa nunca
// va a servir de manual del equipo — que es una de las tres cosas para las que
// se hizo.
//
// Abraham, 23 nov 2026: «sigue con el mapa visual, simplifícalo si es
// necesario».
//
// LA SIMPLIFICACIÓN NO INVENTA UN FORMATO NUEVO: el diseño ya admitía fichas
// `esqueleto` (`tools/mapa-comprobar.mjs`, MADUREZ) y nadie las había escrito.
// Lo que faltaba era no escribirlas a mano.
//
// QUÉ PONE Y QUÉ NO. Solo hechos que se leen del árbol: dónde vive la pantalla,
// qué función la pinta, qué RPC llama esa función y quién alcanza la sección
// según la matriz de permisos (que ya se genera de producción). NO pone para
// qué sirve, ni qué le falta, ni pines: eso es criterio y se escribe a mano, y
// una ficha completa sigue siendo mejor que un esqueleto.
//
// Y COMO SE GENERA, NO ENVEJECE. Es la diferencia con las fichas escritas: si
// alguien mueve una sección o cambia su RPC, esto lo dice al siguiente `npm run
// mapa`. Una ficha escrita a mano se queda contando lo de hace dos meses —que
// es justo lo que le pasó a este mapa con tres de sus cinco pendientes.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const RAIZ = process.cwd();
const SALIDA = 'docs/mapa/datos/secciones.js';
const app = readFileSync('src/app.js', 'utf8');
const panel = readFileSync('src/panel.js', 'utf8');
const html = readFileSync('index.html', 'utf8');

const hoy = new Date().toISOString().slice(0, 10);

// ── 1. El catálogo de secciones, de donde lo lee la propia app ─────────────
const mCat = app.match(/const NAV_ITEM_POR_SECCION = \{([\s\S]*?)\n\};/);
if (!mCat) { console.error('No encuentro NAV_ITEM_POR_SECCION'); process.exit(1); }
const SECCIONES = [...mCat[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);

// ── 2. Sección → pantalla y función que la pinta, leyendo `navegar` ────────
// Se lee el cuerpo entero de `navegar` y se parte por sus ramas: cada rama
// nombra su sección, enciende un `s-…` y suele llamar a su render.
// `navegar` se declara como `window.navegar = function(seccion)`, no como
// `function navegar(`: buscarlo por lo segundo devolvía -1 y el cuerpo salía
// vacío, y entonces las 18 secciones aparecían «sin rama». Lo dijo el propio
// generador en su primera corrida, que para eso imprime lo que NO pudo hacer.
const iNav = app.indexOf('window.navegar = function(seccion)');
if (iNav < 0) { console.error('No encuentro navegar'); process.exit(1); }
const cuerpoNav = app.slice(iNav, app.indexOf('\n};', iNav));
// Las ramas se parten por su propia marca, no con un lookahead frágil: cada
// trozo empieza en `if (seccion === 'X')` y acaba donde empieza el siguiente.
const trozos = cuerpoNav.split(/(?=(?:else )?if \(seccion === ')/);
const ramas = {};
for (const t of trozos) {
  const m = t.match(/^(?:else )?if \(seccion === '([a-z0-9]+)'\)/);
  if (m) ramas[m[1]] = t;
}

const pantallaDe = (rama) => (rama.match(/getElementById\('(s-[a-z0-9-]+)'\)\.classList\.add\('active'\)/) || [])[1];
const rendersDe = (rama) => [...rama.matchAll(/\bP?\.?(render[A-Z]\w*)\s*\(/g)].map((m) => m[1]);

// ── 3. Dónde vive una función y qué RPC llama ──────────────────────────────
function cuerpoFuncion(nombre) {
  for (const [txt, archivo] of [[panel, 'src/panel.js'], [app, 'src/app.js']]) {
    const re = new RegExp('\\n(?:async )?function ' + nombre + '\\s*\\(');
    const m = txt.match(re);
    if (!m) continue;
    const ini = m.index + 1;
    // Hasta la siguiente función de primer nivel: no se parsea JS, se corta.
    const sig = txt.slice(ini + 10).search(/\n(?:async )?function \w/);
    const fin = sig < 0 ? txt.length : ini + 10 + sig;
    const linea = txt.slice(0, ini).split('\n').length;
    return { archivo, desde: linea, hasta: txt.slice(0, fin).split('\n').length, cuerpo: txt.slice(ini, fin) };
  }
  return null;
}

const rpcsDe = (cuerpo) => [...new Set([...cuerpo.matchAll(/rpc\/([a-z0-9_]+)/g)].map((m) => m[1]))].sort();

// Palabras que parecen llamadas a función y no lo son, o que no describen la
// pantalla. Sin esta lista el rastreo de un nivel arrastra medio archivo.
const PALABRAS = new Set(['function', 'return', 'typeof', 'catch', 'while', 'switch',
  'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date', 'Promise',
  'parseInt', 'parseFloat', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'querySelector', 'querySelectorAll', 'getElementById', 'addEventListener', 'console',
  'supabaseCall', 'forEach', 'filter', 'map', 'join', 'split', 'slice', 'replace',
  'toLocaleString', 'toFixed', 'push', 'includes', 'sort', 'reduce', 'some', 'every']);

// ── 4. Dónde vive la pantalla en index.html ────────────────────────────────
function rangoPantalla(id) {
  const i = html.indexOf(`id="${id}"`);
  if (i < 0) return null;
  const desde = html.slice(0, i).split('\n').length;
  const sig = html.indexOf('<div class="screen"', i + 10);
  const hasta = sig < 0 ? html.split('\n').length : html.slice(0, sig).split('\n').length - 1;
  return { archivo: 'index.html', desde, hasta };
}

// ── 5. Quién la ve, de la matriz que ya se genera de producción ────────────
const win = {};
const dirDatos = 'docs/mapa/datos';
for (const f of readdirSync(dirDatos).filter((f) => f.endsWith('.js'))) {
  if (f === 'secciones.js') continue;
  new Function('window', readFileSync(join(dirDatos, f), 'utf8'))(win);
}
const permisos = (win.MAPA && win.MAPA.permisos) || { porRol: {} };
// Los cuatro tipos de cliente comparten la barra del consumidor: no hay una
// lista por tipo, así que lo que alcanza `consumidor` lo alcanzan los cuatro.
const TIPOS_CLIENTE = ['consumidor', 'tienda', 'restaurante', 'mayorista'];
function quienLaVe(seccion) {
  const ven = new Set();
  // Los tipos de cliente, de la lista del rol `consumidor`.
  const delCliente = (permisos.porRol || {}).consumidor || [];
  if (delCliente.includes(seccion)) TIPOS_CLIENTE.forEach((t) => ven.add(t));
  // El equipo, de la matriz EFECTIVA (usuario a usuario) y no de la del rol.
  // Preguntarle al rol daba `ven: []` en `resumen` y `costos`: ninguna lista de
  // rol las nombra, y el dueño llega por su atajo. Una ficha que dice «no la ve
  // nadie» de una pantalla que se usa a diario es justo la clase de mentira que
  // este mapa existe para no contar.
  for (const u of Object.values(permisos.efectivo || {})) {
    if (!u || !Array.isArray(u.secciones) || !u.secciones.includes(seccion)) continue;
    const rol = String(u.rol || '').toLowerCase();
    if (rol.startsWith('administrador')) ven.add('administrador');
    else if (rol === 'mostrador') ven.add('mostrador');
    else if (rol === 'vendedor') ven.add('vendedor');
  }
  return [...ven];
}

// ── 6. Las que ya tienen ficha escrita a mano NO se tocan ──────────────────
const yaEscritas = new Set(
  Object.values(win.MAPA || {})
    .filter((v) => v && Array.isArray(v.fichas))
    .flatMap((v) => v.fichas.map((f) => f.id)));

// ── 7. Generar ─────────────────────────────────────────────────────────────
const fichas = [];
const sinRama = [];
for (const seccion of SECCIONES) {
  const clave = seccion === 'catalogo' ? 'inicio' : seccion;
  const rama = ramas[clave];
  if (!rama) { sinRama.push(seccion); continue; }
  const pantalla = pantallaDe(rama);
  if (!pantalla) { sinRama.push(seccion); continue; }
  if (yaEscritas.has(pantalla)) continue;

  const codigo = [];
  const rango = rangoPantalla(pantalla);
  if (rango) codigo.push(rango);
  const rpcs = new Set();
  const indirectos = new Set();
  for (const nombre of rendersDe(rama)) {
    const f = cuerpoFuncion(nombre);
    if (!f) continue;
    codigo.push({ archivo: f.archivo, desde: f.desde, hasta: f.hasta });
    rpcsDe(f.cuerpo).forEach((r) => rpcs.add(r));
    // UN nivel más abajo, y solo uno. `renderPedidos()` no llama a ningún RPC:
    // reparte entre `renderPedidosVendedor()` y la vista del consumidor, y los
    // RPC viven ahí. Quedarse en el primer nivel decía una verdad que engaña.
    // Dos niveles ya arrastran medio archivo y dejan de describir la pantalla.
    for (const m of f.cuerpo.matchAll(/\b([a-zA-Z_]\w{3,})\s*\(/g)) {
      const hijo = m[1];
      if (hijo === nombre || PALABRAS.has(hijo)) continue;
      const g = cuerpoFuncion(hijo);
      if (!g || !g.cuerpo.includes('rpc/')) continue;
      rpcsDe(g.cuerpo).forEach((r) => { if (!rpcs.has(r)) indirectos.add(r); });
    }
  }

  const lista = [...rpcs].sort();
  const indir = [...indirectos].sort();
  const resumen =
    'Ficha generada por `tools/mapa-fichas.mjs`: dice dónde vive la pantalla, qué la ' +
    'pinta y qué pide, nada más — para qué sirve y qué le falta se escribe a mano. ' +
    (lista.length
      ? 'Pide directamente ' + lista.length + ' RPC: ' + lista.map((r) => '`' + r + '`').join(', ') + '. '
      : 'Su render no pide ningún RPC directamente. ') +
    (indir.length
      ? 'Y ' + indir.length + ' más a través de las funciones a las que llama: ' +
        indir.map((r) => '`' + r + '`').join(', ') + '.'
      : (lista.length ? '' : 'Tampoco a través de las funciones a las que llama: se pinta con ' +
         'datos que ya están en memoria.'));

  fichas.push({
    id: pantalla,
    nombre: seccion.charAt(0).toUpperCase() + seccion.slice(1),
    tipo: 'pantalla',
    ruta: '#' + pantalla,
    seccion,
    codigo,
    ven: quienLaVe(seccion),
    rpcs: lista,
    rpcsIndirectos: indir,
    madurez: 'esqueleto',
    verificado: hoy,
    resumen,
  });
}

const salida =
  'window.MAPA = window.MAPA || {};\n' +
  '// GENERADO por `node tools/mapa-fichas.mjs`. No se edita a mano: se regenera.\n' +
  '// Cuando una de estas fichas se escriba completa -con sus capturas, sus pines y\n' +
  '// su criterio-, se mueve a su familia y el generador deja de tocarla sola.\n' +
  'window.MAPA.secciones = ' +
  JSON.stringify({ familia: { id: 'secciones', nombre: 'Secciones (esqueleto)', orden: 9 }, fichas }, null, 2) +
  ';\n';
writeFileSync(SALIDA, salida, 'utf8');

// La primera corrida de este generador escribió CERO fichas y salió con éxito:
// buscaba `function navegar(` y la app la declara `window.navegar = function`.
// Un generador que no encuentra nada y no se queja deja un archivo vacío que
// parece legítimo, y el comprobador lo da por bueno porque un array vacío es
// coherente. Si se rompe el parser, que se rompa en voz alta.
if (!fichas.length || sinRama.length > SECCIONES.length / 2) {
  console.error(`\n  El generador no encontró casi nada: ${fichas.length} fichas y ` +
    `${sinRama.length} secciones sin rama de ${SECCIONES.length}. ` +
    `Lo más probable es que haya cambiado la forma de \`navegar\` en src/app.js.\n`);
  process.exit(1);
}

console.log(`\n${SALIDA} — ${fichas.length} fichas esqueleto de ${SECCIONES.length} secciones`);
if (yaEscritas.size) console.log(`  ${yaEscritas.size} ya tenían ficha escrita y no se tocan: ${[...yaEscritas].join(', ')}`);
if (sinRama.length) console.log(`  ${sinRama.length} sin rama propia en navegar: ${sinRama.join(', ')}`);
const sinRpc = fichas.filter((f) => !f.rpcs.length).map((f) => f.seccion);
if (sinRpc.length) console.log(`  ${sinRpc.length} sin RPC en su render: ${sinRpc.join(', ')}`);
console.log('');
