-- 20261113000002_radar_instagram.sql
-- Radar de Instagram: las tres tablas, la lista semilla y la lectura del informe.
-- Diseno: cambios/2026-11-13-radar-instagram.md · Plan: ...-plan.md, tarea 2.
--
-- No toca nada existente. Ninguna de estas tablas guarda datos de clientes: son
-- cuentas publicas de negocio y metricas publicas.

-- ── T1. Las cuentas que se vigilan ──────────────────────────────────────────
-- `estado` existe porque NADIE ha verificado esta lista (D7 del diseno). Intente
-- comprobar los handles desde fuera y el metodo no servia: instagram.com devuelve
-- 200 igual para una cuenta real que para un usuario inventado. La primera
-- llamada a business_discovery es la que poda.
create table if not exists public.ig_cuentas (
  usuario    text primary key,
  grupo      text        not null check (grupo in ('artesanal', 'local', 'grande', 'propia')),
  estado     text        not null default 'por_comprobar'
               check (estado in ('por_comprobar', 'ok', 'no_existe', 'no_es_negocio', 'sin_datos')),
  activa     boolean     not null default true,
  nota       text,
  creada_en  timestamptz not null default now(),
  revisada_en timestamptz
);

-- ── T2. El historico de medios ──────────────────────────────────────────────
-- SIN restriccion unica sobre (usuario, id_medio), A PROPOSITO: se guarda una
-- fila por cada LECTURA, no una por reel. Sin lecturas viejas no se puede
-- comparar con la semana pasada, que es donde esta casi todo el valor.
create table if not exists public.ig_medios (
  id           bigserial primary key,
  usuario      text        not null,
  id_medio     text        not null,
  tipo         text,
  publicado_en timestamptz,
  vistas       integer     not null default 0,
  me_gusta     integer     not null default 0,
  comentarios  integer     not null default 0,
  texto        text,
  enlace       text,
  leido_en     timestamptz not null default now()
);
create index if not exists ix_ig_medios_usuario_leido on public.ig_medios (usuario, leido_en desc);
create index if not exists ix_ig_medios_medio on public.ig_medios (id_medio, leido_en desc);

-- ── T3. Los informes ────────────────────────────────────────────────────────
create table if not exists public.ig_informes (
  id                bigserial primary key,
  fecha             date        not null unique,
  desde             date,
  hasta             date,
  cuentas_leidas    integer     not null default 0,
  cuentas_fallidas  integer     not null default 0,
  destacados        jsonb       not null default '[]'::jsonb,
  texto             text,
  tokens            integer,
  creado_en         timestamptz not null default now()
);

-- ── Las dos cerraduras, no una (regla 41) ───────────────────────────────────
-- RLS activa y CERO politicas: ni anon ni authenticated leen ni escriben una
-- sola fila. Solo la llave de servicio y los RPC security definer.
alter table public.ig_cuentas  enable row level security;
alter table public.ig_medios   enable row level security;
alter table public.ig_informes enable row level security;
revoke all on table public.ig_cuentas  from anon, authenticated;
revoke all on table public.ig_medios   from anon, authenticated;
revoke all on table public.ig_informes from anon, authenticated;

-- ── T4. La lectura del informe ──────────────────────────────────────────────
-- La puerta es la misma que la de /retos (retos_admin, 20260930000009:240).
-- OJO: NO lleva `stable`, aunque solo lea. `sesion_es_dueno` llama a
-- `resolver_sesion_vendedor`, que ESCRIBE (toca la sesion al resolverla), y
-- PostgREST corre las funciones `stable` en transaccion de solo lectura:
-- `cannot execute UPDATE in a read-only transaction`. retos_admin tampoco lo
-- lleva. Se vio poniendolo y rompiendolo.
create or replace function public.radar_informe(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_fecha date := nullif(p_data->>'fecha', '')::date;
  v_inf   jsonb;
  v_cue   jsonb;
  v_fechas jsonb;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  select to_jsonb(i) into v_inf
    from public.ig_informes i
   where v_fecha is null or i.fecha = v_fecha
   order by i.fecha desc
   limit 1;

  -- Las cuentas van SIEMPRE, con su estado y su motivo: una cuenta que falla
  -- tiene que verse en la pantalla, no desaparecer en silencio.
  select coalesce(jsonb_agg(jsonb_build_object(
           'usuario', c.usuario, 'grupo', c.grupo, 'estado', c.estado,
           'activa', c.activa, 'nota', c.nota, 'revisadaEn', c.revisada_en
         ) order by c.grupo, c.usuario), '[]'::jsonb)
    into v_cue
    from public.ig_cuentas c;

  select coalesce(jsonb_agg(f.fecha order by f.fecha desc), '[]'::jsonb)
    into v_fechas
    from (select fecha from public.ig_informes order by fecha desc limit 26) f;

  return jsonb_build_object(
    'ok', true,
    'informe', v_inf,
    'cuentas', v_cue,
    'fechas', v_fechas
  );
end;
$fn$;

revoke all on function public.radar_informe(jsonb) from public;
grant execute on function public.radar_informe(jsonb) to anon, authenticated;

-- ── T5. La lista semilla ────────────────────────────────────────────────────
-- TODAS entran en 'por_comprobar'. La nota dice de donde salio cada una, para
-- poder dudar de ella despues con la informacion original.
--
-- Las tres marcas de botana artesanal que encontre (Botanas Sol de Chalco,
-- Papita la del Barrio, Senor Mango) NO ESTAN: ninguna fuente daba su cuenta, y
-- deducir el handle del nombre de la marca es exactamente lo que D7 prohibe.
-- Ese grupo queda en cero a proposito, y es el hueco real de la lista.
--
-- `do nothing` para que volver a aplicar esto no duplique ni pise un estado ya
-- comprobado por una corrida anterior.
insert into public.ig_cuentas (usuario, grupo, nota) values
  ('papassabritas',     'grande', 'citado por Chilango y por un boletin de PepsiCo'),
  ('crunchy.papsmx',    'propia', 'la nuestra'),
  ('cesardelaparraco',  'local',  'lista publica de Modash; creador, no negocio'),
  ('eat.walking',       'local',  'lista publica de Modash; creador, no negocio'),
  ('debyfer__',         'local',  'lista publica de Modash; creador, no negocio'),
  ('sheelgarcia',       'local',  'lista publica de Modash; creador, no negocio'),
  ('eatoutdo',          'local',  'lista publica de Modash; creador, no negocio'),
  ('domegaletto',       'local',  'lista publica de Modash; creador, no negocio'),
  ('dashayuso',         'local',  'lista publica de Modash; creador, no negocio'),
  ('thecuriousmexican', 'local',  'lista publica de Modash; creador, no negocio'),
  ('qarikei',           'local',  'lista publica de Modash; creador, no negocio'),
  ('feer_mondragonn',   'local',  'lista publica de Modash; creador, no negocio'),
  ('consypau',          'local',  'lista publica de Modash; creador, no negocio'),
  ('ponchomendivil',    'local',  'lista publica de Modash; creador, no negocio'),
  ('lauras0l',          'local',  'lista publica de Modash; creador, no negocio'),
  ('mafer.gonzy',       'local',  'lista publica de Modash; creador, no negocio'),
  ('sharonjimenbec',    'local',  'lista publica de Modash; creador, no negocio'),
  ('robertobaezmx',     'local',  'lista publica de Modash; creador, no negocio'),
  ('_iamnohemiah',      'local',  'lista publica de Modash; creador, no negocio'),
  ('melifilli',         'local',  'lista publica de Modash; creador, no negocio'),
  ('denissette',        'local',  'lista publica de Modash; creador, no negocio'),
  ('paukreuz',          'local',  'lista publica de Modash; creador, no negocio')
on conflict (usuario) do nothing;
