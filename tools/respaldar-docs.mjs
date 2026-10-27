#!/usr/bin/env node
// tools/respaldar-docs.mjs — Copia los documentos internos al repo PRIVADO.
//
// Los cuatro archivos viven en esta carpeta, que es donde Claude Code los lee,
// y están fuera del repositorio público a propósito. Hasta que existió el repo
// privado, existían SOLO en esta máquina: un disco que fallara se llevaba toda
// la memoria del proyecto.
//
// Uso:  node tools/respaldar-docs.mjs
//       node tools/respaldar-docs.mjs --revisar    (solo dice qué cambió)
//
// Correrlo al terminar una sesión de trabajo.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';

const ORIGEN  = 'C:\\Proyectos\\crunchy-paps';
// Desde el 15 sep 2026 el clon del repo privado vive DENTRO del proyecto
// (decisión de Abraham: «todo debe vivir en crunchy-paps»). Está en el
// .gitignore del repo público; el guardia de abajo comprueba además que el
// remoto sea crunchy-paps-docs antes de escribir.
const DESTINO = 'C:\\Proyectos\\crunchy-paps\\crunchy-paps-docs';
const FIJOS   = ['.claude/settings.json', 'PLAN.md', 'PROGRESO.md', 'ACCESOS.md', 'DESPLIEGUE.md', 'CLAUDE.md',
                 // Nacidos de la poda de CLAUDE.md del 15 sep 2026.
                 'HISTORIA.md', 'REGLAS.md', 'ARQUITECTURA.md'];

// `cambios/` es una CARPETA que crece: un archivo por cambio (PLAN.md §1.5).
// Se recorre en vez de enumerarse, porque una lista fija habría que acordarse de
// actualizar en cada cambio nuevo — y lo que hay que acordarse de hacer, no se
// hace. Si la carpeta no existe todavía, no pasa nada.
//
// `supabase/auditorias/` se añadió el 6 sep 2026 por la misma razón: la primera
// auditoría dejó su SQL y sus CSV de resultados —con nombres de clientes— fuera
// del repo público (bien) y también fuera del respaldo (mal), o sea existiendo
// solo en este disco, que es exactamente lo que este guion vino a evitar.
// 26 sep 2026: `.claude/agents/` pasa de archivo fijo a carpeta recorrida. Estaba
// enumerado `altas-b2b.md` a mano y `devoluciones-puntos.md` llevaba dias sin
// respaldarse: justo el fallo contra el que advierte el comentario de arriba. Un
// subagente nuevo ya entra solo. `.claude/settings.json` se sumo a FIJOS el mismo
// dia, por lo mismo: vivia solo en este disco.
// 6 oct 2026: `cambios/` pasa de `.md` a incluir `.xlsx` y `.py`. El modelo de
// capacidad de rutas (`2026-10-06-rutas-y-cierre/modelo-rutas.xlsx`) y el guion
// que lo genera son la base de una decisión de contratación, y se quedaban
// FUERA del respaldo por la extensión: vivían en un solo disco. Es la misma
// cicatriz del 6 sep con las auditorías y la del 26 sep con los subagentes —
// tercera vez que el filtro deja fuera justo lo que no está en ninguna otra
// parte. El `.py` importa más que el `.xlsx`: regenera el libro entero.
const CARPETAS = [
  { ruta: 'cambios',              ext: ['.md', '.xlsx', '.py'] },
  { ruta: 'supabase/auditorias',  ext: ['.sql', '.csv'] },
  { ruta: '.claude/agents',       ext: ['.md'] },
  // 24 sep 2026: el mapa visual de la app. Vive en docs/mapa/, fuera del repo
  // (el repo es PÚBLICO y el mapa lleva la matriz de permisos de producción y
  // los pendientes de seguridad). El espejo privado es el ÚNICO respaldo que
  // tiene: si se borra la carpeta local, no está en ninguna otra parte.
  { ruta: 'docs/mapa',            ext: ['.html', '.js', '.png'] },
  // 25 oct 2026: la transcripción del cuaderno de producción (ene–jul 2026).
  // Fuera del repo porque lleva nombres de clientes y el repo es PÚBLICO.
  // CUARTA vez que este filtro deja fuera justo lo que no está en ninguna otra
  // parte — tras las auditorías (6 sep), los subagentes (26 sep) y el .xlsx de
  // rutas (6 oct). Aquí el costo de perderlo es releer 58 fotos a mano: el
  // documento de `cambios/` CUENTA el trabajo, pero no lo contiene.
  // El patrón se repite porque el filtro es una lista blanca y lo nuevo nace
  // fuera de ella: al crear una carpeta que no va al repo, añadirla AQUÍ el
  // mismo día, no cuando se eche de menos.
  // `.mjs` y `.sql` van EXPLÍCITOS: las extensiones extra de abajo solo se
  // aplican a subcarpetas, así que un guion en la RAÍZ de la carpeta se caía
  // en silencio. Y aquí los guiones importan más que los datos — regeneran la
  // carga entera, igual que el `.py` del 6 oct regenera su libro.
  { ruta: 'historico',            ext: ['.md', '.json', '.ndjson', '.csv', '.mjs', '.sql', '.xlsx', '.py'] },
  // 25 oct 2026: la direccion de diseno. `material/Design_reference/DIRECCION-DE-DISENO.md`
  // son 215 lineas de criterio propio escritas el 23 sep, y llevaban un mes existiendo
  // SOLO en este disco: la carpeta nunca entro en esta lista. QUINTA vez el mismo fallo
  // (auditorias 6 sep, subagentes 26 sep, .xlsx de rutas 6 oct, historico/ hoy mismo).
  // Solo .md a proposito: los .webp son capturas de una app ajena y se pueden volver a
  // tomar; el razonamiento que sale de ellas, no.
  { ruta: 'material/Design_reference', ext: ['.md'] },
  // 26 oct 2026: la recuperacion de la cuenta de Instagram. `Instagram/` nacio hoy,
  // fuera del repo porque lleva correos y telefonos personales de terceros. SEXTA vez
  // el mismo fallo en puertas (auditorias 6 sep, subagentes 26 sep, .xlsx de rutas
  // 6 oct, historico/ y Design_reference/ el 25 oct) — pero esta vez la carpeta se
  // anade AQUI el mismo dia que nace, que es lo que el comentario de arriba pide y
  // las cinco veces anteriores no se hizo. Lo que contiene no esta en ninguna otra
  // parte: que perfil colgaba de que centro de cuentas, y por que cada codigo de 2FA
  // salio rechazado.
  { ruta: 'Instagram',            ext: ['.md'] },
];

// Un PNG no tiene líneas. Contarlas daba números sin sentido en el informe
// («+48213 líneas» para una captura), así que los binarios se miden en KB.
const BINARIOS = ['.png', '.jpg', '.webp', '.pdf'];
const esBinario = (ruta) => BINARIOS.some((e) => ruta.endsWith(e));

// 13 sep 2026: cada cambio puede traer una subcarpeta con sus parches, guiones
// y SQL (cambios/2026-09-13-precio-por-caja/…). Se recorre un nivel más, con
// las mismas extensiones más .mjs, .sh y .sql, que es lo que hay ahí.
const listarCarpeta = ({ ruta, ext }) => {
  const dir = join(ORIGEN, ruta);
  if (!existsSync(dir)) return [];
  const extSub = [...ext, '.mjs', '.sh', '.sql', '.txt'];
  // Recursivo desde el 15 sep 2026: cambios/<cambio>/<subcarpeta>/ existía
  // (la copia de la sesión alterna) y el respaldo la saltaba en silencio.
  const recorrer = (rel) => readdirSync(join(ORIGEN, rel), { withFileTypes: true })
    .flatMap((d) => d.isDirectory()
      ? recorrer(`${rel}/${d.name}`)
      : (extSub.some((e) => d.name.endsWith(e)) ? [`${rel}/${d.name}`] : []));
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => {
      if (d.isDirectory()) return recorrer(`${ruta}/${d.name}`);
      return ext.some((e) => d.name.endsWith(e)) ? [`${ruta}/${d.name}`] : [];
    })
    .sort();
};

const DOCS = [...FIJOS, ...CARPETAS.flatMap(listarCarpeta)];

const soloRevisar = process.argv.includes('--revisar');

if (!existsSync(DESTINO)) {
  console.error(`No existe ${DESTINO}.`);
  console.error('Clónalo primero:  git clone https://github.com/abr-m-m/crunchy-paps-docs.git');
  process.exit(1);
}

const git = (...args) =>
  execFileSync('git', args, { cwd: DESTINO, encoding: 'utf8' }).trim();

// Salvaguarda: si el repo de destino no fuera privado, esto publicaría el
// inventario de seguridad y la bitácora de vulnerabilidades.
try {
  const url = git('remote', 'get-url', 'origin');
  if (!url.includes('crunchy-paps-docs')) {
    console.error('ABORTADO: el remoto de destino no es crunchy-paps-docs.');
    console.error('  ' + url);
    process.exit(1);
  }
} catch {
  console.error('ABORTADO: el destino no tiene remoto configurado.');
  process.exit(1);
}

let copiados = 0;
const cambios = [];
for (const doc of DOCS) {
  const origen = join(ORIGEN, doc);
  if (!existsSync(origen)) { console.log(`  ${doc.padEnd(42)} no está en el origen, se omite`); continue; }
  const nuevo = readFileSync(origen);
  const destino = join(DESTINO, doc);
  const viejo = existsSync(destino) ? readFileSync(destino) : null;
  if (viejo && viejo.equals(nuevo)) { console.log(`  ${doc.padEnd(42)} sin cambios`); continue; }
  let delta;
  if (esBinario(doc)) {
    const kb = (n) => Math.round(n / 1024) + ' KB';
    delta = viejo ? `${kb(viejo.length)} → ${kb(nuevo.length)}` : `nuevo (${kb(nuevo.length)})`;
  } else {
    const lineas = nuevo.toString('utf8').split('\n').length;
    const antes  = viejo ? viejo.toString('utf8').split('\n').length : 0;
    // "nuevo líneas" se leía mal en la salida; un archivo que no existía antes
    // dice cuántas trae, no cuántas cambió.
    delta = viejo ? (lineas - antes >= 0 ? '+' : '') + (lineas - antes) + ' líneas'
                  : `nuevo (${lineas} líneas)`;
  }
  cambios.push(`${doc} (${delta})`);
  console.log(`  ${doc.padEnd(42)} ${delta}`);
  if (!soloRevisar) { mkdirSync(dirname(destino), { recursive: true }); writeFileSync(destino, nuevo); copiados++; }
}

if (!cambios.length) { console.log('\n  Todo al día. Nada que respaldar.'); process.exit(0); }
if (soloRevisar)     { console.log(`\n  ${cambios.length} archivo(s) cambiarían. Corre sin --revisar para subirlos.`); process.exit(0); }

git('add', '-A');
// Fecha LOCAL (CDMX), no UTC. `toISOString()` fechaba los respaldos hechos de
// noche en el día siguiente: así nacieron los "Respaldo 2026-09-02" de commits
// del 1 de septiembre, y de ahí los encabezados equivocados de PROGRESO.md.
const d = new Date();
const fecha = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
git('-c', 'user.email=abraham.mmora@gmail.com', '-c', 'user.name=Abraham',
    'commit', '-q', '-m', `Respaldo ${fecha}: ${cambios.join(', ')}`);
execFileSync('git', ['push', '-q'], { cwd: DESTINO, stdio: 'inherit' });

console.log(`\n  ${copiados} archivo(s) respaldados y subidos a crunchy-paps-docs (privado).`);
