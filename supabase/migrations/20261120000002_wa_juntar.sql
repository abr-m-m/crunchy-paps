-- ============================================================================
--  Juntar los mensajes que llegan de golpe
--
--  Diseno: cambios/2026-11-20-juntar-mensajes.md
--
--  EL CASO QUE LO PROVOCO, en produccion el 20 nov 2026: Abraham mando «La
--  última producción» y «?» en el MISMO segundo, y el agente contesto DOS
--  veces, a las 17:40:41 y a las 17:40:42. Cada mensaje de WhatsApp dispara su
--  propia invocacion, asi que dos modelos pensaron a la vez sobre medias
--  preguntas. Abraham: «es muy comun que la gente de pronto no termine una
--  frase en un solo mensaje, sino en dos o tres».
--
--  En una conversacion suya es una rareza. En una COTIZACION es un precio
--  equivocado: «quiero 3 bolsas» + «de habanero» puede cotizarse con la primera
--  mitad.
--
--  COMO SE ARREGLA. Cada invocacion encola su texto y trata de tomar un TURNO
--  por conversacion. La que lo toma espera unos segundos, junta todo lo que
--  llego mientras tanto y contesta UNA vez; las demas solo encolan y se van.
--
--  EL TURNO CADUCA, y no es un detalle: si la invocacion muere a medias
--  -timeout, crash- un candado booleano dejaria la conversacion muda para
--  siempre. Por eso es una FECHA y no un `true`.
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

-- ── 1. La cola y el turno ───────────────────────────────────────────────────
alter table public.wa_conversaciones
  add column if not exists pendientes  jsonb not null default '[]'::jsonb,
  add column if not exists turno_hasta timestamptz;

comment on column public.wa_conversaciones.pendientes is
  'Mensajes entrantes todavia sin contestar, en el orden en que llegaron.';
comment on column public.wa_conversaciones.turno_hasta is
  'Hasta cuando alguien tiene el turno de contestar esta conversacion. NULL o '
  'pasado = libre. Es una FECHA y no un booleano para que una invocacion que '
  'muere a medias no deje la conversacion muda.';

-- ── 2. Encolar y pedir el turno ─────────────────────────────────────────────
-- Las dos cosas en una llamada, porque encolar SIEMPRE tiene que pasar aunque
-- el turno no se consiga: el que no contesta sigue siendo responsable de que su
-- texto no se pierda. Esa es la mitad que convierte este arreglo en un bug peor
-- que el original si se olvida.
create or replace function public.wa_tomar_turno(
  p_telefono text, p_texto text, p_segundos integer default 60)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_n integer;
begin
  if coalesce(btrim(p_telefono), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'telefono_vacio');
  end if;

  -- La fila puede no existir: es el primer mensaje de una conversacion nueva.
  -- Sin este upsert, el UPDATE de abajo afectaria 0 filas y la invocacion
  -- concluiria que no tiene el turno — y nadie contestaria nunca.
  insert into public.wa_conversaciones (telefono, pendientes)
  values (p_telefono, jsonb_build_array(coalesce(p_texto, '')))
  on conflict (telefono) do update
     set pendientes = coalesce(public.wa_conversaciones.pendientes, '[]'::jsonb)
                      || jsonb_build_array(coalesce(p_texto, ''));

  -- EL UPDATE CONDICIONAL ES LO QUE LO HACE ATOMICO: dos invocaciones compiten
  -- por la misma fila, la segunda espera a que la primera cometa y entonces
  -- reevalua el WHERE contra la fila ya actualizada. Solo una afecta una fila.
  update public.wa_conversaciones
     set turno_hasta = now() + make_interval(secs => greatest(coalesce(p_segundos, 60), 0))
   where telefono = p_telefono
     and (turno_hasta is null or turno_hasta < now());
  get diagnostics v_n = row_count;

  return jsonb_build_object('ok', true, 'tomado', v_n > 0);
end;
$$;

-- ── 3. Recoger lo encolado ──────────────────────────────────────────────────
-- Devuelve lo que habia y lo VACIA, en la misma transaccion: si devolviera sin
-- vaciar, la siguiente vuelta volveria a contestar lo mismo.
create or replace function public.wa_tomar_pendientes(
  p_telefono text, p_segundos integer default 60)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_p jsonb;
begin
  -- `for update` antes de leer: entre el select y el update podria entrar otro
  -- mensaje, y se perderia sin que nadie lo notara.
  select coalesce(pendientes, '[]'::jsonb) into v_p
    from public.wa_conversaciones where telefono = p_telefono for update;

  if v_p is null then
    return jsonb_build_object('ok', true, 'pendientes', '[]'::jsonb);
  end if;

  update public.wa_conversaciones
     set pendientes  = '[]'::jsonb,
         -- Se extiende el turno: el que recoge es el que va a trabajar.
         turno_hasta = now() + make_interval(secs => greatest(coalesce(p_segundos, 60), 0))
   where telefono = p_telefono;

  return jsonb_build_object('ok', true, 'pendientes', v_p);
end;
$$;

-- ── 4. Soltar el turno ──────────────────────────────────────────────────────
create or replace function public.wa_soltar_turno(p_telefono text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.wa_conversaciones set turno_hasta = null where telefono = p_telefono;
  return jsonb_build_object('ok', true);
end;
$$;

-- Regla 42: EXECUTE a PUBLIC por omision. Solo la llave de servicio.
revoke all on function public.wa_tomar_turno(text, text, integer)   from public, anon, authenticated;
revoke all on function public.wa_tomar_pendientes(text, integer)    from public, anon, authenticated;
revoke all on function public.wa_soltar_turno(text)                 from public, anon, authenticated;
grant execute on function public.wa_tomar_turno(text, text, integer) to service_role;
grant execute on function public.wa_tomar_pendientes(text, integer)  to service_role;
grant execute on function public.wa_soltar_turno(text)               to service_role;

-- ── 5. Cuanto se espera, es un ajuste ───────────────────────────────────────
-- 0 lo apaga y contesta al instante, que es el comportamiento de hoy: si esto
-- sale mal un sabado, apagarlo es un UPDATE y no un despliegue.
-- El maximo son 30 s porque la funcion tiene 60 de tope y el modelo ya gasta
-- entre 3 y 6 (medido el 20 nov en produccion).
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
    'avisos_por_dia',   jsonb_build_array(0, 50),
    'callar_horas',     jsonb_build_array(1, 72),
    'juntar_segundos',  jsonb_build_array(0, 30)
  );
$$;

grant execute on function public.wa_rangos() to anon, authenticated, service_role;
