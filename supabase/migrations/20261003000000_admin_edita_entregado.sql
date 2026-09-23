-- El admin puede editar un pedido ENTREGADO, forzandolo explicitamente.
--
-- Hasta ahora `editable_pedido` bloqueaba 'Entregado' para TODO EL MUNDO: el
-- `p_quien` solo valia 'vendedor' o 'cliente', y el `v_admin` que existe en
-- `editar_pedido` / `obtener_pedido` solo decide QUE pedidos alcanzas (el dueno
-- todos, el vendedor los suyos), nunca si puedes saltarte el candado. Un pedido
-- entregado que salio mal no habia forma de corregirlo desde la app, ni siendo
-- el dueno. Decision de Abraham (22 sep 2026): abrir SOLO 'entregado'.
--
-- LA TRAMPA, y por que el Stripe se evalua aparte:
-- `editable_pedido` devuelve el PRIMER motivo de su cadena `elsif`, y 'Entregado'
-- se evalua ANTES que los dos de Stripe. Un pedido entregado Y pagado por Stripe
-- reporta 'entregado', no 'pagado_en_linea'. Si la excepcion se limitara a "si el
-- motivo es 'entregado', el admin pasa", esos pedidos quedarian editables — justo
-- lo que se descarto, porque el dinero ya se movio en Stripe y nada lo reconcilia.
-- Medido en produccion el 22 sep 2026: **3 pedidos** son Entregado + Stripe ($848).
-- Por eso se anade `v_stripe`, que se calcula aparte de la cadena y solo se usa al
-- decidir `editable`. NO se reordenan los `elsif`: reordenarlos cambiaria el
-- `motivo` que ven las pantallas y las pruebas (un Cancelado+Stripe pasaria de
-- 'cancelado' a 'pagado_en_linea') sin cambiar ninguna decision.
--
-- INTENCION EXPLICITA: el admin no se salta el candado por inercia. `editar_pedido`
-- pasa `p_quien := 'admin'` solo si el rol es admin Y el payload trae `forzar: true`.
-- Sin `forzar`, un entregado sigue devolviendo `no_editable/entregado` tambien para
-- el dueno. El servidor es quien decide (regla 10): la pantalla no puede concederselo.
-- Como el rol viaja dentro de `p_quien`, NINGUNA firma cambia.

-- ── editable_pedido: tercer rol 'admin' + candado de Stripe independiente ──────
create or replace function public.editable_pedido(o public.ordenes, p_quien text) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare v_m text := ''; v_stripe boolean;
begin
  -- Se calcula aparte de la cadena: la cadena para en el primer motivo y
  -- 'Entregado' va antes, asi que el motivo puede tapar un pedido de Stripe.
  v_stripe := lower(coalesce(o.estado_pago, '')) = 'pagado'
           or coalesce(o.stripe_payment_intent, '') <> ''
           or (coalesce(o.stripe_session_id, '') <> '' and lower(coalesce(o.estado_pago, '')) = 'pendiente');

  if o.estatus_pedido = 'Cancelado' then v_m := 'cancelado';
  -- 'admin' conserva lo que ya tenia el vendedor en el caso interno.
  elsif o.estatus_pedido = 'Entregado' and not (coalesce(o.tipo_interno, '') <> '' and p_quien in ('vendedor', 'admin')) then v_m := 'entregado';
  elsif lower(coalesce(o.estado_pago, '')) = 'pagado' or coalesce(o.stripe_payment_intent, '') <> '' then v_m := 'pagado_en_linea';
  elsif coalesce(o.stripe_session_id, '') <> '' and lower(coalesce(o.estado_pago, '')) = 'pendiente' then v_m := 'pago_en_linea_pendiente';
  elsif o.estatus_pedido = 'En camino' then v_m := 'en_camino';
  elsif o.armado_en is not null then v_m := 'ya_armado';
  end if;

  return jsonb_build_object(
    'editable', v_m = ''
             or (p_quien in ('vendedor', 'admin') and v_m in ('en_camino', 'ya_armado'))
             or (p_quien = 'admin' and v_m = 'entregado' and not v_stripe),
    'motivo', v_m);
end $$;
revoke all on function public.editable_pedido(public.ordenes, text) from public, anon, authenticated;

-- ── editar_pedido_compensar: el admin tambien desarma ─────────────────────────
-- Si no, un pedido armado editado por el admin se quedaria marcado como armado.
-- Unico cambio del cuerpo; el resto va verbatim de 20261001000000_editar_pedido.sql.
create or replace function public.editar_pedido_compensar(o public.ordenes, p_total_nuevo numeric, p_actor text, p_quien text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_avisos jsonb := '[]'::jsonb; v_caja jsonb := null; v_pts jsonb := null;
  v_orig  caja_movimientos%rowtype; v_dif numeric; v_codigo text; v_id_punto bigint; v_id_caja bigint; v_id_mov bigint;
  v_cfg jsonb; v_rate numeric; v_base text; v_neto numeric; v_desc numeric; v_obj integer; v_hay integer; v_dpts integer; v_id_led bigint;
begin
  if p_quien in ('vendedor', 'admin') and o.armado_en is not null then
    update ordenes set armado_en = null, armado_por = null where id = o.id;
  end if;

  if coalesce(o.tipo_interno, '') <> '' then
    return jsonb_build_object('avisos', v_avisos, 'caja', null, 'puntos', null);
  end if;

  select * into v_orig from caja_movimientos where id_orden = o.id and tipo like 'venta_%' order by id limit 1;
  v_dif := round(p_total_nuevo - coalesce(o.total, 0), 2);
  if v_orig.id is not null and v_dif <> 0 then
    v_codigo := case when v_orig.tipo = 'venta_efectivo' then 'punto_venta' else 'cuenta_banco' end;
    select id into v_id_punto from caja_puntos where codigo = v_codigo limit 1;
    select id into v_id_caja from caja_dias where id_punto = v_id_punto and fecha = current_date and estatus = 'abierta' limit 1;
    if v_id_punto is not null and v_id_caja is not null then
      insert into caja_movimientos (id_caja_dia, id_punto, tipo, monto, id_orden, consecutivo_pedido, id_mov_pareja, descripcion, actor)
      values (v_id_caja, v_id_punto, v_orig.tipo, v_dif, o.id, o.consecutivo, v_orig.id,
              'Ajuste por edición de ' || o.consecutivo || ' (' || coalesce(o.total, 0)::text || ' → ' || p_total_nuevo::text || ')', coalesce(p_actor, 'sistema'))
      returning id into v_id_mov;
      v_caja := jsonb_build_object('id', v_id_mov, 'tipo', v_orig.tipo, 'monto', v_dif, 'id_mov_pareja', v_orig.id);
    elsif o.estatus_caja = 'confirmado' then
      raise exception using errcode = 'P0001', message = 'caja_cerrada';
    else
      v_avisos := v_avisos || to_jsonb('caja_sin_ajuste'::text);
    end if;
  end if;

  if o.id_cliente is not null and o.id_cliente <> 999999
     and exists (select 1 from lealtad_movimientos where id_orden = o.id and tipo = 'generacion') then
    select valor into v_cfg from config_produccion where clave = 'lealtad';
    if v_cfg is null or coalesce((v_cfg->'generacion'->>'activo')::boolean, false) = false then
      perform public.evaluar_retos(o.id_cliente);
    else
      v_rate := coalesce((v_cfg->'generacion'->>'puntos_por_peso')::numeric, 0);
      v_base := coalesce(v_cfg->'generacion'->>'base', 'total');
      select subtotal, descuento into v_neto, v_desc from ordenes where id = o.id;
      v_neto := case v_base when 'neto' then greatest(0, coalesce(v_neto, 0) - coalesce(v_desc, 0))
                            when 'subtotal' then coalesce(v_neto, 0) else p_total_nuevo end;
      v_obj := floor(v_neto * v_rate)::integer;
      select coalesce(sum(puntos), 0)::integer into v_hay from lealtad_movimientos
       where id_orden = o.id and tipo in ('generacion', 'reversion', 'ajuste');
      v_dpts := v_obj - v_hay;
      if v_dpts <> 0 then
        -- Sigue siendo 'generacion', no 'ajuste': revertir_puntos_al_cancelar solo
        -- suma 'generacion' y 'reversion'. Ver la regla 1 de la revision final de
        -- 20261001000000_editar_pedido.sql.
        v_id_led := agregar_movimiento_lealtad(o.id_cliente, 'generacion', v_dpts, o.id, o.consecutivo, null, null, v_neto,
                      'Ajuste por edición de ' || o.consecutivo, coalesce(p_actor, 'sistema'));
        v_pts := jsonb_build_object('id', v_id_led, 'puntos', v_dpts);
      end if;
      perform public.evaluar_retos(o.id_cliente);
    end if;
  end if;

  return jsonb_build_object('avisos', v_avisos, 'caja', v_caja, 'puntos', v_pts);
end $$;
revoke all on function public.editar_pedido_compensar(public.ordenes, numeric, text, text) from public, anon, authenticated;

-- ── editar_pedido: 'admin' solo con rol admin Y forzar ────────────────────────
create or replace function public.editar_pedido(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id_vend bigint; v_rol text; v_id bigint; v_ref text := coalesce(p_data->>'idOrden', p_data->>'consecutivo', '');
  o ordenes%rowtype; v_dueno boolean; v_quien text;
begin
  select s.id_vendedor, s.rol into v_id_vend, v_rol from public.sesion_exige_seccion(p_data->>'token', 'pedidos') s;
  if v_id_vend is null then return jsonb_build_object('ok', false, 'error', 'no_autorizado'); end if;
  select * into o from ordenes where consecutivo = v_ref or (v_ref ~ '^[0-9]+$' and id = v_ref::bigint) limit 1;
  if o.id is null then return jsonb_build_object('ok', false, 'error', 'no_encontrado'); end if;
  v_dueno := lower(trim(coalesce(v_rol, ''))) in ('admin', 'administrador');
  if not v_dueno and o.id_vendedor is distinct from v_id_vend then
    return jsonb_build_object('ok', false, 'error', 'no_editable', 'motivo', 'no_es_tu_pedido');
  end if;
  -- El rol viaja en p_quien: sin `forzar`, el admin edita exactamente como un vendedor.
  v_quien := case when v_dueno and coalesce((p_data->>'forzar')::boolean, false) then 'admin' else 'vendedor' end;
  begin
    return public.editar_pedido_interno(o.id, p_data->'lineas', coalesce(nullif(p_data->>'actualizadoPor', ''), 'vendedor'),
                                        coalesce(p_data->>'modo', 'aplicar'), v_quien);
  exception when others then
    if sqlerrm = 'sin_lote' then return jsonb_build_object('ok', false, 'error', 'sin_lote', 'mensaje', 'No hay lote activo: registra el lote de producción antes de agregar líneas a un pedido confirmado.'); end if;
    if sqlerrm = 'caja_cerrada' then return jsonb_build_object('ok', false, 'error', 'caja_cerrada', 'mensaje', 'Este pedido ya está en caja y la caja del día está cerrada: ábrela para editarlo.'); end if;
    raise;
  end;
end $$;
grant execute on function public.editar_pedido(jsonb) to anon, authenticated;

-- ── obtener_pedido: anade `puedeForzar` para que el drawer sepa ofrecerlo ─────
-- `editable` y `motivo` NO cambian de significado: se siguen calculando con
-- 'vendedor', asi que ningun consumidor existente se entera. `puedeForzar` es
-- informativo; quien decide sigue siendo `editar_pedido` al recibir `forzar`.
-- Copiada entera de 20261001000000_editar_pedido.sql:662-714; lo unico que cambia
-- es el jsonb del return.
create or replace function public.obtener_pedido(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id_vend bigint;
  v_rol     text;
  v_admin   boolean;
  v_ref     text := coalesce(p_data->>'ref', '');
  v_pedido  jsonb;
  v_id      bigint;
  v_detalle jsonb;
begin
  select s.id_vendedor, s.rol into v_id_vend, v_rol
    from public.sesion_exige_seccion(p_data->>'token', 'pedidos') s;
  if v_id_vend is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  if v_ref = '' then
    return jsonb_build_object('ok', false, 'error', 'Falta la referencia del pedido');
  end if;

  v_admin := lower(trim(coalesce(v_rol,''))) in ('admin','administrador');

  select to_jsonb(o), o.id into v_pedido, v_id
    from public.ordenes o
   where (o.consecutivo = v_ref
          or (v_ref ~ '^[0-9]+$' and o.id = v_ref::bigint))
     and (v_admin or o.id_vendedor = v_id_vend)
   limit 1;

  if v_pedido is null then
    return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado');
  end if;

  select coalesce(jsonb_agg(to_jsonb(d) order by d.id), '[]'::jsonb)
    into v_detalle
    from public.ordenes_detalle d where d.id_orden = v_id;

  return jsonb_build_object('ok', true, 'pedido', v_pedido, 'detalle', v_detalle)
      || (select public.editable_pedido(o, 'vendedor') from public.ordenes o where o.id = v_id)
      || jsonb_build_object('puedeForzar', v_admin and (
           select (public.editable_pedido(o, 'admin')->>'editable')::boolean
              and not (public.editable_pedido(o, 'vendedor')->>'editable')::boolean
             from public.ordenes o where o.id = v_id))
      || jsonb_build_object('nivel', (
           select case
             when lower(coalesce(o.canal, '')) = 'mostrador' then 'mostrador'
             when lower(coalesce(o.canal, '')) = 'b2b' or coalesce(c.aprobado_b2b, false) then
               case c.tipo_id when 2 then 'restaurante' when 3 then 'tienda' when 4 then 'mayorista' else 'consumidor' end
             else 'consumidor' end
           from public.ordenes o left join public.clientes c on c.id = o.id_cliente and o.id_cliente <> 999999
           where o.id = v_id));
end;
$$;

