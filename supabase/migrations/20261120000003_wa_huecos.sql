-- ============================================================================
--  Lo que el agente no supo contestar queda apuntado
--
--  Diseno: cambios/2026-11-20-el-equipo-completo.md
--
--  DOS COSAS QUE RESULTARON SER UNA.
--
--  1) Idea de Abraham el 20 nov 2026: «Las preguntas que no pueda resolver al
--     dueño del negocio, dejar registro y estructurar una rutina de
--     entrenamiento para que cada vez tenga mayor alcance».
--
--  2) Un error que aparecio ese mismo dia a las 18:17, usandolo de verdad:
--     Abraham pregunto «cuando fue el ultimo dia que vendimos?», el agente no
--     tenia herramienta, y **ESCALO** con `pasar_con_una_persona`. Consecuencias
--     en cadena: el aviso interno salio a SU PROPIO numero -porque `avisar_a` es
--     el suyo-, y escalar **calla la conversacion 8 horas**. Su siguiente
--     mensaje no recibio nada y no lo habria recibido hasta las 02:17.
--
--     El dueño pregunto algo, el robot se lo reenvio al dueño, y despues dejo de
--     hablarle al dueño. Cada pieza hacia lo correcto por separado.
--
--  EL ARREGLO ES EL MISMO PARA LAS DOS: al dueño no se le ofrece escalar -el ES
--  el equipo-; en su lugar dice llanamente que no puede y **apunta el hueco**.
--
--  NO SE DEDUPLICA, A PROPOSITO. Si pregunta lo mismo cinco veces, son cinco
--  filas: la FRECUENCIA es la señal de que esa herramienta hace falta. Agrupar
--  al escribir perderia justo el dato que decide que construir.
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

create table if not exists public.agente_huecos (
  id           bigserial primary key,
  agente       text        not null references public.agentes(clave),
  telefono     text,
  quien        text,
  pregunta     text        not null,
  que_falta    text        not null,
  fecha        timestamptz not null default now(),
  resuelto_en  timestamptz,
  nota         text
);

create index if not exists ix_agente_huecos_fecha on public.agente_huecos (fecha desc);

comment on table public.agente_huecos is
  'Preguntas que un agente no pudo contestar por falta de herramienta. Es el '
  'guion de lo que hay que construir: no se deduplica porque la frecuencia es '
  'la señal.';

create or replace function public.wa_registrar_hueco(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id       bigint;
  v_agente   text := coalesce(nullif(btrim(p_data->>'agente'), ''), 'whatsapp');
  v_pregunta text := nullif(btrim(coalesce(p_data->>'pregunta', '')), '');
  v_falta    text := nullif(btrim(coalesce(p_data->>'queFalta', '')), '');
begin
  if v_pregunta is null or v_falta is null then
    return jsonb_build_object('ok', false, 'error', 'faltan_datos');
  end if;
  if not exists (select 1 from public.agentes where clave = v_agente) then
    return jsonb_build_object('ok', false, 'error', 'agente_desconocido');
  end if;

  insert into public.agente_huecos (agente, telefono, quien, pregunta, que_falta)
  values (v_agente, p_data->>'telefono', p_data->>'quien',
          left(v_pregunta, 500), left(v_falta, 500))
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id,
    -- Cuantas veces se ha pedido ya lo mismo, por si el agente quiere decirlo.
    'vecesEsteMes', (select count(*) from public.agente_huecos
                      where agente = v_agente and fecha > now() - interval '30 days'));
end;
$$;

revoke all on function public.wa_registrar_hueco(jsonb) from public, anon, authenticated;
grant execute on function public.wa_registrar_hueco(jsonb) to service_role;

alter table public.agente_huecos enable row level security;
revoke all on public.agente_huecos from anon, authenticated;
