// Una sola vez. Lee src/app.js y tools/partir/panel.json; escribe src/panel.js y reescribe src/app.js.
// Todo por rangos del AST (acorn), aplicados de atrás hacia delante sobre el texto: nunca String.replace.
//
// NO es idempotente sobre su propia salida: para volver a correrlo,
//   git checkout src/app.js && rm -f src/panel.js
//
// El esquema de nombres de los ítems es EL MISMO que el de tools/analizar-dependencias.mjs,
// que es quien generó panel.json. Si los dos no coinciden, los ítems que el analizador
// nombra de una forma y este script de otra se quedan en app.js en silencio.
import { readFileSync, writeFileSync } from 'node:fs';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const src = readFileSync('src/app.js', 'utf8');
const lista = new Set(JSON.parse(readFileSync('tools/partir/panel.json', 'utf8')).panel);
const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', ranges: true, locations: true });

// 1. Ítems de nivel superior con nombre(s) y rango.
//    Un ítem = UNA sentencia de nivel superior (la unidad mínima que se puede mover de
//    archivo). El analizador da un nombre por declarador, así que una sentencia puede
//    tener VARIOS nombres: `let a = 1, b = 2;` son dos nombres y una sola sentencia.
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
  return { prop: l.property.name };
}
function nombresDe(n) {
  if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') return [n.id.name];
  if (n.type === 'VariableDeclaration') return n.declarations.flatMap((d) => nombresDePatron(d.id, []));
  const w = esAsignacionWindow(n);
  if (w) return ['window.' + w.prop];
  return ['(sentencia)@' + n.loc.start.line];
}

const items = [];
const conflictos = [];
for (const n of ast.body) {
  const nombres = nombresDe(n);
  const enPanel = nombres.filter((x) => lista.has(x));
  // Una sentencia no se puede partir: o va entera al panel o entera a app.js.
  if (enPanel.length && enPanel.length !== nombres.length) conflictos.push({ linea: n.loc.start.line, nombres, enPanel });
  items.push({ nombre: nombres[0], nombres, nodo: n, grupo: enPanel.length ? 'panel' : 'app' });
}
if (conflictos.length) {
  for (const c of conflictos) console.error(`CONFLICTO línea ${c.linea}: la sentencia declara ${c.nombres.join(', ')} y panel.json solo manda al panel ${c.enPanel.join(', ')}; decídelo entero en panel.json`);
  process.exit(1);
}
const esIdentificador = (x) => !x.startsWith('window.') && !x.startsWith('(sentencia)@');
const declaradas = new Map();
for (const i of items) for (const x of i.nombres) if (esIdentificador(x) && !declaradas.has(x)) declaradas.set(x, i);
const variables = new Set();
const kindDe = new Map(); // una `const` NO lleva setter: asignarle lanzaría en tiempo de ejecución.
for (const i of items) if (i.nodo.type === 'VariableDeclaration') for (const x of i.nombres) { variables.add(x); kindDe.set(x, i.nodo.kind); }

// 2. Referencias libres de un ítem a nombres de nivel superior del OTRO grupo.
function refs(item) {
  const out = [];
  walk.fullAncestor(item.nodo, (n, _s, anc) => {
    if (n.type !== 'Identifier') return;
    const p = anc[anc.length - 2]; if (!p) return;
    if (p.type === 'MemberExpression' && p.property === n && !p.computed) return;
    if (p.type === 'Property' && p.key === n && !p.computed) { if (!p.shorthand) return; }
    if (p.type === 'MethodDefinition' && p.key === n) return;
    if ((p.type === 'FunctionDeclaration' || p.type === 'FunctionExpression' || p.type === 'ArrowFunctionExpression') && (p.id === n || p.params.includes(n))) return;
    if (p.type === 'VariableDeclarator' && p.id === n) return;
    if (p.type === 'CatchClause' && p.param === n) return;
    const d = declaradas.get(n.name); if (!d || d.grupo === item.grupo || d === item) return;
    out.push({ nodo: n, nombre: n.name, corta: p.type === 'Property' && p.shorthand });
  });
  return out;
}

// 3. Reescrituras: en el panel, variables de app → N.x ; en app, funciones del panel → P.x
const cambios = [];        // { ini, fin, texto }
const usaN = new Set();    // funciones de app que el panel usa (se destructuran de N)
const varsN = new Set();   // variables de app que el panel usa (getters/setters)
const usaP = new Set();
const violaciones = [];
for (const it of items) {
  for (const r of refs(it)) {
    if (it.grupo === 'panel') {
      if (variables.has(r.nombre)) { varsN.add(r.nombre); cambios.push({ ini: r.nodo.range[0], fin: r.nodo.range[1], texto: r.corta ? `${r.nombre}: N.${r.nombre}` : `N.${r.nombre}` }); }
      else usaN.add(r.nombre);
    } else {
      if (variables.has(r.nombre)) { violaciones.push(`VIOLACIÓN: app.js usa la variable del panel ${r.nombre} (en ${it.nombre}); quítala de panel.json`); continue; }
      usaP.add(r.nombre); cambios.push({ ini: r.nodo.range[0], fin: r.nodo.range[1], texto: r.corta ? `${r.nombre}: P.${r.nombre}` : `P.${r.nombre}` });
    }
  }
}
if (violaciones.length) { for (const v of [...new Set(violaciones)]) console.error(v); process.exit(1); }
function aplicar(texto, lista_) { return lista_.sort((a, b) => b.ini - a.ini).reduce((t, c) => t.slice(0, c.ini) + c.texto + t.slice(c.fin), texto); }
const conCambios = aplicar(src, cambios);
// Los rangos de los ítems se recalculan tras aplicar: se vuelve a analizar.
const ast2 = acorn.parse(conCambios, { ecmaVersion: 'latest', sourceType: 'module', ranges: true });
// La comprobación va ANTES de indexar: si el AST cambió de forma, items[i] no corresponde.
if (ast2.body.length !== items.length) { console.error('el AST cambió de forma tras reescribir; abortar'); process.exit(1); }
// Los rangos de acorn NO incluyen los comentarios: cortar por ellos tira 649 líneas
// de comentario del monolito (las que explican por qué algo es como es). Cada ítem se
// lleva el hueco que tiene DELANTE, salvo lo que quede en la misma línea del ítem
// anterior (su comentario de cola). Así los dos archivos PARTEN el texto original: la
// concatenación de todos los trozos es el archivo entero, sin perder un byte.
const cortes = [0];
for (let i = 1; i < ast2.body.length; i++) {
  const desde = ast2.body[i - 1].range[1], hasta = ast2.body[i].range[0];
  const salto = conCambios.indexOf('\n', desde);
  cortes.push(salto !== -1 && salto < hasta ? salto + 1 : hasta);
}
cortes.push(conCambios.length);
const trozos = { app: [], panel: [] };
ast2.body.forEach((n, i) => { trozos[items[i].grupo].push(conCambios.slice(cortes[i], cortes[i + 1])); });

const puente = `\n// ── Puente con el panel (cambios/2026-09-19-partir-monolito) ─────────────────\n` +
  `export const N = {\n` + [...varsN].sort().map((v) => kindDe.get(v) === 'const'
    ? `  get ${v}() { return ${v}; },`
    : `  get ${v}() { return ${v}; }, set ${v}(valor) { ${v} = valor; },`).join('\n') + '\n' +
  [...usaN].sort().map((f) => `  ${f},`).join('\n') + '\n};\n' +
  `export let P = null;\nexport function cargarPanel() { return P ? Promise.resolve(P) : import('./panel.js').then((m) => (P = m)); }\n`;
// Los trozos ya traen sus propios saltos de línea: se pegan sin separador.
writeFileSync('src/app.js', trozos.app.join('') + '\n' + puente);
writeFileSync('src/panel.js', `import { N } from './app.js';\nconst { ${[...usaN].sort().join(', ')} } = N;\n\n` + trozos.panel.join('') + '\n\n' +
  `// Lo que app.js llama del panel\nexport { ${[...usaP].sort().join(', ')} };\n`);
console.log(`panel.js: ${trozos.panel.length} ítems · app.js: ${trozos.app.length} ítems · N: ${varsN.size} variables + ${usaN.size} funciones · P: ${usaP.size} funciones`);
