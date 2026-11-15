#!/usr/bin/env node
// tools/probar-wa-cotizar.mjs — la tarea del dinero. D6 del diseno.
//
// LA PROPIEDAD QUE VIGILA: el total lo pone el SERVIDOR, y el nivel de precio no
// es negociable. El modelo dice que lineas quiere; ni suma, ni elige a que precio.
//
// COMO. Sustituye el transporte por un ESPIA que anota con que argumentos se llamo
// a `cotizar_linea` y contesta con los numeros que la base de verdad daria -traidos
// por SQL, no inventados-. Asi se ve la propiedad directamente: el `p_nivel` que
// sale hacia el servidor. Mirar solo el total la comprueba de rebote; mirar la
// llamada la comprueba de frente.
//
// POR QUE UN ESPIA Y NO LA BASE. La llave de servicio no se puede sacar del CLI:
// solo entrega las legacy -apagadas el 18 sep 2026- y trunca las nuevas. Meter una
// en disco para una prueba no vale la pena. Lo que SI se hace por la base, via el
// CLI, es traer los precios reales: el espia no se inventa un solo numero (regla 4,
// una prueba que copia el codigo solo demuestra que la copia funciona).
//
// Reparto de responsabilidades, para que quede claro que prueba cada mitad:
//   - cotizar_linea pone los precios  -> se comprueba por SQL, abajo.
//   - cotizarLineas los suma y manda el nivel -> se comprueba con el espia.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  cotizarLineas, correrHerramienta, usarTransporteDePrueba,
} = require('../api/whatsapp.js');
const MAX_PIEZAS_LINEA = require('../api/whatsapp.js').POR_DEFECTO.max_piezas_linea;

const STG = 'dkwatbsaidlfjqjnfyrk';
const dir = mkdtempSync(join(tmpdir(), 'wa-cotizar-'));
const sql = (q) => {
  const f = join(dir, 'q.sql');
  writeFileSync(f, q);
  const out = execSync(`supabase db query --linked --project-ref ${STG} -o json --file "${f}"`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const i = out.indexOf('{');
  return i < 0 ? [] : (JSON.parse(out.slice(i)).rows || []);
};

let fallos = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

// ── El producto sale de la base, no de un id a mano ─────────────────────────
const P = sql(`
  select id, sabor, presentacion, precio_consumidor, precio_tienda, precio_caja_12
    from productos
   where activo and not coalesce(descontinuado, false)
     and presentacion <> 'Granel' and coalesce(tipo_venta, 1) <> 2
     and coalesce(precio_caja_12, 0) > 0
     and coalesce(precio_consumidor, 0) > 0 and coalesce(precio_tienda, 0) > 0
     and precio_consumidor <> precio_tienda
   order by id limit 1`)[0];
const GRANEL = sql(`
  select id, sabor from productos
   where activo and not coalesce(descontinuado, false) and presentacion = 'Granel'
   order by id limit 1`)[0];

if (!P || !GRANEL) {
  console.error('Staging no tiene lo que esta prueba necesita: un producto con caja de 12 y\n'
    + 'precios de consumidor y tienda DISTINTOS, y un granel. Sin precios distintos, el caso\n'
    + 'de D6 no distingue nada y daria verde por casualidad. Parar en vez de dar verde.');
  process.exit(1);
}
console.log(`\nProducto: ${P.id} — ${P.sabor} ${P.presentacion}`);
console.log(`  consumidor ${P.precio_consumidor} · tienda ${P.precio_tienda} · caja12 ${P.precio_caja_12}`);

// ── Las respuestas del espia son las de la base, traidas por SQL ────────────
// Una por cada (nivel, cantidad, caja) que la prueba va a usar. Si una no esta
// aqui, el espia contesta 404 y la prueba lo nota: nunca improvisa un precio.
const PEDIDAS = [
  ['tienda', 72, 12], ['consumidor', 72, 12], ['mayorista', 72, 12],
  ['tienda', 1, 0], ['consumidor', 1, 0],
];
const guion = new Map();
for (const [nivel, cant, caja] of PEDIDAS) {
  const r = sql(`select cotizar_linea(${P.id}, '${nivel}', ${cant}, ${caja}) as c`)[0];
  guion.set(`${P.id}|${nivel}|${cant}|${caja}`, r.c);
}
// Y los dos rechazos del servidor, tambien reales.
for (const [id, etq] of [[GRANEL.id, 'granel'], [999999, 'inexistente']]) {
  const r = sql(`select cotizar_linea(${id}, 'tienda', 1, 0) as c`)[0];
  guion.set(`${id}|tienda|1|0`, r.c);
  console.log(`  ${etq} -> ${JSON.stringify(r.c)}`);
}

const visto = [];
usarTransporteDePrueba(async (path, method, body) => {
  visto.push({ path, method, body });
  const k = `${body.p_id_producto}|${body.p_nivel}|${body.p_cantidad}|${body.p_caja}`;
  if (!guion.has(k)) return { ok: false, status: 404, data: { sin_guion: k } };
  return { ok: true, status: 200, data: guion.get(k) };
});

// ── 1. Suma lo del servidor, sin tocarlo ────────────────────────────────────
console.log('\n1. El total es la suma de los subtotales del servidor');
const lineas = [{ idProducto: P.id, cantidad: 72, caja: 12 }];
visto.length = 0;
const cTienda = await cotizarLineas(lineas, 'tienda');
ok(cTienda.ok === true, `cotiza 72 piezas con caja de 12: ${cTienda.ok ? 'ok' : cTienda.error}`);
ok(Number(cTienda.total) === Number(guion.get(`${P.id}|tienda|72|12`).subtotal),
  `total ${cTienda.total} = subtotal del servidor ${guion.get(`${P.id}|tienda|72|12`).subtotal}`);
ok(Number(cTienda.total) === Number(P.precio_caja_12) * 6,
  `y son 6 cajas x ${P.precio_caja_12} = ${Number(P.precio_caja_12) * 6}, no 72 por pieza`);

console.log('\n   El detalle es del servidor, no del modelo');
ok(cTienda.detalle.length === 1, 'una linea, una entrada en el detalle');
ok(cTienda.detalle[0].sabor === P.sabor, `el sabor lo puso el servidor: ${cTienda.detalle[0].sabor}`);
ok(Number(cTienda.detalle[0].piezasPorCaja) === 12, 'y recuerda las piezas por caja');

// ── 2. D6: ESTE ES EL CASO ──────────────────────────────────────────────────
console.log('\n2. D6: el nivel que sale hacia el servidor es el del servidor');
visto.length = 0;
await cotizarLineas(lineas, 'consumidor');
ok(visto.length === 1, 'una linea, una llamada a cotizar_linea');
ok(visto[0].path === 'rpc/cotizar_linea', `llamo a ${visto[0].path}`);
ok(visto[0].body.p_nivel === 'consumidor', `mando p_nivel = "${visto[0].body.p_nivel}"`);

// Ahora por la puerta por la que entra el modelo, con la entrada MINTIENDO.
// El esquema no permite estos campos, pero esto comprueba el CODIGO, no el
// esquema: si manana alguien los acepta, aqui se pone rojo.
console.log('\n   Y con la entrada del modelo mintiendo sobre el nivel');
visto.length = 0;
const mentira = { lineas, nivel: 'mayorista', tipoCliente: 'mayorista', total: 1, precio: 1 };
const txt = await correrHerramienta('cotizar', mentira,
  { nivel: 'consumidor', esCliente: true, nombre: 'Ana', telefono: '5215500000001' });
let leido = null;
try { leido = JSON.parse(txt); } catch { /* vino texto de error */ }
ok(leido !== null, `devolvio una cotizacion y no un error: ${leido ? 'si' : String(txt).slice(0, 70)}`);
ok(visto.length === 1 && visto[0].body.p_nivel === 'consumidor',
  `con "nivel: mayorista" en la entrada, al servidor fue "${visto[0] && visto[0].body.p_nivel}"`);
ok(leido && leido.nivelDePrecio === 'consumidor',
  `y le dice al modelo que el nivel es "${leido && leido.nivelDePrecio}"`);
ok(leido && Number(leido.total) === Number(guion.get(`${P.id}|consumidor|72|12`).subtotal),
  `cobro ${leido && leido.total}, el de consumidor, no el de mayorista`);

// Que los tres niveles den numeros distintos es lo que hace valer el caso de
// arriba. Si fueran iguales, pasaria sin comprobar nada.
const tres = ['tienda', 'consumidor', 'mayorista']
  .map((n) => Number(guion.get(`${P.id}|${n}|72|12`).subtotal));
ok(new Set(tres).size > 1, `los niveles dan totales distintos (${tres.join(' / ')}): el caso discrimina`);

// ── 3. Al consumidor la caja no le aplica ───────────────────────────────────
console.log('\n3. La caja es cosa de tienda y mayorista, y el codigo no la finge');
const cCons = await cotizarLineas(lineas, 'consumidor');
ok(Number(cCons.total) === Number(P.precio_consumidor) * 72,
  `consumidor: 72 x ${P.precio_consumidor} = ${Number(P.precio_consumidor) * 72}, sin precio de caja`);
ok(cCons.detalle[0].piezasPorCaja === null,
  `y el detalle no dice piezas por caja (dice ${JSON.stringify(cCons.detalle[0].piezasPorCaja)})`);

// ── 4. Lo que rechaza, antes de molestar al servidor ────────────────────────
console.log('\n4. Lo que no cotiza');
const rechazos = [
  [[], 'sin_lineas', 'lista vacia', 0],
  [[{ idProducto: P.id, cantidad: 0, caja: 0 }], 'cantidad_invalida', 'cantidad cero', 0],
  [[{ idProducto: P.id, cantidad: 1.5, caja: 0 }], 'cantidad_invalida', 'cantidad con decimales', 0],
  [[{ idProducto: P.id, cantidad: MAX_PIEZAS_LINEA + 1, caja: 0 }], 'cantidad_enorme', 'cantidad absurda', 0],
  [[{ idProducto: P.id, cantidad: 2, caja: 0 }, { idProducto: P.id, cantidad: 3, caja: 0 }],
    'producto_repetido', 'el mismo producto dos veces', 0],
  [[{ idProducto: GRANEL.id, cantidad: 1, caja: 0 }], 'granel_no_soportado', 'granel', 1],
  [[{ idProducto: 999999, cantidad: 1, caja: 0 }], 'producto_no_disponible', 'un id que no existe', 1],
];
for (const [ls, esperado, que, llamadas] of rechazos) {
  visto.length = 0;
  const r = await cotizarLineas(ls, 'tienda');
  ok(r.ok === false && r.error === esperado, `${que} -> ${r.ok ? 'COTIZO' : r.error} (esperado ${esperado})`);
  // Lo que se puede rechazar sin preguntar, se rechaza sin preguntar.
  ok(visto.length === llamadas, `  y ${visto.length} llamada(s) al servidor (esperadas ${llamadas})`);
}

console.log('\n5. Un rechazo le prohibe dar un total y le dice que hacer');
const err = await correrHerramienta('cotizar',
  { lineas: [{ idProducto: GRANEL.id, cantidad: 1, caja: 0 }] },
  { nivel: 'tienda', esCliente: true, nombre: 'Lupita', telefono: '5215500000002' });
ok(/^NO le des ningun total/.test(err), 'empieza prohibiendole dar un total');
ok(/granel/i.test(err) && /100, 250, 500/.test(err), 'y le dice que ofrecer en su lugar');
ok(!/granel_no_soportado/.test(err), 'sin soltarle el codigo de error crudo');
console.log(`  dijo: "${String(err).slice(0, 130)}"`);

console.log('\n6. El gancho de pruebas esta cerrado en produccion');
process.env.VERCEL = '1';
let lanzo = false;
try { usarTransporteDePrueba(() => {}); } catch { lanzo = true; }
delete process.env.VERCEL;
ok(lanzo, 'con VERCEL puesta, sustituir el transporte lanza');

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
