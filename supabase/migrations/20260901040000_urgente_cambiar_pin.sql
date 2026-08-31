-- ============================================================================
--  🔴 URGENTE — cambiar_pin_vendedor permitía tomar cualquier cuenta
-- ----------------------------------------------------------------------------
--  HALLAZGO 20 (31 ago 2026). La función recibía `idVendedor` y `pinNuevo` y
--  reescribía el PIN. Sin pedir el PIN actual. Sin sesión. Sin autorización de
--  ningún tipo. Con la llave anon publicada en el repo público, esta única
--  petición tomaba la cuenta de administrador:
--
--      POST /rest/v1/rpc/cambiar_pin_vendedor
--      {"p_data": {"idVendedor": 1, "pinNuevo": "9999"}}
--
--  Verificado como ALCANZABLE en producción el 31 ago 2026 con una sonda no
--  destructiva (idVendedor 999999 -> "Vendedor no encontrado", es decir, llegó
--  a ejecutar el UPDATE y no encontró fila).
--
--  POR QUÉ ESTA MIGRACIÓN SE PUEDE APLICAR A PRODUCCIÓN POR SEPARADO
--  ----------------------------------------------------------------
--  `index.html` NO llama a esta función en ninguna línea (verificado por grep).
--  Por eso, a diferencia del resto de la Etapa B, esta migración NO necesita
--  desplegar la app: no puede romper ninguna pantalla existente.
--
--  QUÉ QUEDA DESPUÉS
--  -----------------
--  Dos caminos legítimos, ambos con sesión:
--    1. Cambiar el PIN PROPIO, presentando el PIN actual.
--    2. Un rol dueño (admin/administrador) restablece el de otra persona.
--  Cualquier otra combinación se rechaza.
-- ============================================================================

create or replace function public.cambiar_pin_vendedor(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_sesion_id   bigint;
  v_sesion_rol  text;
  v_objetivo    bigint;
  v_pin_nuevo   text := coalesce(p_data->>'pinNuevo', '');
  v_pin_actual  text := coalesce(p_data->>'pinActual', '');
  v_hash_actual text;
  v_es_dueno    boolean;
begin
  -- 1. Exigir sesión. Sin esto, todo lo demás sobra.
  select s.id_vendedor, s.rol into v_sesion_id, v_sesion_rol
    from public.resolver_sesion_vendedor(p_data->>'token') s;

  if v_sesion_id is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida o expirada');
  end if;

  -- Por defecto, uno se cambia el suyo.
  v_objetivo := coalesce((p_data->>'idVendedor')::bigint, v_sesion_id);
  v_es_dueno := lower(trim(coalesce(v_sesion_rol, ''))) in ('admin', 'administrador');

  -- 2. PIN nuevo mínimamente sano.
  if length(v_pin_nuevo) < 4 then
    return jsonb_build_object('ok', false, 'error', 'PIN muy corto (mínimo 4)');
  end if;
  if v_pin_nuevo !~ '^[0-9]+$' then
    return jsonb_build_object('ok', false, 'error', 'El PIN debe ser numérico');
  end if;

  -- 3. Autorización.
  if v_objetivo <> v_sesion_id then
    -- Restablecer el PIN de OTRA persona: solo un rol dueño.
    if not v_es_dueno then
      return jsonb_build_object('ok', false, 'error', 'No autorizado');
    end if;
  else
    -- Cambiar el PROPIO: hay que demostrar que se conoce el actual. Tener la
    -- sesión no basta: si alguien deja la sesión abierta en un dispositivo, no
    -- debería poder quedarse con la cuenta.
    select pin_hash into v_hash_actual from public.vendedores where id = v_sesion_id;
    if v_hash_actual is null or v_hash_actual = '' then
      return jsonb_build_object('ok', false, 'error', 'Vendedor sin PIN configurado');
    end if;
    if v_pin_actual = '' or v_hash_actual <> crypt(v_pin_actual, v_hash_actual) then
      return jsonb_build_object('ok', false, 'error', 'PIN actual incorrecto');
    end if;
  end if;

  update public.vendedores
     set pin_hash = crypt(v_pin_nuevo, gen_salt('bf')),
         fecha_actualizacion = now()
   where id = v_objetivo;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Vendedor no encontrado');
  end if;

  -- 4. Cambiar el PIN invalida las sesiones de esa persona. Si el cambio fue
  --    para expulsar a un intruso, dejarle la sesión viva sería inútil.
  update public.sesiones_vendedor
     set revocada = true
   where id_vendedor = v_objetivo;

  return jsonb_build_object('ok', true, 'msg', 'PIN actualizado. Se cerraron las sesiones abiertas.');
end;
$$;

comment on function public.cambiar_pin_vendedor(jsonb) is
  'Hallazgo 20: antes cambiaba el PIN de cualquiera sin credencial. Ahora exige sesión, y o bien el PIN actual (cambio propio) o bien rol dueño (restablecer el de otro). Cambiar el PIN revoca las sesiones de esa persona.';
