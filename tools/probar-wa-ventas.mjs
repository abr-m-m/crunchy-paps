#!/usr/bin/env node
// tools/probar-wa-ventas.mjs — la herramienta de ventas del dueño.
//
// LA PIDIO EL PROPIO AGENTE. El 20 nov 2026 a las 19:07, al no poder contestar
// «¿cuándo fue el último día que vendimos?», apunto el hueco con esta ficha:
// «Herramienta de consulta de ventas del negocio (todos los pedidos/ventas, NO
// SOLO LOS DEL USUARIO) que devuelva la fecha de la última venta.»
//
// LO QUE DE VERDAD VIGILA ESTA PRUEBA, y es una sola cosa:
//
//   QUE EL AGENTE Y LA PANTALLA DIGAN EL MISMO NUMERO. `wa_ventas` NO calcula
//   las ventas: envuelve `dashboard_resumen_interno`, que es la misma funcion
//   que alimenta el tablero. La prueba compara los dos lados y falla si se
//   separan. Una copia que nadie compara, miente (regla 63) — y aqui mentir
//   significa que el dueño lea un numero por WhatsApp y otro en su pantalla,
//   sin forma de saber cual.
//
// Lee de STAGING. No escribe nada.
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { herramientasPara, usarAjustesDePrueba } = require('../api/whatsapp.js');

const STG = 'dkwatbsaidlfjqjnfyrk';
const dir = mkdtempSync(join(tmpdir(), 'wa-ventas-'));
let fallos = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

function sql(q) {
  const f = join(dir, 'q.sql');
  writeFileSync(f, q, 'utf8');
  const out = execFileSync('supabase',
    ['db', 'query', '--linked', '--project-ref', STG, '-f', f],
    { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const c = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1).replace(/,\s*\n\}/, '\n}'));
  if (c.error) throw new Error(JSON.stringify(c.error));
  return (c.rows || [])[0];
}

const DUENO = {
  nombre: 'Abraham', nivel: 'consumidor', esCliente: false,
  esVendedor: true, esDueno: true, rol: 'Administrador', telefono: '5215500000006',
};

try {
  console.log('\nLa herramienta existe, y SOLO para el dueño');
  {
    usarAjustesDePrueba({ avisar_a: ['5215500000099'] });
    const dueno = herramientasPara(DUENO).map((h) => h.name);
    const tendero = herramientasPara({ nombre: 'Lupita', nivel: 'tienda', esCliente: true })
      .map((h) => h.name);
    ok(dueno.includes('ventas'), 'el dueño la tiene');
    ok(!tendero.includes('ventas'), 'el tendero NO: las ventas del negocio no son suyas');
    usarAjustesDePrueba({});
  }

  console.log('\nContesta la pregunta que la pidio');
  const r = sql("select public.wa_ventas(null, null) as j;").j;
  {
    ok(r.ok === true, 'ok = true');
    ok(r.ultimoDiaConVentas !== undefined, 'trae `ultimoDiaConVentas`, que es lo que se pregunto');
    ok(r.neto !== undefined && r.pedidos !== undefined, 'y el neto y los pedidos del periodo');
  }

  console.log('\nEL NUMERO ES EL MISMO QUE EL DE LA PANTALLA (la que importa)');
  {
    // Se le pide a `dashboard_resumen_interno` EL MISMO periodo y se comparan.
    // Si alguien reescribe `wa_ventas` con su propia consulta «para que sea mas
    // rapida», esta asercion lo caza.
    const c = sql(`with v as (select public.wa_ventas('${r.desde}'::date, '${r.hasta}'::date) j),
                        d as (select public.dashboard_resumen_interno(
                                jsonb_build_object('desde','${r.desde}','hasta','${r.hasta}'))->'data' j)
                   select (select (j->>'neto')::numeric from v)                as agente,
                          (select (j->'ingresos'->>'neto')::numeric from d)    as pantalla,
                          (select (j->>'pedidos')::int from v)                 as ped_agente,
                          (select (j->>'entregados')::int from d)              as ped_pantalla;`);
    ok(Number(c.agente) === Number(c.pantalla),
      `el neto coincide: agente ${c.agente} = pantalla ${c.pantalla}`);
    ok(Number(c.ped_agente) === Number(c.ped_pantalla),
      `y los pedidos: agente ${c.ped_agente} = pantalla ${c.ped_pantalla}`);
  }

  console.log('');
  console.log('El agente puede EXPLICAR por que cobrado > neto');
  {
    // Lo encontro el propio agente el 20 nov a las 19:26: «Cobrado sale mayor que
    // neto. No sé a qué se deba la diferencia, y con estos datos no puedo
    // explicarla.» Tenia razon, y el defecto era de la herramienta: le daba
    // `neto` -sin envio- y `cobrado` -con envio- sin con que explicar la
    // diferencia. Dijo «no se» en vez de inventar, que es lo que se le pidio.
    ok(r.envioCobrado !== undefined, 'el payload trae `envioCobrado`');
    const cuadra = Math.abs(Number(r.neto) + Number(r.envioCobrado) - Number(r.cobrado)) < 0.01;
    ok(cuadra,
      `cobrado = neto + envio: ${r.cobrado} = ${r.neto} + ${r.envioCobrado}`);
    ok(r.cupones !== undefined, 'y los cupones, que es el otro hueco entre bruto y neto');
  }

  console.log('\n«El último día que vendimos» no depende de la ventana');
  {
    // Es la unica cifra que NO es del periodo: preguntar «cuando vendimos por
    // ultima vez» con una ventana de 90 dias daria «nunca» en cuanto el negocio
    // lleve tres meses parado — que es justo el caso de hoy.
    const c = sql(`with v as (select public.wa_ventas('2026-11-01'::date, '2026-11-30'::date) j)
                   select (select j->'ultimoDiaConVentas'->>'fecha' from v) as con_ventana_corta,
                          (select max(fecha_orden)::date::text from ordenes
                            where coalesce(tipo_interno,'')='' and estatus_pedido <> 'Cancelado')
                            as de_verdad,
                          (select (j->>'neto')::numeric from v) as neto_del_mes;`);
    ok(c.con_ventana_corta === c.de_verdad,
      `con ventana de un mes sigue diciendo ${c.con_ventana_corta} (y la verdad es ${c.de_verdad})`);
    ok(c.neto_del_mes !== null, 'y el neto SI es el del periodo pedido');
  }

  console.log('\nUn periodo al reves no revienta');
  {
    const c = sql("select public.wa_ventas('2026-12-31'::date, '2026-01-01'::date) as j;").j;
    ok(c.ok === true || c.error, 'contesta algo en vez de tronar');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
