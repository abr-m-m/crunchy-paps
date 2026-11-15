-- ============================================================================
--  Ajustes del agente de WhatsApp, al estilo de las rutas
--
--  POR QUE. Hasta hoy, cambiar un tope o apagar el agente costaba un commit, un
--  CI y un despliegue. Eso esta bien para el prompt -que es logica y pasa por
--  seis pruebas- y es absurdo para un numero. Decision de Abraham el 14 nov
--  2026: a la base los NUMEROS y los INTERRUPTORES; el prompt se queda en el
--  repo, donde el CI lo mira.
--
--  LO QUE DE VERDAD COMPRA ESTO es `activo`. Si el agente se desmadra un sabado,
--  hoy hay que desplegar para callarlo. Con esto es un UPDATE.
--
--  EL CODIGO MANDA SI ESTO FALLA. api/whatsapp.js trae los mismos valores como
--  constantes y los usa cuando la base no contesta o devuelve basura. Un ajuste
--  que falla abierto no es un ajuste: justo el dia que Supabase va lento seria
--  el dia sin topes.
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

-- Sigue el patron de `config_produccion` (clave + valor jsonb), que ya usan
-- 'lealtad', 'mayoreo' y 'hora_limite_pedido'. Una tabla nueva para once
-- numeros habria sido una tabla de mas.
insert into public.config_produccion (clave, valor)
select 'agente_whatsapp', jsonb_build_object(
  'activo',           true,
  'modelo',           'claude-opus-5-5',
  'effort',           'medium',
  'tope_por_numero',  40,
  'tope_global',      400,
  'max_turnos',       24,
  'max_vueltas',      6,
  'max_lineas',       20,
  'max_piezas_linea', 2000,
  -- Vacio a proposito: sin numero al que avisar, la herramienta de escalado NO
  -- se le ofrece al modelo. Que no prometa lo que no puede cumplir — llevaba
  -- todo el 14 nov diciendo "le aviso" sin que existiera forma de avisar.
  'avisar_a',         jsonb_build_array(),
  'avisos_por_dia',   2,
  'mensaje_apagado',  'Ahorita no te puedo atender por aqui. Escribenos en crunchypaps.mx y te respondemos.'
)
 where not exists (select 1 from public.config_produccion where clave = 'agente_whatsapp');

-- ── Lectura ─────────────────────────────────────────────────────────────────
-- La llama api/whatsapp.js con la llave de servicio en cada mensaje. Devuelve
-- SIEMPRE un objeto completo: si falta una clave, pone la de por defecto, para
-- que el codigo no tenga que comprobar once veces si algo vino nulo.
create or replace function public.wa_ajustes()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'activo',           true,
    'modelo',           'claude-opus-5-5',
    'effort',           'medium',
    'tope_por_numero',  40,
    'tope_global',      400,
    'max_turnos',       24,
    'max_vueltas',      6,
    'max_lineas',       20,
    'max_piezas_linea', 2000,
    'avisar_a',         jsonb_build_array(),
    'avisos_por_dia',   2,
    'mensaje_apagado',  'Ahorita no te puedo atender por aqui. Escribenos en crunchypaps.mx y te respondemos.'
  ) || coalesce(
    (select valor from public.config_produccion where clave = 'agente_whatsapp'),
    '{}'::jsonb);
$$;

revoke all on function public.wa_ajustes() from public, anon, authenticated;
grant execute on function public.wa_ajustes() to service_role;

-- ── Escritura ───────────────────────────────────────────────────────────────
-- Solo el dueno, como `set_rutas`. Y con RANGOS: un tope global de 999999 por
-- un cero de mas no es un ajuste, es una factura. Las claves que no vengan se
-- conservan, igual que set_rutas conserva `dias_preventa`.
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
  -- clave -> [minimo, maximo]. Fuera de rango, se rechaza con el nombre de la
  -- clave: un error que no dice cual de once numeros esta mal no sirve de nada.
  v_rangos jsonb := jsonb_build_object(
    'tope_por_numero',  jsonb_build_array(1, 500),
    'tope_global',      jsonb_build_array(1, 5000),
    'max_turnos',       jsonb_build_array(2, 100),
    'max_vueltas',      jsonb_build_array(1, 12),
    'max_lineas',       jsonb_build_array(1, 50),
    'max_piezas_linea', jsonb_build_array(1, 100000),
    'avisos_por_dia',   jsonb_build_array(0, 50)
  );
begin
  -- OJO a la firma: es sesion_es_dueno(p_token text), NO sin argumentos. PL/pgSQL
  -- no valida nombres al CREAR la funcion (regla 22), asi que escribirlo mal se
  -- crea sin una queja y revienta en la primera llamada. El token viaja dentro de
  -- p_data, como en /retos y /radar.
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'solo_el_dueno');
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

  -- El modelo es lista blanca, no texto libre: un nombre mal escrito no se
  -- descubre al guardarlo, se descubre cuando un cliente escribe y la API
  -- devuelve 404 (y el agente contesta que se le trabo el sistema).
  if p_data ? 'modelo' and (p_data->>'modelo') not in
     ('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5') then
    return jsonb_build_object('ok', false, 'error', 'modelo_desconocido',
      'permitidos', jsonb_build_array('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'));
  end if;
  if p_data ? 'effort' and (p_data->>'effort') not in ('low', 'medium', 'high') then
    return jsonb_build_object('ok', false, 'error', 'effort_desconocido');
  end if;
  if p_data ? 'avisar_a' and jsonb_typeof(p_data->'avisar_a') <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'avisar_a_no_es_lista');
  end if;

  v_actual := coalesce(
    (select valor from public.config_produccion where clave = 'agente_whatsapp'), '{}'::jsonb);
  -- El token NO se guarda: es credencial, no ajuste. Guardarlo lo dejaria en una
  -- tabla que lee media app.
  v_nuevo := v_actual || (p_data - 'token');

  insert into public.config_produccion (clave, valor)
  values ('agente_whatsapp', v_nuevo)
  on conflict (clave) do update set valor = excluded.valor;

  return jsonb_build_object('ok', true, 'ajustes', public.wa_ajustes());
end;
$$;

revoke all on function public.set_wa_ajustes(jsonb) from public, anon, authenticated;
grant execute on function public.set_wa_ajustes(jsonb) to anon, authenticated, service_role;

comment on function public.wa_ajustes() is
  'Ajustes del agente de WhatsApp, completos: las claves que falten salen con su valor por '
  'defecto. Solo service_role. El codigo de api/whatsapp.js trae los mismos valores y los usa '
  'si esto no contesta.';
comment on function public.set_wa_ajustes(jsonb) is
  'Cambia los ajustes del agente. Solo el dueno. Valida rangos y lista blanca de modelo; '
  'las claves que no vengan se conservan.';
