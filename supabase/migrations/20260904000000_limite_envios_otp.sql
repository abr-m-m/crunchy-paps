-- ============================================================================
--  LÍMITE DE ENVÍOS DE OTP — freno al bombeo de SMS
-- ----------------------------------------------------------------------------
--  EL PROBLEMA (hallazgos 02/15 y ACCESOS.md §3.7)
--  ---------------------------------------------
--  `api/sheets.js` limita los envíos con `otpStore`, un Map EN MEMORIA de una
--  función serverless. En Vercel cada arranque en frío empieza con el mapa
--  vacío y cada instancia concurrente tiene el suyo, así que el contador se
--  reinicia solo. El límite de 3 envíos no existe en la práctica.
--
--  Y el SMS es el canal por defecto de la app (`window._otpCanal || 'sms'`),
--  así que es el camino principal, no el alterno.
--
--  Consecuencia: cualquiera puede disparar SMS a números arbitrarios, cobrados
--  a la cuenta de Twilio. Es el fraude por bombeo de SMS, y es de los pocos
--  agujeros de este proyecto que cuesta dinero de forma directa e inmediata.
--
--  POR QUÉ NO BASTA CON LIMITAR POR TELÉFONO
--  -----------------------------------------
--  El atacante no manda mil veces al mismo número: manda una vez a mil números.
--  Un límite por teléfono no le estorba. Por eso hay DOS topes:
--
--    · por teléfono -> protege a cada persona de recibir spam
--    · GLOBAL       -> pone techo al gasto pase lo que pase
--
--  El global es el que de verdad acota la factura. 60 SMS/hora es holgado para
--  un negocio con 10 usuarios y 40 clientes, y convierte un ataque ilimitado en
--  uno de coste acotado y visible.
--
--  DISEÑO: BITÁCORA, NO CONTADOR
--  -----------------------------
--  Se guarda una fila por envío en vez de un contador por teléfono. Así los dos
--  topes son la misma consulta con distinto `where`, y además queda rastro para
--  saber si alguien lo intentó.
-- ============================================================================

create table if not exists public.envios_otp (
  id       bigserial   primary key,
  telefono text        not null,          -- normalizado, 10 dígitos
  canal    text        not null,          -- 'sms' | 'email'
  creado   timestamptz not null default now()
);

comment on table public.envios_otp is
  'Bitácora de envíos de OTP, para limitar el bombeo de SMS. Sustituye al Map en memoria de api/sheets.js, que se reiniciaba en cada arranque en frío. Cerrada a anon.';

create index if not exists idx_envios_otp_tel    on public.envios_otp (telefono, creado desc);
create index if not exists idx_envios_otp_creado on public.envios_otp (creado desc);

alter table public.envios_otp enable row level security;
revoke all on public.envios_otp from anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
--  ¿Se puede enviar? — la llaman las funciones serverless ANTES de gastar
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.registrar_envio_otp(p_telefono text, p_canal text default 'sms')
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tel      text := right(regexp_replace(coalesce(p_telefono,''), '\D', '', 'g'), 10);
  v_ultimo   timestamptz;
  v_en15     int;
  v_enhora   int;
  v_global   int;
  v_espera   int;

  -- Holgados para el uso real (10 usuarios, 40 clientes), estrechos para un
  -- ataque. Si algún día el negocio crece, estos son los números a subir.
  c_seg_entre    constant int := 60;   -- segundos mínimos entre dos envíos
  c_max_15min    constant int := 3;    -- por teléfono
  c_max_hora     constant int := 6;    -- por teléfono
  c_max_global   constant int := 60;   -- TODOS los teléfonos, por hora
begin
  if length(v_tel) < 10 then
    return jsonb_build_object('ok', false, 'error', 'Número inválido');
  end if;

  -- ── Tope global: el que acota la factura ────────────────────────────────
  select count(*) into v_global
    from public.envios_otp where creado > now() - interval '1 hour';

  if v_global >= c_max_global then
    -- Mensaje deliberadamente vago: no se le confirma a quien ataca que topó
    -- con un límite global, ni cuánto falta.
    return jsonb_build_object('ok', false,
      'error', 'No se pudo enviar el código en este momento. Intenta más tarde.',
      'motivo', 'global');
  end if;

  -- ── Por teléfono ────────────────────────────────────────────────────────
  select max(creado) into v_ultimo
    from public.envios_otp where telefono = v_tel;

  if v_ultimo is not null and v_ultimo > now() - make_interval(secs => c_seg_entre) then
    v_espera := greatest(1, c_seg_entre - extract(epoch from (now() - v_ultimo))::int);
    return jsonb_build_object('ok', false,
      'error', 'Espera ' || v_espera || ' segundos antes de pedir otro código.',
      'esperaSegundos', v_espera, 'motivo', 'frecuencia');
  end if;

  select count(*) into v_en15
    from public.envios_otp
   where telefono = v_tel and creado > now() - interval '15 minutes';
  if v_en15 >= c_max_15min then
    return jsonb_build_object('ok', false,
      'error', 'Demasiados códigos pedidos. Espera 15 minutos.', 'motivo', 'telefono_15min');
  end if;

  select count(*) into v_enhora
    from public.envios_otp
   where telefono = v_tel and creado > now() - interval '1 hour';
  if v_enhora >= c_max_hora then
    return jsonb_build_object('ok', false,
      'error', 'Demasiados códigos pedidos hoy. Intenta más tarde.', 'motivo', 'telefono_hora');
  end if;

  -- ── Autorizado: se registra el envío ────────────────────────────────────
  insert into public.envios_otp (telefono, canal)
  values (v_tel, coalesce(nullif(p_canal,''), 'sms'));

  delete from public.envios_otp where creado < now() - interval '7 days';

  return jsonb_build_object('ok', true);
end;
$$;

-- Igual que emitir_sesion_cliente: solo la llaman las funciones serverless.
-- Si `anon` pudiera invocarla, podría agotar el cupo global a propósito y dejar
-- a los clientes legítimos sin poder recibir su código.
revoke all on function public.registrar_envio_otp(text, text) from public, anon, authenticated;
grant execute on function public.registrar_envio_otp(text, text) to service_role;
