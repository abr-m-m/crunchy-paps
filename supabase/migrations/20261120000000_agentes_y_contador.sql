-- ============================================================================
--  El espinazo de los agentes, y el primero que se cuelga de él: el contador
--
--  Diseno: cambios/2026-11-20-el-equipo-completo.md
--
--  NO SE CONSTRUYE «EL CONTADOR». Se construye lo que van a usar TODOS los
--  agentes de operacion -registro, bitacora de corridas, convencion de aviso- y
--  el contador es el primero. Peticion de Abraham el 20 nov 2026: «considera que
--  en el camino pueden surgir necesidades nuevas; la construccion debe
--  considerar la posibilidad de integrar mas equipo».
--
--  Un agente nuevo = una fila en `agentes` + un endpoint. Nada mas.
--
--  EL CONTADOR V1 NO LLAMA A NINGUN MODELO. Las seis revisiones son SQL, asi
--  que **cuesta cero**. Explicar los hallazgos en prosa necesitaria un modelo y
--  es la V2; hoy no hace falta, porque un hallazgo con su folio y su monto se
--  entiende solo.
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

-- ── 1. El registro: quien existe ────────────────────────────────────────────
-- Dice QUIEN es cada agente y si esta encendido. NO dice como se comporta: eso
-- vive donde ya vivia (`config_produccion`, una clave por agente), y la columna
-- `config_clave` apunta ahi. Dos fuentes para dos preguntas distintas, no dos
-- copias de la misma (regla 63).
create table if not exists public.agentes (
  clave         text primary key,
  nombre        text        not null,
  que_hace      text        not null,
  casa          text        not null check (casa in ('vercel', 'supabase', 'claude')),
  activo        boolean     not null default true,
  horario       text,                      -- informativo, para la pantalla
  avisar_a      text[]      not null default '{}',
  config_clave  text,                      -- la clave suya en config_produccion
  creado_en     timestamptz not null default now()
);

comment on table public.agentes is
  'Registro del equipo de agentes: quien existe, donde corre y si esta encendido. '
  'El comportamiento de cada uno vive en config_produccion, no aqui.';

-- Los que YA corren quedan registrados, para que el registro no nazca mintiendo
-- por omision. `activo` refleja la realidad de hoy, no el deseo.
insert into public.agentes (clave, nombre, que_hace, casa, activo, horario, config_clave) values
  ('whatsapp', 'Atencion por WhatsApp',
   'Contesta, cotiza con el precio del canal, levanta pedidos y escala a una persona.',
   'vercel', true, 'Al llegar un mensaje', 'agente_whatsapp'),
  ('recordatorios', 'Recordatorios de pago',
   'Avisa de pedidos pendientes de pago a las 24 h y 48 h, maximo tres.',
   'vercel', true, '0 17 * * *', null),
  ('radar', 'Radar de Instagram',
   'Mide que reels revientan contra lo normal de su propia cuenta.',
   'vercel', false, 'Semanal', null),
  ('caja_abrir', 'Abrir la caja del dia',
   'Abre una caja por punto activo y adopta los movimientos huerfanos del dia.',
   'supabase', true, '5 6 * * *', null),
  ('puntos_vencer', 'Vencer puntos',
   'Vence los puntos que cumplieron 12 meses, FIFO por paquete.',
   'supabase', true, '10 6 * * *', null),
  ('contador', 'Contador',
   'Cruza la app contra la caja, los puntos y Stripe. Si todo cuadra, no avisa.',
   'vercel', true, '0 7 * * *', 'agente_contador')
on conflict (clave) do nothing;

-- ── 2. La bitacora: que hizo cada uno, y que costo ──────────────────────────
-- UNA fila por corrida, de cualquier agente. Es lo que hace legible al equipo:
-- sin esto, el gasto y los fallos de cada agente viven en su propio rincon y
-- nadie puede mirar el conjunto. Es solo-INSERT, como los demas libros.
create table if not exists public.agentes_corridas (
  id             bigserial primary key,
  agente         text        not null references public.agentes(clave),
  inicio         timestamptz not null default now(),
  duracion_ms    integer,
  ok             boolean     not null default true,
  cuantos        integer     not null default 0,   -- hallazgos; 0 = todo en orden
  hallazgos      jsonb,
  aviso_enviado  boolean     not null default false,
  tokens         integer,                           -- null = no llamo a ningun modelo
  costo_usd      numeric(10,5),
  error          text
);

create index if not exists ix_agentes_corridas_agente_inicio
  on public.agentes_corridas (agente, inicio desc);

comment on table public.agentes_corridas is
  'Una fila por corrida de cualquier agente. Solo-INSERT. `cuantos` = 0 significa '
  'que corrio y no encontro nada, que NO es lo mismo que no haber corrido.';

-- ── 3. Las siete revisiones del contador ────────────────────────────────────
-- CADA UNA NACIO DE UN INCIDENTE REAL, igual que las reglas. No son revisiones
-- inventadas por simetria:
--
--   pagado_sin_caja      PED-00075: $880 cobrados por Stripe el 13 oct, entrega
--                        prometida el 15, nunca armado ni entregado, caja en
--                        `pendiente_confirmacion`. **Encontrado el 20 nov 2026 por
--                        esta misma consulta, cinco semanas despues, y nadie lo
--                        habia visto.** Abraham confirmo ese dia que se reembolso
--                        por su cuenta personal, igual que PED-00067: el dinero
--                        volvio, el registro no. El pedido seguia en 'Pendiente',
--                        con 88 puntos vivos a favor del cliente.
--   caja_sin_cobro       El fantasma del 22 sep: el asiento se escribia al CREAR
--                        el pedido y no al cobrarlo (migracion 20261002000000).
--   cancelado_con_caja   Los tres cancelados-pero-pagados de ago y sep.
--   sin_caja_dia         Los 73 huerfanos historicos reenganchados el 22 sep.
--   stripe_sin_intent    Sin el intent no se puede rastrear el cargo ni pedir el
--                        reembolso: paso con los tres de agosto.
--   puntos_negativos     `ajuste` en vez de `generacion` al editar un pedido
--                        hacia perder puntos de OTROS pedidos (20261001000000).
--   entrega_vencida      La que PED-00075 enseño que faltaba: las otras seis lo
--                        vieron por la caja, CINCO SEMANAS tarde. Esta lo habria
--                        visto el 17 de octubre.
--
-- CALIBRADA CONTRA PRODUCCION el 20 nov 2026 antes de escribirla: cinco dan 0,
-- que es lo que ya se sabia, y `pagado_sin_caja` da 1. Una herramienta de
-- medicion se calibra contra un hecho conocido antes de creerle (regla 60).
create or replace function public.contador_revisar(p_dias integer default 365)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
with neto as (
  select o.id, o.consecutivo, o.fecha_orden, o.total,
         o.estatus_pedido, o.estatus_pago,
         coalesce(o.tipo_interno, '') as interno,
         coalesce(o.tipo_pago, '')    as tipo_pago,
         o.stripe_payment_intent,
         o.fecha_entrega::date as prometida,
         o.fecha_entrega_real  as entregada,
         coalesce((select sum(m.monto) from public.caja_movimientos m
                    where m.id_orden = o.id and m.tipo like 'venta_%'), 0) as caja_neto
    from public.ordenes o
   where o.fecha_orden >= now() - make_interval(days => greatest(p_dias, 1))
),
r as (
  select 'pagado_sin_caja' as clave, 'alta' as gravedad,
         'Cobrado y sin asiento de caja' as titulo,
         jsonb_agg(jsonb_build_object('folio', consecutivo, 'monto', total,
                                      'fecha', fecha_orden::date, 'estatus', estatus_pedido)
                   order by fecha_orden) as ejemplos
    from neto
   where estatus_pago = 'Pagado' and estatus_pedido <> 'Cancelado'
     and interno = '' and caja_neto = 0
  union all
  select 'caja_sin_cobro', 'alta', 'Asiento de caja sin cobro',
         jsonb_agg(jsonb_build_object('folio', consecutivo, 'monto', caja_neto,
                                      'fecha', fecha_orden::date) order by fecha_orden)
    from neto where estatus_pago <> 'Pagado' and caja_neto > 0
  union all
  select 'cancelado_con_caja', 'alta', 'Cancelado y la caja sigue en positivo',
         jsonb_agg(jsonb_build_object('folio', consecutivo, 'monto', caja_neto,
                                      'fecha', fecha_orden::date) order by fecha_orden)
    from neto where estatus_pedido = 'Cancelado' and caja_neto > 0
  union all
  select 'sin_caja_dia', 'media', 'Movimiento de caja sin dia asignado',
         jsonb_agg(jsonb_build_object('id', id, 'monto', monto, 'fecha', fecha::date)
                   order by fecha)
    from public.caja_movimientos where id_caja_dia is null
  union all
  select 'stripe_sin_intent', 'media', 'Cobro por Stripe sin identificador del cargo',
         jsonb_agg(jsonb_build_object('folio', consecutivo, 'monto', total,
                                      'fecha', fecha_orden::date) order by fecha_orden)
    from neto
   where estatus_pago = 'Pagado' and tipo_pago ilike '%stripe%'
     and stripe_payment_intent is null
  union all
  select 'puntos_negativos', 'media', 'Cliente con saldo de puntos negativo',
         jsonb_agg(jsonb_build_object('cliente', id_cliente, 'puntos', saldo))
    from (select id_cliente, sum(puntos) as saldo
            from public.lealtad_movimientos group by id_cliente having sum(puntos) < 0) z
  union all
  -- LA QUE FALTABA, Y LA ESCRIBIO PED-00075. Las seis de arriba lo encontraron
  -- por el lado de la caja, cinco semanas tarde. Esta lo habria encontrado el
  -- 17 de octubre: alguien pago, la fecha que le prometimos paso, y no se le
  -- entrego. Es la unica revision que mira al CLIENTE y no a los libros, y la
  -- unica que avisa mientras todavia se puede arreglar.
  select 'entrega_vencida', 'alta', 'Pagado y la fecha de entrega ya paso',
         jsonb_agg(jsonb_build_object('folio', consecutivo, 'monto', total,
                                      'prometida', prometida,
                                      'diasTarde', current_date - prometida)
                   order by prometida)
    from neto
   where estatus_pago = 'Pagado'
     and estatus_pedido not in ('Cancelado', 'Entregado')
     and interno = '' and entregada is null
     and prometida is not null and prometida < current_date - 2
),
vivos as (
  -- `jsonb_agg` de un conjunto vacio devuelve NULL, no '[]': por eso se filtra
  -- por `ejemplos is not null` y no por longitud. Sin esto, las seis revisiones
  -- saldrian siempre, cinco de ellas vacias, y el informe dejaria de leerse.
  select * from r where ejemplos is not null
)
select jsonb_build_object(
  'revisado_en', now(),
  'dias', greatest(p_dias, 1),
  'cuantos', coalesce((select sum(jsonb_array_length(ejemplos))::int from vivos), 0),
  'revisiones', coalesce((select jsonb_agg(jsonb_build_object(
      'clave', clave, 'gravedad', gravedad, 'titulo', titulo,
      'cuantos', jsonb_array_length(ejemplos),
      -- Un tope por revision: el aviso tiene que caber en un WhatsApp. El
      -- conteo de arriba sigue siendo el total, no el de la muestra.
      'ejemplos', (select jsonb_agg(e) from (
          select e from jsonb_array_elements(ejemplos) e limit 5) s)
    ) order by case gravedad when 'alta' then 0 else 1 end, clave) from vivos), '[]'::jsonb)
);
$$;

-- Regla 42: una funcion nueva concede EXECUTE a PUBLIC por defecto.
revoke all on function public.contador_revisar(integer) from public, anon, authenticated;
grant execute on function public.contador_revisar(integer) to service_role;

-- ── 4. Dejar constancia de la corrida ───────────────────────────────────────
-- La usan TODOS los agentes, no solo el contador. `p_data` es abierto a
-- proposito: un agente nuevo que mida otra cosa no necesita otra migracion.
create or replace function public.agente_registrar_corrida(p_data jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id bigint; v_agente text := p_data->>'agente';
begin
  if v_agente is null or not exists (select 1 from public.agentes where clave = v_agente) then
    raise exception 'agente_desconocido: %', coalesce(v_agente, '(null)');
  end if;

  insert into public.agentes_corridas
    (agente, duracion_ms, ok, cuantos, hallazgos, aviso_enviado, tokens, costo_usd, error)
  values (
    v_agente,
    (p_data->>'duracion_ms')::int,
    coalesce((p_data->>'ok')::boolean, true),
    coalesce((p_data->>'cuantos')::int, 0),
    p_data->'hallazgos',
    coalesce((p_data->>'aviso_enviado')::boolean, false),
    (p_data->>'tokens')::int,
    (p_data->>'costo_usd')::numeric,
    nullif(p_data->>'error', '')
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.agente_registrar_corrida(jsonb) from public, anon, authenticated;
grant execute on function public.agente_registrar_corrida(jsonb) to service_role;

-- ── 5. Lo que lee la pantalla ───────────────────────────────────────────────
-- Para que `/agente` pueda mostrar el equipo entero sin saber de cada uno.
create or replace function public.agentes_estado()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'clave', a.clave, 'nombre', a.nombre, 'queHace', a.que_hace, 'casa', a.casa,
    'activo', a.activo, 'horario', a.horario,
    'ultima', u.inicio, 'ultimaOk', u.ok, 'ultimosHallazgos', u.cuantos,
    'corridas30d', (select count(*) from public.agentes_corridas c
                     where c.agente = a.clave and c.inicio > now() - interval '30 days'),
    'costo30dUsd', (select coalesce(sum(c.costo_usd), 0) from public.agentes_corridas c
                     where c.agente = a.clave and c.inicio > now() - interval '30 days')
  ) order by a.casa, a.clave), '[]'::jsonb)
  from public.agentes a
  left join lateral (select inicio, ok, cuantos from public.agentes_corridas c
                      where c.agente = a.clave order by c.inicio desc limit 1) u on true;
$$;

revoke all on function public.agentes_estado() from public, anon;
grant execute on function public.agentes_estado() to service_role;

-- ── 6. RLS: las dos tablas quedan cerradas ──────────────────────────────────
-- Solo las alcanzan las funciones de arriba, que corren con la llave de
-- servicio. Regla 41: RLS y GRANT son dos cerraduras distintas, se echan las dos.
alter table public.agentes            enable row level security;
alter table public.agentes_corridas   enable row level security;
revoke all on public.agentes          from anon, authenticated;
revoke all on public.agentes_corridas from anon, authenticated;
