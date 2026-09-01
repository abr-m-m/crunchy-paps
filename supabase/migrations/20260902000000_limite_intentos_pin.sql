-- ============================================================================
--  LÍMITE DE INTENTOS DE PIN
-- ----------------------------------------------------------------------------
--  EL PROBLEMA
--  -----------
--  Los 8 vendedores entran con un PIN de 4 dígitos: 10.000 combinaciones, sin
--  ningún freno. Un script las prueba todas en minutos.
--
--  Hasta la Etapa B eso daba acceso a la interfaz. Desde la Etapa B, el PIN
--  emite un TOKEN DE SESIÓN que abre finanzas, el padrón de clientes y las
--  mutaciones de personal. El PIN pasó de ser una molestia a ser la llave, así
--  que ahora pesa mucho más.
--
--  Y los teléfonos de los vendedores estuvieron públicos hasta el 30 ago vía
--  `obtener_vendedores`, así que hay que asumir que alguien pudo cosecharlos.
--
--  LA POLÍTICA
--  -----------
--  Ventana deslizante de 15 minutos, por teléfono:
--    · 5 fallos en la ventana  -> bloqueo
--    · duración del bloqueo: 15 min, y se DUPLICA con cada bloqueo consecutivo
--      (15 → 30 → 60 → 120 → 240), con tope de 4 horas
--    · un acierto borra el registro: quien sabe su PIN nunca se ve afectado
--    · la ventana se reinicia sola tras 15 min sin fallos
--
--  5 intentos es holgado para quien teclea mal; 10.000 con bloqueos crecientes
--  son años.
--
--  Se cuentan también los intentos contra teléfonos QUE NO EXISTEN, para que
--  enumerar la lista de vendedores también quede limitado.
--
--  DECISIÓN CONSCIENTE: se conservan los mensajes distintos entre "Vendedor no
--  encontrado" y "PIN incorrecto". Técnicamente eso permite saber qué teléfonos
--  son de vendedores, pero son 8 personas cuyos números no son secretos, y
--  unificar el mensaje complicaría el soporte cuando alguien teclea mal su
--  teléfono. El freno real es el bloqueo, no la ambigüedad del mensaje.
--
--  NO REQUIERE DESPLEGAR LA APP: la firma y la forma de la respuesta no cambian.
--  El único añadido es un `error` nuevo cuando hay bloqueo, que la app ya sabe
--  mostrar porque muestra `res.error` tal cual.
-- ============================================================================

create table if not exists public.intentos_pin (
  telefono          text        primary key,   -- últimos 10 dígitos, normalizado
  intentos          int         not null default 0,
  ventana_inicio    timestamptz not null default now(),
  ultimo_intento    timestamptz not null default now(),
  bloqueos          int         not null default 0,
  bloqueado_hasta   timestamptz
);

comment on table public.intentos_pin is
  'Control de fuerza bruta sobre validar_vendedor_pin. Ventana deslizante de 15 min; 5 fallos bloquean, con duración que se duplica en bloqueos consecutivos. Un acierto borra la fila. Cerrada a anon: solo la tocan funciones SECURITY DEFINER.';

create index if not exists idx_intentos_pin_limpieza on public.intentos_pin (ultimo_intento);

alter table public.intentos_pin enable row level security;
revoke all on public.intentos_pin from anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
--  Registro de un fallo (helper interno)
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.registrar_fallo_pin(
  p_telefono text, p_max int, p_base interval, p_tope interval)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_intentos int;
  v_bloqueos int;
  v_dur      interval;
begin
  insert into public.intentos_pin (telefono, intentos, ventana_inicio, ultimo_intento)
  values (p_telefono, 1, now(), now())
  on conflict (telefono) do update
    set intentos       = public.intentos_pin.intentos + 1,
        ultimo_intento = now()
  returning intentos, bloqueos into v_intentos, v_bloqueos;

  if v_intentos >= p_max then
    -- El bloqueo se duplica con cada bloqueo consecutivo, con tope.
    v_dur := least(p_base * power(2, v_bloqueos)::int, p_tope);
    update public.intentos_pin
       set bloqueado_hasta = now() + v_dur,
           bloqueos        = v_bloqueos + 1,
           intentos        = 0,
           ventana_inicio  = now()
     where telefono = p_telefono;
  end if;
end;
$$;

revoke all on function public.registrar_fallo_pin(text, int, interval, interval)
  from public, anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
--  validar_vendedor_pin con límite de intentos
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.validar_vendedor_pin(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
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

  INSERT INTO public.sesiones_vendedor (token_hash, id_vendedor, rol, expira_en, user_agent)
  VALUES (encode(digest(v_token, 'sha256'), 'hex'),
          v_vendedor.id, v_vendedor.rol, v_expira,
          COALESCE(p_data->>'userAgent', NULL));

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
$$;

