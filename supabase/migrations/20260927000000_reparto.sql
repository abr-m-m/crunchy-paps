-- 20260927000000_reparto.sql — Reparto P1 (cambios/2026-09-17-reparto.md, R-D1..R-D10)
-- Tenderos por ruta y en bloque; consumidores por quien vendió (id_repartidor) o paquetería.
-- Aplicar en staging (dkwatbsaidlfjqjnfyrk) primero; producción (xbyzarzyxiugrucyjwfn) con permiso.

-- 1) Columnas nuevas en ordenes: nada existente cambia.
alter table public.ordenes
  add column if not exists id_repartidor bigint references public.vendedores(id),
  add column if not exists metodo_entrega text,
  add column if not exists cargado_en timestamptz,
  add column if not exists cargado_por bigint,
  add column if not exists entrega_lat numeric,
  add column if not exists entrega_lng numeric,
  add column if not exists entrega_distancia_m integer,
  add column if not exists entrega_fuera_del_punto boolean,
  add column if not exists devuelto_en timestamptz;
alter table public.ordenes drop constraint if exists ordenes_metodo_entrega_check;
alter table public.ordenes add constraint ordenes_metodo_entrega_check
  check (metodo_entrega is null or metodo_entrega in ('domicilio', 'paqueteria'));
comment on column public.ordenes.id_repartidor is 'Quién reparte (solo consumidores). Nulo = el vendedor del pedido. R-D2.';
comment on column public.ordenes.metodo_entrega is 'domicilio | paqueteria. Nulo en pedidos anteriores al 17 sep 2026 = domicilio.';

-- Backfill: la paquetería solo vivía en la etiqueta de notas.
update public.ordenes set metodo_entrega = 'paqueteria'
 where metodo_entrega is null and notas ilike '%[ENTREGA: Paqueter%';

-- 2) Repartidor efectivo (R-D2, R-D7). Función pura: no lee sesión.
create or replace function public.repartidor_de(o public.ordenes) returns bigint
language sql stable set search_path = public, extensions, pg_temp as $fn$
  select case
    when o.metodo_entrega = 'paqueteria' then null
    when o.id_ruta is not null
         and exists (select 1 from public.clientes c where c.id = o.id_cliente and c.tipo_id in (2, 3, 4))
      then (select r.id_vendedor from public.rutas r where r.id = o.id_ruta and r.activa)
    else coalesce(o.id_repartidor, o.id_vendedor)
  end;
$fn$;
revoke all on function public.repartidor_de(public.ordenes) from public;

-- 3) Secciones: reparto y entregas entran al catálogo.
create or replace function public.sesion_secciones(p_token text)
returns text[] language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
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
    'gastos','jornadas','productos','cupones','resumen','cuenta','armado','ruta',
    'reparto','entregas'
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
end $fn$;
revoke all on function public.sesion_secciones(text) from public, anon, authenticated;

-- Rol administrador: +reparto. Rol vendedor (los contratados que vengan): +reparto +entregas, conserva ruta.
update public.config_secciones set secciones = array_append(secciones, 'reparto')
 where lower(rol) = 'administrador' and not ('reparto' = any(secciones));
update public.config_secciones set secciones = array_append(secciones, 'reparto')
 where lower(rol) = 'vendedor' and not ('reparto' = any(secciones));
update public.config_secciones set secciones = array_append(secciones, 'entregas')
 where lower(rol) = 'vendedor' and not ('entregas' = any(secciones));
-- La familia (vendedores con lista personal): ruta fuera, entregas dentro (R-D8).
update public.vendedores
   set secciones = array_append(array_remove(secciones, 'ruta'), 'entregas')
 where lower(trim(rol)) = 'vendedor' and secciones is not null and array_length(secciones, 1) > 0
   and not ('entregas' = any(secciones));

-- 4) reparto_del_dia: los bloques del día, con alcance por token.
create or replace function public.reparto_del_dia(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_vend    bigint;
  v_rol     text;
  v_todas   boolean;
  v_fecha   date;
  v_rutas   jsonb;
  v_cons    jsonb;
  v_paq     jsonb;
  v_sin     jsonb;
  v_porconf int;
begin
  select s.id_vendedor into v_vend from public.sesion_exige_seccion(p_data->>'token', 'reparto') s;
  if v_vend is null then
    select s.id_vendedor into v_vend from public.sesion_exige_seccion(p_data->>'token', 'entregas') s;
  end if;
  if v_vend is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  select lower(trim(v.rol)) into v_rol from public.vendedores v where v.id = v_vend;
  v_todas := coalesce(v_rol, '') in ('admin', 'administrador');   -- R-D10: solo el dueño
  begin
    v_fecha := coalesce(nullif(p_data->>'fecha', '')::date, (now() at time zone 'America/Mexico_City')::date);
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'Datos inválidos');
  end;

  -- Pendientes del día: se cuentan, no entran.
  select count(*) into v_porconf from public.ordenes o
   where o.fecha_entrega::date = v_fecha and coalesce(o.tipo_interno, '') = '' and o.estatus_pedido = 'Pendiente';

  -- Cada pedido como lo pinta la app.
  create temp table if not exists t_ped (id bigint, j jsonb, id_ruta bigint, tienda boolean, rep bigint, lat double precision, lng double precision) on commit drop;
  truncate t_ped;
  insert into t_ped
  select o.id,
         jsonb_build_object('id', o.id, 'consecutivo', o.consecutivo, 'cliente', o.nombre_cliente,
           'telefono', c.telefono, 'direccion', o.direccion, 'colonia', o.colonia,
           'lat', x.lat, 'lng', x.lng, 'total', o.total, 'estatusPago', o.estatus_pago,
           'estatusPedido', o.estatus_pedido, 'armadoEn', o.armado_en, 'cargadoEn', o.cargado_en,
           'entregaDistanciaM', o.entrega_distancia_m, 'entregaFueraDelPunto', o.entrega_fuera_del_punto,
           'idVendedor', o.id_vendedor, 'idRepartidor', o.id_repartidor, 'metodoEntrega', coalesce(o.metodo_entrega, 'domicilio'),
           'idRuta', o.id_ruta),
         o.id_ruta,
         coalesce(c.tipo_id in (2, 3, 4), false),
         public.repartidor_de(o),
         x.lat, x.lng
    from public.ordenes o                    -- la fila real: repartidor_de(o) exige el tipo ordenes
    left join public.clientes c on c.id = o.id_cliente
    left join lateral (select
        case when o.coordenadas ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*,\s*-?[0-9]+(\.[0-9]+)?\s*$'
             then split_part(o.coordenadas, ',', 1)::double precision end as lat,
        case when o.coordenadas ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*,\s*-?[0-9]+(\.[0-9]+)?\s*$'
             then split_part(o.coordenadas, ',', 2)::double precision end as lng) x on true
   where o.fecha_entrega::date = v_fecha
     and coalesce(o.tipo_interno, '') = ''
     and o.estatus_pedido in ('En proceso', 'En camino', 'Entregado');   -- universo del día: confirmados; los entregados se quedan a la vista con su check

  -- Bloques por ruta: solo tiendas con ruta activa; orden por distancia a la planta.
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'nombre', r.nombre, 'color', r.color,
           'idVendedor', r.id_vendedor, 'pedidos', p.arr) order by r.orden, r.id), '[]'::jsonb)
    into v_rutas
    from public.rutas r
    join lateral (select jsonb_agg(t.j order by public.distancia_metros(19.3909758, -99.1249345, t.lat, t.lng) nulls last, t.id) as arr
                    from t_ped t where t.id_ruta = r.id and t.tienda) p on p.arr is not null
   where r.activa and (v_todas or r.id_vendedor = v_vend);

  -- Consumidores por repartidor efectivo (no tiendas, no paquetería).
  select coalesce(jsonb_agg(jsonb_build_object('idRepartidor', g.rep, 'nombre', v.nombre, 'pedidos', g.arr) order by v.nombre), '[]'::jsonb)
    into v_cons
    from (select t.rep, jsonb_agg(t.j order by public.distancia_metros(19.3909758, -99.1249345, t.lat, t.lng) nulls last, t.id) as arr
            from t_ped t where not t.tienda and t.rep is not null and (t.j->>'metodoEntrega') <> 'paqueteria'
             and (v_todas or t.rep = v_vend)
           group by t.rep) g
    left join public.vendedores v on v.id = g.rep;

  -- Paquetería y sin ruta: solo el dueño.
  select coalesce(jsonb_agg(t.j order by t.id), '[]'::jsonb) into v_paq
    from t_ped t where v_todas and (t.j->>'metodoEntrega') = 'paqueteria';
  select coalesce(jsonb_agg(t.j order by t.id), '[]'::jsonb) into v_sin
    from t_ped t where v_todas and (t.j->>'metodoEntrega') <> 'paqueteria'
     and t.rep is null;

  return jsonb_build_object('ok', true, 'fecha', v_fecha, 'todas', v_todas,
    'rutas', v_rutas, 'consumidores', v_cons, 'paqueteria', v_paq, 'sinRuta', v_sin,
    'porConfirmar', v_porconf);
end $fn$;
revoke all on function public.reparto_del_dia(jsonb) from public;
grant execute on function public.reparto_del_dia(jsonb) to anon, authenticated;

-- 5) ¿Este pedido está en el alcance de quien llama? (misma regla que reparto_del_dia)
create or replace function public.reparto_en_alcance(p_vend bigint, p_todas boolean, p_id bigint) returns boolean
language sql stable set search_path = public, extensions, pg_temp as $fn$
  select exists (
    select 1 from public.ordenes o
    left join public.clientes c on c.id = o.id_cliente
    where o.id = p_id and coalesce(o.tipo_interno, '') = ''
      and (p_todas
           or (c.tipo_id in (2, 3, 4) and o.id_ruta is not null
               and exists (select 1 from public.rutas r where r.id = o.id_ruta and r.activa and r.id_vendedor = p_vend))
           or (coalesce(c.tipo_id, 1) not in (2, 3, 4) and public.repartidor_de(o) = p_vend)));
$fn$;
revoke all on function public.reparto_en_alcance(bigint, boolean, bigint) from public;

-- 6) salir_a_ruta: «En camino» en bloque, uno por uno por la función de estatus.
create or replace function public.salir_a_ruta(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_vend  bigint; v_rol text; v_todas boolean; v_nom text;
  v_id    bigint; v_est text; v_n int := 0; v_rech jsonb := '[]'::jsonb; v_r jsonb;
begin
  select s.id_vendedor into v_vend from public.sesion_exige_seccion(p_data->>'token', 'reparto') s;
  if v_vend is null then
    select s.id_vendedor into v_vend from public.sesion_exige_seccion(p_data->>'token', 'entregas') s;
  end if;
  if v_vend is null then return jsonb_build_object('ok', false, 'error', 'No autorizado'); end if;
  select lower(trim(v.rol)), v.nombre into v_rol, v_nom from public.vendedores v where v.id = v_vend;
  v_todas := coalesce(v_rol, '') in ('admin', 'administrador');
  if jsonb_typeof(p_data->'ids') <> 'array' or jsonb_array_length(p_data->'ids') = 0 then
    return jsonb_build_object('ok', false, 'error', 'Sin pedidos');
  end if;
  for v_id in select (e)::bigint from jsonb_array_elements_text(p_data->'ids') as e loop
    select o.estatus_pedido into v_est from public.ordenes o where o.id = v_id;
    if v_est is null or not public.reparto_en_alcance(v_vend, v_todas, v_id) then
      v_rech := v_rech || jsonb_build_object('id', v_id, 'motivo', 'No es tuyo');
    elsif v_est <> 'En proceso' then
      v_rech := v_rech || jsonb_build_object('id', v_id, 'motivo', 'Está ' || v_est);
    else
      v_r := public.actualizar_estatus_pedido_interno(jsonb_build_object('idOrden', v_id, 'estatusPedido', 'En camino', 'actualizadoPor', v_nom));
      if coalesce((v_r->>'ok')::boolean, false) then v_n := v_n + 1;
      else v_rech := v_rech || jsonb_build_object('id', v_id, 'motivo', coalesce(v_r->>'error', 'Error')); end if;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'cambiados', v_n, 'rechazados', v_rech);
end $fn$;
revoke all on function public.salir_a_ruta(jsonb) from public;
grant execute on function public.salir_a_ruta(jsonb) to anon, authenticated;

-- 7) entregar_pedido: «Entregado» con ubicación (R-D5); paquetería «Enviado» sin ubicación.
create or replace function public.entregar_pedido(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_vend bigint; v_rol text; v_todas boolean; v_nom text;
  v_id bigint; v_o public.ordenes%rowtype;
  v_lat double precision; v_lng double precision; v_plat double precision; v_plng double precision;
  v_d integer; v_fuera boolean; v_r jsonb;
  c_radio constant integer := 100;
begin
  select s.id_vendedor into v_vend from public.sesion_exige_seccion(p_data->>'token', 'reparto') s;
  if v_vend is null then
    select s.id_vendedor into v_vend from public.sesion_exige_seccion(p_data->>'token', 'entregas') s;
  end if;
  if v_vend is null then return jsonb_build_object('ok', false, 'error', 'No autorizado'); end if;
  select lower(trim(v.rol)), v.nombre into v_rol, v_nom from public.vendedores v where v.id = v_vend;
  v_todas := coalesce(v_rol, '') in ('admin', 'administrador');
  begin
    v_id := (p_data->>'id')::bigint;
    v_lat := nullif(p_data->>'lat', '')::double precision;
    v_lng := nullif(p_data->>'lng', '')::double precision;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'Datos inválidos');
  end;
  select * into v_o from public.ordenes where id = v_id;
  if not found or not public.reparto_en_alcance(v_vend, v_todas, v_id) then
    return jsonb_build_object('ok', false, 'error', 'No es tuyo');
  end if;
  if v_o.estatus_pedido not in ('En proceso', 'En camino') then
    return jsonb_build_object('ok', false, 'error', 'Está ' || v_o.estatus_pedido);
  end if;

  -- Paquetería: «Enviado» = En camino, sin ubicación.
  if coalesce((p_data->>'enviado')::boolean, false) then
    if coalesce(v_o.metodo_entrega, 'domicilio') <> 'paqueteria' then
      return jsonb_build_object('ok', false, 'error', 'No va por paquetería');
    end if;
    v_r := public.actualizar_estatus_pedido_interno(jsonb_build_object('idOrden', v_id, 'estatusPedido', 'En camino', 'actualizadoPor', v_nom));
    return v_r || jsonb_build_object('estatus', 'En camino');
  end if;

  if v_lat is null or v_lng is null then
    return jsonb_build_object('ok', false, 'error', 'Sin ubicación no se puede marcar la entrega');
  end if;
  if v_o.coordenadas ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*,\s*-?[0-9]+(\.[0-9]+)?\s*$' then
    v_plat := split_part(v_o.coordenadas, ',', 1)::double precision;
    v_plng := split_part(v_o.coordenadas, ',', 2)::double precision;
    v_d := public.distancia_metros(v_lat, v_lng, v_plat, v_plng);
    v_fuera := v_d > c_radio;
  end if;
  update public.ordenes
     set entrega_lat = v_lat, entrega_lng = v_lng, entrega_distancia_m = v_d, entrega_fuera_del_punto = v_fuera
   where id = v_id;
  v_r := public.actualizar_estatus_pedido_interno(jsonb_build_object('idOrden', v_id, 'estatusPedido', 'Entregado', 'actualizadoPor', v_nom));
  return v_r || jsonb_build_object('estatus', 'Entregado', 'distanciaM', v_d, 'fueraDelPunto', v_fuera);
end $fn$;
revoke all on function public.entregar_pedido(jsonb) from public;
grant execute on function public.entregar_pedido(jsonb) to anon, authenticated;

-- 8) asignar_repartidor: solo el dueño, solo consumidores (R-D2).
create or replace function public.asignar_repartidor(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint; v_rep bigint; v_tipo int; v_nom text;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  begin
    v_id := (p_data->>'id')::bigint;
    v_rep := nullif(p_data->>'idRepartidor', '')::bigint;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'Datos inválidos');
  end;
  select c.tipo_id into v_tipo from public.ordenes o left join public.clientes c on c.id = o.id_cliente where o.id = v_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado'); end if;
  if v_tipo in (2, 3, 4) then return jsonb_build_object('ok', false, 'error', 'Solo pedidos de consumidor'); end if;
  if v_rep is not null then
    select nombre into v_nom from public.vendedores where id = v_rep and activo;
    if v_nom is null then return jsonb_build_object('ok', false, 'error', 'Repartidor no encontrado'); end if;
  end if;
  update public.ordenes set id_repartidor = v_rep where id = v_id;
  return jsonb_build_object('ok', true, 'idRepartidor', v_rep, 'repartidor', v_nom);
end $fn$;
revoke all on function public.asignar_repartidor(jsonb) from public;
grant execute on function public.asignar_repartidor(jsonb) to anon, authenticated;
