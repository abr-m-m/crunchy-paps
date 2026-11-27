-- 26 nov 2026 — La pestaña «En promoción» necesita saber hasta cuándo.
--
-- `catalogo_promociones` ya devolvia, desde el 24 nov, una fila por promocion
-- viva con su id, su nombre y donde aterriza. Para pintar la banda de la
-- pestaña nueva faltan dos datos que el cliente SI necesita ver: el descuento
-- y la fecha en que se acaba.
--
-- Es aditivo: la clave `promos` -la que decide los precios- no se toca, y las
-- dos listas siguen saliendo del MISMO CTE, que es lo que impide que un dia
-- digan cosas distintas (regla 63).
--
-- POR QUE LA FECHA Y NO UN CONTADOR: «hasta el 30 de noviembre» es un hecho
-- que no envejece mal. «Quedan 3 dias» obliga a que el navegador calcule, y
-- entonces hay dos relojes -el del telefono y el del servidor- que no siempre
-- dicen lo mismo. El servidor manda la fecha; la app la escribe.

begin;

create or replace function public.catalogo_promociones(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_nivel text := lower(coalesce(p_data->>'nivel', 'consumidor'));
  v_tel   text;
  v_cli   bigint;
begin
  -- El cliente sale de SU sesion, nunca de un id que mande el navegador: un
  -- id a mano seria «dime las promociones de otra persona».
  v_tel := public.resolver_sesion_cliente(p_data->>'tokenCliente');
  if v_tel is not null then
    select c.id into v_cli from public.clientes c
     where right(regexp_replace(coalesce(c.telefono,''), '\D', '', 'g'), 10)
         = right(regexp_replace(v_tel, '\D', '', 'g'), 10)
     limit 1;
  end if;

  return (
    with vivas as (
      select p.id        as id_producto,
             m.id_promocion,
             m.precio_unitario,
             pr.tipo, pr.valor, pr.nombre, pr.aterriza_en, pr.hasta
        from public.productos p
        cross join lateral public.promocion_mejor(p.id, v_nivel, current_date, v_cli) m
        join public.promociones pr on pr.id = m.id_promocion
       where coalesce(p.activo, true) and not coalesce(p.descontinuado, false)
         and m.id_promocion is not null
    )
    select jsonb_build_object(
      'ok', true, 'nivel', v_nivel,
      -- Lo de siempre: que paga cada producto.
      'promos', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'idProducto', v.id_producto, 'idPromocion', v.id_promocion,
                 'precio', v.precio_unitario,
                 'tipo', v.tipo,
                 'pct', case when v.tipo = 'porcentaje' then round(v.valor, 0) end,
                 'nombre', v.nombre))
          from vivas v), '[]'::jsonb),
      -- Una fila por promocion viva: para el banner que apunta por id y para
      -- la banda de la pestaña «En promocion».
      'promociones', coalesce((
        select jsonb_agg(distinct jsonb_build_object(
                 'id', v.id_promocion, 'nombre', v.nombre,
                 'aterriza', coalesce(v.aterriza_en, 'promocion'),
                 'tipo', v.tipo,
                 'pct', case when v.tipo = 'porcentaje' then round(v.valor, 0) end,
                 'hasta', v.hasta))
          from vivas v), '[]'::jsonb))
  );
end;
$fn$;
revoke all on function public.catalogo_promociones(jsonb) from public, anon;
grant execute on function public.catalogo_promociones(jsonb) to anon, authenticated;

commit;
