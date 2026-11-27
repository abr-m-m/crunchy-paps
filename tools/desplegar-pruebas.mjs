#!/usr/bin/env node
// Despliega la app de PRUEBAS (crunchy-staging.vercel.app) — 27 nov 2026
//
// POR QUE EXISTE. El proyecto de pruebas estuvo conectado al repositorio para
// que se desplegara solo con cada push. Duro una hora: en cuanto hubo DOS
// proyectos de Vercel colgados del mismo repositorio, `vercel[bot]` dejo de
// crear despliegues para CUALQUIERA de los dos —GitHub no registro ninguno
// para el push de las 15:4x, habiendolos registrado para los tres anteriores—.
// Se desconecto el de pruebas y produccion vuelve a desplegarse sola; el de
// pruebas se sube con esto.
//
// POR QUE NO `vercel --prod` A SECAS. El CLI sube EL DIRECTORIO, y en esta
// carpeta vive `respaldos/`, que esta fuera del repositorio porque contiene
// 1,122 telefonos de clientes reales. Un despliegue descuidado los publicaria.
// Aqui se arma primero un arbol con `git archive`, que por definicion solo
// contiene lo que esta en el repositorio, y se sube ESE.
//
//   node tools/desplegar-pruebas.mjs            (lo que hay en HEAD)
//   node tools/desplegar-pruebas.mjs --sucio    (incluye cambios sin commitear)

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const RAIZ = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const SUCIO = process.argv.includes('--sucio');

// El id del proyecto de PRUEBAS. Escrito aqui a proposito: el `.vercel/` de la
// carpeta apunta al proyecto BUENO, y confundirlos seria publicar la app de
// pruebas encima de crunchypaps.mx.
const PROYECTO = 'prj_q3xuyqi3GufCQITF1Ai7HcjBagsL';
const EQUIPO   = 'team_J9qCZ1UACTkQbM8mhD0PQASM';
const PROD     = 'prj_0iSPaD8bQvo7UOBHdb7Wex2XKd0H';

if (PROYECTO === PROD) {
  console.error('El id de pruebas es el de produccion. No se despliega nada.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'cp-pruebas-'));
try {
  mkdirSync(join(dir, '.vercel'), { recursive: true });
  writeFileSync(join(dir, '.vercel', 'project.json'),
    JSON.stringify({ projectId: PROYECTO, orgId: EQUIPO, projectName: 'crunchy-staging' }));

  // Se copia lo que `git ls-files` LISTA, leido del arbol de trabajo. Nada de
  // `git archive | tar`: en Windows, tar lee «C:\...» como si fuera una maquina
  // remota y contesta «Cannot connect to C: resolve failed».
  //
  // La lista es la garantia, no el metodo de copia: `git ls-files` solo nombra
  // lo que esta en el repositorio, asi que `respaldos/` -1,122 telefonos
  // reales, fuera del repo a proposito- no puede colarse.
  const lista = execFileSync('git', ['-C', RAIZ, 'ls-files'], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  let copiados = 0;
  for (const f of lista) {
    const origen = join(RAIZ, f);
    if (!existsSync(origen)) continue;      // borrado y sin commitear
    const destino = join(dir, f);
    mkdirSync(join(destino, '..'), { recursive: true });
    writeFileSync(destino, readFileSync(origen));
    copiados++;
  }

  // Se dice en voz alta si va algo sin commitear: la app de pruebas tiene que
  // enseñar lo que va a haber en la buena, y un despliegue con cambios sueltos
  // enseña otra cosa.
  const sucio = execFileSync('git', ['-C', RAIZ, 'status', '--porcelain'], { encoding: 'utf8' })
    .split('\n').filter((l) => l.trim() && !l.startsWith('??'));
  if (sucio.length && !SUCIO) {
    console.error('Hay ' + sucio.length + ' archivo(s) sin commitear. Se suben igual, pero');
    console.error('la app de pruebas dejara de coincidir con lo que hay en main.');
    console.error('Commitea antes, o pasa --sucio si es lo que quieres.');
    process.exit(1);
  }
  console.log(copiados + ' archivos del repositorio' + (sucio.length ? ' (con cambios sin commitear)' : ''));

  // Red de seguridad, no confianza: si algo cuela una carpeta que no debe
  // salir, se para aqui en vez de publicarla.
  for (const prohibido of ['respaldos', 'cambios', 'material', 'mapa-trabajo', 'docs', '.env.push', '.env.local']) {
    if (existsSync(join(dir, prohibido))) {
      console.error('ALTO: «' + prohibido + '» acabo en el arbol a subir. No se despliega.');
      process.exit(1);
    }
  }

  console.log('Subiendo a la app de pruebas…');
  // Un solo string y `shell: true`: en Windows `vercel` es un .cmd y sin shell
  // no arranca. Pasar ademas un array de argumentos con shell encendido levanta
  // un aviso de Node porque no se escapan; aqui no hay nada que escapar -los
  // tres argumentos son constantes- pero se escribe asi para no dejar el aviso.
  const r = spawnSync('vercel deploy --prod --yes', { cwd: dir, encoding: 'utf8', shell: true });
  const salida = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0) {
    console.error(salida.slice(-1200));
    process.exit(1);
  }
  console.log('Listo: https://crunchy-staging.vercel.app');
} finally {
  // Windows suele tener el directorio tomado un instante despues de que el CLI
  // termina. Se reintenta, y si aun asi no se puede, se dice y se sigue: una
  // carpeta olvidada en el temporal del sistema no vale un error de salida
  // cuando el despliegue ya salio bien.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    console.log('(no se pudo borrar ' + dir + ': ' + e.code + '. Lo limpia el sistema.)');
  }
}
