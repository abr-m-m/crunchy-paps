-- 24 nov 2026 — La promocion llega al precio (pieza L3, mitad de cobro).
-- Diseño: cambios/2026-11-24-promociones-diseno.md · relato: cambios/2026-11-24-promociones-al-precio.md
--
-- LO QUE CAMBIA DE VERDAD: `crear_pedido` deja de mirar solo el precio de caja
-- y el descuento de lista. Ahora pregunta tambien por la promocion vigente y
-- se queda con el precio MAS BAJO de los tres, nunca con la suma (decision D2).
--
-- POR QUE HAY QUE TOCAR TRES SITIOS A LA VEZ, y no se puede ir por partes:
-- `crear_pedido` compara su total con el que manda la app y rechaza el pedido
-- si difieren en mas de un peso (`precio_cambiado`). Asi que si el servidor
-- cobrara la promocion y la app no la conociera, TODOS los pedidos de un
-- producto en promocion fallarian. Por eso la app recibe el precio ya
-- calculado por el servidor (`catalogo_promociones`) en vez de calcularlo:
-- un numero, no una formula repetida.
--
-- Y UN HALLAZGO QUE QUEDA ESCRITO: `crear_pedido` NO usa `cotizar_linea`.
-- Tiene su propia copia de la regla de precio desde siempre. Aqui se parchan
-- las dos con el mismo `promocion_mejor` para que no se separen, pero la
-- duplicacion sigue ahi y merece su propia pieza.
--
-- 1. promocion_mejor: la unica fuente del precio de una promocion.
-- 2. catalogo_promociones: lo que la app pinta, calculado por el servidor.
-- 3. cotizar_linea (editor de pedidos) con el mismo candidato.
-- 4. crear_pedido, parchado sobre una copia byte a byte de la que corre hoy
--    (md5 del cuerpo comprobado antes de tocarla: 4d0d7f16636b2f559ff316292ef29061).

begin;

-- ── 1 ─────────────────────────────────────────────────────────────────────
-- Devuelve CERO o UNA fila: la promocion vigente que deja el precio mas bajo
-- para ese producto y ese canal. Los paquetes NO entran aqui: necesitan ver el
-- carrito entero, y eso es la pieza L4.
create or replace function public.promocion_mejor(p_id_producto bigint, p_nivel text, p_fecha date)
returns table (id_promocion bigint, precio_unitario numeric)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_p     productos%rowtype;
  v_base  numeric;
  v_grupo text;
begin
  if p_id_producto is null then return; end if;
  select * into v_p from public.productos where id = p_id_producto;
  if v_p.id is null or not coalesce(v_p.activo, true) or coalesce(v_p.descontinuado, false) then return; end if;

  -- El mayorista nunca entra en promociones, igual que en el Club y en los
  -- retos: ya compra al precio mas bajo de la casa.
  v_grupo := case lower(coalesce(p_nivel, 'consumidor'))
               when 'tienda' then 'tiendas'
               when 'restaurante' then 'tiendas'
               when 'mayorista' then null
               else 'consumidores' end;
  if v_grupo is null then return; end if;

  v_base := case lower(coalesce(p_nivel, 'consumidor'))
              when 'tienda'      then v_p.precio_tienda
              when 'restaurante' then v_p.precio_restaurante
              when 'mostrador'   then v_p.precio_mostrador
              else v_p.precio_consumidor end;
  if v_base is null then return; end if;

  return query
  select pr.id,
         case pr.tipo
           -- Mismo redondeo que el descuento de lista y que la app.
           when 'porcentaje' then round(v_base * (1 - pr.valor / 100.0))
           else round(pr.valor, 2)
         end as precio
    from public.promociones pr
   where pr.activa
     and pr.tipo in ('porcentaje', 'precio_fijo')
     and coalesce(p_fecha, current_date) between pr.desde and pr.hasta
     and (pr.publico = 'todos' or pr.publico = v_grupo)
     and exists (
       select 1 from public.promocion_items i
        where i.id_promocion = pr.id
          and ((i.id_producto is not null and i.id_producto = v_p.id)
            or (i.id_producto is null
                and (coalesce(i.sabor, '') = '' or i.sabor = v_p.sabor)
                and (coalesce(i.presentacion, '') = '' or i.presentacion = v_p.presentacion))))
   order by precio asc, pr.id asc
   limit 1;
end;
$fn$;
revoke all on function public.promocion_mejor(bigint, text, date) from public, anon, authenticated;

-- ── 2 ─────────────────────────────────────────────────────────────────────
-- Lo que la app necesita para PINTAR el precio promocional. Devuelve el numero
-- ya calculado: la app no repite la formula, porque dos formulas iguales se
-- separan y `crear_pedido` rechaza el pedido si no cuadran al peso.
create or replace function public.catalogo_promociones(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v_nivel text := lower(coalesce(p_data->>'nivel', 'consumidor'));
begin
  return jsonb_build_object('ok', true, 'nivel', v_nivel, 'promos', coalesce((
    select jsonb_agg(jsonb_build_object(
             'idProducto', p.id, 'idPromocion', m.id_promocion, 'precio', m.precio_unitario))
      from public.productos p
      cross join lateral public.promocion_mejor(p.id, v_nivel, current_date) m
     where coalesce(p.activo, true) and not coalesce(p.descontinuado, false)
       and m.id_promocion is not null), '[]'::jsonb));
end;
$fn$;
revoke all on function public.catalogo_promociones(jsonb) from public, anon;
grant execute on function public.catalogo_promociones(jsonb) to anon, authenticated;

-- ── 3 ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cotizar_linea(p_id_producto bigint, p_nivel text, p_cantidad numeric, p_caja integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_p     productos%rowtype;
  v_base  numeric; v_pct numeric; v_pcaja numeric; v_unit numeric; v_sub numeric;
  v_caja  integer := case when p_caja in (3, 6, 12) then p_caja else 0 end;
  v_promo_id bigint; v_promo_unit numeric;
  v_nivel text := lower(coalesce(p_nivel, 'consumidor'));
begin
  select * into v_p from productos where id = p_id_producto;
  if v_p.id is null or not coalesce(v_p.activo, true) or coalesce(v_p.descontinuado, false) then
    return jsonb_build_object('ok', false, 'error', 'producto_no_disponible');
  end if;
  if v_p.presentacion = 'Granel' or v_p.tipo_venta = 2 then
    return jsonb_build_object('ok', false, 'error', 'granel_no_soportado');
  end if;
  if p_cantidad is null or p_cantidad <= 0 or p_cantidad <> trunc(p_cantidad) then
    return jsonb_build_object('ok', false, 'error', 'cantidad_invalida');
  end if;
  v_base := case v_nivel
              when 'tienda'      then v_p.precio_tienda
              when 'restaurante' then v_p.precio_restaurante
              when 'mayorista'   then coalesce(nullif(v_p.precio_mayorista, 0), v_p.precio_tienda)
              when 'mostrador'   then v_p.precio_mostrador
              else v_p.precio_consumidor end;
  if v_base is null then
    return jsonb_build_object('ok', false, 'error', 'producto_no_disponible');
  end if;
  v_pct   := coalesce(v_p.descuento_pct, 0);
  v_pcaja := case v_caja when 3 then v_p.precio_caja_3 when 6 then v_p.precio_caja_6 when 12 then v_p.precio_caja_12 else null end;
  if coalesce(v_pcaja, 0) <= 0 then v_pcaja := null; end if;
  if v_nivel in ('tienda', 'mayorista') and v_pcaja is not null and v_caja > 0 and mod(p_cantidad, v_caja) = 0 then
    v_sub  := round(p_cantidad / v_caja * v_pcaja, 2);
    v_unit := round(v_pcaja / v_caja, 2);
  else
    v_unit := case when v_pct > 0 then round(v_base * (1 - v_pct / 100.0)) else v_base end;
    v_sub  := round(p_cantidad * v_unit, 2);
  end if;

  -- La promocion compite y gana solo si deja el precio mas bajo (D2). Mismo
  -- `promocion_mejor` que usa crear_pedido: si el editor cotizara distinto,
  -- editar un pedido le cambiaria el precio al cliente sin motivo.
  select m.id_promocion, m.precio_unitario into v_promo_id, v_promo_unit
    from public.promocion_mejor(v_p.id, v_nivel, current_date) m;
  if v_promo_unit is not null and v_promo_unit < v_unit then
    v_unit := v_promo_unit;
    v_sub  := round(p_cantidad * v_unit, 2);
  else
    v_promo_id := null;
  end if;
  return jsonb_build_object(
    'ok', true, 'idProducto', v_p.id::text, 'sabor', v_p.sabor, 'presentacion', v_p.presentacion,
    'tipoVenta', 'Por Pieza', 'cantidad', p_cantidad, 'gramos', 0,
    'precioUnitario', v_unit, 'subtotal', v_sub,
    'descuento', greatest(0, round(p_cantidad * v_base, 2) - v_sub),
    'piezasPorCaja', case when v_nivel in ('tienda', 'mayorista') and v_caja > 0 then v_caja else null end,
    'idPromocion', v_promo_id);
end $function$;

-- ── 4 ─────────────────────────────────────────────────────────────────
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
  v_promo_id     BIGINT;    -- PROMOCION que gano esta linea, si alguna
  v_promo_unit   NUMERIC;   -- lo que costaria la pieza con esa promocion

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
    v_promo_id := NULL; v_promo_unit := NULL;
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

      -- PROMOCIONES (24 nov 2026, decision D2 de cambios/2026-11-24-promociones-diseno.md).
      -- Una promocion NO se suma a la caja ni al descuento de lista: es un
      -- candidato mas, y se queda el precio MAS BAJO para el cliente. Con un
      -- orden fijo, una promocion podia salir peor que el precio de caja que
      -- esa tienda ya tenia y se le cobraba de mas justo el dia de la promo.
      -- El precio lo da `promocion_mejor`, que es el MISMO que ve la app
      -- (catalogo_promociones) y el editor (cotizar_linea): una sola fuente.
      SELECT m.id_promocion, m.precio_unitario INTO v_promo_id, v_promo_unit
        FROM public.promocion_mejor(v_p.id, v_nivel, CURRENT_DATE) m;
      IF v_promo_unit IS NOT NULL AND v_promo_unit < v_unit THEN
        v_unit      := v_promo_unit;
        v_sub_linea := ROUND(v_cant * v_unit, 2);
      ELSE
        v_promo_id := NULL;   -- no gano: la linea no lleva promocion
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
      'idPromocion',  v_promo_id,
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
      piezas_por_caja, puntos_canje, id_promocion
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
      COALESCE((v_producto->>'puntosCanje')::INTEGER, 0),
      NULLIF(v_producto->>'idPromocion', '')::BIGINT
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

commit;
