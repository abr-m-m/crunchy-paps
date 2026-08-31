-- ============================================================================
--  ETAPA B — Cerrar las ESCRITURAS de `ordenes` y `prospectos`
--            y retirar todo privilegio que la app no use
-- ----------------------------------------------------------------------------
--  Contexto: producción NO tiene respaldos automáticos (plan gratuito). Con
--  `ordenes`, `ordenes_detalle` y `prospectos` abiertas a DELETE para `anon`,
--  cualquiera con la llave publicada podía borrar las 67 órdenes y los 1.132
--  prospectos SIN VUELTA ATRÁS. Esta migración quita eso.
--
--  ── PARTE 1: retirar privilegios que la app nunca usa ──────────────────────
--  Se inventarió, tabla por tabla, qué verbos usa `index.html`:
--
--    TABLA                GET POST PATCH DELETE   se revoca
--    ordenes               3    0    2     0      INSERT, DELETE
--    ordenes_detalle       6    0    0     0      INSERT, UPDATE, DELETE
--    prospectos            2    1    3     0      DELETE
--    gastos_insumos        0    1    0     0      UPDATE, DELETE
--    jornadas              2    1    2     0      DELETE
--    lotes_produccion      7    0    3     0      INSERT, DELETE
--    produccion_diaria     2    0    2     0      INSERT, DELETE
--    productos             2    0    1     0      INSERT, DELETE
--    productos_bebidas     3    1    2     0      DELETE
--    stock_terminado       3    1    0     1      UPDATE
--    cupones               1    1    1     0      DELETE
--
--  DELETE desaparece de 9 de 11 tablas sin tocar una línea de la app. Con RLS
--  activo y una política permisiva, el GRANT es la cerradura efectiva: sin
--  privilegio no se escribe, diga lo que diga la política.
--
--  ── PARTE 2: las escrituras que sí existen, tras sesión ────────────────────
--  Los 6 puntos de escritura de `ordenes` y `prospectos` pasan a RPCs con
--  sesión y sección, y con LISTA BLANCA DE COLUMNAS. Eso cierra algo que hoy es
--  posible aunque no lo haga la app: modificar el `total` de un pedido.
--
--  ── LO QUE ESTA MIGRACIÓN NO HACE ──────────────────────────────────────────
--  Las LECTURAS de `ordenes`, `ordenes_detalle` y `prospectos` siguen abiertas.
--  Son 15 puntos de llamada con formas muy variadas (filtros, listas de ids,
--  agregaciones y un join embebido) y necesitan ~9 RPCs nuevos. Hacerlo con
--  prisa justo antes de un despliegue a producción es mala idea. Queda como el
--  siguiente trabajo, y hasta entonces la exposición de privacidad sigue igual
--  que hoy — ni mejor ni peor.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
--  PARTE 1 — Retirar privilegios sin uso
-- ────────────────────────────────────────────────────────────────────────────
revoke insert, delete, truncate on public.ordenes            from anon;
revoke insert, update, delete, truncate on public.ordenes_detalle from anon;
revoke delete, truncate on public.prospectos                 from anon;
revoke update, delete, truncate on public.gastos_insumos     from anon;
revoke delete, truncate on public.jornadas                   from anon;
revoke insert, delete, truncate on public.lotes_produccion   from anon;
revoke insert, delete, truncate on public.produccion_diaria  from anon;
revoke insert, delete, truncate on public.productos          from anon;
revoke delete, truncate on public.productos_bebidas          from anon;
revoke update, truncate on public.stock_terminado            from anon;
revoke delete, truncate on public.cupones                    from anon;

-- ────────────────────────────────────────────────────────────────────────────
--  PARTE 2 — Escrituras de `ordenes` tras sesión, con lista blanca
-- ────────────────────────────────────────────────────────────────────────────
--  Sustituye los dos `PATCH ordenes?...` del panel: cambiar una fecha y
--  corregir el método de pago. La lista blanca es lo importante: `total`,
--  `subtotal` y `descuento` NO son modificables por esta vía, ni siquiera por
--  un admin. Para eso están los RPCs de negocio, que recalculan.
create or replace function public.actualizar_campos_pedido(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id_vend   bigint;
  v_ref       text   := coalesce(p_data->>'idOrden', '');
  v_campos    jsonb  := coalesce(p_data->'campos', '{}'::jsonb);
  v_id        bigint;
  v_clave     text;
  v_permitidas constant text[] := array[
    'fecha_entrega', 'fecha_entrega_real', 'fecha_pago',
    'tipo_pago', 'tipo_pago_id', 'actualizado_por', 'notas'
  ];
begin
  select s.id_vendedor into v_id_vend
    from public.sesion_exige_seccion(p_data->>'token', 'pedidos') s;
  if v_id_vend is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  if v_ref = '' then
    return jsonb_build_object('ok', false, 'error', 'Falta idOrden');
  end if;

  -- Rechazar cualquier columna fuera de la lista. Se falla en vez de ignorar en
  -- silencio: si la app manda algo inesperado, queremos enterarnos.
  for v_clave in select jsonb_object_keys(v_campos) loop
    if not (v_clave = any(v_permitidas)) then
      return jsonb_build_object('ok', false,
        'error', 'Campo no permitido: ' || v_clave);
    end if;
  end loop;

  -- La referencia puede venir como id numérico o como consecutivo.
  if v_ref ~ '^[0-9]+$' then
    select o.id into v_id from public.ordenes o where o.id = v_ref::bigint;
  else
    select o.id into v_id from public.ordenes o where o.consecutivo = v_ref;
  end if;

  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado');
  end if;

  update public.ordenes o set
    fecha_entrega      = case when v_campos ? 'fecha_entrega'      then (v_campos->>'fecha_entrega')::timestamptz      else o.fecha_entrega      end,
    fecha_entrega_real = case when v_campos ? 'fecha_entrega_real' then (v_campos->>'fecha_entrega_real')::timestamptz else o.fecha_entrega_real end,
    fecha_pago         = case when v_campos ? 'fecha_pago'         then (v_campos->>'fecha_pago')::timestamptz         else o.fecha_pago         end,
    tipo_pago          = case when v_campos ? 'tipo_pago'          then  v_campos->>'tipo_pago'                        else o.tipo_pago          end,
    tipo_pago_id       = case when v_campos ? 'tipo_pago_id'       then (v_campos->>'tipo_pago_id')::int               else o.tipo_pago_id       end,
    actualizado_por    = case when v_campos ? 'actualizado_por'    then  v_campos->>'actualizado_por'                  else o.actualizado_por    end,
    notas              = case when v_campos ? 'notas'              then  v_campos->>'notas'                            else o.notas              end
  where o.id = v_id;

  return jsonb_build_object('ok', true, 'idOrden', v_id);
end;
$$;

revoke update on public.ordenes from anon;

-- ────────────────────────────────────────────────────────────────────────────
--  PARTE 3 — Escrituras de `prospectos` tras sesión
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.crear_prospecto(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id_vend bigint;
  v_rol     text;
  v_nuevo   bigint;
begin
  select s.id_vendedor, s.rol into v_id_vend, v_rol
    from public.sesion_exige_seccion(p_data->>'token', 'prospeccion') s;
  if v_id_vend is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  if coalesce(p_data->>'nombre_negocio', '') = '' then
    return jsonb_build_object('ok', false, 'error', 'Falta nombre del negocio');
  end if;

  -- El vendedor sale de la SESIÓN, no del payload: nadie registra prospectos a
  -- nombre de otro.
  insert into public.prospectos (
    nombre_negocio, tipo_negocio, contacto_nombre, contacto_telefono, email,
    direccion, colonia, codigo_postal, municipio, estado,
    latitud, longitud, coordenadas, distancia_metros, score, notas,
    estatus, num_visitas, fecha_visita, origen,
    id_vendedor, nombre_vendedor
  )
  values (
    p_data->>'nombre_negocio',
    p_data->>'tipo_negocio',
    p_data->>'contacto_nombre',
    p_data->>'contacto_telefono',
    p_data->>'email',
    p_data->>'direccion',
    p_data->>'colonia',
    p_data->>'codigo_postal',
    p_data->>'municipio',
    p_data->>'estado',
    (p_data->>'latitud')::numeric,
    (p_data->>'longitud')::numeric,
    p_data->>'coordenadas',
    (p_data->>'distancia_metros')::numeric,
    coalesce((p_data->>'score')::int, 0),
    p_data->>'notas',
    coalesce(nullif(p_data->>'estatus', ''), 'contactado'),
    coalesce((p_data->>'num_visitas')::int, 1),
    coalesce((p_data->>'fecha_visita')::timestamptz, now()),
    coalesce(nullif(p_data->>'origen', ''), 'app'),
    v_id_vend,
    (select v.nombre from public.vendedores v where v.id = v_id_vend)
  )
  returning id into v_nuevo;

  return jsonb_build_object('ok', true, 'id', v_nuevo);
end;
$$;

create or replace function public.actualizar_prospecto(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id_vend bigint;
  v_id      bigint := (p_data->>'id')::bigint;
  v_campos  jsonb  := coalesce(p_data->'campos', '{}'::jsonb);
  v_clave   text;
  v_permitidas constant text[] := array[
    'estatus', 'num_visitas', 'fecha_visita', 'notas', 'score',
    'motivo_descarte', 'fecha_descarte', 'contacto_nombre', 'contacto_telefono'
  ];
begin
  select s.id_vendedor into v_id_vend
    from public.sesion_exige_seccion(p_data->>'token', 'prospeccion') s;
  if v_id_vend is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'Falta id');
  end if;

  for v_clave in select jsonb_object_keys(v_campos) loop
    if not (v_clave = any(v_permitidas)) then
      return jsonb_build_object('ok', false,
        'error', 'Campo no permitido: ' || v_clave);
    end if;
  end loop;

  update public.prospectos p set
    estatus           = case when v_campos ? 'estatus'           then  v_campos->>'estatus'                       else p.estatus           end,
    num_visitas       = case when v_campos ? 'num_visitas'       then (v_campos->>'num_visitas')::int             else p.num_visitas       end,
    fecha_visita      = case when v_campos ? 'fecha_visita'      then (v_campos->>'fecha_visita')::timestamptz    else p.fecha_visita      end,
    notas             = case when v_campos ? 'notas'             then  v_campos->>'notas'                         else p.notas             end,
    score             = case when v_campos ? 'score'             then (v_campos->>'score')::int                   else p.score             end,
    motivo_descarte   = case when v_campos ? 'motivo_descarte'   then  v_campos->>'motivo_descarte'               else p.motivo_descarte   end,
    fecha_descarte    = case when v_campos ? 'fecha_descarte'    then (v_campos->>'fecha_descarte')::timestamptz  else p.fecha_descarte    end,
    contacto_nombre   = case when v_campos ? 'contacto_nombre'   then  v_campos->>'contacto_nombre'               else p.contacto_nombre   end,
    contacto_telefono = case when v_campos ? 'contacto_telefono' then  v_campos->>'contacto_telefono'             else p.contacto_telefono end,
    -- Quien toca el prospecto queda registrado a partir de la sesión.
    id_vendedor       = v_id_vend,
    nombre_vendedor   = (select v.nombre from public.vendedores v where v.id = v_id_vend)
  where p.id = v_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Prospecto no encontrado');
  end if;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

revoke insert, update on public.prospectos from anon;

comment on table public.ordenes is
  'RLS Etapa B (31 ago 2026): anon conserva SELECT (pendiente de cerrar). Escritura solo por RPCs: crear_pedido, actualizar_estatus_pedido, actualizar_campos_pedido. total/subtotal/descuento NO son modificables por PATCH.';
comment on table public.prospectos is
  'RLS Etapa B (31 ago 2026): anon conserva SELECT (pendiente de cerrar). Escritura solo por RPCs: crear_prospecto, actualizar_prospecto, importar_prospectos_bulk.';
