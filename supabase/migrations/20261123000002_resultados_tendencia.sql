-- ════════════════════════════════════════════════════════════════════════════
--  RESULTADOS: los indicadores del negocio, con su serie en el tiempo
--  23 nov 2026. Abraham: «en la sección de resultados me gustaría tener
--  gráficos de indicadores importantes del negocio y no solo de ventas».
--
--  LO QUE SE MIDIO ANTES DE ESCRIBIR UNA LINEA (regla 5: antes de construir un
--  tablero, comprobar que el dato que va a mostrar existe y es fiel):
--    · Ventas reales: 3 meses con datos — jun (41 pedidos), jul (18), sep (1).
--      60 pedidos en total, $12,215 netos, 47 kg. La ultima venta, septiembre.
--    · Margen por mes: YA existe, lo calcula `margen_lineas` desde el motor de
--      costeo. Aqui NO se recalcula (regla 63).
--    · Navegacion: 4,601 eventos de junio a noviembre. Es el unico dato con
--      volumen de verdad.
--    · Prospectos 1,132 · clientes B2B aprobados 36 · pedidos B2B: CERO.
--
--  POR ESO LA SERIE VA MES A MES DESDE LA PRIMERA VENTA HASTA HOY, con los
--  meses vacios DENTRO. Un tablero que solo pinta los meses que tienen datos
--  dibuja tres barras seguidas y miente: aqui agosto, octubre y noviembre
--  salen en cero porque en cero estuvieron. El hueco ES el dato.
--
--  QUIEN VE QUE. La seccion `resumen` la tiene el equipo, pero el COSTO y el
--  margen son del dueno: `margen` solo viaja si `sesion_es_dueno`.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.resultados_tendencia(p_data jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_vend   bigint;
  v_dueno  boolean;
  v_meses  integer := least(greatest(coalesce((p_data->>'meses')::integer, 12), 3), 36);
  v_desde  date;
  v_hasta  date := (date_trunc('month', current_date) + interval '1 month - 1 day')::date;
  v_serie  jsonb;
  v_margen jsonb;
  v_emb    jsonb;
  v_primera date;
begin
  select s.id_vendedor into v_vend
    from public.sesion_exige_seccion(p_data->>'token', 'resumen') s;
  if v_vend is null then
    return jsonb_build_object('ok', false, 'error', 'no_autorizado');
  end if;
  v_dueno := public.sesion_es_dueno(p_data->>'token');

  -- La ventana arranca en la primera venta real, no hace meses redondos: con
  -- tres meses de historia, doce cubos vacios delante no informan de nada.
  select date_trunc('month', min(o.fecha_orden))::date into v_primera
    from public.ordenes o
   where coalesce(o.tipo_interno,'') = '' and o.estatus_pedido <> 'Cancelado';
  v_desde := greatest(
    coalesce(v_primera, date_trunc('month', current_date)::date),
    (date_trunc('month', current_date) - ((v_meses - 1) || ' months')::interval)::date);

  -- ── La serie de venta, mes a mes y SIN huecos ────────────────────────────
  with meses as (
    select generate_series(v_desde, date_trunc('month', current_date)::date,
                           interval '1 month')::date mes
  ),
  reales as (
    select o.id, o.id_cliente,
           date_trunc('month', o.fecha_orden)::date mes,
           coalesce(o.subtotal,0) - coalesce(o.descuento,0) neto
      from public.ordenes o
     where coalesce(o.tipo_interno,'') = ''
       and o.estatus_pedido <> 'Cancelado'
       and o.fecha_orden >= v_desde
  ),
  -- «Nuevo» es quien compra por PRIMERA VEZ en toda la historia, no en la
  -- ventana: si no, al mover la ventana el mismo cliente se vuelve nuevo otra
  -- vez y el numero sube sin que pase nada en el negocio.
  primeras as (
    select o.id_cliente, min(date_trunc('month', o.fecha_orden)::date) primer_mes
      from public.ordenes o
     where coalesce(o.tipo_interno,'') = '' and o.estatus_pedido <> 'Cancelado'
       and o.id_cliente is not null
     group by o.id_cliente
  ),
  kilos as (
    select date_trunc('month', o.fecha_orden)::date mes,
           sum(public.kg_de_linea(d.tipo_venta, d.presentacion,
                                  d.cantidad, d.gramos_vendidos)) kg
      from public.ordenes_detalle d
      join public.ordenes o on o.id = d.id_orden
     where coalesce(o.tipo_interno,'') = '' and o.estatus_pedido <> 'Cancelado'
       and o.fecha_orden >= v_desde
     group by 1
  )
  select jsonb_agg(jsonb_build_object(
           'mes',      to_char(m.mes, 'YYYY-MM'),
           'pedidos',  coalesce(r.pedidos, 0),
           'neto',     round(coalesce(r.neto, 0), 2),
           'ticket',   case when coalesce(r.pedidos,0) > 0
                            then round(r.neto / r.pedidos, 2) else 0 end,
           'clientes', coalesce(r.clientes, 0),
           'nuevos',   coalesce(r.nuevos, 0),
           'kg',       round(coalesce(k.kg, 0), 2)
         ) order by m.mes) into v_serie
    from meses m
    left join (
      select x.mes, count(*) pedidos, sum(x.neto) neto,
             count(distinct x.id_cliente) clientes,
             count(distinct x.id_cliente) filter (where p.primer_mes = x.mes) nuevos
        from reales x
        left join primeras p on p.id_cliente = x.id_cliente
       group by x.mes) r on r.mes = m.mes
    left join kilos k on k.mes = m.mes;

  -- ── Margen por mes: lo da el motor de costeo, no se recalcula ────────────
  if v_dueno then
    select jsonb_agg(t order by t->>'mes') into v_margen from (
      select jsonb_build_object(
               'mes', to_char(l.fecha, 'YYYY-MM'),
               'neto', round(sum(l.neto), 2),
               'costo', round(sum(l.costo), 2),
               'margen_pct', public.pct_margen(sum(l.costo), sum(l.neto))) t
        from public.margen_lineas(v_desde, v_hasta) l
       where not l.sin_costo
       group by to_char(l.fecha, 'YYYY-MM')) z;
  end if;

  -- ── Del catalogo al pedido, por mes ──────────────────────────────────────
  -- Solo sesiones de CONSUMIDOR. `params->>'v' = '1'` marca una sesion del
  -- equipo, y es el mismo criterio que usa `embudo_resumen`: cuando una app
  -- sirve a dos publicos con el mismo codigo, cualquier metrica de
  -- comportamiento los mezcla, y no en la direccion inocente (regla 6).
  with ev as (
    select nullif(e.session_id,'') sid,
           date_trunc('month', e.creado_en)::date mes,
           coalesce(e.params->>'v','') = '1' personal,
           case e.evento when 'view_catalog' then 1 when 'view_item' then 2
                         when 'add_to_cart' then 3 when 'begin_checkout' then 4
                         when 'select_payment' then 5 when 'purchase' then 6
                         else 0 end paso
      from public.eventos_navegacion e
     where e.creado_en >= v_desde
  ),
  por_sesion as (
    select sid, min(mes) mes, max(paso) mayor
      from ev where paso > 0 and sid is not null and not personal
     group by sid
  )
  select jsonb_agg(jsonb_build_object(
           'mes', to_char(mes,'YYYY-MM'),
           'sesiones', sesiones, 'compraron', compraron,
           'conversion_pct', case when sesiones > 0
                                  then round(compraron * 100.0 / sesiones, 1)
                                  else 0 end) order by mes) into v_emb
    from (select mes, count(*) sesiones,
                 count(*) filter (where mayor >= 6) compraron
            from por_sesion group by mes) z;

  return jsonb_build_object(
    'ok', true,
    'desde', to_char(v_desde,'YYYY-MM'),
    'serie', coalesce(v_serie, '[]'::jsonb),
    'margen', case when v_dueno then coalesce(v_margen,'[]'::jsonb) else null end,
    'embudo', coalesce(v_emb, '[]'::jsonb),
    -- El techo y la restriccion viajan CON la medida, no se deducen al pintar:
    -- quien lea esto tiene que saber sobre cuanta historia esta mirando.
    'meses_con_venta', (select count(*) from jsonb_array_elements(coalesce(v_serie,'[]'::jsonb)) e
                         where (e->>'pedidos')::int > 0),
    'meses_en_serie', jsonb_array_length(coalesce(v_serie,'[]'::jsonb)),
    'ultima_venta', (select to_char(max(o.fecha_orden),'YYYY-MM-DD')
                       from public.ordenes o
                      where coalesce(o.tipo_interno,'') = ''
                        and o.estatus_pedido <> 'Cancelado')
  );
end $$;

-- Una funcion nueva concede EXECUTE a PUBLIC por defecto (regla 42).
revoke all on function public.resultados_tendencia(jsonb) from public, anon, authenticated;
grant execute on function public.resultados_tendencia(jsonb) to anon, authenticated;
