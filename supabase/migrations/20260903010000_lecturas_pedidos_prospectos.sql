-- ============================================================================
--  ETAPA B — Cerrar las LECTURAS de ordenes, ordenes_detalle y prospectos
-- ----------------------------------------------------------------------------
--  Es lo que queda del §3.0. `ordenes` lleva nombre, dirección y teléfono de
--  cada cliente; `prospectos` son 1.132 negocios con geolocalización. Todo
--  legible hoy con la llave publicada en este repo.
--
--  Las 16 lecturas del navegador se agrupan en 7 RPCs. La consolidación no es
--  cosmética: había cuatro consultas distintas a `ordenes_detalle` que solo se
--  diferenciaban en el `select`, y traer una columna de más no justifica cuatro
--  puntos de entrada que mantener.
--
--  ALCANCE POR ROL — lo impone el servidor, no el navegador
--    · rol dueño        -> todo
--    · resto del personal -> lo suyo (sus pedidos, sus prospectos)
--    · cliente final    -> lo suyo, resuelto desde su token
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
--  1. LISTADO DE PEDIDOS
-- ────────────────────────────────────────────────────────────────────────────
--  Sustituye las dos variantes del panel (todos / por vendedor) y la consulta
--  por lista de ids del kárdex. El filtro por vendedor deja de decidirlo el
--  navegador: antes bastaba borrar un `if` en DevTools para ver los pedidos de
--  todos.
create or replace function public.obtener_pedidos(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id     bigint;
  v_rol    text;
  v_admin  boolean;
  v_limit  int := least(coalesce((p_data->>'limit')::int, 200), 500);
  v_offset int := greatest(coalesce((p_data->>'offset')::int, 0), 0);
  v_ids    bigint[];
  v_total  bigint;
  v_filas  jsonb;
begin
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.sesion_exige_seccion(p_data->>'token', 'pedidos') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  v_admin := lower(trim(coalesce(v_rol,''))) in ('admin','administrador');

  -- Lista de ids opcional (kárdex de lote): se respeta igualmente el alcance.
  if jsonb_typeof(p_data->'ids') = 'array' then
    select array_agg((value #>> '{}')::bigint) into v_ids
      from jsonb_array_elements(p_data->'ids');
  end if;

  select count(*) into v_total
    from public.ordenes o
   where (v_admin or o.id_vendedor = v_id)
     and (v_ids is null or o.id = any(v_ids));

  select coalesce(jsonb_agg(to_jsonb(t) order by t.fecha_orden desc), '[]'::jsonb)
    into v_filas
    from (
      select o.* from public.ordenes o
       where (v_admin or o.id_vendedor = v_id)
         and (v_ids is null or o.id = any(v_ids))
       order by o.fecha_orden desc
       limit v_limit offset v_offset
    ) t;

  return jsonb_build_object('ok', true, 'pedidos', v_filas, 'total', v_total,
                            'limit', v_limit, 'offset', v_offset);
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
--  2. UN PEDIDO CON SU DETALLE
-- ────────────────────────────────────────────────────────────────────────────
--  El navegador hacía dos consultas en paralelo —el pedido por consecutivo o
--  id, y su detalle— y las unía. Aquí van juntas: menos viajes y sin riesgo de
--  que una llegue y la otra no.
create or replace function public.obtener_pedido(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id_vend bigint;
  v_rol     text;
  v_admin   boolean;
  v_ref     text := coalesce(p_data->>'ref', '');
  v_pedido  jsonb;
  v_id      bigint;
  v_detalle jsonb;
begin
  select s.id_vendedor, s.rol into v_id_vend, v_rol
    from public.sesion_exige_seccion(p_data->>'token', 'pedidos') s;
  if v_id_vend is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  if v_ref = '' then
    return jsonb_build_object('ok', false, 'error', 'Falta la referencia del pedido');
  end if;

  v_admin := lower(trim(coalesce(v_rol,''))) in ('admin','administrador');

  select to_jsonb(o), o.id into v_pedido, v_id
    from public.ordenes o
   where (o.consecutivo = v_ref
          or (v_ref ~ '^[0-9]+$' and o.id = v_ref::bigint))
     and (v_admin or o.id_vendedor = v_id_vend)
   limit 1;

  if v_pedido is null then
    return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado');
  end if;

  select coalesce(jsonb_agg(to_jsonb(d) order by d.id), '[]'::jsonb)
    into v_detalle
    from public.ordenes_detalle d where d.id_orden = v_id;

  return jsonb_build_object('ok', true, 'pedido', v_pedido, 'detalle', v_detalle);
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
--  3. DETALLE DE VARIOS PEDIDOS
-- ────────────────────────────────────────────────────────────────────────────
--  Unifica cuatro consultas que solo se diferenciaban en el `select`. Se
--  devuelven las filas completas: traer una columna de más no compensa
--  mantener cuatro puertas.
create or replace function public.obtener_detalle_pedidos(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id_vend bigint;
  v_rol     text;
  v_admin   boolean;
  v_ids     bigint[];
  v_filas   jsonb;
begin
  select s.id_vendedor, s.rol into v_id_vend, v_rol
    from public.sesion_exige_seccion(p_data->>'token', 'pedidos') s;
  if v_id_vend is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  v_admin := lower(trim(coalesce(v_rol,''))) in ('admin','administrador');

  if jsonb_typeof(p_data->'ids') = 'array' then
    select array_agg((value #>> '{}')::bigint) into v_ids
      from jsonb_array_elements(p_data->'ids');
  end if;
  if v_ids is null or array_length(v_ids, 1) is null then
    return jsonb_build_object('ok', true, 'detalle', '[]'::jsonb);
  end if;

  -- El alcance se aplica por el PEDIDO al que pertenece cada línea: si no,
  -- pedir ids de detalle sería una vía lateral para leer pedidos ajenos.
  select coalesce(jsonb_agg(to_jsonb(d) order by d.id), '[]'::jsonb)
    into v_filas
    from public.ordenes_detalle d
    join public.ordenes o on o.id = d.id_orden
   where d.id_orden = any(v_ids)
     and (v_admin or o.id_vendedor = v_id_vend);

  return jsonb_build_object('ok', true, 'detalle', v_filas);
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
--  4. KÁRDEX DE LOTES
-- ────────────────────────────────────────────────────────────────────────────
--  Sustituye la consulta global (con join embebido a `ordenes`) y la de un lote
--  concreto. Es de producción, no de pedidos: por eso pide esa sección.
create or replace function public.obtener_kardex_lotes(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id    bigint;
  v_lote  text := nullif(trim(coalesce(p_data->>'idLote','')), '');
  v_limit int  := least(coalesce((p_data->>'limit')::int, 400), 1000);
  v_filas jsonb;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'produccion') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  select coalesce(jsonb_agg(f order by (f->>'id')::bigint desc), '[]'::jsonb)
    into v_filas
    from (
      select jsonb_build_object(
               'id', d.id,
               'id_orden', d.id_orden,
               'consecutivo_orden', d.consecutivo_orden,
               'sabor', d.sabor,
               'presentacion', d.presentacion,
               'cantidad', d.cantidad,
               'kg_descontado_lote', d.kg_descontado_lote,
               'id_lote_descontado', d.id_lote_descontado,
               'ordenes', jsonb_build_object(
                 'consecutivo', o.consecutivo,
                 'fecha_orden', o.fecha_orden,
                 'tipo_interno', o.tipo_interno,
                 'estatus_pedido', o.estatus_pedido)
             ) as f
        from public.ordenes_detalle d
        left join public.ordenes o on o.id = d.id_orden
       where d.kg_descontado_lote > 0
         and (v_lote is null or d.id_lote_descontado = v_lote)
       order by d.id desc
       limit v_limit
    ) x;

  return jsonb_build_object('ok', true, 'movimientos', v_filas);
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
--  5. TOTALES DE COMPRA POR CLIENTE (panel B2B)
-- ────────────────────────────────────────────────────────────────────────────
--  Antes se traían todas las filas de `ordenes` de esos clientes y el navegador
--  sumaba. Ahora suma Postgres y viaja solo el resultado: menos datos
--  personales en el navegador y menos tráfico.
create or replace function public.obtener_totales_clientes(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id_vend bigint;
  v_rol     text;
  v_admin   boolean;
  v_ids     bigint[];
  v_filas   jsonb;
begin
  select s.id_vendedor, s.rol into v_id_vend, v_rol
    from public.sesion_exige_seccion(p_data->>'token', 'b2b') s;
  if v_id_vend is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  v_admin := lower(trim(coalesce(v_rol,''))) in ('admin','administrador');

  if jsonb_typeof(p_data->'ids') = 'array' then
    select array_agg((value #>> '{}')::bigint) into v_ids
      from jsonb_array_elements(p_data->'ids');
  end if;
  if v_ids is null or array_length(v_ids, 1) is null then
    return jsonb_build_object('ok', true, 'totales', '{}'::jsonb);
  end if;

  select coalesce(jsonb_object_agg(t.id_cliente::text,
           jsonb_build_object('total', t.total, 'num', t.num)), '{}'::jsonb)
    into v_filas
    from (
      select o.id_cliente, sum(o.total) as total, count(*) as num
        from public.ordenes o
       where o.id_cliente = any(v_ids)
         and o.estatus_pedido <> 'Cancelado'
         and o.tipo_interno is null
         and (v_admin or o.id_vendedor = v_id_vend)
       group by o.id_cliente
    ) t;

  return jsonb_build_object('ok', true, 'totales', v_filas);
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
--  6. LISTADO DE PROSPECTOS
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.obtener_prospectos(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id     bigint;
  v_rol    text;
  v_admin  boolean;
  v_limit  int := least(coalesce((p_data->>'limit')::int, 500), 2000);
  v_offset int := greatest(coalesce((p_data->>'offset')::int, 0), 0);
  v_total  bigint;
  v_filas  jsonb;
begin
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.sesion_exige_seccion(p_data->>'token', 'prospeccion') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  v_admin := lower(trim(coalesce(v_rol,''))) in ('admin','administrador');

  select count(*) into v_total
    from public.prospectos p where v_admin or p.id_vendedor = v_id;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.score desc nulls last,
                            t.fecha_creacion desc), '[]'::jsonb)
    into v_filas
    from (
      select p.* from public.prospectos p
       where v_admin or p.id_vendedor = v_id
       order by p.score desc nulls last, p.fecha_creacion desc
       limit v_limit offset v_offset
    ) t;

  return jsonb_build_object('ok', true, 'prospectos', v_filas, 'total', v_total);
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
--  7. REGALOS RECIBIDOS — de cara al CLIENTE
-- ────────────────────────────────────────────────────────────────────────────
--  Antes: `ordenes?id_cliente=eq.N`, con el filtro puesto por el navegador, así
--  que cualquiera veía los regalos de cualquiera. Ahora el cliente sale de SU
--  token; un vendedor con sección `pedidos` puede consultar los de un cliente
--  concreto, que es lo que necesita el historial del panel.
create or replace function public.obtener_regalos_cliente(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tel      text;
  v_id_vend  bigint;
  v_id_cli   bigint;
  v_filas    jsonb;
begin
  v_tel := public.resolver_sesion_cliente(p_data->>'token');

  if v_tel is not null then
    -- Cliente: solo los suyos. El idCliente que venga en el payload se ignora.
    select c.id into v_id_cli from public.clientes c
     where right(regexp_replace(coalesce(c.telefono,''), '\D', '', 'g'), 10) = v_tel
     limit 1;
  else
    select s.id_vendedor into v_id_vend
      from public.sesion_exige_seccion(p_data->>'token', 'pedidos') s;
    if v_id_vend is null then
      return jsonb_build_object('ok', false, 'error', 'Sesión inválida o expirada');
    end if;
    v_id_cli := (p_data->>'idCliente')::bigint;
  end if;

  if v_id_cli is null then
    return jsonb_build_object('ok', true, 'regalos', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(f order by (f->>'fecha_orden') desc), '[]'::jsonb)
    into v_filas
    from (
      select jsonb_build_object(
               'id', o.id,
               'consecutivo', o.consecutivo,
               'fecha_orden', o.fecha_orden,
               'tipo_interno', o.tipo_interno,
               'ordenes_detalle', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'kg_descontado_lote', d.kg_descontado_lote,
                          'sabor', d.sabor,
                          'presentacion', d.presentacion))
                   from public.ordenes_detalle d where d.id_orden = o.id), '[]'::jsonb)
             ) as f
        from public.ordenes o
       where o.id_cliente = v_id_cli
         and o.tipo_interno in ('sampling','regalo','bonificacion')
         and o.estatus_pedido <> 'Cancelado'
    ) x;

  return jsonb_build_object('ok', true, 'regalos', v_filas);
end;
$$;
