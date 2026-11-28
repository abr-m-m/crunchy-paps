-- 27 nov 2026 — Quien puede pedir un enlace de pago, y cuánto por día
--
-- Abraham: «está el ayudante de la tienda y pide por la aplicación, pero no
-- tiene los datos bancarios del dueño. ¿Cómo generar un link para que se lo
-- mande al dueño y el dueño pague?» Y después: «¿podemos poner límite de
-- enlaces creados por repartidor/vendedor?».
--
-- DÓNDE VIVE LA POLÍTICA. En Postgres, no en la Edge Function. La función que
-- habla con Stripe queda delgada: recibe el token, pregunta aquí si puede, y
-- si la respuesta es no, no crea nada. Así la regla -quién, cuánto, con qué
-- tope- se cambia y se prueba con SQL, que es donde se puede, en vez de con un
-- despliegue de Edge Functions, que es donde no.
--
-- LO QUE ESTO ARREGLA DE PASO. `crear-checkout` hoy NO pide sesión: cualquiera
-- con la llave pública puede pedir el enlace de cualquier pedido. No es un
-- agujero de dinero -pagar la cuenta de otro no es un ataque y se niega si ya
-- está pagado- pero filtra el total de cualquier pedido por enumeración.
-- Mientras el enlace era un detalle interno importaba poco; en cuanto se manda
-- por WhatsApp, no.
--
-- EL TOPE, dicho con honestidad. El dinero de un enlace entra SIEMPRE a la
-- cuenta de Crunchy Paps: un repartidor no puede desviarlo. Así que el tope no
-- protege el dinero. Protege otras dos cosas reales: que alguien use el
-- endpoint para probar tarjetas robadas -lo que trae contracargos y castigo de
-- Stripe- y la comisión, que es ~4 % de cada cobro. Y puede estorbar un día
-- bueno. Por eso nace SIN tope: la llave existe, el número lo pone Abraham.
--
-- SE MIDE, NO SE CUENTA. Igual que los topes de las promociones: el consumo
-- sale de las filas de `enlaces_pago`, no de un contador que se separa de la
-- realidad. Y se cuenta por PEDIDO distinto, no por llamada: un enlace que
-- caducó y se vuelve a generar es el mismo cobro, no dos.

begin;

-- ── 1. La bitácora de enlaces ─────────────────────────────────────────────
create table if not exists public.enlaces_pago (
  id           bigserial primary key,
  id_orden     bigint not null references public.ordenes(id) on delete cascade,
  id_vendedor  bigint,            -- NULL = lo pidió el propio cliente
  telefono     text,              -- el del cliente, para rastrear sin sesión
  monto        numeric,
  origen       text,              -- 'checkout' | 'reparto' | 'pedidos'
  creado       timestamptz not null default now()
);

create index if not exists enlaces_pago_vendedor_dia
  on public.enlaces_pago (id_vendedor, creado);
create index if not exists enlaces_pago_orden on public.enlaces_pago (id_orden);

-- Cerrada: la escribe solo el RPC de abajo, que es SECURITY DEFINER.
alter table public.enlaces_pago enable row level security;
comment on table public.enlaces_pago is
  'Cada vez que alguien pide un enlace de pago. Solo-INSERT, la escribe autorizar_enlace_pago. 27 nov 2026.';

-- ── 2. Lo que lleva gastado un vendedor hoy ───────────────────────────────
-- Por PEDIDO distinto: regenerar un enlace caducado no es un cobro nuevo.
create or replace function public.enlaces_pago_hoy(p_id_vendedor bigint)
returns table (pedidos integer, monto numeric)
language sql stable security definer set search_path = public, pg_temp as $fn$
  select coalesce(count(*), 0)::integer, coalesce(sum(e.monto), 0)::numeric
    from (select distinct on (id_orden) id_orden, monto
            from public.enlaces_pago
           where id_vendedor = p_id_vendedor
             and creado >= date_trunc('day', now() at time zone 'America/Mexico_City')
                           at time zone 'America/Mexico_City'
           order by id_orden, creado) e;
$fn$;
revoke all on function public.enlaces_pago_hoy(bigint) from public, anon, authenticated;

-- ── 3. La puerta ──────────────────────────────────────────────────────────
create or replace function public.autorizar_enlace_pago(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_orden    public.ordenes%rowtype;
  v_vend     bigint;
  v_tel_ses  text;
  v_tel_orden text;
  v_cfg      jsonb;
  v_max_ped  int;
  v_max_mto  numeric;
  v_hoy      record;
  v_ya       boolean;
begin
  select * into v_orden from public.ordenes where id = (p_data->>'idOrden')::bigint;
  if v_orden.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_existe');
  end if;
  if v_orden.estatus_pedido = 'Cancelado' then
    return jsonb_build_object('ok', false, 'error', 'cancelado',
      'mensaje', 'Ese pedido está cancelado.');
  end if;
  if coalesce(v_orden.estado_pago, '') = 'pagado'
     or coalesce(v_orden.estatus_pago, '') = 'Pagado' then
    return jsonb_build_object('ok', false, 'error', 'ya_pagado',
      'mensaje', 'Ese pedido ya está pagado.');
  end if;
  -- El mínimo de Stripe. Se dice aquí para que la pantalla no mande a alguien
  -- a un enlace que va a fallar con «monto inválido».
  if coalesce(v_orden.total, 0) < 10 then
    return jsonb_build_object('ok', false, 'error', 'monto_minimo',
      'mensaje', 'Stripe no cobra menos de $10.');
  end if;

  -- ¿Vendedor? Entonces puede cobrar cualquier pedido de su trabajo.
  select s.id_vendedor into v_vend from public.resolver_sesion_vendedor(p_data->>'token') s;

  if v_vend is null then
    -- ¿El cliente dueño del pedido? Solo el suyo.
    v_tel_ses := public.resolver_sesion_cliente(p_data->>'token');
    if v_tel_ses is null then
      return jsonb_build_object('ok', false, 'error', 'sin_sesion');
    end if;
    -- El pedido no guarda telefono: el dueño se mira por `clientes`. Un pedido
    -- sin cliente -mostrador, o uno huerfano- no es de nadie, asi que ninguna
    -- sesion de cliente puede reclamarlo.
    select right(regexp_replace(coalesce(c.telefono, ''), '\D', '', 'g'), 10)
      into v_tel_orden
      from public.clientes c where c.id = v_orden.id_cliente;
    if v_tel_orden is null
       or v_tel_orden <> right(regexp_replace(v_tel_ses, '\D', '', 'g'), 10) then
      return jsonb_build_object('ok', false, 'error', 'no_es_tuyo');
    end if;
  else
    -- ── El tope, solo para vendedores ─────────────────────────────────────
    select valor into v_cfg from public.config_produccion where clave = 'cobro_tarjeta';
    v_max_ped := nullif(v_cfg->>'max_pedidos_dia', '')::int;
    v_max_mto := nullif(v_cfg->>'max_monto_dia', '')::numeric;

    if v_max_ped is not null or v_max_mto is not null then
      select * into v_hoy from public.enlaces_pago_hoy(v_vend);
      -- ¿Este pedido YA cuenta en el dia? Entonces no ocupa un hueco nuevo:
      -- regenerar un enlace que caduco es el MISMO cobro, no dos. Sin esto, el
      -- tope mordia al segundo intento del mismo pedido.
      select exists (
        select 1 from public.enlaces_pago e
         where e.id_orden = v_orden.id and e.id_vendedor = v_vend
           and e.creado >= date_trunc('day', now() at time zone 'America/Mexico_City')
                           at time zone 'America/Mexico_City') into v_ya;

      if not v_ya and v_max_ped is not null and v_hoy.pedidos >= v_max_ped then
        return jsonb_build_object('ok', false, 'error', 'tope_pedidos',
          'mensaje', 'Llegaste al tope de ' || v_max_ped || ' cobros con tarjeta por hoy.',
          'hoy', v_hoy.pedidos);
      end if;
      -- El tope de monto se mira CON este pedido dentro: de nada sirve avisar
      -- cuando ya se paso.
      if v_max_mto is not null
         and (v_hoy.monto + case when v_ya then 0 else v_orden.total end) > v_max_mto then
        return jsonb_build_object('ok', false, 'error', 'tope_monto',
          'mensaje', 'Este cobro pasa el tope de $' || v_max_mto || ' por tarjeta al día.',
          'hoy', v_hoy.monto);
      end if;
    end if;
  end if;

  insert into public.enlaces_pago (id_orden, id_vendedor, telefono, monto, origen)
  values (v_orden.id, v_vend,
          (select right(regexp_replace(coalesce(c.telefono, ''), '\D', '', 'g'), 10)
             from public.clientes c where c.id = v_orden.id_cliente),
          v_orden.total,
          nullif(btrim(coalesce(p_data->>'origen', '')), ''));

  return jsonb_build_object('ok', true, 'idOrden', v_orden.id, 'monto', v_orden.total,
                            'consecutivo', v_orden.consecutivo, 'esVendedor', v_vend is not null);
end;
$fn$;
revoke all on function public.autorizar_enlace_pago(jsonb) from public, anon;
-- Solo la llave de servicio: la llama la Edge Function, nunca el navegador.
-- Si la llamara el navegador, saltarsela seria tan facil como no llamarla.
grant execute on function public.autorizar_enlace_pago(jsonb) to service_role;
comment on function public.autorizar_enlace_pago(jsonb) is
  'Decide si se puede crear un enlace de pago para un pedido, y lo apunta. La llama crear-checkout con la llave de servicio. 27 nov 2026.';

commit;
