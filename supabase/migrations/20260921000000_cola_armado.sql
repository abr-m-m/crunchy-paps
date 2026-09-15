-- 20260921000000_cola_armado.sql
-- Entrega 2 de la cola de pedidos (cambios/2026-09-14-cola-de-pedidos.md).
-- Lista de armado por fecha con casilla por pedido. Sin estatus nuevo. Re-ejecutable.

-- 1. Marca de armado en el pedido.
alter table public.ordenes add column if not exists armado_en timestamptz;
alter table public.ordenes add column if not exists armado_por text;

-- 2. La sección «armado». sesion_secciones lleva el catálogo completo en una
--    constante: sin esto el dueño no la tendría. Mismo cuerpo que
--    20260901030000_permisos_por_seccion.sql con 'armado' en `todas`.
create or replace function public.sesion_secciones(p_token text)
returns text[]
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id      bigint;
  v_rol     text;
  v_rol_l   text;
  v_over    text[];
  v_secs    text[];
  -- Roles con acceso total. Deliberadamente EXACTOS: 'administrador2' NO está
  -- aquí, para que los perfiles de socio se puedan recortar por override.
  roles_dueno constant text[] := array['admin', 'administrador'];
  -- Catálogo completo, igual que NAV_ITEM_POR_SECCION en index.html.
  todas constant text[] := array[
    'catalogo','pedidos','premia','b2b','produccion','prospeccion','caja',
    'gastos','jornadas','productos','cupones','resumen','cuenta','armado'
  ];
begin
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.resolver_sesion_vendedor(p_token) s;
  if v_id is null then
    return array[]::text[];               -- sin sesión, sin secciones
  end if;
  v_rol_l := lower(trim(coalesce(v_rol, '')));
  if v_rol_l = any(roles_dueno) then
    return todas;
  end if;
  -- El rol vigente se relee de la tabla, no del token.
  select lower(trim(v.rol)), v.secciones into v_rol_l, v_over
    from public.vendedores v
   where v.id = v_id and v.activo = true;
  if v_rol_l is null then
    return array[]::text[];               -- vendedor desactivado
  end if;
  if v_rol_l = any(roles_dueno) then
    return todas;
  end if;
  if v_over is not null and array_length(v_over, 1) > 0 then
    v_secs := v_over;                     -- override individual manda
  else
    select c.secciones into v_secs
      from public.config_secciones c where lower(c.rol) = v_rol_l;
    if v_secs is null then
      v_secs := array['catalogo','pedidos','cuenta'];   -- mínimo seguro
    end if;
  end if;
  -- Mismo añadido que hace la interfaz para mostrador (array_append, no ||).
  if v_rol_l = 'mostrador' then
    if not ('productos' = any(v_secs)) then v_secs := array_append(v_secs, 'productos'); end if;
    if not ('cupones'   = any(v_secs)) then v_secs := array_append(v_secs, 'cupones');   end if;
  end if;
  return v_secs;
end;
$$;
revoke all on function public.sesion_secciones(text) from public, anon, authenticated;

update public.config_secciones
   set secciones = array_append(secciones, 'armado'), fecha_actualizacion = now()
 where lower(rol) in ('administrador', 'administrador2', 'mostrador')
   and not ('armado' = any(coalesce(secciones, array[]::text[])));

-- 3. Líneas con kilos de los pedidos En proceso de una fecha. Función interna
--    (sin EXECUTE para nadie): la usan cola_armado y sus totales, sin tablas
--    temporales (PostgREST reutiliza sesiones y los planes cacheados de una
--    temp table recreada fallan con «relation with OID … does not exist»).
--    Kilos: primero lo que descontó el lote (kg_descontado_lote); si es 0, la
--    fórmula de CLAUDE.md §4 leyendo los gramos de la presentación con una
--    expresión regular («100g», «Bolsa 50g», «1kg»). fecha_entrega se guarda a
--    medianoche UTC desde un 'YYYY-MM-DD': se compara con ::date, no en CDMX.
create or replace function public.lineas_armado_interno(p_fecha date)
returns table (
  id_orden bigint, sabor text, presentacion text, tipo_venta text, cantidad numeric,
  piezas_por_caja integer, gramos_vendidos numeric, piezas numeric, kg numeric
)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $fn$
  select d.id_orden, d.sabor, d.presentacion, d.tipo_venta, d.cantidad,
         d.piezas_por_caja::integer, d.gramos_vendidos,
         case when d.tipo_venta ilike 'a granel' then 0 else coalesce(d.cantidad, 0) end as piezas,
         case when coalesce(d.kg_descontado_lote, 0) > 0 then d.kg_descontado_lote
              when d.tipo_venta ilike 'a granel' then coalesce(d.gramos_vendidos, 0) / 1000.0
              when d.presentacion ~* '\d+\s*kg' then coalesce(d.cantidad, 0) * (substring(d.presentacion from '(\d+)\s*[kK][gG]'))::numeric
              when d.presentacion ~* '\d+\s*g'  then coalesce(d.cantidad, 0) * (substring(d.presentacion from '(\d+)\s*[gG]'))::numeric / 1000.0
              else 0 end as kg
    from public.ordenes_detalle d
    join public.ordenes o on o.id = d.id_orden
   where o.fecha_entrega::date = p_fecha
     and o.estatus_pedido = 'En proceso';
$fn$;
revoke all on function public.lineas_armado_interno(date) from public, anon, authenticated;

-- 4. Lectura: qué armar para una fecha.
create or replace function public.cola_armado(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
declare
  v_id bigint; v_rol text;
  v_fecha date;
  v_desde timestamptz;
  v_cfg jsonb;
  v_nuevos jsonb; v_resumen jsonb; v_pedidos jsonb; v_porconf jsonb; v_tot jsonb;
begin
  -- Autorizar primero.
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.sesion_exige_seccion(p_data->>'token', 'armado') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  v_cfg   := public.get_hora_limite_config();
  v_fecha := coalesce(nullif(p_data->>'fecha', '')::date,
                      (now() at time zone 'America/Mexico_City')::date + 1);
  v_desde := coalesce(nullif(p_data->>'desde', '')::timestamptz, now() - interval '24 hours');

  -- Consolidado por sabor y presentación (piezas, kg y cajas por tamaño).
  select coalesce(jsonb_agg(r.fila order by r.fila->>'sabor', r.fila->>'presentacion'), '[]'::jsonb)
    into v_resumen
    from (
      select jsonb_build_object(
               'sabor', l.sabor, 'presentacion', l.presentacion,
               'piezas', sum(l.piezas), 'kg', round(sum(l.kg)::numeric, 3),
               'cajas', (select coalesce(jsonb_agg(jsonb_build_object('piezasPorCaja', c.ppc, 'cajas', c.n)), '[]'::jsonb)
                           from (select l2.piezas_por_caja as ppc, sum(l2.cantidad / l2.piezas_por_caja) as n
                                   from public.lineas_armado_interno(v_fecha) l2
                                  where l2.sabor = l.sabor and l2.presentacion = l.presentacion
                                    and coalesce(l2.piezas_por_caja, 0) > 0
                                  group by l2.piezas_por_caja) c)
             ) as fila
        from public.lineas_armado_interno(v_fecha) l
       group by l.sabor, l.presentacion
    ) r;

  -- Una tarjeta por pedido, los no armados primero.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'consecutivo', o.consecutivo, 'cliente', o.nombre_cliente,
           'negocio', c.nombre_comercial, 'canal', o.canal, 'idVendedor', o.id_vendedor,
           'vendedor', o.nombre_vendedor, 'tipoInterno', coalesce(o.tipo_interno, ''),
           'total', o.total, 'fechaOrden', o.fecha_orden,
           'armadoEn', o.armado_en, 'armadoPor', o.armado_por,
           'lineas', (select coalesce(jsonb_agg(jsonb_build_object(
                        'sabor', l.sabor, 'presentacion', l.presentacion, 'tipoVenta', l.tipo_venta,
                        'cantidad', l.cantidad, 'piezasPorCaja', l.piezas_por_caja,
                        'gramos', l.gramos_vendidos, 'kg', round(l.kg::numeric, 3)) order by l.sabor), '[]'::jsonb)
                        from public.lineas_armado_interno(v_fecha) l where l.id_orden = o.id)
         ) order by o.armado_en nulls first, o.fecha_orden), '[]'::jsonb)
    into v_pedidos
    from public.ordenes o
    left join public.clientes c on c.id = o.id_cliente
   where o.fecha_entrega::date = v_fecha
     and o.estatus_pedido = 'En proceso';

  -- Pendientes de esa fecha: se confirman en Pedidos, aquí solo se enseñan.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'consecutivo', o.consecutivo, 'cliente', o.nombre_cliente,
           'negocio', c.nombre_comercial, 'canal', o.canal, 'total', o.total, 'fechaOrden', o.fecha_orden
         ) order by o.fecha_orden), '[]'::jsonb)
    into v_porconf
    from public.ordenes o
    left join public.clientes c on c.id = o.id_cliente
   where o.fecha_entrega::date = v_fecha
     and o.estatus_pedido = 'Pendiente';

  -- Nuevos desde el último vistazo (la cola en vivo, entrega 3).
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'consecutivo', o.consecutivo, 'fechaOrden', o.fecha_orden,
           'cliente', o.nombre_cliente, 'negocio', c.nombre_comercial, 'canal', o.canal,
           'total', o.total, 'estatus', o.estatus_pedido, 'fechaEntrega', o.fecha_entrega::date,
           'lineasResumen', (select string_agg(trim_scale(d.cantidad)::text || ' × ' || d.sabor || ' ' || d.presentacion, ' · ')
                               from public.ordenes_detalle d where d.id_orden = o.id)
         ) order by o.fecha_orden desc), '[]'::jsonb)
    into v_nuevos
    from (select * from public.ordenes o2
           where o2.fecha_orden > v_desde and o2.estatus_pedido <> 'Cancelado'
           order by o2.fecha_orden desc limit 50) o
    left join public.clientes c on c.id = o.id_cliente;

  select jsonb_build_object(
           'pedidos', count(distinct o.id),
           'armados', count(distinct o.id) filter (where o.armado_en is not null),
           'kg', round(coalesce(sum(l.kg), 0)::numeric, 3),
           'piezas', coalesce(sum(l.piezas), 0))
    into v_tot
    from public.ordenes o
    left join public.lineas_armado_interno(v_fecha) l on l.id_orden = o.id
   where o.fecha_entrega::date = v_fecha
     and o.estatus_pedido = 'En proceso';

  return jsonb_build_object(
    'ok', true, 'fecha', to_char(v_fecha, 'YYYY-MM-DD'), 'horaLimite', v_cfg->>'hora',
    'nuevos', v_nuevos, 'resumen', v_resumen, 'pedidos', v_pedidos,
    'porConfirmar', v_porconf, 'totales', v_tot);
end;
$fn$;
revoke all on function public.cola_armado(jsonb) from public;
grant execute on function public.cola_armado(jsonb) to anon, authenticated;

-- 5. Escritura: marcar o desmarcar un pedido como armado.
create or replace function public.marcar_armado(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
declare
  v_id bigint; v_rol text; v_nombre text;
  v_orden bigint := nullif(p_data->>'id', '')::bigint;
  v_armado boolean := coalesce((p_data->>'armado')::boolean, true);
  v_est text; v_consec text; v_en timestamptz; v_por text;
begin
  -- Autorizar primero, validar después.
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.sesion_exige_seccion(p_data->>'token', 'armado') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  if v_orden is null then
    return jsonb_build_object('ok', false, 'error', 'Falta el id del pedido');
  end if;
  select estatus_pedido, consecutivo into v_est, v_consec
    from public.ordenes where id = v_orden for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado');
  end if;
  if v_est <> 'En proceso' then
    return jsonb_build_object('ok', false, 'motivo', 'El pedido está ' || v_est, 'error', 'El pedido está ' || v_est);
  end if;
  select nombre into v_nombre from public.vendedores where id = v_id;
  update public.ordenes
     set armado_en  = case when v_armado then now() else null end,
         armado_por = case when v_armado then v_nombre else null end
   where id = v_orden
  returning armado_en, armado_por into v_en, v_por;
  return jsonb_build_object('ok', true, 'id', v_orden, 'consecutivo', v_consec, 'armadoEn', v_en, 'armadoPor', v_por);
end;
$fn$;
revoke all on function public.marcar_armado(jsonb) from public;
grant execute on function public.marcar_armado(jsonb) to anon, authenticated;
