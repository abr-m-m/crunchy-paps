-- 20261021000000_anaquel_y_prioridad.sql
-- Piezas en anaquel y recompra visible en la ruta
-- (cambios/2026-09-24-motor-comercial/diseno.md §B.1 y §B.2).
--
-- LOS DOS CUERPOS SE COPIARON DE PRODUCCION, no se escribieron de memoria (regla 24). Antes de
-- editarlos se comprobo que staging y produccion tenian el MISMO md5:
--   registrar_visita  64c0387d15cefcc83e1a28758115c74e  (6,094 B)
--   ruta_del_dia      c51ec8ebc6e936cde79c968c2a6eee7b  (8,993 B)
-- Los cambios son quirurgicos y estan marcados con comentarios en el cuerpo.
--
-- CORRECCION AL PLAN, hallada al leer el codigo: `ruta_del_dia` arma los candidatos por prioridad
-- pero DESPUES los reordena geograficamente por vecino mas cercano (bloque A3). La prioridad NO
-- decide el orden de visita: solo decide quien entra cuando hay mas candidatos que el tope de 60, y
-- con 5 tiendas hoy entran todas. Por eso el cambio tiene DOS mitades:
--   1. El orden de corte de `cli` (que sirve cuando una ruta pase de 60 clientes).
--   2. Que cada parada de cliente LLEVE su etapa y sus dias sin comprar, que es lo que el vendedor
--      ve al caminar y lo unico que cambia algo manana.
-- Decision de Abraham, 24 sep 2026: las dos.

create or replace function public.registrar_visita(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
declare
  v_anaquel integer;   -- piezas en el anaquel (motor comercial, tarea 2)
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
  -- Cuantas piezas le quedan en el anaquel. Opcional: si no viene o no es numero, queda NULL y
  -- la visita se registra igual. Un 0 significaria «anaquel vacio», que es un dato distinto de
  -- «no lo preguntaron».
  begin
    v_anaquel := nullif(btrim(coalesce(p_data->>'piezasEnAnaquel','')), '')::integer;
  exception when others then
    v_anaquel := null;
  end;
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
                                resultado, nota, lat, lng, precision_metros, distancia_metros, fuera_del_punto, piezas_en_anaquel)
    values (null, v_idc, v_vend, v_nom, v_c.id_ruta, v_res, v_nota, v_lat, v_lng, v_prec, v_dist, v_fuera, v_anaquel)
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
                              resultado, nota, lat, lng, precision_metros, distancia_metros, fuera_del_punto, piezas_en_anaquel)
  values (v_idp, v_idc, v_vend, v_nom, v_ruta, v_res, v_nota, v_lat, v_lng, v_prec, v_dist, v_fuera, v_anaquel)
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

create or replace function public.ruta_del_dia(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
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
           hoy.resultado as res_hoy, hoy.fuera_del_punto as fuera_hoy, ult.creada_en as ultima,
           pe.ultimo_pedido,
           case when pe.ultimo_pedido is null then null else (v_fecha - pe.ultimo_pedido) end as dias_sin_comprar,
           -- Mismo vocabulario y misma precedencia que la vista `cuentas` (D7/D8).
           case when pe.ultimo_pedido is null then 'pendiente'
                when v_fecha - pe.ultimo_pedido > 21 then 'dormido'
                when coalesce(pe.pedidos, 0) >= 2 then 'activo'
                else 'cliente' end as etapa,
           -- La prioridad ordena el CORTE de 60, no el recorrido: el orden de visita lo pone
           -- despues el vecino mas cercano (A3). Con 5 tiendas hoy no cambia nada; existe para
           -- cuando una ruta pase de 60 clientes.
           case when hoy.resultado is not null then 0
                when pe.ultimo_pedido is not null and v_fecha - pe.ultimo_pedido > 21 then 1
                when pe.ultimo_pedido is not null then 2
                else 3 end as nivel
      from public.clientes c
      left join lateral (select v.resultado, v.fuera_del_punto from public.visitas v
                          where v.id_cliente = c.id
                            and (v.creada_en at time zone 'America/Mexico_City')::date = v_fecha
                          order by v.creada_en desc limit 1) hoy on true
      left join lateral (select v.creada_en from public.visitas v
                          where v.id_cliente = c.id order by v.creada_en desc limit 1) ult on true
      left join lateral (select max(o.fecha_orden)::date as ultimo_pedido, count(*) as pedidos
                           from public.ordenes o
                          where o.id_cliente = c.id
                            and coalesce(o.tipo_interno, '') = ''
                            and o.estatus_pedido <> 'Cancelado') pe on true
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
                'ultimaVisita', c.ultima, 'ultimoResultado', null,
                'etapa', c.etapa, 'diasSinComprar', c.dias_sin_comprar) as j
         from cli c order by c.nivel, c.ultimo_pedido asc nulls last, c.id limit c_tope)
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
end $fn$;

