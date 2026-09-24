#!/usr/bin/env node
// tools/mapa-permisos.mjs — genera docs/mapa/datos/permisos.js desde PRODUCCIÓN. Solo LEE.
// La matriz de permisos es la parte del mapa que más deriva. Generada no puede mentir — pero
// solo si modela la función que decide de verdad: ver la CORRECCIÓN del 23 sep, más abajo.
// La lista personal sustituye a la del rol SALVO para los roles dueño, que lo ven todo.
// El catálogo de secciones sale de NAV_ITEM_POR_SECCION y NO de las listas, porque una sección
// que no está en ninguna lista (hoy `resumen`) tiene que salir igualmente, marcada como muerta.
// Uso: node tools/mapa-permisos.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROD = 'xbyzarzyxiugrucyjwfn';
const dir = mkdtempSync(join(tmpdir(), 'mapa-permisos-'));
const sql = (q) => {
  const f = join(dir, 'q.sql'); writeFileSync(f, q);
  const out = execSync(`supabase db query --linked --project-ref ${PROD} -o json --file "${f}"`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const i = out.indexOf('{');
  return i < 0 ? [] : (JSON.parse(out.slice(i)).rows || []);
};

const app = readFileSync('src/app.js', 'utf8');
const bloque = app.match(/const NAV_ITEM_POR_SECCION = \{([\s\S]*?)\n\};/);
if (!bloque) { console.error('No se encontró NAV_ITEM_POR_SECCION en src/app.js'); process.exit(1); }
const catalogo = [...bloque[1].matchAll(/^\s*([a-z0-9]+)\s*:/gm)].map(m => m[1]);

const roles = sql(`select lower(rol) rol, coalesce(secciones,'{}') secciones from config_secciones order by 1`);
const usuarios = sql(`select id, nombre, lower(trim(rol)) rol, secciones from vendedores order by id`);
rmSync(dir, { recursive: true, force: true });

const porRol = Object.fromEntries(roles.map(r => [r.rol, r.secciones]));
const tienePropia = (u) => Array.isArray(u.secciones) && u.secciones.length > 0;

// CORRECCIÓN DEL 23 SEP 2026. Esta matriz decía que el rol administrador no podía abrir
// Ruta, Reparto ni Resumen, y era FALSO: se había copiado la lógica de
// `get_secciones_usuario`, que es la función VIEJA (la que recibía idVendedor y devolvía la
// lista personal a secas; src/app.js:5197 explica por qué se sustituyó). Quien decide de
// verdad es `sesion_secciones`, que usan `mis_secciones` —la que pinta la barra— y
// `sesion_exige_seccion` —la que cierra cada RPC—, y ESA abre con:
//     roles_dueno constant text[] := array['admin', 'administrador'];
//     if v_rol_l = any(roles_dueno) then return todas; end if;
// antes de mirar el override individual. Un dueño lo ve todo, tenga la lista personal que
// tenga. Regla 4: copiar el código solo demuestra que la copia funciona — y aquí ni siquiera
// se copió el código bueno. Se modela `sesion_secciones`, y solo esa.
const ROLES_DUENO = ['admin', 'administrador'];   // EXACTOS: 'administrador2' NO está
const resolver = (u) => {
  if (ROLES_DUENO.includes(u.rol)) return { fuente: 'dueño', secciones: catalogo };
  if (tienePropia(u))              return { fuente: 'individual', secciones: u.secciones };
  const base = porRol[u.rol] || ['catalogo', 'pedidos', 'cuenta'];   // mínimo seguro
  return { fuente: 'rol', secciones: base };
};
const efectivo = usuarios.map(u => {
  const r = resolver(u);
  // Mostrador recibe productos y cupones por añadido, no por lista (sesion_secciones lo hace
  // con array_append al final, y la interfaz repite el mismo añadido).
  const secciones = u.rol === 'mostrador'
    ? [...r.secciones, ...['productos', 'cupones'].filter(s => !r.secciones.includes(s))]
    : r.secciones;
  // Qué le da su rol que su lista personal no tiene. Es lo que habría cazado el desfase el
  // mismo día en vez de una semana después: las migraciones que reparten secciones nuevas
  // actualizan `vendedores` filtrando por rol, y a quien no case se le queda la lista vieja.
  const desfase = tienePropia(u) && !ROLES_DUENO.includes(u.rol)
    ? (porRol[u.rol] || []).filter(s => !u.secciones.includes(s)) : [];
  return { id: u.id, nombre: u.nombre, rol: u.rol, fuente: r.fuente, secciones, desfase };
});

const alcance = Object.fromEntries(
  catalogo.map(s => [s, efectivo.filter(u => u.secciones.includes(s)).map(u => u.nombre)]));
const muertas = catalogo.filter(s => alcance[s].length === 0);

// Fecha LOCAL (CDMX), no UTC. `toISOString()` corriendo de noche fecha el mapa
// en el día siguiente: esta misma herramienta, corrida a las 23:19 del 23 sep
// 2026, escribió «generado: 2026-09-24», y de ahí se copiaron a mano 15 fechas
// equivocadas a los datos. Es exactamente el fallo que ya tenía su cicatriz en
// tools/respaldar-docs.mjs (los «Respaldo 2026-09-02» de commits del 1 sep):
// regla 59, aplicar el arreglo en un sitio y olvidarlo en el de al lado.
const d = new Date();
const hoy = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const datos = { generado: hoy, catalogo, porRol, efectivo, alcance, muertas };
writeFileSync('docs/mapa/datos/permisos.js',
  `window.MAPA = window.MAPA || {};\nwindow.MAPA.permisos = ${JSON.stringify(datos, null, 2)};\n`);

console.log(`docs/mapa/datos/permisos.js — ${roles.length} roles, ${efectivo.length} usuarios, ${catalogo.length} secciones`);
console.log(muertas.length
  ? `  SIN NADIE QUE LAS ABRA: ${muertas.join(', ')}`
  : '  todas las secciones tienen a alguien');
