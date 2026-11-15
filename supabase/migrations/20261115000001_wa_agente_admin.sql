-- ============================================================================
--  wa_agente_admin — lo que lee la pagina /agente
--
--  Patron de `retos_admin` y `radar_informe`: recibe el token del dueno dentro
--  de p_data, lo valida y devuelve todo lo que la pantalla necesita en UNA
--  llamada. La llave publica solo puede llamar a esto; `wa_ajustes()` sigue
--  siendo de service_role.
--
--  DEVUELVE TAMBIEN LOS RANGOS, y no es un capricho: si la pagina llevara sus
--  propios min/max escritos en el HTML, el dia que alguien cambie un rango en
--  set_wa_ajustes el formulario seguiria aceptando lo viejo y el guardado
--  fallaria sin que se entienda por que. Una copia que nadie compara, miente
--  (regla 63). Por eso los rangos salen de wa_rangos(), una sola fuente que
--  usan la validacion y la pantalla.
--
--  Y el PULSO DEL DIA, para que la pagina no sea solo un formulario: cuantos
--  mensajes entraron, cuantos salieron, cuanto se gasto y los ultimos de verdad.
--  Ajustar sin ver el efecto es ajustar a ciegas.
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

-- Los rangos, en un solo sitio. `set_wa_ajustes` los usa para validar y
-- `wa_agente_admin` para pintar el formulario.
create or replace function public.wa_rangos()
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'tope_por_numero',  jsonb_build_array(1, 500),
    'tope_global',      jsonb_build_array(1, 5000),
    'max_turnos',       jsonb_build_array(2, 100),
    'max_vueltas',      jsonb_build_array(1, 12),
    'max_lineas',       jsonb_build_array(1, 50),
    'max_piezas_linea', jsonb_build_array(1, 100000),
    'avisos_por_dia',   jsonb_build_array(0, 50)
  );
$$;

grant execute on function public.wa_rangos() to anon, authenticated, service_role;

-- set_wa_ajustes deja de llevar su propia copia de los rangos.
create or replace function public.set_wa_ajustes(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actual jsonb;
  v_nuevo  jsonb;
  v_n      numeric;
  v_clave  text;
  v_rangos jsonb := public.wa_rangos();
begin
  -- OJO a la firma: es sesion_es_dueno(p_token text), NO sin argumentos.
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'datos_invalidos');
  end if;

  for v_clave in select jsonb_object_keys(v_rangos) loop
    if p_data ? v_clave then
      begin
        v_n := (p_data->>v_clave)::numeric;
      exception when others then
        return jsonb_build_object('ok', false, 'error', 'no_es_numero', 'clave', v_clave);
      end;
      if v_n < (v_rangos->v_clave->>0)::numeric or v_n > (v_rangos->v_clave->>1)::numeric then
        return jsonb_build_object('ok', false, 'error', 'fuera_de_rango', 'clave', v_clave,
          'min', (v_rangos->v_clave->0), 'max', (v_rangos->v_clave->1));
      end if;
    end if;
  end loop;

  if p_data ? 'modelo' and (p_data->>'modelo') not in
     ('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5') then
    return jsonb_build_object('ok', false, 'error', 'modelo_desconocido');
  end if;
  if p_data ? 'effort' and (p_data->>'effort') not in ('low', 'medium', 'high') then
    return jsonb_build_object('ok', false, 'error', 'effort_desconocido');
  end if;
  if p_data ? 'avisar_a' and jsonb_typeof(p_data->'avisar_a') <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'avisar_a_no_es_lista');
  end if;

  v_actual := coalesce(
    (select valor from public.config_produccion where clave = 'agente_whatsapp'), '{}'::jsonb);
  -- El token NO se guarda: es credencial, no ajuste.
  v_nuevo := v_actual || (p_data - 'token');

  insert into public.config_produccion (clave, valor)
  values ('agente_whatsapp', v_nuevo)
  on conflict (clave) do update set valor = excluded.valor;

  return jsonb_build_object('ok', true, 'ajustes', public.wa_ajustes());
end;
$$;

revoke all on function public.set_wa_ajustes(jsonb) from public;
grant execute on function public.set_wa_ajustes(jsonb) to anon, authenticated, service_role;

-- ── Lo que lee la pantalla ──────────────────────────────────────────────────
create or replace function public.wa_agente_admin(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_desde timestamptz;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  -- "Hoy" es hoy en CDMX, no en UTC: a las 19:00 de Mexico ya es manana en UTC
  -- y el pulso del dia se vaciaria a media tarde.
  v_desde := ((now() at time zone 'America/Mexico_City')::date)::timestamp
             at time zone 'America/Mexico_City';

  return jsonb_build_object(
    'ok', true,
    'ajustes', public.wa_ajustes(),
    'rangos',  public.wa_rangos(),
    'hoy', coalesce((
      select jsonb_build_object(
        'entran',   count(*) filter (where direccion = 'entra'),
        'salen',    count(*) filter (where direccion = 'sale'
                      and coalesce(herramientas->>'tipo', '') <> 'aviso'),
        'avisos',   count(*) filter (where coalesce(herramientas->>'tipo', '') = 'aviso'),
        'personas', count(distinct telefono),
        -- $4 por millon de entrada y $20 de salida. Si algun dia cambia el
        -- precio, cambia aqui y en POR_DEFECTO del codigo, no en la pantalla.
        'usd', round(coalesce(sum(
                 ((herramientas->>'entrada')::numeric * 4
                + (herramientas->>'salida')::numeric * 20) / 1000000), 0), 4))
      from public.wa_mensajes where fecha >= v_desde), '{}'::jsonb),
    'ultimos', coalesce((
      select jsonb_agg(x order by x->>'id' desc) from (
        select jsonb_build_object(
          'id', id,
          'hora', to_char(fecha at time zone 'America/Mexico_City', 'HH24:MI'),
          'dir', direccion,
          'tipo', herramientas->>'tipo',
          'tel', right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 4),
          'texto', left(replace(coalesce(texto, ''), chr(10), ' '), 110),
          'uso', herramientas->'usadas',
          'usd', round(coalesce(
                   ((herramientas->>'entrada')::numeric * 4
                  + (herramientas->>'salida')::numeric * 20) / 1000000, 0), 4)) as x
        from public.wa_mensajes order by id desc limit 14) s), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.wa_agente_admin(jsonb) from public;
grant execute on function public.wa_agente_admin(jsonb) to anon, authenticated, service_role;

comment on function public.wa_agente_admin(jsonb) is
  'Lo que lee /agente: ajustes, rangos y el pulso del dia. Solo el dueno. Los rangos salen de '
  'wa_rangos(), la misma fuente que valida set_wa_ajustes, para que el formulario no acepte lo '
  'que el guardado rechaza.';
