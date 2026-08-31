-- ============================================================================
--  SESIONES DE VENDEDOR — identidad del lado del servidor
-- ----------------------------------------------------------------------------
--  EL PROBLEMA QUE RESUELVE
--  ------------------------
--  Hasta hoy la app no tenía NINGUNA identidad en el servidor. `esAdmin()` y
--  `vendedorInfo` son variables del navegador, y el navegador es del atacante.
--  Consecuencia medida el 30 ago 2026: con solo la llave anon publicada,
--  cualquiera obtenía el padrón de vendedores con correos (obtener_vendedores),
--  las ventas del mes (dashboard_resumen), los cobros pendientes
--  (reporte_cobros) y el historial de compras de un cliente dado su teléfono
--  (obtener_cliente_con_stats).
--
--  Por eso mover `clientes` detrás de un RPC no arreglaba nada: habría dejado
--  un RPC tan abierto como la tabla. Primero hace falta saber QUIÉN llama.
--
--  CÓMO FUNCIONA
--  -------------
--  `validar_vendedor_pin` ya verifica teléfono + PIN contra bcrypt en el
--  servidor. Ahora, además, emite un token aleatorio de 32 bytes. El token
--  viaja al navegador; en la base se guarda SOLO su SHA-256, de modo que leer
--  la tabla no entrega credenciales usables. Cada RPC protegido recibe el
--  token y resuelve identidad y rol aquí dentro.
--
--  Esto NO toca el flujo del cliente final (OTP por SMS/correo). Los RPCs de
--  cara al cliente —crear_pedido, get_tracking_pedido, guardar_encuesta— siguen
--  sin token. Su blindaje es otra conversación (ver PENDIENTE al final).
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
--  1. TABLA
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.sesiones_vendedor (
  token_hash    text        primary key,
  id_vendedor   bigint      not null references public.vendedores(id) on delete cascade,
  rol           text        not null,
  creada_en     timestamptz not null default now(),
  expira_en     timestamptz not null,
  ultimo_uso    timestamptz,
  revocada      boolean     not null default false,
  user_agent    text
);

comment on table public.sesiones_vendedor is
  'Sesiones de vendedor. Se guarda SOLO el SHA-256 del token: leer esta tabla no da credenciales usables. Cerrada a anon; se alcanza únicamente por funciones SECURITY DEFINER.';

create index if not exists idx_sesiones_vendedor_expira on public.sesiones_vendedor (expira_en);
create index if not exists idx_sesiones_vendedor_id     on public.sesiones_vendedor (id_vendedor);

-- RLS activo y SIN políticas: nadie entra por PostgREST. Solo las funciones
-- DEFINER, que corren como postgres.
alter table public.sesiones_vendedor enable row level security;
revoke all on public.sesiones_vendedor from anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
--  2. HELPER INTERNO: token -> identidad
-- ────────────────────────────────────────────────────────────────────────────
--  Devuelve NULL si el token no existe, expiró o fue revocado. Actualiza
--  ultimo_uso para poder auditar.
--
--  ⚠️ Se le RETIRA el permiso de ejecución a anon: es maquinaria interna. Si
--  quedara expuesta, un atacante podría usarla como oráculo para validar
--  tokens robados.

create or replace function public.resolver_sesion_vendedor(p_token text)
returns table (id_vendedor bigint, rol text)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_hash text;
begin
  if p_token is null or length(p_token) < 32 then
    return;
  end if;

  v_hash := encode(digest(p_token, 'sha256'), 'hex');

  update public.sesiones_vendedor s
     set ultimo_uso = now()
   where s.token_hash = v_hash
     and s.revocada = false
     and s.expira_en > now();

  return query
    select s.id_vendedor, s.rol
      from public.sesiones_vendedor s
     where s.token_hash = v_hash
       and s.revocada = false
       and s.expira_en > now();
end;
$$;

revoke all on function public.resolver_sesion_vendedor(text) from public, anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
--  3. validar_vendedor_pin — ahora emite sesión
-- ────────────────────────────────────────────────────────────────────────────
--  Se conserva EXACTAMENTE el contrato anterior (ok, error, vendedor.*) y solo
--  se AÑADEN los campos `token` y `expiraEn`. Así la app actual sigue
--  funcionando sin cambios mientras se migran las pantallas una por una.

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
BEGIN
  v_telefono := COALESCE(p_data->>'telefono', '');
  v_pin      := COALESCE(p_data->>'pin', '');

  IF v_telefono = '' OR v_pin = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Faltan datos');
  END IF;

  v_tel_norm := REGEXP_REPLACE(v_telefono, '\D', '', 'g');

  SELECT * INTO v_vendedor FROM vendedores
  WHERE RIGHT(REGEXP_REPLACE(COALESCE(telefono, ''), '\D', '', 'g'), 10) = RIGHT(v_tel_norm, 10)
    AND activo = TRUE
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Vendedor no encontrado o inactivo');
  END IF;

  IF v_vendedor.pin_hash IS NULL OR v_vendedor.pin_hash = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Vendedor sin PIN configurado');
  END IF;

  IF v_vendedor.pin_hash <> crypt(v_pin, v_vendedor.pin_hash) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PIN incorrecto');
  END IF;

  -- ── Emitir sesión ────────────────────────────────────────────────────────
  -- 32 bytes de gen_random_bytes = 256 bits. En la tabla va solo el SHA-256.
  v_token  := encode(gen_random_bytes(32), 'hex');
  v_expira := now() + interval '12 hours';   -- una jornada de trabajo

  INSERT INTO public.sesiones_vendedor (token_hash, id_vendedor, rol, expira_en, user_agent)
  VALUES (encode(digest(v_token, 'sha256'), 'hex'),
          v_vendedor.id, v_vendedor.rol, v_expira,
          COALESCE(p_data->>'userAgent', NULL));

  -- Aprovechar para barrer lo viejo. Barato: la tabla es diminuta.
  DELETE FROM public.sesiones_vendedor WHERE expira_en < now() - interval '7 days';

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

-- ────────────────────────────────────────────────────────────────────────────
--  4. CERRAR SESIÓN
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.cerrar_sesion_vendedor(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_token text := coalesce(p_data->>'token', '');
begin
  if v_token = '' then
    return jsonb_build_object('ok', true);   -- nada que cerrar
  end if;

  update public.sesiones_vendedor
     set revocada = true
   where token_hash = encode(digest(v_token, 'sha256'), 'hex');

  return jsonb_build_object('ok', true);
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
--  PENDIENTE — lo que esta migración NO resuelve
-- ────────────────────────────────────────────────────────────────────────────
--  1. Los ~60 RPCs existentes siguen SIN pedir token. Esta migración solo
--     construye el mecanismo; blindarlos es el trabajo que sigue, RPC por RPC.
--  2. No hay límite de intentos de PIN. Con 8 vendedores y PINs de 4 dígitos,
--     la fuerza bruta es viable. Falta un contador por teléfono/IP.
--  3. El cliente final (OTP) sigue sin sesión de servidor: por eso
--     `obtener_cliente_con_stats(p_telefono)` entrega el historial de compras
--     de cualquiera que conozca un teléfono. Necesita su propio mecanismo.
