#!/usr/bin/env node
// tools/probar-bi.mjs — calibracion del esquema `bi` (20261016000000).
// Spec: cambios/2026-09-23-costeo-y-margen/diseno.md §3.
//
// Regla 60: una herramienta de medicion nueva se calibra contra un hecho ya sabido antes de
// creerle. El hecho, medido en produccion el 23 sep 2026: 60 pedidos reales, 182 lineas,
// Σ subtotal = $12,538, cupon $323 en 5 pedidos, NETO = $12,215.
//
// La asercion que carga el peso es que Σ f_ventas.neto sea EXACTAMENTE lo mismo que
// Σ(lineas.subtotal) − Σ(cupon), calculado SIN la vista y solo sobre los pedidos que tienen lineas.
// El cupon vive a nivel de pedido y la vista lo prorratea por linea; si el reparto pierde o inventa
// un centavo, se ve aqui y en ningun otro sitio.
//
// SOLO LEE. No escribe nada, asi que se puede correr contra produccion sin permiso.
// Uso: node tools/probar-bi.mjs [staging|produccion]     (por defecto staging)
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REFS = { staging: 'dkwatbsaidlfjqjnfyrk', produccion: 'xbyzarzyxiugrucyjwfn' };
const entorno = (process.argv[2] || 'staging').toLowerCase();
const REF = REFS[entorno];
if (!REF) { console.error('Uso: node tools/probar-bi.mjs [staging|produccion]'); process.exit(1); }

let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };
const dir = mkdtempSync(join(tmpdir(), 'bi-'));
const sql = (q) => { const f = join(dir, 'q.sql'); writeFileSync(f, q); const out = execSync(`supabase db query --linked --project-ref ${REF} -o json --file "${f}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); const i = out.indexOf('{'); return i < 0 ? [] : (JSON.parse(out.slice(i)).rows || []); };
const uno = (q) => (sql(q)[0] || {});

console.log(`\nCalibrando bi.f_ventas contra ${entorno} (${REF})`);

// ── La fuente de verdad, calculada SIN la vista ─────────────────────────────
// El invariante se calcula sobre los pedidos que TIENEN lineas. Una tabla de hechos por linea no
// puede representar un pedido sin ninguna, y en staging hay dos (PED-00001 y PED-00002, $100 de
// cabecera y cero lineas). Compararla contra la suma de CABECERAS acusaria a la vista de un hueco
// que esta en los datos: la primera version de esta prueba hizo justo eso (regla 3).
const real = uno(`
  with p as (select o.id, o.subtotal, coalesce(o.descuento,0) dsc
               from ordenes o
              where coalesce(o.tipo_interno,'') = '' and o.estatus_pedido <> 'Cancelado'
                and exists (select 1 from ordenes_detalle d where d.id_orden = o.id))
  select count(*)::text pedidos,
         round((select sum(d.subtotal) from ordenes_detalle d where d.id_orden in (select id from p)), 2)::text sub,
         round(sum(p.dsc), 2)::text desc_,
         round((select sum(d.subtotal) from ordenes_detalle d where d.id_orden in (select id from p))
               - sum(p.dsc), 2)::text neto,
         (select count(*) from ordenes_detalle d where d.id_orden in (select id from p))::text lineas
    from p`);

const vista = uno(`
  select count(*)::text lineas,
         round(sum(subtotal_linea), 2)::text sub,
         round(sum(descuento_prorrateado), 2)::text desc_,
         round(sum(neto), 2)::text neto
    from bi.f_ventas`);

console.log(`  fuente: ${real.pedidos} pedidos, ${real.lineas} lineas, sub ${real.sub}, cupon ${real.desc_}, neto ${real.neto}`);
console.log(`  vista : ${vista.lineas} lineas, sub ${vista.sub}, prorrateado ${vista.desc_}, neto ${vista.neto}`);

ok(vista.lineas === real.lineas, `Las lineas cuadran (${vista.lineas} = ${real.lineas})`);
ok(vista.sub === real.sub, `Σ subtotal cuadra (${vista.sub} = ${real.sub})`);
ok(vista.desc_ === real.desc_, `El cupon prorrateado suma el cupon entero (${vista.desc_} = ${real.desc_}) — no se perdio ni se invento`);
ok(vista.neto === real.neto, `Σ NETO cuadra EXACTO (${vista.neto} = ${real.neto})`);

if (entorno === 'produccion') {
  console.log('\nAnclas de produccion medidas el 23 sep 2026');
  ok(vista.neto === '12215.00' || vista.neto === '12215', `Σ neto = 12,215 (dio ${vista.neto})`);
  ok(real.lineas === '182', `182 lineas (dio ${real.lineas})`);
  ok(real.desc_ === '323.00' || real.desc_ === '323', `cupon 323 (dio ${real.desc_})`);
}

console.log('\nPedidos que cuentan como venta pero no tienen ni una linea');
// No es un fallo de la vista: es una senal de calidad de dato. Un pedido con importe y sin lineas
// es una venta fantasma, y conviene verla en vez de que la absorba un total.
const huerfanos = sql(`select o.consecutivo, o.subtotal::text s from ordenes o
  where coalesce(o.tipo_interno,'') = '' and o.estatus_pedido <> 'Cancelado'
    and not exists (select 1 from ordenes_detalle d where d.id_orden = o.id) order by o.id`);
if (huerfanos.length) {
  console.log(`  AVISO: ${huerfanos.length} pedido(s) sin lineas: ` +
              huerfanos.map(h => `${h.consecutivo} ($${h.s})`).join(', '));
}
ok(entorno !== 'produccion' || huerfanos.length === 0,
   entorno === 'produccion' ? `produccion no tiene pedidos sin lineas (${huerfanos.length})`
                            : `en staging se toleran (${huerfanos.length}); en produccion seria un fallo`);

console.log('\nUn pedido SIN cupon no debe llevar prorrateo');
const sinCupon = uno(`select count(*)::text n from bi.f_ventas v
  where v.descuento_prorrateado <> 0
    and v.id_orden in (select id from ordenes where coalesce(descuento,0) = 0)`);
ok(sinCupon.n === '0', `ninguna linea de un pedido sin cupon lleva descuento (${sinCupon.n})`);

console.log('\nLo que NO se cuenta como venta');
const fuera = uno(`
  select (select count(*) from bi.f_ventas v join ordenes o on o.id = v.id_orden
           where o.estatus_pedido = 'Cancelado')::text cancelados,
         (select count(*) from bi.f_ventas v join ordenes o on o.id = v.id_orden
           where coalesce(o.tipo_interno,'') <> '')::text internos`);
ok(fuera.cancelados === '0', `ningun pedido cancelado entra (${fuera.cancelados})`);
ok(fuera.internos === '0', `ningun pedido interno entra (${fuera.internos})`);

console.log('\nEl margen ausente es NULL, no el neto entero (D12)');
const m = uno(`select count(*)::text sin_costo,
                      count(*) filter (where margen is not null)::text con_margen,
                      count(*) filter (where costo_unitario is null and margen is not null)::text mal
                 from bi.f_ventas`);
ok(m.mal === '0', `ninguna linea sin costo tiene margen (${m.mal})`);

console.log('\nd_cliente no lleva datos personales (D7)');
const cols = sql(`select column_name c from information_schema.columns
                   where table_schema='bi' and table_name='d_cliente'`).map(r => r.c);
ok(!cols.some(c => /telefono|direccion|coordenada|latitud|longitud|rfc|email/i.test(c)),
   `d_cliente sin datos personales (${cols.join(', ')})`);

console.log('\nLas 11 vistas existen');
const vistas = sql(`select table_name t from information_schema.views where table_schema='bi' order by 1`).map(r => r.t);
ok(vistas.length === 11, `11 vistas en bi (${vistas.length}: ${vistas.join(', ')})`);

console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
