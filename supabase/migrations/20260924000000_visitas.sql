-- 20260924000000_visitas.sql
-- Ruta del día, entrega 1 (cambios/2026-09-16-ruta-del-dia.md): cada visita es un
-- renglón que nunca se borra, con resultado de catálogo, ubicación obligatoria y
-- distancia a la tienda. Re-ejecutable.

-- ── 1. Tabla ────────────────────────────────────────────────────────────────
create table if not exists public.visitas (
  id               bigserial primary key,
  id_prospecto     bigint references public.prospectos(id),
  id_cliente       bigint references public.clientes(id),
  id_vendedor      bigint not null,
  nombre_vendedor  text,
  id_ruta          bigint references public.rutas(id) on delete set null,
  resultado        text not null check (resultado in ('convertido','interesado','no_estaba',
                     'ya_tiene_proveedor','caro','no_le_interesa','ya_no_existe')),
  nota             text,
  lat              double precision not null check (lat between -90 and 90),
  lng              double precision not null check (lng between -180 and 180),
  precision_metros double precision,
  distancia_metros integer,
  fuera_del_punto  boolean,
  creada_en        timestamptz not null default now(),
  constraint visitas_a_alguien check (id_prospecto is not null or id_cliente is not null)
);
create index if not exists visitas_prospecto on public.visitas (id_prospecto, creada_en desc);
create index if not exists visitas_ruta_dia on public.visitas (id_ruta, creada_en);
create index if not exists visitas_vendedor_dia on public.visitas (id_vendedor, creada_en);

-- Cerrada: solo la escriben y leen los RPC de abajo (security definer).
alter table public.visitas enable row level security;
revoke all on public.visitas from anon, authenticated;
revoke all on sequence public.visitas_id_seq from anon, authenticated;

-- Solo-INSERT, como caja_movimientos y lealtad_movimientos.
create or replace function public.trg_visitas_solo_insert() returns trigger
language plpgsql as $fn$
begin
  raise exception 'visitas es solo-INSERT: no se actualiza ni se borra';
end $fn$;
drop trigger if exists trg_visitas_solo_insert on public.visitas;
create trigger trg_visitas_solo_insert before update or delete on public.visitas
  for each row execute function public.trg_visitas_solo_insert();

-- ── 2. Auxiliares ───────────────────────────────────────────────────────────
-- Distancia en metros entre dos puntos (haversine).
create or replace function public.distancia_metros(lat1 double precision, lng1 double precision,
                                                   lat2 double precision, lng2 double precision)
returns integer language sql immutable as $fn$
  select round(2 * 6371000 * asin(sqrt(
           power(sin(radians(lat2 - lat1) / 2), 2) +
           cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))))::integer;
$fn$;
revoke all on function public.distancia_metros(double precision, double precision, double precision, double precision) from public;

-- Código → etiqueta. NULL = fuera de catálogo.
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
  end;
$fn$;
revoke all on function public.resultado_visita_etiqueta(text) from public;

-- ── 3. registrar_visita ─────────────────────────────────────────────────────
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

  if v_idp is null then
    return jsonb_build_object('ok', false, 'error', 'Falta el prospecto');
  end if;
  if v_lat is null or v_lng is null then
    return jsonb_build_object('ok', false, 'error', 'Falta la ubicación: sin ubicación no se registra la visita');
  end if;
  if v_lat not between -90 and 90 or v_lng not between -180 and 180 then
    return jsonb_build_object('ok', false, 'error', 'Ubicación inválida');
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

  -- El CP de prospectos trae basura de importación (un apóstrofo delante): se limpia.
  v_ruta := public.ruta_para(nullif(regexp_replace(coalesce(v_p.codigo_postal, ''), '[^0-9]', '', 'g'), ''), v_p.colonia);
  select nombre into v_nom from public.vendedores where id = v_vend;

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

-- ── 4. obtener_visitas ──────────────────────────────────────────────────────
create or replace function public.obtener_visitas(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_vend bigint;
  v_idp  bigint;
  v_pro  jsonb;
  v_vis  jsonb;
begin
  select s.id_vendedor into v_vend
    from public.sesion_exige_seccion(p_data->>'token', 'prospeccion') s;
  if v_vend is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  begin
    v_idp := nullif(p_data->>'idProspecto', '')::bigint;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'Falta el prospecto');
  end;
  if v_idp is null then
    return jsonb_build_object('ok', false, 'error', 'Falta el prospecto');
  end if;

  select jsonb_build_object('id', p.id, 'estatus', p.estatus, 'numVisitas', coalesce(p.num_visitas, 0),
           'notas', p.notas, 'motivoDescarte', p.motivo_descarte, 'fechaDescarte', p.fecha_descarte,
           'idClienteConvertido', p.id_cliente_convertido)
    into v_pro
    from public.prospectos p where p.id = v_idp;
  if v_pro is null then
    return jsonb_build_object('ok', false, 'error', 'Prospecto no encontrado');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', v.id, 'resultado', v.resultado, 'etiqueta', public.resultado_visita_etiqueta(v.resultado),
           'nota', v.nota, 'vendedor', v.nombre_vendedor, 'distanciaMetros', v.distancia_metros,
           'fueraDelPunto', v.fuera_del_punto, 'idCliente', v.id_cliente, 'creadaEn', v.creada_en)
         order by v.creada_en desc, v.id desc), '[]'::jsonb)
    into v_vis
    from (select * from public.visitas where id_prospecto = v_idp
           order by creada_en desc, id desc limit 20) v;

  return jsonb_build_object('ok', true, 'prospecto', v_pro, 'visitas', v_vis);
end $fn$;
revoke all on function public.obtener_visitas(jsonb) from public;
grant execute on function public.obtener_visitas(jsonb) to anon, authenticated;
