-- ============================================================================
--  PIN mínimo de 6 dígitos
-- ----------------------------------------------------------------------------
--  Cuatro dígitos son 10.000 combinaciones. El límite de intentos
--  (20260902000000) hace inviable probarlas, pero el PIN abre finanzas, el
--  padrón de clientes y las mutaciones de personal: conviene que además sea
--  más largo. Seis dígitos son un millón, cien veces más.
--
--  Hasta ahora proponer esto no tenía sentido, porque no existía forma de que
--  la gente cambiara su PIN sin SQL. Con la pantalla ya construida, sí la hay.
--
--  ⚠️ EL MÍNIMO APLICA AL CAMBIAR, NO AL ENTRAR
--  --------------------------------------------
--  `validar_vendedor_pin` NO comprueba longitud: solo compara contra el hash.
--  Por tanto los PIN de 4 dígitos que existen hoy siguen funcionando y NADIE
--  se queda fuera. Lo que ya no se puede es poner uno nuevo de menos de 6.
--
--  Es deliberado: forzar el cambio en el login habría dejado a las 8 personas
--  sin poder entrar de golpe, y a un negocio en operación eso no se le hace.
--  La migración a 6 dígitos se hace persona por persona, desde la app.
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
  c_min_pin constant int := 6;
begin
  select s.id_vendedor, s.rol into v_sesion_id, v_sesion_rol
    from public.resolver_sesion_vendedor(p_data->>'token') s;

  if v_sesion_id is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida o expirada');
  end if;

  v_objetivo := coalesce((p_data->>'idVendedor')::bigint, v_sesion_id);
  v_es_dueno := lower(trim(coalesce(v_sesion_rol, ''))) in ('admin', 'administrador');

  -- ── AUTORIZAR PRIMERO, VALIDAR DESPUÉS ───────────────────────────────────
  -- El orden importa. Si se valida el formato antes, quien no tiene permiso
  -- recibe "El PIN no puede ser un dígito repetido" en vez de "No autorizado":
  -- se le enseñan las reglas de la casa a alguien que no debería haber pasado
  -- de la puerta. Autorización primero, siempre.
  if v_objetivo <> v_sesion_id then
    if not v_es_dueno then
      return jsonb_build_object('ok', false, 'error', 'No autorizado');
    end if;
  end if;

  if length(v_pin_nuevo) < c_min_pin then
    return jsonb_build_object('ok', false,
      'error', 'El PIN debe tener al menos ' || c_min_pin || ' dígitos');
  end if;
  if v_pin_nuevo !~ '^[0-9]+$' then
    return jsonb_build_object('ok', false, 'error', 'El PIN debe ser numérico');
  end if;

  -- Rechazar los PIN más obvios. No es una lista exhaustiva —eso sería teatro—
  -- pero sí evita los que un atacante prueba primero.
  if v_pin_nuevo ~ '^(.)\1+$' then                      -- 000000, 111111...
    return jsonb_build_object('ok', false,
      'error', 'El PIN no puede ser un mismo dígito repetido');
  end if;
  if v_pin_nuevo in ('123456','654321','123123','112233','121212','098765') then
    return jsonb_build_object('ok', false, 'error', 'Ese PIN es demasiado común');
  end if;

  if v_objetivo = v_sesion_id then
    select pin_hash into v_hash_actual from public.vendedores where id = v_sesion_id;
    if v_hash_actual is null or v_hash_actual = '' then
      return jsonb_build_object('ok', false, 'error', 'Vendedor sin PIN configurado');
    end if;
    if v_pin_actual = '' or v_hash_actual <> crypt(v_pin_actual, v_hash_actual) then
      return jsonb_build_object('ok', false, 'error', 'PIN actual incorrecto');
    end if;
    if v_pin_nuevo = v_pin_actual then
      return jsonb_build_object('ok', false, 'error', 'El PIN nuevo debe ser distinto del actual');
    end if;
  end if;

  update public.vendedores
     set pin_hash = crypt(v_pin_nuevo, gen_salt('bf')),
         fecha_actualizacion = now()
   where id = v_objetivo;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Vendedor no encontrado');
  end if;

  -- Cambiar el PIN invalida las sesiones de esa persona: si el cambio fue para
  -- expulsar a un intruso, dejarle la sesión viva sería inútil.
  update public.sesiones_vendedor
     set revocada = true
   where id_vendedor = v_objetivo;

  -- Y limpiar cualquier bloqueo por intentos fallidos: con PIN nuevo, se parte
  -- de cero. Si no, alguien restablecido seguiría bloqueado sin saber por qué.
  delete from public.intentos_pin
   where telefono = (select right(regexp_replace(coalesce(v.telefono,''), '\D', '', 'g'), 10)
                       from public.vendedores v where v.id = v_objetivo);

  return jsonb_build_object('ok', true, 'msg', 'PIN actualizado. Se cerraron las sesiones abiertas.');
end;
$$;

comment on function public.cambiar_pin_vendedor(jsonb) is
  'Mínimo 6 dígitos, numérico, sin dígitos repetidos ni secuencias obvias. El mínimo aplica al CAMBIAR: los PIN de 4 dígitos existentes siguen sirviendo para entrar, para no dejar al equipo fuera de golpe. Cambiar el PIN revoca las sesiones de esa persona y limpia sus bloqueos por intentos fallidos.';
