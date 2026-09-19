-- 19 sep 2026 — Ingreso bruto y neto en el tablero, con el envío a la vista
-- (cambios/2026-09-19-ingreso-bruto-neto.md).
-- Decidido por Abraham: «Ventas» es el ingreso neto sin envío; bruto − descuentos = neto para todo tipo de cliente,
-- contra la lista del canal; el canje se descuenta por el valor de los puntos gastados; el envío se lleva completo
-- (tarifa, absorbido, cobrado).
--
-- 1. ordenes.envio / descuento_envio, con relleno de lo histórico (0 envíos gratis al 19 sep).
-- 2. crear_pedido: escribe ordenes_detalle.descuento y el envío del pedido. Cobra exactamente lo mismo que antes.
-- 3. dashboard_resumen_interno: «ventas» en neto y la clave ingresos.

begin;

-- ── 1 ─────────────────────────────────────────────────────────────────────
alter table public.ordenes add column if not exists envio numeric not null default 0;
alter table public.ordenes add column if not exists descuento_envio numeric not null default 0;
comment on column public.ordenes.envio is 'Tarifa de envío aplicada al pedido, antes del cupón de envío gratis. 19 sep 2026.';
comment on column public.ordenes.descuento_envio is 'Envío absorbido por el negocio (cupón de envío gratis). 19 sep 2026.';
update public.ordenes
   set envio = greatest(0, total - (subtotal - coalesce(descuento, 0)))
 where coalesce(tipo_interno, '') = '' and envio = 0;

-- ── 2 ─────────────────────────────────────────────────────────────────────
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
      'caja',         v_caja,
      -- 19 sep 2026 (ingreso bruto/neto): lo rebajado de la lista del canal (descuento_pct o ahorro de la caja).
      'descuento',    CASE WHEN v_tv = 'A granel' THEN 0 ELSE GREATEST(0, ROUND(v_cant * v_base, 2) - v_sub_linea) END
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
    -- Lo vencido se escribe antes de sumar: un punto vencido no se gasta (20260930000007).
    PERFORM public.vencer_puntos(v_cli_canje);
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
    puntos_canjeados, descuento_puntos,
    envio, descuento_envio
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
    v_pts_canje, ROUND(v_pts_canje * COALESCE(v_valor_punto, 0), 2),
    v_envio, v_desc_envio
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
      -- 19 sep 2026: descuento de la línea. Canje = valor de los puntos gastados (D4); internos, 0.
      CASE WHEN v_tipo_int <> '' THEN 0
           WHEN (v_producto->>'puntosCanje') IS NOT NULL THEN ROUND((v_producto->>'puntosCanje')::NUMERIC * COALESCE(v_valor_punto, 0), 2)
           ELSE COALESCE((v_producto->>'descuento')::NUMERIC, 0) END,
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

-- ── 3 ─────────────────────────────────────────────────────────────────────
create or replace function public.dashboard_resumen_interno(p_data jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_hoy   date := (now() at time zone 'America/Mexico_City')::date;
  v_desde date := coalesce(nullif(p_data->>'desde', '')::date, date_trunc('month', v_hoy)::date);
  v_hasta date := coalesce(nullif(p_data->>'hasta', '')::date, v_hoy);
  v_sabor text := nullif(p_data->>'sabor', '');
  v_pres  text := nullif(p_data->>'presentacion', '');
  v_prod  boolean;
  v_dias  int;
  v_pdesde date;
  v_phasta date;
  v_mes_alineado boolean;
  v_resultado jsonb;
begin
  if v_desde > v_hasta then
    return jsonb_build_object('ok', false, 'error', 'El rango empieza después de terminar');
  end if;

  v_prod := (v_sabor is not null or v_pres is not null);
  v_dias := (v_hasta - v_desde) + 1;
  -- Tope duro: dos años. Sin él, un rango absurdo barre la tabla entera.
  if v_dias > 731 then
    v_desde := v_hasta - 730;
    v_dias  := 731;
  end if;

  v_mes_alineado := (v_desde = date_trunc('month', v_desde)::date)
                and (date_trunc('month', v_hasta) = date_trunc('month', v_desde));

  if v_mes_alineado then
    -- El mismo tramo de días del mes anterior, sin desbordar su último día.
    v_pdesde := (date_trunc('month', v_desde) - interval '1 month')::date;
    v_phasta := least(
                  (v_pdesde + (v_dias - 1) * interval '1 day')::date,
                  (date_trunc('month', v_pdesde) + interval '1 month - 1 day')::date
                );
  else
    v_phasta := v_desde - 1;
    v_pdesde := v_phasta - (v_dias - 1);
  end if;

  with
  -- Pedidos válidos del periodo. Con filtro de producto, solo los que lo llevan.
  ord as (
    select o.id, o.id_vendedor, o.nombre_vendedor, o.estatus_pago, o.estatus_pedido,
           o.total, o.subtotal - coalesce(o.descuento, 0) as neto, coalesce(o.descuento, 0) as cupon,
           coalesce(o.envio, 0) as envio, coalesce(o.descuento_envio, 0) as descuento_envio,
           (o.fecha_orden at time zone 'America/Mexico_City')::date as f
      from ordenes o
     where coalesce(o.tipo_interno, '') = ''
       and o.estatus_pedido <> 'Cancelado'
       and (o.fecha_orden at time zone 'America/Mexico_City')::date between v_desde and v_hasta
       and (not v_prod or exists (
             select 1 from ordenes_detalle d
              where d.id_orden = o.id
                and (v_sabor is null or d.sabor = v_sabor)
                and (v_pres  is null or d.presentacion = v_pres)))
  ),
  -- Las líneas que casan con el filtro, dentro de esos pedidos.
  det as (
    select o.id as id_orden, o.f, o.id_vendedor, o.nombre_vendedor, o.estatus_pago,
           d.sabor, d.presentacion, d.tipo_venta, d.cantidad, d.subtotal,
           coalesce(d.descuento, 0) as descuento, coalesce(d.puntos_canje, 0) as puntos_canje
      from ord o
      join ordenes_detalle d on d.id_orden = o.id
     where (v_sabor is null or d.sabor = v_sabor)
       and (v_pres  is null or d.presentacion = v_pres)
  ),
  ord_prev as (
    select o.subtotal - coalesce(o.descuento, 0) as neto, (o.fecha_orden at time zone 'America/Mexico_City')::date as f, o.id
      from ordenes o
     where coalesce(o.tipo_interno, '') = ''
       and o.estatus_pedido <> 'Cancelado'
       and (o.fecha_orden at time zone 'America/Mexico_City')::date between v_pdesde and v_phasta
       and (not v_prod or exists (
             select 1 from ordenes_detalle d
              where d.id_orden = o.id
                and (v_sabor is null or d.sabor = v_sabor)
                and (v_pres  is null or d.presentacion = v_pres)))
  ),
  det_prev as (
    select d.subtotal
      from ord_prev o
      join ordenes_detalle d on d.id_orden = o.id
     where (v_sabor is null or d.sabor = v_sabor)
       and (v_pres  is null or d.presentacion = v_pres)
  ),
  -- Un renglón por día del rango, con 0 donde no hubo venta.
  serie as (
    select g.dia::date as f from generate_series(v_desde, v_hasta, interval '1 day') g(dia)
  ),
  por_dia as (
    select s.f,
           coalesce(
             case when v_prod
                  then (select sum(x.subtotal) from det x where x.f = s.f)
                  else (select sum(y.neto)     from ord y where y.f = s.f)
             end, 0) as monto
      from serie s
  ),
  vend as (
    select o.id_vendedor,
           max(o.nombre_vendedor) as nombre,
           case when v_prod
                then (select coalesce(sum(x.subtotal), 0) from det x where x.id_vendedor = o.id_vendedor)
                else sum(o.neto)
           end as ventas,
           count(*) as pedidos,
           count(*) filter (where o.estatus_pago <> 'Pagado') as pendientes_pago
      from ord o
     group by o.id_vendedor
  )
  select jsonb_build_object(

    -- Ventas por día del periodo. `dia` (día del mes) se conserva porque el
    -- frontend lo usa; `fecha` es lo correcto para un rango que cruce meses.
    'ventas_dia', coalesce((
      select jsonb_agg(jsonb_build_object(
               'dia',   extract(day from p.f)::int,
               'fecha', p.f,
               'monto', p.monto) order by p.f)
        from por_dia p), '[]'::jsonb),

    'mtd_actual', coalesce((
      select case when v_prod then (select coalesce(sum(subtotal), 0) from det)
                  else (select coalesce(sum(neto), 0) from ord) end), 0),

    'mtd_anterior', coalesce((
      select case when v_prod then (select coalesce(sum(subtotal), 0) from det_prev)
                  else (select coalesce(sum(neto), 0) from ord_prev) end), 0),

    -- Objetivo: cuotas del mes en que TERMINA el rango. No se filtra por
    -- producto — una cuota es global, y prorratearla sería inventar un número.
    'objetivo_mes', coalesce((
      select sum(cuota) from cuotas_vendedor
       where mes = extract(month from v_hasta)::int
         and anio = extract(year from v_hasta)::int), 0),

    -- ── Saldo operativo: GLOBAL a propósito, no del periodo ──
    -- Acotar «lo que me deben» al mes escondería las deudas viejas.
    'por_entregar', coalesce((
      select count(*) from ordenes
       where coalesce(tipo_interno, '') = '' and estatus_pedido <> 'Cancelado'
         and estatus_pedido <> 'Entregado'), 0),
    'por_cobrar_monto', coalesce((
      select sum(total) from ordenes
       where coalesce(tipo_interno, '') = '' and estatus_pedido <> 'Cancelado'
         and estatus_pago <> 'Pagado'), 0),

    -- Entregados: ahora DEL PERIODO (antes era histórico).
    'entregados', coalesce((
      select count(*) from ord where estatus_pedido = 'Entregado'), 0),

    -- Top sabores y presentaciones: ahora DEL PERIODO (antes eran históricos).
    'top_sabores', coalesce((
      select jsonb_agg(jsonb_build_object('sabor', s.sabor, 'pzas', s.pzas) order by s.pzas desc)
        from (select d.sabor, sum(d.cantidad) as pzas
                from det d
               where coalesce(d.sabor, '') <> ''
               group by d.sabor order by pzas desc limit 8) s), '[]'::jsonb),

    'top_presentaciones', coalesce((
      select jsonb_agg(jsonb_build_object('presentacion', p.presentacion, 'pzas', p.pzas) order by p.pzas desc)
        from (select d.presentacion, sum(d.cantidad) as pzas
                from det d
               where coalesce(d.presentacion, '') <> ''
                 and coalesce(d.tipo_venta, '') <> 'A granel'
               group by d.presentacion order by pzas desc limit 8) p), '[]'::jsonb),

    'por_vendedor', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id_vendedor', v.id_vendedor,
               'nombre', v.nombre,
               'ventas', v.ventas,
               'cuota', coalesce(c.cuota, 0),
               'pedidos', v.pedidos,
               'pendientes_pago', v.pendientes_pago,
               'pct_pendiente_pago', case when v.pedidos > 0
                                          then round(100.0 * v.pendientes_pago / v.pedidos)::int
                                          else 0 end
             ) order by v.ventas desc)
        from vend v
        left join cuotas_vendedor c
          on c.id_vendedor = v.id_vendedor
         and c.mes  = extract(month from v_hasta)::int
         and c.anio = extract(year  from v_hasta)::int), '[]'::jsonb),

    -- `dia_mes` se conserva por compatibilidad; `dias` es lo correcto para un
    -- rango cualquiera, y los filtros vuelven para que la pantalla los muestre.
    -- 19 sep 2026: bruto − descuentos = neto; neto + envío cobrado = cobrado. Con filtro de producto, cupones y
    -- envío no se reparten por línea (salen en 0 y con_filtro lo dice).
    'ingresos', (
      select jsonb_build_object(
               'bruto',           b.bruto,
               'desc_producto',   b.dprod,
               'cupones',         c.cupones,
               'canje',           b.canje,
               'neto',            b.bruto - b.dprod - b.canje - c.cupones,
               'envio_tarifa',    c.tarifa,
               'envio_absorbido', c.absorbido,
               'envio_cobrado',   c.tarifa - c.absorbido,
               'cobrado',         b.bruto - b.dprod - b.canje - c.cupones + c.tarifa - c.absorbido,
               'con_filtro',      v_prod)
        from (select coalesce(sum(x.subtotal + x.descuento), 0) as bruto,
                     coalesce(sum(x.descuento) filter (where x.puntos_canje = 0), 0) as dprod,
                     coalesce(sum(x.descuento) filter (where x.puntos_canje > 0), 0) as canje
                from det x) b,
             (select case when v_prod then 0 else coalesce(sum(y.cupon), 0) end as cupones,
                     case when v_prod then 0 else coalesce(sum(y.envio), 0) end as tarifa,
                     case when v_prod then 0 else coalesce(sum(y.descuento_envio), 0) end as absorbido
                from ord y) c),

    'dia_mes', extract(day from v_hasta)::int,
    'dias',    v_dias,
    'desde',   v_desde,
    'hasta',   v_hasta,
    'prev_desde', v_pdesde,
    'prev_hasta', v_phasta,
    'filtro_producto', v_prod,
    'sabor', v_sabor,
    'presentacion', v_pres
  ) into v_resultado;

  return jsonb_build_object('ok', true, 'data', v_resultado);
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;

alter function public.dashboard_resumen_interno(jsonb) owner to postgres;
revoke all on function public.dashboard_resumen_interno(jsonb) from public, anon, authenticated;

commit;
