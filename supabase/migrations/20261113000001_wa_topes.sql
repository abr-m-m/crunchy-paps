-- 20261113000001_wa_topes.sql
-- Agente de WhatsApp: los dos topes de gasto, y el registro del mensaje que entra.
-- Diseno: cambios/2026-11-12-agente-whatsapp.md (D8) · Plan: tarea 3.
--
-- POR QUE ESTO ES SQL Y NO JAVASCRIPT (enmienda al plan, 13 nov 2026)
-- El plan ponia el conteo en api/whatsapp.js, con dos lecturas por REST. Se movio aqui por
-- tres razones, en este orden:
--   1. Se puede PROBAR sin la llave de servicio: la prueba lo llama con `supabase db query`,
--      como la de wa_identidad. En JavaScript habria hecho falta meter la llave de servicio
--      en el entorno de la prueba, y una prueba que es dificil de correr no se corre.
--   2. Contar e insertar en la misma llamada es un viaje en vez de tres, y no deja hueco
--      entre "cuento" y "registro".
--   3. Los topes son PARAMETROS con valor por defecto: la prueba los dispara con 2 en vez de
--      insertar 40 filas, y afinarlos no necesita otra migracion.

create or replace function public.wa_entrante(
  p_telefono     text,
  p_texto        text,
  p_tope_numero  integer default 40,
  p_tope_global  integer default 400
)
returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_tel    text := right(regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g'), 10);
  v_desde  timestamptz := now() - interval '24 hours';
  v_numero integer;
  v_global integer;
begin
  if length(v_tel) <> 10 then
    return jsonb_build_object('permitido', false, 'motivo', 'telefono_invalido');
  end if;

  -- Se cuenta ANTES de insertar: el mensaje de ahora no se cuenta a si mismo.
  select count(*) into v_numero from wa_mensajes
   where direccion = 'entra' and fecha > v_desde
     and right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) = v_tel;

  select count(*) into v_global from wa_mensajes
   where direccion = 'entra' and fecha > v_desde;

  -- Se registra SIEMPRE, pase o no. Que el bloqueado tambien cuente es a proposito:
  -- si no contara, quien se pasa del tope lo volveria a pasar en cada mensaje.
  insert into wa_mensajes (telefono, direccion, texto) values (p_telefono, 'entra', p_texto);

  -- El tope del numero manda sobre el global: "te pasaste tu" se le dice al numero;
  -- "nos pasamos todos" es un problema de Abraham, no suyo.
  if v_numero >= p_tope_numero then
    return jsonb_build_object('permitido', false, 'motivo', 'numero', 'cuenta', v_numero);
  elsif v_global >= p_tope_global then
    return jsonb_build_object('permitido', false, 'motivo', 'global', 'cuenta', v_global);
  end if;

  return jsonb_build_object('permitido', true, 'cuenta', v_numero, 'global', v_global);
end;
$$;

-- Regla 42: EXECUTE a PUBLIC por defecto. Solo la llave de servicio.
revoke all on function public.wa_entrante(text, text, integer, integer)
  from public, anon, authenticated;
