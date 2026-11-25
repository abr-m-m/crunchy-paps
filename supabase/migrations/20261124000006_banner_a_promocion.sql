-- 24 nov 2026 — Un banner apunta a una PROMOCION, no a un sabor escrito a mano.
--
-- Esta es la pregunta con la que nacio el frente de promociones, y la cicatriz
-- que la provoco: `banners.json` pedia el sabor «Natural» cuando en la base
-- dice «Naturales». Cinco meses y medio mandando al sabor equivocado, y nadie
-- lo vio porque la app se cura sola -si el filtro no existe te deja en otro
-- sabor, sin decir nada-.
--
-- El destino `producto` NUNCA se rompio, y no es casualidad: se guarda por ID.
-- Un id no se escribe mal; un nombre si, y encima se puede renombrar.
--
-- Asi que un banner de promocion guarda `promocionId`, y es LA PROMOCION la
-- que sabe donde aterriza (`promociones.aterriza_en`, que ya existe). El
-- banner deja de nombrar sabores: renombrar un sabor ya no puede romperlo, y
-- cambiar a que productos aplica la promocion tampoco, porque el banner no
-- repite esa lista.
--
-- LO QUE HACE ESTA MIGRACION, que es poco: `catalogo_promociones` ya decia,
-- producto por producto, que promocion gana. Ahora dice ademas, UNA vez por
-- promocion viva, su nombre y donde aterriza. Con eso la app puede resolver el
-- clic sin preguntar nada mas y sin guardar un solo texto en el banner.
--
-- LAS DOS SALEN DE LA MISMA CONSULTA (un CTE), no de dos consultas parecidas:
-- si se separaran, un dia la lista de promociones vivas diria una cosa y los
-- precios otra (regla 63).
--
-- LO QUE NO HACE: la seccion «Promociones» del consumidor no existe todavia
-- (pieza L2, a medias: la administracion esta hecha, la mitad del consumidor
-- no). Una promocion con `aterriza_en = 'promocion'` aterriza, por ahora, en
-- el catalogo filtrado por lo que esa promocion cubre de verdad. Es una
-- degradacion dicha en voz alta, no un olvido: el banner ya no puede mentir
-- sobre un sabor, que es el fallo que esto viene a cerrar.

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
             pr.tipo, pr.valor, pr.nombre, pr.aterriza_en
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
      -- Nuevo: una fila por promocion viva, para que un banner pueda apuntar
      -- a ella por ID y la promocion decida donde cae el clic.
      'promociones', coalesce((
        select jsonb_agg(distinct jsonb_build_object(
                 'id', v.id_promocion, 'nombre', v.nombre,
                 'aterriza', coalesce(v.aterriza_en, 'promocion')))
          from vivas v), '[]'::jsonb))
  );
end;
$fn$;
revoke all on function public.catalogo_promociones(jsonb) from public, anon;
grant execute on function public.catalogo_promociones(jsonb) to anon, authenticated;

commit;
