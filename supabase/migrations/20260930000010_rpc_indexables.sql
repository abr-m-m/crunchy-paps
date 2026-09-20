-- 19 sep 2026 — Rendimiento, punto 4 del diagnóstico (cambios/2026-09-19-rendimiento-diagnostico.md,
-- cambios/2026-09-19-rpc-indexables.md): dos RPC recorrían la tabla entera porque el filtro no podía usar
-- el índice. Misma firma, misma salida; solo cambia el filtro. Ninguno de los dos fijaba search_path
-- (regla 43): ahora sí. Los GRANT no se tocan (CREATE OR REPLACE los conserva).
--
-- 1. obtener_encuestas_cliente: comparaba RIGHT(REGEXP_REPLACE(c.telefono, …), 10) = …, una función sobre
--    la columna que anula clientes_telefono_key → Seq Scan en cada apertura con sesión. Todos los teléfonos
--    de clientes son de 10 dígitos (comprobado en staging y producción: 0 filas cuya normalización difiera
--    de la columna), así que c.telefono = RIGHT(<entrada normalizada>, 10) da lo mismo y usa el índice.
-- 2. get_tracking_pedido: WHERE consecutivo = p OR id::text = p anulaba los dos índices → Seq Scan en
--    ordenes. Ahora busca por consecutivo y, si no está y la entrada son solo dígitos, por id. Ningún
--    consecutivo es numérico ni coincide con el id de otro pedido (comprobado en los dos proyectos).
-- 3. track_functions = pl NO se puede: es un parámetro de superusuario y el rol postgres de Supabase no lo
--    es ("permission denied to set parameter track_functions", staging, 19 sep 2026). Se queda en none.

begin;

-- ── 1 ─────────────────────────────────────────────────────────────────────
create or replace function public.obtener_encuestas_cliente(p_data jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_tel_norm text;
  v_ids      jsonb;
begin
  v_tel_norm := regexp_replace(coalesce(p_data->>'telefono', ''), '\D', '', 'g');
  if v_tel_norm = '' then
    return jsonb_build_object('ok', true, 'idsEncuestadas', '[]'::jsonb);
  end if;

  -- 19 sep 2026: la columna se compara tal cual (índice); la entrada se sigue normalizando.
  select coalesce(jsonb_agg(e.id_orden), '[]'::jsonb)
    into v_ids
  from encuestas e
  join ordenes o  on o.id = e.id_orden
  join clientes c on c.id = o.id_cliente
  where c.telefono = right(v_tel_norm, 10);

  return jsonb_build_object('ok', true, 'idsEncuestadas', v_ids);
end;
$fn$;

-- ── 2 ─────────────────────────────────────────────────────────────────────
create or replace function public.get_tracking_pedido(p_id_orden text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_orden  ordenes%rowtype;
  v_items  jsonb;
  v_mapa_estatus jsonb := '{
    "pendiente":      "Recibido",
    "confirmado":     "Recibido",
    "en proceso":     "En preparación",
    "en preparacion": "En preparación",
    "en preparación": "En preparación",
    "listo":          "En preparación",
    "en camino":      "En camino",
    "entregado":      "Entregado",
    "cancelado":      "Cancelado"
  }'::jsonb;
  v_est_int text;
  v_est_cli text;
begin
  -- 19 sep 2026: primero por consecutivo (índice único); si no está y la entrada son solo
  -- dígitos, por id (clave primaria). Antes: consecutivo = p OR id::text = p, sin índice.
  select * into v_orden from ordenes where consecutivo = p_id_orden;
  if not found and p_id_orden ~ '^[0-9]{1,18}$' then
    select * into v_orden from ordenes where id = p_id_orden::bigint;
  end if;

  if v_orden.id is null then
    return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado');
  end if;

  v_est_int := lower(coalesce(v_orden.estatus_pedido, 'pendiente'));
  v_est_cli := coalesce(v_mapa_estatus->>v_est_int, 'Recibido');

  -- Items
  select coalesce(jsonb_agg(jsonb_build_object(
    'sabor', sabor,
    'presentacion', presentacion,
    'cantidad', cantidad,
    'modo', case when tipo_venta = 'A granel' then 'granel' else 'pieza' end,
    'subtotal', subtotal,
    'gramos', gramos_vendidos
  )), '[]'::jsonb) into v_items
  from ordenes_detalle where id_orden = v_orden.id;

  return jsonb_build_object(
    'ok', true,
    'pedido', jsonb_build_object(
      'id', v_orden.id,
      'consecutivo', v_orden.consecutivo,
      'nombreCliente', v_orden.nombre_cliente,
      'fecha', v_orden.fecha_orden,
      'fechaEntrega', v_orden.fecha_entrega,
      'fechaEntregaReal', v_orden.fecha_entrega_real,
      'total', v_orden.total,
      'subtotal', v_orden.subtotal,
      'descuento', v_orden.descuento,
      'cuponCodigo', v_orden.cupon_codigo,
      'estatusInterno', v_orden.estatus_pedido,
      'estatusCliente', v_est_cli,
      'estatusPago', v_orden.estatus_pago,
      'tipoPago', v_orden.tipo_pago,
      'canal', v_orden.canal,
      'direccion', v_orden.direccion,
      'colonia', v_orden.colonia,
      'cp', v_orden.cp,
      'coordenadas', v_orden.coordenadas,
      'notas', v_orden.notas,
      'nombreVendedor', v_orden.nombre_vendedor,
      'tipoInterno', v_orden.tipo_interno,
      'items', v_items
    )
  );
end;
$fn$;

commit;
