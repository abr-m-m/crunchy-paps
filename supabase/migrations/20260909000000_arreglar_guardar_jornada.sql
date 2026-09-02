-- ═══════════════════════════════════════════════════════════════════════════
-- Arreglar guardar_jornada: iniciar una jornada fallaba siempre (hallazgo 27)
--
-- Segundo fallo de la misma función. El primero fue el payload del navegador,
-- que mandaba `id_vendedor` y chocaba con la lista blanca. Al quitarlo salió
-- este, que estaba detrás:
--
--   column "hora_inicio" is of type timestamp with time zone
--   but expression is of type text
--
-- El JSON entrega texto y estas columnas no son texto. En el resto de la
-- migración 20260906 los casts SÍ están puestos —se revisaron las 33
-- asignaciones una por una— y solo esta función quedó sin ellos.
--
-- Tres arreglos y medio:
--   1. INSERT: hora_inicio necesitaba ::timestamptz.
--   2. INSERT: `actividades` estaba en la lista blanca pero NO en la lista de
--      columnas. Se aceptaba y se tiraba en silencio; las actividades que
--      alguien capturara al abrir la jornada se perdían sin avisar.
--   3. UPDATE: hora_cierre necesitaba ::timestamptz. Cerrar una jornada habría
--      fallado igual que abrirla, en cuanto abrir volviera a funcionar.
--   4. UPDATE: `actividades` es text[], y v_c->>'actividades' entrega la CADENA
--      JSON («["a","b"]»), no un arreglo de Postgres.
-- ═══════════════════════════════════════════════════════════════════════════

-- La lógica vive en la función PÚBLICA (la 20260906 la definió ahí, sin
-- envoltorio). Se corrige esa, que es la que llama el navegador...
create or replace function public.guardar_jornada(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare
  v_id_vend bigint;
  v_id bigint := nullif(p_data->>'id','')::bigint;
  v_c jsonb := coalesce(p_data->'campos','{}'::jsonb);
  v_clave text;
  v_actividades text[];
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

  -- El front manda un arreglo JSON. `->>` daría la cadena «["a","b"]», que no
  -- es un text[]; hay que desarmarla elemento a elemento.
  if jsonb_typeof(v_c->'actividades') = 'array' then
    v_actividades := array(select jsonb_array_elements_text(v_c->'actividades'));
  else
    v_actividades := null;
  end if;

  if v_id is null then
    insert into public.jornadas (id_vendedor, nombre_vendedor, fecha, hora_inicio,
      coords_entrada, en_planta_entrada, actividades, notas_inicio, estatus)
    values (v_id_vend, (select v.nombre from public.vendedores v where v.id = v_id_vend),
      coalesce((v_c->>'fecha')::date, current_date),
      coalesce((v_c->>'hora_inicio')::timestamptz, now()),
      v_c->>'coords_entrada', (v_c->>'en_planta_entrada')::boolean,
      v_actividades,
      v_c->>'notas_inicio', coalesce(nullif(v_c->>'estatus',''), 'abierta'))
    returning id into v_id;
    return jsonb_build_object('ok', true, 'id', v_id, 'creado', true);
  end if;

  -- Solo la propia jornada: nadie cierra la de otro.
  update public.jornadas j set
    hora_cierre      = coalesce((v_c->>'hora_cierre')::timestamptz, j.hora_cierre),
    coords_salida    = coalesce(v_c->>'coords_salida', j.coords_salida),
    en_planta_salida = coalesce((v_c->>'en_planta_salida')::boolean, j.en_planta_salida),
    actividades      = coalesce(v_actividades, j.actividades),
    notas_cierre     = coalesce(v_c->>'notas_cierre', j.notas_cierre),
    duracion_minutos = coalesce((v_c->>'duracion_minutos')::int, j.duracion_minutos),
    estatus          = coalesce(v_c->>'estatus', j.estatus),
    fecha_actualizacion = now()
  where j.id = v_id and j.id_vendedor = v_id_vend;

  if not found then return jsonb_build_object('ok', false, 'error', 'Jornada no encontrada'); end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'creado', false);
end $fn$;

-- ...y también `_interno`, que arrastra el mismo defecto aunque hoy no la
-- llame nadie: dejarla mal es dejar una trampa para el próximo que la use.
create or replace function public.guardar_jornada_interno(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare
  v_id_vend bigint;
  v_id bigint := nullif(p_data->>'id','')::bigint;
  v_c jsonb := coalesce(p_data->'campos','{}'::jsonb);
  v_clave text;
  v_actividades text[];
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

  -- El front manda un arreglo JSON. `->>` daría la cadena «["a","b"]», que no
  -- es un text[]; hay que desarmarla elemento a elemento.
  if jsonb_typeof(v_c->'actividades') = 'array' then
    v_actividades := array(select jsonb_array_elements_text(v_c->'actividades'));
  else
    v_actividades := null;
  end if;

  if v_id is null then
    insert into public.jornadas (id_vendedor, nombre_vendedor, fecha, hora_inicio,
      coords_entrada, en_planta_entrada, actividades, notas_inicio, estatus)
    values (v_id_vend, (select v.nombre from public.vendedores v where v.id = v_id_vend),
      coalesce((v_c->>'fecha')::date, current_date),
      coalesce((v_c->>'hora_inicio')::timestamptz, now()),
      v_c->>'coords_entrada', (v_c->>'en_planta_entrada')::boolean,
      v_actividades,
      v_c->>'notas_inicio', coalesce(nullif(v_c->>'estatus',''), 'abierta'))
    returning id into v_id;
    return jsonb_build_object('ok', true, 'id', v_id, 'creado', true);
  end if;

  -- Solo la propia jornada: nadie cierra la de otro.
  update public.jornadas j set
    hora_cierre      = coalesce((v_c->>'hora_cierre')::timestamptz, j.hora_cierre),
    coords_salida    = coalesce(v_c->>'coords_salida', j.coords_salida),
    en_planta_salida = coalesce((v_c->>'en_planta_salida')::boolean, j.en_planta_salida),
    actividades      = coalesce(v_actividades, j.actividades),
    notas_cierre     = coalesce(v_c->>'notas_cierre', j.notas_cierre),
    duracion_minutos = coalesce((v_c->>'duracion_minutos')::int, j.duracion_minutos),
    estatus          = coalesce(v_c->>'estatus', j.estatus),
    fecha_actualizacion = now()
  where j.id = v_id and j.id_vendedor = v_id_vend;

  if not found then return jsonb_build_object('ok', false, 'error', 'Jornada no encontrada'); end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'creado', false);
end $fn$;

revoke all on function public.guardar_jornada_interno(jsonb) from public, anon, authenticated;
