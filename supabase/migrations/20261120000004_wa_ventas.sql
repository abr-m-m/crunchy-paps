-- ============================================================================
--  La herramienta de ventas del dueño
--
--  Diseno: cambios/2026-11-20-el-equipo-completo.md
--
--  LA PIDIO EL PROPIO AGENTE. El 20 nov 2026 a las 19:07, al no poder contestar
--  «¿cuándo fue el último día que vendimos?», apunto el hueco con esta ficha:
--
--    «Herramienta de consulta de ventas del negocio (todos los pedidos/ventas,
--     NO SOLO LOS DEL USUARIO) que devuelva la fecha de la última venta.»
--
--  No la escribio una persona: la escribio el agente al reconocer lo que le
--  faltaba, y distinguio solo lo que importa —todos los pedidos contra solo los
--  de quien escribe—, que es justo donde `mis_pedidos` se queda corta.
--
--  NO CALCULA NADA. Envuelve `dashboard_resumen_interno`, que es la MISMA
--  funcion que alimenta el tablero (`dashboard_resumen` es solo su envoltura de
--  autorizacion, y el agente no lleva token). Asi el numero que el dueño lee por
--  WhatsApp y el que ve en su pantalla no pueden separarse: son el mismo.
--  Una copia que nadie compara, miente (regla 63) — y aqui mentir seria que
--  lea $12,215 en un lado y otra cosa en el otro sin saber cual creer.
--
--  LA UNICA CIFRA QUE NO SALE DE AHI es `ultimoDiaConVentas`, y es a proposito:
--  «cuando vendimos por ultima vez» NO es una pregunta del periodo. Con una
--  ventana de 90 dias diria «nunca» en cuanto el negocio lleve tres meses
--  parado, que es exactamente el caso de hoy —la ultima venta es del 7 de
--  septiembre—. Se mira sobre TODOS los pedidos, con la condicion estandar del
--  proyecto (`CLAUDE.md` §4), verificada contra el tablero: los dos cuentan 60.
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
