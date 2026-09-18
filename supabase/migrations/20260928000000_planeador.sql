-- 20260928000000_planeador.sql — Planeador E3.1 (cambios/2026-09-17-planeador.md, P-D1..P-D10)
-- Días de preventa por ruta, get/set_rutas v3, ruta_del_dia v2 y el RPC del planeador.
-- get_rutas, set_rutas y ruta_del_dia se volcaron de producción el 17 sep 2026 (idénticas a staging)
-- y se cambian solo en las líneas marcadas con P-D3. Staging primero; producción con permiso.

-- 1) Reparto y preventa son dos calendarios (P-D3). Nulo = los mismos días que reparto.
alter table public.rutas add column if not exists dias_preventa int[];
comment on column public.rutas.dias_preventa is 'Días de visita (0=dom..6=sáb). Nulo = igual que dias (reparto). P-D3.';

-- 2) get_rutas v3: diasPreventa y el nombre del vendedor.
CREATE OR REPLACE FUNCTION public.get_rutas(p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'nombre', r.nombre, 'color', r.color, 'dias', to_jsonb(r.dias),
           'diasPreventa', to_jsonb(r.dias_preventa),
           'activa', r.activa, 'orden', r.orden, 'idVendedor', r.id_vendedor,
           'vendedor', (select v2.nombre from public.vendedores v2 where v2.id = r.id_vendedor),
           'cobertura', (select coalesce(jsonb_agg(jsonb_build_object('tipo', c.tipo, 'valor', c.valor, 'cpHasta', c.cp_hasta) order by c.tipo, c.valor), '[]'::jsonb)
                           from public.rutas_cobertura c where c.id_ruta = r.id)
         ) order by r.orden, r.id), '[]'::jsonb)
    into v
    from public.rutas r
   where r.activa or coalesce((p_data->>'incluirInactivas')::boolean, false);
  return jsonb_build_object('ok', true, 'rutas', v);
end $function$;
revoke all on function public.get_rutas(jsonb) from public;
grant execute on function public.get_rutas(jsonb) to anon, authenticated;

-- 3) set_rutas v3: acepta diasPreventa; sin la clave, conserva el valor.
CREATE OR REPLACE FUNCTION public.set_rutas(p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  r jsonb; c jsonb; v_id bigint; v_ids bigint[] := '{}'; v_n int := 0; v_dup text;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  if jsonb_typeof(p_data->'rutas') <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'Faltan rutas');
  end if;
  -- Validar antes de escribir: una colonia o un CP en dos rutas.
  select string_agg(y.valor, ', ') into v_dup
    from (select min(x.valor) as valor
            from (select public.normalizar_colonia(cc->>'valor') || '|' || (cc->>'tipo') as clave,
                         cc->>'valor' as valor, rr->>'nombre' as ruta
                    from jsonb_array_elements(p_data->'rutas') rr,
                         jsonb_array_elements(coalesce(rr->'cobertura', '[]'::jsonb)) cc) x
           group by x.clave having count(distinct x.ruta) > 1) y;
  if v_dup is not null then
    return jsonb_build_object('ok', false, 'error', 'Cobertura repetida en dos rutas: ' || v_dup);
  end if;
  -- Dos rutas con el mismo nombre en la misma petición.
  select string_agg(y.nombre, ', ') into v_dup
    from (select lower(trim(rr->>'nombre')) as nombre from jsonb_array_elements(p_data->'rutas') rr
           group by 1 having count(*) > 1) y;
  if v_dup is not null then
    return jsonb_build_object('ok', false, 'error', 'Dos rutas con el mismo nombre: ' || v_dup);
  end if;
  for r in select * from jsonb_array_elements(p_data->'rutas') loop
    if coalesce(trim(r->>'nombre'), '') = '' then
      return jsonb_build_object('ok', false, 'error', 'Una ruta sin nombre');
    end if;
    v_id := coalesce(nullif(r->>'id', '')::bigint,
                     (select ru.id from public.rutas ru where lower(ru.nombre) = lower(trim(r->>'nombre'))),
                     nextval('public.rutas_id_seq'));
    insert into public.rutas (id, nombre, color, dias, activa, orden, actualizada_en)
    values (v_id,
            trim(r->>'nombre'), coalesce(nullif(r->>'color', ''), '#ffd200'),
            coalesce((select array_agg((d)::int) from jsonb_array_elements_text(coalesce(r->'dias', '[]'::jsonb)) d), '{}'),
            coalesce((r->>'activa')::boolean, true), v_n, now())
    on conflict (id) do update
      set nombre = excluded.nombre, color = excluded.color, dias = excluded.dias,
          activa = excluded.activa, orden = excluded.orden, actualizada_en = now()
    returning id into v_id;
    -- P-D3: días de preventa. Si la clave no viene (editor del teléfono), se conserva lo que había.
    if r ? 'diasPreventa' then
      update public.rutas
         set dias_preventa = case when jsonb_typeof(r->'diasPreventa') = 'array'
                                  then (select array_agg((d)::int) from jsonb_array_elements_text(r->'diasPreventa') d)
                                  else null end
       where id = v_id;
    end if;
    v_ids := v_ids || v_id; v_n := v_n + 1;
    delete from public.rutas_cobertura where id_ruta = v_id;
    for c in select * from jsonb_array_elements(coalesce(r->'cobertura', '[]'::jsonb)) loop
      if (c->>'tipo') in ('colonia', 'cp') and coalesce(trim(c->>'valor'), '') <> '' then
        insert into public.rutas_cobertura (id_ruta, tipo, valor, cp_hasta)
        values (v_id, c->>'tipo', trim(c->>'valor'), nullif(trim(c->>'cpHasta'), ''));
      end if;
    end loop;
  end loop;
  -- Las que no vienen se desactivan, no se borran: hay pedidos que las citan.
  update public.rutas set activa = false, actualizada_en = now()
   where activa and not (id = any(v_ids));
  perform setval('public.rutas_id_seq', greatest((select coalesce(max(id), 0) from public.rutas), 1));
  return jsonb_build_object('ok', true, 'rutas', v_n);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'Ya existe otra ruta con ese nombre: ' || coalesce(trim(r->>'nombre'), '?'));
end $function$;
revoke all on function public.set_rutas(jsonb) from public;
grant execute on function public.set_rutas(jsonb) to anon, authenticated;

-- 4) ruta_del_dia v2: la visita va por preventa; sin preventa capturada, por reparto.
CREATE OR REPLACE FUNCTION public.ruta_del_dia(p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
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
     where r.activa and v_dow = any(coalesce(r.dias_preventa, r.dias)) and (v_todas or r.id_vendedor = v_vend)
     order by r.orden, r.id limit 1;
    if not found then
      select g.d::date into v_prox
        from generate_series(v_fecha + 1, v_fecha + 7, interval '1 day') as g(d)
       where exists (select 1 from public.rutas r
                      where r.activa and extract(dow from g.d)::int = any(coalesce(r.dias_preventa, r.dias))
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
                               'dias', to_jsonb(v_ruta.dias), 'diasPreventa', to_jsonb(v_ruta.dias_preventa), 'idVendedor', v_ruta.id_vendedor,
                               'vendedor', v_nomvend),
    'avance', v_avance, 'paradas', v_orden);
end $function$;
revoke all on function public.ruta_del_dia(jsonb) from public;
grant execute on function public.ruta_del_dia(jsonb) to anon, authenticated;

-- 5) planeador_datos: conteos por CP y las rutas, solo el dueño (P-D2, P-D4). Sin nombres ni teléfonos.
create or replace function public.planeador_datos(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare v_cps jsonb; v_sin jsonb; v_rutas jsonb;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  with pro as (
    select nullif(regexp_replace(coalesce(p.codigo_postal, ''), '[^0-9]', '', 'g'), '') as cp,
           nullif(trim(p.colonia), '') as colonia,
           p.latitud::double precision as lat, p.longitud::double precision as lng
      from public.prospectos p
     where p.estatus not in ('descartado', 'convertido')
  ),
  cli as (
    select nullif(regexp_replace(coalesce(c.cp, ''), '[^0-9]', '', 'g'), '') as cp,
           nullif(trim(c.colonia), '') as colonia,
           (coalesce(c.aprobado_b2b, false) and c.tipo_id in (2, 3, 4)) as tienda
      from public.clientes c
  ),
  cps as (
    select cp from pro where cp is not null
    union
    select cp from cli where cp is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'cp', x.cp,
           'colonias', (select coalesce(jsonb_agg(distinct initcap(lower(pro.colonia))), '[]'::jsonb) from pro where pro.cp = x.cp and pro.colonia is not null),
           'prospectos', (select count(*) from pro where pro.cp = x.cp),
           'tiendas', (select count(*) from cli where cli.cp = x.cp and cli.tienda),
           'consumidores', (select count(*) from cli where cli.cp = x.cp and not cli.tienda),
           'lat', (select avg(pro.lat) from pro where pro.cp = x.cp and pro.lat is not null and pro.lng is not null),
           'lng', (select avg(pro.lng) from pro where pro.cp = x.cp and pro.lat is not null and pro.lng is not null),
           -- Desglose por colonia: la colonia manda sobre el CP (ruta_para), así que los totales por ruta
           -- se cuentan fila por fila, no CP por CP.
           'detalle', (select coalesce(jsonb_agg(jsonb_build_object('colonia', d.col, 'prospectos', d.p, 'tiendas', d.t, 'consumidores', d.c) order by d.col), '[]'::jsonb)
                         from (select u.col, sum(u.p)::int as p, sum(u.t)::int as t, sum(u.c)::int as c
                                 from (select coalesce(pro.colonia, '') as col, 1 as p, 0 as t, 0 as c from pro where pro.cp = x.cp
                                       union all
                                       select coalesce(cli.colonia, ''), 0, case when cli.tienda then 1 else 0 end, case when cli.tienda then 0 else 1 end
                                         from cli where cli.cp = x.cp) u
                                group by u.col) d)
         ) order by x.cp), '[]'::jsonb)
    into v_cps
    from cps x;
  select jsonb_build_object(
           'prospectos', (select count(*) from public.prospectos p where p.estatus not in ('descartado', 'convertido')
                           and nullif(regexp_replace(coalesce(p.codigo_postal, ''), '[^0-9]', '', 'g'), '') is null),
           'tiendas', (select count(*) from public.clientes c where coalesce(c.aprobado_b2b, false) and c.tipo_id in (2, 3, 4)
                        and nullif(regexp_replace(coalesce(c.cp, ''), '[^0-9]', '', 'g'), '') is null))
    into v_sin;
  v_rutas := public.get_rutas(jsonb_build_object('incluirInactivas', true)) -> 'rutas';
  return jsonb_build_object('ok', true, 'cps', v_cps, 'sinCp', v_sin, 'rutas', v_rutas, 'generado', now());
end $fn$;
revoke all on function public.planeador_datos(jsonb) from public;
grant execute on function public.planeador_datos(jsonb) to anon, authenticated;
