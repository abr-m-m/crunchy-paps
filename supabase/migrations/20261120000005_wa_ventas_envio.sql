-- ============================================================================
--  `wa_ventas`: el envio, para que la diferencia se pueda explicar
--
--  LO ENCONTRO EL AGENTE, el 20 nov 2026 a las 19:26. Al dar el acumulado del
--  año cerro asi:
--
--    «Cobrado sale mayor que neto. No sé a qué se deba la diferencia, y con
--     estos datos no puedo explicarla.»
--
--  Tenia razon, y el defecto era de la herramienta: 12,295.20 - 12,215.20 = 80.00,
--  que es exactamente `envio_cobrado`. `wa_ventas` le entregaba `neto` -que NO
--  lleva envio- junto a `cobrado` -que SI-, **sin darle con que explicarlo**.
--
--  Dijo «no se» en vez de inventar una razon plausible, que es justo lo que el
--  prompt le pide. Ese «no se» fue accionable: faltaban tres campos.
--
--  `neto` = subtotal - descuento, SIN envio (CLAUDE.md §4).
--  `cobrado` = neto + envioCobrado.
--  `bruto` - `neto` = cupones + descuento de linea.
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

create or replace function public.wa_ventas(p_desde date default null, p_hasta date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_hasta date := coalesce(p_hasta, (now() at time zone 'America/Mexico_City')::date);
  v_desde date := coalesce(p_desde, v_hasta - 89);
  v_d     jsonb;
  v_ult   jsonb;
  v_tmp   date;
begin
  -- Un periodo al reves se endereza en vez de tronar: el modelo puede mandar
  -- las fechas cambiadas, y un error ahi se traduce en «se me complico el
  -- sistema» para el dueño.
  if v_desde > v_hasta then
    v_tmp := v_desde; v_desde := v_hasta; v_hasta := v_tmp;
  end if;

  v_d := public.dashboard_resumen_interno(
           jsonb_build_object('desde', v_desde::text, 'hasta', v_hasta::text))->'data';

  -- El ultimo dia con ventas, SOBRE TODO EL HISTORICO. `coalesce(tipo_interno,'') = ''`
  -- y `estatus_pedido <> 'Cancelado'` son la condicion estandar de «ventas
  -- reales» del proyecto; que coincide con la del tablero esta comprobado
  -- (los dos cuentan 60 pedidos en 2026).
  select jsonb_build_object(
           'fecha', o.dia::text,
           'pedidos', o.n,
           'neto', o.neto)
    into v_ult
    from (
      select fecha_orden::date as dia, count(*) as n,
             sum(coalesce(subtotal, 0) - coalesce(descuento, 0)) as neto
        from public.ordenes
       where coalesce(tipo_interno, '') = '' and estatus_pedido <> 'Cancelado'
       group by 1
      having sum(coalesce(subtotal, 0) - coalesce(descuento, 0)) > 0
       order by 1 desc
       limit 1
    ) o;

  return jsonb_build_object(
    'ok', true,
    'desde', v_desde::text,
    'hasta', v_hasta::text,
    -- Lo que se pregunto, y lo unico que no depende del periodo.
    'ultimoDiaConVentas', v_ult,
    -- Lo del periodo, tal cual lo da el tablero.
    'neto',        (v_d->'ingresos'->>'neto')::numeric,
    'bruto',       (v_d->'ingresos'->>'bruto')::numeric,
    'cobrado',     (v_d->'ingresos'->>'cobrado')::numeric,
    -- LO QUE FALTABA, y lo encontro el propio agente (ver cabecera).
    'envioCobrado',   (v_d->'ingresos'->>'envio_cobrado')::numeric,
    'envioAbsorbido', (v_d->'ingresos'->>'envio_absorbido')::numeric,
    'cupones',        (v_d->'ingresos'->>'cupones')::numeric,
    'porCobrar',   (v_d->>'por_cobrar_monto')::numeric,
    'pedidos',     (v_d->>'entregados')::int,
    'porEntregar', (v_d->>'por_entregar')::int,
    -- Solo los tres primeros: el aviso va por WhatsApp y el modelo no necesita
    -- la lista entera para contestar.
    'porVendedor', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select jsonb_build_object('nombre', e->>'nombre', 'ventas', e->>'ventas',
                                  'pedidos', e->>'pedidos') as x
          from jsonb_array_elements(coalesce(v_d->'por_vendedor', '[]'::jsonb)) e
         where (e->>'ventas')::numeric > 0
         limit 3) s)
  );
end;
$$;

revoke all on function public.wa_ventas(date, date) from public, anon, authenticated;
grant execute on function public.wa_ventas(date, date) to service_role;
