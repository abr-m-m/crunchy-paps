-- ============================================================================
--  🔴 PARCHE URGENTE PARA PRODUCCIÓN — hallazgo 20
--  cambiar_pin_vendedor permitía tomar cualquier cuenta sin credencial
-- ----------------------------------------------------------------------------
--  ⚠️  ESTE ARCHIVO VIVE FUERA DE migrations/ A PROPÓSITO.
--      Se aplica A MANO y de inmediato. No lo toca `supabase db push`.
--
--  EL PROBLEMA
--  -----------
--  La función recibía `idVendedor` y `pinNuevo` y reescribía el PIN. Sin pedir
--  el PIN actual. Sin sesión. Sin autorización de ningún tipo. Con la llave
--  anon publicada en el repo público, esta sola petición tomaba la cuenta de
--  administrador de crunchypaps.mx:
--
--      POST /rest/v1/rpc/cambiar_pin_vendedor
--      {"p_data": {"idVendedor": 1, "pinNuevo": "9999"}}
--
--  Verificado alcanzable en producción el 31 ago 2026 con una sonda no
--  destructiva (idVendedor 999999 devolvió "Vendedor no encontrado": llegó a
--  ejecutar el UPDATE y no encontró fila).
--
--  POR QUÉ ESTE PARCHE ES SEGURO DE APLICAR YA
--  -------------------------------------------
--  1. `index.html` NO llama a esta función en ninguna línea (verificado por
--     grep). No puede romper ninguna pantalla.
--  2. NO depende de la infraestructura de sesiones de la Etapa B, que todavía
--     no está en producción. Solo usa pgcrypto, que ya está instalado.
--
--  QUÉ HACE
--  --------
--  Exige el PIN ACTUAL para cambiar el PIN. Quien no lo conozca, no cambia
--  nada. Eso cierra la toma de control por completo.
--
--  DESPUÉS
--  -------
--  Cuando se despliegue la Etapa B, la migración
--  `20260901040000_urgente_cambiar_pin.sql` sustituye esta versión por una que
--  además exige sesión y permite a un rol dueño restablecer el PIN de otra
--  persona. Este parche es el suelo, no el techo.
--
--  APLICAR CON:
--    supabase link --project-ref xbyzarzyxiugrucyjwfn
--    supabase db query --linked -f supabase/urgente/20260831_cambiar_pin_sin_sesion.sql
--    supabase link --project-ref dkwatbsaidlfjqjnfyrk        <- volver a staging
-- ============================================================================

create or replace function public.cambiar_pin_vendedor(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id          bigint := coalesce((p_data->>'idVendedor')::bigint, 0);
  v_pin_nuevo   text   := coalesce(p_data->>'pinNuevo', '');
  v_pin_actual  text   := coalesce(p_data->>'pinActual', '');
  v_hash_actual text;
begin
  if v_id = 0 then
    return jsonb_build_object('ok', false, 'error', 'Faltan datos');
  end if;

  if length(v_pin_nuevo) < 4 then
    return jsonb_build_object('ok', false, 'error', 'PIN muy corto (mínimo 4)');
  end if;
  if v_pin_nuevo !~ '^[0-9]+$' then
    return jsonb_build_object('ok', false, 'error', 'El PIN debe ser numérico');
  end if;

  -- ── LA CORRECCIÓN ────────────────────────────────────────────────────────
  -- Hay que demostrar que se conoce el PIN actual.
  select pin_hash into v_hash_actual
    from public.vendedores where id = v_id and activo = true;

  if v_hash_actual is null then
    -- Mismo mensaje que un PIN equivocado: no confirmar qué ids existen.
    return jsonb_build_object('ok', false, 'error', 'PIN actual incorrecto');
  end if;

  if v_pin_actual = '' or v_hash_actual <> crypt(v_pin_actual, v_hash_actual) then
    return jsonb_build_object('ok', false, 'error', 'PIN actual incorrecto');
  end if;

  update public.vendedores
     set pin_hash = crypt(v_pin_nuevo, gen_salt('bf')),
         fecha_actualizacion = now()
   where id = v_id;

  return jsonb_build_object('ok', true, 'msg', 'PIN actualizado');
end;
$$;
