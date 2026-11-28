-- 27 nov 2026 — Ponerle nombre a cada aparato
--
-- Abraham, al ver que la lista de sesiones solo dice «Android · Chrome»:
-- «¿el PIN qué registra del aparato? ¿Id del aparato? ¿modelo? ¿marca?».
--
-- Lo que el navegador deja leer es su user-agent y nada más: sistema,
-- navegador y, en Android, a veces el modelo (`SM-A546E`). **Un id de aparato,
-- un IMEI o un número de serie no se pueden leer desde una web**, y está bien
-- que no se pueda.
--
-- Con tres teléfonos iguales la lista diría «Android · Chrome» tres veces y no
-- serviría para nada el día que haya que cerrar UNO. Así que el aparato se
-- bautiza: la app genera un código al azar la primera vez que se entra en ese
-- teléfono, lo guarda ahí, y Abraham le pone nombre desde la consola.
--
-- NO ES UNA HUELLA NI PRETENDE SERLO. Borrar los datos del navegador lo
-- reinicia y el aparato vuelve a aparecer sin nombre. Eso es una característica
-- y no un fallo: un aparato que aparece sin nombre es justo el que hay que
-- mirar.

begin;

-- ── 1. Los aparatos ───────────────────────────────────────────────────────
create table if not exists public.aparatos (
  id          text primary key,           -- el codigo que genera la app
  nombre      text,                       -- «Telefono de Ana», lo pone el dueño
  user_agent  text,                       -- lo ultimo que dijo de si mismo
  creado      timestamptz not null default now(),
  ultimo_uso  timestamptz not null default now()
);
alter table public.aparatos enable row level security;
comment on table public.aparatos is
  'Un codigo por instalacion del navegador, para poder nombrar los telefonos. No es una huella: borrar los datos del navegador lo reinicia. 27 nov 2026.';

alter table public.sesiones_vendedor add column if not exists aparato_id text;
create index if not exists sesiones_vendedor_aparato on public.sesiones_vendedor (aparato_id);

-- ── 2. Apuntar el aparato al entrar ───────────────────────────────────────
-- Se hace en una funcion aparte y no dentro de `validar_vendedor_pin`: esa es
-- la puerta de entrada de todo el equipo y cada linea de mas ahi es riesgo.
create or replace function public.registrar_aparato(p_id text, p_ua text)
returns text language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_id text := nullif(btrim(coalesce(p_id, '')), '');
begin
  -- Un id que no tenga la forma esperada se ignora en silencio: viene del
  -- navegador y no vale la pena dejar que invente filas.
  if v_id is null or v_id !~ '^[a-z0-9]{8,32}$' then return null; end if;
  insert into public.aparatos (id, user_agent)
  values (v_id, left(coalesce(p_ua, ''), 400))
  on conflict (id) do update
     set ultimo_uso = now(),
         user_agent = coalesce(nullif(left(excluded.user_agent, 400), ''), public.aparatos.user_agent);
  return v_id;
end;
$fn$;
revoke all on function public.registrar_aparato(text, text) from public, anon, authenticated;

-- ── 3. Bautizarlo ─────────────────────────────────────────────────────────
create or replace function public.nombrar_aparato(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_id  text := nullif(btrim(coalesce(p_data->>'id', '')), '');
  v_nom text := nullif(btrim(coalesce(p_data->>'nombre', '')), '');
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'solo_dueno');
  end if;
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'falta_id'); end if;
  update public.aparatos set nombre = left(v_nom, 60) where id = v_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_existe'); end if;
  return jsonb_build_object('ok', true, 'nombre', left(v_nom, 60));
end;
$fn$;
revoke all on function public.nombrar_aparato(jsonb) from public, anon;
grant execute on function public.nombrar_aparato(jsonb) to anon, authenticated;

commit;
