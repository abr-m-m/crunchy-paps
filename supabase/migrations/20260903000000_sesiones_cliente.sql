-- ============================================================================
--  SESIONES DE CLIENTE — la última pieza del modelo de identidad
-- ----------------------------------------------------------------------------
--  EL PROBLEMA
--  -----------
--  La sesión de VENDEDOR se construyó en la Etapa B y cerró el panel. Pero el
--  cliente final nunca tuvo identidad en el servidor: el OTP se verifica en
--  `api/otp-email.js` y `api/sheets.js`, y esas funciones devuelven un simple
--  { verificado: true } que el navegador se cree. Después, el `id_cliente` o el
--  teléfono viajan como PARÁMETRO en cada consulta.
--
--  Consecuencias medidas:
--    · `obtener_cliente_con_stats(p_telefono)` entrega el historial de compras
--      de cualquiera que conozca un teléfono. Lleva días en la lista.
--    · `pintarRegalosCliente()` lee `ordenes?id_cliente=eq.N` — el filtro lo
--      pone el navegador, así que cualquiera ve los regalos de cualquiera.
--
--  Y mientras eso siga así, `ordenes` no se puede cerrar: esa pantalla la
--  necesita abierta.
--
--  EL DISEÑO
--  ---------
--  Mismo patrón que la sesión de vendedor, con UNA diferencia crítica:
--
--    `emitir_sesion_cliente` NO es invocable por `anon`.
--
--  Si lo fuera, cualquiera se emitiría una sesión para el teléfono que quisiera
--  y todo esto no serviría de nada. Solo `service_role` puede llamarla, que es
--  lo que tienen las funciones serverless DESPUÉS de comprobar el código OTP.
--  El navegador nunca puede emitir una sesión: solo recibirla.
--
--  Duración: 60 días, igual que la sesión que ya guarda la app. Es deliberado —
--  renovarla cuesta un SMS de Twilio, y el proyecto optimizó para no pagarlos.
-- ============================================================================

create table if not exists public.sesiones_cliente (
  token_hash  text        primary key,
  telefono    text        not null,          -- normalizado, 10 dígitos
  creada_en   timestamptz not null default now(),
  expira_en   timestamptz not null,
  ultimo_uso  timestamptz,
  revocada    boolean     not null default false
);

comment on table public.sesiones_cliente is
  'Sesiones de cliente final, emitidas tras verificar el OTP. Se guarda solo el SHA-256 del token. Cerrada a anon; emitir_sesion_cliente solo la puede llamar service_role, desde las funciones serverless.';

create index if not exists idx_sesiones_cliente_tel    on public.sesiones_cliente (telefono);
create index if not exists idx_sesiones_cliente_expira on public.sesiones_cliente (expira_en);

alter table public.sesiones_cliente enable row level security;
revoke all on public.sesiones_cliente from anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
--  EMITIR — solo service_role
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.emitir_sesion_cliente(p_telefono text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tel    text := right(regexp_replace(coalesce(p_telefono,''), '\D', '', 'g'), 10);
  v_token  text;
  v_expira timestamptz;
begin
  if length(v_tel) < 10 then
    return jsonb_build_object('ok', false, 'error', 'Teléfono inválido');
  end if;

  v_token  := encode(gen_random_bytes(32), 'hex');
  v_expira := now() + interval '60 days';

  insert into public.sesiones_cliente (token_hash, telefono, expira_en)
  values (encode(digest(v_token, 'sha256'), 'hex'), v_tel, v_expira);

  -- Barrido barato: la tabla es pequeña.
  delete from public.sesiones_cliente where expira_en < now() - interval '7 days';

  return jsonb_build_object('ok', true, 'token', v_token, 'expiraEn', v_expira);
end;
$$;

-- ⚠️ LO MÁS IMPORTANTE DE ESTE ARCHIVO.
-- Si `anon` pudiera llamar a esto, cualquiera se emitiría una sesión para el
-- teléfono que quisiera y toda la protección sería decorativa. Solo la llaman
-- las funciones serverless, DESPUÉS de comprobar el código OTP.
revoke all on function public.emitir_sesion_cliente(text) from public, anon, authenticated;
grant execute on function public.emitir_sesion_cliente(text) to service_role;

-- ────────────────────────────────────────────────────────────────────────────
--  RESOLVER — helper interno
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.resolver_sesion_cliente(p_token text)
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_hash text;
  v_tel  text;
begin
  if p_token is null or length(p_token) < 32 then
    return null;
  end if;

  v_hash := encode(digest(p_token, 'sha256'), 'hex');

  update public.sesiones_cliente
     set ultimo_uso = now()
   where token_hash = v_hash and revocada = false and expira_en > now();

  select s.telefono into v_tel
    from public.sesiones_cliente s
   where s.token_hash = v_hash and s.revocada = false and s.expira_en > now();

  return v_tel;
end;
$$;

revoke all on function public.resolver_sesion_cliente(text) from public, anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
--  CERRAR SESIÓN
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.cerrar_sesion_cliente(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare v_token text := coalesce(p_data->>'token', '');
begin
  if v_token = '' then return jsonb_build_object('ok', true); end if;
  update public.sesiones_cliente
     set revocada = true
   where token_hash = encode(digest(v_token, 'sha256'), 'hex');
  return jsonb_build_object('ok', true);
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
--  obtener_cliente_con_stats — CIERRE DEL HUECO CONOCIDO
-- ────────────────────────────────────────────────────────────────────────────
--  Recibía `p_telefono` y entregaba el historial de compras de quien fuera.
--  Ahora el teléfono sale del TOKEN, no del parámetro.
--
--  Se conserva el parámetro `p_telefono` en la firma por compatibilidad, pero
--  se IGNORA salvo que quien llame traiga sesión de vendedor con sección `b2b`:
--  el panel sí necesita consultar el historial de un cliente concreto.
alter function public.obtener_cliente_con_stats(text) rename to obtener_cliente_con_stats_interno;
revoke all on function public.obtener_cliente_con_stats_interno(text) from public, anon, authenticated;

create or replace function public.obtener_cliente_con_stats(
  p_telefono text default null, p_token text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tel_sesion text;
  v_id_vend    bigint;
  v_objetivo   text;
begin
  -- 1. ¿Sesión de cliente? Entonces solo puede verse a sí mismo.
  v_tel_sesion := public.resolver_sesion_cliente(p_token);
  if v_tel_sesion is not null then
    return public.obtener_cliente_con_stats_interno(v_tel_sesion);
  end if;

  -- 2. ¿Sesión de vendedor con b2b? Entonces sí puede consultar a otro.
  select s.id_vendedor into v_id_vend
    from public.sesion_exige_seccion(p_token, 'b2b') s;
  if v_id_vend is not null then
    v_objetivo := right(regexp_replace(coalesce(p_telefono,''), '\D', '', 'g'), 10);
    if length(v_objetivo) < 10 then
      return jsonb_build_object('ok', false, 'error', 'Falta teléfono');
    end if;
    return public.obtener_cliente_con_stats_interno(v_objetivo);
  end if;

  return jsonb_build_object('ok', false, 'error', 'Sesión inválida o expirada');
end;
$$;

comment on function public.obtener_cliente_con_stats(text, text) is
  'El teléfono sale del TOKEN de cliente, no del parámetro. Un vendedor con sección b2b sí puede consultar el de otro. Antes entregaba el historial de compras de cualquiera que conociera un teléfono.';
