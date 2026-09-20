#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════
// analizar-dependencias.mjs — qué cruza la frontera consumidor ↔ panel
// ══════════════════════════════════════════════════════════════════════════
//
// Regla única: PANEL = lo que una sesión de consumidor NUNCA ejecuta.
//
// Dos modos:
//
//   node tools/analizar-dependencias.mjs
//       Clasifica `src/app.js` por tramos de línea (las secciones del propio
//       archivo) y por nombre, y escribe `tools/partir/panel.propuesta.json`.
//       Es un BORRADOR: la lista buena se revisa a mano.
//
//   node tools/analizar-dependencias.mjs --lista tools/partir/panel.json
//       Toma esa lista como verdad y calcula los cruces. Imprime CINCO bloques:
//         1. variables de app.js que el panel lee   → getters/setters del puente
//         2. funciones de app.js que el panel llama → se desestructuran del puente
//         3. funciones del panel que app.js llama   → pasan a `P.x`
//         4. VIOLACIONES: variables declaradas en el panel que app.js usa
//                         (deben ser CERO: se quitan de panel.json)
//         5. `window.X` del panel referenciado desde app.js o desde un onclick
//            de una pantalla que NO es del panel. `window` es global, así que
//            la reescritura por AST no puede verlo: daría TypeError. Cuenta
//            también el identificador PELADO (`foo()`) cuyo único declarador es
//            `window.foo = …`: 193 de los ítems del panel son de esa forma, y
//            ahí el fallo es ReferenceError, no `undefined`.
//
// QUÉ PRUEBA Y QUÉ NO. Los bloques 1–4 son estáticos y completos: salen de
// resolver ámbitos sobre el AST. El bloque 5 no puede serlo, porque `window` es
// un cajón de sastre. Para los `onclick` de index.html el análisis demuestra
// «oculto al cargar» —el manejador nace dentro de algo con `display:none`, de
// una `.screen` sin `.active` o de un `.overlay`/`.drawer` cerrado—, y eso NO
// es lo mismo que «nunca se muestra»: no mira quién quita ese estado después.
// Si alguien añade un `classList.add('open')` desde código del consumidor,
// este script seguirá diciendo «0 a la vista» y estará equivocado. Esa mitad
// se comprueba leyendo el código, y está anotada en clasificacion.md §2.
//
//   Banderas extra: --items (volcado de todos los ítems con su tramo),
//                   --json (bloques en JSON), --html <ruta> (por defecto index.html)
//
// No modifica nada fuera de `tools/partir/`.

import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const RAIZ = process.cwd();
const RUTA_APP = path.join(RAIZ, 'src', 'app.js');

// ──────────────────────────────────────────────────────────────────────────
// 1. Tramos: las secciones de src/app.js, con su lado.
//    Se derivan de los rótulos `// ═══` del propio archivo. El tramo manda;
//    los nombres de NOMBRES_* corrigen ítems sueltos dentro de un tramo.
//    Sólo es el borrador — `panel.json` es el que decide.
// ──────────────────────────────────────────────────────────────────────────
const TRAMOS = [
  [1,     617,   'consumidor', 'config, estado, navegación, OTP, catálogo, alta de la propia tienda'],
  [618,   792,   'panel',      'ajustar ubicación y alta de negocio: el VENDEDOR en sitio'],
  [793,   4285,  'consumidor', 'datos de tienda, sesión, cache, catálogo, carrito, pago, zona, Maps, confirmar pedido'],
  [4286,  4322,  'panel',      'tickets de gasto (ticketCall, abrirTicket)'],
  [4323,  4467,  'consumidor', 'tokens de sesión, supabaseCall, catálogo desde Supabase'],
  [4468,  5080,  'panel',      'login con PIN; producción: tabs, insumos, consumibles, lotes'],
  [5081,  5138,  'consumidor', 'canje de puntos (Club), navbar, cerrar sesión'],
  [5139,  5211,  'panel',      'cambio de PIN del personal'],
  [5212,  5461,  'consumidor', 'Mi cuenta, opt-in de promos, navegar() y el botón atrás'],
  [5462,  5723,  'consumidor', 'Crunchy Club: puntos, retos, movimientos, tienda de canje'],
  [5724,  5900,  'panel',      'admin del Club, mínimos de mayoreo, hora límite, rutas'],
  [5901,  5977,  'consumidor', 'regalos del cliente y su historial de pedidos'],
  [5978,  5982,  'panel',      'estado de la pantalla B2B (admin)'],
  [5983,  5999,  'consumidor', 'esAdmin y los mostrarNav*: los llama el arranque de todos'],
  [6000,  8198,  'panel',      'resumen, dashboard, recordatorios, embudos, kárdex, inventario físico, cliente-vendedor, pedidos del vendedor'],
  [8199,  8282,  'consumidor', 'verDetallePedido: puerta compartida, desvía al tracking si no es vendedor'],
  [8283,  11609, 'panel',      'detalle+ticket, B2B, prospección, ruta, reparto, entregas, gastos'],
  [11610, 11615, 'panel',      'estado de caja'],
  [11616, 11624, 'consumidor', 'mostrarNavCaja: lo llama el arranque'],
  [11625, 12683, 'panel',      'caja y armado'],
  [12684, 12776, 'consumidor', 'permisos del navbar: corren también para el consumidor'],
  [12777, 13602, 'panel',      'UI admin de permisos y jornadas'],
  [13603, 13856, 'consumidor', 'mini carrito, tracking, ?ir=, pulse glow'],
  [13857, 14462, 'panel',      'productos/bebidas y cupones (admin), escáner de código'],
  [14463, 99999, 'consumidor', 'cupón en el checkout, instalación PWA, banners, encuesta'],
];

// Correcciones por nombre dentro de un tramo (falsos positivos conocidos).
const NOMBRES_CONSUMIDOR = new Set([
  'esVendedor', 'vendedorInfo', 'tokenVendedor', 'clienteActual', 'carrito',
  'aplicarModoVenta', 'mostrarCanalVenta', 'esCanalMayorista', 'MAYOREO_MINIMOS',
  'metodoEntrega', '_cuponEnCarrito', 'calcularDescuentoCupon', 'detectarZona',
  'pintarTracking', 'pintarTiendaCanje', 'mapInstance',
  // helpers de tramo panel que el camino del consumidor sí ejecuta
  'window.cerrarCambioPin',   // lo llama renderCuenta, sin condición
  'esAdminEstricto',          // lo llama aplicarPermisosNavbar
  'window.navegar',           // el no-op de 4802 y el navegador real de 5319
  '_modoCliente',             // lo escribe renderDrawer (el carrito)
  'ARMADO_TITULO_BASE',       // lo lee navegar() al salir de Armado
  'bloquearCamposCliente',    // lo llama renderDrawer
  'mostrarNavProduccion',     // lo llama irAlCatalogo, como sus tres hermanas
  'renderClubAdminCfg',       // renderPremia lo llama SIN condición (línea 5459)
]);
const NOMBRES_PANEL = new Set([]);

function ladoPorTramo(linea) {
  for (const [a, b, lado, nota] of TRAMOS) if (linea >= a && linea <= b) return [lado, nota];
  return ['consumidor', '(sin tramo)'];
}

// ──────────────────────────────────────────────────────────────────────────
// 2. Inventario de ítems de nivel superior
// ──────────────────────────────────────────────────────────────────────────
function nombresDePatron(p, salida) {
  if (!p) return salida;
  switch (p.type) {
    case 'Identifier': salida.push(p.name); break;
    case 'ObjectPattern': for (const pr of p.properties) nombresDePatron(pr.type === 'RestElement' ? pr.argument : pr.value, salida); break;
    case 'ArrayPattern': for (const el of p.elements) nombresDePatron(el, salida); break;
    case 'AssignmentPattern': nombresDePatron(p.left, salida); break;
    case 'RestElement': nombresDePatron(p.argument, salida); break;
  }
  return salida;
}

function esAsignacionWindow(n) {
  if (n.type !== 'ExpressionStatement') return null;
  const e = n.expression;
  if (e.type !== 'AssignmentExpression' || e.operator !== '=') return null;
  const l = e.left;
  if (l.type !== 'MemberExpression' || l.computed) return null;
  if (l.object.type !== 'Identifier' || l.object.name !== 'window') return null;
  if (l.property.type !== 'Identifier') return null;
  return { prop: l.property.name, derecha: e.right };
}

function inventario(ast, src) {
  const items = [];
  const push = (o) => { items.push(o); return o; };
  for (const n of ast.body) {
    const linea = n.loc.start.line, fin = n.loc.end.line;
    const base = { nodo: n, linea, fin, start: n.start, end: n.end };
    if (n.type === 'FunctionDeclaration') {
      push({ ...base, nombre: n.id.name, clase: 'funcion' });
    } else if (n.type === 'ClassDeclaration') {
      push({ ...base, nombre: n.id.name, clase: 'clase' });
    } else if (n.type === 'VariableDeclaration') {
      for (const d of n.declarations) {
        const nombres = nombresDePatron(d.id, []);
        // Un `const f = () => …` es una función a todos los efectos.
        const esFn = d.init && (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression');
        for (const nm of nombres) {
          push({
            ...base, nombre: nm, clase: esFn ? 'funcion' : 'variable',
            kind: n.kind, declarador: d, varios: nombres.length > 1,
          });
        }
      }
    } else {
      const w = esAsignacionWindow(n);
      if (w) {
        const esFn = w.derecha.type === 'ArrowFunctionExpression' || w.derecha.type === 'FunctionExpression';
        const alias = w.derecha.type === 'Identifier' ? w.derecha.name : null;
        push({ ...base, nombre: 'window.' + w.prop, prop: w.prop, clase: esFn ? 'window-funcion' : 'window-variable', alias });
      } else {
        push({ ...base, nombre: '(sentencia)@' + linea, clase: 'sentencia' });
      }
    }
  }
  // Mapa nombre → ítem (el primero gana; los redeclarados se anotan)
  const porNombre = new Map();
  for (const it of items) {
    if (!porNombre.has(it.nombre)) porNombre.set(it.nombre, it);
    else it.duplicado = true;
  }
  return { items, porNombre };
}

// ──────────────────────────────────────────────────────────────────────────
// 3. Ámbitos: para saber si un identificador es LIBRE (apunta al nivel
//    superior) o está declarado dentro del propio ítem.
// ──────────────────────────────────────────────────────────────────────────
const cacheAmbito = new WeakMap();

function varsDeFuncion(cuerpo, salida) {
  // `var` y function declarations hoisted, sin cruzar funciones anidadas.
  const visitar = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'FunctionDeclaration') { if (n.id) salida.add(n.id.name); return; }
    if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'ClassDeclaration' || n.type === 'ClassExpression') return;
    if (n.type === 'VariableDeclaration' && n.kind === 'var') {
      for (const d of n.declarations) nombresDePatron(d.id, []).forEach(x => salida.add(x));
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visitar);
      else if (v && typeof v === 'object' && typeof v.type === 'string') visitar(v);
    }
  };
  visitar(cuerpo);
  return salida;
}

function esNodoAmbito(n) {
  return n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' ||
    n.type === 'ArrowFunctionExpression' || n.type === 'BlockStatement' ||
    n.type === 'ForStatement' || n.type === 'ForInStatement' || n.type === 'ForOfStatement' ||
    n.type === 'CatchClause' || n.type === 'ClassExpression' || n.type === 'StaticBlock';
}

function ligadurasDe(n) {
  if (cacheAmbito.has(n)) return cacheAmbito.get(n);
  const s = new Set();
  switch (n.type) {
    case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
      for (const p of n.params) nombresDePatron(p, []).forEach(x => s.add(x));
      if (n.type === 'FunctionExpression' && n.id) s.add(n.id.name);
      if (n.type !== 'ArrowFunctionExpression') s.add('arguments');
      if (n.body && n.body.type === 'BlockStatement') varsDeFuncion(n.body, s);
      break;
    }
    case 'BlockStatement': case 'StaticBlock': {
      for (const st of n.body) {
        if (st.type === 'VariableDeclaration' && st.kind !== 'var') {
          for (const d of st.declarations) nombresDePatron(d.id, []).forEach(x => s.add(x));
        } else if (st.type === 'FunctionDeclaration' && st.id) s.add(st.id.name);
        else if (st.type === 'ClassDeclaration' && st.id) s.add(st.id.name);
      }
      break;
    }
    case 'ForStatement': {
      if (n.init && n.init.type === 'VariableDeclaration')
        for (const d of n.init.declarations) nombresDePatron(d.id, []).forEach(x => s.add(x));
      break;
    }
    case 'ForInStatement': case 'ForOfStatement': {
      if (n.left && n.left.type === 'VariableDeclaration')
        for (const d of n.left.declarations) nombresDePatron(d.id, []).forEach(x => s.add(x));
      break;
    }
    case 'CatchClause': nombresDePatron(n.param, []).forEach(x => s.add(x)); break;
    case 'ClassExpression': if (n.id) s.add(n.id.name); break;
  }
  cacheAmbito.set(n, s);
  return s;
}

// ¿Este Identifier es una REFERENCIA (no una declaración, clave ni propiedad)?
function esReferencia(nodo, padre, abuelo) {
  if (!padre) return true;
  switch (padre.type) {
    case 'MemberExpression': return !(padre.property === nodo && !padre.computed);
    case 'Property': return !(padre.key === nodo && !padre.computed);
    case 'PropertyDefinition': case 'MethodDefinition': return !(padre.key === nodo && !padre.computed);
    case 'VariableDeclarator': return padre.id !== nodo;
    case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
      return padre.id !== nodo && !padre.params.includes(nodo);
    case 'ClassDeclaration': case 'ClassExpression': return padre.id !== nodo;
    case 'LabeledStatement': return padre.label !== nodo;
    case 'BreakStatement': case 'ContinueStatement': return padre.label !== nodo;
    case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier': return false;
    case 'ExportSpecifier': return false;
    case 'AssignmentPattern': return !(padre.left === nodo && abuelo && (abuelo.type === 'ArrowFunctionExpression' || abuelo.type === 'FunctionExpression' || abuelo.type === 'FunctionDeclaration'));
    case 'RestElement': return padre.argument !== nodo;
    case 'ObjectPattern': case 'ArrayPattern': return false;
    default: return true;
  }
}

function esEscritura(nodo, padre) {
  if (!padre) return false;
  if (padre.type === 'AssignmentExpression' && padre.left === nodo) return true;
  if (padre.type === 'UpdateExpression' && padre.argument === nodo) return true;
  return false;
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Referencias: para cada ítem, qué nombres de nivel superior usa
// ──────────────────────────────────────────────────────────────────────────
function itemEnPosicion(items, pos) {
  let lo = 0, hi = items.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (pos < items[m].start) hi = m - 1;
    else if (pos >= items[m].end) lo = m + 1;
    else return items[m];
  }
  return null;
}

function referencias(ast, items, porNombre) {
  // Ítems ordenados por posición, uno por sentencia de nivel superior
  const porPos = [];
  const vistos = new Set();
  for (const it of items) {
    if (vistos.has(it.nodo)) continue;
    vistos.add(it.nodo); porPos.push(it);
  }
  porPos.sort((a, b) => a.start - b.start);
  // Un nodo de nivel superior puede haber generado varios ítems (varios
  // declaradores): el "dueño" de las referencias es el primero.
  const dueno = new Map();
  for (const it of items) if (!dueno.has(it.nodo)) dueno.set(it.nodo, it);

  const usos = [];   // {desdeItem, nombre, linea, escritura, esWindow}
  walk.fullAncestor(ast, (nodo, _st, ancestros) => {
    if (nodo.type !== 'Identifier' && nodo.type !== 'MemberExpression') return;
    const padre = ancestros[ancestros.length - 2] || null;
    const abuelo = ancestros[ancestros.length - 3] || null;

    if (nodo.type === 'MemberExpression') {
      // window.X  → referencia global explícita
      if (nodo.computed) return;
      if (nodo.object.type !== 'Identifier' || nodo.object.name !== 'window') return;
      if (nodo.property.type !== 'Identifier') return;
      const raiz = itemEnPosicion(porPos, nodo.start);
      if (!raiz) return;
      const it = dueno.get(raiz.nodo) || raiz;
      // La propia declaración `window.X = …` no cuenta como uso
      if (it.clase && it.clase.startsWith('window-') && it.nombre === 'window.' + nodo.property.name
          && it.nodo.expression && it.nodo.expression.left === nodo) return;
      usos.push({ desde: it, nombre: 'window.' + nodo.property.name, prop: nodo.property.name,
        linea: nodo.loc.start.line, escritura: esEscritura(nodo, padre), esWindow: true });
      return;
    }

    if (!esReferencia(nodo, padre, abuelo)) return;
    const nombre = nodo.name;
    // 193 de los ítems se declaran SÓLO como `window.foo = function…`, y su
    // clave en porNombre es 'window.foo'. Un `foo()` pelado en app.js que llame
    // a uno de ellos no es una MemberExpression, así que la rama de arriba no
    // lo ve; si aquí lo descartáramos por no estar en porNombre, el cruce no
    // caería en ningún bloque — y en ejecución es un ReferenceError hasta que
    // el panel carga, que es justo lo que el bloque 5 existe para atrapar.
    // Por eso se busca también la forma `window.<nombre>`.
    const declarado = porNombre.has(nombre);
    const soloWindow = !declarado && porNombre.has('window.' + nombre);
    if (!declarado && !soloWindow) return;
    // ¿lo tapa un ámbito local?
    for (let i = ancestros.length - 2; i >= 0; i--) {
      const a = ancestros[i];
      if (a.type === 'Program') break;
      if (!esNodoAmbito(a)) continue;
      if (ligadurasDe(a).has(nombre)) return;
    }
    const raiz = itemEnPosicion(porPos, nodo.start);
    if (!raiz) return;
    const it = dueno.get(raiz.nodo) || raiz;
    if (soloWindow) {
      // Se atribuye al ítem `window.<nombre>`, y se marca como global: no es una
      // referencia léxica, la reescritura por AST no puede convertirla en `P.x`.
      usos.push({ desde: it, nombre: 'window.' + nombre, prop: nombre,
        linea: nodo.loc.start.line, escritura: esEscritura(nodo, padre), esWindow: true, pelado: true });
      return;
    }
    usos.push({ desde: it, nombre, linea: nodo.loc.start.line, escritura: esEscritura(nodo, padre), esWindow: false });
  });
  return usos;
}

// ──────────────────────────────────────────────────────────────────────────
// 5. onclick de index.html, con la pantalla en la que vive cada uno
// ──────────────────────────────────────────────────────────────────────────
// Las 14 pantallas del panel, tal y como existen en index.html. No hay
// `s-permisos`: los permisos viven en el modal `drawer-permisos`, que este
// análisis trata como cualquier otro cajón.
const PANTALLAS_PANEL = new Set([
  's-produccion', 's-b2b', 's-prospeccion', 's-ruta', 's-reparto', 's-entregas',
  's-armado', 's-caja', 's-gastos', 's-jornadas', 's-productos', 's-cupones',
  's-resumen', 's-pin',
]);

const VACIAS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Reemplaza por espacios (conservando posiciones) lo que no es marcado:
// comentarios y el contenido de <script>/<style>, donde un `<` no abre etiqueta.
function soloMarcado(html) {
  let s = html;
  const blanquea = (re) => {
    s = s.replace(re, (t) => ' '.repeat(t.length));
  };
  blanquea(/<!--[\s\S]*?-->/g);
  s = s.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi, (_t, a, b, c) => a + ' '.repeat(b.length) + c);
  s = s.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_t, a, b, c) => a + ' '.repeat(b.length) + c);
  return s;
}

// Extensión de cada elemento con id: para decir en qué pantalla —o en qué
// modal— vive un onclick. index.html está balanceado (lo comprueba validar.mjs).
function elementosConId(html) {
  const marcado = soloMarcado(html);
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  const pila = [];
  const salida = [];
  let m;
  while ((m = re.exec(marcado))) {
    const cierra = m[1] === '/', tag = m[2].toLowerCase(), attrs = m[3], auto = m[4] === '/';
    if (cierra) {
      for (let i = pila.length - 1; i >= 0; i--) {
        if (pila[i].tag === tag) {
          const [el] = pila.splice(i, pila.length - i);
          salida.push({ ...el, hasta: m.index });
          break;
        }
      }
      continue;
    }
    if (auto || VACIAS.has(tag)) continue;
    const mid = /\bid="([^"]+)"/.exec(attrs);
    const mcl = /\bclass="([^"]*)"/.exec(attrs);
    const mst = /\bstyle="([^"]*)"/.exec(attrs);
    pila.push({ tag, id: mid ? mid[1] : null, clases: mcl ? mcl[1] : '', estilo: mst ? mst[1] : '', desde: m.index });
  }
  for (const el of pila) salida.push({ ...el, hasta: marcado.length });
  return salida;
}

const RE_OCULTO = /display\s*:\s*none/i;

function onclicksDe(html) {
  const els = elementosConId(html);
  const pantallas = els.filter(e => e.id && /\bscreen\b/.test(e.clases));
  const conId = els.filter(e => e.id);
  const salida = [];
  const re = /\bon(?:click|change|input|submit|keyup|keydown|focus|blur)="([^"]*)"/gi;
  let m;
  while ((m = re.exec(html))) {
    let pant = null;
    for (const p of pantallas) if (m.index > p.desde && m.index < p.hasta && (!pant || p.desde > pant.desde)) pant = p;
    // contenedor con id más EXTERNO (el modal/drawer o la pantalla)
    let raiz = null;
    for (const e of conId) if (m.index > e.desde && m.index < e.hasta && (!raiz || e.desde < raiz.desde)) raiz = e;
    // ¿El propio elemento o alguno de sus ancestros nace invisible AL CARGAR?
    // Tres vías, con su razón exacta en estilos.css:
    //   · estilo en línea `display:none`;
    //   · `.screen` sin `.active`  → `.screen{display:none}` (estilos.css:30);
    //   · `.overlay` sin `.visible` → `pointer-events:none` (estilos.css:373);
    //   · `.drawer` sin `.open`     → `transform:translateY(100%)`
    //     (estilos.css:380): el cajón NO tiene pointer-events:none, está
    //     desplazado entero por debajo del viewport fijo, y por eso no se puede
    //     tocar. La distinción importa: quien cambie ese transform por otra
    //     animación se lleva la garantía por delante.
    //
    // OJO CON LO QUE ESTO PRUEBA. Prueba «oculto al cargar», no «nunca se
    // muestra». No mira quién quita después ese estado: un
    // `classList.add('open')` o un `style.display=''` escrito desde código del
    // consumidor dejaría el manejador a la vista y este análisis no se
    // enteraría. Esa mitad se comprueba a mano (ver clasificacion.md §2, B5).
    let oculto = null;
    const marca = (e, razon) => { if (!oculto || e.desde > oculto.desde) oculto = { desde: e.desde, razon }; };
    for (const e of els) {
      if (!(m.index > e.desde && m.index < e.hasta)) continue;
      const c = ' ' + e.clases + ' ';
      if (RE_OCULTO.test(e.estilo)) marca(e, (e.id || '<' + e.tag + '>') + ' display:none');
      else if (/\bscreen\b/.test(c) && !/\bactive\b/.test(c)) marca(e, '.screen ' + (e.id || '') + ' inactiva');
      else if (/\boverlay\b/.test(c) && !/\bvisible\b/.test(c)) marca(e, '.overlay ' + (e.id || '') + ' cerrado');
      else if (/\bdrawer\b/.test(c) && !/\bopen\b/.test(c)) marca(e, '.drawer ' + (e.id || '') + ' cerrado');
    }
    const linea = html.slice(0, m.index).split('\n').length;
    salida.push({
      codigo: m[1], linea,
      pantalla: pant ? pant.id : '(fuera de pantalla)',
      contenedor: pant ? pant.id : (raiz ? raiz.id : '(sin contenedor)'),
      oculto: oculto ? oculto.razon : null,
    });
  }
  return salida;
}

const RE_IDENT = /[A-Za-z_$][\w$]*/g;
const RE_ONATTR = /\bon(?:click|change|input|submit|keyup|keydown|focus|blur|pointerdown)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

// Los `onclick=` que NO están en index.html: los escribe el propio app.js
// dentro de plantillas. Corren en ámbito global igual que los del HTML, así
// que valen para el bloque 5 aunque el AST no los vea como llamadas.
function onclicksEnJS(src, items) {
  const salida = [];
  let m;
  RE_ONATTR.lastIndex = 0;
  while ((m = RE_ONATTR.exec(src))) {
    const codigo = m[1] != null ? m[1] : m[2];
    const linea = src.slice(0, m.index).split('\n').length;
    salida.push({ codigo, linea, pos: m.index });
  }
  return salida;
}

// ──────────────────────────────────────────────────────────────────────────
// 6. Modos
// ──────────────────────────────────────────────────────────────────────────
function cargar() {
  const src = fs.readFileSync(RUTA_APP, 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const { items, porNombre } = inventario(ast, src);
  return { src, ast, items, porNombre };
}

function proponer({ items }) {
  const panel = [], consumidor = [];
  for (const it of items) {
    let [lado] = ladoPorTramo(it.linea);
    const corto = it.prop || it.nombre;
    if (NOMBRES_CONSUMIDOR.has(corto) || NOMBRES_CONSUMIDOR.has(it.nombre)) lado = 'consumidor';
    if (NOMBRES_PANEL.has(corto) || NOMBRES_PANEL.has(it.nombre)) lado = 'panel';
    it.lado = lado;
    (lado === 'panel' ? panel : consumidor).push(it);
  }
  const lineasPanel = panel.reduce((a, it) => a + (it.fin - it.linea + 1), 0);
  const lineasCons = consumidor.reduce((a, it) => a + (it.fin - it.linea + 1), 0);
  const destino = path.join(RAIZ, 'tools', 'partir', 'panel.propuesta.json');
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, JSON.stringify({
    _nota: 'BORRADOR heurístico (tramos de línea + nombres). Revisar a mano antes de usar.',
    panel: panel.map(it => it.nombre),
  }, null, 2) + '\n');
  console.log(`Ítems de nivel superior: ${items.length}`);
  console.log(`  panel      ${panel.length}  (~${lineasPanel} líneas)`);
  console.log(`  consumidor ${consumidor.length}  (~${lineasCons} líneas)`);
  console.log(`Escrito: ${path.relative(RAIZ, destino)}`);
}

function volcarItems({ items }) {
  for (const it of items) {
    let [lado, nota] = ladoPorTramo(it.linea);
    const corto = it.prop || it.nombre;
    if (NOMBRES_CONSUMIDOR.has(corto) || NOMBRES_CONSUMIDOR.has(it.nombre)) { lado = 'consumidor'; nota = 'corregido a mano · ' + nota; }
    if (NOMBRES_PANEL.has(corto) || NOMBRES_PANEL.has(it.nombre)) { lado = 'panel'; nota = 'corregido a mano · ' + nota; }
    console.log([String(it.linea).padStart(6), String(it.fin - it.linea + 1).padStart(5), (it.clase || '').padEnd(15), lado.padEnd(11), it.nombre, '  // ' + nota].join(' '));
  }
}

function analizar({ src, ast, items, porNombre }, lista, rutaHtml) {
  const enPanel = new Set(lista);
  // Un `window.X = X` (alias) sigue al ítem X aunque no esté en la lista.
  for (const it of items) {
    if (it.clase === 'window-funcion' || it.clase === 'window-variable') {
      if (it.alias && enPanel.has(it.alias)) enPanel.add(it.nombre);
    }
  }
  const lado = (it) => (enPanel.has(it.nombre) ? 'panel' : 'app');
  const desconocidos = lista.filter(n => !porNombre.has(n));

  const usos = referencias(ast, items, porNombre);

  const b1 = new Map(); // var de app leída por el panel
  const b2 = new Map(); // fn de app llamada por el panel
  const b3 = new Map(); // fn del panel llamada por app
  const b4 = new Map(); // VIOLACIÓN: var del panel usada por app
  const b5 = new Map(); // window.X del panel tocado desde app / onclick de consumidor

  const anota = (mapa, nombre, u, pelado) => {
    if (!mapa.has(nombre)) mapa.set(nombre, { nombre, usos: 0, escrituras: 0, pelados: 0, desde: new Set(), lineas: [] });
    const e = mapa.get(nombre);
    e.usos++; if (u.escritura) e.escrituras++; if (pelado) e.pelados++;
    e.desde.add(u.desde.nombre); if (e.lineas.length < 6) e.lineas.push(u.linea);
  };

  for (const u of usos) {
    const decl = porNombre.get(u.nombre);
    const ladoDesde = lado(u.desde);
    if (u.esWindow) {
      // ¿window.X lo declara el panel y lo toca app.js?
      const declW = porNombre.get(u.nombre);
      const declBare = porNombre.get(u.prop);
      // Sólo importan las FUNCIONES: leer `window.loQueSea` de algo que no se
      // ha cargado da `undefined`, no TypeError. Llamarlo, sí.
      const esFnW = (declW && declW.clase === 'window-funcion') || (declBare && (declBare.clase === 'funcion' || declBare.clase === 'clase'));
      const declaradoEnPanel = (declW && lado(declW) === 'panel') || (declBare && enPanel.has(declBare.nombre));
      // `u.pelado` = el uso es un identificador SIN `window.` cuyo único
      // declarador es `window.X`. Ahí no hace falta que sea función: leer un
      // nombre pelado que aún no existe es ReferenceError, no `undefined`.
      if ((esFnW || u.pelado) && declaradoEnPanel && ladoDesde === 'app') anota(b5, u.nombre, u, u.pelado);
      continue;
    }
    if (!decl) continue;
    const ladoDecl = lado(decl);
    if (ladoDecl === ladoDesde) continue;
    const esFn = decl.clase === 'funcion' || decl.clase === 'clase' || decl.clase === 'window-funcion';
    if (ladoDecl === 'app' && ladoDesde === 'panel') anota(esFn ? b2 : b1, u.nombre, u);
    else if (ladoDecl === 'panel' && ladoDesde === 'app') anota(esFn ? b3 : b4, u.nombre, u);
  }

  // Bloque 5, segunda vía: onclick de index.html
  const html = fs.readFileSync(rutaHtml, 'utf8');
  const clicks = onclicksDe(html);
  const onclickMalos = [];
  for (const c of clicks) {
    if (PANTALLAS_PANEL.has(c.pantalla)) continue;
    const nombres = new Set(c.codigo.match(RE_IDENT) || []);
    for (const n of nombres) {
      const declW = porNombre.get('window.' + n);
      const declBare = porNombre.get(n);
      const enP = (declW && lado(declW) === 'panel') || (declBare && enPanel.has(declBare.nombre));
      if (!enP) continue;
      onclickMalos.push({ nombre: n, pantalla: c.pantalla, contenedor: c.contenedor, oculto: c.oculto, linea: c.linea, codigo: c.codigo.slice(0, 70) });
    }
  }

  // Bloque 5, tercera vía: onclick escritos por el propio app.js en plantillas
  // dentro de código del lado consumidor.
  const porPos = [...new Set(items.map(it => it.nodo))]
    .map(n => items.find(it => it.nodo === n)).sort((a, b) => a.start - b.start);
  const onclickJS = [];
  for (const c of onclicksEnJS(src, items)) {
    const raiz = itemEnPosicion(porPos, c.pos);
    if (!raiz || lado(raiz) !== 'app') continue;
    const nombres = new Set(c.codigo.match(RE_IDENT) || []);
    for (const n of nombres) {
      const declW = porNombre.get('window.' + n);
      const declBare = porNombre.get(n);
      const enP = (declW && lado(declW) === 'panel') || (declBare && enPanel.has(declBare.nombre));
      if (!enP) continue;
      onclickJS.push({ nombre: n, desde: raiz.nombre, linea: c.linea, codigo: c.codigo.slice(0, 60) });
    }
  }

  // Bloque 5, cuarta vía: los <script> propios de index.html (el bootstrap
  // vanilla) corren antes que el módulo y también ven `window`.
  const scriptsMalos = [];
  {
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    let m;
    while ((m = re.exec(html))) {
      if (/\bsrc\s*=/.test(m[1])) continue;
      const linea = html.slice(0, m.index).split('\n').length;
      const vistos = new Set();
      for (const n of (m[2].match(RE_IDENT) || [])) {
        if (vistos.has(n)) continue;
        const declW = porNombre.get('window.' + n), declBare = porNombre.get(n);
        const enP = (declW && lado(declW) === 'panel') || (declBare && enPanel.has(declBare.nombre));
        if (!enP) continue;
        vistos.add(n);
        scriptsMalos.push({ nombre: n, linea });
      }
    }
  }

  // Nombres declarados dos veces en el nivel superior: el reescritor de la
  // tarea 5 no sabría a cuál se refiere cada uso.
  const dobles = items.filter(it => it.duplicado).map(it => it.nombre + '@' + it.linea);

  const panelItems = items.filter(it => enPanel.has(it.nombre));
  const lineasPanel = [...new Set(panelItems.map(it => it.nodo))].reduce((a, n) => a + (n.loc.end.line - n.loc.start.line + 1), 0);

  const orden = (m) => [...m.values()].sort((a, b) => b.usos - a.usos || a.nombre.localeCompare(b.nombre));
  const pinta = (titulo, arr, detalle = true) => {
    console.log('\n' + '═'.repeat(74));
    console.log(titulo + '  — ' + arr.length);
    console.log('═'.repeat(74));
    for (const e of arr) {
      const w = e.escrituras ? `  ⚠ ${e.escrituras} escritura(s)` : '';
      console.log('  ' + e.nombre.padEnd(38) + String(e.usos).padStart(4) + ' usos' + w);
      if (detalle) console.log('      líneas ' + e.lineas.join(', ') + (e.usos > e.lineas.length ? '…' : '') + '  desde: ' + [...e.desde].slice(0, 5).join(', '));
    }
    if (!arr.length) console.log('  (vacío)');
  };

  console.log(`src/app.js: ${items.length} ítems de nivel superior`);
  console.log(`panel.json: ${lista.length} nombres  →  ${panelItems.length} ítems, ~${lineasPanel} líneas`);
  if (desconocidos.length) console.log('⚠ nombres de panel.json que NO existen en app.js: ' + desconocidos.join(', '));

  pinta('BLOQUE 1 — variables de app.js que lee el panel (→ getters/setters de N)', orden(b1));
  pinta('BLOQUE 2 — funciones de app.js que llama el panel (→ se toman de N)', orden(b2));
  pinta('BLOQUE 3 — funciones del panel que llama app.js (→ P.x)', orden(b3));
  pinta('BLOQUE 4 — VIOLACIONES: variables del panel que usa app.js (debe estar VACÍO)', orden(b4));

  console.log('\n' + '═'.repeat(74));
  const expuestos = onclickMalos.filter(o => !o.oculto);
  const ocultos = onclickMalos.filter(o => o.oculto);
  console.log(`BLOQUE 5 — window.X del panel visto desde fuera  — AST ${b5.size} · onclick HTML ${onclickMalos.length} (${expuestos.length} a la vista al cargar) · onclick de app.js ${onclickJS.length}`);
  console.log('═'.repeat(74));
  for (const e of orden(b5)) console.log('  [AST' + (e.pelados ? '-pelado' : '') + ']'.padEnd(e.pelados ? 3 : 10) + e.nombre.padEnd(34) + String(e.usos).padStart(3) + ' usos' + (e.pelados ? ' (' + e.pelados + ' sin window.)' : '') + ' · líneas ' + e.lineas.join(', ') + ' · desde: ' + [...e.desde].slice(0, 4).join(', '));
  for (const o of expuestos) console.log('  [html!]    ' + o.nombre.padEnd(34) + o.contenedor.padEnd(26) + 'index.html:' + o.linea);
  const porCont = new Map();
  for (const o of ocultos) {
    const k = o.contenedor + ' · oculto por ' + o.oculto;
    if (!porCont.has(k)) porCont.set(k, new Set());
    porCont.get(k).add(o.nombre);
  }
  for (const [k, ns] of porCont) console.log('  [html-oculto] ' + k + '\n                  → ' + [...ns].join(', '));
  for (const o of onclickJS) console.log('  [plantilla]' + o.nombre.padEnd(34) + ('desde ' + o.desde).padEnd(26) + 'app.js:' + o.linea);
  for (const o of scriptsMalos) console.log('  [script]   ' + o.nombre.padEnd(34) + 'index.html:' + o.linea);
  if (!b5.size && !onclickMalos.length && !onclickJS.length && !scriptsMalos.length) console.log('  (vacío)');
  if (dobles.length) console.log('\n⚠ nombres de nivel superior declarados más de una vez: ' + dobles.join(', '));

  const n5 = b5.size + onclickMalos.length + onclickJS.length + scriptsMalos.length;
  console.log('\nResumen: B1=' + b1.size + '  B2=' + b2.size + '  B3=' + b3.size + '  B4=' + b4.size + '  B5=' + n5);

  return { b1: orden(b1), b2: orden(b2), b3: orden(b3), b4: orden(b4), b5: orden(b5), onclickMalos, onclickJS, lineasPanel, itemsPanel: panelItems.length, total: items.length };
}

// ──────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const datos = cargar();

if (args.includes('--items')) {
  volcarItems(datos);
} else if (args.includes('--lista')) {
  const ruta = arg('--lista');
  const lista = JSON.parse(fs.readFileSync(path.resolve(RAIZ, ruta), 'utf8')).panel;
  const html = path.resolve(RAIZ, arg('--html') || 'index.html');
  const r = analizar(datos, lista, html);
  if (args.includes('--json')) fs.writeFileSync(path.join(RAIZ, 'tools', 'partir', 'cruces.json'), JSON.stringify(r, (k, v) => (v instanceof Set ? [...v] : k === 'desde' ? v : v), 2));
} else {
  proponer(datos);
}
