// ============================================================================
//  Simulador de temporada — clientes sintéticos comprando en STAGING
//
//  La app lleva 80 días sin un pedido. Todo lo construido desde septiembre
//  —promociones, topes, puntos, canje, caja, lote— está probado pieza a pieza
//  y NUNCA con volumen ni con varios clientes a la vez. Esto lo arregla.
//
//  QUÉ NO ES: no simula el mercado. No dice cuánta gente compraría. Lo que
//  mide es si la APP aguanta que la usen, y si las cuentas cuadran después.
//
//  TRES REGLAS QUE NO SE NEGOCIAN
//  ------------------------------
//  1. SOLO STAGING. El ref de producción está escrito aquí para RECHAZARLO.
//     Dos pedidos de prueba en producción costaron una tarde de reparar
//     asientos de caja en septiembre (`cambios/2026-09-22-caja-asiento-fantasma.md`).
//  2. TODO POR LA PUERTA DE VERDAD. Los pedidos los crea `crear_pedido`, no un
//     INSERT. Una prueba que escribe las filas a mano solo demuestra que sabe
//     escribir filas (regla 4).
//  3. EL SIMULADOR NO CALCULA DINERO. Manda un total deliberadamente malo,
//     el servidor lo rechaza con `precio_cambiado` y DICE el correcto, y
//     entonces se manda otra vez con ese. Así no hay una segunda copia de la
//     regla de precio que pueda desviarse de la primera (regla 63).
//
//  LA ÚNICA PUERTA QUE SE SALTA, dicha en voz alta: la verificación por SMS.
//  Las sesiones de cliente se escriben directamente en `sesiones_cliente`, que
//  es lo que haría el OTP al terminar. Mandar SMS de verdad costaría dinero y
//  quemaría la cuota de Twilio.
//
//    node tools/simular-temporada.mjs                  12 clientes · 14 días
//    node tools/simular-temporada.mjs --clientes 40 --dias 90
//    node tools/simular-temporada.mjs --limpiar        borra lo que creó
// ============================================================================
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STAGING = 'dkwatbsaidlfjqjnfyrk';
const PRODUCCION = 'xbyzarzyxiugrucyjwfn';

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
};
const CLIENTES = arg('--clientes', 12);
const DIAS = arg('--dias', 14);
const SEMILLA = arg('--semilla', 0.42);        // misma semilla, misma temporada
const LIMPIAR = process.argv.includes('--limpiar');
const REF = process.argv.includes('--ref') ? process.argv[process.argv.indexOf('--ref') + 1] : STAGING;

if (REF === PRODUCCION) {
  console.error('\n  NO. Esto no se corre contra producción, nunca.\n');
  process.exit(2);
}

const sql = (consulta) => {
  const f = path.join(os.tmpdir(), `sim-${Date.now()}.sql`);
  writeFileSync(f, consulta, 'utf8');
  const salida = execFileSync('supabase',
    ['db', 'query', '--linked', '--project-ref', REF, '-f', f],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  const i = salida.indexOf('{'), j = salida.lastIndexOf('}');
  if (i < 0) return [];
  try { return JSON.parse(salida.slice(i, j + 1)).rows || []; } catch { return []; }
};

// ── Limpiar ─────────────────────────────────────────────────────────────────
if (LIMPIAR) {
  const r = sql(`
    with b as (delete from public.ordenes where idempotency_key like 'sim-%' returning 1),
         c as (delete from public.clientes where nombre like 'SIM %' returning 1),
         s as (delete from public.sesiones_cliente where telefono like '55999%' returning 1)
    select (select count(*) from b) || ' pedidos, ' || (select count(*) from c) || ' clientes, ' ||
           (select count(*) from s) || ' sesiones' as v`);
  console.log('\n  Borrado: ' + (r[0]?.v || '?') + '\n');
  process.exit(0);
}

// Un token por cliente. El hash va a la base; el token se queda aquí.
const SELLO = Date.now().toString(36);
// Cambiar el estatus de un pedido es cosa de vendedor, no de cliente: hace
// falta su sesion. En la primera corrida se llamaba sin token y con `perform`,
// que tira la respuesta, asi que CERO pedidos se entregaron y el informe no
// dijo ni una palabra (regla 13: un script que no mira la respuesta supone).
const TOK_VEND = randomBytes(24).toString('hex');
const HASH_VEND = createHash('sha256').update(TOK_VEND).digest('hex');
const clientes = Array.from({ length: CLIENTES }, (_, i) => {
  const tok = randomBytes(24).toString('hex');
  // Tres perfiles, en la proporción que tiene el negocio hoy: casi todo
  // consumidor, unas pocas tiendas (medido: 35 consumidores y 5 tiendas).
  const perfil = i % 7 === 0 ? 'tienda' : (i % 11 === 0 ? 'restaurante' : 'consumidor');
  return {
    i, tok, perfil,
    hash: createHash('sha256').update(tok).digest('hex'),
    tel: '55999' + String(100000 + i).slice(-5),
    nombre: `SIM ${perfil} ${i + 1}`,
  };
});

console.log(`\n  SIMULADOR DE TEMPORADA · ${CLIENTES} clientes · ${DIAS} días · staging\n`);

// ── 1. Los clientes, por el RPC de verdad ───────────────────────────────────
sql(clientes.map((c) => `
  select public.registrar_o_actualizar_cliente($j$${JSON.stringify({
    telefono: c.tel, nombre: c.nombre, tipo: c.perfil === 'consumidor' ? 'Consumidor' : 'Tienda',
    cp: '03100', colonia: 'Del Valle', municipio: 'Benito Juárez', estado: 'CDMX',
  })}$j$::jsonb);`).join('\n') + '\n' +
  clientes.map((c) => `
  insert into public.sesiones_cliente (token_hash, telefono, expira_en, revocada)
  values ('${c.hash}', '${c.tel}', now() + interval '2 hours', false)
  on conflict (token_hash) do nothing;`).join('\n') +
  `\ninsert into public.sesiones_vendedor (id_vendedor, rol, token_hash, expira_en, revocada)
     select v.id, v.rol, '${HASH_VEND}', now() + interval '2 hours', false
       from public.vendedores v where v.activo order by v.id limit 1
     on conflict (token_hash) do nothing;` +
  `\nselect 'listo' as v;`);
console.log(`  ok     ${CLIENTES} clientes y sus sesiones`);

// ── 2. La temporada ─────────────────────────────────────────────────────────
// Un DO block que, por cada día y cada cliente, tira un dado y compra. El
// precio NO lo calcula: manda 1 peso, lee `totalCorrecto` del rechazo y repite.
const temporada = `
do $sim$
declare
  v_prod    record;
  v_cli     record;
  v_r       jsonb;
  v_total   numeric;
  v_clave   text;
  v_cant    int;
  v_r2      jsonb;
  v_id_cli  bigint;
  v_pedidos int := 0;
  v_rech    int := 0;
  v_entregados   int := 0;
  v_sin_entregar int := 0;
  v_motivo  text;
begin
  perform setseed(${SEMILLA});
  create temp table if not exists _sim_cli (tel text, tok text, perfil text) on commit drop;
  truncate _sim_cli;
  ${clientes.map((c) => `insert into _sim_cli values ('${c.tel}','${c.tok}','${c.perfil}');`).join('\n  ')}

  for d in 0..${DIAS - 1} loop
    for v_cli in select * from _sim_cli loop
      -- Una tienda compra menos veces pero más cantidad; un consumidor al revés.
      continue when random() > (case v_cli.perfil when 'consumidor' then 0.22 else 0.10 end);

      select p.id, p.sabor, p.presentacion into v_prod
        from public.productos p
       where coalesce(p.activo, true) and not coalesce(p.descontinuado, false)
         and p.gramos is not null and p.sabor not like 'EDIT%' and p.sabor not like 'CAJA%'
       order by random() limit 1;
      continue when v_prod.id is null;

      v_cant  := case v_cli.perfil when 'consumidor' then 1 + floor(random() * 3)::int
                                   else 6 * (1 + floor(random() * 2)::int) end;
      v_clave := 'sim-${SELLO}-' || d || '-' || v_cli.tel || '-' || v_prod.id;
      -- crear_pedido toma el id del cliente del PAYLOAD, igual que se lo manda
      -- la app. Sin el, el pedido se guarda SIN dueño: sin puntos, sin salir en
      -- «mis pedidos» y sin contar para los retos. La primera corrida no lo
      -- mandaba y 13 pedidos pagados generaron CERO puntos; eso lo delato.
      select c.id into v_id_cli from public.clientes c
       where right(regexp_replace(coalesce(c.telefono,''), '[^0-9]', '', 'g'), 10) = right(v_cli.tel, 10)
       limit 1;

      -- Paso 1: un total imposible. El servidor dice cual es el bueno.
      v_r := public.crear_pedido(jsonb_build_object(
        'tokenCliente', v_cli.tok, 'tipoCliente', v_cli.perfil, 'canal', 'web',
        'telefono', v_cli.tel, 'nombreCliente', 'SIM', 'idempotencyKey', v_clave,
        'idCliente', v_id_cli,
        'metodoEntrega', 'domicilio', 'metodoPago', 1, 'total', 1,
        'productos', jsonb_build_array(jsonb_build_object(
          'idProducto', v_prod.id::text, 'sabor', v_prod.sabor, 'presentacion', v_prod.presentacion,
          'tipoVenta', 'Por Pieza', 'cantidad', v_cant, 'gramos', 0, 'precio', 1, 'subtotal', 1))));

      if (v_r->>'error') <> 'precio_cambiado' then
        v_rech := v_rech + 1;
        continue;                      -- otra cosa lo rechazo: se cuenta y sigue
      end if;
      v_total := (v_r->>'totalCorrecto')::numeric;

      -- Paso 2: el mismo pedido al precio que dijo el servidor.
      v_r := public.crear_pedido(jsonb_build_object(
        'tokenCliente', v_cli.tok, 'tipoCliente', v_cli.perfil, 'canal', 'web',
        'telefono', v_cli.tel, 'nombreCliente', 'SIM', 'idempotencyKey', v_clave,
        'idCliente', v_id_cli,
        'metodoEntrega', 'domicilio', 'metodoPago', 1, 'total', v_total,
        'productos', jsonb_build_array(jsonb_build_object(
          'idProducto', v_prod.id::text, 'sabor', v_prod.sabor, 'presentacion', v_prod.presentacion,
          'tipoVenta', 'Por Pieza', 'cantidad', v_cant, 'gramos', 0,
          'precio', round(v_total / v_cant, 2), 'subtotal', v_total))));

      if coalesce((v_r->>'ok')::boolean, false) then
        v_pedidos := v_pedidos + 1;
        -- Dos de cada tres se cobran y entregan; el resto se queda en el aire,
        -- que es como se comporta un negocio de verdad.
        if random() < 0.66 then
          v_r2 := public.actualizar_estatus_pedido(jsonb_build_object(
            -- La clave es estatusPedido. En la primera corrida se mando
            -- «estatus», el RPC la ignoro -no la lee-, aplico solo el pago y
            -- devolvio ok. No es un fallo suyo: una clave que no existe no
            -- puede fallar. El informe decia «13 entregados» y la foto «0»,
            -- y esa contradiccion fue la que lo delato.
            'token', '${TOK_VEND}', 'idOrden', (v_r->>'idOrden')::bigint,
            'actualizadoPor', 'simulador',
            'estatusPedido', 'Entregado', 'estatusPago', 'Pagado'));
          if coalesce((v_r2->>'ok')::boolean, false) then
            v_entregados := v_entregados + 1;
          else
            v_sin_entregar := v_sin_entregar + 1;
            if v_motivo is null then v_motivo := coalesce(v_r2->>'mensaje', v_r2->>'error'); end if;
          end if;
        end if;
      else
        v_rech := v_rech + 1;
      end if;
    end loop;
  end loop;

  create temp table if not exists _sim_res (k text, v text) on commit drop;
  truncate _sim_res;
  insert into _sim_res values
    ('pedidos creados', v_pedidos::text),
    ('rechazados al crear', v_rech::text),
    ('entregados y cobrados', v_entregados::text),
    ('fallaron al entregar', v_sin_entregar::text || coalesce(' · ' || v_motivo, ''));
end $sim$;
select k as v, v as n from _sim_res;
`;
const res = sql(temporada);
for (const r of res) console.log(`  ok     ${r.v}: ${r.n}`);

// ── 3. Las cuentas, que es para lo que existe esto ──────────────────────────
const INVARIANTES = [
  ['caja: todo pedido cobrado tiene su asiento, y solo uno',
   `select count(*) from public.ordenes o
     where o.idempotency_key like 'sim-%' and o.estatus_caja = 'confirmado'
       and (select count(*) from public.caja_movimientos m
             where m.id_orden = o.id and m.tipo like 'venta_%') <> 1`],
  ['caja: ningun pedido SIN cobrar tiene asiento (el fantasma de septiembre)',
   `select count(*) from public.ordenes o
     where o.idempotency_key like 'sim-%' and coalesce(o.estatus_caja,'') <> 'confirmado'
       and exists (select 1 from public.caja_movimientos m
                    where m.id_orden = o.id and m.tipo like 'venta_%')`],
  ['puntos: el saldo del ledger nunca es negativo',
   `select count(*) from (
      select l.id_cliente, sum(l.puntos) s from public.lealtad_movimientos l
       join public.clientes c on c.id = l.id_cliente
       where c.nombre like 'SIM %' group by 1) q where q.s < 0`],
  // OJO CON EL ALCANCE. La primera version miraba TODOS los lotes de staging y
  // canto 40 descuadrados... de los que la simulacion habia tocado CERO: era
  // basura de meses de pruebas. Un invariante que acusa de lo que ya estaba
  // roto enseña a ignorarlo. Solo se miran los lotes que ESTA corrida movio.
  ['lote: lo descontado por linea cuadra con el lote (solo los que tocó)',
   `select count(*) from public.lotes_produccion lp
     where lp.id_lote in (select distinct d.id_lote_descontado from public.ordenes_detalle d
                            join public.ordenes o on o.id = d.id_orden
                           where o.idempotency_key like 'sim-%' and d.id_lote_descontado is not null)
       and abs(coalesce(lp.kilos_vendidos,0) -
         coalesce((select sum(d.kg_descontado_lote) from public.ordenes_detalle d
                    where d.id_lote_descontado = lp.id_lote), 0)) > 0.001`],
  ['promociones: ningun tope se paso de la raya',
   `select count(*) from public.promociones pr
     cross join lateral public.promocion_consumo(pr.id) c
     where (pr.limite_total is not null and c.usos > pr.limite_total)
        or (pr.presupuesto  is not null and c.gastado > pr.presupuesto)`],
  ['consecutivos: ninguno repetido',
   `select count(*) from (select consecutivo from public.ordenes
      group by consecutivo having count(*) > 1) q`],
];
// Cada invariante dice ademas SOBRE CUANTAS FILAS miro. Uno que pasa porque no
// habia nada que mirar no esta en verde: esta vacio, y decir «ok» ahi es la
// forma mas comoda de no enterarse de nada (regla 16: un 0 sin denominador no
// es un resultado).
// Cada invariante trae SU universo, no uno comun: el de caja mira los pedidos
// con la caja confirmada, que pueden ser cero aunque haya 18 pedidos. Con un
// universo compartido, ese invariante salia «ok» sin haber mirado nada.
const UNIVERSOS = [
  `select count(*) from public.ordenes where idempotency_key like 'sim-%' and estatus_caja = 'confirmado'`,
  `select count(*) from public.ordenes where idempotency_key like 'sim-%'`,
  `select count(*) from public.lealtad_movimientos l join public.clientes c on c.id = l.id_cliente where c.nombre like 'SIM %'`,
  `select count(distinct d.id_lote_descontado) from public.ordenes_detalle d join public.ordenes o on o.id = d.id_orden where o.idempotency_key like 'sim-%' and d.id_lote_descontado is not null`,
  `select count(*) from public.promociones where limite_total is not null or presupuesto is not null or limite_por_cliente is not null`,
  `select count(*) from public.ordenes where idempotency_key like 'sim-%'`,
];
let fallos = 0, vacios = 0;
console.log('');
const filas = sql(INVARIANTES.map(([n, q], i) =>
  `select ${i} as i, $t$${n}$t$ as v, (${q})::text as n, (${UNIVERSOS[i]})::text as u`).join(' union all ') + ' order by i');
for (const f of filas) {
  const ok = f.n === '0';
  const vacio = f.u === '0';
  if (!ok) fallos++;
  if (vacio) vacios++;
  console.log('  ' + (!ok ? 'FALLA ' : vacio ? 'VACIO ' : 'ok    ') + ' ' + f.v +
              (ok ? '' : `  → ${f.n} caso(s)`) + (vacio ? '  (no había nada que mirar)' : ''));
}
if (vacios) fallos++;

// ── 4. Lo que quedó, para poder mirarlo ─────────────────────────────────────
const foto = sql(`
  select 'pedidos de la simulacion' as v, count(*)::text as n from public.ordenes where idempotency_key like 'sim-%'
  union all select 'entregados', count(*)::text from public.ordenes where idempotency_key like 'sim-%' and estatus_pedido='Entregado'
  union all select 'vendido (neto)', coalesce(sum(o.subtotal - coalesce(o.descuento,0)),0)::text from public.ordenes o where o.idempotency_key like 'sim-%' and o.estatus_pedido <> 'Cancelado'
  union all select 'asientos de caja', count(*)::text from public.caja_movimientos m join public.ordenes o on o.id=m.id_orden where o.idempotency_key like 'sim-%'
  union all select 'puntos generados', coalesce(sum(l.puntos),0)::text from public.lealtad_movimientos l join public.clientes c on c.id=l.id_cliente where c.nombre like 'SIM %'`);
console.log('');
for (const f of foto) console.log('  ' + String(f.v).padEnd(28) + f.n);

console.log('\n  ' + (fallos ? `${fallos} INVARIANTE(S) ROTO(S)` : 'Las cuentas cuadran.') +
            '\n  Para borrarlo: node tools/simular-temporada.mjs --limpiar\n');
process.exit(fallos ? 1 : 0);
