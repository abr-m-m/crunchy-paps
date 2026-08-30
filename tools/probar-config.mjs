#!/usr/bin/env node
// tools/probar-config.mjs — Prueba la resolución de configuración por entorno
// que vive en index.html (Fase 1c). Extrae el bloque real del archivo y lo
// ejecuta con un window/location simulados, para verificar que:
//
//   1. Producción sigue funcionando aunque /api/config.js no cargue.
//   2. Un preview con config de staging usa staging.
//   3. Un preview SIN config no adivina: se queda sin base y avisa.
//   4. Un preview al que le pasen la base de PRODUCCIÓN se bloquea en seco.
//
// El punto 4 es el hallazgo 16: es la prueba de que un entorno de pruebas ya
// no puede escribir sobre datos de clientes reales.
//
// Uso:  node tools/probar-config.mjs [ruta/al/index.html]

import { readFileSync } from 'node:fs';

const archivo = process.argv[2] || 'index.html';
const src = readFileSync(archivo, 'utf8');

const inicio = src.indexOf('const CP_PROD_URL');
const finMarca = 'window.CP_ENTORNO =';
const fin = src.indexOf('\n', src.indexOf(finMarca));
if (inicio === -1 || fin === -1) {
  console.error('No encontré el bloque de configuración en ' + archivo);
  process.exit(1);
}
const bloque = src.slice(inicio, fin);

const URL_PROD = 'https://xbyzarzyxiugrucyjwfn.supabase.co';
const URL_STG = 'https://dkwatbsaidlfjqjnfyrk.supabase.co';

function correr({ hostname, config, almacen }) {
  const errores = [];
  const win = { __CP_CONFIG__: config };
  const ctx = {
    window: win,
    location: { hostname },
    localStorage: {
      getItem: (k) => (almacen && almacen[k]) || null
    },
    console: { error: (m) => errores.push(String(m)) }
  };
  let lanzo = null;
  try {
    const fn = new Function('window', 'location', 'localStorage', 'console',
      bloque + '\nreturn { url: SUPABASE_URL, key: SUPABASE_ANON_KEY, entorno: window.CP_ENTORNO };');
    const r = fn(ctx.window, ctx.location, ctx.localStorage, ctx.console);
    return { ...r, errores, lanzo };
  } catch (e) {
    lanzo = e.message;
    return { url: null, key: null, entorno: null, errores, lanzo };
  }
}

const casos = [
  {
    nombre: '1. Producción sin /api/config.js (endpoint caído)',
    entrada: { hostname: 'crunchypaps.mx', config: undefined },
    esperado: (r) => r.url === URL_PROD && !!r.key && !r.lanzo,
    porque: 'la tienda real nunca debe caerse por un fallo del endpoint de config'
  },
  {
    nombre: '2. Producción con config correcta',
    entrada: { hostname: 'crunchypaps.mx', config: { ENTORNO: 'production', SUPABASE_URL: URL_PROD, SUPABASE_ANON_KEY: 'anon-prod' } },
    esperado: (r) => r.url === URL_PROD && r.entorno === 'produccion' && !r.lanzo,
    porque: 'camino normal de producción'
  },
  {
    nombre: '3. Preview con config de staging',
    entrada: { hostname: 'rama-x-abc.vercel.app', config: { ENTORNO: 'preview', SUPABASE_URL: URL_STG, SUPABASE_ANON_KEY: 'anon-stg' } },
    esperado: (r) => r.url === URL_STG && !r.lanzo,
    porque: 'un preview debe hablar con staging'
  },
  {
    nombre: '4. Preview SIN config (no debe adivinar)',
    entrada: { hostname: 'rama-x-abc.vercel.app', config: undefined },
    esperado: (r) => r.url === '' && r.errores.some((e) => e.includes('Sin configuración')),
    porque: 'sin config no se elige base: se avisa, no se adivina'
  },
  {
    nombre: '5. Preview apuntado a PRODUCCIÓN (hallazgo 16)',
    entrada: { hostname: 'rama-x-abc.vercel.app', config: { ENTORNO: 'preview', SUPABASE_URL: URL_PROD, SUPABASE_ANON_KEY: 'anon-prod' } },
    esperado: (r) => !!r.lanzo && r.errores.some((e) => e.includes('BLOQUEADO')),
    porque: 'DEBE bloquearse: es exactamente el bug que estamos cerrando'
  },
  {
    nombre: '6. Local con override de localStorage',
    entrada: { hostname: 'localhost', config: undefined, almacen: { cp_supabase_url: URL_STG, cp_supabase_anon: 'anon-stg' } },
    esperado: (r) => r.url === URL_STG && !r.lanzo,
    porque: 'desarrollo local sin vercel dev'
  }
];

console.log('\nProbando la configuración por entorno de ' + archivo + '\n');
let fallos = 0;
for (const c of casos) {
  const r = correr(c.entrada);
  const paso = c.esperado(r);
  if (!paso) fallos++;
  console.log(`  ${paso ? 'ok   ' : 'FALLA'} ${c.nombre}`);
  console.log(`         ${c.porque}`);
  console.log(`         url=${JSON.stringify(r.url)} entorno=${JSON.stringify(r.entorno)}` +
              (r.lanzo ? ` lanzó="${r.lanzo}"` : ''));
}
console.log(fallos ? `\n${fallos} caso(s) fallando.\n` : '\nLos 6 casos pasan.\n');
process.exit(fallos ? 1 : 0);
