-- 20260922000000_push_suscripciones.sql
-- Entrega 4 de la cola de pedidos: suscripciones Web Push del personal.
-- La tabla solo la leen service_role (/api/push-enviar) y los dos RPCs. Re-ejecutable.

create table if not exists public.push_suscripciones (
  id          bigserial primary key,
  id_vendedor bigint not null,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  creada_en   timestamptz not null default now(),
  ultima_ok   timestamptz
);
alter table public.push_suscripciones enable row level security;
revoke all on table public.push_suscripciones from public, anon, authenticated;
-- Sin políticas: anon/authenticated no leen ni escriben; service_role las salta.

create or replace function public.guardar_suscripcion_push(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
declare
  v_id bigint; v_rol text; v_fila bigint;
  v_endpoint text := trim(coalesce(p_data->>'endpoint', ''));
  v_p256dh text := trim(coalesce(p_data->>'p256dh', ''));
  v_auth text := trim(coalesce(p_data->>'auth', ''));
begin
  -- Autorizar primero, validar después.
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.sesion_exige_seccion(p_data->>'token', 'armado') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  if v_endpoint !~ '^https://' or length(v_endpoint) > 2000 or v_p256dh = '' or v_auth = '' then
    return jsonb_build_object('ok', false, 'error', 'Suscripción inválida');
  end if;
  insert into public.push_suscripciones (id_vendedor, endpoint, p256dh, auth, user_agent)
  values (v_id, v_endpoint, v_p256dh, v_auth, left(coalesce(p_data->>'userAgent', ''), 300))
  on conflict (endpoint) do update
    set id_vendedor = excluded.id_vendedor, p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, creada_en = now()
  returning id into v_fila;
  return jsonb_build_object('ok', true, 'id', v_fila);
end;
$fn$;
revoke all on function public.guardar_suscripcion_push(jsonb) from public;
grant execute on function public.guardar_suscripcion_push(jsonb) to anon, authenticated;

create or replace function public.borrar_suscripcion_push(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
declare v_id bigint; v_rol text; v_n int;
begin
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.sesion_exige_seccion(p_data->>'token', 'armado') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  delete from public.push_suscripciones
   where endpoint = trim(coalesce(p_data->>'endpoint', '')) and id_vendedor = v_id;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'borradas', v_n);
end;
$fn$;
revoke all on function public.borrar_suscripcion_push(jsonb) from public;
grant execute on function public.borrar_suscripcion_push(jsonb) to anon, authenticated;
