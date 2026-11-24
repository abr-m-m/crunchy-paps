-- 24 nov 2026 — Un solo redondeo para el precio promocional.
--
-- LO QUE ABRAHAM VIO: configuró una promoción del 5 % y la tarjeta del
-- producto decía 6 %. Medido en producción: Adobada Hot 100 g, lista $32.
--
--   lo que COBRA el servidor (promocion_mejor)  → $30      (round a pesos)
--   lo que ENSEÑA la consola (promocion_margen) → $30.40   (round a 2 decimales)
--   descuento real sobre $32                    → 6.25 %
--
-- Dos cosas mal, y la segunda es la cara:
--
--  1. La consola enseñaba un precio que NADIE paga, y por tanto un margen que
--     no era el real. La pantalla que existe para que no se venda con pérdida
--     estaba calculando sobre el número equivocado.
--  2. El porcentaje de la tarjeta se recalculaba desde el precio ya redondeado,
--     asi que decia 6 % cuando el dueño habia escrito 5.
--
-- Es la regla 63 otra vez: dos funciones que responden lo mismo acaban
-- respondiendo distinto. Ahora el precio promocional lo decide UNA funcion,
-- `precio_promocional`, y las dos la llaman.
--
-- El precio que paga el cliente NO cambia: sigue siendo $30. Lo que cambia es
-- que la consola deja de mentir y que el porcentaje de la tarjeta vuelve a ser
-- el que se configuro.

begin;

-- ── 1. La unica regla de redondeo ─────────────────────────────────────────
-- Pesos ENTEROS para un porcentaje, igual que `descuento_pct` en crear_pedido
-- y que `Math.round` en la app: los precios de esta casa son enteros.
create or replace function public.precio_promocional(p_base numeric, p_tipo text, p_valor numeric)
returns numeric language sql immutable as $fn$
  select case
           when p_base is null or p_valor is null then null
           when p_tipo = 'precio_fijo' then round(p_valor, 2)
           else round(p_base * (1 - p_valor / 100.0))
         end;
$fn$;
revoke all on function public.precio_promocional(numeric, text, numeric) from public, anon, authenticated;
comment on function public.precio_promocional(numeric, text, numeric) is
  'El precio de una promocion, en UN solo sitio. Lo llaman promocion_mejor (lo que se cobra) y promocion_margen (lo que ve el dueño). 24 nov 2026.';

-- ── 2. Lo que se cobra ────────────────────────────────────────────────────
create or replace function public.promocion_mejor(p_id_producto bigint, p_nivel text, p_fecha date)
returns table (id_promocion bigint, precio_unitario numeric)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_p     productos%rowtype;
  v_base  numeric;
  v_grupo text;
begin
  if p_id_producto is null then return; end if;
  select * into v_p from public.productos where id = p_id_producto;
  if v_p.id is null or not coalesce(v_p.activo, true) or coalesce(v_p.descontinuado, false) then return; end if;

  -- El mayorista nunca entra en promociones, igual que en el Club y en los
  -- retos: ya compra al precio mas bajo de la casa.
  v_grupo := case lower(coalesce(p_nivel, 'consumidor'))
               when 'tienda' then 'tiendas'
               when 'restaurante' then 'tiendas'
               when 'mayorista' then null
               else 'consumidores' end;
  if v_grupo is null then return; end if;

  v_base := case lower(coalesce(p_nivel, 'consumidor'))
              when 'tienda'      then v_p.precio_tienda
              when 'restaurante' then v_p.precio_restaurante
              when 'mostrador'   then v_p.precio_mostrador
              else v_p.precio_consumidor end;
  if v_base is null then return; end if;

  return query
  select pr.id, public.precio_promocional(v_base, pr.tipo, pr.valor) as precio
    from public.promociones pr
   where pr.activa
     and pr.tipo in ('porcentaje', 'precio_fijo')
     and coalesce(p_fecha, current_date) between pr.desde and pr.hasta
     and (pr.publico = 'todos' or pr.publico = v_grupo)
     and exists (
       select 1 from public.promocion_items i
        where i.id_promocion = pr.id
          and ((i.id_producto is not null and i.id_producto = v_p.id)
            or (i.id_producto is null
                and (coalesce(i.sabor, '') = '' or i.sabor = v_p.sabor)
                and (coalesce(i.presentacion, '') = '' or i.presentacion = v_p.presentacion))))
   order by precio asc, pr.id asc
   limit 1;
end;
$fn$;
revoke all on function public.promocion_mejor(bigint, text, date) from public, anon, authenticated;

-- ── 3. Lo que ve el dueño, con el MISMO precio ────────────────────────────
create or replace function public.promocion_margen(p_promocion bigint)
returns table (
  id_producto bigint, sabor text, presentacion text, canal text,
  precio_lista numeric, precio_promo numeric, costo numeric, margen_pct numeric
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  pr public.promociones%rowtype;
begin
  select * into pr from public.promociones where id = p_promocion;
  if pr.id is null then return; end if;

  return query
  with canales as (
    select c.canal from (values ('consumidor'), ('tienda')) as c(canal)
    where (pr.publico = 'todos')
       or (pr.publico = 'consumidores' and c.canal = 'consumidor')
       or (pr.publico = 'tiendas'      and c.canal = 'tienda')
  ),
  skus as (
    select distinct p.*
      from public.promocion_items i
      join public.productos p
        on (i.id_producto is not null and p.id = i.id_producto)
        or (i.id_producto is null
            and (coalesce(i.sabor, '') = '' or p.sabor = i.sabor)
            and (coalesce(i.presentacion, '') = '' or p.presentacion = i.presentacion))
     where i.id_promocion = p_promocion
       and coalesce(p.activo, true) and not coalesce(p.descontinuado, false)
  ),
  base as (
    select s.id, s.sabor, s.presentacion, c.canal,
           case c.canal when 'tienda' then s.precio_tienda else s.precio_consumidor end as lista
      from skus s cross join canales c
  )
  select b.id, b.sabor, b.presentacion, b.canal,
         round(b.lista, 2) as precio_lista,
         v.promo as precio_promo,
         round(ct.costo, 2) as costo,
         case when v.promo > 0 and ct.costo is not null
              then round((v.promo - ct.costo) / v.promo * 100, 1) end as margen_pct
    from base b
    -- El MISMO precio que se va a cobrar. Antes aqui habia un `round(...,2)`
    -- propio, y por eso la consola enseñaba $30.40 de un producto que se
    -- cobra a $30: el margen salia calculado sobre un precio inexistente.
    cross join lateral (select public.precio_promocional(b.lista, pr.tipo, pr.valor) as promo) v
    cross join lateral (select public.costo_sku(b.id, current_date) as costo) ct
   where b.lista is not null;
end;
$fn$;
revoke all on function public.promocion_margen(bigint) from public, anon, authenticated;

-- ── 4. Lo que la app pinta: tambien el PORCENTAJE que se configuro ────────
-- La tarjeta decia 6 % porque lo recalculaba desde el precio redondeado. El
-- numero que se enseña es el que el dueño escribio; el redondeo a pesos cae
-- siempre a favor del cliente, asi que nadie paga de mas por verlo.
create or replace function public.catalogo_promociones(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v_nivel text := lower(coalesce(p_data->>'nivel', 'consumidor'));
begin
  return jsonb_build_object('ok', true, 'nivel', v_nivel, 'promos', coalesce((
    select jsonb_agg(jsonb_build_object(
             'idProducto', p.id, 'idPromocion', m.id_promocion,
             'precio', m.precio_unitario,
             'tipo', pr.tipo,
             'pct', case when pr.tipo = 'porcentaje' then round(pr.valor, 0) end,
             'nombre', pr.nombre))
      from public.productos p
      cross join lateral public.promocion_mejor(p.id, v_nivel, current_date) m
      join public.promociones pr on pr.id = m.id_promocion
     where coalesce(p.activo, true) and not coalesce(p.descontinuado, false)
       and m.id_promocion is not null), '[]'::jsonb));
end;
$fn$;
revoke all on function public.catalogo_promociones(jsonb) from public, anon;
grant execute on function public.catalogo_promociones(jsonb) to anon, authenticated;

commit;
