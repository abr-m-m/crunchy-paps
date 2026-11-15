#!/usr/bin/env node
// tools/probar-wa-catalogo.mjs — el catalogo del agente contra cotizar_linea.
//
// POR QUE EXISTE. La herramienta `catalogo` trae las 35 filas de golpe y decide por
// su cuenta que ofrecer y a que precio, con una COPIA de las reglas de
// cotizar_linea. Copiarlas fue deliberado (cotizar 35 productos en cada mensaje
// serian 35 llamadas), pero una copia que nadie compara no mide: repite (regla 63).
// Esta prueba es la comparacion. Llama a cotizar_linea DE VERDAD, producto por
// producto y nivel por nivel, y exige las dos direcciones:
//
//   1. Todo lo que el catalogo OFRECE, el servidor lo cotiza ok... y al MISMO
//      precio. Si no, el agente promete algo que no se puede cobrar.
//   2. Todo lo que el catalogo ESCONDE, el servidor no lo cobraria (o lo cobraria
//      a $0). Si no, el agente esconde producto vendible.
//
// La direccion 2 es la que se suele olvidar. Un filtro de mas no revienta nada:
// simplemente deja de vender, en silencio.
//
// Verifica con un metodo DISTINTO del que hizo el cambio (regla 58): el codigo usa
// PostgREST y columnas; esto usa SQL y la funcion que de verdad cobra.
//
// Solo LEE, y lee PRODUCCION a proposito: los datos que importan son los reales.
// Salio de encontrar, el 14 nov 2026, que el catalogo ofrecia los 6 granel a $0 y
// mandaba precios de caja a restaurantes, dos cosas que cotizar_linea no hace.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { clasificarProducto, COLUMNA_PRECIO, NIVELES_CON_CAJA } = require('../api/whatsapp.js');

const PROD = 'xbyzarzyxiugrucyjwfn';
const dir = mkdtempSync(join(tmpdir(), 'wa-catalogo-'));
const sql = (q) => {
  const f = join(dir, 'q.sql');
  writeFileSync(f, q);
  const out = execSync(`supabase db query --linked --project-ref ${PROD} -o json --file "${f}"`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const i = out.indexOf('{');
  return i < 0 ? [] : (JSON.parse(out.slice(i)).rows || []);
};

let fallos = 0;
const ok = (c, m) => { if (!c) { console.log('  FALLA ' + m); fallos++; } };

const NIVELES = Object.keys(COLUMNA_PRECIO);

// Una sola consulta: cada producto activo por cada nivel, con lo que cotizar_linea
// contesta para 1 pieza sin caja. `activo and not descontinuado` es el unico filtro
// que el codigo hace en la query; todo lo demas lo decide clasificarProducto, que es
// precisamente lo que se esta comprobando.
console.log('\nTrayendo productos y cotizando cada uno en los 4 niveles...');
const filas = sql(`
  select p.id, p.sabor, p.presentacion, p.gramos, p.tipo_venta,
         p.precio_consumidor, p.precio_tienda, p.precio_restaurante, p.precio_mayorista,
         p.precio_caja_3, p.precio_caja_6, p.precio_caja_12,
         n.nivel,
         cotizar_linea(p.id, n.nivel, 1, 0) as cot
    from productos p
    cross join (values ${NIVELES.map((n) => `('${n}')`).join(',')}) as n(nivel)
   where p.activo and not coalesce(p.descontinuado, false)
   order by p.id, n.nivel`);

ok(filas.length > 0, 'la consulta no devolvio nada: sin datos esta prueba no prueba nada');
if (!filas.length) { console.log('\n1 FALLAS'); process.exit(1); }

const productos = new Set(filas.map((f) => f.id)).size;
console.log(`  ${productos} productos x ${NIVELES.length} niveles = ${filas.length} cotizaciones`);

let ofrecidos = 0, escondidos = 0;
const porQue = {};

for (const f of filas) {
  const col = COLUMNA_PRECIO[f.nivel];
  const c = clasificarProducto(f, f.nivel, col);
  const cot = f.cot || {};
  const cotizable = cot.ok === true && Number(cot.subtotal) > 0;
  const donde = `producto ${f.id} (${f.sabor} ${f.presentacion}) nivel ${f.nivel}`;

  if (c.fuera) {
    escondidos++;
    porQue[c.fuera] = (porQue[c.fuera] || 0) + 1;
    // Direccion 2: esconder algo que el servidor SI cobraria es dejar de vender.
    ok(!cotizable, `${donde}: el catalogo lo esconde por "${c.fuera}", pero cotizar_linea `
      + `lo cobra a ${cot.subtotal}. El filtro sobra y el agente deja de ofrecerlo`);
    continue;
  }

  ofrecidos++;
  // Direccion 1a: lo ofrecido tiene que cotizar.
  ok(cot.ok === true, `${donde}: el catalogo lo ofrece a ${c.precio}, pero cotizar_linea `
    + `responde "${cot.error}". El agente promete lo que no se puede cobrar`);
  // Direccion 1b, la fuerte: al MISMO precio. Esto es lo que ata el coalesce de
  // mayorista del codigo al coalesce de mayorista del servidor.
  if (cot.ok === true) {
    ok(Number(cot.precioUnitario) === Number(c.precio),
      `${donde}: el catalogo dice ${c.precio} y cotizar_linea cobra ${cot.precioUnitario}`);
  }
}

console.log(`\n  ofrecidos: ${ofrecidos}   escondidos: ${escondidos} `
  + `(${Object.entries(porQue).map(([k, v]) => `${k}: ${v}`).join(', ') || 'ninguno'})`);
ok(ofrecidos > 0, 'el catalogo no ofrece NADA en ningun nivel: algo filtra de mas');

// ── Las cajas ───────────────────────────────────────────────────────────────
// El catalogo manda caja3/6/12 solo a tienda y mayorista. La razon tiene que ser
// comprobable, no una creencia: para los demas niveles, cotizar_linea ignora la
// caja. Se cotizan 3 piezas con p_caja = 3 y se compara contra el precio de caja.
console.log('\nEl precio de caja solo lo aplica el servidor a tienda y mayorista');
const conCaja = sql(`
  select p.id, p.sabor, p.precio_caja_3, n.nivel,
         cotizar_linea(p.id, n.nivel, 3, 3) as cot
    from productos p
    cross join (values ${NIVELES.map((n) => `('${n}')`).join(',')}) as n(nivel)
   where p.activo and not coalesce(p.descontinuado, false)
     and coalesce(p.precio_caja_3, 0) > 0
   order by p.id, n.nivel`);

ok(conCaja.length > 0, 'ningun producto tiene precio_caja_3: esta mitad no comprueba nada');
for (const f of conCaja) {
  const cot = f.cot || {};
  if (cot.ok !== true) continue;
  const usoLaCaja = Number(cot.subtotal) === Number(f.precio_caja_3);
  const deberia = NIVELES_CON_CAJA.includes(f.nivel);
  ok(usoLaCaja === deberia,
    `producto ${f.id} (${f.sabor}) nivel ${f.nivel}: 3 piezas con caja de 3 `
    + `${usoLaCaja ? 'SI' : 'NO'} cobraron precio de caja, y el codigo manda las cajas a `
    + `este nivel: ${deberia ? 'SI' : 'NO'}. No coinciden`);
}
console.log(`  ${conCaja.length} cotizaciones de caja comprobadas`);

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
