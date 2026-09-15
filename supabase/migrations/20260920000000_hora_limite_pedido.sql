-- 20260920000000_hora_limite_pedido.sql
-- Entrega 1 de la cola de pedidos (cambios/2026-09-14-cola-de-pedidos.md).
-- Hora límite configurable: antes de la hora, entrega en dias_normal (1);
-- después, en dias_tarde (2). obtener_fecha_entrega deja de consultar las
-- tablas `lotes` y `produccion_programada`, que no existen: siempre caía a
-- hoy + dias_entrega_con_stock (2). Re-ejecutable.

-- 1. Clave de configuración (no pisa un valor ya editado).
insert into public.config_produccion (clave, valor, descripcion, fecha_actualizacion)
values ('hora_limite_pedido',
        jsonb_build_object('hora', '18:00', 'dias_normal', 1, 'dias_tarde', 2),
        'Hora límite (CDMX) para que un pedido se entregue en dias_normal días; después, en dias_tarde.',
        now())
on conflict (clave) do nothing;

-- 2. Lectura pública (el checkout y el panel la leen sin sesión).
create or replace function public.get_hora_limite_config()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
declare
  v_val jsonb;
  v_dom boolean;
begin
  select valor into v_val from public.config_produccion where clave = 'hora_limite_pedido' limit 1;
  if v_val is null then
    v_val := jsonb_build_object('hora', '18:00', 'dias_normal', 1, 'dias_tarde', 2);
  end if;
  select (valor)::text::boolean into v_dom from public.config_produccion where clave = 'evitar_domingos' limit 1;
  return jsonb_build_object(
    'ok', true,
    'hora', coalesce(v_val->>'hora', '18:00'),
    'diasNormal', coalesce((v_val->>'dias_normal')::int, 1),
    'diasTarde', coalesce((v_val->>'dias_tarde')::int, 2),
    'evitarDomingos', coalesce(v_dom, true));
end;
$fn$;

revoke all on function public.get_hora_limite_config() from public;
grant execute on function public.get_hora_limite_config() to anon, authenticated;

-- 3. Escritura: solo el dueño (mismo criterio que set_mayoreo_config).
create or replace function public.set_hora_limite_config(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
declare
  v_hora text := trim(coalesce(p_data->>'hora', ''));
  v_dn int := (p_data->>'diasNormal')::int;
  v_dt int := (p_data->>'diasTarde')::int;
begin
  -- Autorizar primero, validar después.
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  if v_hora !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    return jsonb_build_object('ok', false, 'error', 'Hora inválida (HH:MM)');
  end if;
  if v_dn is null or v_dt is null or v_dn < 0 or v_dt < v_dn or v_dt > 7 then
    return jsonb_build_object('ok', false, 'error', 'Días inválidos (0 ≤ normal ≤ tarde ≤ 7)');
  end if;
  insert into public.config_produccion (clave, valor, descripcion, fecha_actualizacion)
  values ('hora_limite_pedido',
          jsonb_build_object('hora', v_hora, 'dias_normal', v_dn, 'dias_tarde', v_dt),
          'Hora límite (CDMX) para que un pedido se entregue en dias_normal días; después, en dias_tarde.',
          now())
  on conflict (clave) do update
    set valor = excluded.valor, fecha_actualizacion = now();
  return jsonb_build_object('ok', true, 'hora', v_hora, 'diasNormal', v_dn, 'diasTarde', v_dt);
end;
$fn$;

revoke all on function public.set_hora_limite_config(jsonb) from public;
grant execute on function public.set_hora_limite_config(jsonb) to anon, authenticated;

-- 4. Fecha sugerida v2: misma firma, mismo JSON (ok, fecha, fechaDisplay, msg).
create or replace function public.obtener_fecha_entrega(p_data jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
declare
  v_cfg jsonb := public.get_hora_limite_config();
  v_ahora timestamp := (now() at time zone 'America/Mexico_City');
  v_hoy date := v_ahora::date;
  v_hora time := (v_cfg->>'hora')::time;
  v_antes boolean := v_ahora::time < v_hora;
  v_dias int := case when v_antes then (v_cfg->>'diasNormal')::int else (v_cfg->>'diasTarde')::int end;
  v_fecha date := v_hoy + v_dias;
  v_msg text;
begin
  if (v_cfg->>'evitarDomingos')::boolean and extract(dow from v_fecha) = 0 then
    v_fecha := v_fecha + 1;
  end if;
  v_msg := case
    when v_antes and v_dias = 1 then 'Pedidos antes de las ' || (v_cfg->>'hora') || ' se entregan mañana'
    when v_antes then 'Pedidos antes de las ' || (v_cfg->>'hora') || ' se entregan en ' || v_dias || ' días'
    else 'Después de las ' || (v_cfg->>'hora') || ' la entrega es en ' || v_dias || ' días'
  end;
  -- El estatus del lote se escribe «activo» en staging y «Activo»/«Cerrado» en producción.
  if not exists (select 1 from public.lotes_produccion
                  where lower(coalesce(estatus, '')) <> 'cerrado' and coalesce(kilos_disponibles, 0) > 0) then
    v_msg := v_msg || ' · sin lote activo, la fecha puede moverse';
  end if;
  return jsonb_build_object(
    'ok', true,
    'fecha', to_char(v_fecha, 'YYYY-MM-DD'),
    'fechaDisplay', to_char(v_fecha, 'TMDay DD "de" TMMonth'),
    'msg', v_msg);
end;
$fn$;

revoke all on function public.obtener_fecha_entrega(jsonb) from public;
grant execute on function public.obtener_fecha_entrega(jsonb) to anon, authenticated;
