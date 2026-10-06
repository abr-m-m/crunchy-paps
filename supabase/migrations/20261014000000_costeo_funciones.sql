-- 20261014000000_costeo_funciones.sql
-- costo_base_kg y costo_sku (cambios/2026-09-23-costeo-y-margen/diseno.md §2).
--
-- LA TRAMPA, y la razón de que estas funciones sean plpgsql y no un select de una línea:
-- `sum()` de Postgres IGNORA los NULL en silencio. Una receta a la que le falte el costo de un
-- insumo devolvería la suma de los demás —un número MENOR que el real, con cara de bueno— en vez
-- de admitir que no se puede costear. En la receta de prueba son 8 pesos por kg de diferencia.
-- Por eso los faltantes se cuentan aparte con `count(*) filter (where ... is null)` y cualquier
-- hueco tumba el resultado entero a NULL (D12). Un 0 aquí se leería como margen del 100 %.
--
-- El navegador no decide dinero (regla 10): todo el cálculo vive aquí.

-- ── El costo de 1 kg de base a precios vigentes en una fecha ─────────────────
create or replace function public.costo_base_kg(p_fecha date)
returns numeric
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_receta bigint;
  v_rinde  numeric;
  v_suma   numeric;
  v_faltan integer;
begin
  -- La receta vigente es la más reciente que no sea del futuro. Cambiar una receta no reescribe
  -- el pasado: por eso se busca por `vigente_desde <= p_fecha` y no por `activa` a secas.
  select r.id, r.rinde_cantidad into v_receta, v_rinde
    from public.recetas r
   where r.tipo = 'base' and r.activa and r.vigente_desde <= p_fecha
   order by r.vigente_desde desc
   limit 1;
  if v_receta is null then
    return null;                              -- sin receta vigente: sin costear, no gratis
  end if;

  select sum(l.cantidad * public.costo_insumo(l.id_insumo, p_fecha)),
         count(*) filter (where public.costo_insumo(l.id_insumo, p_fecha) is null)
    into v_suma, v_faltan
    from public.receta_lineas l
   where l.id_receta = v_receta;

  -- v_faltan > 0: a algún insumo le falta costo en esa fecha.
  -- v_suma is null: la receta no tiene ni una línea. Las dos son «no se puede costear».
  if v_faltan > 0 or v_suma is null then
    return null;
  end if;
  return round(v_suma / v_rinde, 4);
end $$;

-- ── El costo de UNA pieza de un SKU ─────────────────────────────────────────
-- Dos niveles, como se produce: los kg de base que lleva más su propio empaque y sazonador.
create or replace function public.costo_sku(p_id_producto bigint, p_fecha date)
returns numeric
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_receta bigint;
  v_kgbase numeric;
  v_base   numeric;
  v_suma   numeric;
  v_faltan integer;
begin
  select r.id, r.kg_base into v_receta, v_kgbase
    from public.recetas r
   where r.tipo = 'sku' and r.id_producto = p_id_producto
     and r.activa and r.vigente_desde <= p_fecha
   order by r.vigente_desde desc
   limit 1;
  if v_receta is null then
    return null;
  end if;

  v_base := public.costo_base_kg(p_fecha);
  if v_base is null then
    return null;                              -- si la base no se pudo costear, el SKU tampoco
  end if;

  -- coalesce a 0 aquí SÍ es correcto: un SKU puede no llevar ninguna línea propia (granel sin
  -- bolsa, por ejemplo) y eso no es un hueco. El hueco lo detecta v_faltan.
  select coalesce(sum(l.cantidad * public.costo_insumo(l.id_insumo, p_fecha)), 0),
         count(*) filter (where public.costo_insumo(l.id_insumo, p_fecha) is null)
    into v_suma, v_faltan
    from public.receta_lineas l
   where l.id_receta = v_receta;

  if v_faltan > 0 then
    return null;
  end if;
  return round(v_kgbase * v_base + v_suma, 4);
end $$;

-- Regla 42: EXECUTE se concede a PUBLIC por defecto. No se dan a `anon`: solo las llaman otras
-- funciones del servidor y los RPC del panel (tareas 3 y 4).
revoke all on function public.costo_base_kg(date) from public;
revoke all on function public.costo_sku(bigint, date) from public;
