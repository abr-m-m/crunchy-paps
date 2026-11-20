-- ============================================================================
--  Los agentes reconocen al dueño
--
--  Diseno: cambios/2026-11-20-el-equipo-completo.md
--
--  `wa_identidad` solo miraba `clientes`. Mientras el numero de Abraham estuvo
--  ahi dentro, daba igual; el 20 nov 2026 se solto de `clientes` -su registro de
--  consumidor «Ana Maria Mora» paso a un telefono muerto- y el agente quedo
--  viendolo como un desconocido cualquiera. Dos consecuencias inmediatas:
--  el agente le habla como a un cliente nuevo, y **el siguiente mensaje suyo lo
--  daria de alta como prospecto**, metiendolo en la lista de tienditas por
--  visitar.
--
--  Su fila de dueño SIEMPRE existio, en otra tabla: `vendedores` id 1, rol
--  'Administrador'. Nadie la miraba desde aqui.
--
--  D6 NO SE TOCA, Y ES LO QUE MAS IMPORTA DE ESTA MIGRACION. `wa_identidad` es
--  quien decide el NIVEL DE PRECIO. El cambio es **estrictamente aditivo**: se
--  agregan campos nuevos y el `case` que calcula `nivel` queda **letra por letra
--  como estaba**. Si el rol entrara en ese case, un vendedor que ademas es
--  tendero cotizaria a otro precio y nadie se enteraria hasta la factura.
--  `tools/probar-wa-dueno.mjs` crea a proposito un cliente que TAMBIEN es
--  vendedor -el caso que nadie piensa en probar- y comprueba que su nivel sigue
--  saliendo de `clientes`.
--
--  QUIEN ES DUEÑO: rol `admin` o `administrador`, la misma regla que usa
--  `ruta_del_dia` para decidir quien ve todas las rutas. **`administrador2` NO
--  es dueño** aunque lo parezca: es un rol real del proyecto, con acceso a
--  armado, que no manda sobre todo. La prueba lo fija.
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

-- ── 1. wa_identidad tambien mira `vendedores` ───────────────────────────────
create or replace function public.wa_identidad(p_telefono text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tel text := right(regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g'), 10);
  v_cli clientes%rowtype;
  v_ven vendedores%rowtype;
  v_rol text;
  v_dueno boolean := false;
begin
  if length(v_tel) <> 10 then
    return jsonb_build_object('ok', false, 'error', 'telefono_invalido');
  end if;

  -- El dueño primero, porque hoy puede no estar en `clientes` en absoluto.
  -- Solo vendedores ACTIVOS: dar de baja a alguien tiene que quitarle esto.
  select * into v_ven from public.vendedores
   where activo
     and right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) = v_tel
   order by id
   limit 1;

  if v_ven.id is not null then
    v_rol   := lower(btrim(coalesce(v_ven.rol, '')));
    v_dueno := v_rol in ('admin', 'administrador');
  end if;

  select * into v_cli from clientes
   where right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) = v_tel
   limit 1;

  if v_cli.id is null then
    -- No es un error: es alguien que escribe por primera vez. Consumidor.
    return jsonb_build_object(
      'ok', true, 'esCliente', false, 'idCliente', null, 'nombre', v_ven.nombre,
      'nivel', 'consumidor', 'aprobadoB2B', false, 'idRuta', null,
      'esVendedor', v_ven.id is not null, 'esDueno', v_dueno,
      'rol', v_ven.rol, 'idVendedor', v_ven.id);
  end if;

  return jsonb_build_object(
    'ok', true,
    'esCliente', true,
    'idCliente', v_cli.id,
    'nombre', v_cli.nombre,
    'aprobadoB2B', coalesce(v_cli.aprobado_b2b, false),
    'idRuta', v_cli.id_ruta,
    -- ESTE `case` NO SE TOCO. Es el que decide el precio (D6).
    'nivel', case
      when not coalesce(v_cli.aprobado_b2b, false) then 'consumidor'
      when v_cli.tipo_id = 2 then 'restaurante'
      when v_cli.tipo_id = 3 then 'tienda'
      when v_cli.tipo_id = 4 then 'mayorista'
      else 'consumidor'
    end,
    -- Lo nuevo va APARTE, sin rozar lo de arriba.
    'esVendedor', v_ven.id is not null,
    'esDueno', v_dueno,
    'rol', v_ven.rol,
    'idVendedor', v_ven.id
  );
end;
$$;

revoke all on function public.wa_identidad(text) from public, anon, authenticated;
grant execute on function public.wa_identidad(text) to service_role;

-- ── 2. Un vendedor no es un prospecto ───────────────────────────────────────
-- Sin esto, el dueño se da de alta a si mismo en la lista de tienditas por
-- visitar en cuanto le escribe a su propio agente. Y con el, cualquiera del
-- equipo.
create or replace function public.wa_prospecto(p_telefono text, p_nombre text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tel   text := right(regexp_replace(coalesce(p_telefono, ''), '[^0-9]', '', 'g'), 10);
  v_nom   text := nullif(btrim(coalesce(p_nombre, '')), '');
  v_id    bigint;
  v_nuevo boolean := false;
begin
  if length(v_tel) <> 10 then
    return jsonb_build_object('ok', false, 'error', 'telefono_invalido');
  end if;

  -- NUEVO: el equipo no se prospecta a si mismo.
  if exists (select 1 from public.vendedores
              where activo
                and right(regexp_replace(coalesce(telefono, ''), '[^0-9]', '', 'g'), 10) = v_tel) then
    return jsonb_build_object('ok', true, 'esVendedor', true, 'esCliente', false,
                              'idProspecto', null, 'nuevo', false);
  end if;

  -- Un cliente no es un prospecto.
  if exists (select 1 from public.clientes
              where right(regexp_replace(coalesce(telefono, ''), '[^0-9]', '', 'g'), 10) = v_tel) then
    return jsonb_build_object('ok', true, 'esCliente', true, 'esVendedor', false,
                              'idProspecto', null, 'nuevo', false);
  end if;

  select id into v_id from public.prospectos
   where right(regexp_replace(coalesce(contacto_telefono, ''), '[^0-9]', '', 'g'), 10) = v_tel
   order by id
   limit 1;

  if v_id is null then
    insert into public.prospectos (nombre_negocio, contacto_nombre, contacto_telefono,
                                   origen, primer_wa_en, ultimo_wa_en)
    values (coalesce(v_nom, 'WhatsApp ' || v_tel), v_nom, v_tel,
            'whatsapp', now(), now())
    returning id into v_id;
    v_nuevo := true;
  else
    update public.prospectos
       set primer_wa_en        = coalesce(primer_wa_en, now()),
           ultimo_wa_en        = now(),
           fecha_actualizacion = now()
     where id = v_id;
  end if;

  return jsonb_build_object('ok', true, 'esCliente', false, 'esVendedor', false,
                            'idProspecto', v_id, 'nuevo', v_nuevo);
end;
$$;

revoke all on function public.wa_prospecto(text, text) from public, anon, authenticated;
grant execute on function public.wa_prospecto(text, text) to service_role;
