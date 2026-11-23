-- ════════════════════════════════════════════════════════════════════════════
--  RESULTADOS: la misma serie, pero por DÍA cuando se elige un mes
--  23 nov 2026. Abraham, viendo Resultados: «me gusta la tendencia mensual y me
--  sirve. Integra la posibilidad de visualizar tendencia diaria. Es decir, si
--  elijo ver abril 2026, en los diferentes indicadores poder ver la tendencia
--  diaria.»
--
--  CÓMO SE HIZO, Y POR QUÉ ASÍ. No hay una función nueva ni una rama `if` por
--  cada indicador: **el grano es una variable**. `date_trunc(v_grano, fecha)` y
--  el paso de `generate_series` son lo único que cambia entre «mes a mes» y
--  «día a día» — el resto del cuerpo es idéntico, así que las dos vistas no
--  pueden discrepar por descuido. Dos copias del mismo cálculo acabarían
--  contando cosas distintas en cuanto alguien toque una (regla 63).
--
--  LO QUE SE CONSERVA DEL DISEÑO DE AYER: la serie trae TODOS los cubos del
--  periodo, también los vacíos. En un mes concreto eso importa más que en la
--  serie anual: un mes con tres ventas y veintisiete días en cero tiene que
--  verse como lo que es, no como tres barras seguidas.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.resultados_tendencia(p_data jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_vend    bigint;
  v_dueno   boolean;
  v_meses   integer := least(greatest(coalesce((p_data->>'meses')::integer, 12), 3), 36);
  v_mes     text    := nullif(p_data->>'mes', '');
  v_grano   text    := 'month';
  v_paso    interval := interval '1 month';
  v_desde   date;
  v_hasta   date;
  v_serie   jsonb;
  v_margen  jsonb;
  v_emb     jsonb;
  v_primera date;
begin
  select s.id_vendedor into v_vend
    from public.sesion_exige_seccion(p_data->>'token', 'resumen') s;
  if v_vend is null then
    return jsonb_build_object('ok', false, 'error', 'no_autorizado');
  end if;
  v_dueno := public.sesion_es_dueno(p_data->>'token');

  if v_mes is not null then
    -- Un mes concreto: el grano pasa a día y la ventana es ese mes entero.
    begin
      v_desde := to_date(v_mes || '-01', 'YYYY-MM-DD');
    exception when others then
      return jsonb_build_object('ok', false, 'error', 'mes_invalido');
    end;
    v_grano := 'day';
    v_paso  := interval '1 day';
    v_hasta := (v_desde + interval '1 month - 1 day')::date;
  else
    select date_trunc('month', min(o.fecha_orden))::date into v_primera
      from public.ordenes o
     where coalesce(o.tipo_interno,'') = '' and o.estatus_pedido <> 'Cancelado';
    v_desde := greatest(
      coalesce(v_primera, date_trunc('month', current_date)::date),
      (date_trunc('month', current_date) - ((v_meses - 1) || ' months')::interval)::date);
    v_hasta := (date_trunc('month', current_date) + interval '1 month - 1 day')::date;
  end if;

  -- ── La serie, SIN huecos, al grano que toque ─────────────────────────────
  with cubos as (
    select generate_series(v_desde, least(v_hasta, greatest(current_date, v_desde)), v_paso)::date cubo
  ),
  reales as (
    select o.id, o.id_cliente,
           date_trunc(v_grano, o.fecha_orden)::date cubo,
           coalesce(o.subtotal,0) - coalesce(o.descuento,0) neto
      from public.ordenes o
     where coalesce(o.tipo_interno,'') = ''
       and o.estatus_pedido <> 'Cancelado'
       and o.fecha_orden >= v_desde
       and o.fecha_orden < (v_hasta + 1)
  ),
  -- «Nuevo» sigue siendo la primera compra de TODA su historia, no la primera
  -- del periodo que se está mirando: si no, al cambiar de mes el mismo cliente
  -- vuelve a ser nuevo y el número sube sin que pase nada en el negocio.
  primeras as (
    select o.id_cliente, date_trunc(v_grano, min(o.fecha_orden))::date primer_cubo
      from public.ordenes o
     where coalesce(o.tipo_interno,'') = '' and o.estatus_pedido <> 'Cancelado'
       and o.id_cliente is not null
     group by o.id_cliente
  ),
  kilos as (
    select date_trunc(v_grano, o.fecha_orden)::date cubo,
           sum(public.kg_de_linea(d.tipo_venta, d.presentacion,
                                  d.cantidad, d.gramos_vendidos)) kg
      from public.ordenes_detalle d
      join public.ordenes o on o.id = d.id_orden
     where coalesce(o.tipo_interno,'') = '' and o.estatus_pedido <> 'Cancelado'
       and o.fecha_orden >= v_desde and o.fecha_orden < (v_hasta + 1)
     group by 1
  )
  select jsonb_agg(jsonb_build_object(
           'mes',      to_char(c.cubo, case when v_grano = 'day' then 'YYYY-MM-DD' else 'YYYY-MM' end),
           'pedidos',  coalesce(r.pedidos, 0),
           'neto',     round(coalesce(r.neto, 0), 2),
           'ticket',   case when coalesce(r.pedidos,0) > 0
                            then round(r.neto / r.pedidos, 2) else 0 end,
           'clientes', coalesce(r.clientes, 0),
           'nuevos',   coalesce(r.nuevos, 0),
           'kg',       round(coalesce(k.kg, 0), 2)
         ) order by c.cubo) into v_serie
    from cubos c
    left join (
      select x.cubo, count(*) pedidos, sum(x.neto) neto,
             count(distinct x.id_cliente) clientes,
             count(distinct x.id_cliente) filter (where p.primer_cubo = x.cubo) nuevos
        from reales x
        left join primeras p on p.id_cliente = x.id_cliente
       group by x.cubo) r on r.cubo = c.cubo
    left join kilos k on k.cubo = c.cubo;

  -- ── Margen: lo da el motor de costeo, al mismo grano ─────────────────────
  if v_dueno then
    select jsonb_agg(t order by t->>'mes') into v_margen from (
      select jsonb_build_object(
               'mes', to_char(date_trunc(v_grano, l.fecha),
                              case when v_grano = 'day' then 'YYYY-MM-DD' else 'YYYY-MM' end),
               'neto', round(sum(l.neto), 2),
               'costo', round(sum(l.costo), 2),
               'margen_pct', public.pct_margen(sum(l.costo), sum(l.neto))) t
        from public.margen_lineas(v_desde, v_hasta) l
       where not l.sin_costo
       group by date_trunc(v_grano, l.fecha)) z;
  end if;

  -- ── Del catálogo al pedido, al mismo grano y solo consumidor ─────────────
  with ev as (
    select nullif(e.session_id,'') sid,
           date_trunc(v_grano, e.creado_en)::date cubo,
           coalesce(e.params->>'v','') = '1' personal,
           case e.evento when 'view_catalog' then 1 when 'view_item' then 2
                         when 'add_to_cart' then 3 when 'begin_checkout' then 4
                         when 'select_payment' then 5 when 'purchase' then 6
                         else 0 end paso
      from public.eventos_navegacion e
     where e.creado_en >= v_desde and e.creado_en < (v_hasta + 1)
  ),
  por_sesion as (
    select sid, min(cubo) cubo, max(paso) mayor
      from ev where paso > 0 and sid is not null and not personal
     group by sid
  )
  select jsonb_agg(jsonb_build_object(
           'mes', to_char(cubo, case when v_grano = 'day' then 'YYYY-MM-DD' else 'YYYY-MM' end),
           'sesiones', sesiones, 'compraron', compraron,
           'conversion_pct', case when sesiones > 0
                                  then round(compraron * 100.0 / sesiones, 1)
                                  else 0 end) order by cubo) into v_emb
    from (select cubo, count(*) sesiones,
                 count(*) filter (where mayor >= 6) compraron
            from por_sesion group by cubo) z;

  return jsonb_build_object(
    'ok', true,
    'grano', v_grano,
    'mes', v_mes,
    'desde', to_char(v_desde, 'YYYY-MM-DD'),
    'hasta', to_char(v_hasta, 'YYYY-MM-DD'),
    'serie', coalesce(v_serie, '[]'::jsonb),
    'margen', case when v_dueno then coalesce(v_margen,'[]'::jsonb) else null end,
    'embudo', coalesce(v_emb, '[]'::jsonb),
    -- El techo viaja CON la medida: quien lea esto tiene que saber sobre
    -- cuántos cubos con venta está mirando, sean meses o días.
    'meses_con_venta', (select count(*) from jsonb_array_elements(coalesce(v_serie,'[]'::jsonb)) e
                         where (e->>'pedidos')::int > 0),
    'meses_en_serie', jsonb_array_length(coalesce(v_serie,'[]'::jsonb)),
    -- Los meses que SÍ tuvieron venta, para que la pantalla no ofrezca elegir
    -- entre treinta y seis meses vacíos.
    'meses_con_datos', (select coalesce(jsonb_agg(m order by m desc), '[]'::jsonb) from (
        select distinct to_char(date_trunc('month', o.fecha_orden), 'YYYY-MM') m
          from public.ordenes o
         where coalesce(o.tipo_interno,'') = '' and o.estatus_pedido <> 'Cancelado') y),
    'ultima_venta', (select to_char(max(o.fecha_orden),'YYYY-MM-DD')
                       from public.ordenes o
                      where coalesce(o.tipo_interno,'') = ''
                        and o.estatus_pedido <> 'Cancelado')
  );
end $$;

revoke all on function public.resultados_tendencia(jsonb) from public, anon, authenticated;
grant execute on function public.resultados_tendencia(jsonb) to anon, authenticated;
