-- 18 sep 2026 — Crunchy Club, fase 2: tienda de canje (cambios/2026-09-18-club/diseno-canje.md).
-- Decidido por Abraham: catálogo de canje como Premia Juntos+ de FEMSA, solo piezas y abierto a otros
-- productos; consumidores y tiendas; máximo 5 piezas por pedido; un pedido nunca es solo de canje; al
-- cancelar, los puntos canjeados regresan solo después de una validación (un agente la propone y se
-- resuelve por RPC).
--
-- 1. productos.canje_activo / puntos_canje; ordenes.puntos_canjeados / descuento_puntos;
--    ordenes_detalle.puntos_canje.
-- 2. puntos_de_canje(id): puntos_canje propio, o precio_consumidor ÷ valor del punto hacia arriba a la
--    decena. canje_catalogo(): lo que ve la tienda de canje, con la misma fórmula que cobra el servidor.
-- 3. crear_pedido: líneas con canje:true (ver 3b y 8b en la función).
-- 4. canje_devoluciones: una solicitud por pedido cancelado con canje; revertir_puntos_al_cancelar la
--    crea. resolver_devolucion_canje(_interno) la aprueba (asiento 'devolucion') o la rechaza.
-- 5. mis_puntos devuelve también las devoluciones en revisión.

begin;

-- 1) Columnas
alter table public.productos add column if not exists canje_activo boolean not null default false;
alter table public.productos add column if not exists puntos_canje integer;
alter table public.productos add column if not exists orden_canje integer;
comment on column public.productos.canje_activo is 'Sale en la tienda de canje del Crunchy Club (fase 2, 18 sep 2026).';
comment on column public.productos.orden_canje is 'Orden en la tienda de canje (menor primero); nulo = el orden del catálogo (productos.orden).';
comment on column public.productos.puntos_canje is 'Precio en puntos propio; nulo = precio_consumidor / valor del punto, hacia arriba a la decena.';
alter table public.ordenes add column if not exists puntos_canjeados integer not null default 0;
alter table public.ordenes add column if not exists descuento_puntos numeric not null default 0;
alter table public.ordenes_detalle add column if not exists puntos_canje integer not null default 0;

-- Las papas por pieza entran a la tienda de canje (tipo_venta 1 = pieza; 2 = granel).
update public.productos set canje_activo = true
 where tipo_venta::text = '1' and coalesce(activo, true) and not coalesce(descontinuado, false) and not canje_activo;

-- 2) Precio en puntos y catálogo
create or replace function public.puntos_de_canje(p_id bigint) returns integer
language sql stable security definer set search_path = public, extensions, pg_temp as $fn$
  select coalesce(nullif(p.puntos_canje, 0),
           (ceil(p.precio_consumidor / nullif((select (valor->'redencion'->>'valor_punto_mxn')::numeric
                                                  from config_produccion where clave = 'lealtad'), 0) / 10.0) * 10)::integer)
    from productos p where p.id = p_id
$fn$;
revoke all on function public.puntos_de_canje(bigint) from public;

create or replace function public.canje_catalogo() returns jsonb
language sql stable security definer set search_path = public, extensions, pg_temp as $fn$
  select jsonb_build_object('ok', true, 'maxPiezas', 5,
    'productos', coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'sabor', p.sabor, 'presentacion', p.presentacion, 'gramos', p.gramos,
        'imagen', p.imagen_url, 'puntos', public.puntos_de_canje(p.id))
      order by coalesce(p.orden_canje, p.orden) nulls last, p.gramos, p.sabor), '[]'::jsonb))
    from productos p
   where p.canje_activo and coalesce(p.activo, true) and not coalesce(p.descontinuado, false)
     and public.puntos_de_canje(p.id) > 0
$fn$;
revoke all on function public.canje_catalogo() from public;
grant execute on function public.canje_catalogo() to anon, authenticated;

-- 3) crear_pedido con canje
CREATE OR REPLACE FUNCTION public.crear_pedido(p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_idempotency  TEXT;
  v_existente    ordenes%ROWTYPE;
  v_id_orden     BIGINT;
  v_consec       TEXT;
  v_canal        TEXT;
  v_tipo_int     TEXT;
  v_estatus_ped  TEXT;
  v_estatus_pag  TEXT;
  v_fecha_pago   TIMESTAMPTZ;
  v_producto     JSONB;
  v_id_cliente   BIGINT;
  v_telefono     TEXT;
  v_nombre_cli   TEXT;
  v_filas_det    INTEGER := 0;

  v_id_vend_ses  BIGINT;
  v_tel_ses      TEXT;
  v_cli          clientes%ROWTYPE;
  v_nivel        TEXT;

  v_p            productos%ROWTYPE;
  v_pid          TEXT;
  v_tv           TEXT;
  v_cant         NUMERIC;
  v_gram         NUMERIC;
  v_base         NUMERIC;
  v_pct          NUMERIC;
  v_pkg          NUMERIC;
  v_unit         NUMERIC;
  v_sub_linea    NUMERIC;
  v_caja         INTEGER;   -- CAJA: piezas por caja de la línea (0 = por pieza)
  v_pcaja        NUMERIC;   -- CAJA: precio propio de esa caja, si existe

  v_sub          NUMERIC := 0;
  v_desc         NUMERIC := 0;
  v_envio        NUMERIC := 0;
  v_desc_envio   NUMERIC := 0;
  v_total        NUMERIC := 0;
  v_declarado    NUMERIC;

  v_cod_cupon    TEXT;
  v_cupon        JSONB;
  v_tipo_cup     TEXT;
  v_valor_cup    NUMERIC;

  v_calc         JSONB := '[]'::JSONB;   -- líneas recotizadas por el servidor

  -- CANJE (Club fase 2): piezas pagadas con puntos. Valen $0 en el subtotal y descuentan del
  -- saldo en esta misma transacción.
  v_es_canje     BOOLEAN;
  v_pts_unit     INTEGER;
  v_pts_canje    INTEGER := 0;
  v_pzs_canje    INTEGER := 0;
  v_lineas_pago  INTEGER := 0;
  v_valor_punto  NUMERIC;
  v_cli_canje    BIGINT;
  v_saldo        INTEGER;
BEGIN
  v_idempotency := COALESCE(p_data->>'idempotencyKey', '');
  v_canal       := COALESCE(p_data->>'canal', 'web');
  v_tipo_int    := COALESCE(p_data->>'tipoInterno', '');
  v_id_cliente  := NULLIF(p_data->>'idCliente', '')::BIGINT;
  v_telefono    := p_data->>'telefono';
  v_nombre_cli  := COALESCE(p_data->>'nombreCliente', '');
  v_cod_cupon   := UPPER(COALESCE(p_data->>'cuponCodigo', ''));

  -- ── 0) IDENTIDAD ────────────────────────────────────────────────────────
  SELECT s.id_vendedor INTO v_id_vend_ses
    FROM public.resolver_sesion_vendedor(p_data->>'token') s;
  v_tel_ses := public.resolver_sesion_cliente(p_data->>'tokenCliente');

  IF v_id_vend_ses IS NULL AND v_tel_ses IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sesion_requerida',
      'mensaje', 'Verifica tu teléfono para completar el pedido');
  END IF;

  IF v_tipo_int <> '' AND v_id_vend_ses IS NULL THEN
    RETURN jsonb_build_object('ok', false,
      'error', 'Un pedido interno requiere sesión de vendedor');
  END IF;

  IF v_canal = 'mostrador' AND v_id_vend_ses IS NULL THEN
    v_canal := 'web';
  END IF;

  -- ── 1) NIVEL DE PRECIO ──────────────────────────────────────────────────
  IF v_id_vend_ses IS NOT NULL THEN
    v_nivel := LOWER(COALESCE(p_data->>'tipoCliente', 'consumidor'));
    IF v_nivel NOT IN ('consumidor','tienda','restaurante','mayorista','mostrador') THEN
      v_nivel := 'consumidor';
    END IF;
  ELSE
    v_nivel := 'consumidor';
    SELECT * INTO v_cli FROM clientes
     WHERE RIGHT(REGEXP_REPLACE(COALESCE(telefono,''), '\D', '', 'g'), 10)
         = RIGHT(REGEXP_REPLACE(COALESCE(v_tel_ses,''), '\D', '', 'g'), 10)
     LIMIT 1;
    IF FOUND AND COALESCE(v_cli.aprobado_b2b, false) THEN
      v_nivel := CASE v_cli.tipo_id
                   WHEN 2 THEN 'restaurante'
                   WHEN 3 THEN 'tienda'
                   WHEN 4 THEN 'mayorista'
                   ELSE 'consumidor'
                 END;
    END IF;
  END IF;

  -- ── 2) Idempotency ──────────────────────────────────────────────────────
  IF v_idempotency <> '' THEN
    SELECT * INTO v_existente FROM ordenes WHERE idempotency_key = v_idempotency LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', true, 'duplicado', true,
        'idOrden', v_existente.id, 'consecutivo', v_existente.consecutivo);
    END IF;
  END IF;

  -- ── 3) RECOTIZAR CADA LÍNEA ─────────────────────────────────────────────
  FOR v_producto IN SELECT * FROM jsonb_array_elements(p_data->'productos') LOOP
    v_pid  := COALESCE(v_producto->>'idProducto', '');
    v_tv   := COALESCE(v_producto->>'tipoVenta', 'Por Pieza');
    v_cant := COALESCE((v_producto->>'cantidad')::NUMERIC, 0);
    v_gram := COALESCE((v_producto->>'gramos')::NUMERIC, 0);
    -- CAJA: 3/6/12 si la línea se vendió por caja; cualquier otra cosa = por pieza.
    v_caja  := CASE WHEN (v_producto->>'caja') ~ '^(3|6|12)$' THEN (v_producto->>'caja')::INTEGER ELSE 0 END;
    v_pcaja := NULL;
    v_base := NULL; v_pct := 0; v_pkg := 0; v_p := NULL;
    v_es_canje := COALESCE((v_producto->>'canje')::BOOLEAN, false);

    IF v_pid ~ '^b[0-9]+$' THEN
      -- Bebida: una sola columna de precio, igual para todos los niveles.
      SELECT b.precio INTO v_base FROM productos_bebidas b
       WHERE b.id = SUBSTRING(v_pid FROM 2)::BIGINT
         AND COALESCE(b.activo, true) AND NOT COALESCE(b.descontinuado, false);
    ELSE
      IF v_pid ~ '^[0-9]+$' THEN
        SELECT * INTO v_p FROM productos WHERE id = v_pid::BIGINT;
      END IF;
      IF v_p.id IS NULL THEN
        SELECT * INTO v_p FROM productos
         WHERE sabor = v_producto->>'sabor'
           AND presentacion = v_producto->>'presentacion'
           AND NOT COALESCE(descontinuado, false)
         LIMIT 1;
      END IF;
      IF v_p.id IS NOT NULL THEN
        v_base := CASE v_nivel
                    WHEN 'tienda'      THEN v_p.precio_tienda
                    WHEN 'restaurante' THEN v_p.precio_restaurante
                    -- Puente vivo: mientras precio_mayorista sea 0/NULL se cobra
                    -- precio de tienda, igual que hace getPrecio en la app.
                    WHEN 'mayorista'   THEN COALESCE(NULLIF(v_p.precio_mayorista, 0), v_p.precio_tienda)
                    WHEN 'mostrador'   THEN v_p.precio_mostrador
                    ELSE v_p.precio_consumidor
                  END;
        v_pct := COALESCE(v_p.descuento_pct, 0);
        v_pkg := COALESCE(v_p.precio_granel_kg, 0);
        -- CAJA: precio propio de esa caja, si el producto lo tiene (NULL/0 = no).
        v_pcaja := CASE v_caja WHEN 3 THEN v_p.precio_caja_3 WHEN 6 THEN v_p.precio_caja_6 WHEN 12 THEN v_p.precio_caja_12 ELSE NULL END;
        IF COALESCE(v_pcaja, 0) <= 0 THEN v_pcaja := NULL; END IF;
      END IF;
    END IF;

    -- Una línea que no se puede cotizar tumba el pedido entero. Adivinar un
    -- precio sería volver al problema que esto viene a cerrar.
    IF v_base IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'producto_no_encontrado',
        'mensaje', 'No pudimos cotizar: ' ||
                   COALESCE(NULLIF(v_producto->>'sabor',''), v_pid, 'un producto'));
    END IF;

    -- CANJE: solo piezas de productos canjeables; el precio en puntos lo decide el servidor.
    IF v_es_canje THEN
      IF v_p.id IS NULL OR NOT COALESCE(v_p.canje_activo, false) OR v_tv <> 'Por Pieza' OR v_caja > 0
         OR v_cant <= 0 OR v_cant <> TRUNC(v_cant) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'canje_no_disponible',
          'mensaje', 'Ese producto no se puede canjear: ' || COALESCE(NULLIF(v_producto->>'sabor',''), v_pid));
      END IF;
      v_pts_unit  := public.puntos_de_canje(v_p.id);
      v_pts_canje := v_pts_canje + (v_cant * v_pts_unit)::INTEGER;
      v_pzs_canje := v_pzs_canje + v_cant::INTEGER;
      v_calc := v_calc || jsonb_build_object(
        'idProducto', v_pid, 'sabor', v_producto->>'sabor', 'presentacion', v_producto->>'presentacion',
        'tipoVenta', v_tv, 'cantidad', v_cant, 'gramos', v_gram, 'precio', 0, 'precioKg', 0,
        'subtotal', 0, 'caja', 0, 'puntosCanje', (v_cant * v_pts_unit)::INTEGER);
      CONTINUE;
    END IF;

    IF v_tv = 'A granel' THEN
      IF v_pkg <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'granel_sin_precio',
          'mensaje', 'Ese producto no se vende a granel');
      END IF;
      v_unit      := v_pkg;
      v_sub_linea := ROUND(v_gram / 1000.0 * v_pkg, 2);
    ELSE
      -- CAJA: el precio de caja es de TIENDA y MAYORISTA. Sin esta guarda un
      -- consumidor que mandara `caja: 12` a mano pagaba $300 en vez de 12 × $35
      -- (comprobado en staging el 13 sep 2026, PED-00033).
      IF v_nivel IN ('tienda', 'mayorista') AND v_pcaja IS NOT NULL AND v_caja > 0 AND v_cant > 0 AND MOD(v_cant, v_caja) = 0 THEN
        -- CAJA: cajas × precio propio de la caja. La cantidad sigue en piezas y
        -- el precio unitario que se guarda es informativo (precio_caja / piezas).
        v_sub_linea := ROUND(v_cant / v_caja * v_pcaja, 2);
        v_unit      := ROUND(v_pcaja / v_caja, 2);
      ELSE
        -- Mismo redondeo que la app (Math.round del precio con descuento).
        v_unit      := CASE WHEN v_pct > 0 THEN ROUND(v_base * (1 - v_pct / 100.0)) ELSE v_base END;
        v_sub_linea := ROUND(v_cant * v_unit, 2);
      END IF;
    END IF;

    v_sub  := v_sub + v_sub_linea;
    IF v_sub_linea > 0 THEN v_lineas_pago := v_lineas_pago + 1; END IF;
    v_calc := v_calc || jsonb_build_object(
      'idProducto',   v_pid,
      'sabor',        v_producto->>'sabor',
      'presentacion', v_producto->>'presentacion',
      'tipoVenta',    v_tv,
      'cantidad',     v_cant,
      'gramos',       v_gram,
      'precio',       CASE WHEN v_tv = 'A granel' THEN 0 ELSE v_unit END,
      'precioKg',     CASE WHEN v_tv = 'A granel' THEN v_pkg ELSE 0 END,
      'subtotal',     v_sub_linea,
      'caja',         v_caja
    );
  END LOOP;

  -- ── 3b) CANJE: reglas de Abraham (18 sep 2026) ──────────────────────────
  IF v_pzs_canje > 0 THEN
    IF v_tipo_int <> '' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'canje_no_disponible', 'mensaje', 'Un pedido interno no lleva canje');
    END IF;
    IF v_lineas_pago = 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'canje_sin_compra',
        'mensaje', 'Para canjear puntos, agrega al menos un producto comprado.');
    END IF;
    IF v_pzs_canje > 5 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'canje_maximo',
        'mensaje', 'Puedes canjear hasta 5 piezas por pedido.');
    END IF;
    IF COALESCE((p_data->>'puntosCanje')::INTEGER, -1) <> v_pts_canje THEN
      RETURN jsonb_build_object('ok', false, 'error', 'puntos_cambiados',
        'mensaje', 'Los puntos del canje cambiaron. Revisa tu carrito y confirma de nuevo.',
        'puntosCorrectos', v_pts_canje, 'puntosEnviados', p_data->'puntosCanje');
    END IF;
    -- El cliente del canje: el de la sesión; con sesión de vendedor, el del pedido.
    v_cli_canje := CASE WHEN v_id_vend_ses IS NULL THEN v_cli.id ELSE v_id_cliente END;
    IF v_cli_canje IS NULL OR (v_id_vend_ses IS NULL AND v_id_cliente IS DISTINCT FROM v_cli_canje) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'canje_sin_cliente',
        'mensaje', 'Para canjear puntos necesitas tu cuenta verificada.');
    END IF;
    -- Dos pedidos a la vez no gastan el mismo saldo: candado por cliente hasta el fin de la transacción.
    PERFORM pg_advisory_xact_lock(hashtext('canje:' || v_cli_canje));
    SELECT COALESCE(SUM(puntos), 0) INTO v_saldo FROM lealtad_movimientos WHERE id_cliente = v_cli_canje;
    IF v_saldo < v_pts_canje THEN
      RETURN jsonb_build_object('ok', false, 'error', 'saldo_insuficiente',
        'mensaje', 'No te alcanzan los puntos para este canje.', 'saldo', v_saldo, 'puntos', v_pts_canje);
    END IF;
    SELECT COALESCE((valor->'redencion'->>'valor_punto_mxn')::NUMERIC, 0) INTO v_valor_punto
      FROM config_produccion WHERE clave = 'lealtad';
  END IF;

  -- ── 4) CUPÓN — lo valida quien ya sabía hacerlo ─────────────────────────
  IF v_cod_cupon <> '' AND v_tipo_int = '' THEN
    v_cupon := public.validar_cupon(v_cod_cupon, v_telefono, v_id_cliente, v_sub, v_nivel)::JSONB;
    IF COALESCE((v_cupon->>'ok')::BOOLEAN, false) THEN
      v_tipo_cup  := v_cupon->'cupon'->>'tipo';
      v_valor_cup := COALESCE((v_cupon->'cupon'->>'valor')::NUMERIC, 0);
      IF v_tipo_cup = 'descuento_pct' THEN
        v_desc := ROUND(v_sub * v_valor_cup / 100.0, 2);
      ELSIF v_tipo_cup = 'descuento_fijo' THEN
        v_desc := LEAST(v_valor_cup, v_sub);
      END IF;
    END IF;
  END IF;

  -- ── 5) ENVÍO ────────────────────────────────────────────────────────────
  -- 80 = COSTO_PAQUETERIA (index.html:3789). Es una constante duplicada en dos
  -- sitios: debería vivir en config_produccion y leerse desde los dos. Anotado.
  IF COALESCE(p_data->>'metodoEntrega','') = 'paqueteria'
     AND v_nivel = 'consumidor' AND v_tipo_int = '' THEN
    v_envio := 80;
  END IF;
  IF v_tipo_cup = 'envio_gratis' THEN v_desc_envio := v_envio; END IF;

  v_total := GREATEST(0, v_sub - v_desc + v_envio - v_desc_envio);

  IF v_tipo_int <> '' THEN
    v_total := 0; v_sub := 0; v_desc := 0;
  END IF;

  -- ── 6) CUADRE ───────────────────────────────────────────────────────────
  v_declarado := COALESCE((p_data->>'total')::NUMERIC, -1);
  IF v_tipo_int = '' AND ABS(v_total - v_declarado) > 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'precio_cambiado',
      'mensaje', 'El precio cambió. Revisa tu carrito y confirma de nuevo.',
      'totalCorrecto', v_total, 'subtotal', v_sub,
      'descuento', v_desc, 'envio', v_envio - v_desc_envio,
      'totalEnviado', v_declarado);
  END IF;

  -- ── 7) Estatus ──────────────────────────────────────────────────────────
  v_estatus_ped := 'Pendiente';
  v_estatus_pag := 'Pendiente';
  IF v_canal = 'mostrador' OR v_tipo_int <> '' THEN
    v_estatus_ped := 'Entregado';
    v_estatus_pag := 'Pagado';
    v_fecha_pago := NOW();
  END IF;

  v_consec := siguiente_consecutivo();

  INSERT INTO ordenes (
    consecutivo, canal, id_cliente, nombre_cliente,
    id_vendedor, nombre_vendedor,
    fecha_orden, fecha_entrega, fecha_pago,
    tipo_pago_id, tipo_pago,
    estatus_pedido, estatus_pago,
    subtotal, descuento, total, notas,
    cp, colonia, municipio, estado, direccion, coordenadas,
    zona_entrega, stripe_payment_id, cupon_codigo, tipo_interno,
    metodo_entrega,
    idempotency_key,
    puntos_canjeados, descuento_puntos
  ) VALUES (
    v_consec, v_canal, v_id_cliente, v_nombre_cli,
    COALESCE(v_id_vend_ses, NULLIF(p_data->>'idVendedor', '')::BIGINT),
    p_data->>'nombreVendedor',
    NOW(), COALESCE((SELECT CASE WHEN (fe AT TIME ZONE 'UTC')::time = '00:00' THEN fe + interval '18 hours' ELSE fe END FROM (SELECT (p_data->>'fechaEntrega')::timestamptz fe) s), NOW()), v_fecha_pago,
    COALESCE((p_data->>'tipoPagoId')::INTEGER, 0), p_data->>'tipoPago',
    v_estatus_ped, v_estatus_pag,
    v_sub, v_desc, v_total,          -- ← cifras del SERVIDOR
    p_data->>'notas', p_data->>'cp', p_data->>'colonia', p_data->>'municipio',
    p_data->>'estado', p_data->>'direccion', p_data->>'coordenadas',
    COALESCE(p_data->>'zonaEntrega', 'cdmx'),
    p_data->>'stripePaymentId',
    v_cod_cupon,
    v_tipo_int,
    -- 17 sep 2026 (Reparto P1): el método de entrega se guarda; misma condición que el envío.
    CASE WHEN COALESCE(p_data->>'metodoEntrega','') = 'paqueteria' AND v_nivel = 'consumidor' THEN 'paqueteria' ELSE 'domicilio' END,
    NULLIF(v_idempotency, ''),
    v_pts_canje, ROUND(v_pts_canje * COALESCE(v_valor_punto, 0), 2)
  ) RETURNING id INTO v_id_orden;

  -- ── 8) Líneas, con los precios recotizados ──────────────────────────────
  FOR v_producto IN SELECT * FROM jsonb_array_elements(v_calc) LOOP
    INSERT INTO ordenes_detalle (
      id_orden, consecutivo_orden,
      id_producto, sabor, presentacion, tipo_venta,
      cantidad, gramos_vendidos, precio_unitario, descuento, subtotal, precio_kg, notas_linea,
      piezas_por_caja, puntos_canje
    ) VALUES (
      v_id_orden, v_consec,
      v_producto->>'idProducto', v_producto->>'sabor', v_producto->>'presentacion',
      v_producto->>'tipoVenta',
      (v_producto->>'cantidad')::NUMERIC,
      (v_producto->>'gramos')::NUMERIC,
      (v_producto->>'precio')::NUMERIC,
      0,
      (v_producto->>'subtotal')::NUMERIC,
      (v_producto->>'precioKg')::NUMERIC,
      CASE WHEN (v_producto->>'puntosCanje') IS NOT NULL THEN 'Canje Crunchy Club' END,
      CASE WHEN v_nivel IN ('tienda', 'mayorista') THEN NULLIF(COALESCE((v_producto->>'caja')::INTEGER, 0), 0) END,
      COALESCE((v_producto->>'puntosCanje')::INTEGER, 0)
    );
    v_filas_det := v_filas_det + 1;
  END LOOP;

  -- ── 8b) CANJE: el asiento va en la misma transacción que el pedido (regla 27) ─
  IF v_pts_canje > 0 THEN
    PERFORM public.agregar_movimiento_lealtad(
      v_cli_canje, 'canje', -v_pts_canje, v_id_orden, v_consec, NULL, NULL,
      ROUND(v_pts_canje * COALESCE(v_valor_punto, 0), 2),
      'Canje de ' || v_pzs_canje || ' pieza' || CASE WHEN v_pzs_canje = 1 THEN '' ELSE 's' END || ' en ' || v_consec,
      COALESCE((SELECT nombre FROM vendedores WHERE id = v_id_vend_ses), 'cliente'));
  END IF;

  -- ── 9) USO DEL CUPÓN, EN LA MISMA TRANSACCIÓN ───────────────────────────
  -- Antes se registraba en una SEGUNDA llamada desde el navegador, con el error
  -- tragado (`catch(e) { /* no bloquear */ }`). Si la red se cortaba entre las
  -- dos, el pedido quedaba con su descuento aplicado y el cupón sin marcar: uno
  -- de un solo uso se podía volver a usar. El descuento ya se decide aquí
  -- arriba, así que el uso pertenece aquí. Ver cambios/2026-09-07-cupon-en-la-transaccion.md
  --
  -- Idempotente por (id_cupon, id_orden): si la llamada vieja del navegador
  -- llega después —una PWA cacheada la sigue haciendo— no cuenta dos veces.
  IF v_cod_cupon <> '' AND v_tipo_int = ''
     AND COALESCE((v_cupon->>'ok')::BOOLEAN, false) THEN
    DECLARE v_id_cup BIGINT;
    BEGIN
      SELECT id INTO v_id_cup FROM public.cupones WHERE codigo = v_cod_cupon LIMIT 1;
      IF v_id_cup IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM public.cupones_uso
            WHERE id_cupon = v_id_cup AND id_orden = v_id_orden::TEXT) THEN
        INSERT INTO public.cupones_uso
          (id_cupon, codigo, id_cliente, telefono, id_orden, monto_descuento)
        VALUES (v_id_cup, v_cod_cupon, v_id_cliente, v_telefono,
                v_id_orden::TEXT, v_desc + v_desc_envio);
        UPDATE public.cupones SET usos_actuales = COALESCE(usos_actuales, 0) + 1
         WHERE id = v_id_cup;
      END IF;
    END;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'idOrden', v_id_orden,
    'consecutivo', v_consec,
    'lineas', v_filas_det,
    'total', v_total,
    'nivelPrecio', v_nivel,
    'puntosAcumulados', 0,
    'puntosCanjeados', v_pts_canje
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

-- 4) Devoluciones de canje con validación
create table if not exists public.canje_devoluciones (
  id           bigserial primary key,
  id_orden     bigint not null unique references public.ordenes(id),
  id_cliente   bigint not null,
  consecutivo  text,
  puntos       integer not null check (puntos > 0),
  estado       text not null default 'pendiente' check (estado in ('pendiente', 'aprobada', 'rechazada')),
  cancelado_por text,
  creada_en    timestamptz not null default now(),
  resuelta_en  timestamptz,
  resuelta_por text,
  nota         text
);
alter table public.canje_devoluciones enable row level security;
revoke all on table public.canje_devoluciones from anon, authenticated;
comment on table public.canje_devoluciones is 'Puntos canjeados de un pedido cancelado, en espera de validación. Aprobar escribe el asiento devolucion. Club fase 2.';

create or replace function public.revertir_puntos_al_cancelar() returns trigger
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare v_neto int; v_canje int; v_cli bigint;
begin
  if new.estatus_pedido = 'Cancelado' and coalesce(old.estatus_pedido, '') <> 'Cancelado' then
    -- Lo generado por la parte pagada se revierte solo.
    select coalesce(sum(puntos), 0) into v_neto
      from lealtad_movimientos
     where id_orden = new.id and tipo in ('generacion', 'reversion');
    if v_neto > 0 then
      perform agregar_movimiento_lealtad(
        new.id_cliente, 'reversion', -v_neto,
        new.id, new.consecutivo, null, null, null,
        'Reversión por cancelación de ' || coalesce(new.consecutivo, ''),
        coalesce(nullif(new.actualizado_por, ''), 'sistema'));
    end if;
    -- Lo canjeado NO regresa solo: queda una solicitud para validar (Abraham, 18 sep 2026).
    select -coalesce(sum(puntos), 0), min(id_cliente) into v_canje, v_cli
      from lealtad_movimientos
     where id_orden = new.id and tipo in ('canje', 'devolucion');
    if v_canje > 0 then
      insert into canje_devoluciones (id_orden, id_cliente, consecutivo, puntos, cancelado_por)
      values (new.id, v_cli, new.consecutivo, v_canje, nullif(new.actualizado_por, ''))
      on conflict (id_orden) do nothing;
    end if;
  end if;
  return new;
end $fn$;
revoke all on function public.revertir_puntos_al_cancelar() from public;

-- Resolver una solicitud. La usa el agente validador por CLI (tras el sí de Abraham) y el dueño por la API.
create or replace function public.resolver_devolucion_canje_interno(p_id bigint, p_aprobar boolean, p_nota text, p_actor text)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare v_s canje_devoluciones%rowtype; v_est text;
begin
  select * into v_s from canje_devoluciones where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Solicitud no encontrada'); end if;
  if v_s.estado <> 'pendiente' then
    return jsonb_build_object('ok', false, 'error', 'La solicitud ya está ' || v_s.estado);
  end if;
  select estatus_pedido into v_est from ordenes where id = v_s.id_orden;
  if p_aprobar and coalesce(v_est, '') <> 'Cancelado' then
    return jsonb_build_object('ok', false, 'error', 'El pedido ya no está cancelado (' || coalesce(v_est, '—') || ')');
  end if;
  if coalesce(trim(p_nota), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'Falta el motivo');
  end if;
  if p_aprobar then
    perform agregar_movimiento_lealtad(
      v_s.id_cliente, 'devolucion', v_s.puntos, v_s.id_orden, v_s.consecutivo, null, null, null,
      'Devolución del canje de ' || coalesce(v_s.consecutivo, '') || ': ' || trim(p_nota), coalesce(p_actor, 'validador'));
  end if;
  update canje_devoluciones
     set estado = case when p_aprobar then 'aprobada' else 'rechazada' end,
         resuelta_en = now(), resuelta_por = coalesce(p_actor, 'validador'), nota = trim(p_nota)
   where id = p_id;
  return jsonb_build_object('ok', true, 'estado', case when p_aprobar then 'aprobada' else 'rechazada' end,
                            'puntos', case when p_aprobar then v_s.puntos else 0 end);
end $fn$;
revoke all on function public.resolver_devolucion_canje_interno(bigint, boolean, text, text) from public, anon, authenticated;

create or replace function public.resolver_devolucion_canje(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.resolver_devolucion_canje_interno(
    nullif(p_data->>'id', '')::bigint, coalesce((p_data->>'aprobar')::boolean, false), p_data->>'nota',
    (select v.nombre from vendedores v join public.resolver_sesion_vendedor(p_data->>'token') s on s.id_vendedor = v.id limit 1));
end $fn$;
revoke all on function public.resolver_devolucion_canje(jsonb) from public;
grant execute on function public.resolver_devolucion_canje(jsonb) to anon, authenticated;

-- Lista para el dueño (y lo que el agente lee por SQL): la solicitud con lo necesario para decidir.
create or replace function public.devoluciones_canje(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return jsonb_build_object('ok', true, 'solicitudes', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', d.id, 'idOrden', d.id_orden, 'consecutivo', d.consecutivo, 'puntos', d.puntos,
             'estado', d.estado, 'canceladoPor', d.cancelado_por, 'creadaEn', d.creada_en,
             'resueltaEn', d.resuelta_en, 'resueltaPor', d.resuelta_por, 'nota', d.nota,
             'idCliente', d.id_cliente, 'cliente', c.nombre,
             'cancelacionesConCanje90d', (select count(*) from canje_devoluciones d2
                                           where d2.id_cliente = d.id_cliente and d2.creada_en > now() - interval '90 days'))
           order by d.creada_en desc)
      from canje_devoluciones d left join clientes c on c.id = d.id_cliente
     where coalesce(nullif(p_data->>'estado', ''), d.estado) = d.estado), '[]'::jsonb));
end $fn$;
revoke all on function public.devoluciones_canje(jsonb) from public;
grant execute on function public.devoluciones_canje(jsonb) to anon, authenticated;

-- 5) mis_puntos con las devoluciones en revisión
create or replace function public.mis_puntos(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_tel  text;
  v_id   bigint;
  v_movs jsonb;
  v_pend jsonb;
begin
  v_tel := public.resolver_sesion_cliente(p_token);
  if v_tel is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida o expirada');
  end if;
  select c.id into v_id from public.clientes c where c.telefono = v_tel order by c.id limit 1;
  if v_id is null then
    return jsonb_build_object('ok', true, 'saldo', 0, 'movimientos', '[]'::jsonb, 'pendientes', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'fecha', m.fecha, 'tipo', m.tipo, 'puntos', m.puntos,
           'consecutivo', m.consecutivo, 'monto', m.monto_origen, 'nota', m.nota)
         order by m.fecha desc, m.id desc), '[]'::jsonb)
    into v_movs
    from (select * from public.lealtad_movimientos
           where id_cliente = v_id order by fecha desc, id desc limit 50) m;

  select coalesce(jsonb_agg(jsonb_build_object('fecha', d.creada_en, 'puntos', d.puntos, 'consecutivo', d.consecutivo)
                            order by d.creada_en desc), '[]'::jsonb)
    into v_pend
    from public.canje_devoluciones d where d.id_cliente = v_id and d.estado = 'pendiente';

  return jsonb_build_object('ok', true,
    'saldo', coalesce((select sum(puntos) from public.lealtad_movimientos where id_cliente = v_id), 0),
    'movimientos', v_movs, 'pendientes', v_pend);
end $fn$;
revoke all on function public.mis_puntos(text) from public;
grant execute on function public.mis_puntos(text) to anon, authenticated;

commit;
