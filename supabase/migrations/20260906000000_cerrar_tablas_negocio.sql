-- ============================================================================
--  Cerrar las 6 tablas de negocio que quedaban
-- ----------------------------------------------------------------------------
--  `gastos`, `gastos_insumos`, `jornadas`, `lotes_produccion`,
--  `produccion_diaria` y `stock_terminado`. No llevan datos personales de
--  clientes, pero sí la operación completa del negocio: cuánto se gasta y en
--  qué, cuánto se produce, quién trabajó cuándo, y el inventario.
--
--  Y una escritura que preocupa más que las lecturas: `gastos` tenía DELETE
--  abierto. Sin respaldos automáticos, borrar la contabilidad no se deshace.
--
--  Las 24 llamadas del navegador se agrupan en 11 RPCs. Todas de personal:
--  se verificó que ninguna vive en el flujo del cliente — las dos que rozaban
--  la duda (`renderProduccion` y `guardarInventario`) son pantallas de panel.
--
--  Secciones exigidas: `gastos`, `jornadas` y `produccion`, que son las que ya
--  usa la matriz de permisos.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
--  GASTOS
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.obtener_gastos(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_id bigint; v_rol text; v_admin boolean;
  v_limit int := least(coalesce((p_data->>'limit')::int, 200), 500);
  v_filas jsonb;
begin
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.sesion_exige_seccion(p_data->>'token', 'gastos') s;
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'No autorizado'); end if;
  v_admin := lower(trim(coalesce(v_rol,''))) in ('admin','administrador');

  select coalesce(jsonb_agg(to_jsonb(t) order by t.fecha desc), '[]'::jsonb) into v_filas
    from (select g.* from public.gastos g
           where v_admin or g.id_vendedor = v_id
           order by g.fecha desc limit v_limit) t;

  return jsonb_build_object('ok', true, 'gastos', v_filas);
end $$;

create or replace function public.guardar_gasto(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_id_vend bigint; v_rol text; v_admin boolean;
  v_id bigint := nullif(p_data->>'id','')::bigint;
  v_c jsonb := coalesce(p_data->'campos', '{}'::jsonb);
  v_clave text;
  v_permitidas constant text[] := array[
    'fecha','categoria','subcategoria','descripcion','monto','moneda','metodo_pago',
    'proveedor','rfc_proveedor','tiene_factura','ticket_url','notas','estatus',
    'motivo_rechazo','aprobado_por','fecha_aprobacion','fuente_dinero'
  ];
begin
  select s.id_vendedor, s.rol into v_id_vend, v_rol
    from public.sesion_exige_seccion(p_data->>'token', 'gastos') s;
  if v_id_vend is null then return jsonb_build_object('ok', false, 'error', 'No autorizado'); end if;
  v_admin := lower(trim(coalesce(v_rol,''))) in ('admin','administrador');

  for v_clave in select jsonb_object_keys(v_c) loop
    if not (v_clave = any(v_permitidas)) then
      return jsonb_build_object('ok', false, 'error', 'Campo no permitido: ' || v_clave);
    end if;
  end loop;

  if v_id is null then
    -- El vendedor sale de la SESIÓN: nadie registra gastos a nombre de otro.
    insert into public.gastos (fecha, categoria, subcategoria, descripcion, monto,
      moneda, metodo_pago, proveedor, rfc_proveedor, tiene_factura, ticket_url,
      notas, estatus, fuente_dinero, id_vendedor, nombre_vendedor)
    values (coalesce((v_c->>'fecha')::date, current_date), v_c->>'categoria',
      v_c->>'subcategoria', v_c->>'descripcion', (v_c->>'monto')::numeric,
      coalesce(nullif(v_c->>'moneda',''), 'MXN'), v_c->>'metodo_pago',
      v_c->>'proveedor', v_c->>'rfc_proveedor',
      coalesce((v_c->>'tiene_factura')::boolean, false), v_c->>'ticket_url',
      v_c->>'notas', coalesce(nullif(v_c->>'estatus',''), 'pendiente'),
      v_c->>'fuente_dinero', v_id_vend,
      (select v.nombre from public.vendedores v where v.id = v_id_vend))
    returning id into v_id;
    return jsonb_build_object('ok', true, 'id', v_id, 'creado', true);
  end if;

  update public.gastos g set
    fecha            = coalesce((v_c->>'fecha')::date, g.fecha),
    categoria        = coalesce(v_c->>'categoria', g.categoria),
    subcategoria     = coalesce(v_c->>'subcategoria', g.subcategoria),
    descripcion      = coalesce(v_c->>'descripcion', g.descripcion),
    monto            = coalesce((v_c->>'monto')::numeric, g.monto),
    metodo_pago      = coalesce(v_c->>'metodo_pago', g.metodo_pago),
    proveedor        = coalesce(v_c->>'proveedor', g.proveedor),
    rfc_proveedor    = coalesce(v_c->>'rfc_proveedor', g.rfc_proveedor),
    tiene_factura    = coalesce((v_c->>'tiene_factura')::boolean, g.tiene_factura),
    ticket_url       = coalesce(v_c->>'ticket_url', g.ticket_url),
    notas            = coalesce(v_c->>'notas', g.notas),
    estatus          = coalesce(v_c->>'estatus', g.estatus),
    motivo_rechazo   = coalesce(v_c->>'motivo_rechazo', g.motivo_rechazo),
    aprobado_por     = coalesce(v_c->>'aprobado_por', g.aprobado_por),
    fecha_aprobacion = coalesce((v_c->>'fecha_aprobacion')::timestamptz, g.fecha_aprobacion),
    fuente_dinero    = coalesce(v_c->>'fuente_dinero', g.fuente_dinero),
    fecha_actualizacion = now()
  where g.id = v_id and (v_admin or g.id_vendedor = v_id_vend);

  if not found then return jsonb_build_object('ok', false, 'error', 'Gasto no encontrado'); end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'creado', false);
end $$;

-- Borrar contabilidad no se deshace sin respaldos, así que se reserva al dueño.
create or replace function public.eliminar_gasto(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare v_id bigint := (p_data->>'id')::bigint;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'Solo un administrador puede eliminar gastos');
  end if;
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'Falta id'); end if;

  delete from public.gastos_insumos where id_gasto = v_id;
  delete from public.gastos where id = v_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'Gasto no encontrado'); end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.registrar_gasto_insumo(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare v_id_vend bigint; v_c jsonb := coalesce(p_data->'campos','{}'::jsonb); v_id bigint;
begin
  select s.id_vendedor into v_id_vend
    from public.sesion_exige_seccion(p_data->>'token', 'gastos') s;
  if v_id_vend is null then return jsonb_build_object('ok', false, 'error', 'No autorizado'); end if;

  insert into public.gastos_insumos (id_gasto, insumo, unidad, cantidad, precio_unitario, subtotal)
  values ((v_c->>'id_gasto')::bigint, v_c->>'insumo', v_c->>'unidad',
          (v_c->>'cantidad')::numeric, (v_c->>'precio_unitario')::numeric,
          (v_c->>'subtotal')::numeric)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- ────────────────────────────────────────────────────────────────────────────
--  JORNADAS
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.obtener_jornadas(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_id bigint; v_rol text; v_admin boolean;
  v_solo_abierta boolean := coalesce((p_data->>'soloAbierta')::boolean, false);
  v_desde date := nullif(p_data->>'desde','')::date;
  v_hasta date := nullif(p_data->>'hasta','')::date;
  v_limit int  := least(coalesce((p_data->>'limit')::int, 50), 1000);
  v_filas jsonb;
begin
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.sesion_exige_seccion(p_data->>'token', 'jornadas') s;
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'No autorizado'); end if;
  v_admin := lower(trim(coalesce(v_rol,''))) in ('admin','administrador');

  select coalesce(jsonb_agg(to_jsonb(t) order by t.fecha desc, t.hora_inicio desc), '[]'::jsonb)
    into v_filas
    from (select j.* from public.jornadas j
           where (v_admin or j.id_vendedor = v_id)
             and (not v_solo_abierta or j.estatus = 'abierta')
             and (v_desde is null or j.fecha >= v_desde)
             and (v_hasta is null or j.fecha <= v_hasta)
           order by j.fecha desc, j.hora_inicio desc limit v_limit) t;

  return jsonb_build_object('ok', true, 'jornadas', v_filas);
end $$;

create or replace function public.guardar_jornada(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_id_vend bigint;
  v_id bigint := nullif(p_data->>'id','')::bigint;
  v_c jsonb := coalesce(p_data->'campos','{}'::jsonb);
  v_clave text;
  v_permitidas constant text[] := array[
    'fecha','hora_inicio','hora_cierre','coords_entrada','coords_salida',
    'en_planta_entrada','en_planta_salida','actividades','notas_inicio',
    'notas_cierre','duracion_minutos','estatus'
  ];
begin
  select s.id_vendedor into v_id_vend
    from public.sesion_exige_seccion(p_data->>'token', 'jornadas') s;
  if v_id_vend is null then return jsonb_build_object('ok', false, 'error', 'No autorizado'); end if;

  for v_clave in select jsonb_object_keys(v_c) loop
    if not (v_clave = any(v_permitidas)) then
      return jsonb_build_object('ok', false, 'error', 'Campo no permitido: ' || v_clave);
    end if;
  end loop;

  if v_id is null then
    insert into public.jornadas (id_vendedor, nombre_vendedor, fecha, hora_inicio,
      coords_entrada, en_planta_entrada, notas_inicio, estatus)
    values (v_id_vend, (select v.nombre from public.vendedores v where v.id = v_id_vend),
      coalesce((v_c->>'fecha')::date, current_date), v_c->>'hora_inicio',
      v_c->>'coords_entrada', (v_c->>'en_planta_entrada')::boolean,
      v_c->>'notas_inicio', coalesce(nullif(v_c->>'estatus',''), 'abierta'))
    returning id into v_id;
    return jsonb_build_object('ok', true, 'id', v_id, 'creado', true);
  end if;

  -- Solo la propia jornada: nadie cierra la de otro.
  update public.jornadas j set
    hora_cierre      = coalesce(v_c->>'hora_cierre', j.hora_cierre),
    coords_salida    = coalesce(v_c->>'coords_salida', j.coords_salida),
    en_planta_salida = coalesce((v_c->>'en_planta_salida')::boolean, j.en_planta_salida),
    actividades      = coalesce(v_c->>'actividades', j.actividades),
    notas_cierre     = coalesce(v_c->>'notas_cierre', j.notas_cierre),
    duracion_minutos = coalesce((v_c->>'duracion_minutos')::int, j.duracion_minutos),
    estatus          = coalesce(v_c->>'estatus', j.estatus),
    fecha_actualizacion = now()
  where j.id = v_id and j.id_vendedor = v_id_vend;

  if not found then return jsonb_build_object('ok', false, 'error', 'Jornada no encontrada'); end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'creado', false);
end $$;

-- ────────────────────────────────────────────────────────────────────────────
--  LOTES
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.obtener_lotes(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_id bigint;
  v_lote text := nullif(trim(coalesce(p_data->>'idLote','')), '');
  v_solo_activos boolean := coalesce((p_data->>'soloActivos')::boolean, false);
  v_limit int := least(coalesce((p_data->>'limit')::int, 50), 500);
  v_filas jsonb;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'produccion') s;
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'No autorizado'); end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.fecha desc), '[]'::jsonb) into v_filas
    from (select l.* from public.lotes_produccion l
           where (v_lote is null or l.id_lote = v_lote)
             and (not v_solo_activos or l.estatus = 'Activo')
           order by l.fecha desc limit v_limit) t;

  return jsonb_build_object('ok', true, 'lotes', v_filas);
end $$;

create or replace function public.actualizar_lote(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_id_vend bigint;
  v_lote text := nullif(trim(coalesce(p_data->>'idLote','')), '');
  v_c jsonb := coalesce(p_data->'campos','{}'::jsonb);
  v_clave text;
  -- `kilos_disponibles` es columna GENERADA: no se puede escribir.
  v_permitidas constant text[] := array[
    'kilos_totales','kilos_vendidos','estatus','notas','fecha_cierre','fecha'
  ];
begin
  select s.id_vendedor into v_id_vend
    from public.sesion_exige_seccion(p_data->>'token', 'produccion') s;
  if v_id_vend is null then return jsonb_build_object('ok', false, 'error', 'No autorizado'); end if;
  if v_lote is null then return jsonb_build_object('ok', false, 'error', 'Falta idLote'); end if;

  for v_clave in select jsonb_object_keys(v_c) loop
    if not (v_clave = any(v_permitidas)) then
      return jsonb_build_object('ok', false, 'error', 'Campo no permitido: ' || v_clave);
    end if;
  end loop;

  update public.lotes_produccion l set
    kilos_totales  = coalesce((v_c->>'kilos_totales')::numeric, l.kilos_totales),
    kilos_vendidos = coalesce((v_c->>'kilos_vendidos')::numeric, l.kilos_vendidos),
    estatus        = coalesce(v_c->>'estatus', l.estatus),
    notas          = coalesce(v_c->>'notas', l.notas),
    fecha_cierre   = coalesce((v_c->>'fecha_cierre')::timestamptz, l.fecha_cierre),
    fecha          = coalesce((v_c->>'fecha')::date, l.fecha),
    fecha_actualizacion = now()
  where l.id_lote = v_lote;

  if not found then return jsonb_build_object('ok', false, 'error', 'Lote no encontrado'); end if;
  return jsonb_build_object('ok', true, 'idLote', v_lote);
end $$;

-- ────────────────────────────────────────────────────────────────────────────
--  PRODUCCIÓN DIARIA
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.obtener_produccion(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_id bigint;
  v_sabor text := nullif(trim(coalesce(p_data->>'sabor','')), '');
  v_prox boolean := coalesce((p_data->>'proximaFecha')::boolean, false);
  v_filas jsonb;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'produccion') s;
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'No autorizado'); end if;

  if v_prox then
    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_filas
      from (select p.fecha_siguiente from public.produccion_diaria p
             where p.activo and p.fecha_siguiente > current_date
             order by p.fecha_siguiente asc limit 1) t;
    return jsonb_build_object('ok', true, 'filas', v_filas);
  end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.fecha_produccion desc), '[]'::jsonb)
    into v_filas
    from (select p.* from public.produccion_diaria p
           where p.activo and (v_sabor is null or p.sabor = v_sabor)
           order by p.fecha_produccion desc limit 200) t;

  return jsonb_build_object('ok', true, 'filas', v_filas);
end $$;


create or replace function public.actualizar_produccion(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_id_vend bigint;
  v_id bigint := nullif(p_data->>'id','')::bigint;
  v_todas_activas boolean := coalesce((p_data->>'todasActivas')::boolean, false);
  v_c jsonb := coalesce(p_data->'campos','{}'::jsonb);
  v_clave text;
  -- `kilos_disponibles` también es GENERADA aquí.
  v_permitidas constant text[] := array[
    'kilos_producidos','kilos_vendidos','fecha_siguiente','notas','activo'
  ];
begin
  select s.id_vendedor into v_id_vend
    from public.sesion_exige_seccion(p_data->>'token', 'produccion') s;
  if v_id_vend is null then return jsonb_build_object('ok', false, 'error', 'No autorizado'); end if;

  for v_clave in select jsonb_object_keys(v_c) loop
    if not (v_clave = any(v_permitidas)) then
      return jsonb_build_object('ok', false, 'error', 'Campo no permitido: ' || v_clave);
    end if;
  end loop;

  if v_id is null and not v_todas_activas then
    return jsonb_build_object('ok', false, 'error', 'Falta id o todasActivas');
  end if;

  update public.produccion_diaria p set
    kilos_producidos = coalesce((v_c->>'kilos_producidos')::numeric, p.kilos_producidos),
    kilos_vendidos   = coalesce((v_c->>'kilos_vendidos')::numeric, p.kilos_vendidos),
    fecha_siguiente  = coalesce((v_c->>'fecha_siguiente')::date, p.fecha_siguiente),
    notas            = coalesce(v_c->>'notas', p.notas),
    activo           = coalesce((v_c->>'activo')::boolean, p.activo),
    fecha_actualizacion = now()
  where (v_id is not null and p.id = v_id)
     or (v_todas_activas and p.activo);

  return jsonb_build_object('ok', true);
end $$;

-- ────────────────────────────────────────────────────────────────────────────
--  STOCK TERMINADO
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.obtener_stock_lote(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_id bigint;
  v_lote text := nullif(trim(coalesce(p_data->>'idLote','')), '');
  v_filas jsonb;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'produccion') s;
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'No autorizado'); end if;
  if v_lote is null then return jsonb_build_object('ok', true, 'stock', '[]'::jsonb); end if;

  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_filas
    from (select s2.* from public.stock_terminado s2 where s2.id_lote = v_lote) t;

  return jsonb_build_object('ok', true, 'stock', v_filas);
end $$;

-- El navegador hacía DELETE + POST en dos llamadas. Si la segunda fallaba, el
-- lote se quedaba SIN stock: el borrado ya había ocurrido. Aquí es una sola
-- transacción, así que o se reemplaza entero o no se toca nada.
create or replace function public.reemplazar_stock_lote(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_id_vend bigint;
  v_lote text := nullif(trim(coalesce(p_data->>'idLote','')), '');
  v_items jsonb := coalesce(p_data->'items', '[]'::jsonb);
  v_n int;
begin
  select s.id_vendedor into v_id_vend
    from public.sesion_exige_seccion(p_data->>'token', 'produccion') s;
  if v_id_vend is null then return jsonb_build_object('ok', false, 'error', 'No autorizado'); end if;
  if v_lote is null then return jsonb_build_object('ok', false, 'error', 'Falta idLote'); end if;

  delete from public.stock_terminado where id_lote = v_lote;

  insert into public.stock_terminado (id_lote, sabor, presentacion, piezas,
                                      gramos_unitarios, fecha, registrado_por)
  select v_lote, i->>'sabor', i->>'presentacion', (i->>'piezas')::numeric,
         (i->>'gramos_unitarios')::numeric,
         coalesce((i->>'fecha')::date, current_date),
         (select v.nombre from public.vendedores v where v.id = v_id_vend)
    from jsonb_array_elements(v_items) i;

  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'insertados', v_n);
end $$;

-- ────────────────────────────────────────────────────────────────────────────
--  CERRAR LAS TABLAS
-- ────────────────────────────────────────────────────────────────────────────
revoke select, insert, update, delete, truncate on public.gastos            from anon;
revoke select, insert, update, delete, truncate on public.gastos_insumos    from anon;
revoke select, insert, update, delete, truncate on public.jornadas          from anon;
revoke select, insert, update, delete, truncate on public.lotes_produccion  from anon;
revoke select, insert, update, delete, truncate on public.produccion_diaria from anon;
revoke select, insert, update, delete, truncate on public.stock_terminado   from anon;
