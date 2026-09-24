#!/usr/bin/env node
// tools/mapa-permisos.mjs — genera docs/mapa/datos/permisos.js desde PRODUCCIÓN. Solo LEE.
// La matriz de permisos es la parte del mapa que más deriva. Escrita a mano diría que el rol
// administrador ve Armado, Caja, Ruta y Reparto — y no los ve: su lista personal SUSTITUYE a la
// del rol (20260830203059_remote_schema.sql:1740). Generada no puede mentir.
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
const efectivo = usuarios.map(u => ({
  id: u.id, nombre: u.nombre, rol: u.rol,
  fuente: tienePropia(u) ? 'individual' : 'rol',
  secciones: tienePropia(u) ? u.secciones : (porRol[u.rol] || []),
}));

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
