-- 20260930000003_planeador_recalcular.sql — Planeador E3.2 (cambios/2026-09-17-planeador.md, P-D6)
-- Ruta fijada a mano, reasignar_ruta_cliente v2 y el recálculo de tiendas por cobertura.

-- 1) La ruta puesta a mano se distingue de la calculada. Las existentes nacen sin fijar: el recálculo
--    las enseña a todas y el dueño decide.
alter table public.clientes add column if not exists ruta_fijada boolean not null default false;
comment on column public.clientes.ruta_fijada is 'La ruta la eligió el dueño en la tarjeta B2B; el recálculo no la marca por defecto. E3.2.';

-- 2) reasignar_ruta_cliente v2 (volcado de producción del 17 sep + la línea marcada E3.2).
CREATE OR REPLACE FUNCTION public.reasignar_ruta_cliente(p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_id bigint; v_rol text;
  v_cli  bigint := nullif(p_data->>'idCliente', '')::bigint;
  v_ruta bigint := nullif(p_data->>'idRuta', '')::bigint;
  v_nom  text;
begin
  select s.id_vendedor, s.rol into v_id, v_rol from public.sesion_exige_seccion(p_data->>'token', 'b2b') s;
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'No autorizado'); end if;
  if v_cli is null then return jsonb_build_object('ok', false, 'error', 'Falta el cliente'); end if;
  if v_ruta is not null and not exists (select 1 from public.rutas where id = v_ruta) then
    return jsonb_build_object('ok', false, 'error', 'Ruta inexistente');
  end if;
  -- E3.2 (P-D6): una ruta elegida a mano queda fijada; «Sin ruta» la suelta y el recálculo la puede proponer.
  update public.clientes set id_ruta = v_ruta, ruta_fijada = (v_ruta is not null) where id = v_cli;
  if not found then return jsonb_build_object('ok', false, 'error', 'Cliente no encontrado'); end if;
  select nombre into v_nom from public.rutas where id = v_ruta;
  return jsonb_build_object('ok', true, 'idRuta', v_ruta, 'ruta', v_nom);
end $function$;
revoke all on function public.reasignar_ruta_cliente(jsonb) from public;
grant execute on function public.reasignar_ruta_cliente(jsonb) to anon, authenticated;

-- 3) planeador_recalcular: tiendas aprobadas cuya ruta no coincide con su cobertura.
--    { simular: true }            → lista (no escribe).
--    { simular: false, ids: [..] } → aplica solo a esas, si siguen difiriendo; las deja sin fijar.
create or replace function public.planeador_recalcular(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare v_lista jsonb; v_n int := 0; v_ids bigint[];
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  if coalesce((p_data->>'simular')::boolean, true) then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', t.id, 'nombre', t.nombre, 'cp', t.cp, 'colonia', t.colonia, 'fijada', t.ruta_fijada,
             'rutaActual', case when t.actual is null then null else jsonb_build_object('id', t.actual, 'nombre', ra.nombre) end,
             'rutaNueva', case when t.nueva is null then null else jsonb_build_object('id', t.nueva, 'nombre', rn.nombre) end)
           order by t.ruta_fijada, t.nombre), '[]'::jsonb)
      into v_lista
      from (select c.id, coalesce(nullif(trim(c.nombre_comercial), ''), c.nombre) as nombre, c.cp, c.colonia, c.ruta_fijada,
                   c.id_ruta as actual,
                   public.ruta_para(nullif(regexp_replace(coalesce(c.cp, ''), '[^0-9]', '', 'g'), ''), c.colonia) as nueva
              from public.clientes c
             where coalesce(c.aprobado_b2b, false) and c.tipo_id in (2, 3, 4)) t
      left join public.rutas ra on ra.id = t.actual
      left join public.rutas rn on rn.id = t.nueva
     where t.actual is distinct from t.nueva;
    return jsonb_build_object('ok', true, 'tiendas', v_lista);
  end if;
  if jsonb_typeof(p_data->'ids') <> 'array' or jsonb_array_length(p_data->'ids') = 0 then
    return jsonb_build_object('ok', false, 'error', 'Sin tiendas');
  end if;
  select array_agg((e)::bigint) into v_ids from jsonb_array_elements_text(p_data->'ids') as e;
  with nuevo as (
    select c.id, public.ruta_para(nullif(regexp_replace(coalesce(c.cp, ''), '[^0-9]', '', 'g'), ''), c.colonia) as ruta
      from public.clientes c
     where c.id = any(v_ids) and coalesce(c.aprobado_b2b, false) and c.tipo_id in (2, 3, 4)
  )
  update public.clientes c set id_ruta = n.ruta, ruta_fijada = false
    from nuevo n
   where c.id = n.id and c.id_ruta is distinct from n.ruta;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'cambiadas', v_n);
end $fn$;
revoke all on function public.planeador_recalcular(jsonb) from public;
grant execute on function public.planeador_recalcular(jsonb) to anon, authenticated;
