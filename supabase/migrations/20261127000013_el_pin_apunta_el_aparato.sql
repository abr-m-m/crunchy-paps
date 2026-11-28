-- 27 nov 2026 — El PIN apunta de qué aparato viene, y la lista lo nombra
--
-- Segunda mitad de «ponerle nombre a cada aparato». La primera creó la tabla
-- y el bautizo; esta engancha la entrada.
--
-- `validar_vendedor_pin` es la puerta de todo el equipo, así que se toca lo
-- mínimo: una columna más en el INSERT y una llamada a `registrar_aparato`,
-- que es quien valida el id y lo ignora si no tiene la forma esperada. Si la
-- validación estuviera aquí también, en tres meses dirían cosas distintas.

begin;

CREATE OR REPLACE FUNCTION public.validar_vendedor_pin(p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_telefono TEXT;
  v_pin      TEXT;
  v_tel_norm TEXT;
  v_vendedor vendedores%ROWTYPE;
  v_token    TEXT;
  v_expira   TIMESTAMPTZ;
  v_ctrl     public.intentos_pin%ROWTYPE;
  v_espera   INT;
  v_bloqueo  INTERVAL;

  c_max_intentos CONSTANT INT      := 5;
  c_ventana      CONSTANT INTERVAL := interval '15 minutes';
  c_base_bloqueo CONSTANT INTERVAL := interval '15 minutes';
  c_tope_bloqueo CONSTANT INTERVAL := interval '4 hours';
BEGIN
  v_telefono := COALESCE(p_data->>'telefono', '');
  v_pin      := COALESCE(p_data->>'pin', '');

  IF v_telefono = '' OR v_pin = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Faltan datos');
  END IF;

  v_tel_norm := RIGHT(REGEXP_REPLACE(v_telefono, '\D', '', 'g'), 10);

  -- ── 1. ¿Está bloqueado? ───────────────────────────────────────────────────
  SELECT * INTO v_ctrl FROM public.intentos_pin WHERE telefono = v_tel_norm;

  IF FOUND AND v_ctrl.bloqueado_hasta IS NOT NULL
     AND v_ctrl.bloqueado_hasta > now() THEN
    v_espera := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_ctrl.bloqueado_hasta - now())) / 60)::int);
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'Demasiados intentos. Espera ' || v_espera || ' minuto' ||
               CASE WHEN v_espera = 1 THEN '' ELSE 's' END || ' e inténtalo de nuevo.',
      'bloqueado', true,
      'minutosRestantes', v_espera
    );
  END IF;

  -- La ventana se reinicia sola tras 15 min sin fallos.
  IF FOUND AND v_ctrl.ventana_inicio < now() - c_ventana THEN
    UPDATE public.intentos_pin
       SET intentos = 0, ventana_inicio = now(), bloqueado_hasta = NULL
     WHERE telefono = v_tel_norm;
    v_ctrl.intentos := 0;
  END IF;

  -- ── 2. Validación real ────────────────────────────────────────────────────
  SELECT * INTO v_vendedor FROM vendedores
  WHERE RIGHT(REGEXP_REPLACE(COALESCE(telefono, ''), '\D', '', 'g'), 10) = v_tel_norm
    AND activo = TRUE
  LIMIT 1;

  IF NOT FOUND THEN
    PERFORM public.registrar_fallo_pin(v_tel_norm, c_max_intentos, c_base_bloqueo, c_tope_bloqueo);
    RETURN jsonb_build_object('ok', false, 'error', 'Vendedor no encontrado o inactivo');
  END IF;

  IF v_vendedor.pin_hash IS NULL OR v_vendedor.pin_hash = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Vendedor sin PIN configurado');
  END IF;

  IF v_vendedor.pin_hash <> crypt(v_pin, v_vendedor.pin_hash) THEN
    PERFORM public.registrar_fallo_pin(v_tel_norm, c_max_intentos, c_base_bloqueo, c_tope_bloqueo);
    RETURN jsonb_build_object('ok', false, 'error', 'PIN incorrecto');
  END IF;

  -- ── 3. Acierto: se borra el control ───────────────────────────────────────
  -- Quien sabe su PIN nunca arrastra bloqueos de intentos anteriores.
  DELETE FROM public.intentos_pin WHERE telefono = v_tel_norm;

  v_token  := encode(gen_random_bytes(32), 'hex');
  v_expira := now() + interval '12 hours';

  -- 27 nov 2026: de que aparato viene. `registrar_aparato` se ocupa de
  -- validarlo y de ignorarlo si no tiene la forma esperada, asi que aqui no
  -- hay una segunda copia de esa regla.
  INSERT INTO public.sesiones_vendedor (token_hash, id_vendedor, rol, expira_en, user_agent, aparato_id)
  VALUES (encode(digest(v_token, 'sha256'), 'hex'),
          v_vendedor.id, v_vendedor.rol, v_expira,
          COALESCE(p_data->>'userAgent', NULL),
          public.registrar_aparato(p_data->>'aparatoId', p_data->>'userAgent'));

  DELETE FROM public.sesiones_vendedor WHERE expira_en < now() - interval '7 days';
  DELETE FROM public.intentos_pin      WHERE ultimo_intento < now() - interval '7 days';

  RETURN jsonb_build_object(
    'ok', true,
    'token', v_token,
    'expiraEn', v_expira,
    'vendedor', jsonb_build_object(
      'id', v_vendedor.id,
      'nombre', v_vendedor.nombre,
      'telefono', v_vendedor.telefono,
      'email', v_vendedor.email,
      'rol', v_vendedor.rol,
      'direccionPuntoVenta', v_vendedor.direccion_punto_venta,
      'cpPuntoVenta', v_vendedor.cp_punto_venta
    )
  );
END;
$function$;

-- ── La lista, ahora con el nombre del aparato ─────────────────────────────
create or replace function public.sesiones_abiertas(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_yo bigint;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'solo_dueno');
  end if;
  select s.id_vendedor into v_yo from public.resolver_sesion_vendedor(p_data->>'token') s;

  return jsonb_build_object('ok', true, 'sesiones', coalesce((
    select jsonb_agg(jsonb_build_object(
             'hash',      s.token_hash,
             'vendedor',  coalesce(v.nombre, 'vendedor ' || s.id_vendedor),
             'rol',       s.rol,
             'aparato',   public.aparato_de(s.user_agent),
             -- El id y el nombre del aparato. Sin nombre, la consola lo dice:
             -- un aparato sin bautizar es justo el que hay que mirar.
             'aparatoId', s.aparato_id,
             'nombre',    a.nombre,
             'desde',     s.creada_en,
             'ultimoUso', s.ultimo_uso,
             'expira',    s.expira_en,
             'esLaMia',   s.id_vendedor = v_yo
               and s.token_hash = encode(digest(p_data->>'token', 'sha256'), 'hex'))
           order by s.ultimo_uso desc nulls last, s.creada_en desc)
      from public.sesiones_vendedor s
      left join public.vendedores v on v.id = s.id_vendedor
      left join public.aparatos a on a.id = s.aparato_id
     where not s.revocada and s.expira_en > now()), '[]'::jsonb));
end;
$fn$;
revoke all on function public.sesiones_abiertas(jsonb) from public, anon;
grant execute on function public.sesiones_abiertas(jsonb) to anon, authenticated;

commit;
