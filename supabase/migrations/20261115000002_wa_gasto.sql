-- ============================================================================
--  Gasto del agente: por modelo, y en tres ventanas
--
--  DOS COSAS, y la primera es un arreglo.
--
--  1) EL COSTO SE CALCULABA SUPONIENDO OPUS SIEMPRE. `wa_agente_admin` tenia
--     los precios de Opus 5.5 escritos a mano ($4 y $20 por millon). Desde que
--     el modelo es un ajuste de /agente, esa suposicion es falsa en cuanto
--     alguien lo baja: Haiku 5.5 cuesta $0.10 / $0.50, una veintava parte en
--     entrada, y el panel habria seguido enseñando precio de Opus. Un numero que
--     miente es peor que no tenerlo, porque se usa para decidir.
--
--     Ahora los precios viven en `wa_precios()` y el gasto se calcula con el
--     modelo que REALMENTE se uso, guardado en `wa_mensajes.herramientas.modelo`
--     desde el 15 nov 2026. Lo anterior a esa fecha no lo trae, y para eso se
--     usa Opus como respaldo: es lo que de verdad corrio esos dias.
--
--  2) TRES VENTANAS: hoy, 7 dias y 30 dias. Pedido por Abraham el 15 nov. Un
--     gasto diario sin el acumulado no dice si va bien: un dia de 2 pesos puede
--     ser normal o puede ser el principio de algo.
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

-- Precios en USD por millon de tokens. Si cambian, se cambian AQUI y en
-- POR_DEFECTO de api/whatsapp.js, que es donde el agente los documenta.
create or replace function public.wa_precios()
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'claude-opus-5-5',   jsonb_build_object('entrada', 4.0,  'salida', 20.0, 'cache', 0.20),
    'claude-sonnet-5-5', jsonb_build_object('entrada', 2.0,  'salida', 10.0, 'cache', 0.10),
    'claude-haiku-5-5',  jsonb_build_object('entrada', 0.10, 'salida', 0.50, 'cache', 0.01)
  );
$$;

grant execute on function public.wa_precios() to anon, authenticated, service_role;

-- Gasto de UN mensaje, con el modelo que se uso. Los tokens leidos de cache se
-- cobran aparte y mucho mas baratos, asi que se restan de la entrada: si no, se
-- contarian dos veces y el panel exageraria el gasto.
create or replace function public.wa_costo(p_herr jsonb)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p_herr is null or not (p_herr ? 'entrada') then 0 else
    greatest(0, coalesce((p_herr->>'entrada')::numeric, 0)
                - coalesce((p_herr->>'cacheLeido')::numeric, 0))
      * coalesce((public.wa_precios()->coalesce(p_herr->>'modelo','claude-opus-5-5')->>'entrada')::numeric,
                 (public.wa_precios()->'claude-opus-5-5'->>'entrada')::numeric) / 1000000
    + coalesce((p_herr->>'salida')::numeric, 0)
      * coalesce((public.wa_precios()->coalesce(p_herr->>'modelo','claude-opus-5-5')->>'salida')::numeric,
                 (public.wa_precios()->'claude-opus-5-5'->>'salida')::numeric) / 1000000
    + coalesce((p_herr->>'cacheLeido')::numeric, 0)
      * coalesce((public.wa_precios()->coalesce(p_herr->>'modelo','claude-opus-5-5')->>'cache')::numeric,
                 (public.wa_precios()->'claude-opus-5-5'->>'cache')::numeric) / 1000000
  end;
$$;

grant execute on function public.wa_costo(jsonb) to anon, authenticated, service_role;

-- ── La pantalla ─────────────────────────────────────────────────────────────
create or replace function public.wa_agente_admin(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hoy    timestamptz;
  v_semana timestamptz;
  v_mes    timestamptz;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  -- "Hoy" es hoy en CDMX, no en UTC: a las 19:00 de Mexico ya es manana en UTC
  -- y el gasto del dia se vaciaria a media tarde. Semana y mes son ventanas
  -- moviles de 7 y 30 dias, no "del lunes" ni "del dia 1": lo que importa es si
  -- el gasto va subiendo, y un mes natural lo esconde cada vez que empieza.
  v_hoy := ((now() at time zone 'America/Mexico_City')::date)::timestamp
           at time zone 'America/Mexico_City';
  v_semana := v_hoy - interval '6 days';
  v_mes    := v_hoy - interval '29 days';

  return jsonb_build_object(
    'ok', true,
    'ajustes', public.wa_ajustes(),
    'rangos',  public.wa_rangos(),
    'precios', public.wa_precios(),
    'hoy',    public.wa_resumen(v_hoy),
    'semana', public.wa_resumen(v_semana),
    'mes',    public.wa_resumen(v_mes),
    'ultimos', coalesce((
      select jsonb_agg(x order by x->>'id' desc) from (
        select jsonb_build_object(
          'id', id,
          'hora', to_char(fecha at time zone 'America/Mexico_City', 'HH24:MI'),
          'dir', direccion,
          'tipo', herramientas->>'tipo',
          'modelo', herramientas->>'modelo',
          'tel', right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 4),
          'texto', left(replace(coalesce(texto, ''), chr(10), ' '), 110),
          'uso', herramientas->'usadas',
          'usd', round(public.wa_costo(herramientas), 5)) as x
        from public.wa_mensajes order by id desc limit 14) s), '[]'::jsonb)
  );
end;
$$;

-- El resumen de una ventana. Aparte, para que las tres se calculen igual: si
-- fueran tres consultas escritas a mano, se separarian a la primera correccion.
create or replace function public.wa_resumen(p_desde timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'entran',   count(*) filter (where direccion = 'entra'),
    'salen',    count(*) filter (where direccion = 'sale'
                  and coalesce(herramientas->>'tipo', '') <> 'aviso'),
    'avisos',   count(*) filter (where coalesce(herramientas->>'tipo', '') = 'aviso'),
    'personas', count(distinct telefono),
    'usd',      round(coalesce(sum(public.wa_costo(herramientas)), 0), 4),
    -- Cuanto de la entrada vino de cache. Si sale 0 con trafico, el
    -- cache_control del prompt no esta haciendo nada.
    'cache',    coalesce(sum(coalesce((herramientas->>'cacheLeido')::numeric, 0)), 0))
  from public.wa_mensajes where fecha >= p_desde;
$$;

revoke all on function public.wa_resumen(timestamptz) from public, anon, authenticated;
grant execute on function public.wa_resumen(timestamptz) to service_role;

revoke all on function public.wa_agente_admin(jsonb) from public;
grant execute on function public.wa_agente_admin(jsonb) to anon, authenticated, service_role;

comment on function public.wa_costo(jsonb) is
  'Gasto en USD de un mensaje, con el modelo que realmente se uso (herramientas.modelo). '
  'Los tokens de cache se restan de la entrada y se cobran a su tarifa. Lo anterior al 15 nov '
  '2026 no guarda modelo: se usa Opus como respaldo, que es lo que corrio esos dias.';
