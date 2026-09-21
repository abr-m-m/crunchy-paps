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
