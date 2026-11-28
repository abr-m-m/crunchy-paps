-- 27 nov 2026 — La sesión se comprueba ANTES que el estado del pedido
--
-- Al probar la puerta en produccion salio esto:
--
--   sin token, pedido 1   -> 409 {"error":"no_existe"}
--   sin token, cancelado  -> 409 {"error":"cancelado"}
--
-- Es decir: sin ninguna sesion, cualquiera con la llave publica podia
-- preguntar por un id y enterarse de si ese pedido existe, si esta cancelado,
-- si ya se pago y si pasa de $10. Menos de lo que se filtraba antes -el total
-- entero, por la pagina de Stripe-, pero es informacion que se da a quien no
-- ha acreditado nada, y el orden de las comprobaciones es lo unico que hacia
-- falta cambiar.
--
-- Ahora: primero QUIEN ERES, despues QUE PASA CON EL PEDIDO. A quien no trae
-- sesion se le contesta lo mismo -`sin_sesion`- exista el pedido o no, asi que
-- no se puede usar el endpoint para enumerar nada.
--
-- El resto del cuerpo no cambia.

begin;

create or replace function public.autorizar_enlace_pago(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_orden     public.ordenes%rowtype;
  v_vend      bigint;
  v_tel_ses   text;
  v_tel_orden text;
  v_cfg       jsonb;
  v_max_ped   int;
  v_max_mto   numeric;
  v_hoy       record;
  v_ya        boolean;
begin
  -- ── 1. Quien eres. Antes que nada ───────────────────────────────────────
  select s.id_vendedor into v_vend from public.resolver_sesion_vendedor(p_data->>'token') s;
  if v_vend is null then
    v_tel_ses := public.resolver_sesion_cliente(p_data->>'token');
    if v_tel_ses is null then
      -- La misma respuesta exista el pedido o no: el endpoint no sirve para
      -- averiguar que ids hay.
      return jsonb_build_object('ok', false, 'error', 'sin_sesion');
    end if;
  end if;

  -- ── 2. Que pedido es ────────────────────────────────────────────────────
  select * into v_orden from public.ordenes where id = (p_data->>'idOrden')::bigint;
  if v_orden.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_existe');
  end if;

  -- Si quien pregunta es un cliente, tiene que ser SU pedido. Se comprueba
  -- aqui, antes de contar nada de su estado.
  if v_vend is null then
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
  end if;

  -- ── 3. Si ese pedido admite cobro ───────────────────────────────────────
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

  -- ── 4. El tope, solo para vendedores ────────────────────────────────────
  if v_vend is not null then
    select valor into v_cfg from public.config_produccion where clave = 'cobro_tarjeta';
    v_max_ped := nullif(v_cfg->>'max_pedidos_dia', '')::int;
    v_max_mto := nullif(v_cfg->>'max_monto_dia', '')::numeric;

    if v_max_ped is not null or v_max_mto is not null then
      select * into v_hoy from public.enlaces_pago_hoy(v_vend);
      -- ¿Este pedido YA cuenta en el dia? Entonces no ocupa un hueco nuevo:
      -- regenerar un enlace que caduco es el MISMO cobro, no dos.
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

revoke all on function public.autorizar_enlace_pago(jsonb) from public, anon, authenticated;
grant execute on function public.autorizar_enlace_pago(jsonb) to service_role;

commit;
