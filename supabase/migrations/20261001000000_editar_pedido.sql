-- 20261001000000_editar_pedido.sql — Editar pedido (cantidad, quitar, agregar) con lote, cupón, caja y puntos.
-- Spec: cambios/2026-09-20-editar-pedido/diseno.md · Plan: cambios/2026-09-20-editar-pedido/plan.md
-- Re-ejecutable: create or replace / drop trigger if exists / add column if not exists.

-- ── T1. Columnas, kg_de_linea, triggers de lote en ordenes_detalle ───────────────────────────────
alter table public.ordenes add column if not exists editado_en timestamptz;
alter table public.ordenes add column if not exists editado_por text;

-- La fórmula de kilos de una línea, tal cual la usa fn_reconciliar_pedido (20260830203059:1486-1536).
-- Bebidas y presentaciones fuera de la lista dan 0; granel usa gramos_vendidos.
create or replace function public.kg_de_linea(
  p_tipo_venta text, p_presentacion text, p_cantidad numeric, p_gramos_vendidos numeric
) returns numeric
language sql immutable
set search_path = public, pg_temp
as $$
  select case
    when p_tipo_venta = 'A granel' then coalesce(p_gramos_vendidos, 0) / 1000.0
    else coalesce(p_cantidad, 0) * (case p_presentacion
      when '100g' then 100 when '250g' then 250 when '500g' then 500 when '1kg' then 1000 else 0 end) / 1000.0
  end
$$;
revoke all on function public.kg_de_linea(text, text, numeric, numeric) from public, anon, authenticated;

-- AFTER DELETE: si la línea ya había descontado, devuelve sus kg al mismo lote.
create or replace function public.trg_detalle_devolver_al_borrar() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(OLD.kg_descontado_lote, 0) > 0 and OLD.id_lote_descontado is not null then
    update public.lotes_produccion
       set kilos_vendidos = greatest(0, coalesce(kilos_vendidos, 0) - OLD.kg_descontado_lote)
     where id_lote = OLD.id_lote_descontado;
  end if;
  return OLD;
end $$;
drop trigger if exists trg_detalle_devolver_al_borrar on public.ordenes_detalle;
create trigger trg_detalle_devolver_al_borrar
  after delete on public.ordenes_detalle
  for each row execute function public.trg_detalle_devolver_al_borrar();

-- BEFORE UPDATE OF cantidad, gramos_vendidos: si la línea ya descontó, aplica la diferencia al mismo lote
-- y deja kg_descontado_lote en el valor nuevo. Una línea sin descuento (pedido Pendiente) no se toca:
-- fn_reconciliar_pedido la descontará al confirmar. Las escrituras de esa función a kg_descontado_lote
-- no disparan este trigger (no tocan cantidad ni gramos_vendidos).
create or replace function public.trg_detalle_ajustar_al_cambiar() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_nuevo numeric;
begin
  if coalesce(OLD.kg_descontado_lote, 0) <= 0 or OLD.id_lote_descontado is null then
    return NEW;
  end if;
  v_nuevo := public.kg_de_linea(NEW.tipo_venta, NEW.presentacion, NEW.cantidad, NEW.gramos_vendidos);
  if v_nuevo <> OLD.kg_descontado_lote then
    update public.lotes_produccion
       set kilos_vendidos = greatest(0, coalesce(kilos_vendidos, 0) + (v_nuevo - OLD.kg_descontado_lote))
     where id_lote = OLD.id_lote_descontado;
    NEW.kg_descontado_lote := v_nuevo;
  end if;
  return NEW;
end $$;
drop trigger if exists trg_detalle_ajustar_al_cambiar on public.ordenes_detalle;
create trigger trg_detalle_ajustar_al_cambiar
  before update of cantidad, gramos_vendidos on public.ordenes_detalle
  for each row execute function public.trg_detalle_ajustar_al_cambiar();

-- ── T2. cotizar_linea: el precio de una línea nueva, con la lógica de crear_pedido (20260930000008:163-250) ──
-- Solo papas por pieza o por caja. Bebidas y granel no se agregan en la edición (spec §2).
create or replace function public.cotizar_linea(p_id_producto bigint, p_nivel text, p_cantidad numeric, p_caja integer)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_p     productos%rowtype;
  v_base  numeric; v_pct numeric; v_pcaja numeric; v_unit numeric; v_sub numeric;
  v_caja  integer := case when p_caja in (3, 6, 12) then p_caja else 0 end;
  v_nivel text := lower(coalesce(p_nivel, 'consumidor'));
begin
  select * into v_p from productos where id = p_id_producto;
  if v_p.id is null or not coalesce(v_p.activo, true) or coalesce(v_p.descontinuado, false) then
    return jsonb_build_object('ok', false, 'error', 'producto_no_disponible');
  end if;
  if v_p.presentacion = 'Granel' or v_p.tipo_venta = 2 then
    return jsonb_build_object('ok', false, 'error', 'granel_no_soportado');
  end if;
  if p_cantidad is null or p_cantidad <= 0 or p_cantidad <> trunc(p_cantidad) then
    return jsonb_build_object('ok', false, 'error', 'cantidad_invalida');
  end if;
  v_base := case v_nivel
              when 'tienda'      then v_p.precio_tienda
              when 'restaurante' then v_p.precio_restaurante
              when 'mayorista'   then coalesce(nullif(v_p.precio_mayorista, 0), v_p.precio_tienda)
              when 'mostrador'   then v_p.precio_mostrador
              else v_p.precio_consumidor end;
  if v_base is null then
    return jsonb_build_object('ok', false, 'error', 'producto_no_disponible');
  end if;
  v_pct   := coalesce(v_p.descuento_pct, 0);
  v_pcaja := case v_caja when 3 then v_p.precio_caja_3 when 6 then v_p.precio_caja_6 when 12 then v_p.precio_caja_12 else null end;
  if coalesce(v_pcaja, 0) <= 0 then v_pcaja := null; end if;
  if v_nivel in ('tienda', 'mayorista') and v_pcaja is not null and v_caja > 0 and mod(p_cantidad, v_caja) = 0 then
    v_sub  := round(p_cantidad / v_caja * v_pcaja, 2);
    v_unit := round(v_pcaja / v_caja, 2);
  else
    v_unit := case when v_pct > 0 then round(v_base * (1 - v_pct / 100.0)) else v_base end;
    v_sub  := round(p_cantidad * v_unit, 2);
  end if;
  return jsonb_build_object(
    'ok', true, 'idProducto', v_p.id::text, 'sabor', v_p.sabor, 'presentacion', v_p.presentacion,
    'tipoVenta', 'Por Pieza', 'cantidad', p_cantidad, 'gramos', 0,
    'precioUnitario', v_unit, 'subtotal', v_sub,
    'descuento', greatest(0, round(p_cantidad * v_base, 2) - v_sub),
    'piezasPorCaja', case when v_nivel in ('tienda', 'mayorista') and v_caja > 0 then v_caja else null end);
end $$;
revoke all on function public.cotizar_linea(bigint, text, numeric, integer) from public, anon, authenticated;

-- ── T3. editable_pedido, descuento_cupon_para, editar_pedido_interno, puertas ───────────────────
-- Una tabla, la misma para servidor y pantallas (spec §2).
create or replace function public.editable_pedido(o public.ordenes, p_quien text) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare v_m text := '';
begin
  if o.estatus_pedido = 'Cancelado' then v_m := 'cancelado';
  elsif o.estatus_pedido = 'Entregado' and not (coalesce(o.tipo_interno, '') <> '' and p_quien = 'vendedor') then v_m := 'entregado';
  elsif lower(coalesce(o.estado_pago, '')) = 'pagado' or coalesce(o.stripe_payment_intent, '') <> '' then v_m := 'pagado_en_linea';
  elsif coalesce(o.stripe_session_id, '') <> '' and lower(coalesce(o.estado_pago, '')) = 'pendiente' then v_m := 'pago_en_linea_pendiente';
  elsif o.estatus_pedido = 'En camino' then v_m := 'en_camino';
  elsif o.armado_en is not null then v_m := 'ya_armado';
  end if;
  return jsonb_build_object(
    'editable', v_m = '' or (p_quien = 'vendedor' and v_m in ('en_camino', 'ya_armado')),
    'motivo', v_m);
end $$;
revoke all on function public.editable_pedido(public.ordenes, text) from public, anon, authenticated;

-- El descuento de un cupón para un subtotal dado, sin validar_cupon (que rechaza por un_uso_por_usuario el
-- cupón de este mismo pedido). Mismas reglas de valor que crear_pedido (20260930000008:296-307).
create or replace function public.descuento_cupon_para(p_codigo text, p_subtotal numeric) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare c cupones%rowtype;
begin
  if coalesce(p_codigo, '') = '' then return jsonb_build_object('descuento', 0, 'envio_gratis', false, 'retirado', false); end if;
  select * into c from cupones where codigo = upper(p_codigo) limit 1;
  if c.id is null or not coalesce(c.activo, true) or coalesce(c.compra_minima, 0) > p_subtotal then
    return jsonb_build_object('descuento', 0, 'envio_gratis', false, 'retirado', true);
  end if;
  return jsonb_build_object(
    'descuento', case c.tipo when 'descuento_pct' then round(p_subtotal * coalesce(c.valor, 0) / 100.0, 2)
                             when 'descuento_fijo' then least(coalesce(c.valor, 0), p_subtotal) else 0 end,
    'envio_gratis', c.tipo = 'envio_gratis', 'retirado', false);
end $$;
revoke all on function public.descuento_cupon_para(text, numeric) from public, anon, authenticated;

create or replace function public.editar_pedido_interno(p_id_orden bigint, p_lineas jsonb, p_actor text, p_modo text, p_quien text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o        ordenes%rowtype;
  v_cli    clientes%rowtype;
  d        ordenes_detalle%rowtype;
  v_ed     jsonb; v_in jsonb; v_cot jsonb; v_cup jsonb; v_l jsonb;
  v_nivel  text; v_interno boolean; v_id bigint;
  v_ids    bigint[] := '{}';
  v_fin    jsonb := '[]'::jsonb;     -- líneas finales: {accion: igual|cambiar|nueva|quitar, ...}
  v_avisos jsonb := '[]'::jsonb;
  v_sub    numeric := 0; v_desc numeric := 0; v_desc_envio numeric := 0; v_total numeric;
  v_compradas integer := 0; v_tiene_canje boolean := false;
  v_cant   numeric; v_cajas integer; v_caja integer; v_gramos numeric; v_subl numeric; v_descl numeric; v_factor numeric;
  v_res    jsonb;
begin
  if p_modo not in ('cotizar', 'aplicar') then
    return jsonb_build_object('ok', false, 'error', 'modo_invalido');
  end if;
  if p_lineas is null or jsonb_typeof(p_lineas) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'lineas_invalidas');
  end if;

  -- 1. Bloqueo del pedido: dos ediciones se serializan.
  select * into o from ordenes where id = p_id_orden for update;
  if o.id is null then return jsonb_build_object('ok', false, 'error', 'no_encontrado'); end if;
  v_ed := public.editable_pedido(o, p_quien);
  if not (v_ed->>'editable')::boolean then
    return jsonb_build_object('ok', false, 'error', 'no_editable', 'motivo', v_ed->>'motivo');
  end if;
  if (v_ed->>'motivo') <> '' then v_avisos := v_avisos || to_jsonb(v_ed->>'motivo'); end if;
  v_interno := coalesce(o.tipo_interno, '') <> '';
  if o.id_cliente is not null and coalesce(o.puntos_canjeados, 0) > 0 then
    perform pg_advisory_xact_lock(hashtext('canje:' || o.id_cliente));
  end if;

  -- Nivel de precio del pedido (para líneas nuevas): mostrador por canal; B2B por tipo del cliente.
  if o.id_cliente is not null and o.id_cliente <> 999999 then
    select * into v_cli from clientes where id = o.id_cliente;
  end if;
  v_nivel := case
    when lower(coalesce(o.canal, '')) = 'mostrador' then 'mostrador'
    when lower(coalesce(o.canal, '')) = 'b2b' or coalesce(v_cli.aprobado_b2b, false) then
      case v_cli.tipo_id when 2 then 'restaurante' when 3 then 'tienda' when 4 then 'mayorista' else 'consumidor' end
    else 'consumidor' end;

  -- 2. Validar y calcular, sin escribir.
  for v_in in select * from jsonb_array_elements(p_lineas) loop
    if coalesce(v_in->>'id', '') <> '' then
      if (v_in->>'id') !~ '^[0-9]+$' then return jsonb_build_object('ok', false, 'error', 'linea_ajena'); end if;
      v_id := (v_in->>'id')::bigint;
      if v_id = any(v_ids) then return jsonb_build_object('ok', false, 'error', 'linea_repetida'); end if;
      select * into d from ordenes_detalle where id = v_id and id_orden = o.id;
      if d.id is null then return jsonb_build_object('ok', false, 'error', 'linea_ajena'); end if;
      v_ids := v_ids || v_id;

      if coalesce(d.puntos_canje, 0) > 0 then
        -- Canje: tiene que venir intacto.
        if (v_in ? 'cantidad' and (v_in->>'cantidad')::numeric <> d.cantidad) or v_in ? 'cajas' or v_in ? 'gramos' then
          return jsonb_build_object('ok', false, 'error', 'canje_bloqueado');
        end if;
        v_tiene_canje := true;
        v_fin := v_fin || jsonb_build_object('accion', 'igual', 'id', d.id, 'sabor', d.sabor, 'presentacion', d.presentacion,
                   'cantidad', d.cantidad, 'gramos', d.gramos_vendidos, 'subtotal', d.subtotal, 'descuento', d.descuento, 'canje', true);
        continue;
      end if;

      if d.tipo_venta = 'A granel' then
        v_gramos := coalesce(nullif(v_in->>'gramos', '')::numeric, d.gramos_vendidos);
        if v_gramos < 100 or v_gramos <> trunc(v_gramos) or v_gramos > 50000 then return jsonb_build_object('ok', false, 'error', 'cantidad_invalida'); end if;
        v_factor := case when coalesce(d.gramos_vendidos, 0) > 0 then v_gramos / d.gramos_vendidos else 0 end;
        v_cant := d.cantidad;
      elsif coalesce(d.piezas_por_caja, 0) > 0 then
        v_cajas := coalesce(nullif(v_in->>'cajas', '')::integer, (d.cantidad / d.piezas_por_caja)::integer);
        if v_cajas < 1 or v_cajas > 100 then return jsonb_build_object('ok', false, 'error', 'cantidad_invalida'); end if;
        v_cant := v_cajas * d.piezas_por_caja; v_gramos := d.gramos_vendidos;
        v_factor := case when d.cantidad > 0 then v_cant / d.cantidad else 0 end;
      else
        v_cant := coalesce(nullif(v_in->>'cantidad', '')::numeric, d.cantidad);
        if v_cant < 1 or v_cant <> trunc(v_cant) or v_cant > 1000 then return jsonb_build_object('ok', false, 'error', 'cantidad_invalida'); end if;
        v_gramos := d.gramos_vendidos;
        v_factor := case when d.cantidad > 0 then v_cant / d.cantidad else 0 end;
      end if;
      -- Precio pactado, proporcional (desviación 2 del plan).
      v_subl  := round(coalesce(d.subtotal, 0) * v_factor, 2);
      v_descl := round(coalesce(d.descuento, 0) * v_factor, 2);
      v_fin := v_fin || jsonb_build_object(
        'accion', case when v_cant = d.cantidad and coalesce(v_gramos, 0) = coalesce(d.gramos_vendidos, 0) then 'igual' else 'cambiar' end,
        'id', d.id, 'sabor', d.sabor, 'presentacion', d.presentacion, 'cantidad', v_cant, 'gramos', v_gramos,
        'subtotal', v_subl, 'descuento', v_descl, 'piezasPorCaja', d.piezas_por_caja, 'canje', false);
      v_compradas := v_compradas + 1;
    else
      -- Línea nueva: solo papas por pieza o por caja.
      if coalesce(v_in->>'idProducto', '') !~ '^[0-9]+$' then
        return jsonb_build_object('ok', false, 'error', 'producto_no_disponible');
      end if;
      v_caja  := case when (v_in->>'caja') in ('3', '6', '12') then (v_in->>'caja')::integer else 0 end;
      v_cajas := case when (v_in->>'cajas') ~ '^[0-9]+$' then (v_in->>'cajas')::integer else 0 end;
      v_cant  := case when v_caja > 0 then v_cajas * v_caja else coalesce(nullif(v_in->>'cantidad', '')::numeric, 0) end;
      if (v_caja > 0 and v_cajas > 100) or v_cant > 1000 then
        return jsonb_build_object('ok', false, 'error', 'cantidad_invalida');
      end if;
      v_cot := public.cotizar_linea((v_in->>'idProducto')::bigint, v_nivel, v_cant, v_caja);
      if not coalesce((v_cot->>'ok')::boolean, false) then
        return jsonb_build_object('ok', false, 'error', v_cot->>'error');
      end if;
      v_fin := v_fin || (v_cot - 'ok' || jsonb_build_object('accion', 'nueva', 'canje', false,
                 'subtotal', case when v_interno then 0 else (v_cot->>'subtotal')::numeric end,
                 'descuento', case when v_interno then 0 else (v_cot->>'descuento')::numeric end));
      v_compradas := v_compradas + 1;
    end if;
  end loop;

  -- Lo que no vino, se quita (canje omitido = bloqueado).
  for d in select * from ordenes_detalle where id_orden = o.id and not (id = any(v_ids)) order by id loop
    if coalesce(d.puntos_canje, 0) > 0 then return jsonb_build_object('ok', false, 'error', 'canje_bloqueado'); end if;
    v_fin := v_fin || jsonb_build_object('accion', 'quitar', 'id', d.id, 'sabor', d.sabor, 'presentacion', d.presentacion, 'cantidad', d.cantidad, 'subtotal', d.subtotal, 'canje', false);
  end loop;

  if v_compradas = 0 then return jsonb_build_object('ok', false, 'error', 'pedido_vacio'); end if;

  -- 3. Totales.
  select coalesce(sum((l->>'subtotal')::numeric), 0) into v_sub
    from jsonb_array_elements(v_fin) l where l->>'accion' <> 'quitar' and not (l->>'canje')::boolean;
  if v_interno then
    v_sub := 0; v_desc := 0; v_desc_envio := 0; v_total := 0;
  else
    v_cup := public.descuento_cupon_para(o.cupon_codigo, v_sub);
    v_desc := (v_cup->>'descuento')::numeric;
    if (v_cup->>'envio_gratis')::boolean then v_desc_envio := coalesce(o.envio, 0); end if;
    if (v_cup->>'retirado')::boolean and coalesce(o.descuento, 0) > 0 then v_avisos := v_avisos || to_jsonb('cupon_retirado'::text); end if;
    v_total := greatest(0, v_sub - v_desc + coalesce(o.envio, 0) - v_desc_envio);
  end if;

  v_res := jsonb_build_object('subtotal', v_sub, 'descuento', v_desc, 'envio', coalesce(o.envio, 0), 'descuento_envio', v_desc_envio,
             'total', v_total, 'total_anterior', o.total, 'lineas', v_fin);
  if p_modo = 'cotizar' then
    return jsonb_build_object('ok', true, 'cotizacion', v_res, 'avisos', v_avisos);
  end if;

  -- 4. Aplicar líneas (los triggers de T1 mueven los kg; el INSERT dispara fn_reconciliar_pedido).
  begin
    for v_l in select * from jsonb_array_elements(v_fin) loop
      case v_l->>'accion'
        when 'quitar' then
          delete from ordenes_detalle where id = (v_l->>'id')::bigint;
        when 'cambiar' then
          update ordenes_detalle
             set cantidad = (v_l->>'cantidad')::numeric,
                 gramos_vendidos = nullif(v_l->>'gramos', '')::numeric,
                 subtotal = (v_l->>'subtotal')::numeric,
                 descuento = (v_l->>'descuento')::numeric
           where id = (v_l->>'id')::bigint;
        when 'nueva' then
          insert into ordenes_detalle (id_orden, consecutivo_orden, id_producto, sabor, presentacion, tipo_venta,
                                       cantidad, gramos_vendidos, precio_unitario, descuento, subtotal, precio_kg,
                                       piezas_por_caja, puntos_canje, fecha)
          values (o.id, o.consecutivo, v_l->>'idProducto', v_l->>'sabor', v_l->>'presentacion', 'Por Pieza',
                  (v_l->>'cantidad')::numeric, 0, (v_l->>'precioUnitario')::numeric, (v_l->>'descuento')::numeric,
                  (v_l->>'subtotal')::numeric, 0, nullif(v_l->>'piezasPorCaja', '')::integer, 0, now());
        else null;
      end case;
    end loop;
  exception when others then
    -- Solo el candado del lote se traduce; cualquier otro error sube tal cual (regla 21).
    if sqlerrm like '%No hay LOTE ACTIVO%' then
      raise exception using errcode = 'P0001', message = 'sin_lote';
    end if;
    raise;
  end;

  -- 5. Cabecera.
  update ordenes
     set subtotal = v_sub, descuento = v_desc, descuento_envio = v_desc_envio, total = v_total,
         editado_en = now(), editado_por = p_actor, actualizado_por = p_actor
   where id = o.id;

  -- 6. Compensaciones y armado: T4.
  v_res := public.editar_pedido_compensar(o, v_total, p_actor, p_quien);
  v_avisos := v_avisos || coalesce(v_res->'avisos', '[]'::jsonb);

  select * into o from ordenes where id = o.id;
  return jsonb_build_object(
    'ok', true,
    'pedido', jsonb_build_object('id', o.id, 'consecutivo', o.consecutivo, 'subtotal', o.subtotal, 'descuento', o.descuento,
                'envio', o.envio, 'descuento_envio', o.descuento_envio, 'total', o.total, 'estatus_pedido', o.estatus_pedido,
                'estatus_pago', o.estatus_pago, 'armado_en', o.armado_en, 'editado_en', o.editado_en, 'editado_por', o.editado_por),
    'lineas', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) from ordenes_detalle x where x.id_orden = o.id),
    'avisos', v_avisos, 'caja', v_res->'caja', 'puntos', v_res->'puntos');
end $$;
revoke all on function public.editar_pedido_interno(bigint, jsonb, text, text, text) from public, anon, authenticated;

-- T3: sin compensaciones todavía. T4 la reemplaza.
create or replace function public.editar_pedido_compensar(o public.ordenes, p_total_nuevo numeric, p_actor text, p_quien text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return jsonb_build_object('avisos', '[]'::jsonb, 'caja', null, 'puntos', null);
end $$;
revoke all on function public.editar_pedido_compensar(public.ordenes, numeric, text, text) from public, anon, authenticated;

-- Puerta del vendedor: sección `pedidos`; dueño cualquier pedido, vendedor los suyos.
create or replace function public.editar_pedido(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id_vend bigint; v_rol text; v_id bigint; v_ref text := coalesce(p_data->>'idOrden', p_data->>'consecutivo', '');
  o ordenes%rowtype; v_dueno boolean;
begin
  select s.id_vendedor, s.rol into v_id_vend, v_rol from public.sesion_exige_seccion(p_data->>'token', 'pedidos') s;
  if v_id_vend is null then return jsonb_build_object('ok', false, 'error', 'no_autorizado'); end if;
  select * into o from ordenes where consecutivo = v_ref or (v_ref ~ '^[0-9]+$' and id = v_ref::bigint) limit 1;
  if o.id is null then return jsonb_build_object('ok', false, 'error', 'no_encontrado'); end if;
  v_dueno := lower(trim(coalesce(v_rol, ''))) in ('admin', 'administrador');
  if not v_dueno and o.id_vendedor is distinct from v_id_vend then
    return jsonb_build_object('ok', false, 'error', 'no_editable', 'motivo', 'no_es_tu_pedido');
  end if;
  begin
    return public.editar_pedido_interno(o.id, p_data->'lineas', coalesce(nullif(p_data->>'actualizadoPor', ''), 'vendedor'),
                                        coalesce(p_data->>'modo', 'aplicar'), 'vendedor');
  exception when others then
    if sqlerrm = 'sin_lote' then return jsonb_build_object('ok', false, 'error', 'sin_lote', 'mensaje', 'No hay lote activo: registra el lote de producción antes de agregar líneas a un pedido confirmado.'); end if;
    if sqlerrm = 'caja_cerrada' then return jsonb_build_object('ok', false, 'error', 'caja_cerrada', 'mensaje', 'Este pedido ya está en caja y la caja del día está cerrada: ábrela para editarlo.'); end if;
    raise;
  end;
end $$;
grant execute on function public.editar_pedido(jsonb) to anon, authenticated;

-- Puerta del cliente: su pedido, y solo mientras nadie lo ha armado (editable_pedido con 'cliente').
create or replace function public.editar_mi_pedido(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tel text; v_id_cli bigint; v_ref text := coalesce(p_data->>'idOrden', p_data->>'consecutivo', ''); o ordenes%rowtype;
begin
  v_tel := public.resolver_sesion_cliente(p_data->>'token');
  if v_tel is null then return jsonb_build_object('ok', false, 'error', 'Sesión inválida o expirada'); end if;
  select c.id into v_id_cli from clientes c where c.telefono = v_tel order by c.id limit 1;
  select * into o from ordenes where (consecutivo = v_ref or (v_ref ~ '^[0-9]+$' and id = v_ref::bigint)) and id_cliente = v_id_cli limit 1;
  if o.id is null then return jsonb_build_object('ok', false, 'error', 'no_encontrado'); end if;
  begin
    return public.editar_pedido_interno(o.id, p_data->'lineas', 'cliente', coalesce(p_data->>'modo', 'aplicar'), 'cliente');
  exception when others then
    if sqlerrm = 'sin_lote' then return jsonb_build_object('ok', false, 'error', 'sin_lote', 'mensaje', 'Ahora mismo no podemos cambiar tu pedido; escríbenos por WhatsApp.'); end if;
    if sqlerrm = 'caja_cerrada' then return jsonb_build_object('ok', false, 'error', 'caja_cerrada', 'mensaje', 'Ahora mismo no podemos cambiar tu pedido; escríbenos por WhatsApp.'); end if;
    raise;
  end;
end $$;
grant execute on function public.editar_mi_pedido(jsonb) to anon, authenticated;

-- ── T4. Compensaciones (caja, puntos), desarmado y editadoEn en la cola ─────────────────────────
create or replace function public.editar_pedido_compensar(o public.ordenes, p_total_nuevo numeric, p_actor text, p_quien text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_avisos jsonb := '[]'::jsonb; v_caja jsonb := null; v_pts jsonb := null;
  v_orig  caja_movimientos%rowtype; v_dif numeric; v_codigo text; v_id_punto bigint; v_id_caja bigint; v_id_mov bigint;
  v_cfg jsonb; v_rate numeric; v_base text; v_neto numeric; v_desc numeric; v_obj integer; v_hay integer; v_dpts integer; v_id_led bigint;
begin
  -- Vendedor edita un pedido ya armado: vuelve a «Por armar». Corre para CUALQUIER pedido, incluidos los
  -- internos (fix 1, ronda 1 de revisión: antes el early-return de interno lo dejaba fuera).
  if p_quien = 'vendedor' and o.armado_en is not null then
    update ordenes set armado_en = null, armado_por = null where id = o.id;
  end if;

  if coalesce(o.tipo_interno, '') <> '' then
    return jsonb_build_object('avisos', v_avisos, 'caja', null, 'puntos', null);
  end if;

  -- Caja: si ya hay venta asentada y el total cambió, asiento del MISMO tipo por la diferencia, emparejado.
  -- El trigger trg_caja_confirmar_pedido (AFTER INSERT OR UPDATE OF estatus_caja) compara con `<>` contra
  -- NULL en su guarda (`IF NEW.estatus_caja <> 'confirmado' THEN RETURN NEW`), que en plpgsql da falso, no
  -- verdadero: por eso YA existe una fila «venta_%» desde el INSERT de CUALQUIER pedido en efectivo o
  -- transferencia, aunque nunca se haya pagado ni confirmado (o.estatus_caja sigue null). Fuera de alcance
  -- de T4 tocar ese trigger (regla del brief). Regla del controlador (fix 3, ronda 1 de revisión):
  --   (a) o.estatus_caja = 'confirmado' + fila real + total cambió + caja del día abierta → compensar.
  --       Sin caja del día abierta → 'caja_cerrada' (deshace todo editar_pedido, como antes).
  --   (b) fila fantasma (o.estatus_caja distinto de 'confirmado') + total cambió: si hay caja del día
  --       abierta para ese punto, se compensa igual (mismo asiento pareado, misma inserción que (a)); si
  --       no la hay, NO se falla: se omite y se avisa 'caja_sin_ajuste'.
  --   (c) sin fila «venta_%» → nada.
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

  -- Puntos: si el pedido ya generó, ajuste por la diferencia contra el neto nuevo — solo si la generación
  -- sigue activa (fix 2, ronda 1 de revisión: espejo de otorgar_puntos_al_confirmar,
  -- 20260930000009_retos.sql:175-179); luego evaluar_retos siempre, esté activa o no.
  if o.id_cliente is not null and o.id_cliente <> 999999
     and exists (select 1 from lealtad_movimientos where id_orden = o.id and tipo = 'generacion') then
    select valor into v_cfg from config_produccion where clave = 'lealtad';
    if v_cfg is null or coalesce((v_cfg->'generacion'->>'activo')::boolean, false) = false then
      perform public.evaluar_retos(o.id_cliente);
    else
      v_rate := coalesce((v_cfg->'generacion'->>'puntos_por_peso')::numeric, 0);
      v_base := coalesce(v_cfg->'generacion'->>'base', 'total');
      select subtotal, descuento into v_neto, v_desc from ordenes where id = o.id;   -- ya actualizados en el paso 5
      v_neto := case v_base when 'neto' then greatest(0, coalesce(v_neto, 0) - coalesce(v_desc, 0))
                            when 'subtotal' then coalesce(v_neto, 0) else p_total_nuevo end;
      v_obj := floor(v_neto * v_rate)::integer;
      select coalesce(sum(puntos), 0)::integer into v_hay from lealtad_movimientos
       where id_orden = o.id and tipo in ('generacion', 'reversion', 'ajuste');
      v_dpts := v_obj - v_hay;
      if v_dpts <> 0 then
        v_id_led := agregar_movimiento_lealtad(o.id_cliente, 'ajuste', v_dpts, o.id, o.consecutivo, null, null, v_neto,
                      'Ajuste por edición de ' || o.consecutivo, coalesce(p_actor, 'sistema'));
        v_pts := jsonb_build_object('id', v_id_led, 'puntos', v_dpts);
      end if;
      perform public.evaluar_retos(o.id_cliente);
    end if;
  end if;

  return jsonb_build_object('avisos', v_avisos, 'caja', v_caja, 'puntos', v_pts);
end $$;
revoke all on function public.editar_pedido_compensar(public.ordenes, numeric, text, text) from public, anon, authenticated;

-- cola_armado (copiada entera de 20260923000000_rutas.sql:254-359, con 'editadoEn'/'editadoPor' añadidos
-- al jsonb_build_object de cada pedido, junto a 'armadoEn'/'armadoPor').
create or replace function public.cola_armado(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
declare
  v_id bigint; v_rol text;
  v_fecha date;
  v_desde timestamptz;
  v_cfg jsonb;
  v_nuevos jsonb; v_resumen jsonb; v_pedidos jsonb; v_porconf jsonb; v_tot jsonb;
begin
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.sesion_exige_seccion(p_data->>'token', 'armado') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  v_cfg   := public.get_hora_limite_config();
  v_fecha := coalesce(nullif(p_data->>'fecha', '')::date,
                      (now() at time zone 'America/Mexico_City')::date + 1);
  v_desde := coalesce(nullif(p_data->>'desde', '')::timestamptz, now() - interval '24 hours');

  select coalesce(jsonb_agg(r.fila order by r.fila->>'sabor', r.fila->>'presentacion'), '[]'::jsonb)
    into v_resumen
    from (
      select jsonb_build_object(
               'sabor', l.sabor, 'presentacion', l.presentacion,
               'piezas', sum(l.piezas), 'kg', round(sum(l.kg)::numeric, 3),
               'cajas', (select coalesce(jsonb_agg(jsonb_build_object('piezasPorCaja', c.ppc, 'cajas', c.n)), '[]'::jsonb)
                           from (select l2.piezas_por_caja as ppc, sum(l2.cantidad / l2.piezas_por_caja) as n
                                   from public.lineas_armado_interno(v_fecha) l2
                                  where l2.sabor = l.sabor and l2.presentacion = l.presentacion
                                    and coalesce(l2.piezas_por_caja, 0) > 0
                                  group by l2.piezas_por_caja) c)
             ) as fila
        from public.lineas_armado_interno(v_fecha) l
       group by l.sabor, l.presentacion
    ) r;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'consecutivo', o.consecutivo, 'cliente', o.nombre_cliente,
           'negocio', c.nombre_comercial, 'canal', o.canal, 'idVendedor', o.id_vendedor,
           'vendedor', o.nombre_vendedor, 'tipoInterno', coalesce(o.tipo_interno, ''),
           'total', o.total, 'fechaOrden', o.fecha_orden,
           'armadoEn', o.armado_en, 'armadoPor', o.armado_por, 'editadoEn', o.editado_en, 'editadoPor', o.editado_por,
           'idRuta', o.id_ruta, 'ruta', ru.nombre, 'rutaColor', ru.color, 'rutaOrden', ru.orden,
           'lineas', (select coalesce(jsonb_agg(jsonb_build_object(
                        'sabor', l.sabor, 'presentacion', l.presentacion, 'tipoVenta', l.tipo_venta,
                        'cantidad', l.cantidad, 'piezasPorCaja', l.piezas_por_caja,
                        'gramos', l.gramos_vendidos, 'kg', round(l.kg::numeric, 3)) order by l.sabor), '[]'::jsonb)
                        from public.lineas_armado_interno(v_fecha) l where l.id_orden = o.id)
         ) order by o.armado_en nulls first, ru.orden nulls last, o.fecha_orden), '[]'::jsonb)
    into v_pedidos
    from public.ordenes o
    left join public.clientes c on c.id = o.id_cliente
    left join public.rutas ru on ru.id = o.id_ruta
   where o.fecha_entrega::date = v_fecha
     and o.estatus_pedido = 'En proceso';

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'consecutivo', o.consecutivo, 'cliente', o.nombre_cliente,
           'negocio', c.nombre_comercial, 'canal', o.canal, 'total', o.total, 'fechaOrden', o.fecha_orden,
           'idRuta', o.id_ruta, 'ruta', ru.nombre, 'rutaColor', ru.color, 'rutaOrden', ru.orden
         ) order by o.fecha_orden), '[]'::jsonb)
    into v_porconf
    from public.ordenes o
    left join public.clientes c on c.id = o.id_cliente
    left join public.rutas ru on ru.id = o.id_ruta
   where o.fecha_entrega::date = v_fecha
     and o.estatus_pedido = 'Pendiente';

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'consecutivo', o.consecutivo, 'fechaOrden', o.fecha_orden,
           'cliente', o.nombre_cliente, 'negocio', c.nombre_comercial, 'canal', o.canal,
           'total', o.total, 'estatus', o.estatus_pedido, 'fechaEntrega', o.fecha_entrega::date,
           'idRuta', o.id_ruta, 'ruta', ru.nombre, 'rutaColor', ru.color, 'rutaOrden', ru.orden,
           'lineasResumen', (select string_agg(trim_scale(d.cantidad)::text || ' × ' || d.sabor || ' ' || d.presentacion, ' · ')
                               from public.ordenes_detalle d where d.id_orden = o.id)
         ) order by o.fecha_orden desc), '[]'::jsonb)
    into v_nuevos
    from (select * from public.ordenes o2
           where o2.fecha_orden > v_desde and o2.estatus_pedido <> 'Cancelado'
           order by o2.fecha_orden desc limit 50) o
    left join public.clientes c on c.id = o.id_cliente
    left join public.rutas ru on ru.id = o.id_ruta;

  select jsonb_build_object(
           'pedidos', count(distinct o.id),
           'armados', count(distinct o.id) filter (where o.armado_en is not null),
           'kg', round(coalesce(sum(l.kg), 0)::numeric, 3),
           'piezas', coalesce(sum(l.piezas), 0))
    into v_tot
    from public.ordenes o
    left join public.lineas_armado_interno(v_fecha) l on l.id_orden = o.id
   where o.fecha_entrega::date = v_fecha
     and o.estatus_pedido = 'En proceso';

  return jsonb_build_object(
    'ok', true, 'fecha', to_char(v_fecha, 'YYYY-MM-DD'), 'horaLimite', v_cfg->>'hora',
    'nuevos', v_nuevos, 'resumen', v_resumen, 'pedidos', v_pedidos,
    'porConfirmar', v_porconf, 'totales', v_tot);
end;
$fn$;
revoke all on function public.cola_armado(jsonb) from public;
grant execute on function public.cola_armado(jsonb) to anon, authenticated;
