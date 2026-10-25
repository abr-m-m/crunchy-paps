-- Vistas de BI sobre el historico del cuaderno (ene-jul 2026).
--
-- Aqui vive TODO lo inferido: el vendedor deducido, la presentacion supuesta, el precio
-- aplicado y la regla de no duplicar con la app. Las tablas de `historico` solo guardan
-- lo que el cuaderno dice; si un criterio resulta mal, se corrige con un
-- CREATE OR REPLACE VIEW y la transcripcion no se toca.
--
-- EL SOLAPE CON LA APP, medido contra produccion el 25 oct 2026:
--   `ordenes` arranca el 8 jun 2026; 64 de sus 74 pedidos caen dentro del cuaderno,
--   y `caja_movimientos` igual (65 de 152). PERO mostrador (1 registro contra 209
--   ventas locales del cuaderno) y gastos (1 contra 27 compras) NO estan en la app,
--   ni los pesos de tanda, ni el aceite, ni el inventario del local.
--   => el solape esta acotado a PEDIDOS y CAJA, desde el 8 jun.
--   Las vistas marcan esas filas con `solapa_con_app` y las dejan FUERA de las sumas,
--   pero NO las borran: que el cuaderno registre 542 piezas donde la app registro 293
--   mide cuanto se vendia por fuera de la app, y eso es un dato, no un error.

-- ---------------------------------------------------------------------------
-- bi.h_pedidos — lineas de pedido con vendedor y cliente resueltos
-- ---------------------------------------------------------------------------
create or replace view bi.h_pedidos as
with cfg as (
  select
    (select (valor #>> '{}')::date from historico.supuestos where clave = 'app_arranca')      as app_arranca,
    (select valor from historico.supuestos where clave = 'vendedores')                         as vendedores,
    (select (valor #>> '{}')::numeric from historico.supuestos where clave = 'precio_tienda_100g') as precio_tienda
),
part as (
  -- `para` viene como "Vendedor > Cliente", o solo cliente, o solo vendedor
  select h.*,
         btrim(split_part(h.para, '>', 1))            as izq,
         nullif(btrim(split_part(h.para, '>', 2),''), '') as der
  from historico.hechos h
  where h.tipo = 'pedido'
),
sep as (
  select p.*,
         (select count(*) > 0 from jsonb_array_elements_text((select vendedores from cfg)) v
           where lower(v) = lower(p.izq)) as izq_es_vendedor
  from part p
),
norm as (
  select s.*,
         case when s.der is not null then s.izq
              when s.izq_es_vendedor then s.izq end                       as vend_escrito,
         case when s.der is not null then s.der
              when s.izq_es_vendedor then null
              else s.izq end                                              as cliente_cuaderno
  from sep s
),
ali as (
  select n.*, coalesce(a.cliente, n.cliente_cuaderno) as cliente
  from norm n
  left join historico.alias a on lower(a.nombre_cuaderno) = lower(n.cliente_cuaderno)
)
select
  a.id, a.pag, a.fecha, a.dia, a.dia_cuadra,
  a.para          as para_cuaderno,
  a.cliente_cuaderno,
  a.cliente,
  a.sabor, a.pres, a.cant, a.monto, a.pagado,
  a.texto, a.conf, a.duda,

  -- EL VENDEDOR, por orden de firmeza. Nunca se inventa: si nada lo dice, queda null.
  coalesce(a.vend_escrito, hv.vendedor, hc.vendedor)                       as vendedor,
  case
    when a.vend_escrito is not null and a.der is not null then 'escrito en el renglon'
    when a.vend_escrito is not null                        then 'el para ES un vendedor'
    when hv.vendedor is not null then 'encabezado de la pagina (' || hv.conf || ')'
    when hc.vendedor is not null then 'mapa cliente: ' || hc.origen
  end                                                                      as origen_vendedor,
  hc.tipo  as tipo_cliente,
  hc.canal as canal_cliente,

  -- La presentacion: la escrita, o 100g si es tienda y el cuaderno la omitio.
  coalesce(a.pres, case when hc.tipo = 'tienda' then '100g' end)           as pres_resuelta,
  (a.pres is null and hc.tipo = 'tienda')                                  as pres_supuesta,

  -- NO DUPLICAR: desde que arranca la app, estas lineas conviven con `ordenes`.
  (a.fecha >= (select app_arranca from cfg))                               as solapa_con_app
from ali a
left join lateral (
  select v.vendedor, v.conf
  from historico.vendedores v
  where v.pag = a.pag
    and v.fecha is not distinct from a.fecha
    and lower(v.cliente) = lower(a.cliente_cuaderno)
    and v.vendedor is not null
  order by case v.conf when 'alta' then 1 when 'media' then 2 else 3 end
  limit 1
) hv on true
left join lateral (
  select c.vendedor, c.origen, c.tipo, c.canal
  from historico.clientes c
  where lower(c.cliente) = lower(a.cliente)
    and (c.vigente_desde is null or a.fecha >= c.vigente_desde)
    and (c.vigente_hasta is null or a.fecha <= c.vigente_hasta)
  order by c.vigente_desde nulls last
  limit 1
) hc on true;

comment on view bi.h_pedidos is
  'Lineas de pedido del cuaderno, con vendedor y cliente resueltos. `origen_vendedor` dice '
  'de donde salio cada atribucion: un tablero NO debe tratar igual lo escrito en el renglon '
  'que lo que Abraham recordo en 2026. `solapa_con_app` = true: no sumar, ya esta en `ordenes`.';

-- ---------------------------------------------------------------------------
-- bi.h_produccion — la jornada de freido
-- ---------------------------------------------------------------------------
create or replace view bi.h_produccion as
select
  h.fecha,
  to_char(h.fecha, 'Day')                                        as dia_semana,
  max(h.cant) filter (where h.cant is not null)                  as kg,
  max(substring(h.texto from '(\d{1,2}:\d{2})'))                 as hora_inicio,
  max(substring(h.texto from '\d{1,2}:\d{2}\s*[-–]\s*(\d{1,2}:\d{2})')) as hora_fin,
  bool_or(h.duda like 'CONFLICTO%')                              as peso_en_duda,
  string_agg(h.texto, ' | ' order by h.id)                       as texto
from historico.hechos h
where h.tipo = 'produccion'
group by h.fecha;

comment on view bi.h_produccion is
  'Una fila por jornada de freido. Las horas vienen en reloj de casa (la de fin siempre es '
  'de la tarde), asi que para restar hay que sumarle 12 h cuando es menor que 7. '
  'peso_en_duda marca la p.44, donde los renglones no suman el total escrito.';

-- ---------------------------------------------------------------------------
-- bi.h_venta_local — el mostrador, EN PESOS
-- ---------------------------------------------------------------------------
create or replace view bi.h_venta_local as
select h.id, h.pag, h.fecha, h.dia, h.sabor, h.monto, h.texto, h.conf, h.duda,
       false as solapa_con_app   -- la app tiene UN registro de mostrador: aqui no hay solape
from historico.hechos h
where h.tipo = 'venta_local';

comment on view bi.h_venta_local is
  'EN PESOS, no en piezas: en el mostrador pedian "$10, $15, $20 de papa", asi que la '
  'cantidad NO EXISTE en la fuente. Convertirla a piezas es una estimacion y no se guarda. '
  'El ticket mas repetido es $27 (88 de 209), que es una pieza de 100g.';

-- ---------------------------------------------------------------------------
-- bi.h_gastos y bi.h_caja
-- ---------------------------------------------------------------------------
create or replace view bi.h_gastos as
select h.id, h.pag, h.fecha, h.monto, h.texto, h.conf, h.duda,
  case
    when h.texto ~* 'gas'                                  then 'gas'
    when h.texto ~* 'bolsa'                                then 'bolsas'
    when h.texto ~* 'jabon|cloro|fabuloso|sanitas|papel'   then 'limpieza'
    when h.texto ~* 'coca|leche'                           then 'bebidas_reventa'
    when h.texto ~* 'fumig'                                then 'fumigacion'
    when h.texto ~* '\msal\M'                              then 'sal'
    else 'otros'
  end as categoria,
  false as solapa_con_app   -- la app tiene UN gasto: aqui no hay solape
from historico.hechos h
where h.tipo = 'compra';

comment on view bi.h_gastos is
  'OJO: la papa y el aceite NO estan en el cuaderno. Esto es lo que compraba la persona '
  'de la caja chica, no el costo de producir.';

create or replace view bi.h_caja as
select h.id, h.pag, h.fecha, h.monto, h.texto, h.conf, h.duda,
  case when h.texto ~* 'total'   then 'total'
       when h.texto ~* 'billet'  then 'billetes'
       when h.texto ~* 'moneda'  then 'monedas'
       else 'sin_etiqueta' end as concepto,
  (h.fecha >= (select (valor #>> '{}')::date from historico.supuestos where clave = 'app_arranca'))
    as solapa_con_app
from historico.hechos h
where h.tipo = 'caja';

comment on view bi.h_caja is
  'El concepto "total" NO se suma con billetes y monedas: hay renglones como '
  '"Total: 1380 (billetes+monedas)" que contarian dos veces.';

-- ---------------------------------------------------------------------------
-- bi.h_inventario — lo que quedaba armado en el local
-- ---------------------------------------------------------------------------
create or replace view bi.h_inventario as
select h.id, h.pag, h.fecha, h.sabor, h.pres, h.cant, h.texto, h.conf, h.duda
from historico.hechos h
where h.tipo = 'inventario';

-- ---------------------------------------------------------------------------
-- Cerrado igual que las tablas (regla 41).
-- ---------------------------------------------------------------------------
revoke all on bi.h_pedidos, bi.h_produccion, bi.h_venta_local,
              bi.h_gastos, bi.h_caja, bi.h_inventario from public;
grant select on bi.h_pedidos, bi.h_produccion, bi.h_venta_local,
                bi.h_gastos, bi.h_caja, bi.h_inventario to service_role;
