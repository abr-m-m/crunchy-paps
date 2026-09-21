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
