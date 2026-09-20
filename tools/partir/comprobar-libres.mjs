#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// comprobar-libres.mjs — la red que `vite build` NO es.
//
// Rollup no resuelve identificadores globales: si al partir el monolito una
// función se quedó llamando a un nombre que ya no existe en su archivo, el build
// sale en verde y el ReferenceError aparece en el navegador de un cliente.
//
// Esta herramienta recorre `src/app.js` y `src/panel.js` con un modelo de
// ámbitos propio y saca cada identificador LIBRE (el que ningún ámbito del
// archivo liga). Un identificador libre solo es legítimo si es:
//   1. un global del navegador o un built-in de JavaScript,
//   2. uno de los cinco externos conocidos (Maps, Quagga, /api/config.js),
//   3. un `window.X` que alguno de los DOS archivos asigna.
// Cualquier otro nombre se lista y el proceso sale con 1.
//
// Uso:  node tools/partir/comprobar-libres.mjs [raíz-del-repo]
// ══════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const acorn = await import(pathToFileURL(path.join(RAIZ, 'node_modules/acorn/dist/acorn.mjs')).href);
const walk = await import(pathToFileURL(path.join(RAIZ, 'node_modules/acorn-walk/dist/walk.mjs')).href);

const parse = (t) => acorn.parse(t, { ecmaVersion: 'latest', sourceType: 'module', ranges: true, locations: true });

// ── Los cinco externos conocidos: Google Maps, Quagga y lo que inyecta /api/config.js ──
const EXTERNOS = new Set(['google', 'fechaCDMX', 'navSections', 'fechaDeValorCDMX', 'Quagga']);

// ── Globales del navegador y built-ins de JavaScript ──
// Los built-ins salen de `globalThis` de Node (Object, Array, JSON, Promise, Math…);
// el resto es la lista del navegador, que Node no tiene.
const NAVEGADOR = [
  'window', 'document', 'location', 'navigator', 'history', 'screen', 'self', 'top', 'parent', 'frames',
  'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'origin', 'closed', 'name',
  'alert', 'confirm', 'prompt', 'open', 'close', 'focus', 'blur', 'print', 'stop',
  'scrollTo', 'scrollBy', 'scroll', 'scrollX', 'scrollY', 'innerWidth', 'innerHeight',
  'outerWidth', 'outerHeight', 'pageXOffset', 'pageYOffset', 'devicePixelRatio', 'visualViewport',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
  'matchMedia', 'getComputedStyle', 'getSelection', 'btoa', 'atob',
  'Image', 'Audio', 'Option', 'FormData', 'Blob', 'File', 'FileReader', 'FileList',
  'URL', 'URLSearchParams', 'XMLHttpRequest', 'WebSocket', 'Worker', 'SharedWorker', 'BroadcastChannel',
  'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'TouchEvent', 'PointerEvent', 'FocusEvent',
  'DragEvent', 'WheelEvent', 'InputEvent', 'SubmitEvent', 'MessageEvent', 'CloseEvent',
  'EventTarget', 'EventSource', 'AbortController', 'AbortSignal',
  'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLCanvasElement',
  'HTMLImageElement', 'HTMLFormElement', 'HTMLAnchorElement', 'HTMLTextAreaElement', 'HTMLButtonElement',
  'NodeList', 'HTMLCollection', 'DocumentFragment', 'ShadowRoot', 'DOMParser', 'XMLSerializer',
  'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'PerformanceObserver', 'performance',
  'AudioContext', 'webkitAudioContext', 'OfflineAudioContext', 'MediaRecorder', 'MediaStream',
  'Notification', 'PushManager', 'ServiceWorker', 'ServiceWorkerRegistration',
  'Geolocation', 'GeolocationPositionError', 'PositionError',
  'CSS', 'CanvasRenderingContext2D', 'Path2D', 'DOMRect', 'DOMMatrix',
  'ClipboardItem', 'Range', 'Selection', 'Response', 'Request', 'Headers', 'ReadableStream', 'WritableStream',
  'TextEncoder', 'TextDecoder', 'CompressionStream', 'DecompressionStream',
  'customElements', 'crypto', 'fetch', 'structuredClone', 'queueMicrotask', 'reportError',
  'getEventListeners', 'onerror', 'onload',
  // Analítica que index.html define en su bootstrap (bloque <head>)
  'gtag', 'dataLayer', 'ga',
];

const GLOBALES = new Set([...Object.getOwnPropertyNames(globalThis), ...NAVEGADOR, ...EXTERNOS]);

// ── Modelo de ámbitos ────────────────────────────────────────────────────────
function nombresDePatron(p, out = []) {
  if (!p) return out;
  switch (p.type) {
    case 'Identifier': out.push(p.name); break;
    case 'ObjectPattern': p.properties.forEach((q) => nombresDePatron(q.type === 'RestElement' ? q.argument : q.value, out)); break;
    case 'ArrayPattern': p.elements.forEach((e) => nombresDePatron(e, out)); break;
    case 'AssignmentPattern': nombresDePatron(p.left, out); break;
    case 'RestElement': nombresDePatron(p.argument, out); break;
  }
  return out;
}

// `var` y declaraciones de función suben hasta la función contenedora.
function varsDeFuncion(cuerpo, salida) {
  const visitar = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'FunctionDeclaration') { if (n.id) salida.add(n.id.name); return; }
    if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'ClassDeclaration' || n.type === 'ClassExpression') return;
    if (n.type === 'VariableDeclaration' && n.kind === 'var') for (const d of n.declarations) nombresDePatron(d.id).forEach((x) => salida.add(x));
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visitar);
      else if (v && typeof v === 'object' && typeof v.type === 'string') visitar(v);
    }
  };
  visitar(cuerpo);
  return salida;
}

const cache = new WeakMap();
function ligadurasDe(n) {
  if (cache.has(n)) return cache.get(n);
  const s = new Set();
  switch (n.type) {
    case 'Program': {
      for (const st of n.body) {
        const d = st.type === 'ExportNamedDeclaration' && st.declaration ? st.declaration : st;
        if (d.type === 'VariableDeclaration') for (const dd of d.declarations) nombresDePatron(dd.id).forEach((x) => s.add(x));
        else if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) s.add(d.id.name);
        else if (d.type === 'ImportDeclaration') for (const sp of d.specifiers) s.add(sp.local.name);
      }
      varsDeFuncion({ type: 'BlockStatement', body: n.body }, s);
      break;
    }
    case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
      for (const p of n.params) nombresDePatron(p).forEach((x) => s.add(x));
      if (n.type === 'FunctionExpression' && n.id) s.add(n.id.name);
      if (n.type !== 'ArrowFunctionExpression') s.add('arguments');
      if (n.body && n.body.type === 'BlockStatement') varsDeFuncion(n.body, s);
      break;
    case 'BlockStatement': case 'StaticBlock':
      for (const st of n.body) {
        if (st.type === 'VariableDeclaration' && st.kind !== 'var') for (const d of st.declarations) nombresDePatron(d.id).forEach((x) => s.add(x));
        else if ((st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') && st.id) s.add(st.id.name);
      }
      break;
    case 'SwitchStatement':
      for (const c of n.cases) for (const st of c.consequent) {
        if (st.type === 'VariableDeclaration' && st.kind !== 'var') for (const d of st.declarations) nombresDePatron(d.id).forEach((x) => s.add(x));
        else if ((st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') && st.id) s.add(st.id.name);
      }
      break;
    case 'ForStatement': if (n.init && n.init.type === 'VariableDeclaration') for (const d of n.init.declarations) nombresDePatron(d.id).forEach((x) => s.add(x)); break;
    case 'ForInStatement': case 'ForOfStatement': if (n.left && n.left.type === 'VariableDeclaration') for (const d of n.left.declarations) nombresDePatron(d.id).forEach((x) => s.add(x)); break;
    case 'CatchClause': nombresDePatron(n.param).forEach((x) => s.add(x)); break;
    case 'ClassExpression': case 'ClassDeclaration': if (n.id) s.add(n.id.name); break;
  }
  cache.set(n, s);
  return s;
}

const ESCOPO = new Set(['Program', 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'BlockStatement', 'StaticBlock', 'SwitchStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'CatchClause', 'ClassExpression', 'ClassDeclaration']);

// ¿Este Identifier es una REFERENCIA (se lee un valor) o solo un nombre (propiedad, etiqueta…)?
function esReferencia(n, p, ab) {
  if (!p) return true;
  switch (p.type) {
    case 'MemberExpression': return !(p.property === n && !p.computed);
    case 'Property': return !(p.key === n && !p.computed) || p.shorthand;
    case 'PropertyDefinition': case 'MethodDefinition': return !(p.key === n && !p.computed);
    case 'VariableDeclarator': return p.id !== n;
    case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': return p.id !== n && !p.params.includes(n);
    case 'ClassDeclaration': case 'ClassExpression': return p.id !== n;
    case 'LabeledStatement': return p.label !== n;
    case 'BreakStatement': case 'ContinueStatement': return p.label !== n;
    case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier': case 'ExportSpecifier': return false;
    case 'AssignmentPattern': return !(p.left === n && ab && (ab.type === 'ArrowFunctionExpression' || ab.type === 'FunctionExpression' || ab.type === 'FunctionDeclaration'));
    case 'RestElement': return p.argument !== n;
    case 'ObjectPattern': case 'ArrayPattern': return false;
    default: return true;
  }
}

function libresDe(ast) {
  const out = new Map();
  walk.fullAncestor(ast, (n, _s, anc) => {
    if (n.type !== 'Identifier') return;
    const p = anc[anc.length - 2] || null;
    const ab = anc[anc.length - 3] || null;
    if (!esReferencia(n, p, ab)) return;
    for (let k = 0; k < anc.length - 1; k++) {
      const a = anc[k];
      if (ESCOPO.has(a.type) && ligadurasDe(a).has(n.name)) return;
    }
    if (!out.has(n.name)) out.set(n.name, []);
    out.get(n.name).push(n.loc.start.line);
  });
  return out;
}

// Todo `window.X = …` (en cualquier profundidad) de los dos archivos.
function windowAsignados(texto) {
  return new Set([...texto.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map((m) => m[1]));
}

// ── Ejecución ────────────────────────────────────────────────────────────────
const ARCHIVOS = ['src/app.js', 'src/panel.js'];
const fuentes = ARCHIVOS.map((f) => readFileSync(path.join(RAIZ, f), 'utf8'));
const asignadosWindow = new Set(fuentes.flatMap((t) => [...windowAsignados(t)]));

console.log(`comprobar-libres — ${ARCHIVOS.join(' + ')}`);
console.log(`globales conocidos: ${GLOBALES.size} · window.X asignados entre los dos archivos: ${asignadosWindow.size}`);

let malos = 0;
for (let i = 0; i < ARCHIVOS.length; i++) {
  const libres = libresDe(parse(fuentes[i]));
  const sueltos = [...libres.keys()].filter((x) => !GLOBALES.has(x) && !asignadosWindow.has(x));
  console.log(`\n${ARCHIVOS[i]}: ${libres.size} identificadores libres distintos · ${sueltos.length} sin respaldo`);
  for (const x of sueltos.sort()) {
    malos++;
    console.log(`  SUELTO: ${x}  (líneas ${libres.get(x).slice(0, 8).join(', ')})`);
  }
}

if (malos) {
  console.log(`\nRESULTADO: ${malos} identificador(es) libre(s) sin respaldo. Cada uno es un ReferenceError que el build no ve.`);
  process.exit(1);
}
console.log('\nRESULTADO: ningún identificador libre quedó colgando.');
