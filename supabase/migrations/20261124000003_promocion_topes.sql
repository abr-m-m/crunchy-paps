-- 24 nov 2026 — Los tres topes de una promocion.
--
-- Dictado por Abraham: «especificar el maximo de promociones aplicables por
-- cliente y total», y en el mismo mensaje «limite de promociones totales
-- efectuadas O PRESUPUESTO asociado a esa promo».
--
-- Son TRES topes distintos, y el tercero es el que de verdad protege:
--
--   limite_por_cliente  cuantas veces la puede usar UNA persona
--   limite_total        cuantas veces se puede usar en total
--   presupuesto         cuanto dinero de descuento puede regalar
--
-- Los dos primeros cuentan pedidos; el tercero cuenta PESOS, y por eso es el
-- que protege el margen: con «50 usos» una promocion cuesta muy distinto
-- segun quien la use. Con un presupuesto, no.
--
-- UN USO ES UN PEDIDO, no una linea. Si alguien compra tres SKU de la misma
-- promocion en un pedido, eso es UN uso. Contar lineas castigaria al que
-- compra mas, que es justo lo contrario de lo que una promocion quiere.
--
-- QUE PASA AL AGOTARSE: la promocion deja de ofrecerse, sin que nadie la
-- apague a mano. La linea vuelve al siguiente mejor precio. Y como la app
-- pinta lo que `catalogo_promociones` le da, la promocion agotada desaparece
-- tambien de la tarjeta: si no, el cliente veria un precio que el servidor ya
-- no cobra y `crear_pedido` le rechazaria el pedido con `precio_cambiado`.
--
-- 1. Las tres columnas.
-- 2. promocion_consumo: lo gastado, medido desde los pedidos (sin tabla de
--    contadores: un contador se desincroniza, los pedidos no).
-- 3. promocion_mejor con el cliente, y los topes aplicados.
-- 4. catalogo_promociones resuelve el cliente de la sesion.
-- 5. promociones_admin y guardar_promocion: ver y poner los topes.

begin;

-- ── 1 ─────────────────────────────────────────────────────────────────────
-- NULL = sin tope. Es lo que tienen las promociones creadas hasta hoy, asi que
-- nada cambia de comportamiento al aplicar esta migracion.
alter table public.promociones
  add column if not exists limite_por_cliente integer check (limite_por_cliente is null or limite_por_cliente > 0),
  add column if not exists limite_total       integer check (limite_total is null or limite_total > 0),
  add column if not exists presupuesto        numeric check (presupuesto is null or presupuesto > 0);

comment on column public.promociones.limite_por_cliente is 'Cuantos PEDIDOS puede hacer un mismo cliente con esta promocion. NULL = sin tope.';
comment on column public.promociones.limite_total       is 'Cuantos PEDIDOS en total. NULL = sin tope.';
comment on column public.promociones.presupuesto        is 'Cuanto dinero de descuento puede regalar en total. NULL = sin tope.';

-- ── 2 ─────────────────────────────────────────────────────────────────────
-- Medido desde los pedidos, no desde un contador. Un contador se desincroniza
-- en cuanto alguien cancela, edita o borra; los pedidos son la verdad.
-- Se cuentan solo las ventas REALES: la condicion estandar de CLAUDE.md §4.
create or replace function public.promocion_consumo(p_promocion bigint)
returns table (usos integer, clientes integer, gastado numeric)
language sql stable security definer set search_path = public, pg_temp as $fn$
  select coalesce(count(distinct d.id_orden), 0)::integer,
         coalesce(count(distinct o.id_cliente), 0)::integer,
         coalesce(sum(d.descuento), 0)::numeric
    from public.ordenes_detalle d
    join public.ordenes o on o.id = d.id_orden
   where d.id_promocion = p_promocion
     and coalesce(o.tipo_interno, '') = ''
     and o.estatus_pedido <> 'Cancelado';
$fn$;
revoke all on function public.promocion_consumo(bigint) from public, anon, authenticated;

create or replace function public.promocion_usos_de(p_promocion bigint, p_cliente bigint)
returns integer
language sql stable security definer set search_path = public, pg_temp as $fn$
  select coalesce(count(distinct d.id_orden), 0)::integer
    from public.ordenes_detalle d
    join public.ordenes o on o.id = d.id_orden
   where d.id_promocion = p_promocion
     and o.id_cliente = p_cliente
     and coalesce(o.tipo_interno, '') = ''
     and o.estatus_pedido <> 'Cancelado';
$fn$;
revoke all on function public.promocion_usos_de(bigint, bigint) from public, anon, authenticated;

-- ── 3 ─────────────────────────────────────────────────────────────────────
-- El cliente es el CUARTO parametro y tiene valor por omision, asi que
-- `crear_pedido` y `cotizar_linea`, que la llaman con tres, siguen valiendo.
--
-- PERO HAY QUE TIRAR LA DE TRES PRIMERO. `create or replace` con una firma
-- distinta no reemplaza: CREA OTRA. Con las dos vivas, una llamada de tres
-- argumentos es ambigua y Postgres aborta con «function ... is not unique»:
-- es decir, dejar la vieja no es inofensivo, rompe el cobro. Visto en staging
-- al correr la primera prueba, antes de que esto se acercara a produccion.
drop function if exists public.promocion_mejor(bigint, text, date);

create or replace function public.promocion_mejor(p_id_producto bigint, p_nivel text, p_fecha date,
                                                  p_id_cliente bigint default null)
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
    cross join lateral public.promocion_consumo(pr.id) c
   where pr.activa
     and pr.tipo in ('porcentaje', 'precio_fijo')
     and coalesce(p_fecha, current_date) between pr.desde and pr.hasta
     and (pr.publico = 'todos' or pr.publico = v_grupo)
     -- LOS TRES TOPES. Un NULL no limita nada.
     and (pr.limite_total is null or c.usos < pr.limite_total)
     and (pr.presupuesto  is null or c.gastado < pr.presupuesto)
     and (pr.limite_por_cliente is null or p_id_cliente is null
          or public.promocion_usos_de(pr.id, p_id_cliente) < pr.limite_por_cliente)
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
revoke all on function public.promocion_mejor(bigint, text, date, bigint) from public, anon, authenticated;

-- ── 4 ─────────────────────────────────────────────────────────────────────
-- La app tiene que ver lo MISMO que el servidor va a cobrar, topes incluidos.
-- Por eso ahora acepta la sesion del cliente: sin ella el tope por cliente no
-- se puede evaluar y la tarjeta podria ofrecer una promocion que al pedir se
-- cae, lo que acaba en `precio_cambiado` y un pedido que no se puede cerrar.
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

  return jsonb_build_object('ok', true, 'nivel', v_nivel, 'promos', coalesce((
    select jsonb_agg(jsonb_build_object(
             'idProducto', p.id, 'idPromocion', m.id_promocion,
             'precio', m.precio_unitario,
             'tipo', pr.tipo,
             'pct', case when pr.tipo = 'porcentaje' then round(pr.valor, 0) end,
             'nombre', pr.nombre))
      from public.productos p
      cross join lateral public.promocion_mejor(p.id, v_nivel, current_date, v_cli) m
      join public.promociones pr on pr.id = m.id_promocion
     where coalesce(p.activo, true) and not coalesce(p.descontinuado, false)
       and m.id_promocion is not null), '[]'::jsonb));
end;
$fn$;
revoke all on function public.catalogo_promociones(jsonb) from public, anon;
grant execute on function public.catalogo_promociones(jsonb) to anon, authenticated;

-- ── 5 ─────────────────────────────────────────────────────────────────────
create or replace function public.promociones_admin(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_piso numeric;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'solo_dueno');
  end if;
  select coalesce((valor->>'piso_margen')::numeric, 15) into v_piso
    from public.config_produccion where clave = 'promociones';

  return jsonb_build_object(
    'ok', true,
    'piso_margen', coalesce(v_piso, 15),
    'promociones', coalesce((
      select jsonb_agg(x order by x->>'nombre')
        from (
          select jsonb_build_object(
                   'id', pr.id, 'nombre', pr.nombre, 'descripcion', pr.descripcion,
                   'imagen', pr.imagen, 'tipo', pr.tipo, 'valor', pr.valor,
                   'publico', pr.publico, 'desde', pr.desde, 'hasta', pr.hasta,
                   'activa', pr.activa, 'acumulable_con_cupon', pr.acumulable_con_cupon,
                   'es_gancho', pr.es_gancho, 'aterriza_en', pr.aterriza_en,
                   'limitePorCliente', pr.limite_por_cliente,
                   'limiteTotal', pr.limite_total,
                   'presupuesto', pr.presupuesto,
                   -- Lo gastado viaja con la promocion, como el margen: es el
                   -- dato con el que se decide si todavia sirve.
                   'consumo', (select to_jsonb(c) from public.promocion_consumo(pr.id) c),
                   'items', coalesce((select jsonb_agg(jsonb_build_object(
                              'id', i.id, 'idProducto', i.id_producto, 'sabor', i.sabor,
                              'presentacion', i.presentacion, 'cantidad', i.cantidad))
                              from public.promocion_items i where i.id_promocion = pr.id), '[]'::jsonb),
                   'tramos', coalesce((select jsonb_agg(jsonb_build_object(
                              'desdeMonto', t.desde_monto, 'valor', t.valor) order by t.desde_monto)
                              from public.promocion_tramos t where t.id_promocion = pr.id), '[]'::jsonb),
                   'margen', coalesce((select jsonb_agg(jsonb_build_object(
                              'idProducto', m.id_producto, 'sabor', m.sabor,
                              'presentacion', m.presentacion, 'canal', m.canal,
                              'precioLista', m.precio_lista, 'precioPromo', m.precio_promo,
                              'costo', m.costo, 'margenPct', m.margen_pct))
                              from public.promocion_margen(pr.id) m), '[]'::jsonb),
                   'usada', exists (select 1 from public.ordenes_detalle d where d.id_promocion = pr.id)
                 ) as x
            from public.promociones pr
        ) s), '[]'::jsonb));
end;
$fn$;
revoke all on function public.promociones_admin(jsonb) from public, anon;
grant execute on function public.promociones_admin(jsonb) to anon, authenticated;

-- guardar_promocion acepta los tres topes. Parchada sobre una copia de la
-- que corre en produccion, no reescrita: lo unico que cambia son cinco
-- sitios -declaracion, lectura, validacion, insert/update y la respuesta-.
CREATE OR REPLACE FUNCTION public.guardar_promocion(p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  j        jsonb := p_data->'promocion';
  v_id     bigint;
  v_act    public.promociones%rowtype;
  v_nombre text; v_tipo text; v_valor numeric; v_pub text; v_desde date; v_hasta date;
  v_activa boolean; v_acum boolean; v_gancho boolean; v_aterriza text; v_desc text; v_img text;
  v_items  jsonb; v_tramos jsonb; v_item jsonb;
  v_piso   numeric; v_peor numeric; v_actor text;
  v_lpc integer; v_lt integer; v_pres numeric;
  v_n      integer;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'solo_dueno');
  end if;
  if j is null or jsonb_typeof(j) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'falta', 'mensaje', 'Falta la promoción.');
  end if;

  v_id := nullif(j->>'id', '')::bigint;
  if v_id is not null then
    select * into v_act from public.promociones where id = v_id;
    if v_act.id is null then return jsonb_build_object('ok', false, 'error', 'no_existe', 'mensaje', 'Esa promoción no existe.'); end if;
  end if;

  v_nombre   := coalesce(nullif(trim(j->>'nombre'), ''), v_act.nombre);
  v_desc     := coalesce(j->>'descripcion', v_act.descripcion, '');
  v_img      := coalesce(nullif(trim(j->>'imagen'), ''), v_act.imagen);
  v_tipo     := coalesce(nullif(lower(trim(j->>'tipo')), ''), v_act.tipo);
  v_pub      := coalesce(nullif(lower(trim(j->>'publico')), ''), v_act.publico, 'todos');
  v_aterriza := coalesce(nullif(lower(trim(j->>'aterrizaEn')), ''), v_act.aterriza_en, 'promocion');
  v_activa   := coalesce((j->>'activa')::boolean, v_act.activa, true);
  v_acum     := coalesce((j->>'acumulableConCupon')::boolean, v_act.acumulable_con_cupon, false);
  v_gancho   := coalesce((j->>'esGancho')::boolean, v_act.es_gancho, false);
  begin v_valor := coalesce(nullif(j->>'valor', '')::numeric, v_act.valor); exception when others then v_valor := null; end;
  -- Los tres topes. Mandar la clave vacia los QUITA (sin tope); no mandarla
  -- los deja como estaban, que es lo que hace el resto de esta funcion.
  begin
    v_lpc  := case when j ? 'limitePorCliente' then nullif(j->>'limitePorCliente','')::integer else v_act.limite_por_cliente end;
    v_lt   := case when j ? 'limiteTotal'      then nullif(j->>'limiteTotal','')::integer      else v_act.limite_total end;
    v_pres := case when j ? 'presupuesto'      then nullif(j->>'presupuesto','')::numeric      else v_act.presupuesto end;
  exception when others then
    v_lpc := v_act.limite_por_cliente; v_lt := v_act.limite_total; v_pres := v_act.presupuesto;
  end;
  if v_lpc is not null and v_lpc <= 0 then return jsonb_build_object('ok', false, 'error', 'limite', 'mensaje', 'El limite por cliente debe ser mayor que 0.'); end if;
  if v_lt  is not null and v_lt  <= 0 then return jsonb_build_object('ok', false, 'error', 'limite', 'mensaje', 'El limite total debe ser mayor que 0.'); end if;
  if v_pres is not null and v_pres <= 0 then return jsonb_build_object('ok', false, 'error', 'limite', 'mensaje', 'El presupuesto debe ser mayor que 0.'); end if;
  begin
    v_desde := coalesce(nullif(j->>'desde', '')::date, v_act.desde);
    v_hasta := coalesce(nullif(j->>'hasta', '')::date, v_act.hasta);
  exception when others then v_desde := null; v_hasta := null; end;

  if v_nombre is null then return jsonb_build_object('ok', false, 'error', 'nombre', 'mensaje', 'Ponle nombre.'); end if;
  if v_tipo is null or v_tipo not in ('porcentaje', 'precio_fijo', 'paquete') then
    return jsonb_build_object('ok', false, 'error', 'tipo', 'mensaje', 'Tipo: porcentaje, precio_fijo o paquete.');
  end if;
  if v_valor is null or v_valor <= 0 then return jsonb_build_object('ok', false, 'error', 'valor', 'mensaje', 'El valor debe ser mayor que 0.'); end if;
  if v_tipo in ('porcentaje', 'paquete') and v_valor > 100 then
    return jsonb_build_object('ok', false, 'error', 'valor', 'mensaje', 'Un porcentaje no pasa de 100.');
  end if;
  if v_desde is null or v_hasta is null or v_hasta < v_desde then
    return jsonb_build_object('ok', false, 'error', 'fechas', 'mensaje', 'Fechas AAAA-MM-DD, y «hasta» no antes de «desde».');
  end if;

  v_items  := coalesce(j->'items', '[]'::jsonb);
  v_tramos := coalesce(j->'tramos', '[]'::jsonb);
  if jsonb_typeof(v_items) <> 'array' then v_items := '[]'::jsonb; end if;

  -- Si no vienen items y la promocion ya existe, se conservan los suyos.
  if jsonb_array_length(v_items) = 0 and v_id is not null then
    v_items := coalesce((select jsonb_agg(jsonb_build_object(
                 'idProducto', i.id_producto, 'sabor', i.sabor,
                 'presentacion', i.presentacion, 'cantidad', i.cantidad))
                 from public.promocion_items i where i.id_promocion = v_id), '[]'::jsonb);
  end if;
  if jsonb_array_length(v_items) = 0 then
    return jsonb_build_object('ok', false, 'error', 'items', 'mensaje', 'Di a qué productos aplica.');
  end if;
  if v_tipo = 'paquete' and jsonb_array_length(v_items) < 2 then
    return jsonb_build_object('ok', false, 'error', 'items', 'mensaje', 'Un paquete lleva al menos dos productos.');
  end if;

  -- Cada item, contra la base. Mismo criterio que /api/banners: un nombre que
  -- no existe no se guarda, porque falla en silencio meses despues.
  for v_item in select * from jsonb_array_elements(v_items) loop
    if nullif(v_item->>'idProducto', '') is not null then
      if not exists (select 1 from public.productos p where p.id = (v_item->>'idProducto')::bigint
                       and coalesce(p.activo, true) and not coalesce(p.descontinuado, false)) then
        return jsonb_build_object('ok', false, 'error', 'item', 'mensaje', 'Un producto de la lista no existe o está dado de baja.');
      end if;
    elsif v_tipo = 'paquete' then
      return jsonb_build_object('ok', false, 'error', 'item', 'mensaje', 'En un paquete cada producto se elige uno por uno.');
    else
      if coalesce(v_item->>'sabor', '') <> '' and not exists (select 1 from public.productos p where p.sabor = v_item->>'sabor') then
        return jsonb_build_object('ok', false, 'error', 'item', 'mensaje', 'El sabor «' || (v_item->>'sabor') || '» no existe en el catálogo.');
      end if;
      if coalesce(v_item->>'presentacion', '') <> '' and not exists (select 1 from public.productos p where p.presentacion = v_item->>'presentacion') then
        return jsonb_build_object('ok', false, 'error', 'item', 'mensaje', 'La presentación «' || (v_item->>'presentacion') || '» no existe.');
      end if;
    end if;
  end loop;

  select coalesce(v.nombre, 'alguien') into v_actor
    from public.resolver_sesion_vendedor(p_data->>'token') s
    join public.vendedores v on v.id = s.id_vendedor;

  if v_id is null then
    insert into public.promociones (nombre, descripcion, imagen, tipo, valor, publico, desde, hasta,
                                    activa, acumulable_con_cupon, es_gancho, aterriza_en, creado_por,
                                    limite_por_cliente, limite_total, presupuesto)
    values (v_nombre, v_desc, v_img, v_tipo, v_valor, v_pub, v_desde, v_hasta,
            v_activa, v_acum, v_gancho, v_aterriza, v_actor,
            v_lpc, v_lt, v_pres)
    returning id into v_id;
  else
    update public.promociones
       set nombre = v_nombre, descripcion = v_desc, imagen = v_img, tipo = v_tipo, valor = v_valor,
           publico = v_pub, desde = v_desde, hasta = v_hasta, activa = v_activa,
           acumulable_con_cupon = v_acum, es_gancho = v_gancho, aterriza_en = v_aterriza,
           limite_por_cliente = v_lpc, limite_total = v_lt, presupuesto = v_pres,
           actualizado_en = now()
     where id = v_id;
  end if;

  delete from public.promocion_items where id_promocion = v_id;
  insert into public.promocion_items (id_promocion, id_producto, sabor, presentacion, cantidad)
  select v_id, nullif(e->>'idProducto', '')::bigint, nullif(e->>'sabor', ''), nullif(e->>'presentacion', ''),
         greatest(1, coalesce(nullif(e->>'cantidad', '')::integer, 1))
    from jsonb_array_elements(v_items) e;

  delete from public.promocion_tramos where id_promocion = v_id;
  if jsonb_typeof(v_tramos) = 'array' then
    insert into public.promocion_tramos (id_promocion, desde_monto, valor)
    select v_id, (e->>'desdeMonto')::numeric, (e->>'valor')::numeric
      from jsonb_array_elements(v_tramos) e
     where nullif(e->>'desdeMonto','') is not null and nullif(e->>'valor','') is not null;
  end if;

  -- D4: el margen se mira SIEMPRE, y manda. Se calcula despues de guardar los
  -- items porque es lo que define que SKU toca; si no pasa el piso, se
  -- deshace la transaccion entera.
  select coalesce((valor->>'piso_margen')::numeric, 15) into v_piso
    from public.config_produccion where clave = 'promociones';
  v_piso := coalesce(v_piso, 15);
  select min(m.margen_pct), count(*) into v_peor, v_n from public.promocion_margen(v_id) m;

  if v_n = 0 then
    raise exception 'sin_skus';
  end if;
  if not v_gancho and v_peor is not null and v_peor < v_piso then
    raise exception 'margen_bajo:%:%', round(v_peor, 1), v_piso;
  end if;

  return jsonb_build_object('ok', true, 'id', v_id, 'peorMargen', v_peor, 'pisoMargen', v_piso,
    'limitePorCliente', v_lpc, 'limiteTotal', v_lt, 'presupuesto', v_pres,
    'margen', coalesce((select jsonb_agg(jsonb_build_object(
        'idProducto', m.id_producto, 'sabor', m.sabor, 'presentacion', m.presentacion,
        'canal', m.canal, 'precioLista', m.precio_lista, 'precioPromo', m.precio_promo,
        'costo', m.costo, 'margenPct', m.margen_pct)) from public.promocion_margen(v_id) m), '[]'::jsonb));
exception
  when others then
    if sqlerrm like 'margen_bajo:%' then
      return jsonb_build_object('ok', false, 'error', 'margen_bajo',
        'mensaje', 'Deja ' || split_part(sqlerrm, ':', 2) || ' % de margen y el piso es ' ||
                   split_part(sqlerrm, ':', 3) || ' %. Si es a propósito, márcala como promoción de gancho.');
    elsif sqlerrm = 'sin_skus' then
      return jsonb_build_object('ok', false, 'error', 'sin_skus', 'mensaje', 'Esa selección no toca ningún producto activo.');
    end if;
    raise;
end;
$function$;
revoke all on function public.guardar_promocion(jsonb) from public, anon;
grant execute on function public.guardar_promocion(jsonb) to anon, authenticated;

commit;
