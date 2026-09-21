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
