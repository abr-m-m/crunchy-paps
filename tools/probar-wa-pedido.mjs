#!/usr/bin/env node
// tools/probar-wa-pedido.mjs — la herramienta que ESCRIBE. D6 del diseno.
//
// Es la primera que toca la base de verdad, asi que lo que vigila no es que
// "funcione": es el PAYLOAD que sale hacia crear_pedido. Ahi estan los dos fallos
// que importan, y los dos son silenciosos:
//
//   1. `tipoCliente` tiene que ser el de wa_identidad, pase lo que pase en la
//      entrada del modelo. Si alguien deja que lo ponga el modelo, una tienda
//      compra a precio de mayorista y se ve en la factura, no antes.
//   2. Cada producto tiene que llevar `caja`. cotizar_linea devuelve
//      `piezasPorCaja` y crear_pedido lee `caja`: NO son la misma clave. Sin la
//      traduccion, toda linea por caja viaja como "por pieza" y el pedido muere
//      en `precio_cambiado` — ningun tendero podria comprar por caja nunca.
//
// El payload se ESPIA. No hace falta una credencial de vendedor (que ademas dura
// 12 h y hoy no hay ninguna viva), y lo que se comprueba es exactamente lo que se
// quiere comprobar: lo que el agente manda, no lo que la base hace con ello.
//
// Los numeros del espia salen de la base por SQL via el CLI: no se inventa ni uno
// (regla 4, una prueba que copia el codigo solo demuestra que la copia funciona).
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  correrHerramienta, herramientasPara, usarTransporteDePrueba, detalleParaPedido,
} = require('../api/whatsapp.js');

const STG = 'dkwatbsaidlfjqjnfyrk';
const dir = mkdtempSync(join(tmpdir(), 'wa-pedido-'));
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

const P = sql(`
  select id, sabor, presentacion, precio_consumidor, precio_tienda, precio_caja_12
    from productos
   where activo and not coalesce(descontinuado, false)
     and presentacion <> 'Granel' and coalesce(tipo_venta, 1) <> 2
     and coalesce(precio_caja_12, 0) > 0
     and coalesce(precio_consumidor, 0) > 0 and coalesce(precio_tienda, 0) > 0
     and precio_consumidor <> precio_tienda
   order by id limit 1`)[0];
if (!P) {
  console.error('Staging no tiene un producto con caja de 12 y precios de consumidor y tienda\n'
    + 'distintos. Sin eso el caso de D6 no distingue nada: parar en vez de dar verde.');
  process.exit(1);
}
console.log(`\nProducto: ${P.id} — ${P.sabor} ${P.presentacion} · tienda ${P.precio_tienda} · caja12 ${P.precio_caja_12}`);

// El guion del espia: lo que cotizar_linea devuelve de verdad.
const guion = new Map();
for (const [nivel, cant, caja] of [['tienda', 72, 12], ['mayorista', 72, 12], ['consumidor', 72, 12]]) {
  guion.set(`${nivel}|${cant}|${caja}`, sql(`select cotizar_linea(${P.id}, '${nivel}', ${cant}, ${caja}) as c`)[0].c);
}

let visto = [];
let respuesta = { ok: true, consecutivo: 'PED-09999' };
usarTransporteDePrueba(async (path, method, body) => {
  visto.push({ path, body });
  if (path === 'rpc/cotizar_linea') {
    const k = `${body.p_nivel}|${body.p_cantidad}|${body.p_caja}`;
    if (!guion.has(k)) return { ok: false, status: 404, data: { sin_guion: k } };
    return { ok: true, status: 200, data: guion.get(k) };
  }
  if (path === 'rpc/crear_pedido') return { ok: true, status: 200, data: respuesta };
  return { ok: false, status: 404, data: null };
});

const TIENDA = {
  nivel: 'tienda', esCliente: true, aprobadoB2B: true, nombre: 'Tienda Lupita',
  idCliente: 42, telefono: '5215500000002', idMensaje: 'wamid.ABC123',
};
const CONSUMIDOR = {
  nivel: 'consumidor', esCliente: true, aprobadoB2B: true, nombre: 'Ana',
  idCliente: 28, telefono: '5215500000001', idMensaje: 'wamid.XYZ789',
};
const PEDIDO = { lineas: [{ idProducto: P.id, cantidad: 72, caja: 12 }], fechaEntrega: '2026-11-20', notas: '' };
const pedir = async (id, entrada) => {
  visto = [];
  const txt = await correrHerramienta('crear_pedido', entrada, id);
  return { txt, enviado: (visto.find((v) => v.path === 'rpc/crear_pedido') || {}).body };
};

// ── 1. La herramienta solo existe para quien puede pedir ────────────────────
console.log('\n1. crear_pedido no le llega al modelo si quien escribe no puede pedir');
for (const [id, debe] of [[TIENDA, true], [CONSUMIDOR, false]]) {
  const tiene = herramientasPara(id).some((h) => h.name === 'crear_pedido');
  ok(tiene === debe, `${id.nivel}: ${tiene ? 'la tiene' : 'no la tiene'} (esperado ${debe ? 'si' : 'no'})`);
}
// Ana tiene aprobado_b2b = true y NO es tienda. Ese es el caso real del 14 nov.
ok(CONSUMIDOR.aprobadoB2B === true, 'y el consumidor de la prueba trae aprobado_b2b = true, como el real');

console.log('\n   Y aunque se llame a mano, el codigo la rechaza');
const colada = await pedir(CONSUMIDOR, PEDIDO);
ok(/NO puedes crear pedidos/.test(colada.txt), `dijo: "${colada.txt.slice(0, 60)}..."`);
ok(colada.enviado === undefined, 'y no mando NADA a crear_pedido');

// ── 2. El payload: caja ─────────────────────────────────────────────────────
console.log('\n2. Cada producto viaja con `caja`, que es la clave que crear_pedido lee');
const buena = await pedir(TIENDA, PEDIDO);
ok(buena.enviado !== undefined, 'llamo a crear_pedido');
const prod = buena.enviado.p_data.productos[0];
ok(Number(prod.caja) === 12, `caja = ${prod.caja} (cotizar_linea lo llama piezasPorCaja: ${prod.piezasPorCaja})`);
ok(Number(prod.cantidad) === 72, `cantidad = ${prod.cantidad} piezas, no 6 cajas`);
ok(Number(buena.enviado.p_data.total) === Number(guion.get('tienda|72|12').subtotal),
  `total ${buena.enviado.p_data.total} = el del servidor ${guion.get('tienda|72|12').subtotal}`);
ok(Number(buena.enviado.p_data.total) === Number(P.precio_caja_12) * 6,
  `y es precio de CAJA (6 x ${P.precio_caja_12}), no 72 por pieza (${Number(P.precio_tienda) * 72})`);

// ── 3. El payload: tipoCliente. ESTE ES D6 ──────────────────────────────────
console.log('\n3. D6: tipoCliente sale de wa_identidad, mienta lo que mienta la entrada');
ok(buena.enviado.p_data.tipoCliente === 'tienda', `tipoCliente = "${buena.enviado.p_data.tipoCliente}"`);
const mentira = { ...PEDIDO, tipoCliente: 'mayorista', nivel: 'mayorista', total: 1, token: 'robado' };
const m = await pedir(TIENDA, mentira);
ok(m.enviado.p_data.tipoCliente === 'tienda',
  `con "tipoCliente: mayorista" en la entrada, salio "${m.enviado.p_data.tipoCliente}"`);
ok(m.enviado.p_data.total === buena.enviado.p_data.total,
  `y el total no cambio (${m.enviado.p_data.total}): el "total: 1" de la entrada se ignoro`);
const cot = visto.filter((v) => v.path === 'rpc/cotizar_linea');
ok(cot.length === 1 && cot[0].body.p_nivel === 'tienda',
  `y cotizo con p_nivel = "${cot[0] && cot[0].body.p_nivel}"`);

// ── 4. El resto del payload ─────────────────────────────────────────────────
console.log('\n4. Lo demas del payload');
const d = buena.enviado.p_data;
ok(d.canal === 'whatsapp', `canal = ${d.canal}`);
ok(d.idCliente === 42 && d.telefono === '5215500000002', 'cliente y telefono, de la identidad');
ok(d.idempotencyKey === 'wa-5215500000002-wamid.ABC123',
  `clave idempotente con el id del mensaje de Meta: ${d.idempotencyKey}`);
ok(String(d.notas).startsWith('[wa]'), `notas marcadas: "${d.notas}"`);
ok(d.tipoInterno === undefined, 'sin tipoInterno: un pedido del agente es una venta real');

console.log('\n   La clave idempotente cambia con el mensaje, no con el reloj');
const otro = await pedir({ ...TIENDA, idMensaje: 'wamid.OTRO' }, PEDIDO);
ok(otro.enviado.p_data.idempotencyKey !== d.idempotencyKey, 'otro mensaje, otra clave');
const igual = await pedir(TIENDA, PEDIDO);
ok(igual.enviado.p_data.idempotencyKey === d.idempotencyKey,
  'el MISMO mensaje da la MISMA clave (si Meta reintenta, no se duplica el pedido)');

// ── 5. Lo que contesta cuando el servidor dice que no ───────────────────────
console.log('\n5. Cuando el servidor dice que no, NO se da por hecho');
const casos = [
  [{ ok: false, error: 'precio_cambiado', totalCorrecto: 1950 }, /precio cambio/i, 'precio_cambiado'],
  [{ ok: false, error: 'sesion_requerida' }, /NO le digas que quedo hecho/, 'sesion_requerida'],
  [{ ok: false, error: 'producto_no_encontrado' }, /NO le digas que quedo hecho/, 'producto_no_encontrado'],
  [{ ok: true, duplicado: true, consecutivo: 'PED-00080' }, /ya estaba creado/i, 'duplicado'],
];
for (const [resp, espera, etq] of casos) {
  respuesta = resp;
  const { txt } = await pedir(TIENDA, PEDIDO);
  ok(espera.test(txt), `${etq} -> "${txt.slice(0, 72)}..."`);
  if (etq === 'precio_cambiado') {
    ok(/1950/.test(txt) && /1800/.test(txt), '  y le da los DOS numeros, para que el cliente decida');
  }
}
respuesta = { ok: true, consecutivo: 'PED-09999' };

console.log('\n6. Cuando sale bien, avisa de que queda pendiente');
const fin = await pedir(TIENDA, PEDIDO);
ok(/PED-09999/.test(fin.txt), 'da el folio');
ok(/PENDIENTE/.test(fin.txt), 'y dice que queda pendiente de que Abraham confirme');

console.log('\n7. Una fecha que no es AAAA-MM-DD no llega al servidor');
for (const f of ['', 'el jueves', '20-11-2026', '2026-11-20T10:00']) {
  const r = await pedir(TIENDA, { ...PEDIDO, fechaEntrega: f });
  ok(/AAAA-MM-DD/.test(r.txt) && r.enviado === undefined, `"${f}" -> rechazada sin llamar al servidor`);
}

console.log('\n8. detalleParaPedido no pierde lo que ya traia el detalle');
const antes = { idProducto: '1', sabor: 'Natural', cantidad: 72, piezasPorCaja: 12, subtotal: 1800 };
const despues = detalleParaPedido([antes])[0];
ok(despues.caja === 12 && despues.sabor === 'Natural' && despues.subtotal === 1800,
  'anade caja y conserva el resto');
ok(detalleParaPedido([{ ...antes, piezasPorCaja: null }])[0].caja === 0,
  'y sin caja manda 0, no null (crear_pedido hace ~ contra 3|6|12)');

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
