-- ============================================================================
--  registrar_eventos — el mismo registro de navegación, pero por lotes
--  PLAN.md §3.3 · hallazgo 05 del diagnóstico de escala
-- ----------------------------------------------------------------------------
--  `registrar_evento` (singular) es el RPC más usado de toda la app: 3,757
--  llamadas, una petición HTTP por evento. Los 13 eventos del embudo salen de
--  un único emisor —`track()` en index.html— así que agruparlos es un cambio
--  de una función, no de dieciséis puntos de llamada.
--
--  ── Por qué el singular NO se toca ──
--
--  `service-worker.js` cachea `index.html`. Tras desplegar habrá teléfonos
--  corriendo la versión vieja durante días, llamando de uno en uno. Este RPC
--  es ADITIVO: se añade al lado, y el viejo sigue vivo. También es la reversa:
--  deshacer §3.3 es devolver `track()` a la llamada de una en una, sin tocar
--  la base.
--
--  ── El instante de cada evento: `msAtras`, no la fecha del cliente ──
--
--  Un lote llega a la base segundos después de que ocurrieron sus eventos. Si
--  todos entraran con `now()`, los huecos entre `view_item → add_to_cart →
--  begin_checkout` se aplastarían y el embudo mentiría sobre los tiempos.
--
--  La alternativa evidente —que el navegador mande la fecha absoluta— mete el
--  reloj del teléfono en la tabla, y un reloj mal puesto produce eventos con
--  fecha de 2019 o del año que viene. Así que cada evento viaja con su DESFASE
--  en milisegundos y el servidor calcula `now() - msAtras`: los huecos quedan
--  exactos aunque el reloj del cliente esté desajustado, porque solo se confía
--  en la diferencia, nunca en el origen.
--
--  Un `msAtras` que no sea número, o que caiga fuera de [0, 3600000] (una
--  hora), se ignora y el evento cae en `now()`. Es el mismo comportamiento que
--  hoy, que es el peor caso aceptable.
--
--  ── Tope de 50 por lote ──
--
--  Este RPC lo puede ejecutar `anon`, igual que el singular. Agrupar abarata el
--  abuso por 50: una petición pasa a escribir 50 filas. El tope vive en el
--  servidor, no en el navegador, porque el navegador es del atacante. El
--  cliente descarga de 20 en 20, así que nunca se acerca.
--
--  Aditivo y reversible. Para deshacerlo:
--    drop function if exists public.registrar_eventos(jsonb);
-- ============================================================================

create or replace function public.registrar_eventos(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_eventos jsonb := p_data->'eventos';
  v_ahora   timestamptz := now();
  v_n       integer;
  v_desde   timestamptz;
  v_hasta   timestamptz;
begin
  if jsonb_typeof(v_eventos) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'eventos debe ser un arreglo');
  end if;

  v_n := jsonb_array_length(v_eventos);
  if v_n = 0 then
    return jsonb_build_object('ok', true, 'insertados', 0);
  end if;
  if v_n > 50 then
    return jsonb_build_object('ok', false, 'error', 'lote demasiado grande (máximo 50)');
  end if;

  with ins as (
    insert into public.eventos_navegacion (
      session_id, id_cliente, evento, params,
      utm_source, utm_medium, utm_campaign, path, creado_en
    )
    select
      nullif(e->>'sessionId', ''),
      nullif(e->>'idCliente', '')::bigint,
      e->>'evento',
      coalesce(e->'params', '{}'::jsonb),
      nullif(e->>'utmSource', ''),
      nullif(e->>'utmMedium', ''),
      nullif(e->>'utmCampaign', ''),
      nullif(e->>'path', ''),
      -- `jsonb_typeof` antes del cast: sin esa guarda, un `msAtras` con basura
      -- ("abc") reventaría el lote entero con un error de conversión.
      case
        when jsonb_typeof(e->'msAtras') = 'number'
         and (e->>'msAtras')::numeric between 0 and 3600000
        then v_ahora - ((e->>'msAtras')::numeric * interval '1 millisecond')
        else v_ahora
      end
    from jsonb_array_elements(v_eventos) e
    -- Un evento sin nombre no dice nada; se descarta en silencio en vez de
    -- tumbar el lote. El singular devuelve error porque ahí el evento ES la
    -- petición entera.
    where coalesce(e->>'evento', '') <> ''
    returning creado_en
  )
  select count(*), min(creado_en), max(creado_en)
    into v_n, v_desde, v_hasta
    from ins;

  -- `desde`/`hasta` no son adorno: son la única forma de comprobar desde fuera
  -- que `msAtras` se respetó, porque `eventos_navegacion` no se puede leer con
  -- la llave pública. Se devuelve solo lo que esta misma llamada acaba de
  -- escribir.
  return jsonb_build_object('ok', true, 'insertados', v_n,
                            'desde', v_desde, 'hasta', v_hasta);
end;
$$;

alter function public.registrar_eventos(jsonb) owner to postgres;

grant execute on function public.registrar_eventos(jsonb) to anon;
grant execute on function public.registrar_eventos(jsonb) to authenticated;
grant execute on function public.registrar_eventos(jsonb) to service_role;

comment on function public.registrar_eventos(jsonb) is
  'Registro de navegación por lotes (máx 50). Cada evento trae msAtras y el servidor calcula now() - msAtras, para no meter el reloj del cliente en la tabla. Aditivo: registrar_evento (singular) sigue vivo para los teléfonos con la versión cacheada. Creado 4 sep 2026, PLAN.md §3.3.';
