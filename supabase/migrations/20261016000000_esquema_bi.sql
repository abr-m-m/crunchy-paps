-- 20261016000000_esquema_bi.sql
-- El esquema de analisis (cambios/2026-09-23-costeo-y-margen/diseno.md §3).
--
-- Va aparte de `public` para que nada de la app dependa de el: se puede reorganizar sin romper una
-- pantalla, y una vista rota por un cambio en `public` se ve al desplegar y no un lunes al abrir
-- Power BI.
--
-- LA REGLA QUE SOSTIENE TODO: margen, venta neta y kg se calculan AQUI, nunca en una medida de
-- Power BI. En cuanto Power BI recalcule el margen por su cuenta habra dos cifras del mismo
-- concepto y ninguna forma de saber cual vale. Ya paso con bruto contra neto (CLAUDE.md §4).

create schema if not exists bi;

-- ── f_ventas: UNA fila por linea de pedido. La unica que define «venta real» ─
-- Todo lo demas hereda esa definicion de aqui.
--
-- EL CUPON: vive en ordenes.descuento, a nivel de PEDIDO, y ordenes_detalle.descuento esta en 0 en
-- las 182 lineas de produccion (el descuento de linea nunca se ha usado). Para que el margen por
-- SKU sea honesto hay que repartirlo, asi que se prorratea por peso de la linea dentro de su
-- pedido. La prueba de calibracion comprueba que el reparto no pierde ni inventa centavos.
create or replace view bi.f_ventas as
with pedidos as (
  select o.id, o.consecutivo, o.fecha_orden, o.canal, o.id_cliente, o.id_vendedor, o.id_ruta,
         o.metodo_entrega, o.estatus_pedido, o.estatus_pago, o.fecha_entrega, o.fecha_entrega_real,
         coalesce(o.descuento, 0) desc_pedido,
         nullif((select sum(d.subtotal) from public.ordenes_detalle d where d.id_orden = o.id), 0) base
    from public.ordenes o
   where coalesce(o.tipo_interno, '') = ''        -- los internos no son venta (CLAUDE.md §4)
     and o.estatus_pedido <> 'Cancelado')
select d.id                      as id_linea,
       p.id                      as id_orden,
       p.consecutivo,
       p.fecha_orden::date       as fecha,
       p.canal,
       p.id_cliente,
       p.id_vendedor,
       p.id_ruta,
       p.metodo_entrega,
       p.estatus_pedido,
       p.estatus_pago,
       p.fecha_entrega::date     as fecha_prometida,
       p.fecha_entrega_real::date as fecha_entregada,
       d.id_producto,
       d.sabor,
       d.presentacion,
       d.tipo_venta,
       d.cantidad,
       public.kg_de_linea(d.tipo_venta, d.presentacion, d.cantidad, d.gramos_vendidos) as kg,
       d.subtotal                as subtotal_linea,
       round(p.desc_pedido * (d.subtotal / p.base), 2) as descuento_prorrateado,
       d.subtotal - round(p.desc_pedido * (d.subtotal / p.base), 2) as neto,
       d.costo_unitario,
       d.costo_origen,
       case when d.costo_unitario is null then null
            else round(d.cantidad * d.costo_unitario, 2) end as costo_total,
       -- NULL cuando no hay costo, NUNCA el neto entero: un margen del 100 % por costo ausente se
       -- lee como ganancia perfecta y es peor que no tener el dato (D12).
       case when d.costo_unitario is null then null
            else d.subtotal - round(p.desc_pedido * (d.subtotal / p.base), 2)
                            - round(d.cantidad * d.costo_unitario, 2) end as margen,
       coalesce(d.puntos_canje, 0) > 0 as es_canje
  from public.ordenes_detalle d
  join pedidos p on p.id = d.id_orden;

-- ── Dimensiones ─────────────────────────────────────────────────────────────
create or replace view bi.d_producto as
select p.id, p.sabor, p.presentacion, p.gramos, p.tipo_venta, p.activo, p.descontinuado,
       p.precio_consumidor, p.precio_tienda, p.precio_restaurante, p.precio_mostrador,
       p.precio_mayorista, p.precio_granel_kg, p.precio_caja_3, p.precio_caja_6, p.precio_caja_12
  from public.productos p;

-- SIN telefono, SIN direccion, SIN coordenadas (D7). Se escribe columna por columna a proposito:
-- un `select *` traeria el telefono el dia que alguien anada una columna, y nadie se enteraria.
create or replace view bi.d_cliente as
select c.id, c.tipo, c.cp, c.colonia, c.municipio, c.estado, c.id_vendedor, c.id_ruta,
       c.aprobado_b2b, c.fecha_creacion::date as fecha_alta, c.acepta_promos
  from public.clientes c;

create or replace view bi.d_vendedor as
select v.id, v.nombre, v.rol, v.activo, v.fecha_alta::date as fecha_alta
  from public.vendedores v;

create or replace view bi.d_ruta as
select r.id, r.nombre, r.activa, r.dias, r.dias_preventa, r.id_vendedor
  from public.rutas r;

-- Calendario. Hay que GENERARLO: sin el, ninguna comparacion contra el periodo anterior funciona
-- en Power BI.
create or replace view bi.d_fecha as
select d::date                       as fecha,
       extract(year  from d)::int    as anio,
       extract(month from d)::int    as mes,
       to_char(d, 'YYYY-MM')         as anio_mes,
       extract(week  from d)::int    as semana,
       extract(isodow from d)::int   as dia_semana,
       d::date = date_trunc('month', d)::date as es_inicio_mes,
       d::date in ('2026-01-01','2026-02-02','2026-03-16','2026-05-01','2026-09-16',
                   '2026-11-16','2026-12-25','2027-01-01','2027-02-01','2027-03-15',
                   '2027-05-01','2027-09-16','2027-11-15','2027-12-25') as es_festivo
  from generate_series('2026-01-01'::date, '2028-12-31'::date, '1 day') d;

-- ── Gastos, con la marca fijo/variable ──────────────────────────────────────
create or replace view bi.f_gastos as
select g.id, g.fecha::date as fecha, g.categoria, g.subcategoria, g.descripcion, g.monto,
       g.metodo_pago, g.proveedor, g.tiene_factura, g.estatus, g.id_vendedor,
       coalesce(c.es_fijo, false) as es_fijo
  from public.gastos g
  left join public.gastos_categorias c on c.categoria = g.categoria;

-- ── Caja ────────────────────────────────────────────────────────────────────
create or replace view bi.f_caja as
select m.id, m.fecha::date as fecha, m.tipo, m.monto, m.id_orden, m.consecutivo_pedido,
       m.id_gasto, m.id_punto, p.codigo as punto, p.nombre as punto_nombre,
       m.id_caja_dia, m.id_mov_pareja, m.actor
  from public.caja_movimientos m
  left join public.caja_puntos p on p.id = m.id_punto;

-- ── Costo vigente por SKU ───────────────────────────────────────────────────
create or replace view bi.v_costo_sku as
select p.id as id_producto, p.sabor, p.presentacion, p.gramos,
       public.costo_sku(p.id, current_date) as costo_hoy,
       p.precio_consumidor, p.precio_tienda, p.precio_mayorista
  from public.productos p
 where p.activo and coalesce(p.descontinuado, false) = false;

-- ── Punto de equilibrio ─────────────────────────────────────────────────────
-- La mitad de D2 que vive FUERA del costo por kg: los fijos no se prorratean al kg, se comparan
-- contra el margen de contribucion del mes.
create or replace view bi.v_punto_equilibrio as
with fijos as (
  select date_trunc('month', g.fecha)::date as mes, sum(g.monto) as fijos_mes
    from public.gastos g
    join public.gastos_categorias c on c.categoria = g.categoria and c.es_fijo
   where coalesce(g.estatus, 'aprobado') <> 'rechazado'
   group by 1),
contrib as (
  select date_trunc('month', v.fecha)::date as mes,
         sum(v.neto) as neto_mes,
         sum(v.costo_total) as costo_mes,
         count(*) filter (where v.costo_total is null) as lineas_sin_costear
    from bi.f_ventas v
   group by 1)
select coalesce(f.mes, c.mes) as mes, f.fijos_mes, c.neto_mes, c.costo_mes,
       c.neto_mes - c.costo_mes as margen_contribucion, c.lineas_sin_costear,
       -- NULL, no cero, si el mes tiene lineas sin costear: el margen de contribucion saldria
       -- inflado y la venta de equilibrio demasiado baja. Un numero optimista con cara de exacto.
       case when c.lineas_sin_costear > 0 or c.neto_mes is null or c.neto_mes = 0
              or f.fijos_mes is null then null
            else round(f.fijos_mes / ((c.neto_mes - c.costo_mes) / c.neto_mes), 2)
       end as venta_de_equilibrio
  from fijos f full join contrib c on c.mes = f.mes;

-- ── Desempeno por vendedor ──────────────────────────────────────────────────
-- Las tres metricas con las que se dirige una fuerza de venta a tienda: clientes activos,
-- frecuencia de visita y drop size. La de visitas nacera VACIA: `visitas` tenia 1 fila en tres
-- meses. Se llena en el sub-proyecto 2; hasta entonces es «sin dato», no cero.
create or replace view bi.v_desempeno_vendedor as
with ventas as (
  select v.id_vendedor, date_trunc('month', v.fecha)::date as mes,
         count(distinct v.id_orden) as pedidos,
         count(distinct v.id_cliente) as clientes_activos,
         sum(v.neto) as neto,
         sum(v.margen) as margen,
         count(*) filter (where v.costo_total is null) as lineas_sin_costear
    from bi.f_ventas v group by 1, 2),
vis as (
  select vi.id_vendedor, date_trunc('month', vi.creada_en)::date as mes, count(*) as visitas
    from public.visitas vi group by 1, 2)
select coalesce(ve.id_vendedor, vi.id_vendedor) as id_vendedor,
       coalesce(ve.mes, vi.mes) as mes,
       ve.pedidos, ve.clientes_activos, ve.neto,
       case when ve.lineas_sin_costear > 0 then null else ve.margen end as margen,
       round(ve.neto / nullif(ve.pedidos, 0), 2) as drop_size,
       vi.visitas,
       (select q.cuota from public.cuotas_vendedor q
         where q.id_vendedor = coalesce(ve.id_vendedor, vi.id_vendedor)
           and q.anio = extract(year from coalesce(ve.mes, vi.mes))::int
           and q.mes  = extract(month from coalesce(ve.mes, vi.mes))::int) as cuota
  from ventas ve full join vis vi on vi.id_vendedor = ve.id_vendedor and vi.mes = ve.mes;
