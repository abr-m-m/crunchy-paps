-- 20260925000000_ruta_del_dia.sql
-- Ruta del día, entrega 2 (cambios/2026-09-16-ruta-del-dia.md): vendedor por
-- ruta, sección «Mi ruta», visitas a clientes y la lista del día. Re-ejecutable.

-- ── 1. Vendedor por ruta ────────────────────────────────────────────────────
alter table public.rutas add column if not exists id_vendedor bigint
  references public.vendedores(id) on delete set null;

create or replace function public.get_rutas(p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare v jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'nombre', r.nombre, 'color', r.color, 'dias', to_jsonb(r.dias),
           'activa', r.activa, 'orden', r.orden, 'idVendedor', r.id_vendedor,
           'cobertura', (select coalesce(jsonb_agg(jsonb_build_object('tipo', c.tipo, 'valor', c.valor, 'cpHasta', c.cp_hasta) order by c.tipo, c.valor), '[]'::jsonb)
                           from public.rutas_cobertura c where c.id_ruta = r.id)
         ) order by r.orden, r.id), '[]'::jsonb)
    into v
    from public.rutas r
   where r.activa or coalesce((p_data->>'incluirInactivas')::boolean, false);
  return jsonb_build_object('ok', true, 'rutas', v);
end $fn$;
revoke all on function public.get_rutas(jsonb) from public;
grant execute on function public.get_rutas(jsonb) to anon, authenticated;

create or replace function public.asignar_vendedor_ruta(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_ruta bigint;
  v_vend bigint;
  v_nom  text;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  begin
    v_ruta := nullif(p_data->>'idRuta', '')::bigint;
    v_vend := nullif(p_data->>'idVendedor', '')::bigint;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'Datos inválidos');
  end;
  if v_ruta is null then
    return jsonb_build_object('ok', false, 'error', 'Falta la ruta');
  end if;
  if v_vend is not null then
    select nombre into v_nom from public.vendedores where id = v_vend and activo;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'Vendedor no encontrado o inactivo');
    end if;
  end if;
  update public.rutas set id_vendedor = v_vend, actualizada_en = now() where id = v_ruta;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Ruta no encontrada');
  end if;
  return jsonb_build_object('ok', true, 'idRuta', v_ruta, 'idVendedor', v_vend, 'vendedor', v_nom);
end $fn$;
revoke all on function public.asignar_vendedor_ruta(jsonb) from public;
grant execute on function public.asignar_vendedor_ruta(jsonb) to anon, authenticated;

-- ── 2. Sección «ruta» ───────────────────────────────────────────────────────
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
    'gastos','jornadas','productos','cupones','resumen','cuenta','armado','ruta'
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
   set secciones = array_append(secciones, 'ruta'), fecha_actualizacion = now()
 where lower(rol) in ('vendedor', 'administrador')
   and not ('ruta' = any(coalesce(secciones, array[]::text[])));

-- Las listas personales sustituyen a las del rol. En producción los 8 usuarios
-- tienen una: sin esto, ningún vendedor real vería «Mi ruta».
update public.vendedores
   set secciones = array_append(secciones, 'ruta'), fecha_actualizacion = now()
 where lower(trim(rol)) = 'vendedor'
   and secciones is not null and array_length(secciones, 1) > 0
   and not ('ruta' = any(secciones));

-- ── 3. Visitas a clientes ───────────────────────────────────────────────────
alter table public.visitas drop constraint if exists visitas_resultado_check;
alter table public.visitas add constraint visitas_resultado_check check (resultado in (
  'convertido','interesado','no_estaba','ya_tiene_proveedor','caro','no_le_interesa','ya_no_existe',
  'pedido','no_necesita'));

create or replace function public.resultado_visita_etiqueta(p text) returns text
language sql immutable as $fn$
  select case p
    when 'convertido'         then 'Convertido'
    when 'interesado'         then 'Interesado, volver'
    when 'no_estaba'          then 'No estaba el encargado'
    when 'ya_tiene_proveedor' then 'Ya tiene proveedor'
    when 'caro'               then 'Le pareció caro'
    when 'no_le_interesa'     then 'No le interesa'
    when 'ya_no_existe'       then 'Ya no existe el negocio'
    when 'pedido'             then 'Levantó pedido'
    when 'no_necesita'        then 'No necesita resurtido'
  end;
$fn$;
revoke all on function public.resultado_visita_etiqueta(text) from public;

create or replace function public.registrar_visita(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_vend    bigint;
  v_nom     text;
  v_idp     bigint;
  v_idc     bigint;
  v_res     text := coalesce(p_data->>'resultado', '');
  v_nota    text := nullif(trim(coalesce(p_data->>'nota', '')), '');
  v_lat     double precision;
  v_lng     double precision;
  v_prec    double precision;
  v_p       public.prospectos%rowtype;
  v_c       public.clientes%rowtype;
  v_clat    double precision;
  v_clng    double precision;
  v_dist    integer;
  v_fuera   boolean;
  v_ruta    bigint;
  v_id      bigint;
  v_estatus text;
begin
  select s.id_vendedor into v_vend
    from public.sesion_exige_seccion(p_data->>'token', 'prospeccion') s;
  if v_vend is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  if public.resultado_visita_etiqueta(v_res) is null then
    return jsonb_build_object('ok', false, 'error', 'Resultado inválido');
  end if;

  begin
    v_idp  := nullif(p_data->>'idProspecto', '')::bigint;
    v_idc  := nullif(p_data->>'idCliente', '')::bigint;
    v_lat  := nullif(p_data->>'lat', '')::double precision;
    v_lng  := nullif(p_data->>'lng', '')::double precision;
    v_prec := nullif(p_data->>'precision', '')::double precision;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'Datos de la visita inválidos');
  end;

  if v_idp is null and v_idc is null then
    return jsonb_build_object('ok', false, 'error', 'Falta el prospecto o el cliente');
  end if;
  if v_lat is null or v_lng is null then
    return jsonb_build_object('ok', false, 'error', 'Falta la ubicación: sin ubicación no se registra la visita');
  end if;
  if v_lat not between -90 and 90 or v_lng not between -180 and 180 then
    return jsonb_build_object('ok', false, 'error', 'Ubicación inválida');
  end if;
  select nombre into v_nom from public.vendedores where id = v_vend;

  -- ── Visita a cliente (sin prospecto) ──
  if v_idp is null then
    if v_res not in ('pedido', 'no_necesita', 'no_estaba') then
      return jsonb_build_object('ok', false, 'error', 'Resultado inválido para un cliente');
    end if;
    select * into v_c from public.clientes where id = v_idc;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'Cliente no encontrado');
    end if;
    v_clat := coalesce(v_c.latitud::double precision,
      case when v_c.coordenadas ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*,\s*-?[0-9]+(\.[0-9]+)?\s*$'
           then split_part(v_c.coordenadas, ',', 1)::double precision end);
    v_clng := coalesce(v_c.longitud::double precision,
      case when v_c.coordenadas ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*,\s*-?[0-9]+(\.[0-9]+)?\s*$'
           then split_part(v_c.coordenadas, ',', 2)::double precision end);
    if v_clat is not null and v_clng is not null then
      v_dist  := public.distancia_metros(v_lat, v_lng, v_clat, v_clng);
      v_fuera := v_dist > 100;
    end if;
    insert into public.visitas (id_prospecto, id_cliente, id_vendedor, nombre_vendedor, id_ruta,
                                resultado, nota, lat, lng, precision_metros, distancia_metros, fuera_del_punto)
    values (null, v_idc, v_vend, v_nom, v_c.id_ruta, v_res, v_nota, v_lat, v_lng, v_prec, v_dist, v_fuera)
    returning id into v_id;
    return jsonb_build_object('ok', true, 'idVisita', v_id, 'resultado', v_res,
      'etiqueta', public.resultado_visita_etiqueta(v_res), 'estatus', null,
      'distanciaMetros', v_dist, 'fueraDelPunto', v_fuera, 'idRuta', v_c.id_ruta);
  end if;

  -- ── Visita a prospecto (igual que en E1) ──
  if v_res in ('pedido', 'no_necesita') then
    return jsonb_build_object('ok', false, 'error', 'Resultado inválido para un prospecto');
  end if;

  select * into v_p from public.prospectos where id = v_idp for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Prospecto no encontrado');
  end if;
  if v_p.estatus = 'descartado' then
    return jsonb_build_object('ok', false, 'error', 'El prospecto está descartado; reactívalo para registrar otra visita');
  end if;

  if v_res = 'convertido' then
    if v_idc is null then
      return jsonb_build_object('ok', false, 'error', 'Falta el cliente convertido');
    end if;
    if v_p.estatus <> 'convertido' or v_p.id_cliente_convertido is distinct from v_idc then
      return jsonb_build_object('ok', false, 'error', 'El prospecto no está convertido en ese cliente');
    end if;
  else
    v_idc := null;
  end if;

  if v_p.latitud is not null and v_p.longitud is not null then
    v_dist  := public.distancia_metros(v_lat, v_lng, v_p.latitud::double precision, v_p.longitud::double precision);
    v_fuera := v_dist > 100;
  end if;

  v_ruta := public.ruta_para(nullif(regexp_replace(coalesce(v_p.codigo_postal, ''), '[^0-9]', '', 'g'), ''), v_p.colonia);

  insert into public.visitas (id_prospecto, id_cliente, id_vendedor, nombre_vendedor, id_ruta,
                              resultado, nota, lat, lng, precision_metros, distancia_metros, fuera_del_punto)
  values (v_idp, v_idc, v_vend, v_nom, v_ruta, v_res, v_nota, v_lat, v_lng, v_prec, v_dist, v_fuera)
  returning id into v_id;

  v_estatus := case
    when v_res in ('no_le_interesa', 'ya_no_existe') then 'descartado'
    when v_p.estatus = 'convertido' then 'convertido'
    else 'contactado'
  end;

  -- `notas` NO se toca: la nota de la visita vive en la visita.
  update public.prospectos set
    estatus             = v_estatus,
    fecha_visita        = now(),
    num_visitas         = coalesce(num_visitas, 0) + 1,
    id_vendedor         = v_vend,
    nombre_vendedor     = v_nom,
    motivo_descarte     = case when v_estatus = 'descartado' then public.resultado_visita_etiqueta(v_res) else motivo_descarte end,
    fecha_descarte      = case when v_estatus = 'descartado' then now() else fecha_descarte end,
    fecha_actualizacion = now()
  where id = v_idp;

  return jsonb_build_object('ok', true, 'idVisita', v_id, 'resultado', v_res,
    'etiqueta', public.resultado_visita_etiqueta(v_res), 'estatus', v_estatus,
    'distanciaMetros', v_dist, 'fueraDelPunto', v_fuera, 'idRuta', v_ruta);
end $fn$;
revoke all on function public.registrar_visita(jsonb) from public;
grant execute on function public.registrar_visita(jsonb) to anon, authenticated;

-- ── 4. La ruta del día ──────────────────────────────────────────────────────
create or replace function public.ruta_del_dia(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_vend    bigint;
  v_rol     text;
  v_todas   boolean;
  v_fecha   date;
  v_idruta  bigint;
  v_dow     int;
  v_ruta    public.rutas%rowtype;
  v_nomvend text;
  v_ncli    int;
  v_cupo    int;
  v_cands   jsonb;
  v_rest    jsonb;
  v_orden   jsonb := '[]'::jsonb;
  v_avance  jsonb;
  v_prox    date;
  v_cur_lat double precision := 19.3909758;   -- planta: igual que PLANTA_LAT en index.html
  v_cur_lng double precision := -99.1249345;  -- planta: igual que PLANTA_LNG
  v_i       int;
  v_best    int;
  v_bd      integer;
  v_d       integer;
  v_p       jsonb;
  c_tope    constant int := 60;               -- decisión D3
begin
  select s.id_vendedor into v_vend
    from public.sesion_exige_seccion(p_data->>'token', 'ruta') s;
  if v_vend is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  -- D5: cada vendedor ve su ruta; dueño y socios ven todas. Rol releído de la tabla.
  select lower(trim(v.rol)) into v_rol from public.vendedores v where v.id = v_vend;
  v_todas := coalesce(v_rol, '') in ('admin', 'administrador');   -- solo el dueño; los socios no, por ahora

  begin
    v_fecha  := coalesce(nullif(p_data->>'fecha', '')::date, (now() at time zone 'America/Mexico_City')::date);
    v_idruta := nullif(p_data->>'idRuta', '')::bigint;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'Datos inválidos');
  end;
  v_dow := extract(dow from v_fecha)::int;

  if v_idruta is not null then
    select * into v_ruta from public.rutas where id = v_idruta and activa;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'Ruta no encontrada');
    end if;
    if not v_todas and v_ruta.id_vendedor is distinct from v_vend then
      return jsonb_build_object('ok', false, 'error', 'No es tu ruta');
    end if;
  else
    select * into v_ruta from public.rutas r
     where r.activa and v_dow = any(r.dias) and (v_todas or r.id_vendedor = v_vend)
     order by r.orden, r.id limit 1;
    if not found then
      select g.d::date into v_prox
        from generate_series(v_fecha + 1, v_fecha + 7, interval '1 day') as g(d)
       where exists (select 1 from public.rutas r
                      where r.activa and extract(dow from g.d)::int = any(r.dias)
                        and (v_todas or r.id_vendedor = v_vend))
       order by g.d limit 1;
      return jsonb_build_object('ok', true, 'veTodas', v_todas, 'fecha', v_fecha, 'ruta', null,
        'proximaFecha', v_prox,
        'avance', jsonb_build_object('programadas', 0, 'visitadas', 0, 'convertidas', 0, 'fueraDelPunto', 0),
        'paradas', '[]'::jsonb);
    end if;
  end if;

  select nombre into v_nomvend from public.vendedores where id = v_ruta.id_vendedor;
  select count(*) into v_ncli from public.clientes c
   where c.id_ruta = v_ruta.id and coalesce(c.aprobado_b2b, false) and c.tipo_id in (2, 3, 4);
  v_cupo := greatest(c_tope - least(v_ncli, c_tope), 0);

  with cli as (
    select c.id,
           coalesce(nullif(c.nombre_comercial, ''), nullif(c.nombre, ''), 'Sin nombre') as nombre,
           c.colonia,
           coalesce(c.latitud::double precision,
             case when c.coordenadas ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*,\s*-?[0-9]+(\.[0-9]+)?\s*$'
                  then split_part(c.coordenadas, ',', 1)::double precision end) as lat,
           coalesce(c.longitud::double precision,
             case when c.coordenadas ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*,\s*-?[0-9]+(\.[0-9]+)?\s*$'
                  then split_part(c.coordenadas, ',', 2)::double precision end) as lng,
           hoy.resultado as res_hoy, hoy.fuera_del_punto as fuera_hoy, ult.creada_en as ultima
      from public.clientes c
      left join lateral (select v.resultado, v.fuera_del_punto from public.visitas v
                          where v.id_cliente = c.id
                            and (v.creada_en at time zone 'America/Mexico_City')::date = v_fecha
                          order by v.creada_en desc limit 1) hoy on true
      left join lateral (select v.creada_en from public.visitas v
                          where v.id_cliente = c.id order by v.creada_en desc limit 1) ult on true
     where c.id_ruta = v_ruta.id and coalesce(c.aprobado_b2b, false) and c.tipo_id in (2, 3, 4)
  ),
  pro as (
    select p.id, p.nombre_negocio as nombre, p.colonia, p.estatus, coalesce(p.score, 0) as score,
           p.latitud::double precision as lat, p.longitud::double precision as lng,
           hoy.resultado as res_hoy, hoy.fuera_del_punto as fuera_hoy,
           ult.creada_en as ultima, ult.resultado as ultimo_res,
           case when hoy.resultado is not null then 0
                when ult.resultado = 'interesado' then 1
                when ult.creada_en is null then 2
                else 3 end as nivel
      from public.prospectos p
      left join lateral (select v.resultado, v.fuera_del_punto from public.visitas v
                          where v.id_prospecto = p.id
                            and (v.creada_en at time zone 'America/Mexico_City')::date = v_fecha
                          order by v.creada_en desc limit 1) hoy on true
      left join lateral (select v.creada_en, v.resultado from public.visitas v
                          where v.id_prospecto = p.id order by v.creada_en desc limit 1) ult on true
     where public.ruta_para(nullif(regexp_replace(coalesce(p.codigo_postal, ''), '[^0-9]', '', 'g'), ''), p.colonia) = v_ruta.id
       and (hoy.resultado is not null or p.estatus not in ('descartado', 'convertido'))
       -- A2: visitado en los 6 días anteriores, descansa esta vuelta.
       and (hoy.resultado is not null or ult.creada_en is null
            or (ult.creada_en at time zone 'America/Mexico_City')::date not between v_fecha - 6 and v_fecha - 1)
  )
  select coalesce(jsonb_agg(x.j), '[]'::jsonb) into v_cands
    from (
      (select jsonb_build_object('tipo', 'cliente', 'id', c.id, 'nombre', c.nombre, 'colonia', c.colonia,
                'lat', c.lat, 'lng', c.lng, 'score', null, 'estatus', null,
                'visitadaHoy', c.res_hoy is not null, 'resultadoHoy', c.res_hoy,
                'etiquetaHoy', public.resultado_visita_etiqueta(c.res_hoy), 'fueraDelPunto', c.fuera_hoy,
                'ultimaVisita', c.ultima, 'ultimoResultado', null) as j
         from cli c order by c.id limit c_tope)
      union all
      (select jsonb_build_object('tipo', 'prospecto', 'id', p.id, 'nombre', p.nombre, 'colonia', p.colonia,
                'lat', p.lat, 'lng', p.lng, 'score', p.score, 'estatus', p.estatus,
                'visitadaHoy', p.res_hoy is not null, 'resultadoHoy', p.res_hoy,
                'etiquetaHoy', public.resultado_visita_etiqueta(p.res_hoy), 'fueraDelPunto', p.fuera_hoy,
                'ultimaVisita', p.ultima, 'ultimoResultado', p.ultimo_res) as j
         from pro p
        order by p.nivel,
                 (case when p.nivel = 2 then p.score else 0 end) desc,
                 (case when p.nivel = 3 then p.ultima end) asc nulls last,
                 p.id
        limit v_cupo)
    ) x;

  -- A3: vecino más cercano desde la planta. Sin coordenadas, al final.
  v_rest := v_cands;
  loop
    v_best := null;
    v_bd := null;
    for v_i in 0 .. jsonb_array_length(v_rest) - 1 loop
      v_p := v_rest -> v_i;
      if jsonb_typeof(v_p->'lat') = 'number' and jsonb_typeof(v_p->'lng') = 'number' then
        v_d := public.distancia_metros(v_cur_lat, v_cur_lng, (v_p->>'lat')::double precision, (v_p->>'lng')::double precision);
        if v_bd is null or v_d < v_bd then
          v_bd := v_d;
          v_best := v_i;
        end if;
      end if;
    end loop;
    exit when v_best is null;
    v_p := v_rest -> v_best;
    v_orden := v_orden || jsonb_build_array(v_p);
    v_cur_lat := (v_p->>'lat')::double precision;
    v_cur_lng := (v_p->>'lng')::double precision;
    v_rest := v_rest - v_best;
  end loop;
  v_orden := v_orden || v_rest;

  select coalesce(jsonb_agg(t.e || jsonb_build_object('orden', t.o) order by t.o), '[]'::jsonb)
    into v_orden
    from jsonb_array_elements(v_orden) with ordinality as t(e, o);

  select jsonb_build_object(
           'programadas', count(*),
           'visitadas', count(*) filter (where (t.e->>'visitadaHoy')::boolean),
           'convertidas', count(*) filter (where t.e->>'resultadoHoy' = 'convertido'),
           'fueraDelPunto', count(*) filter (where (t.e->>'fueraDelPunto')::boolean))
    into v_avance
    from jsonb_array_elements(v_orden) as t(e);

  return jsonb_build_object('ok', true, 'veTodas', v_todas, 'fecha', v_fecha, 'proximaFecha', null,
    'ruta', jsonb_build_object('id', v_ruta.id, 'nombre', v_ruta.nombre, 'color', v_ruta.color,
                               'dias', to_jsonb(v_ruta.dias), 'idVendedor', v_ruta.id_vendedor,
                               'vendedor', v_nomvend),
    'avance', v_avance, 'paradas', v_orden);
end $fn$;
revoke all on function public.ruta_del_dia(jsonb) from public;
grant execute on function public.ruta_del_dia(jsonb) to anon, authenticated;
