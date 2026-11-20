#!/usr/bin/env node
// tools/demo-contador.mjs — ver al contador correr, con datos REALES.
//
// No es una prueba: es una demostracion para mirar. Corre el handler de verdad
// -`api/contador.js`, el mismo que va a desplegarse- contra hallazgos reales
// sacados de STAGING con la CLI de Supabase.
//
// Lo unico sustituido es el TRANSPORTE a la base (`usarTransporteDePrueba`),
// porque la llave de servicio no se puede sacar del CLI. Todo lo demas -la
// puerta, el interruptor, el silencio, la composicion del aviso, el registro de
// la corrida- es el codigo que va a produccion.
//
// Uso: node tools/demo-contador.mjs
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ANTES del require, y no despues: `api/contador.js` lee `CRON_SECRET` AL
// CARGARSE, como todo modulo que guarda su config en constantes de modulo. Si
// se pone despues, el endpoint se queda con undefined y contesta 403 a todo.
// Es la misma trampa que las variables de Vercel, que no entran en vigor en un
// despliegue que ya existe. Esta demo la encontro sola la primera vez que corrio.
const SECRETO = 'secreto-de-mentira-solo-para-esta-demo';
process.env.CRON_SECRET = SECRETO;

const contador = require('../api/contador.js');
const { usarTransporteDePrueba, textoAviso } = contador;

const STG = 'dkwatbsaidlfjqjnfyrk';
const dir = mkdtempSync(join(tmpdir(), 'demo-contador-'));
const C = { t: '\x1b[1m', d: '\x1b[2m', v: '\x1b[32m', r: '\x1b[31m', a: '\x1b[33m', x: '\x1b[0m' };
const titulo = (s) => console.log(`\n${C.t}${s}${C.x}\n${C.d}${'─'.repeat(s.length)}${C.x}`);
const marco = (s) => s.split('\n').map((l) => `${C.d}│${C.x} ${l}`).join('\n');

function sql(q) {
  const f = join(dir, 'q.sql');
  writeFileSync(f, q, 'utf8');
  const out = execFileSync('supabase',
    ['db', 'query', '--linked', '--project-ref', STG, '-f', f],
    { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const cuerpo = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)
    .replace(/,\s*\n\}/, '\n}'));
  if (cuerpo.error) throw new Error(JSON.stringify(cuerpo.error));
  return (cuerpo.rows || [])[0];
}

// Un res de mentira que guarda lo que el handler contesta.
const hacerRes = () => {
  const res = { codigo: null, cuerpo: null };
  res.status = (c) => { res.codigo = c; return res; };
  res.json = (b) => { res.cuerpo = b; return res; };
  return res;
};

// El transporte de mentira: contesta lo que le digamos y APUNTA cada llamada,
// para poder enseñar que escribio el handler y no solo que contesto.
function transporte({ activo = true, avisarA = [], informe }) {
  const llamadas = [];
  const f = async (path, method, body) => {
    llamadas.push({ path, method, body });
    if (path.startsWith('agentes?select=')) {
      return { ok: true, status: 200, data: [{ activo, avisar_a: avisarA }] };
    }
    if (path === 'rpc/contador_revisar') return { ok: true, status: 200, data: informe };
    if (path === 'rpc/agente_registrar_corrida') return { ok: true, status: 200, data: 1 };
    return { ok: false, status: 404, data: null };
  };
  f.llamadas = llamadas;
  return f;
}

try {
  titulo('1 · Los hallazgos salen de STAGING, de verdad');
  const real = sql('select public.contador_revisar(365) as j;');
  const informe = real.j;
  console.log(`  ${informe.cuantos} hallazgos en ${informe.revisiones.length} revisiones:`);
  for (const r of informe.revisiones) {
    const col = r.gravedad === 'alta' ? C.r : C.a;
    console.log(`    ${col}${r.gravedad.toUpperCase().padEnd(5)}${C.x} ${r.clave.padEnd(20)} ${String(r.cuantos).padStart(5)}`);
  }

  titulo('2 · La puerta, sin la llave');
  {
    usarTransporteDePrueba(transporte({ informe }));
    const res = hacerRes();
    await contador({ headers: {}, query: {} }, res);
    console.log(`  Sin credencial  → ${C.r}${res.codigo}${C.x} ${JSON.stringify(res.cuerpo)}`);
  }
  {
    const res = hacerRes();
    await contador({ headers: { authorization: 'Bearer otro' }, query: {} }, res);
    console.log(`  Secreto malo    → ${C.r}${res.codigo}${C.x} ${JSON.stringify(res.cuerpo)}`);
  }

  titulo('3 · Apagado desde la base');
  {
    usarTransporteDePrueba(transporte({ activo: false, informe }));
    const res = hacerRes();
    await contador({ headers: { authorization: 'Bearer ' + SECRETO }, query: {} }, res);
    console.log(`  activo = false  → ${res.codigo} ${JSON.stringify(res.cuerpo)}`);
    console.log(`  ${C.d}y NO registró corrida: no corrió, que es distinto de correr y no hallar nada${C.x}`);
  }

  titulo('4 · Todo cuadra: silencio, pero queda constancia');
  {
    const limpio = { revisado_en: new Date().toISOString(), cuantos: 0, revisiones: [] };
    const t = transporte({ avisarA: ['5215540801794'], informe: limpio });
    usarTransporteDePrueba(t);
    const res = hacerRes();
    await contador({ headers: { authorization: 'Bearer ' + SECRETO }, query: {} }, res);
    const corrida = t.llamadas.find((l) => l.path === 'rpc/agente_registrar_corrida');
    console.log(`  Respuesta       → ${res.codigo} cuantos=${res.cuerpo.cuantos} avisado=${res.cuerpo.avisado}`);
    console.log(`  Mensaje         → ${C.v}ninguno${C.x} (textoAviso dio ${textoAviso(limpio)})`);
    console.log(`  Fila registrada → ${C.v}sí${C.x}: cuantos=${corrida.body.p_data.cuantos}, ok=${corrida.body.p_data.ok}`);
  }

  titulo('5 · Hay hallazgos: el aviso que llegaría a tu WhatsApp');
  {
    const t = transporte({ avisarA: ['5215540801794'], informe });
    usarTransporteDePrueba(t);
    const res = hacerRes();
    await contador({ headers: { authorization: 'Bearer ' + SECRETO }, query: {} }, res);
    console.log(marco(textoAviso(informe)));
    const corrida = t.llamadas.find((l) => l.path === 'rpc/agente_registrar_corrida');
    console.log(`\n  Respuesta       → ${res.codigo} cuantos=${res.cuerpo.cuantos}`);
    console.log(`  Envío           → ${C.a}no salió${C.x}: no hay WA_TOKEN en local, y se registra como tal`);
    console.log(`  Fila registrada → cuantos=${corrida.body.p_data.cuantos}, ` +
                `aviso_enviado=${corrida.body.p_data.aviso_enviado}, ` +
                `duracion=${corrida.body.p_data.duracion_ms}ms`);
  }

  titulo('6 · Modo seco: mira y no toca');
  {
    const t = transporte({ avisarA: ['5215540801794'], informe });
    usarTransporteDePrueba(t);
    const res = hacerRes();
    await contador({ headers: { authorization: 'Bearer ' + SECRETO }, query: { dry: '1' } }, res);
    const escribio = t.llamadas.some((l) => l.path === 'rpc/agente_registrar_corrida');
    console.log(`  Respuesta       → ${res.codigo} cuantos=${res.cuerpo.cuantos} seco=${res.cuerpo.seco}`);
    console.log(`  ¿Avisó?         → ${escribio ? C.r + 'sí' : C.v + 'no'}${C.x}`);
    console.log(`  ¿Dejó fila?     → ${escribio ? C.r + 'sí' : C.v + 'no'}${C.x}`);
  }

  console.log(`\n${C.d}El handler es el de api/contador.js. Lo único sustituido fue el transporte\na la base; la puerta, el interruptor, el silencio, el aviso y el registro son\nel código que se despliega.${C.x}\n`);
} finally {
  usarTransporteDePrueba(null);
  rmSync(dir, { recursive: true, force: true });
}
