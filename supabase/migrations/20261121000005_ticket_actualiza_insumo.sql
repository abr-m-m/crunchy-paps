-- ============================================================================
--  Un ticket de papa cuenta DOS cosas, no una
--
--  Diseno: cambios/2026-11-21-frente-a-costos.md
--
--  EL PROBLEMA QUE CIERRA. El 21 nov se sembro el costeo con la papa a $23,
--  dicho de palabra. Ese numero envejece: en dos meses la papa estara a otro
--  precio, nadie se va a acordar de venir a cambiarlo, y el margen que enseñe
--  el sistema sera falso sin avisar. Un dato que hay que mantener a mano no se
--  mantiene: ya lo probo `gastos`, con tres filas en un año.
--
--  LA FORMA DE QUE NO ENVEJEZCA es que se actualice solo cuando ocurre el
--  hecho. La foto del ticket de la papa ya entra por WhatsApp; de ese mismo
--  ticket salen DOS hechos distintos:
--
--    1. «salieron $1,380»              -> un gasto           (ya funcionaba)
--    2. «la papa esta a $23 el kilo»   -> un costo de insumo (esto)
--
--  Son dos cosas y se guardan en dos sitios, pero se capturan DE UNA VEZ,
--  porque pedirle a alguien que lo anote dos veces es pedirle que no lo anote.
--
--  LO QUE EL MODELO NO HACE, Y ES DELIBERADO:
--
--  * NO divide. Manda la cantidad y el importe de ESA linea del ticket; el
--    precio unitario lo saca el servidor. El prompt ya le prohibe calcular
--    totales y esta es la misma regla: una division mal hecha aqui se queda
--    en los libros como el costo de la papa.
--  * NO crea insumos. Solo puede poner precio a uno que YA existe en el
--    catalogo. Que la papa sea un insumo es una decision; que hoy valga 23 es
--    un hecho. El modelo captura hechos, no toma decisiones de catalogo.
--  * NO fecha en hoy si el ticket es de otro dia. El precio rige desde la
--    fecha del TICKET, que es cuando de verdad se compro.
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

-- ── Buscar un insumo por nombre, como lo diria una persona ──────────────────
-- 'PAPA', 'papa' y 'Papás' tienen que dar con el mismo. Sin esto, el agente
-- escribe 'Papa blanca' y el precio se pierde en silencio.
create or replace function public.insumo_por_nombre(p_nombre text)
returns bigint
language sql
stable
set search_path = public, pg_temp
as $$
  select i.id from public.insumos i
   where i.activo
     and translate(lower(trim(i.nombre)), 'áéíóúüñ', 'aeiouun')
       = translate(lower(trim(coalesce(p_nombre,''))), 'áéíóúüñ', 'aeiouun')
   limit 1;
$$;

revoke all on function public.insumo_por_nombre(text) from public, anon, authenticated;
grant execute on function public.insumo_por_nombre(text) to service_role, authenticated;

-- ── Poner el precio de un insumo desde una compra ───────────────────────────
create or replace function public.registrar_costo_insumo(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Dos nombres para lo mismo a proposito: la herramienta del agente manda
  --  dentro del bloque y una llamada directa manda . Aceptar
  -- los dos evita que un detalle de nomenclatura tire el dato -que es justo
  -- lo que paso la primera vez que se probo de punta a punta-.
  v_nombre   text    := nullif(trim(coalesce(p_data->>'insumo', p_data->>'nombre','')), '');
  v_cant     numeric := nullif(p_data->>'cantidad','')::numeric;
  v_importe  numeric := nullif(p_data->>'importe','')::numeric;
  v_fecha    date    := coalesce(nullif(p_data->>'fecha','')::date, current_date);
  v_quien    text    := coalesce(nullif(trim(coalesce(p_data->>'quien','')), ''), 'sistema');
  v_nota     text    := nullif(trim(coalesce(p_data->>'nota','')), '');
  v_id       bigint;
  v_unitario numeric;
  v_anterior numeric;
begin
  if v_nombre is null then
    return jsonb_build_object('ok', false, 'error', 'Falta el nombre del insumo');
  end if;
  if v_cant is null or v_cant <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Falta cuánto se compró');
  end if;
  if v_importe is null or v_importe <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Falta cuánto costó esa cantidad');
  end if;

  v_id := public.insumo_por_nombre(v_nombre);
  if v_id is null then
    -- No se crea: que algo sea un insumo es una decision, y se toma en la app.
    -- Se devuelven los que SI existen para que el agente pueda decir cuales hay.
    return jsonb_build_object(
      'ok', false,
      'error', 'No existe un insumo llamado «' || v_nombre || '»',
      'insumos', (select coalesce(jsonb_agg(i.nombre order by i.nombre), '[]'::jsonb)
                    from public.insumos i where i.activo));
  end if;

  -- LA DIVISION LA HACE EL SERVIDOR. El modelo manda cuanto y cuanto costo;
  -- el precio unitario sale de aqui, igual que el total de un pedido.
  v_unitario := round(v_importe / v_cant, 4);

  select c.costo_unidad into v_anterior
    from public.insumos_costos c
   where c.id_insumo = v_id and c.vigente_desde <= v_fecha
   order by c.vigente_desde desc limit 1;

  -- Unico por (insumo, fecha): dos compras del mismo insumo el mismo dia dejan
  -- el ultimo precio, que es el que se acaba de pagar.
  insert into public.insumos_costos (id_insumo, costo_unidad, vigente_desde, fuente, nota)
  values (v_id, v_unitario, v_fecha, 'capturado',
          coalesce(v_nota || ' · ', '') || 'Capturado por ' || v_quien ||
          ' desde una compra de ' || v_cant || ' por $' || v_importe || '.')
  on conflict (id_insumo, vigente_desde)
  do update set costo_unidad = excluded.costo_unidad, nota = excluded.nota;

  return jsonb_build_object(
    'ok', true,
    'idInsumo', v_id,
    'insumo', (select nombre from public.insumos where id = v_id),
    'unitario', v_unitario,
    'anterior', v_anterior,
    -- Para que el agente pueda DECIRLO: un salto grande de precio es noticia,
    -- y el costo de todo lo que se venda a partir de hoy cambia con el.
    'cambio_pct', case when v_anterior is null or v_anterior = 0 then null
                       else round((v_unitario - v_anterior) / v_anterior * 100, 1) end,
    'costoBaseKg', public.costo_base_kg(v_fecha));
end $$;

revoke all on function public.registrar_costo_insumo(jsonb) from public, anon, authenticated;
grant execute on function public.registrar_costo_insumo(jsonb) to service_role;

-- ── La puerta de WhatsApp lo hace en el mismo acto ──────────────────────────
-- `wa_registrar_gasto` gana un bloque `insumo` opcional. Si viene, escribe el
-- gasto Y el costo. Si el insumo no existe, el GASTO SE GUARDA IGUAL y se
-- avisa: perder el gasto por un nombre mal escrito seria peor.
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
  v_ins    jsonb := p_data->'insumo';
  v_resins jsonb;
  v_c      jsonb := coalesce(p_data->'campos', '{}'::jsonb);
  v_dijo_si boolean := coalesce((p_data->>'aprobar')::boolean, false);
begin
  if v_tel = '' then
    return jsonb_build_object('ok', false, 'error', 'Sin telefono');
  end if;

  -- LA CERRADURA DEL DUPLICADO, antes de nada.
  if v_msg is not null then
    select id into v_ya from public.gastos where wa_mensaje_id = v_msg limit 1;
    if v_ya is not null then
      return jsonb_build_object('ok', true, 'id', v_ya, 'creado', false, 'yaEstaba', true);
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

  v_c := v_c - 'estatus' - 'aprobado_por' - 'fecha_aprobacion' - 'motivo_rechazo';

  if (v_c->>'monto') is null or (v_c->>'monto')::numeric <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Falta el monto');
  end if;
  if coalesce(v_c->>'categoria','') = '' then
    return jsonb_build_object('ok', false, 'error', 'Falta la categoria');
  end if;

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

    if v_msg is not null then
      update public.gastos set wa_mensaje_id = v_msg where id = v_id;
    end if;
    if v_ticket is not null then
      update public.wa_conversaciones set ticket_pendiente = null where telefono = v_tel;
    end if;

    -- EL SEGUNDO HECHO. Va DESPUES de guardar el gasto y en su propio camino:
    -- si el nombre del insumo viene mal, el dinero ya quedo anotado.
    if v_ins is not null and v_ins <> 'null'::jsonb then
      v_resins := public.registrar_costo_insumo(
        v_ins || jsonb_build_object(
          'fecha', coalesce(v_c->>'fecha', current_date::text),
          'quien', coalesce(v_nombre, 'WhatsApp') || ' · WhatsApp',
          'nota', 'Del gasto ' || v_id));
    end if;

    return v_res
      || jsonb_build_object('ticket', v_ticket is not null)
      || case when v_resins is null then '{}'::jsonb
              else jsonb_build_object('costoInsumo', v_resins) end;
  end;
end $$;

revoke all on function public.wa_registrar_gasto(jsonb) from public, anon, authenticated;
grant execute on function public.wa_registrar_gasto(jsonb) to service_role;
