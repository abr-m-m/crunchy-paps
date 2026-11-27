// ============================================================================
//  Probar el respaldo de producción — RESTAURÁNDOLO de verdad
//
//  «Un respaldo nunca restaurado es una hipótesis.» Lo dice PLAN.md §P2 desde
//  septiembre y hasta el 26 nov 2026 no se había hecho ni una vez.
//
//  Esto hace el ciclo entero, sin tocar producción más que para LEER:
//
//    1. vuelca el esquema y los datos de producción a `respaldos/`
//    2. levanta un Postgres desechable en Docker
//    3. restaura los dos volcados ahí dentro
//    4. CUENTA las filas de las tablas que importan en los dos lados
//    5. corre una función de negocio sobre el restaurado y compara el valor
//    6. tira el contenedor
//
//  Sale con código 1 si algo no cuadra, para que no pueda pasar inadvertido.
//
//  LO QUE NO PRUEBA, y conviene tenerlo claro: prueba el volcado LÓGICO, que
//  es la copia que controlamos nosotros. Los respaldos FÍSICOS diarios de
//  Supabase (`supabase backups list`) son otra cosa y solo se restauran desde
//  su tablero, sobre el propio proyecto; eso no se ensaya contra producción.
//
//    node tools/probar-respaldo.mjs
//    node tools/probar-respaldo.mjs --sin-volcar   (reusa el volcado de hoy)
// ============================================================================
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const REF = 'xbyzarzyxiugrucyjwfn';          // producción
const RAIZ = path.resolve(import.meta.dirname, '..');
const DIR = path.join(RAIZ, 'respaldos');
const HOY = new Date().toISOString().slice(0, 10);
const ESQ = path.join(DIR, `prod-esquema-${HOY}.sql`);
const DAT = path.join(DIR, `prod-datos-${HOY}.sql`);
const CAJA = 'cp-probar-respaldo';
const SIN_VOLCAR = process.argv.includes('--sin-volcar');

// Las tablas que, si se perdieran, se habría perdido el negocio.
const TABLAS = ['clientes', 'prospectos', 'ordenes', 'ordenes_detalle', 'productos',
                'caja_movimientos', 'lealtad_movimientos', 'promociones',
                'lotes_produccion', 'gastos'];

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });

function sql(consulta) {
  const salida = sh('supabase', ['db', 'query', '--linked', '--project-ref', REF, consulta]);
  const i = salida.indexOf('{'), j = salida.lastIndexOf('}');
  if (i < 0) return [];
  try { return JSON.parse(salida.slice(i, j + 1)).rows || []; } catch { return []; }
}

const docker = (args, entrada) =>
  execFileSync('docker', args, { encoding: 'utf8', input: entrada, maxBuffer: 1 << 28 });

function psql(consulta) {
  return docker(['exec', CAJA, 'psql', '-U', 'postgres', '-d', 'restaurado',
                 '-t', '-A', '-F', '|', '-c', consulta]).trim();
}

let fallos = 0;
const mal = (t) => { fallos++; console.log('  FALLA  ' + t); };

console.log('\n  PROBAR EL RESPALDO DE PRODUCCIÓN\n');

// ── 1. Volcar ───────────────────────────────────────────────────────────────
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
if (SIN_VOLCAR && existsSync(ESQ) && existsSync(DAT)) {
  console.log('  ok     reusando el volcado de hoy (--sin-volcar)');
} else {
  sh('supabase', ['db', 'dump', '--linked', '--project-ref', REF, '-f', ESQ]);
  sh('supabase', ['db', 'dump', '--linked', '--project-ref', REF, '--data-only', '--use-copy', '-f', DAT]);
  console.log('  ok     volcado de producción hecho');
}

// ── 2. Un Postgres desechable ───────────────────────────────────────────────
try { docker(['rm', '-f', CAJA]); } catch { /* no existía */ }
docker(['run', '-d', '--name', CAJA, '-e', 'POSTGRES_PASSWORD=prueba',
        '-e', 'POSTGRES_DB=restaurado', 'postgres:17']);
let listo = false;
for (let i = 0; i < 40; i++) {
  try { docker(['exec', CAJA, 'pg_isready', '-U', 'postgres']); listo = true; break; }
  catch { execSync('timeout /t 2 /nobreak >nul 2>&1 || sleep 2', { shell: true }); }
}
if (!listo) { mal('el Postgres de prueba no arrancó'); process.exit(1); }
console.log('  ok     Postgres desechable en pie');

// Los roles que el volcado nombra. Sin esto, cada GRANT falla.
docker(['exec', '-i', CAJA, 'psql', '-U', 'postgres', '-d', 'restaurado', '-q'],
  ['anon', 'authenticated', 'service_role', 'supabase_auth_admin', 'supabase_storage_admin',
   'authenticator', 'dashboard_user', 'supabase_read_only_user', 'pgbouncer']
    .map((r) => `create role ${r} nologin;`).join('\n') +
  '\ncreate role supabase_admin superuser login;\ncreate schema if not exists auth;\n' +
  'create extension if not exists pgcrypto;\n');

// ── 3. Restaurar ────────────────────────────────────────────────────────────
// Los errores por extensiones de Supabase (pg_cron, pg_net, supabase_vault) son
// ESPERADOS en un Postgres normal y no son pérdida de datos: se cuentan aparte.
const restaurar = (archivo) => {
  // psql escribe los errores en STDERR y con el prefijo `psql:FICHERO:LINEA:`.
  // La primera version de esto miraba solo stdout y buscaba `^ERROR:`, asi que
  // conto CERO errores mientras la pantalla los estaba mostrando. Una
  // comprobacion que no mira donde salen los fallos no comprueba (regla 31).
  // Y hay que usar spawnSync, no execFileSync: este ultimo solo devuelve
  // stderr cuando el comando FALLA, y psql con ON_ERROR_STOP=0 termina en 0
  // aunque haya escupido cien errores. Dos intentos tardo esto en contar de
  // verdad, y los dos decian «0 errores» con los errores en pantalla.
  const r = spawnSync('docker',
    ['exec', '-i', CAJA, 'psql', '-U', 'postgres', '-d', 'restaurado',
     '-v', 'ON_ERROR_STOP=0', '-q', '-f', '/dev/stdin'],
    { encoding: 'utf8', maxBuffer: 1 << 28,
      input: execSync(`type "${archivo}"`, { encoding: 'utf8', maxBuffer: 1 << 28 }) });
  const salida = String(r.stdout || '') + String(r.stderr || '');
  return (salida.match(/^.*ERROR: .*/gm) || []);
};
const errEsq = restaurar(ESQ);
const errDat = restaurar(DAT);
// Lo que falla SIEMPRE al restaurar un volcado de Supabase en un Postgres
// normal, y no es perdida de datos: sus extensiones propias y los esquemas que
// monta su plataforma (`auth`, `supabase_functions`, `extensions`).
const PLATAFORMA = /pg_cron|pg_net|supabase_vault|supabase_functions|supabase_realtime|"extensions"|"auth"|"storage"|"graphql"|"realtime"|publication |"auth\.|"supabase_functions\.|relation "auth|relation "supabase_functions|relation "storage/;
const esperado = (e) => PLATAFORMA.test(e);
const inesperados = [...errEsq, ...errDat].filter((e) => !esperado(e));
console.log(`  ok     restaurado · ${errEsq.length + errDat.length} error(es) de la PLATAFORMA de Supabase ` +
            `(auth, storage, realtime, pg_cron…), ${inesperados.length} inesperado(s)`);
// Esos errores NO son perdida de datos del negocio: son los esquemas que monta
// Supabase y que un Postgres normal no tiene. Para un desastre de verdad se
// restaura en un proyecto Supabase NUEVO, donde si existen. Lo que esta prueba
// demuestra es que el esquema propio, los datos y las funciones sobreviven.
for (const e of inesperados.slice(0, 5)) console.log('         ' + e.trim());
if (inesperados.length) mal('hubo errores que no son de extensiones de Supabase');

// ── 4. Contar los dos lados ─────────────────────────────────────────────────
const union = (t) => t.map((x) => `select '${x}' as t, count(*) as n from public.${x}`).join(' union all ');
const prod = {}; for (const r of sql(`select concat_ws('|', t, n) as v from (${union(TABLAS)}) q`)) {
  const [t, n] = String(r.v).split('|'); prod[t] = n;
}
const rest = {}; for (const l of psql(union(TABLAS)).split('\n')) {
  const [t, n] = l.split('|'); if (t) rest[t.trim()] = (n || '').trim();
}
console.log('\n  ' + 'tabla'.padEnd(22) + 'producción'.padStart(12) + 'restaurado'.padStart(12));
for (const t of TABLAS) {
  const ok = prod[t] !== undefined && prod[t] === rest[t];
  console.log('  ' + t.padEnd(22) + String(prod[t] ?? '?').padStart(12) +
              String(rest[t] ?? '?').padStart(12) + (ok ? '  ok' : '  <<< NO CUADRA'));
  if (!ok) fallos++;
}

// ── 5. Que ademas FUNCIONE, no solo que esté ────────────────────────────────
const vProd = sql("select round(public.costo_sku(1, current_date), 2)::text as v")[0]?.v;
const vRest = psql('select round(public.costo_sku(1, current_date), 2)::text');
console.log(`\n  costo_sku(1): producción ${vProd} · restaurado ${vRest}  ` +
            (vProd === vRest ? 'ok' : '<<< NO CUADRA'));
if (vProd !== vRest) mal('una función de negocio da distinto sobre el restaurado');

// ── 6. Tirar el contenedor ──────────────────────────────────────────────────
docker(['rm', '-f', CAJA]);
console.log('\n  ' + (fallos ? `${fallos} FALLO(S) — el respaldo NO está probado` : 'El respaldo se restaura y cuadra.') + '\n');
process.exit(fallos ? 1 : 0);
