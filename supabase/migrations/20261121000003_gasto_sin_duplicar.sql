-- ============================================================================
--  Que el mismo mensaje no escriba dos gastos, y que la foto no se pierda
--
--  Diseno: cambios/2026-11-21-capturar-el-gasto.md
--
--  LO ESCRIBIO UN FALLO REAL. El 21 nov 2026 a las 13:41:53, el primer gasto
--  capturado por WhatsApp se escribio DOS VECES -filas 7 y 8, 110 ms de
--  diferencia-: el modelo pidio `registrar_gasto` dos veces en la MISMA
--  respuesta (`usadas: ["registrar_gasto","registrar_gasto"]`) y el bucle
--  ejecuta todas las que pida. Nada en el servidor lo impedia.
--
--  No se arregla pidiendole al modelo que no lo haga. Un modelo que llama dos
--  veces es un caso normal -la API permite herramientas en paralelo- y una
--  instruccion no es una cerradura (regla 35). Se arregla donde se escribe.
--
--  DOS PIEZAS:
--
--  1. `wa_mensaje_id` + indice unico parcial. Las dos llamadas vienen del
--     MISMO mensaje de WhatsApp, asi que comparten id. La segunda choca con
--     el indice, y en vez de reventar devuelve el gasto que ya existe: para
--     el modelo es exito, y la fila es una sola.
--
--  2. `ticket_pendiente` en la conversacion. La foto llega en un mensaje y la
--     confirmacion dos mensajes despues; la ruta del archivo solo existia en
--     la invocacion que traia la imagen, asi que el gasto quedaba SIN ticket
--     -paso: la foto esta en Storage y `ticket_url` salio null-. Ahora la ruta
--     se aparca en la conversacion al llegar la foto y el gasto la consume.
--     El modelo nunca ve una ruta de archivo, que no es asunto suyo.
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

-- ── 1. De que mensaje vino cada gasto ──────────────────────────────────────
alter table public.gastos add column if not exists wa_mensaje_id text;

comment on column public.gastos.wa_mensaje_id is
  'Id del mensaje de WhatsApp que lo origino. Sirve de cerradura: dos llamadas '
  'a la herramienta dentro del mismo mensaje escriben UNA fila.';

-- Parcial, para no estorbar a los gastos de la pantalla, que no traen mensaje.
create unique index if not exists idx_gastos_wa_mensaje
  on public.gastos (wa_mensaje_id) where wa_mensaje_id is not null;

-- ── 2. La foto espera a que la confirmen ───────────────────────────────────
alter table public.wa_conversaciones
  add column if not exists ticket_pendiente text;

comment on column public.wa_conversaciones.ticket_pendiente is
  'Ruta en Storage de la ultima foto de ticket recibida, a la espera de que se '
  'confirme el gasto. Se consume al registrarlo. El modelo no la ve nunca.';

create or replace function public.wa_guardar_ticket_pendiente(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tel  text := regexp_replace(coalesce(p_data->>'telefono',''), '[^0-9]', '', 'g');
  v_ruta text := nullif(trim(coalesce(p_data->>'ruta','')), '');
begin
  if v_tel = '' or v_ruta is null then
    return jsonb_build_object('ok', false, 'error', 'Faltan telefono o ruta');
  end if;
  update public.wa_conversaciones
     set ticket_pendiente = v_ruta
   where telefono = v_tel;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Conversacion no encontrada');
  end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.wa_guardar_ticket_pendiente(jsonb) from public, anon, authenticated;
grant execute on function public.wa_guardar_ticket_pendiente(jsonb) to service_role;

-- ── 3. La puerta de WhatsApp, con las dos piezas puestas ───────────────────
create or replace function public.wa_registrar_gasto(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tel    text := regexp_replace(coalesce(p_data->>'telefono',''), '[^0-9]', '', 'g');
  v_msg    text := nullif(trim(coalesce(p_data->>'idMensaje','')), '');
  v_ident  jsonb;
  v_vend   bigint;
  v_rol    text;
  v_sec    text[];
  v_nombre text;
  v_admin  boolean;
  v_ya     bigint;
  v_ticket text;
  v_c      jsonb := coalesce(p_data->'campos', '{}'::jsonb);
  v_dijo_si boolean := coalesce((p_data->>'aprobar')::boolean, false);
begin
  if v_tel = '' then
    return jsonb_build_object('ok', false, 'error', 'Sin telefono');
  end if;

  -- LA CERRADURA DEL DUPLICADO, antes de nada. Dos llamadas del mismo mensaje
  -- comparten `idMensaje`: la segunda encuentra la primera y devuelve SU id.
  -- Para el modelo es un exito -no reintenta-, y la fila es una sola.
  if v_msg is not null then
    select id into v_ya from public.gastos where wa_mensaje_id = v_msg limit 1;
    if v_ya is not null then
      return jsonb_build_object('ok', true, 'id', v_ya, 'creado', false,
                                'yaEstaba', true);
    end if;
  end if;

  v_ident := public.wa_identidad(v_tel);
  v_vend  := nullif(v_ident->>'idVendedor','')::bigint;
  v_rol   := v_ident->>'rol';

  if v_vend is null then
    return jsonb_build_object('ok', false, 'error', 'Quien escribe no es del equipo');
  end if;

  select v.secciones, v.nombre into v_sec, v_nombre
    from public.vendedores v where v.id = v_vend;
  if not ('gastos' = any(coalesce(v_sec, array[]::text[]))) then
    return jsonb_build_object('ok', false, 'error', 'Sin permiso de gastos');
  end if;

  -- EL MODELO NO ESCRIBE EL FLUJO DE APROBACION.
  v_c := v_c - 'estatus' - 'aprobado_por' - 'fecha_aprobacion' - 'motivo_rechazo';

  if (v_c->>'monto') is null or (v_c->>'monto')::numeric <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Falta el monto');
  end if;
  if coalesce(v_c->>'categoria','') = '' then
    return jsonb_build_object('ok', false, 'error', 'Falta la categoria');
  end if;

  -- LA FOTO QUE ESPERABA. La ruta la puso el servidor al recibir la imagen,
  -- no el modelo: el gasto se queda con su comprobante aunque la confirmacion
  -- llegue tres mensajes despues.
  select ticket_pendiente into v_ticket
    from public.wa_conversaciones where telefono = v_tel;
  if v_ticket is not null and coalesce(v_c->>'ticket_url','') = '' then
    v_c := v_c || jsonb_build_object('ticket_url', v_ticket);
  end if;

  v_admin := lower(trim(coalesce(v_rol,''))) in ('admin','administrador');
  if v_dijo_si and v_admin then
    v_c := v_c
      || jsonb_build_object('estatus', 'aprobado')
      || jsonb_build_object('aprobado_por', coalesce(v_nombre, 'Desconocido') || ' · WhatsApp')
      || jsonb_build_object('fecha_aprobacion', now()::text);
  end if;

  declare
    v_res jsonb;
    v_id  bigint;
  begin
    v_res := public.guardar_gasto_interno(v_vend, false, v_c, null);
    if (v_res->>'ok')::boolean is not true then
      return v_res;
    end if;
    v_id := (v_res->>'id')::bigint;

    -- Se sella con el mensaje DESPUES de escribir, y se suelta la foto: la
    -- siguiente que llegue no se pega a un gasto que no es suyo.
    if v_msg is not null then
      update public.gastos set wa_mensaje_id = v_msg where id = v_id;
    end if;
    if v_ticket is not null then
      update public.wa_conversaciones set ticket_pendiente = null where telefono = v_tel;
    end if;

    return v_res || jsonb_build_object('ticket', v_ticket is not null);
  end;
end $$;

revoke all on function public.wa_registrar_gasto(jsonb) from public, anon, authenticated;
grant execute on function public.wa_registrar_gasto(jsonb) to service_role;
