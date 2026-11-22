-- ============================================================================
--  LAS TRES PREGUNTAS DEL FRENTE A, contestables sin abrir SQL
--
--  Diseno: cambios/2026-11-21-frente-a-costos.md
--
--  Hasta hoy el costeo vivia entero en la base: funciones, recetas y 183
--  lineas costeadas que NADIE en Crunchy podia ver. Un dato que solo se lee
--  con `supabase db query` no esta en la empresa, esta en mi sesion.
--
--  Estas tres funciones contestan las tres preguntas del frente, en el orden
--  en que se hacen de verdad:
--
--    1. costos_resumen      -> ¿que cuesta una bolsa, y de que esta hecho?
--    2. margen_resumen      -> ¿que dejo cada canal, de verdad, ya vendido?
--    3. punto_equilibrio    -> ¿que tiene que pasar para ganar?
--
--  LAS TRES LEEN LA RECETA REAL. Ninguna copia la formula del costeo: piden
--  las lineas de `recetas` y los precios de `insumos_costos` y operan sobre
--  ellas. Una herramienta que copia la logica que mide no mide, repite
--  (regla 63) -y lo repetido se queda quieto el dia que la receta cambia-.
--
--  AUTORIZACION: las tres son del DUENO. Patron de `retos_admin`: el token
--  viaja en `p_data`, se resuelve con `sesion_es_dueno` -que relee el rol de
--  la tabla, no del token- y el EXECUTE se concede a anon/authenticated
--  porque la decision la toma el servidor, no el navegador (reglas 35 y 36).
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

-- ── Un margen se calcula en UN sitio ───────────────────────────────────────
-- Escrito en cinco sitios, un dia cuatro cambian y el quinto miente. Va
-- ARRIBA de quien lo usa a proposito: PL/pgSQL no comprueba al crear que la
-- funcion que llamas exista (regla 22), asi que el orden del archivo es la
-- unica garantia de que no se aplique algo que revienta en el primer uso.
create or replace function public.pct_margen(p_costo numeric, p_precio numeric)
returns numeric language sql immutable set search_path = pg_temp as $$
  select case when p_precio is null or p_precio = 0 or p_costo is null then null
              else round((1 - p_costo / p_precio) * 100, 1) end;
$$;

revoke all on function public.pct_margen(numeric, numeric) from public;
grant execute on function public.pct_margen(numeric, numeric) to anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
--  1. ¿QUE CUESTA UNA BOLSA, Y DE QUE ESTA HECHO?
-- ════════════════════════════════════════════════════════════════════════════
-- Devuelve el desglose de la base por kilo, el costo completo de cada
-- presentacion con su margen por canal, y -esto es lo que la hace util- los
-- AVISOS: que parte del costo es un techo declarado y no una medida. Un costo
-- que no dice de que esta hecho se usa como si fuera exacto.
create or replace function public.costos_resumen(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_fecha   date := coalesce(nullif(p_data->>'fecha','')::date, current_date);
  v_receta  bigint;
  v_rinde   numeric;
  v_base    numeric;
  v_lineas  jsonb;
  v_pres    jsonb;
  v_avisos  jsonb;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'Solo el dueño');
  end if;

  select r.id, r.rinde_cantidad into v_receta, v_rinde
    from public.recetas r
   where r.tipo = 'base' and r.activa and r.vigente_desde <= v_fecha
   order by r.vigente_desde desc limit 1;

  if v_receta is null then
    return jsonb_build_object('ok', false, 'error', 'No hay receta base vigente en esa fecha');
  end if;

  v_base := public.costo_base_kg(v_fecha);

  -- El desglose de la base: cada insumo, cuanto pone por kilo de producto y
  -- que porcentaje del total es. El porcentaje es lo que dice donde mirar.
  select jsonb_agg(jsonb_build_object(
           'concepto',  x.nombre,
           'cantidad',  x.cantidad,
           'unidad',    x.unidad,
           'unitario',  x.unitario,
           'por_tanda', round(x.cantidad * x.unitario, 2),
           'por_kg',    round(x.cantidad * x.unitario / v_rinde, 4),
           'pct',       case when v_base is null or v_base = 0 then null
                             else round(x.cantidad * x.unitario / v_rinde / v_base * 100, 1) end,
           'fuente',    x.fuente,
           'nota',      x.nota)
           order by x.cantidad * x.unitario desc)
    into v_lineas
    from (select i.nombre, l.cantidad, l.unidad,
                 public.costo_insumo(l.id_insumo, v_fecha) unitario,
                 (select c.fuente from public.insumos_costos c
                   where c.id_insumo = i.id and c.vigente_desde <= v_fecha
                   order by c.vigente_desde desc limit 1) fuente,
                 (select c.nota from public.insumos_costos c
                   where c.id_insumo = i.id and c.vigente_desde <= v_fecha
                   order by c.vigente_desde desc limit 1) nota
            from public.receta_lineas l
            join public.insumos i on i.id = l.id_insumo
           where l.id_receta = v_receta) x;

  -- Una fila por presentacion. Los precios se agrupan: si una presentacion
  -- tuviera dos precios distintos entre sabores saldrian DOS filas, y eso se
  -- veria -en vez de promediarse y desaparecer-.
  select jsonb_agg(jsonb_build_object(
           'presentacion', y.presentacion,
           'gramos',       y.gramos,
           'sabores',      y.sabores,
           'costo',        y.costo,
           'base',         y.c_base,
           'empaque',      y.c_empaque,
           'precios',      jsonb_build_object(
                             'tienda', y.p_t, 'mayorista', y.p_my,
                             'restaurante', y.p_re, 'consumidor', y.p_co,
                             'mostrador', y.p_mo),
           'margenes',     jsonb_build_object(
                             'tienda',      public.pct_margen(y.costo, y.p_t),
                             'mayorista',   public.pct_margen(y.costo, y.p_my),
                             'restaurante', public.pct_margen(y.costo, y.p_re),
                             'consumidor',  public.pct_margen(y.costo, y.p_co),
                             'mostrador',   public.pct_margen(y.costo, y.p_mo)))
           order by y.gramos)
    into v_pres
    from (select p.presentacion, max(p.gramos) gramos, count(*) sabores,
                 round(max(public.costo_sku(p.id, v_fecha)), 2) costo,
                 round(max(r.kg_base) * v_base, 2) c_base,
                 round(max(public.costo_sku(p.id, v_fecha)) - max(r.kg_base) * v_base, 2) c_empaque,
                 p.precio_tienda p_t, p.precio_mayorista p_my,
                 p.precio_restaurante p_re, p.precio_consumidor p_co,
                 p.precio_mostrador p_mo
            from public.productos p
            join public.recetas r on r.tipo = 'sku' and r.id_producto = p.id and r.activa
                                 and r.vigente_desde <= v_fecha
           where p.activo and public.costo_sku(p.id, v_fecha) is not null
           group by p.presentacion, p.precio_tienda, p.precio_mayorista,
                    p.precio_restaurante, p.precio_consumidor, p.precio_mostrador) y;

  -- LOS AVISOS. Todo costo `reconstruido` es un numero que nadie midio en una
  -- factura: tiene que viajar con el numero, no en un documento aparte.
  select jsonb_agg(jsonb_build_object('concepto', i.nombre, 'nota', c.nota)
                   order by i.nombre)
    into v_avisos
    from public.insumos i
    join public.insumos_costos c on c.id_insumo = i.id
   where c.fuente = 'reconstruido' and i.activo
     and c.vigente_desde = (select max(c2.vigente_desde) from public.insumos_costos c2
                             where c2.id_insumo = i.id and c2.vigente_desde <= v_fecha);

  return jsonb_build_object(
    'ok', true,
    'fecha', v_fecha,
    'base', jsonb_build_object(
      'por_kg', v_base,
      'rinde',  v_rinde,
      'lineas', coalesce(v_lineas, '[]'::jsonb)),
    'presentaciones', coalesce(v_pres, '[]'::jsonb),
    'avisos', coalesce(v_avisos, '[]'::jsonb),
    -- El lever que mas mueve el numero, dicho donde se ve el numero.
    'lever', (select jsonb_build_object(
                'concepto', 'Días pagados por tanda',
                'valor',    l.cantidad,
                'nota',     'La receta paga ' || l.cantidad || ' días por tanda (freír + embolsar). '
                         || 'Si se embolsa el mismo día es 1, y la mano de obra por kilo se parte a la mitad.')
                from public.receta_lineas l
                join public.insumos i on i.id = l.id_insumo
               where l.id_receta = v_receta and i.nombre = 'Mano de obra' limit 1));
end $$;

revoke all on function public.costos_resumen(jsonb) from public, anon, authenticated;
grant execute on function public.costos_resumen(jsonb) to anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
--  2. ¿QUE DEJO CADA CANAL, DE VERDAD?
-- ════════════════════════════════════════════════════════════════════════════
-- Del costo CONGELADO en la linea (`costo_unitario`), no del costo de hoy: el
-- margen de junio se midio con los precios de junio. Recalcularlo al vuelo
-- haria que una compra cara de papa cambiara hacia atras lo que se gano.
-- Las lineas de venta con su costo congelado, en UNA definicion. Es una
-- funcion y no una tabla temporal porque `create temp table` dentro de un
-- SECURITY DEFINER depende de que el rol que llama tenga TEMP en la base, y
-- `anon` puede no tenerlo: fallaria solo en produccion y solo desde el
-- navegador. Y es una funcion y no cuatro copias del WHERE porque la
-- condicion de «venta real» es una convencion del proyecto -interno fuera,
-- cancelado fuera- y escrita cuatro veces se desincroniza.
create or replace function public.margen_lineas(p_desde date, p_hasta date)
returns table (fecha date, canal text, presentacion text, cantidad numeric,
               neto numeric, costo numeric, sin_costo boolean)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select o.fecha_orden::date,
         coalesce(case c.tipo_id when 3 then 'tienda' when 4 then 'mayorista'
                                 when 2 then 'restaurante' end, 'consumidor'),
         coalesce(d.presentacion, '(sin presentación)'),
         d.cantidad,
         d.subtotal - coalesce(d.descuento, 0),
         d.costo_unitario * d.cantidad,
         d.costo_unitario is null
    from public.ordenes_detalle d
    join public.ordenes o on o.id = d.id_orden
    left join public.clientes c on c.id = o.id_cliente
   where coalesce(o.tipo_interno, '') = ''
     and o.estatus_pedido <> 'Cancelado'
     and (p_desde is null or o.fecha_orden::date >= p_desde)
     and (p_hasta is null or o.fecha_orden::date <= p_hasta);
$$;

revoke all on function public.margen_lineas(date, date) from public, anon, authenticated;
grant execute on function public.margen_lineas(date, date) to service_role;

create or replace function public.margen_resumen(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_desde date := nullif(p_data->>'desde','')::date;
  v_hasta date := nullif(p_data->>'hasta','')::date;
  v_canal jsonb; v_mes jsonb; v_pres jsonb; v_tot jsonb; v_sin int;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'Solo el dueño');
  end if;

  select count(*) into v_sin
    from public.margen_lineas(v_desde, v_hasta) where sin_costo;

  select jsonb_agg(t order by (t->>'neto')::numeric desc) into v_canal from (
    select jsonb_build_object('clave', canal, 'lineas', count(*),
             'piezas', sum(cantidad), 'neto', round(sum(neto), 2),
             'costo', round(sum(costo), 2),
             'margen', round(sum(neto) - sum(costo), 2),
             'margen_pct', public.pct_margen(sum(costo), sum(neto))) t
      from public.margen_lineas(v_desde, v_hasta)
     where not sin_costo group by canal) z;

  select jsonb_agg(t order by t->>'clave') into v_mes from (
    select jsonb_build_object('clave', to_char(fecha,'YYYY-MM'), 'lineas', count(*),
             'piezas', sum(cantidad), 'neto', round(sum(neto), 2),
             'costo', round(sum(costo), 2),
             'margen', round(sum(neto) - sum(costo), 2),
             'margen_pct', public.pct_margen(sum(costo), sum(neto))) t
      from public.margen_lineas(v_desde, v_hasta)
     where not sin_costo group by to_char(fecha,'YYYY-MM')) z;

  select jsonb_agg(t order by t->>'clave') into v_pres from (
    select jsonb_build_object('clave', presentacion, 'lineas', count(*),
             'piezas', sum(cantidad), 'neto', round(sum(neto), 2),
             'costo', round(sum(costo), 2),
             'margen', round(sum(neto) - sum(costo), 2),
             'margen_pct', public.pct_margen(sum(costo), sum(neto))) t
      from public.margen_lineas(v_desde, v_hasta)
     where not sin_costo group by presentacion) z;

  select jsonb_build_object('lineas', count(*), 'piezas', sum(cantidad),
           'neto', round(sum(neto), 2), 'costo', round(sum(costo), 2),
           'margen', round(sum(neto) - sum(costo), 2),
           'margen_pct', public.pct_margen(sum(costo), sum(neto)))
    into v_tot from public.margen_lineas(v_desde, v_hasta) where not sin_costo;

  return jsonb_build_object('ok', true,
    'desde', v_desde, 'hasta', v_hasta,
    'total', v_tot,
    'por_canal', coalesce(v_canal,'[]'::jsonb),
    'por_mes', coalesce(v_mes,'[]'::jsonb),
    'por_presentacion', coalesce(v_pres,'[]'::jsonb),
    'sin_costear', v_sin);
end $$;

revoke all on function public.margen_resumen(jsonb) from public, anon, authenticated;
grant execute on function public.margen_resumen(jsonb) to anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
--  3. ¿QUE TIENE QUE PASAR PARA GANAR?
-- ════════════════════════════════════════════════════════════════════════════
-- El punto de equilibrio del modelo de octubre (`historico/modelo.py`), pero
-- leyendo la receta REAL en vez de repetir sus formulas: los precios y las
-- cantidades salen de `recetas` e `insumos_costos`, y solo los LEVERS se
-- sustituyen. Asi el modelo no envejece aparte de la app.
--
-- Levers (todos opcionales; sin ellos usa lo que hay en la base):
--   gramos, canal, precio_papa, kg_por_tanda, dias_por_tanda, pago_dia,
--   fijos_mes, vendedores, costo_vendedor, piezas_tienda_mes,
--   tiendas_por_vendedor, objetivo
create or replace function public.punto_equilibrio(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_fecha  date    := coalesce(nullif(p_data->>'fecha','')::date, current_date);
  v_gramos numeric := coalesce(nullif(p_data->>'gramos','')::numeric, 100);
  v_canal  text    := coalesce(nullif(p_data->>'canal',''), 'tienda');
  v_receta bigint; v_rinde numeric;
  v_papa   numeric; v_pago numeric; v_dias numeric;
  v_otros  numeric;         -- todo lo de la receta base que no es papa ni mano de obra
  v_base   numeric;         -- costo por kg de producto, con los levers puestos
  v_emp    numeric;         -- bolsa + etiqueta de esa presentacion
  v_costo  numeric;         -- costo completo de una pieza
  v_precio numeric;
  v_mc     numeric;         -- margen de contribucion por pieza
  v_fijos  numeric; v_vend numeric; v_cvend numeric;
  v_pzt    numeric; v_tv numeric; v_obj numeric;
  v_pz_eq  numeric; v_pz_ob numeric; v_kg numeric; v_tandas numeric;
  v_tiendas numeric;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'Solo el dueño');
  end if;

  select r.id, r.rinde_cantidad into v_receta, v_rinde
    from public.recetas r
   where r.tipo = 'base' and r.activa and r.vigente_desde <= v_fecha
   order by r.vigente_desde desc limit 1;
  if v_receta is null then
    return jsonb_build_object('ok', false, 'error', 'No hay receta base vigente');
  end if;

  v_rinde := coalesce(nullif(p_data->>'kg_por_tanda','')::numeric, v_rinde);

  -- Papa: la cantidad la dice la receta, el precio lo puede mover el lever.
  select l.cantidad * coalesce(nullif(p_data->>'precio_papa','')::numeric,
                               public.costo_insumo(l.id_insumo, v_fecha))
    into v_papa
    from public.receta_lineas l join public.insumos i on i.id = l.id_insumo
   where l.id_receta = v_receta and i.nombre = 'Papa';

  -- Mano de obra: dias por tanda y pago por dia, los dos movibles.
  select coalesce(nullif(p_data->>'dias_por_tanda','')::numeric, l.cantidad),
         coalesce(nullif(p_data->>'pago_dia','')::numeric,
                  public.costo_insumo(l.id_insumo, v_fecha))
    into v_dias, v_pago
    from public.receta_lineas l join public.insumos i on i.id = l.id_insumo
   where l.id_receta = v_receta and i.nombre = 'Mano de obra';
  v_dias := coalesce(v_dias, coalesce(nullif(p_data->>'dias_por_tanda','')::numeric, 0));
  v_pago := coalesce(v_pago, coalesce(nullif(p_data->>'pago_dia','')::numeric, 0));

  -- Todo lo demas de la receta, tal cual: aceite, gas, otros insumos.
  select coalesce(sum(l.cantidad * public.costo_insumo(l.id_insumo, v_fecha)), 0)
    into v_otros
    from public.receta_lineas l join public.insumos i on i.id = l.id_insumo
   where l.id_receta = v_receta and i.nombre not in ('Papa', 'Mano de obra');

  v_base := round((coalesce(v_papa,0) + v_pago * v_dias + v_otros) / nullif(v_rinde,0), 4);

  -- Empaque de ESA presentacion, leido de su receta de SKU.
  select coalesce(sum(l.cantidad * public.costo_insumo(l.id_insumo, v_fecha)), 0)
    into v_emp
    from public.recetas r
    join public.receta_lineas l on l.id_receta = r.id
   where r.tipo = 'sku' and r.activa and r.kg_base = v_gramos / 1000.0
     and r.vigente_desde <= v_fecha
     and r.id = (select r2.id from public.recetas r2
                  where r2.tipo='sku' and r2.activa and r2.kg_base = v_gramos/1000.0
                    and r2.vigente_desde <= v_fecha
                  order by r2.vigente_desde desc limit 1);

  v_costo := round(v_gramos / 1000.0 * v_base + coalesce(v_emp,0), 4);

  select max(case v_canal
               when 'tienda'      then p.precio_tienda
               when 'mayorista'   then p.precio_mayorista
               when 'restaurante' then p.precio_restaurante
               when 'consumidor'  then p.precio_consumidor
               when 'mostrador'   then p.precio_mostrador end)
    into v_precio
    from public.productos p
   where p.activo and p.gramos = v_gramos;
  v_precio := coalesce(nullif(p_data->>'precio','')::numeric, v_precio);

  v_mc := v_precio - v_costo;

  -- Los fijos. La renta va en 0 por omision: Abraham, 25 oct 2026, «el local
  -- es SUYO, la renta real es 0». El numero que se pone es la luz.
  v_fijos  := coalesce(nullif(p_data->>'fijos_mes','')::numeric, 350);
  v_vend   := coalesce(nullif(p_data->>'vendedores','')::numeric, 2);
  v_cvend  := coalesce(nullif(p_data->>'costo_vendedor','')::numeric, 0);
  v_pzt    := coalesce(nullif(p_data->>'piezas_tienda_mes','')::numeric, 23);
  v_tv     := coalesce(nullif(p_data->>'tiendas_por_vendedor','')::numeric, 200);
  v_obj    := coalesce(nullif(p_data->>'objetivo','')::numeric, 0);

  -- Explicito a proposito: en el xlsx esta misma suma salio mal una vez, por
  -- una referencia de celda escrita a mano que sumaba el NUMERO de vendedores.
  v_fijos := v_fijos + v_vend * v_cvend;

  if v_mc is null or v_mc <= 0 then
    return jsonb_build_object('ok', true,
      'pierde', true,
      'costo', v_costo, 'precio', v_precio, 'margen_contribucion', v_mc,
      'base_por_kg', v_base, 'empaque', v_emp, 'gramos', v_gramos, 'canal', v_canal,
      'mensaje', 'A este precio cada pieza pierde dinero: no hay volumen que lo arregle.');
  end if;

  v_pz_eq   := ceil(v_fijos / v_mc);
  v_pz_ob   := ceil((v_fijos + v_obj) / v_mc);
  v_kg      := round(v_pz_ob * v_gramos / 1000.0, 1);
  v_tandas  := round(v_kg / nullif(v_rinde,0), 1);
  v_tiendas := ceil(v_pz_ob / nullif(v_pzt,0));

  return jsonb_build_object('ok', true,
    'pierde', false,
    'gramos', v_gramos, 'canal', v_canal,
    'costo', v_costo, 'precio', v_precio, 'margen_contribucion', round(v_mc,2),
    'margen_pct', public.pct_margen(v_costo, v_precio),
    'base_por_kg', v_base, 'empaque', v_emp,
    'mano_obra_por_kg', round(v_pago * v_dias / nullif(v_rinde,0), 2),
    'dias_por_tanda', v_dias, 'pago_dia', v_pago, 'kg_por_tanda', v_rinde,
    'fijos_mes', v_fijos, 'objetivo', v_obj,
    'piezas_equilibrio', v_pz_eq,
    'piezas_objetivo', v_pz_ob,
    'kg_mes', v_kg, 'tandas_mes', v_tandas,
    'tiendas', v_tiendas,
    'tiendas_por_vendedor', case when v_vend > 0 then ceil(v_tiendas / v_vend) end,
    'cabe', case when v_vend > 0 then (v_tiendas / v_vend) <= v_tv end,
    'vendedores_necesarios', ceil(v_tiendas / nullif(v_tv,0)));
end $$;

revoke all on function public.punto_equilibrio(jsonb) from public, anon, authenticated;
grant execute on function public.punto_equilibrio(jsonb) to anon, authenticated, service_role;
