


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."abrir_caja_dia"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id_punto      BIGINT;
  v_fecha         DATE;
  v_saldo_ini     NUMERIC;
  v_actor         TEXT;
  v_id_caja       BIGINT;
  v_existente     caja_dias%ROWTYPE;
BEGIN
  v_id_punto := COALESCE((p_data->>'idPunto')::BIGINT, 0);
  v_fecha := COALESCE((p_data->>'fecha')::DATE, CURRENT_DATE);
  v_saldo_ini := COALESCE((p_data->>'saldoInicial')::NUMERIC, 0);
  v_actor := COALESCE(p_data->>'actor', 'sistema');

  IF v_id_punto = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Falta idPunto');
  END IF;

  -- Si ya existe caja del día, devolverla
  SELECT * INTO v_existente FROM caja_dias
  WHERE id_punto = v_id_punto AND fecha = v_fecha LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idCajaDia', v_existente.id,
      'duplicado', true,
      'estatus', v_existente.estatus
    );
  END IF;

  -- Crear caja
  INSERT INTO caja_dias (id_punto, fecha, saldo_apertura, abierta_por, notas_apertura)
  VALUES (v_id_punto, v_fecha, v_saldo_ini, v_actor, p_data->>'notas')
  RETURNING id INTO v_id_caja;

  -- Movimiento de apertura
  INSERT INTO caja_movimientos (id_caja_dia, id_punto, tipo, monto, descripcion, actor)
  VALUES (v_id_caja, v_id_punto, 'apertura', v_saldo_ini,
          'Apertura del día' || COALESCE(' — ' || (p_data->>'notas'), ''),
          v_actor);

  -- Asociar movimientos huérfanos del día (pedidos pagados, gastos aprobados antes de abrir)
  UPDATE caja_movimientos
  SET id_caja_dia = v_id_caja
  WHERE id_caja_dia IS NULL
    AND id_punto = v_id_punto
    AND fecha::DATE = v_fecha
    AND tipo <> 'apertura';

  RETURN jsonb_build_object('ok', true, 'idCajaDia', v_id_caja, 'saldoInicial', v_saldo_ini);
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."abrir_caja_dia"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."actualizar_estatus_pedido"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id_orden     BIGINT;
  v_est_ped      TEXT;
  v_est_pag      TEXT;
  v_actor        TEXT;
  v_orden_ant    ordenes%ROWTYPE;
  v_puntos       INTEGER;
  v_puntos_dad   INTEGER := 0;
  v_puntos_rev   INTEGER := 0;
BEGIN
  v_id_orden := COALESCE((p_data->>'idOrden')::BIGINT, 0);
  IF v_id_orden = 0 THEN
    SELECT id INTO v_id_orden FROM ordenes WHERE consecutivo = p_data->>'idOrden' LIMIT 1;
    IF v_id_orden IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Pedido no encontrado');
    END IF;
  END IF;

  v_est_ped := p_data->>'estatusPedido';
  v_est_pag := p_data->>'estatusPago';
  v_actor := COALESCE(p_data->>'actualizadoPor', '');

  SELECT * INTO v_orden_ant FROM ordenes WHERE id = v_id_orden LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Pedido no encontrado');
  END IF;

  UPDATE ordenes SET
    estatus_pedido     = COALESCE(v_est_ped, estatus_pedido),
    estatus_pago       = COALESCE(v_est_pag, estatus_pago),
    fecha_pago         = CASE WHEN v_est_pag = 'Pagado' AND fecha_pago IS NULL THEN NOW() ELSE fecha_pago END,
    fecha_entrega_real = CASE WHEN v_est_ped = 'Entregado' AND fecha_entrega_real IS NULL THEN NOW() ELSE fecha_entrega_real END,
    actualizado_por    = NULLIF(v_actor, '')
  WHERE id = v_id_orden;

  -- A) Pago pasó a Pagado: GENERAR puntos
  IF v_est_pag = 'Pagado'
     AND v_orden_ant.estatus_pago <> 'Pagado'
     AND v_orden_ant.id_cliente IS NOT NULL
     AND v_orden_ant.id_cliente <> 999999
     AND COALESCE(v_orden_ant.tipo_interno, '') = ''
     AND v_orden_ant.total > 0
     AND COALESCE(v_orden_ant.estatus_pedido, '') <> 'Cancelado'
  THEN
    v_puntos := FLOOR(v_orden_ant.total / 100);
    IF v_puntos > 0 THEN
      PERFORM agregar_movimiento_lealtad(
        v_orden_ant.id_cliente, 'generacion', v_puntos,
        v_orden_ant.id, v_orden_ant.consecutivo, NULL, NULL,
        v_orden_ant.total,
        'Puntos por pedido ' || v_orden_ant.consecutivo || ' (pagado)',
        COALESCE(NULLIF(v_actor, ''), 'sistema')
      );
      v_puntos_dad := v_puntos;
    END IF;
  END IF;

  -- B) Pedido pagado cancelado: REVERTIR puntos
  IF v_est_ped = 'Cancelado'
     AND v_orden_ant.estatus_pedido <> 'Cancelado'
     AND v_orden_ant.estatus_pago = 'Pagado'
     AND v_orden_ant.id_cliente IS NOT NULL
     AND v_orden_ant.id_cliente <> 999999
     AND COALESCE(v_orden_ant.tipo_interno, '') = ''
     AND v_orden_ant.total > 0
  THEN
    v_puntos := FLOOR(v_orden_ant.total / 100);
    IF v_puntos > 0 THEN
      PERFORM agregar_movimiento_lealtad(
        v_orden_ant.id_cliente, 'reversion', -v_puntos,
        v_orden_ant.id, v_orden_ant.consecutivo, NULL, NULL,
        v_orden_ant.total,
        'Reversión por cancelación de ' || v_orden_ant.consecutivo,
        COALESCE(NULLIF(v_actor, ''), 'sistema')
      );
      v_puntos_rev := v_puntos;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'msg', 'Estatus actualizado',
    'puntosOtorgados', v_puntos_dad,
    'puntosRevertidos', v_puntos_rev
  );
END;
$$;


ALTER FUNCTION "public"."actualizar_estatus_pedido"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."actualizar_tipo_cliente"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id      BIGINT;
  v_tipo_id INTEGER;
  v_tipo    TEXT;
BEGIN
  v_id := COALESCE((p_data->>'idCliente')::BIGINT, 0);
  v_tipo_id := COALESCE((p_data->>'tipoId')::INTEGER, 0);
  v_tipo := p_data->>'tipo';

  UPDATE clientes SET
    tipo_id = COALESCE(v_tipo_id, tipo_id),
    tipo = COALESCE(v_tipo, tipo),
    fecha_actualizacion = NOW()
  WHERE id = v_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Cliente no encontrado');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;


ALTER FUNCTION "public"."actualizar_tipo_cliente"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."agregar_movimiento_lealtad"("p_id_cliente" bigint, "p_tipo" "text", "p_puntos" integer, "p_id_orden" bigint DEFAULT NULL::bigint, "p_consecutivo" "text" DEFAULT NULL::"text", "p_id_premio" bigint DEFAULT NULL::bigint, "p_nombre_premio" "text" DEFAULT NULL::"text", "p_monto_origen" numeric DEFAULT NULL::numeric, "p_nota" "text" DEFAULT NULL::"text", "p_actor" "text" DEFAULT 'sistema'::"text") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id BIGINT;
BEGIN
  IF p_puntos = 0 THEN RETURN NULL; END IF;

  INSERT INTO lealtad_movimientos (
    id_cliente, tipo, puntos,
    id_orden, consecutivo, id_premio, nombre_premio,
    monto_origen, nota, actor
  ) VALUES (
    p_id_cliente, p_tipo, p_puntos,
    p_id_orden, p_consecutivo, p_id_premio, p_nombre_premio,
    p_monto_origen, p_nota, p_actor
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;


ALTER FUNCTION "public"."agregar_movimiento_lealtad"("p_id_cliente" bigint, "p_tipo" "text", "p_puntos" integer, "p_id_orden" bigint, "p_consecutivo" "text", "p_id_premio" bigint, "p_nombre_premio" "text", "p_monto_origen" numeric, "p_nota" "text", "p_actor" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."agregar_punto"("p_id_cliente" bigint, "p_nombre" "text" DEFAULT NULL::"text", "p_telefono" "text" DEFAULT NULL::"text", "p_puntos" integer DEFAULT 1) RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_lealtad lealtad%ROWTYPE;
BEGIN
  SELECT * INTO v_lealtad FROM lealtad WHERE id_cliente = p_id_cliente LIMIT 1;
  IF NOT FOUND THEN
    -- Crear registro
    INSERT INTO lealtad (id_cliente, nombre, telefono, puntos_actuales, puntos_ganados)
    VALUES (p_id_cliente, p_nombre, p_telefono, p_puntos, p_puntos)
    RETURNING * INTO v_lealtad;
  ELSE
    UPDATE lealtad SET
      puntos_actuales = puntos_actuales + p_puntos,
      puntos_ganados = puntos_ganados + p_puntos,
      fecha_ultimo_movimiento = NOW()
    WHERE id_cliente = p_id_cliente
    RETURNING * INTO v_lealtad;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'puntos_actuales', v_lealtad.puntos_actuales,
    'puntos_ganados', v_lealtad.puntos_ganados
  );
END;
$$;


ALTER FUNCTION "public"."agregar_punto"("p_id_cliente" bigint, "p_nombre" "text", "p_telefono" "text", "p_puntos" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."aplicar_cupon"("p_codigo" "text", "p_id_cliente" bigint DEFAULT NULL::bigint, "p_telefono" "text" DEFAULT NULL::"text", "p_id_orden" "text" DEFAULT NULL::"text", "p_monto_descuento" numeric DEFAULT 0) RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_cupon_id BIGINT;
BEGIN
  SELECT id INTO v_cupon_id FROM cupones WHERE codigo = UPPER(p_codigo) LIMIT 1;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Cupón no encontrado');
  END IF;

  -- Insertar registro de uso
  INSERT INTO cupones_uso (id_cupon, codigo, id_cliente, telefono, id_orden, monto_descuento)
  VALUES (v_cupon_id, UPPER(p_codigo), p_id_cliente, p_telefono, p_id_orden, p_monto_descuento);

  -- Incrementar contador
  UPDATE cupones SET usos_actuales = usos_actuales + 1 WHERE id = v_cupon_id;

  RETURN json_build_object('ok', true, 'msg', 'Cupón aplicado');
END;
$$;


ALTER FUNCTION "public"."aplicar_cupon"("p_codigo" "text", "p_id_cliente" bigint, "p_telefono" "text", "p_id_orden" "text", "p_monto_descuento" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."aprobar_cliente_b2b"("p_id_cliente" bigint, "p_aprobar" boolean, "p_actor" "text" DEFAULT 'admin'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  UPDATE clientes SET
    aprobado_b2b = p_aprobar,
    fecha_actualizacion = NOW()
  WHERE id = p_id_cliente;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Cliente no encontrado');
  END IF;

  RETURN jsonb_build_object('ok', true, 'aprobado', p_aprobar);
END;
$$;


ALTER FUNCTION "public"."aprobar_cliente_b2b"("p_id_cliente" bigint, "p_aprobar" boolean, "p_actor" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."aprobar_gasto"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id BIGINT;
  v_actor TEXT;
BEGIN
  v_id := COALESCE((p_data->>'idGasto')::BIGINT, 0);
  v_actor := p_data->>'aprobadoPor';
  UPDATE gastos SET
    estatus = 'aprobado',
    aprobado_por = v_actor,
    fecha_aprobacion = NOW()
  WHERE id = v_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Gasto no encontrado');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;


ALTER FUNCTION "public"."aprobar_gasto"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."buscar_cliente_telefono"("p_telefono" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_tel text := right(regexp_replace(coalesce(p_telefono,''), '\D', '', 'g'), 10);
  v_row record;
begin
  if length(v_tel) <> 10 then
    return jsonb_build_object('ok', false, 'error', 'Teléfono inválido');
  end if;
  select id, nombre, tipo, coordenadas
    into v_row
    from public.clientes
   where right(regexp_replace(telefono, '\D', '', 'g'), 10) = v_tel
   limit 1;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'Cliente no encontrado');
  end if;
  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'nombre', v_row.nombre,
    'tipo', v_row.tipo,
    'tieneUbicacion', coalesce(nullif(trim(coalesce(v_row.coordenadas,'')), ''), null) is not null
  );
end;
$$;


ALTER FUNCTION "public"."buscar_cliente_telefono"("p_telefono" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."buscar_clientes_ubicacion"("p_q" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_q      text := trim(coalesce(p_q, ''));
  v_digits text := regexp_replace(v_q, '\D', '', 'g');
  v_rows   jsonb;
begin
  if length(v_q) < 3 then
    return jsonb_build_object('ok', false, 'error', 'Búsqueda muy corta');
  end if;

  if length(v_digits) >= 4 and v_digits = regexp_replace(v_q, '\s', '', 'g') then
    -- Solo dígitos: buscar por teléfono (coincidencia al final)
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'nombre', c.nombre, 'tipo', c.tipo,
             'telefono', right(regexp_replace(c.telefono, '\D', '', 'g'), 10),
             'tieneUbicacion', coalesce(nullif(trim(coalesce(c.coordenadas,'')), ''), null) is not null))
      into v_rows
      from (select * from public.clientes
             where regexp_replace(telefono, '\D', '', 'g') like '%' || v_digits
             order by nombre nulls last
             limit 8) c;
  else
    -- Texto: buscar por nombre (contiene, sin distinguir mayúsculas)
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'nombre', c.nombre, 'tipo', c.tipo,
             'telefono', right(regexp_replace(c.telefono, '\D', '', 'g'), 10),
             'tieneUbicacion', coalesce(nullif(trim(coalesce(c.coordenadas,'')), ''), null) is not null))
      into v_rows
      from (select * from public.clientes
             where nombre ilike '%' || v_q || '%'
             order by nombre
             limit 8) c;
  end if;

  return jsonb_build_object('ok', true, 'clientes', coalesce(v_rows, '[]'::jsonb));
end;
$$;


ALTER FUNCTION "public"."buscar_clientes_ubicacion"("p_q" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."buscar_vendedor_por_telefono"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_telefono TEXT;
  v_tel_norm TEXT;
  v_vendedor vendedores%ROWTYPE;
BEGIN
  v_telefono := COALESCE(p_data->>'telefono', '');
  IF v_telefono = '' THEN
    RETURN jsonb_build_object('ok', true, 'esVendedor', false);
  END IF;

  v_tel_norm := REGEXP_REPLACE(v_telefono, '\D', '', 'g');

  -- Buscar por los últimos 10 dígitos (consistente con validar_vendedor_pin)
  SELECT * INTO v_vendedor FROM vendedores
  WHERE RIGHT(REGEXP_REPLACE(COALESCE(telefono, ''), '\D', '', 'g'), 10) = RIGHT(v_tel_norm, 10)
    AND activo = TRUE
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'esVendedor', false);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'esVendedor', true,
    'vendedor', jsonb_build_object(
      'id', v_vendedor.id,
      'nombre', v_vendedor.nombre,
      'telefono', v_vendedor.telefono,
      'rol', v_vendedor.rol,
      'direccionPuntoVenta', v_vendedor.direccion_punto_venta,
      'cpPuntoVenta', v_vendedor.cp_punto_venta
    )
  );
END;
$$;


ALTER FUNCTION "public"."buscar_vendedor_por_telefono"("p_data" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."buscar_vendedor_por_telefono"("p_data" "jsonb") IS 'Verifica si un teléfono pertenece a un vendedor activo. Normaliza por los últimos 10 dígitos.';



CREATE OR REPLACE FUNCTION "public"."buscar_vendedores"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_query TEXT;
  v_result JSONB;
  v_modo TEXT;
BEGIN
  v_query := LOWER(TRIM(COALESCE(p_data->>'query', '')));
  v_modo  := COALESCE(p_data->>'modo', 'checkout');  -- 'checkout' | 'admin'

  -- Para el checkout: solo roles que atienden público
  -- Para admin: todos
  IF v_modo = 'admin' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id,
      'nombre', nombre,
      'rol', rol,
      'telefono', telefono
    ) ORDER BY rol, nombre), '[]'::JSONB) INTO v_result
    FROM vendedores WHERE activo = TRUE;
    RETURN jsonb_build_object('ok', true, 'vendedores', v_result);
  END IF;

  -- Modo checkout: filtrar roles aptos + query opcional
  -- Si query está vacío, devolvemos TODOS los vendedores aptos (para mostrar lista inicial)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id,
    'nombre', nombre,
    'rol', rol,
    'telefono', telefono
  ) ORDER BY
    -- Priorizar match al inicio del nombre
    CASE WHEN v_query <> '' AND LOWER(nombre) LIKE v_query || '%' THEN 0
         WHEN v_query <> '' AND LOWER(nombre) LIKE '%' || v_query || '%' THEN 1
         ELSE 2 END,
    -- Mostrador al inicio
    CASE WHEN rol = 'Mostrador' THEN 0 ELSE 1 END,
    nombre
  ), '[]'::JSONB) INTO v_result
  FROM vendedores
  WHERE activo = TRUE
    AND rol IN ('Vendedor', 'Mostrador', 'Administrador', 'Administrador2')
    AND (v_query = '' OR LOWER(nombre) LIKE '%' || v_query || '%');

  RETURN jsonb_build_object('ok', true, 'vendedores', v_result);
END;
$$;


ALTER FUNCTION "public"."buscar_vendedores"("p_data" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."buscar_vendedores"("p_data" "jsonb") IS 'Busca vendedores. modo="checkout" filtra solo Vendedor/Mostrador. modo="admin" devuelve todos.';



CREATE OR REPLACE FUNCTION "public"."caja_generar_movimiento_al_confirmar"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_codigo_punto TEXT;
  v_id_punto BIGINT;
  v_id_caja BIGINT;
  v_tipo_mov TEXT;
  v_metodo TEXT;
BEGIN
  -- Solo nos importa cuando estatus_caja pasa a 'confirmado'
  IF NEW.estatus_caja <> 'confirmado' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.estatus_caja,'') = 'confirmado' THEN RETURN NEW; END IF;
  IF COALESCE(NEW.total, 0) <= 0 THEN RETURN NEW; END IF;
  IF COALESCE(NEW.tipo_interno,'') <> '' THEN RETURN NEW; END IF;

  -- Idempotencia
  IF EXISTS (SELECT 1 FROM caja_movimientos WHERE id_orden = NEW.id) THEN
    RETURN NEW;
  END IF;

  v_metodo := LOWER(COALESCE(NEW.tipo_pago, ''));
  IF NEW.tipo_pago_id = 1 OR v_metodo IN ('efectivo','cash') THEN
    v_codigo_punto := 'punto_venta';
    v_tipo_mov := 'venta_efectivo';
  ELSE
    v_codigo_punto := 'cuenta_banco';
    v_tipo_mov := CASE WHEN v_metodo LIKE '%tarjeta%' THEN 'venta_tarjeta' ELSE 'venta_transferencia' END;
  END IF;

  SELECT id INTO v_id_punto FROM caja_puntos WHERE codigo = v_codigo_punto LIMIT 1;
  IF v_id_punto IS NULL THEN RETURN NEW; END IF;

  SELECT id INTO v_id_caja FROM caja_dias
  WHERE id_punto = v_id_punto AND fecha = CURRENT_DATE AND estatus = 'abierta'
  LIMIT 1;

  INSERT INTO caja_movimientos (
    id_caja_dia, id_punto, tipo, monto,
    id_orden, consecutivo_pedido, descripcion, actor
  ) VALUES (
    v_id_caja, v_id_punto, v_tipo_mov, NEW.total,
    NEW.id, NEW.consecutivo,
    'Venta ' || NEW.consecutivo || COALESCE(' — ' || NEW.nombre_cliente, '') ||
      CASE WHEN NEW.id_vendedor IS NOT NULL AND NOT (LOWER(COALESCE(NEW.canal,'')) IN ('mostrador','tienda'))
           THEN ' (vía ' || COALESCE(NEW.nombre_vendedor, 'vendedor') || ')'
           ELSE '' END,
    COALESCE(NEW.confirmado_por, NEW.actualizado_por, 'sistema')
  );

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."caja_generar_movimiento_al_confirmar"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."caja_movimiento_por_gasto"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_codigo_punto TEXT;
  v_id_punto BIGINT;
  v_id_caja BIGINT;
  v_tipo_mov TEXT;
BEGIN
  -- Solo si pasa a aprobado (no estaba aprobado antes)
  IF NEW.estatus <> 'aprobado' THEN RETURN NEW; END IF;
  IF OLD.estatus = 'aprobado' THEN RETURN NEW; END IF;

  -- Solo gastos con fuente Crunchy (Inversión personal NO afecta caja Crunchy)
  IF LOWER(COALESCE(NEW.fuente_dinero, '')) NOT IN ('crunchy', '') THEN RETURN NEW; END IF;

  -- Decidir punto de caja
  IF LOWER(COALESCE(NEW.metodo_pago, '')) IN ('efectivo', 'cash') THEN
    v_codigo_punto := 'punto_venta';
    v_tipo_mov := 'gasto_efectivo';
  ELSIF LOWER(COALESCE(NEW.metodo_pago, '')) IN ('transferencia', 'tarjeta', 'tdc', 'tdd') THEN
    v_codigo_punto := 'cuenta_banco';
    v_tipo_mov := 'gasto_transferencia';
  ELSE
    RETURN NEW;
  END IF;

  SELECT id INTO v_id_punto FROM caja_puntos WHERE codigo = v_codigo_punto LIMIT 1;
  IF v_id_punto IS NULL THEN RETURN NEW; END IF;

  SELECT id INTO v_id_caja FROM caja_dias
  WHERE id_punto = v_id_punto AND fecha = CURRENT_DATE AND estatus = 'abierta'
  LIMIT 1;

  INSERT INTO caja_movimientos (
    id_caja_dia, id_punto, tipo, monto,
    id_gasto, descripcion, actor
  ) VALUES (
    v_id_caja, v_id_punto, v_tipo_mov, -ABS(NEW.monto),
    NEW.id,
    'Gasto ' || NEW.categoria || COALESCE(' — ' || NEW.descripcion, ''),
    COALESCE(NEW.aprobado_por, 'sistema')
  );

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."caja_movimiento_por_gasto"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."caja_movimiento_por_pedido"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_old_estatus_pago TEXT;
  v_canal_es_mostrador BOOLEAN;
  v_metodo TEXT;
BEGIN
  v_old_estatus_pago := CASE WHEN TG_OP = 'INSERT' THEN '' ELSE COALESCE(OLD.estatus_pago, '') END;

  -- Si el pago pasa a Pagado y no estaba Pagado antes, asignar estatus_caja
  IF NEW.estatus_pago = 'Pagado' AND v_old_estatus_pago <> 'Pagado'
     AND COALESCE(NEW.tipo_interno,'') = ''
     AND NEW.total > 0
     AND NEW.estatus_caja IS NULL  -- evita sobrescribir si ya fue confirmado
  THEN
    v_metodo := LOWER(COALESCE(NEW.tipo_pago, ''));
    v_canal_es_mostrador := LOWER(COALESCE(NEW.canal,'')) IN ('mostrador','tienda');

    IF NEW.tipo_pago_id = 1 OR v_metodo IN ('efectivo','cash') THEN
      -- Efectivo: si es mostrador, confirmado de una vez. Si es vendedor, pendiente_entrega.
      IF v_canal_es_mostrador OR NEW.id_vendedor IS NULL THEN
        NEW.estatus_caja := 'confirmado';
        NEW.fecha_confirmacion_caja := NOW();
        NEW.confirmado_por := COALESCE(NEW.actualizado_por, 'sistema');
      ELSE
        NEW.estatus_caja := 'pendiente_entrega';
      END IF;
    ELSE
      -- Transferencia/tarjeta: pendiente de confirmación bancaria
      NEW.estatus_caja := 'pendiente_confirmacion';
    END IF;
  END IF;

  -- Si pedido se cancela, limpiar estatus_caja
  IF NEW.estatus_pedido = 'Cancelado' AND COALESCE(OLD.estatus_pedido,'') <> 'Cancelado' THEN
    NEW.estatus_caja := NULL;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."caja_movimiento_por_pedido"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cambiar_pin_vendedor"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id BIGINT;
  v_pin_nuevo TEXT;
BEGIN
  v_id := COALESCE((p_data->>'idVendedor')::BIGINT, 0);
  v_pin_nuevo := COALESCE(p_data->>'pinNuevo', '');

  IF v_id = 0 OR v_pin_nuevo = '' OR LENGTH(v_pin_nuevo) < 4 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Faltan datos o PIN muy corto (mínimo 4)');
  END IF;

  UPDATE vendedores SET pin_hash = crypt(v_pin_nuevo, gen_salt('bf'))
  WHERE id = v_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Vendedor no encontrado');
  END IF;

  RETURN jsonb_build_object('ok', true, 'msg', 'PIN actualizado');
END;
$$;


ALTER FUNCTION "public"."cambiar_pin_vendedor"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."canjear_premio"("p_id_cliente" bigint, "p_id_premio" bigint) RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_lealtad lealtad%ROWTYPE;
  v_premio premios%ROWTYPE;
BEGIN
  SELECT * INTO v_premio FROM premios WHERE id = p_id_premio AND activo = TRUE;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Premio no disponible');
  END IF;

  IF v_premio.stock = 0 THEN
    RETURN json_build_object('ok', false, 'error', 'Premio agotado');
  END IF;

  SELECT * INTO v_lealtad FROM lealtad WHERE id_cliente = p_id_cliente;
  IF NOT FOUND OR v_lealtad.puntos_actuales < v_premio.puntos_costo THEN
    RETURN json_build_object('ok', false, 'error', 'Puntos insuficientes');
  END IF;

  -- Descontar puntos
  UPDATE lealtad SET
    puntos_actuales = puntos_actuales - v_premio.puntos_costo,
    puntos_canjeados = puntos_canjeados + v_premio.puntos_costo,
    fecha_ultimo_movimiento = NOW()
  WHERE id_cliente = p_id_cliente;

  -- Reducir stock si aplica
  IF v_premio.stock > 0 THEN
    UPDATE premios SET stock = stock - 1 WHERE id = p_id_premio;
  END IF;

  -- Registrar canje
  INSERT INTO canjes (id_cliente, id_premio, nombre_premio, puntos_usados)
  VALUES (p_id_cliente, p_id_premio, v_premio.nombre, v_premio.puntos_costo);

  RETURN json_build_object(
    'ok', true,
    'msg', format('Canjeaste %s por %s pts', v_premio.nombre, v_premio.puntos_costo),
    'puntos_restantes', v_lealtad.puntos_actuales - v_premio.puntos_costo
  );
END;
$$;


ALTER FUNCTION "public"."canjear_premio"("p_id_cliente" bigint, "p_id_premio" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."canjear_premio"("p_id_cliente" bigint, "p_id_premio" bigint, "p_actor" "text" DEFAULT 'cliente'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_premio premios%ROWTYPE;
  v_saldo INTEGER;
  v_id_mov BIGINT;
BEGIN
  SELECT * INTO v_premio FROM premios WHERE id = p_id_premio AND activo = TRUE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Premio no disponible');
  END IF;
  IF v_premio.stock = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Premio agotado');
  END IF;

  -- Saldo actual del cliente desde la vista
  SELECT puntos_actuales INTO v_saldo FROM saldos_lealtad WHERE id_cliente = p_id_cliente;
  v_saldo := COALESCE(v_saldo, 0);
  IF v_saldo < v_premio.puntos_costo THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Puntos insuficientes');
  END IF;

  -- Registrar movimiento negativo
  v_id_mov := agregar_movimiento_lealtad(
    p_id_cliente, 'canje', -v_premio.puntos_costo,
    NULL, NULL, v_premio.id, v_premio.nombre, NULL,
    'Canje: ' || v_premio.nombre, p_actor
  );

  -- Stock
  IF v_premio.stock > 0 THEN
    UPDATE premios SET stock = stock - 1 WHERE id = p_id_premio;
  END IF;

  -- Historial
  INSERT INTO canjes_historial (id_cliente, id_premio, nombre_premio, puntos_usados, id_movimiento)
  VALUES (p_id_cliente, p_id_premio, v_premio.nombre, v_premio.puntos_costo, v_id_mov);

  RETURN jsonb_build_object(
    'ok', true,
    'msg', format('Canjeaste %s por %s pts', v_premio.nombre, v_premio.puntos_costo),
    'puntosRestantes', v_saldo - v_premio.puntos_costo,
    'idMovimiento', v_id_mov
  );
END;
$$;


ALTER FUNCTION "public"."canjear_premio"("p_id_cliente" bigint, "p_id_premio" bigint, "p_actor" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cerrar_caja_dia"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id_caja       BIGINT;
  v_saldo_decl    NUMERIC;
  v_actor         TEXT;
  v_caja          caja_dias%ROWTYPE;
  v_saldo_calc    NUMERIC;
  v_diferencia    NUMERIC;
BEGIN
  v_id_caja := COALESCE((p_data->>'idCajaDia')::BIGINT, 0);
  v_saldo_decl := COALESCE((p_data->>'saldoDeclarado')::NUMERIC, 0);
  v_actor := COALESCE(p_data->>'actor', 'sistema');

  SELECT * INTO v_caja FROM caja_dias WHERE id = v_id_caja LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Caja no encontrada');
  END IF;
  IF v_caja.estatus = 'cerrada' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Caja ya estaba cerrada');
  END IF;

  -- Calcular saldo: apertura + todos los movimientos NO-apertura
  SELECT v_caja.saldo_apertura + COALESCE(SUM(monto), 0)
  INTO v_saldo_calc
  FROM caja_movimientos
  WHERE id_caja_dia = v_id_caja AND tipo <> 'apertura';

  v_diferencia := v_saldo_decl - v_saldo_calc;

  UPDATE caja_dias SET
    estatus                = 'cerrada',
    saldo_cierre_declarado = v_saldo_decl,
    saldo_cierre_calculado = v_saldo_calc,
    diferencia             = v_diferencia,
    cerrada_por            = v_actor,
    fecha_cierre           = NOW(),
    notas_cierre           = p_data->>'notas'
  WHERE id = v_id_caja;

  -- Movimiento de cierre con la diferencia (si la hay)
  IF v_diferencia <> 0 THEN
    INSERT INTO caja_movimientos (id_caja_dia, id_punto, tipo, monto, descripcion, actor)
    VALUES (v_id_caja, v_caja.id_punto,
            CASE WHEN v_diferencia > 0 THEN 'ajuste_pos' ELSE 'ajuste_neg' END,
            v_diferencia,
            'Ajuste por cierre — ' ||
              CASE WHEN v_diferencia > 0 THEN 'sobrante' ELSE 'faltante' END,
            v_actor);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'saldoCalculado', v_saldo_calc,
    'saldoDeclarado', v_saldo_decl,
    'diferencia', v_diferencia
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."cerrar_caja_dia"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."confirmar_caja_pedido"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id_orden BIGINT;
  v_actor TEXT;
  v_orden ordenes%ROWTYPE;
BEGIN
  v_id_orden := COALESCE((p_data->>'idOrden')::BIGINT, 0);
  v_actor := COALESCE(p_data->>'actor', 'admin');

  IF v_id_orden = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Falta idOrden');
  END IF;

  SELECT * INTO v_orden FROM ordenes WHERE id = v_id_orden LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Pedido no encontrado');
  END IF;

  IF v_orden.estatus_caja = 'confirmado' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Pedido ya estaba confirmado');
  END IF;
  IF v_orden.estatus_caja IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Pedido no está pendiente (verifica que esté pagado y no cancelado)');
  END IF;

  UPDATE ordenes SET
    estatus_caja = 'confirmado',
    fecha_confirmacion_caja = NOW(),
    confirmado_por = v_actor
  WHERE id = v_id_orden;

  RETURN jsonb_build_object('ok', true, 'idOrden', v_id_orden, 'consec', v_orden.consecutivo);
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."confirmar_caja_pedido"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."convertir_prospecto_a_cliente"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id_prospecto BIGINT;
  v_telefono TEXT;
  v_id_vendedor BIGINT;
  v_nombre_vendedor TEXT;
  v_prospecto RECORD;
  v_id_cliente BIGINT;
  v_tel_norm TEXT;
BEGIN
  v_id_prospecto := COALESCE((p_data->>'id')::BIGINT, 0);
  v_telefono := COALESCE(p_data->>'telefono', '');
  v_id_vendedor := NULLIF(p_data->>'idVendedor', '')::BIGINT;
  v_nombre_vendedor := p_data->>'nombreVendedor';

  IF v_id_prospecto = 0 AND v_telefono = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Faltan datos');
  END IF;

  -- Buscar prospecto
  IF v_id_prospecto > 0 THEN
    SELECT * INTO v_prospecto FROM prospectos WHERE id = v_id_prospecto LIMIT 1;
  ELSE
    v_tel_norm := REGEXP_REPLACE(v_telefono, '\D', '', 'g');
    SELECT * INTO v_prospecto FROM prospectos
    WHERE RIGHT(REGEXP_REPLACE(COALESCE(telefono,''), '\D', '', 'g'), 10) = RIGHT(v_tel_norm, 10)
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Prospecto no encontrado');
  END IF;

  -- Verificar si ya existe como cliente
  v_tel_norm := REGEXP_REPLACE(COALESCE(v_prospecto.telefono,''), '\D', '', 'g');
  SELECT id INTO v_id_cliente FROM clientes
  WHERE RIGHT(REGEXP_REPLACE(COALESCE(telefono,''), '\D', '', 'g'), 10) = RIGHT(v_tel_norm, 10)
  LIMIT 1;

  IF FOUND THEN
    -- Ya existe — solo actualizar vendedor y eliminar prospecto
    UPDATE clientes SET
      id_vendedor = v_id_vendedor,
      vendedor = v_nombre_vendedor,
      fecha_actualizacion = NOW()
    WHERE id = v_id_cliente;
  ELSE
    -- Crear cliente nuevo desde prospecto
    INSERT INTO clientes (
      tipo, tipo_id, nombre, telefono, direccion, cp, colonia, municipio, estado,
      id_vendedor, vendedor, aprobado_b2b, notas
    ) VALUES (
      COALESCE(v_prospecto.tipo, 'tienda'),
      COALESCE(v_prospecto.tipo_id, 3),
      v_prospecto.nombre,
      v_prospecto.telefono,
      v_prospecto.direccion,
      v_prospecto.cp,
      v_prospecto.colonia,
      v_prospecto.municipio,
      v_prospecto.estado,
      v_id_vendedor,
      v_nombre_vendedor,
      FALSE,  -- aún no aprobado B2B; admin lo aprueba luego
      'Convertido desde prospecto #' || v_prospecto.id || COALESCE(' — ' || v_prospecto.notas, '')
    ) RETURNING id INTO v_id_cliente;
  END IF;

  -- Marcar prospecto como convertido
  UPDATE prospectos SET
    estatus = 'convertido',
    id_cliente_creado = v_id_cliente,
    fecha_conversion = NOW()
  WHERE id = v_prospecto.id;

  RETURN jsonb_build_object('ok', true, 'idCliente', v_id_cliente, 'msg', 'Prospecto convertido a cliente');
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."convertir_prospecto_a_cliente"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."corregir_metodo_pago_pedido"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id_orden BIGINT;
  v_nuevo_metodo TEXT;
  v_nuevo_metodo_id INTEGER;
  v_orden ordenes%ROWTYPE;
  v_actor TEXT;
BEGIN
  v_id_orden := COALESCE((p_data->>'idOrden')::BIGINT, 0);
  v_nuevo_metodo := p_data->>'nuevoMetodo'; -- 'Efectivo' | 'Transferencia' | 'Tarjeta'
  v_actor := COALESCE(p_data->>'actor', 'admin');

  IF v_id_orden = 0 OR v_nuevo_metodo IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Faltan datos: idOrden, nuevoMetodo');
  END IF;

  SELECT * INTO v_orden FROM ordenes WHERE id = v_id_orden LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Pedido no encontrado');
  END IF;

  -- No permitir corregir si ya fue confirmado (movimiento ya generado)
  IF v_orden.estatus_caja = 'confirmado' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No se puede cambiar: pedido ya confirmado. Revierte primero.');
  END IF;

  -- Mapear método a tipo_pago_id
  v_nuevo_metodo_id := CASE LOWER(v_nuevo_metodo)
    WHEN 'efectivo' THEN 1
    WHEN 'transferencia' THEN 2
    WHEN 'tarjeta' THEN 3
    ELSE 0
  END;

  -- Recalcular estatus_caja según el nuevo método
  DECLARE
    v_nuevo_estatus_caja TEXT;
    v_canal_es_mostrador BOOLEAN;
  BEGIN
    v_canal_es_mostrador := LOWER(COALESCE(v_orden.canal,'')) IN ('mostrador','tienda');

    IF v_nuevo_metodo_id = 1 THEN
      v_nuevo_estatus_caja := CASE WHEN v_canal_es_mostrador OR v_orden.id_vendedor IS NULL THEN 'confirmado' ELSE 'pendiente_entrega' END;
    ELSE
      v_nuevo_estatus_caja := 'pendiente_confirmacion';
    END IF;

    UPDATE ordenes SET
      tipo_pago = v_nuevo_metodo,
      tipo_pago_id = v_nuevo_metodo_id,
      estatus_caja = v_nuevo_estatus_caja,
      fecha_confirmacion_caja = CASE WHEN v_nuevo_estatus_caja = 'confirmado' THEN NOW() ELSE NULL END,
      confirmado_por = CASE WHEN v_nuevo_estatus_caja = 'confirmado' THEN v_actor ELSE NULL END,
      actualizado_por = v_actor
    WHERE id = v_id_orden;
  END;

  RETURN jsonb_build_object('ok', true, 'idOrden', v_id_orden, 'nuevoEstatusCaja',
    (SELECT estatus_caja FROM ordenes WHERE id = v_id_orden));
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."corregir_metodo_pago_pedido"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."crear_caja_vendedor"("p_id_vendedor" bigint, "p_nombre" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_codigo TEXT;
  v_id     BIGINT;
  v_existente caja_puntos%ROWTYPE;
BEGIN
  IF p_id_vendedor IS NULL OR p_nombre IS NULL OR TRIM(p_nombre) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Faltan datos');
  END IF;

  v_codigo := 'vendedor_' || p_id_vendedor;

  -- Idempotente: si ya existe, devolverla
  SELECT * INTO v_existente FROM caja_puntos WHERE codigo = v_codigo LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'idPunto', v_existente.id, 'duplicado', true);
  END IF;

  INSERT INTO caja_puntos (codigo, nombre, tipo, subtipo, id_vendedor, fondo_minimo, orden_display)
  VALUES (
    v_codigo,
    'Efectivo ' || p_nombre,
    'efectivo',
    'vendedor_personal',
    p_id_vendedor,
    0,
    10 + p_id_vendedor::INTEGER  -- después de los puntos centrales
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'idPunto', v_id, 'duplicado', false);
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."crear_caja_vendedor"("p_id_vendedor" bigint, "p_nombre" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."crear_pedido"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_idempotency  TEXT;
  v_existente    ordenes%ROWTYPE;
  v_id_orden     BIGINT;
  v_consec       TEXT;
  v_canal        TEXT;
  v_subtotal     NUMERIC;
  v_descuento    NUMERIC;
  v_total        NUMERIC;
  v_tipo_int     TEXT;
  v_estatus_ped  TEXT;
  v_estatus_pag  TEXT;
  v_fecha_pago   TIMESTAMPTZ;
  v_producto     JSONB;
  v_id_cliente   BIGINT;
  v_telefono     TEXT;
  v_nombre_cli   TEXT;
  v_filas_det    INTEGER := 0;
BEGIN
  v_idempotency := COALESCE(p_data->>'idempotencyKey', '');
  v_canal := COALESCE(p_data->>'canal', 'web');
  v_tipo_int := COALESCE(p_data->>'tipoInterno', '');
  v_id_cliente := NULLIF(p_data->>'idCliente', '')::BIGINT;
  v_telefono := p_data->>'telefono';
  v_nombre_cli := COALESCE(p_data->>'nombreCliente', '');

  -- 1) Idempotency
  IF v_idempotency <> '' THEN
    SELECT * INTO v_existente FROM ordenes WHERE idempotency_key = v_idempotency LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', true, 'duplicado', true,
        'idOrden', v_existente.id, 'consecutivo', v_existente.consecutivo
      );
    END IF;
  END IF;

  -- 2) Totales
  v_subtotal := COALESCE((p_data->>'subtotal')::NUMERIC, 0);
  v_descuento := COALESCE((p_data->>'descuento')::NUMERIC, 0);
  v_total := COALESCE((p_data->>'total')::NUMERIC, v_subtotal - v_descuento);
  IF v_tipo_int <> '' THEN
    v_total := 0; v_subtotal := 0; v_descuento := 0;
  END IF;

  -- 3) Estatus por canal
  v_estatus_ped := 'Pendiente';
  v_estatus_pag := 'Pendiente';
  IF v_canal = 'mostrador' OR v_tipo_int <> '' THEN
    v_estatus_ped := 'Entregado';
    v_estatus_pag := 'Pagado';
    v_fecha_pago := NOW();
  END IF;

  -- 4) Generar consecutivo
  v_consec := siguiente_consecutivo();

  -- 5) Insertar orden
  INSERT INTO ordenes (
    consecutivo, canal, id_cliente, nombre_cliente,
    id_vendedor, nombre_vendedor,
    fecha_orden, fecha_entrega, fecha_pago,
    tipo_pago_id, tipo_pago,
    estatus_pedido, estatus_pago,
    subtotal, descuento, total, notas,
    cp, colonia, municipio, estado, direccion, coordenadas,
    zona_entrega, stripe_payment_id, cupon_codigo, tipo_interno,
    idempotency_key
  ) VALUES (
    v_consec, v_canal, v_id_cliente, v_nombre_cli,
    NULLIF(p_data->>'idVendedor', '')::BIGINT, p_data->>'nombreVendedor',
    NOW(), COALESCE((p_data->>'fechaEntrega')::TIMESTAMPTZ, NOW()), v_fecha_pago,
    COALESCE((p_data->>'tipoPagoId')::INTEGER, 0), p_data->>'tipoPago',
    v_estatus_ped, v_estatus_pag, v_subtotal, v_descuento, v_total,
    p_data->>'notas', p_data->>'cp', p_data->>'colonia', p_data->>'municipio',
    p_data->>'estado', p_data->>'direccion', p_data->>'coordenadas',
    COALESCE(p_data->>'zonaEntrega', 'cdmx'),
    p_data->>'stripePaymentId',
    UPPER(COALESCE(p_data->>'cuponCodigo', '')),
    v_tipo_int,
    NULLIF(v_idempotency, '')
  ) RETURNING id INTO v_id_orden;

  -- 6) Líneas de detalle
  FOR v_producto IN SELECT * FROM jsonb_array_elements(p_data->'productos') LOOP
    INSERT INTO ordenes_detalle (
      id_orden, consecutivo_orden,
      id_producto, sabor, presentacion, tipo_venta,
      cantidad, gramos_vendidos, precio_unitario, descuento, subtotal, precio_kg, notas_linea
    ) VALUES (
      v_id_orden, v_consec,
      v_producto->>'idProducto', v_producto->>'sabor', v_producto->>'presentacion',
      v_producto->>'tipoVenta',
      COALESCE((v_producto->>'cantidad')::NUMERIC, 0),
      COALESCE((v_producto->>'gramos')::NUMERIC, 0),
      COALESCE((v_producto->>'precio')::NUMERIC, 0),
      COALESCE((v_producto->>'descuento')::NUMERIC, 0),
      COALESCE((v_producto->>'subtotal')::NUMERIC, 0),
      COALESCE((v_producto->>'precioKg')::NUMERIC, 0),
      NULL
    );
    v_filas_det := v_filas_det + 1;
  END LOOP;

  -- 7) (ELIMINADO) Puntos Crunchy Club.
  --    Los puntos ahora se otorgan SOLO al confirmar Pagado + Entregado,
  --    via el trigger trg_otorgar_puntos (lee la tasa de config_produccion 'lealtad').
  --    Esto cierra el hueco donde los pedidos web/B2B nunca acumulaban puntos.

  RETURN jsonb_build_object(
    'ok', true,
    'idOrden', v_id_orden,
    'consecutivo', v_consec,
    'lineas', v_filas_det,
    'puntosAcumulados', 0   -- se otorgan despues, al confirmar pago+entrega
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."crear_pedido"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dashboard_resumen"("p_data" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_hoy        date := (now() AT TIME ZONE 'America/Mexico_City')::date;
  v_ini_mes    date := date_trunc('month', v_hoy)::date;
  v_dia_mes    int  := EXTRACT(day FROM v_hoy);                       -- día del mes (1..31)
  v_ini_prev   date := date_trunc('month', v_hoy - interval '1 month')::date;
  -- mismo número de días del mes anterior (MTD vs MTD), sin desbordar
  v_fin_prev   date := LEAST(
                         (v_ini_prev + (v_dia_mes - 1) * interval '1 day')::date,
                         (date_trunc('month', v_ini_prev) + interval '1 month - 1 day')::date
                       );
  v_resultado  jsonb;
BEGIN
  v_resultado := jsonb_build_object(

    -- Ventas por día del mes en curso (MTD) — incluye TODOS los días (1..hoy), 0 si no hubo venta
    'ventas_dia', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('dia', g.dia, 'monto', COALESCE(v.monto, 0)) ORDER BY g.dia)
      FROM generate_series(1, v_dia_mes) AS g(dia)
      LEFT JOIN (
        SELECT EXTRACT(day FROM (fecha_orden AT TIME ZONE 'America/Mexico_City'))::int AS dia,
               SUM(total) AS monto
        FROM ordenes
        WHERE COALESCE(tipo_interno,'') = ''
          AND estatus_pedido <> 'Cancelado'
          AND (fecha_orden AT TIME ZONE 'America/Mexico_City')::date >= v_ini_mes
          AND (fecha_orden AT TIME ZONE 'America/Mexico_City')::date <= v_hoy
        GROUP BY 1
      ) v ON v.dia = g.dia
    ), '[]'::jsonb),

    -- Acumulado MTD este mes
    'mtd_actual', COALESCE((
      SELECT SUM(total) FROM ordenes
      WHERE COALESCE(tipo_interno,'') = '' AND estatus_pedido <> 'Cancelado'
        AND (fecha_orden AT TIME ZONE 'America/Mexico_City')::date >= v_ini_mes
        AND (fecha_orden AT TIME ZONE 'America/Mexico_City')::date <= v_hoy
    ), 0),

    -- Acumulado MTD mes anterior (mismos días)
    'mtd_anterior', COALESCE((
      SELECT SUM(total) FROM ordenes
      WHERE COALESCE(tipo_interno,'') = '' AND estatus_pedido <> 'Cancelado'
        AND (fecha_orden AT TIME ZONE 'America/Mexico_City')::date >= v_ini_prev
        AND (fecha_orden AT TIME ZONE 'America/Mexico_City')::date <= v_fin_prev
    ), 0),

    -- Objetivo del mes = suma de cuotas de todos los vendedores (mes/año actual)
    'objetivo_mes', COALESCE((
      SELECT SUM(cuota) FROM cuotas_vendedor
      WHERE mes = EXTRACT(month FROM v_hoy)::int
        AND anio = EXTRACT(year FROM v_hoy)::int
    ), 0),

    -- Estatus de pedidos (sobre no cancelados / no internos)
    'por_entregar', COALESCE((
      SELECT COUNT(*) FROM ordenes
      WHERE COALESCE(tipo_interno,'') = '' AND estatus_pedido <> 'Cancelado'
        AND estatus_pedido <> 'Entregado'
    ), 0),
    'por_cobrar_monto', COALESCE((
      SELECT SUM(total) FROM ordenes
      WHERE COALESCE(tipo_interno,'') = '' AND estatus_pedido <> 'Cancelado'
        AND estatus_pago <> 'Pagado'
    ), 0),
    'entregados', COALESCE((
      SELECT COUNT(*) FROM ordenes
      WHERE COALESCE(tipo_interno,'') = '' AND estatus_pedido = 'Entregado'
    ), 0),

    -- Top sabores por piezas (todo el histórico de pedidos válidos)
    'top_sabores', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('sabor', s.sabor, 'pzas', s.pzas) ORDER BY s.pzas DESC)
      FROM (
        SELECT d.sabor, SUM(d.cantidad) AS pzas
        FROM ordenes_detalle d
        JOIN ordenes o ON o.id = d.id_orden
        WHERE COALESCE(o.tipo_interno,'') = '' AND o.estatus_pedido <> 'Cancelado'
          AND COALESCE(d.sabor,'') <> ''
        GROUP BY d.sabor
        ORDER BY pzas DESC
        LIMIT 8
      ) s
    ), '[]'::jsonb),

    -- Top presentaciones por piezas (excluye granel: se vende por peso, no por pieza)
    'top_presentaciones', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('presentacion', p.presentacion, 'pzas', p.pzas) ORDER BY p.pzas DESC)
      FROM (
        SELECT d.presentacion, SUM(d.cantidad) AS pzas
        FROM ordenes_detalle d
        JOIN ordenes o ON o.id = d.id_orden
        WHERE COALESCE(o.tipo_interno,'') = '' AND o.estatus_pedido <> 'Cancelado'
          AND COALESCE(d.presentacion,'') <> ''
          AND COALESCE(d.tipo_venta,'') <> 'A granel'
        GROUP BY d.presentacion
        ORDER BY pzas DESC
        LIMIT 8
      ) p
    ), '[]'::jsonb),

    -- Por vendedor: ventas del mes (MTD) + su cuota + % de pedidos pendientes de pago
    'por_vendedor', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id_vendedor', v.id_vendedor,
               'nombre', v.nombre,
               'ventas', v.ventas,
               'cuota', COALESCE(c.cuota, 0),
               'pedidos', v.pedidos,
               'pendientes_pago', v.pendientes_pago,
               'pct_pendiente_pago', CASE WHEN v.pedidos > 0
                                          THEN ROUND(100.0 * v.pendientes_pago / v.pedidos)::int
                                          ELSE 0 END
             ) ORDER BY v.ventas DESC)
      FROM (
        SELECT id_vendedor,
               MAX(nombre_vendedor) AS nombre,
               SUM(total)           AS ventas,
               COUNT(*)             AS pedidos,
               COUNT(*) FILTER (WHERE estatus_pago <> 'Pagado') AS pendientes_pago
        FROM ordenes
        WHERE COALESCE(tipo_interno,'') = '' AND estatus_pedido <> 'Cancelado'
          AND (fecha_orden AT TIME ZONE 'America/Mexico_City')::date >= v_ini_mes
          AND (fecha_orden AT TIME ZONE 'America/Mexico_City')::date <= v_hoy
        GROUP BY id_vendedor
      ) v
      LEFT JOIN cuotas_vendedor c
        ON c.id_vendedor = v.id_vendedor
       AND c.mes  = EXTRACT(month FROM v_hoy)::int
       AND c.anio = EXTRACT(year  FROM v_hoy)::int
    ), '[]'::jsonb),

    'dia_mes', v_dia_mes
  );

  RETURN jsonb_build_object('ok', true, 'data', v_resultado);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."dashboard_resumen"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."descontar_inventario_pedido"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_kilos NUMERIC;
  v_id_prod BIGINT;
BEGIN
  -- Skip bebidas
  IF NEW.id_producto IS NULL OR NEW.id_producto = '' THEN RETURN NEW; END IF;
  IF NEW.id_producto LIKE 'b%' THEN RETURN NEW; END IF;
  IF NEW.sabor IS NULL OR NEW.sabor = '' THEN RETURN NEW; END IF;

  -- Calcular kilos a descontar
  IF NEW.tipo_venta = 'A granel' THEN
    v_kilos := COALESCE(NEW.gramos_vendidos, 0) / 1000.0;
  ELSE
    -- Pieza: gramos_vendidos viene del peso de la presentación × cantidad
    v_kilos := COALESCE(NEW.gramos_vendidos, 0) / 1000.0;
  END IF;

  IF v_kilos <= 0 THEN RETURN NEW; END IF;

  -- Buscar fila activa más reciente del sabor
  SELECT id INTO v_id_prod FROM produccion_diaria
  WHERE sabor = NEW.sabor AND activo = TRUE
  ORDER BY fecha_produccion DESC
  LIMIT 1;

  IF v_id_prod IS NOT NULL THEN
    UPDATE produccion_diaria
    SET kilos_vendidos = kilos_vendidos + v_kilos
    WHERE id = v_id_prod;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."descontar_inventario_pedido"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_reconciliar_pedido"("p_id_orden" bigint) RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_estatus text;
  v_debe    boolean;
  v_kg      numeric;
  v_id_lote text;
  rec       record;
begin
  select estatus_pedido
    into v_estatus
    from public.ordenes
   where id = p_id_orden;

  if v_estatus is null then
    return;
  end if;

  v_debe := v_estatus not in ('Pendiente', 'Cancelado');

  if v_debe then
    select coalesce(sum(
             case
               when tipo_venta = 'A granel' then coalesce(gramos_vendidos, 0)
               else coalesce(cantidad, 0) * case presentacion
                                              when '100g' then 100
                                              when '250g' then 250
                                              when '500g' then 500
                                              when '1kg'  then 1000
                                              else 0
                                            end
             end
           ), 0) / 1000.0
      into v_kg
      from public.ordenes_detalle
     where id_orden = p_id_orden
       and coalesce(kg_descontado_lote, 0) = 0;

    if coalesce(v_kg, 0) <= 0 then
      return;
    end if;

    select id_lote into v_id_lote
      from public.lotes_produccion
     where estatus = 'Activo'
     order by fecha desc, id desc
     limit 1;

    -- ── CANDADO (Sesión 24): sin lote activo NO se confirma nada ──
    if v_id_lote is null then
      raise exception '⛔ No hay LOTE ACTIVO. Registra el lote de producción antes de confirmar este pedido (% kg por descontar).', round(v_kg, 3);
    end if;

    update public.lotes_produccion
       set kilos_vendidos = coalesce(kilos_vendidos, 0) + v_kg
     where id_lote = v_id_lote;

    update public.ordenes_detalle
       set kg_descontado_lote = case
                                  when tipo_venta = 'A granel' then coalesce(gramos_vendidos, 0)
                                  else coalesce(cantidad, 0) * case presentacion
                                                                when '100g' then 100
                                                                when '250g' then 250
                                                                when '500g' then 500
                                                                when '1kg'  then 1000
                                                                else 0
                                                              end
                                end / 1000.0,
           id_lote_descontado = v_id_lote
     where id_orden = p_id_orden
       and coalesce(kg_descontado_lote, 0) = 0;

  else
    for rec in
      select id_lote_descontado as lote, sum(kg_descontado_lote) as kg
        from public.ordenes_detalle
       where id_orden = p_id_orden
         and coalesce(kg_descontado_lote, 0) > 0
       group by id_lote_descontado
    loop
      if rec.lote is not null then
        update public.lotes_produccion
           set kilos_vendidos = greatest(0, coalesce(kilos_vendidos, 0) - rec.kg)
         where id_lote = rec.lote;
      end if;
    end loop;

    update public.ordenes_detalle
       set kg_descontado_lote = 0,
           id_lote_descontado = null
     where id_orden = p_id_orden
       and coalesce(kg_descontado_lote, 0) > 0;
  end if;
end;
$$;


ALTER FUNCTION "public"."fn_reconciliar_pedido"("p_id_orden" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_config_secciones"("p_data" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_result JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'rol', rol,
    'secciones', secciones
  ) ORDER BY rol), '[]'::JSONB) INTO v_result
  FROM config_secciones;

  RETURN jsonb_build_object('ok', true, 'configs', v_result);
END;
$$;


ALTER FUNCTION "public"."get_config_secciones"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_cuota_vendedor"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id_vend BIGINT;
  v_mes INTEGER;
  v_anio INTEGER;
  v_cuota NUMERIC := 0;
BEGIN
  v_id_vend := COALESCE((p_data->>'idVendedor')::BIGINT, 0);
  v_mes := COALESCE((p_data->>'mes')::INTEGER, EXTRACT(MONTH FROM CURRENT_DATE)::INTEGER);
  v_anio := COALESCE((p_data->>'anio')::INTEGER, EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER);

  SELECT cuota INTO v_cuota FROM cuotas_vendedor
  WHERE id_vendedor = v_id_vend AND mes = v_mes AND anio = v_anio;

  RETURN jsonb_build_object('ok', true, 'cuota', COALESCE(v_cuota, 0));
END;
$$;


ALTER FUNCTION "public"."get_cuota_vendedor"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_estado_tienda"("p_telefono" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tel text;
  r     record;
begin
  v_tel := right(regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g'), 10);
  if length(v_tel) < 10 then
    return jsonb_build_object('ok', false, 'error', 'telefono invalido');
  end if;

  select nombre, direccion, coordenadas,
         coalesce(aprobado_b2b, false) as aprobado, tipo_id
    into r
    from public.clientes
   where right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) = v_tel
   limit 1;

  if not found then
    return jsonb_build_object('ok', true, 'existe', false);
  end if;

  return jsonb_build_object(
    'ok', true,
    'existe', true,
    'aprobado', r.aprobado,
    'completo', (
      coalesce(btrim(r.nombre), '')     <> '' and
      coalesce(btrim(r.direccion), '')  <> '' and
      coalesce(btrim(r.coordenadas), '') <> ''
    ),
    'tipo_id', r.tipo_id
  );
end;
$$;


ALTER FUNCTION "public"."get_estado_tienda"("p_telefono" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_lealtad_config"() RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT COALESCE(
    (SELECT valor FROM config_produccion WHERE clave = 'lealtad'),
    jsonb_build_object(
      'generacion', jsonb_build_object('activo',true,'puntos_por_peso',0.01,'base','total','momento','pago_y_entrega'),
      'redencion',  jsonb_build_object('activo',true,'valor_punto_mxn',0.10,'pct_max_pedido',50,'pago_minimo_mxn',1,'puntos_minimos_canje',0),
      'segmentacion', jsonb_build_object('modo','todos_iguales')
    )
  );
$$;


ALTER FUNCTION "public"."get_lealtad_config"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_mayoreo_config"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_val jsonb;
begin
  select valor into v_val
    from public.config_produccion
   where clave = 'mayoreo'
   limit 1;

  if v_val is null then
    v_val := jsonb_build_object('minimos',
              jsonb_build_object('100g', 10, '250g', 8, '500g', 6, '1kg', 5));
  end if;

  return jsonb_build_object('ok', true, 'minimos', coalesce(v_val->'minimos', '{}'::jsonb));
end;
$$;


ALTER FUNCTION "public"."get_mayoreo_config"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_opt_in_promos"("p_telefono" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tel    text;
  v_acepta boolean;
begin
  v_tel := right(regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g'), 10);
  if length(v_tel) < 10 then
    return jsonb_build_object('ok', false, 'acepta', false);
  end if;
  select acepta_promos into v_acepta
    from public.clientes
   where right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) = v_tel
   limit 1;
  return jsonb_build_object('ok', true, 'acepta', coalesce(v_acepta, false));
end;
$$;


ALTER FUNCTION "public"."get_opt_in_promos"("p_telefono" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_secciones_usuario"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id_vend BIGINT;
  v_rol TEXT;
  v_secciones_individuales TEXT[];
  v_secciones TEXT[];
  v_rol_real TEXT;
BEGIN
  v_id_vend := COALESCE((p_data->>'idVendedor')::BIGINT, 0);
  v_rol := LOWER(COALESCE(p_data->>'rol', 'consumidor'));

  -- Si tiene id_vendedor, buscar su rol real y override
  IF v_id_vend > 0 THEN
    SELECT LOWER(rol), secciones INTO v_rol_real, v_secciones_individuales
    FROM vendedores WHERE id = v_id_vend AND activo = TRUE;

    IF FOUND THEN
      v_rol := v_rol_real;

      -- Si tiene override individual, usarlo
      IF v_secciones_individuales IS NOT NULL AND ARRAY_LENGTH(v_secciones_individuales, 1) > 0 THEN
        RETURN jsonb_build_object('ok', true, 'secciones', v_secciones_individuales, 'rol', v_rol, 'fuente', 'individual');
      END IF;
    END IF;
  END IF;

  -- Fallback: secciones default del rol
  SELECT secciones INTO v_secciones FROM config_secciones WHERE rol = v_rol;
  IF v_secciones IS NULL THEN
    v_secciones := ARRAY['catalogo','pedidos','cuenta'];  -- fallback mínimo
  END IF;

  RETURN jsonb_build_object('ok', true, 'secciones', v_secciones, 'rol', v_rol, 'fuente', 'rol_default');
END;
$$;


ALTER FUNCTION "public"."get_secciones_usuario"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_tracking_pedido"("p_id_orden" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_orden  ordenes%ROWTYPE;
  v_items  JSONB;
  v_mapa_estatus JSONB := '{
    "pendiente":      "Recibido",
    "confirmado":     "Recibido",
    "en proceso":     "En preparación",
    "en preparacion": "En preparación",
    "en preparación": "En preparación",
    "listo":          "En preparación",
    "en camino":      "En camino",
    "entregado":      "Entregado",
    "cancelado":      "Cancelado"
  }'::JSONB;
  v_est_int TEXT;
  v_est_cli TEXT;
BEGIN
  -- Buscar por consecutivo o por id
  SELECT * INTO v_orden FROM ordenes
  WHERE consecutivo = p_id_orden OR id::TEXT = p_id_orden
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Pedido no encontrado');
  END IF;

  v_est_int := LOWER(COALESCE(v_orden.estatus_pedido, 'pendiente'));
  v_est_cli := COALESCE(v_mapa_estatus->>v_est_int, 'Recibido');

  -- Items
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'sabor', sabor,
    'presentacion', presentacion,
    'cantidad', cantidad,
    'modo', CASE WHEN tipo_venta = 'A granel' THEN 'granel' ELSE 'pieza' END,
    'subtotal', subtotal,
    'gramos', gramos_vendidos
  )), '[]'::JSONB) INTO v_items
  FROM ordenes_detalle WHERE id_orden = v_orden.id;

  RETURN jsonb_build_object(
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
END;
$$;


ALTER FUNCTION "public"."get_tracking_pedido"("p_id_orden" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guardar_encuesta"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id_orden   BIGINT;
  v_id_cliente BIGINT;
  v_telefono   TEXT;
  v_id         BIGINT;
BEGIN
  v_id_orden := NULLIF(p_data->>'idOrden', '')::BIGINT;
  IF v_id_orden IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'idOrden requerido');
  END IF;

  -- Derivar cliente/teléfono desde la orden (no confiar en el cliente)
  SELECT o.id_cliente, c.telefono
    INTO v_id_cliente, v_telefono
  FROM ordenes o
  LEFT JOIN clientes c ON c.id = o.id_cliente
  WHERE o.id = v_id_orden;

  INSERT INTO encuestas (
    id_orden, id_cliente, telefono,
    sabor, textura, sal, recompra, app_facilidad, comentario, utm_campaign
  ) VALUES (
    v_id_orden, v_id_cliente, v_telefono,
    NULLIF(p_data->>'sabor', '')::INTEGER,
    NULLIF(p_data->>'textura', '')::INTEGER,
    NULLIF(p_data->>'sal', ''),
    NULLIF(p_data->>'recompra', ''),
    NULLIF(p_data->>'appFacilidad', '')::INTEGER,
    NULLIF(p_data->>'comentario', ''),
    NULLIF(p_data->>'utmCampaign', '')
  )
  ON CONFLICT (id_orden) DO UPDATE SET
    sabor         = EXCLUDED.sabor,
    textura       = EXCLUDED.textura,
    sal           = EXCLUDED.sal,
    recompra      = EXCLUDED.recompra,
    app_facilidad = EXCLUDED.app_facilidad,
    comentario    = EXCLUDED.comentario,
    utm_campaign  = EXCLUDED.utm_campaign,
    creado_en     = NOW()
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;


ALTER FUNCTION "public"."guardar_encuesta"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."importar_prospectos_bulk"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_lista JSONB;
  v_item JSONB;
  v_telefono TEXT;
  v_tel_norm TEXT;
  v_count_creados INTEGER := 0;
  v_count_duplicados INTEGER := 0;
  v_errores JSONB := '[]'::JSONB;
BEGIN
  v_lista := p_data->'prospectos';
  IF jsonb_typeof(v_lista) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'prospectos debe ser un array');
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_lista)
  LOOP
    BEGIN
      v_telefono := COALESCE(v_item->>'telefono', '');
      v_tel_norm := REGEXP_REPLACE(v_telefono, '\D', '', 'g');

      -- Saltar si ya existe como prospecto o cliente
      IF v_tel_norm <> '' AND LENGTH(v_tel_norm) >= 10 THEN
        IF EXISTS (
          SELECT 1 FROM prospectos
          WHERE RIGHT(REGEXP_REPLACE(COALESCE(telefono,''), '\D', '', 'g'), 10) = RIGHT(v_tel_norm, 10)
        ) OR EXISTS (
          SELECT 1 FROM clientes
          WHERE RIGHT(REGEXP_REPLACE(COALESCE(telefono,''), '\D', '', 'g'), 10) = RIGHT(v_tel_norm, 10)
        ) THEN
          v_count_duplicados := v_count_duplicados + 1;
          CONTINUE;
        END IF;
      END IF;

      INSERT INTO prospectos (
        tipo, tipo_id, nombre, telefono, direccion, cp, colonia, municipio, estado,
        estatus, notas, fecha_alta
      ) VALUES (
        COALESCE(v_item->>'tipo', 'tienda'),
        COALESCE((v_item->>'tipoId')::INTEGER, 3),
        v_item->>'nombre',
        v_telefono,
        v_item->>'direccion',
        v_item->>'cp',
        v_item->>'colonia',
        v_item->>'municipio',
        v_item->>'estado',
        'nuevo',
        v_item->>'notas',
        NOW()
      );
      v_count_creados := v_count_creados + 1;
    EXCEPTION
      WHEN OTHERS THEN
        v_errores := v_errores || jsonb_build_object('item', v_item, 'error', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'creados', v_count_creados,
    'duplicados', v_count_duplicados,
    'errores', v_errores
  );
END;
$$;


ALTER FUNCTION "public"."importar_prospectos_bulk"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."metricas_regalo_mes"("p_anio" integer, "p_mes" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_ini date := make_date(p_anio, p_mes, 1);
  v_fin date := (make_date(p_anio, p_mes, 1) + interval '1 month')::date;
  v_ventas_kg  numeric := 0;
  v_ventas_mxn numeric := 0;
  v_reg_kg     numeric := 0;
  v_reg_mxn    numeric := 0;
  v_por_cliente jsonb;
begin
  -- ── Ventas reales: kg (desde líneas) ──
  select coalesce(sum(
           case when d.tipo_venta = 'A granel' then coalesce(d.gramos_vendidos,0)
                else coalesce(d.cantidad,0) * case d.presentacion
                       when '100g' then 100 when '250g' then 250
                       when '500g' then 500 when '1kg' then 1000 else 0 end
           end)/1000.0, 0)
    into v_ventas_kg
    from public.ordenes o
    join public.ordenes_detalle d on d.id_orden = o.id
   where o.fecha_orden >= v_ini and o.fecha_orden < v_fin
     and coalesce(o.tipo_interno,'') = ''
     and o.estatus_pedido <> 'Cancelado';

  -- ── Ventas reales: $ (ingreso real) ──
  select coalesce(sum(o.total),0)
    into v_ventas_mxn
    from public.ordenes o
   where o.fecha_orden >= v_ini and o.fecha_orden < v_fin
     and coalesce(o.tipo_interno,'') = ''
     and o.estatus_pedido <> 'Cancelado';

  -- ── Regalos: kg y $ (valor que hubiera costado) ──
  select
    coalesce(sum(
      case when d.tipo_venta = 'A granel' then coalesce(d.gramos_vendidos,0)
           else coalesce(d.cantidad,0) * case d.presentacion
                  when '100g' then 100 when '250g' then 250
                  when '500g' then 500 when '1kg' then 1000 else 0 end
      end)/1000.0, 0),
    coalesce(sum(coalesce(d.subtotal,0)), 0)
    into v_reg_kg, v_reg_mxn
    from public.ordenes o
    join public.ordenes_detalle d on d.id_orden = o.id
   where o.fecha_orden >= v_ini and o.fecha_orden < v_fin
     and coalesce(o.tipo_interno,'') in ('sampling','regalo','bonificacion')
     and o.estatus_pedido <> 'Cancelado';

  -- ── Desglose por cliente (regalos del mes + sus ventas para el %) ──
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    into v_por_cliente
  from (
    select
      r.id_cliente,
      r.nombre,
      round(r.regalo_kg, 3)  as regalo_kg,
      round(r.regalo_mxn, 2) as regalo_mxn,
      round(coalesce(v.ventas_kg,0), 3) as ventas_kg,
      case when coalesce(v.ventas_kg,0) > 0
           then round((r.regalo_kg / v.ventas_kg) * 100, 1)
           else null end as pct_vol
    from (
      select o.id_cliente,
             max(o.nombre_cliente) as nombre,
             sum(case when d.tipo_venta = 'A granel' then coalesce(d.gramos_vendidos,0)
                      else coalesce(d.cantidad,0) * case d.presentacion
                             when '100g' then 100 when '250g' then 250
                             when '500g' then 500 when '1kg' then 1000 else 0 end
                 end)/1000.0 as regalo_kg,
             sum(coalesce(d.subtotal,0)) as regalo_mxn
        from public.ordenes o
        join public.ordenes_detalle d on d.id_orden = o.id
       where o.fecha_orden >= v_ini and o.fecha_orden < v_fin
         and coalesce(o.tipo_interno,'') in ('sampling','regalo','bonificacion')
         and o.estatus_pedido <> 'Cancelado'
       group by o.id_cliente
    ) r
    left join (
      select o.id_cliente,
             sum(case when d.tipo_venta = 'A granel' then coalesce(d.gramos_vendidos,0)
                      else coalesce(d.cantidad,0) * case d.presentacion
                             when '100g' then 100 when '250g' then 250
                             when '500g' then 500 when '1kg' then 1000 else 0 end
                 end)/1000.0 as ventas_kg
        from public.ordenes o
        join public.ordenes_detalle d on d.id_orden = o.id
       where o.fecha_orden >= v_ini and o.fecha_orden < v_fin
         and coalesce(o.tipo_interno,'') = ''
         and o.estatus_pedido <> 'Cancelado'
       group by o.id_cliente
    ) v on v.id_cliente = r.id_cliente
    order by r.regalo_kg desc
    limit 20
  ) t;

  return jsonb_build_object(
    'ok', true,
    'periodo',     to_char(v_ini, 'YYYY-MM'),
    'ventas_kg',   round(v_ventas_kg, 3),
    'ventas_mxn',  round(v_ventas_mxn, 2),
    'regalo_kg',   round(v_reg_kg, 3),
    'regalo_mxn',  round(v_reg_mxn, 2),
    'pct_volumen', case when v_ventas_kg  > 0 then round((v_reg_kg  / v_ventas_kg)  * 100, 1) else null end,
    'pct_dinero',  case when v_ventas_mxn > 0 then round((v_reg_mxn / v_ventas_mxn) * 100, 1) else null end,
    'por_cliente', v_por_cliente
  );
end;
$_$;


ALTER FUNCTION "public"."metricas_regalo_mes"("p_anio" integer, "p_mes" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."obtener_caja_dia"("p_fecha" "date" DEFAULT NULL::"date") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_fecha DATE;
  v_puntos JSONB;
BEGIN
  v_fecha := COALESCE(p_fecha, CURRENT_DATE);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'idPunto',          p.id,
    'codigo',           p.codigo,
    'nombre',           p.nombre,
    'tipo',             p.tipo,
    'fondoMinimo',      p.fondo_minimo,
    'cajaDia',          (
      SELECT row_to_json(c)
      FROM (
        SELECT id, fecha, saldo_apertura, saldo_cierre_declarado, saldo_cierre_calculado,
               diferencia, estatus, abierta_por, fecha_apertura, cerrada_por, fecha_cierre,
               notas_apertura, notas_cierre
        FROM caja_dias WHERE id_punto = p.id AND fecha = v_fecha LIMIT 1
      ) c
    ),
    'saldoTotal',       (SELECT COALESCE(SUM(monto), 0) FROM caja_movimientos WHERE id_punto = p.id),
    'totalIngresos',    (SELECT COALESCE(SUM(monto), 0) FROM caja_movimientos WHERE id_punto = p.id AND fecha::DATE = v_fecha AND monto > 0 AND tipo <> 'apertura'),
    'totalEgresos',     (SELECT COALESCE(SUM(monto), 0) FROM caja_movimientos WHERE id_punto = p.id AND fecha::DATE = v_fecha AND monto < 0),
    'numVentas',        (SELECT COUNT(*) FROM caja_movimientos WHERE id_punto = p.id AND fecha::DATE = v_fecha AND tipo LIKE 'venta%'),
    'numGastos',        (SELECT COUNT(*) FROM caja_movimientos WHERE id_punto = p.id AND fecha::DATE = v_fecha AND tipo LIKE 'gasto%'),
    'movimientos',      (
      SELECT COALESCE(jsonb_agg(row_to_json(m) ORDER BY m.fecha DESC), '[]'::JSONB)
      FROM (
        SELECT id, tipo, monto, descripcion, fecha, actor,
               id_orden, consecutivo_pedido, id_gasto, id_punto_destino
        FROM caja_movimientos WHERE id_punto = p.id AND fecha::DATE = v_fecha
        ORDER BY fecha DESC
      ) m
    )
  ) ORDER BY p.orden_display, p.id), '[]'::JSONB) INTO v_puntos
  FROM caja_puntos p
  WHERE p.activo = TRUE;

  RETURN jsonb_build_object('ok', true, 'fecha', v_fecha, 'puntos', v_puntos);
END;
$$;


ALTER FUNCTION "public"."obtener_caja_dia"("p_fecha" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."obtener_cajas_vendedores"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_result JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'idPunto',       p.id,
    'codigo',        p.codigo,
    'nombre',        p.nombre,
    'idVendedor',    p.id_vendedor,
    'saldoActual',   (SELECT COALESCE(SUM(monto), 0)::NUMERIC(12,2) FROM caja_movimientos WHERE id_punto = p.id),
    'cobrosHoy',     (SELECT COALESCE(SUM(monto), 0)::NUMERIC(12,2) FROM caja_movimientos WHERE id_punto = p.id AND fecha::DATE = CURRENT_DATE AND tipo LIKE 'venta%'),
    'numCobrosHoy',  (SELECT COUNT(*) FROM caja_movimientos WHERE id_punto = p.id AND fecha::DATE = CURRENT_DATE AND tipo LIKE 'venta%'),
    'ultimaEntrega', (SELECT MAX(fecha) FROM caja_movimientos WHERE id_punto = p.id AND tipo = 'entrega_vendedor'),
    'diasSinEntregar', (
      SELECT CASE
        WHEN (SELECT COALESCE(SUM(monto), 0) FROM caja_movimientos WHERE id_punto = p.id) > 0 THEN
          EXTRACT(DAY FROM NOW() - COALESCE(
            (SELECT MAX(fecha) FROM caja_movimientos WHERE id_punto = p.id AND tipo IN ('entrega_vendedor','apertura')),
            (SELECT MIN(fecha) FROM caja_movimientos WHERE id_punto = p.id)
          ))::INTEGER
        ELSE 0
      END
    ),
    'pedidosPendientes', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'idOrden', m.id_orden,
        'consec', m.consecutivo_pedido,
        'monto', m.monto,
        'fecha', m.fecha,
        'descripcion', m.descripcion
      ) ORDER BY m.fecha DESC), '[]'::JSONB)
      FROM caja_movimientos m
      WHERE m.id_punto = p.id
        AND m.tipo LIKE 'venta%'
        AND m.id_orden IS NOT NULL
        AND NOT EXISTS (
          -- No considerar como pendiente si ya hubo entrega después
          SELECT 1 FROM caja_movimientos e
          WHERE e.id_punto = p.id AND e.tipo = 'entrega_vendedor'
            AND e.fecha > m.fecha
        )
    )
  ) ORDER BY p.id), '[]'::JSONB) INTO v_result
  FROM caja_puntos p
  WHERE p.activo = TRUE AND p.subtipo = 'vendedor_personal';

  RETURN jsonb_build_object('ok', true, 'vendedores', v_result);
END;
$$;


ALTER FUNCTION "public"."obtener_cajas_vendedores"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."obtener_cliente_con_stats"("p_telefono" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_cliente     clientes%ROWTYPE;
  v_tel_norm    TEXT;
  v_total_ped   INTEGER := 0;
  v_total_gast  NUMERIC := 0;
  v_compras_mes NUMERIC := 0;
  v_ult_pedido  JSONB;
  v_pedidos     JSONB;
  v_puntos      INTEGER;
  v_mes_ini     DATE;
BEGIN
  v_tel_norm := REGEXP_REPLACE(COALESCE(p_telefono, ''), '\D', '', 'g');
  IF v_tel_norm = '' THEN
    RETURN jsonb_build_object('ok', true, 'existe', false);
  END IF;

  -- Cliente
  SELECT * INTO v_cliente FROM clientes
  WHERE RIGHT(REGEXP_REPLACE(telefono, '\D', '', 'g'), 10) = RIGHT(v_tel_norm, 10)
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'existe', false);
  END IF;

  v_mes_ini := DATE_TRUNC('month', CURRENT_DATE)::DATE;

  -- Stats agregadas
  -- FIX v2.11.4: usar COALESCE(tipo_interno, '') = '' en lugar de IS NULL
  -- para cubrir tanto NULL como string vacío. Aplicar el mismo filtro
  -- de internos a totalPedidos para consistencia.
  SELECT
    COUNT(*) FILTER (
      WHERE estatus_pedido <> 'Cancelado'
        AND COALESCE(tipo_interno, '') = ''
    ),
    COALESCE(SUM(total) FILTER (
      WHERE estatus_pedido <> 'Cancelado'
        AND COALESCE(tipo_interno, '') = ''
    ), 0),
    COALESCE(SUM(total) FILTER (
      WHERE estatus_pedido <> 'Cancelado'
        AND COALESCE(tipo_interno, '') = ''
        AND fecha_orden::DATE >= v_mes_ini
    ), 0)
  INTO v_total_ped, v_total_gast, v_compras_mes
  FROM ordenes WHERE id_cliente = v_cliente.id;

  -- Lista completa de pedidos del cliente (formato frontend)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',          o.id,
    'consec',      o.consecutivo,
    'consecutivo', o.consecutivo,
    'fecha',       o.fecha_orden,
    'fechaEntrega', o.fecha_entrega,
    'total',       o.total,
    'subtotal',    o.subtotal,
    'descuento',   o.descuento,
    'estatus',     o.estatus_pedido,
    'estatusPedido', o.estatus_pedido,
    'estatusPago', o.estatus_pago,
    'canal',       o.canal,
    'tipoInterno', o.tipo_interno,
    'cuponCodigo', o.cupon_codigo,
    'notas',       o.notas,
    'nombreCliente', o.nombre_cliente,
    'cliente',     o.nombre_cliente
  ) ORDER BY o.fecha_orden DESC), '[]'::JSONB)
  INTO v_pedidos
  FROM ordenes o WHERE o.id_cliente = v_cliente.id
  LIMIT 100;

  -- Último pedido (atajo para Mi Cuenta)
  SELECT jsonb_build_object(
    'id', id, 'consec', consecutivo, 'consecutivo', consecutivo,
    'fecha', fecha_orden, 'total', total, 'estatus', estatus_pedido
  ) INTO v_ult_pedido
  FROM ordenes
  WHERE id_cliente = v_cliente.id
    AND estatus_pedido <> 'Cancelado'
    AND COALESCE(tipo_interno, '') = ''
  ORDER BY fecha_orden DESC LIMIT 1;

  -- Puntos del ledger
  SELECT COALESCE(puntos_actuales, 0) INTO v_puntos
  FROM saldos_lealtad WHERE id_cliente = v_cliente.id;
  v_puntos := COALESCE(v_puntos, 0);

  RETURN jsonb_build_object(
    'ok', true,
    'existe', true,
    'cliente', jsonb_build_object(
      'id', v_cliente.id, 'tipoId', v_cliente.tipo_id, 'tipo', v_cliente.tipo,
      'nombre', v_cliente.nombre, 'telefono', v_cliente.telefono,
      'direccion', v_cliente.direccion, 'cp', v_cliente.cp,
      'colonia', v_cliente.colonia, 'municipio', v_cliente.municipio,
      'estado', v_cliente.estado, 'coordenadas', v_cliente.coordenadas,
      'idVendedor', v_cliente.id_vendedor, 'vendedor', v_cliente.vendedor,
      'aprobadoB2B', v_cliente.aprobado_b2b
    ),
    'stats', jsonb_build_object(
      'totalPedidos',  v_total_ped,
      'totalGastado',  v_total_gast,
      'totalCompras',  v_total_gast,        -- alias legacy
      'comprasMes',    v_compras_mes,
      'ultimoPedido',  v_ult_pedido,
      'pedidos',       v_pedidos
    ),
    'puntos', v_puntos
  );
END;
$$;


ALTER FUNCTION "public"."obtener_cliente_con_stats"("p_telefono" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."obtener_encuesta_pendiente"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_tel_norm   TEXT;
  v_id_cliente BIGINT;
  v_tiene      INTEGER;
  v_orden      RECORD;
BEGIN
  v_tel_norm := REGEXP_REPLACE(COALESCE(p_data->>'telefono', ''), '\D', '', 'g');
  IF v_tel_norm = '' THEN
    RETURN jsonb_build_object('ok', true, 'pendiente', false);
  END IF;

  SELECT id INTO v_id_cliente
  FROM clientes
  WHERE RIGHT(REGEXP_REPLACE(COALESCE(telefono, ''), '\D', '', 'g'), 10) = RIGHT(v_tel_norm, 10)
  LIMIT 1;
  IF v_id_cliente IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'pendiente', false);
  END IF;

  -- ── Regla de frecuencia (Opción A) ───────────────────────────────
  -- Si el cliente ya tiene al menos una encuesta, NO auto-abrir.
  SELECT COUNT(*) INTO v_tiene
  FROM encuestas e
  JOIN ordenes o ON o.id = e.id_orden
  WHERE o.id_cliente = v_id_cliente;

  IF v_tiene > 0 THEN
    RETURN jsonb_build_object('ok', true, 'pendiente', false);
  END IF;

  -- ── VARIANTE B (primera, luego cada N pedidos) — descomentar para usar
  --   Reemplaza el bloque anterior por:
  --   IF v_tiene > 0 AND (v_total_entregados % 3) <> 0 THEN
  --     RETURN jsonb_build_object('ok', true, 'pendiente', false);
  --   END IF;
  --
  -- ── VARIANTE C (cooldown por tiempo) — descomentar para usar
  --   Bloquear si hay encuesta del cliente en los últimos 30 días:
  --   IF EXISTS (SELECT 1 FROM encuestas e JOIN ordenes o ON o.id=e.id_orden
  --              WHERE o.id_cliente = v_id_cliente
  --                AND e.creado_en > NOW() - INTERVAL '30 days') THEN
  --     RETURN jsonb_build_object('ok', true, 'pendiente', false);
  --   END IF;

  -- Primer pedido entregado (más antiguo), sin encuesta
  SELECT o.id, o.consecutivo, o.fecha_orden
    INTO v_orden
  FROM ordenes o
  WHERE o.id_cliente = v_id_cliente
    AND o.estatus_pedido = 'Entregado'
    AND COALESCE(o.tipo_interno, '') = ''
    AND NOT EXISTS (SELECT 1 FROM encuestas e WHERE e.id_orden = o.id)
  ORDER BY o.fecha_orden ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'pendiente', false);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'pendiente', true,
    'orden', jsonb_build_object(
      'id',          v_orden.id,
      'consecutivo', v_orden.consecutivo,
      'fecha',       v_orden.fecha_orden
    )
  );
END;
$$;


ALTER FUNCTION "public"."obtener_encuesta_pendiente"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."obtener_encuestas_cliente"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_tel_norm TEXT;
  v_ids      JSONB;
BEGIN
  v_tel_norm := REGEXP_REPLACE(COALESCE(p_data->>'telefono', ''), '\D', '', 'g');
  IF v_tel_norm = '' THEN
    RETURN jsonb_build_object('ok', true, 'idsEncuestadas', '[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(e.id_orden), '[]'::jsonb)
    INTO v_ids
  FROM encuestas e
  JOIN ordenes o  ON o.id = e.id_orden
  JOIN clientes c ON c.id = o.id_cliente
  WHERE RIGHT(REGEXP_REPLACE(COALESCE(c.telefono, ''), '\D', '', 'g'), 10) = RIGHT(v_tel_norm, 10);

  RETURN jsonb_build_object('ok', true, 'idsEncuestadas', v_ids);
END;
$$;


ALTER FUNCTION "public"."obtener_encuestas_cliente"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."obtener_fecha_entrega"("p_data" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_hoy DATE;
  v_dias_con_stock INTEGER;
  v_dias_post_prod INTEGER;
  v_evitar_dom BOOLEAN;
  v_hay_stock BOOLEAN := FALSE;
  v_proxima_prod DATE;
  v_fecha DATE;
  v_msg TEXT;
BEGIN
  v_hoy := CURRENT_DATE;

  -- Leer configuración
  SELECT (valor)::TEXT::INTEGER INTO v_dias_con_stock FROM config_produccion WHERE clave = 'dias_entrega_con_stock';
  SELECT (valor)::TEXT::INTEGER INTO v_dias_post_prod FROM config_produccion WHERE clave = 'dias_entrega_post_produccion';
  SELECT (valor)::TEXT::BOOLEAN INTO v_evitar_dom FROM config_produccion WHERE clave = 'evitar_domingos';
  v_dias_con_stock := COALESCE(v_dias_con_stock, 2);
  v_dias_post_prod := COALESCE(v_dias_post_prod, 1);
  v_evitar_dom := COALESCE(v_evitar_dom, TRUE);

  -- Verificar si hay stock (lotes con kg_disponibles > 0)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'lotes') THEN
    SELECT EXISTS (
      SELECT 1 FROM lotes
      WHERE COALESCE(kg_disponibles, 0) > 0
        AND COALESCE(activo, TRUE) = TRUE
    ) INTO v_hay_stock;
  END IF;

  IF v_hay_stock THEN
    v_fecha := v_hoy + v_dias_con_stock;
    v_msg := 'Entrega sugerida en ' || v_dias_con_stock || ' días';
  ELSE
    -- Buscar próxima producción (si existe tabla)
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'produccion_programada') THEN
      SELECT MIN(fecha) INTO v_proxima_prod
      FROM produccion_programada
      WHERE fecha >= v_hoy AND COALESCE(estatus, '') NOT IN ('cancelada','completada');
    END IF;

    IF v_proxima_prod IS NOT NULL THEN
      v_fecha := v_proxima_prod + v_dias_post_prod;
      v_msg := 'Entrega post-producción';
    ELSE
      v_fecha := v_hoy + v_dias_con_stock;
      v_msg := 'Entrega sugerida';
    END IF;
  END IF;

  -- Evitar domingo (0 = domingo en EXTRACT(DOW))
  IF v_evitar_dom AND EXTRACT(DOW FROM v_fecha) = 0 THEN
    v_fecha := v_fecha + 1;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'fecha', TO_CHAR(v_fecha, 'YYYY-MM-DD'),
    'fechaDisplay', TO_CHAR(v_fecha, 'TMDay DD "de" TMMonth'),
    'msg', v_msg
  );
END;
$$;


ALTER FUNCTION "public"."obtener_fecha_entrega"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."obtener_pendientes_caja"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_efectivo JSONB;
  v_transfer JSONB;
  v_totales JSONB;
BEGIN
  -- Pedidos efectivo pendientes de entrega, agrupados por vendedor
  WITH efectivo_por_vendedor AS (
    SELECT
      COALESCE(id_vendedor, 0) AS id_vendedor,
      COALESCE(nombre_vendedor, 'Sin vendedor') AS nombre_vendedor,
      COUNT(*) AS num_pedidos,
      SUM(total) AS monto_total,
      MIN(fecha_orden) AS pedido_mas_viejo,
      EXTRACT(DAY FROM NOW() - MIN(fecha_orden))::INTEGER AS dias_mas_viejo,
      jsonb_agg(jsonb_build_object(
        'idOrden', id,
        'consec', consecutivo,
        'fecha', fecha_orden,
        'cliente', nombre_cliente,
        'monto', total,
        'tipoPago', tipo_pago
      ) ORDER BY fecha_orden DESC) AS pedidos
    FROM ordenes
    WHERE estatus_caja = 'pendiente_entrega'
    GROUP BY id_vendedor, nombre_vendedor
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'idVendedor', id_vendedor,
    'nombreVendedor', nombre_vendedor,
    'numPedidos', num_pedidos,
    'montoTotal', monto_total,
    'pedidoMasViejo', pedido_mas_viejo,
    'diasMasViejo', dias_mas_viejo,
    'pedidos', pedidos
  ) ORDER BY monto_total DESC), '[]'::JSONB)
  INTO v_efectivo FROM efectivo_por_vendedor;

  -- Transferencias/tarjetas pendientes de confirmación bancaria (lista plana)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'idOrden', id,
    'consec', consecutivo,
    'fecha', fecha_orden,
    'cliente', nombre_cliente,
    'monto', total,
    'tipoPago', tipo_pago,
    'idVendedor', id_vendedor,
    'nombreVendedor', nombre_vendedor,
    'diasEspera', EXTRACT(DAY FROM NOW() - fecha_orden)::INTEGER
  ) ORDER BY fecha_orden DESC), '[]'::JSONB)
  INTO v_transfer
  FROM ordenes WHERE estatus_caja = 'pendiente_confirmacion';

  -- Totales generales
  SELECT jsonb_build_object(
    'totalEfectivoPendiente', COALESCE(SUM(total) FILTER (WHERE estatus_caja='pendiente_entrega'), 0),
    'numEfectivoPendiente', COUNT(*) FILTER (WHERE estatus_caja='pendiente_entrega'),
    'totalTransferPendiente', COALESCE(SUM(total) FILTER (WHERE estatus_caja='pendiente_confirmacion'), 0),
    'numTransferPendiente', COUNT(*) FILTER (WHERE estatus_caja='pendiente_confirmacion'),
    'totalConfirmadoHoy', COALESCE(SUM(total) FILTER (WHERE estatus_caja='confirmado' AND fecha_confirmacion_caja::DATE = CURRENT_DATE), 0),
    'numConfirmadoHoy', COUNT(*) FILTER (WHERE estatus_caja='confirmado' AND fecha_confirmacion_caja::DATE = CURRENT_DATE)
  ) INTO v_totales FROM ordenes;

  RETURN jsonb_build_object(
    'ok', true,
    'efectivoPorVendedor', v_efectivo,
    'transferenciasPendientes', v_transfer,
    'totales', v_totales
  );
END;
$$;


ALTER FUNCTION "public"."obtener_pendientes_caja"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."obtener_vendedor_por_cp"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  -- Por ahora devolvemos null para que el cliente busque por nombre
  RETURN jsonb_build_object('ok', true, 'vendedor', NULL);
END;
$$;


ALTER FUNCTION "public"."obtener_vendedor_por_cp"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."obtener_vendedores"("p_data" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_incluir_inactivos BOOLEAN;
  v_result JSONB;
BEGIN
  v_incluir_inactivos := COALESCE((p_data->>'incluirInactivos')::BOOLEAN, FALSE);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id,
    'nombre', nombre,
    'telefono', telefono,
    'email', email,
    'rol', rol,
    'activo', activo,
    'direccionPuntoVenta', direccion_punto_venta,
    'cpPuntoVenta', cp_punto_venta,
    'secciones', secciones
  ) ORDER BY rol, nombre), '[]'::JSONB) INTO v_result
  FROM vendedores
  WHERE v_incluir_inactivos OR activo = TRUE;

  RETURN jsonb_build_object('ok', true, 'vendedores', v_result);
END;
$$;


ALTER FUNCTION "public"."obtener_vendedores"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."otorgar_puntos_al_confirmar"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_cfg     jsonb;
  v_rate    numeric;
  v_base    text;
  v_monto   numeric;
  v_pts     int;
  v_era_ok  boolean;
BEGIN
  -- ¿la orden YA estaba Pagado+Entregado antes? (en INSERT, OLD es NULL -> no)
  v_era_ok := (TG_OP = 'UPDATE'
               AND COALESCE(OLD.estatus_pago,'')   = 'Pagado'
               AND COALESCE(OLD.estatus_pedido,'') = 'Entregado');

  -- Dispara solo en la TRANSICION a Pagado + Entregado
  IF NEW.estatus_pago = 'Pagado' AND NEW.estatus_pedido = 'Entregado'
     AND NOT v_era_ok THEN

    -- Excluir internos y mostrador / sin cliente
    IF COALESCE(NEW.tipo_interno,'') <> ''
       OR NEW.id_cliente IS NULL
       OR NEW.id_cliente = 999999 THEN
      RETURN NEW;
    END IF;

    -- NUEVO: excluir MAYORISTA (no acumula puntos del Club)
    IF lower(COALESCE(NEW.canal,'')) = 'mayorista'
       OR EXISTS (SELECT 1 FROM clientes c
                   WHERE c.id = NEW.id_cliente
                     AND c.tipo_id = 4) THEN
      RETURN NEW;
    END IF;

    -- Anti-doble conteo: si ya hubo generacion para esta orden, no repetir
    IF EXISTS (SELECT 1 FROM lealtad_movimientos
               WHERE id_orden = NEW.id AND tipo = 'generacion') THEN
      RETURN NEW;
    END IF;

    -- Leer reglas de la config
    SELECT valor INTO v_cfg FROM config_produccion WHERE clave = 'lealtad';
    IF v_cfg IS NULL OR COALESCE((v_cfg->'generacion'->>'activo')::bool, false) = false THEN
      RETURN NEW;
    END IF;

    v_rate  := COALESCE((v_cfg->'generacion'->>'puntos_por_peso')::numeric, 0);
    v_base  := COALESCE(v_cfg->'generacion'->>'base', 'total');
    v_monto := CASE WHEN v_base = 'subtotal' THEN NEW.subtotal ELSE NEW.total END;
    v_pts   := floor(COALESCE(v_monto, 0) * v_rate)::int;

    IF v_pts > 0 THEN
      -- misma firma que usaba crear_pedido:
      -- (id_cliente, tipo, puntos, id_orden, consecutivo, NULL, NULL, monto_origen, nota, actor)
      PERFORM agregar_movimiento_lealtad(
        NEW.id_cliente, 'generacion', v_pts,
        NEW.id, NEW.consecutivo, NULL, NULL, v_monto,
        'Puntos por pedido ' || COALESCE(NEW.consecutivo,'') || ' (pagado)', 'sistema'
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."otorgar_puntos_al_confirmar"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reasignar_lote_pedido"("p_id_orden" bigint, "p_id_lote" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_lineas int;
  v_kg     numeric;
  v_lotes  text[];
begin
  -- El lote destino debe existir
  if not exists (select 1 from lotes_produccion where id_lote = p_id_lote) then
    return jsonb_build_object('ok', false, 'error', 'Lote inexistente: ' || coalesce(p_id_lote,'(vacío)'));
  end if;

  -- Lotes afectados: los actuales de la orden + el destino
  select array_agg(distinct d.id_lote_descontado) into v_lotes
    from ordenes_detalle d
   where d.id_orden = p_id_orden
     and coalesce(d.kg_descontado_lote, 0) > 0;

  if v_lotes is null then
    return jsonb_build_object('ok', false, 'error', 'La orden no tiene kg descontados de lote');
  end if;

  v_lotes := array_append(v_lotes, p_id_lote);

  -- Mover las líneas
  update ordenes_detalle d
     set id_lote_descontado = p_id_lote
   where d.id_orden = p_id_orden
     and coalesce(d.kg_descontado_lote, 0) > 0;

  get diagnostics v_lineas = row_count;

  select coalesce(sum(d.kg_descontado_lote), 0) into v_kg
    from ordenes_detalle d
   where d.id_orden = p_id_orden
     and coalesce(d.kg_descontado_lote, 0) > 0;

  -- Recalcular kilos_vendidos SOLO de los lotes afectados, desde las líneas
  update lotes_produccion l
     set kilos_vendidos = coalesce((
           select sum(d.kg_descontado_lote)
             from ordenes_detalle d
            where d.id_lote_descontado = l.id_lote
              and coalesce(d.kg_descontado_lote, 0) > 0), 0),
         fecha_actualizacion = now()
   where l.id_lote = any(v_lotes);

  return jsonb_build_object('ok', true, 'lineas', v_lineas, 'kg', v_kg, 'lote', p_id_lote);
end;
$$;


ALTER FUNCTION "public"."reasignar_lote_pedido"("p_id_orden" bigint, "p_id_lote" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reasignar_vendedor_cliente"("p_id_cliente" bigint, "p_id_vendedor" bigint, "p_nombre_vendedor" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  UPDATE clientes SET
    id_vendedor = p_id_vendedor,
    vendedor = p_nombre_vendedor,
    fecha_actualizacion = NOW()
  WHERE id = p_id_cliente;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Cliente no encontrado');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;


ALTER FUNCTION "public"."reasignar_vendedor_cliente"("p_id_cliente" bigint, "p_id_vendedor" bigint, "p_nombre_vendedor" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rechazar_gasto"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id BIGINT;
  v_motivo TEXT;
  v_actor TEXT;
BEGIN
  v_id := COALESCE((p_data->>'idGasto')::BIGINT, 0);
  v_motivo := p_data->>'motivo';
  v_actor := p_data->>'aprobadoPor';
  UPDATE gastos SET
    estatus = 'rechazado',
    motivo_rechazo = v_motivo,
    aprobado_por = v_actor,
    fecha_aprobacion = NOW()
  WHERE id = v_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Gasto no encontrado');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;


ALTER FUNCTION "public"."rechazar_gasto"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."registrar_entrega_vendedor"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $_$
DECLARE
  v_id_vendedor   BIGINT;
  v_monto_entregado NUMERIC;
  v_monto_calc    NUMERIC;
  v_diferencia    NUMERIC;
  v_actor         TEXT;
  v_notas         TEXT;
  v_id_punto_vend BIGINT;
  v_id_punto_pv   BIGINT;
  v_id_caja_vend  BIGINT;
  v_id_caja_pv    BIGINT;
  v_id_mov_origen BIGINT;
  v_id_mov_dest   BIGINT;
  v_id_mov_ajuste BIGINT;
  v_nombre_vend   TEXT;
BEGIN
  v_id_vendedor := COALESCE((p_data->>'idVendedor')::BIGINT, 0);
  v_monto_entregado := COALESCE((p_data->>'monto')::NUMERIC, 0);
  v_actor := COALESCE(p_data->>'actor', 'sistema');
  v_notas := p_data->>'notas';

  IF v_id_vendedor = 0 OR v_monto_entregado <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Faltan datos: vendedor o monto');
  END IF;

  -- Punto de vendedor
  SELECT id, nombre INTO v_id_punto_vend, v_nombre_vend
  FROM caja_puntos WHERE codigo = 'vendedor_' || v_id_vendedor;
  IF v_id_punto_vend IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Caja del vendedor no existe');
  END IF;

  -- Punto de Venta
  SELECT id INTO v_id_punto_pv FROM caja_puntos WHERE codigo = 'punto_venta' LIMIT 1;
  IF v_id_punto_pv IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No existe caja Punto de Venta');
  END IF;

  -- Saldo actual del vendedor (basado en TODOS sus movimientos)
  SELECT COALESCE(SUM(monto), 0) INTO v_monto_calc
  FROM caja_movimientos WHERE id_punto = v_id_punto_vend;
  v_monto_calc := COALESCE(v_monto_calc, 0);

  v_diferencia := v_monto_entregado - v_monto_calc;

  -- Buscar caja del día (puede no estar abierta — movimientos quedan huérfanos)
  SELECT id INTO v_id_caja_vend FROM caja_dias
    WHERE id_punto = v_id_punto_vend AND fecha = CURRENT_DATE AND estatus = 'abierta' LIMIT 1;
  SELECT id INTO v_id_caja_pv FROM caja_dias
    WHERE id_punto = v_id_punto_pv AND fecha = CURRENT_DATE AND estatus = 'abierta' LIMIT 1;

  -- Movimiento 1: sale de caja del vendedor
  INSERT INTO caja_movimientos (
    id_caja_dia, id_punto, tipo, monto, id_punto_destino,
    descripcion, actor
  ) VALUES (
    v_id_caja_vend, v_id_punto_vend, 'entrega_vendedor', -v_monto_entregado, v_id_punto_pv,
    COALESCE('Entrega de efectivo a Punto de Venta' || COALESCE(' — ' || v_notas, ''), 'Entrega'),
    v_actor
  ) RETURNING id INTO v_id_mov_origen;

  -- Movimiento 2: entra a Punto de Venta
  INSERT INTO caja_movimientos (
    id_caja_dia, id_punto, tipo, monto, id_punto_destino,
    descripcion, actor, id_mov_pareja
  ) VALUES (
    v_id_caja_pv, v_id_punto_pv, 'entrega_vendedor', v_monto_entregado, v_id_punto_vend,
    'Entrega de efectivo de ' || COALESCE(v_nombre_vend, 'vendedor'),
    v_actor, v_id_mov_origen
  ) RETURNING id INTO v_id_mov_dest;

  UPDATE caja_movimientos SET id_mov_pareja = v_id_mov_dest WHERE id = v_id_mov_origen;

  -- Si hubo diferencia, ajustarla en la caja del vendedor (sobrante/faltante)
  IF v_diferencia <> 0 THEN
    INSERT INTO caja_movimientos (
      id_caja_dia, id_punto, tipo, monto, descripcion, actor
    ) VALUES (
      v_id_caja_vend, v_id_punto_vend,
      CASE WHEN v_diferencia < 0 THEN 'ajuste_neg' ELSE 'ajuste_pos' END,
      -v_diferencia,  -- si entregó menos de lo calculado, hay un sobrante en su caja (positivo)
                      -- si entregó más, hay un faltante (negativo)
      'Ajuste por entrega — ' ||
        CASE WHEN v_diferencia < 0 THEN 'faltante de $' ELSE 'sobrante de $' END ||
        ABS(v_diferencia)::TEXT,
      v_actor
    ) RETURNING id INTO v_id_mov_ajuste;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'montoCalculado', v_monto_calc,
    'montoEntregado', v_monto_entregado,
    'diferencia', v_diferencia,
    'idMovOrigen', v_id_mov_origen,
    'idMovDestino', v_id_mov_dest
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$_$;


ALTER FUNCTION "public"."registrar_entrega_vendedor"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."registrar_evento"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id BIGINT;
BEGIN
  IF COALESCE(p_data->>'evento', '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'evento requerido');
  END IF;

  INSERT INTO eventos_navegacion (
    session_id, id_cliente, evento, params, utm_source, utm_medium, utm_campaign, path
  ) VALUES (
    NULLIF(p_data->>'sessionId', ''),
    NULLIF(p_data->>'idCliente', '')::BIGINT,
    p_data->>'evento',
    COALESCE(p_data->'params', '{}'::jsonb),
    NULLIF(p_data->>'utmSource', ''),
    NULLIF(p_data->>'utmMedium', ''),
    NULLIF(p_data->>'utmCampaign', ''),
    NULLIF(p_data->>'path', '')
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;


ALTER FUNCTION "public"."registrar_evento"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."registrar_lote"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id_lote_txt TEXT;
  v_id_new BIGINT;
  v_kilos NUMERIC;
  v_fecha DATE;
  v_count_today INTEGER;
BEGIN
  v_kilos := COALESCE((p_data->>'kilos')::NUMERIC, 0);
  v_fecha := COALESCE((p_data->>'fecha')::DATE, CURRENT_DATE);
  v_id_lote_txt := p_data->>'idLote';

  -- Si no viene id_lote, generamos uno
  IF v_id_lote_txt IS NULL OR v_id_lote_txt = '' THEN
    SELECT COUNT(*) INTO v_count_today FROM lotes_produccion WHERE fecha = v_fecha;
    v_id_lote_txt := 'LOTE-' || TO_CHAR(v_fecha, 'YYYYMMDD') || '-' || LPAD((v_count_today + 1)::TEXT, 2, '0');
  END IF;

  INSERT INTO lotes_produccion (id_lote, fecha, kilos_totales, notas)
  VALUES (v_id_lote_txt, v_fecha, v_kilos, p_data->>'notas')
  RETURNING id INTO v_id_new;

  RETURN jsonb_build_object('ok', true, 'id', v_id_new, 'idLote', v_id_lote_txt);
END;
$$;


ALTER FUNCTION "public"."registrar_lote"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."registrar_movimiento_caja"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id_punto      BIGINT;
  v_id_caja       BIGINT;
  v_tipo          TEXT;
  v_monto         NUMERIC;
  v_actor         TEXT;
  v_desc          TEXT;
  v_id_destino    BIGINT;
  v_id_mov1       BIGINT;
  v_id_mov2       BIGINT;
  v_caja_destino  BIGINT;
BEGIN
  v_id_punto := COALESCE((p_data->>'idPunto')::BIGINT, 0);
  v_tipo := p_data->>'tipo';
  v_monto := COALESCE((p_data->>'monto')::NUMERIC, 0);
  v_actor := COALESCE(p_data->>'actor', 'sistema');
  v_desc := p_data->>'descripcion';
  v_id_destino := NULLIF(p_data->>'idPuntoDestino', '')::BIGINT;

  IF v_id_punto = 0 OR v_tipo IS NULL OR v_monto = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Faltan datos: idPunto, tipo o monto');
  END IF;

  -- Buscar caja_dia del día (si está cerrada o no existe, igualmente registramos pero sin id_caja_dia)
  SELECT id INTO v_id_caja FROM caja_dias
  WHERE id_punto = v_id_punto AND fecha = CURRENT_DATE AND estatus = 'abierta'
  LIMIT 1;

  -- Si es transferencia entre puntos: 2 movimientos
  IF v_tipo IN ('retiro', 'deposito') AND v_id_destino IS NOT NULL THEN
    SELECT id INTO v_caja_destino FROM caja_dias
    WHERE id_punto = v_id_destino AND fecha = CURRENT_DATE AND estatus = 'abierta'
    LIMIT 1;

    -- Movimiento 1: sale del origen (monto negativo)
    INSERT INTO caja_movimientos (
      id_caja_dia, id_punto, tipo, monto, id_punto_destino,
      descripcion, actor
    ) VALUES (
      v_id_caja, v_id_punto, v_tipo, -ABS(v_monto), v_id_destino,
      COALESCE(v_desc, 'Transferencia interna'), v_actor
    ) RETURNING id INTO v_id_mov1;

    -- Movimiento 2: entra al destino (monto positivo)
    INSERT INTO caja_movimientos (
      id_caja_dia, id_punto, tipo, monto, id_punto_destino,
      descripcion, actor, id_mov_pareja
    ) VALUES (
      v_caja_destino, v_id_destino,
      CASE WHEN v_tipo = 'retiro' THEN 'deposito' ELSE 'retiro' END,
      ABS(v_monto), v_id_punto,
      COALESCE(v_desc, 'Transferencia interna'), v_actor, v_id_mov1
    ) RETURNING id INTO v_id_mov2;

    UPDATE caja_movimientos SET id_mov_pareja = v_id_mov2 WHERE id = v_id_mov1;

    RETURN jsonb_build_object('ok', true, 'idMovOrigen', v_id_mov1, 'idMovDestino', v_id_mov2);
  END IF;

  -- Movimiento simple
  INSERT INTO caja_movimientos (
    id_caja_dia, id_punto, tipo, monto, descripcion, actor
  ) VALUES (
    v_id_caja, v_id_punto, v_tipo, v_monto, v_desc, v_actor
  ) RETURNING id INTO v_id_mov1;

  RETURN jsonb_build_object('ok', true, 'idMovimiento', v_id_mov1);
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."registrar_movimiento_caja"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."registrar_o_actualizar_cliente"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_tel        TEXT;
  v_existente  clientes%ROWTYPE;
  v_id_new     BIGINT;
  v_tipo_id    INTEGER;
  v_tipo       TEXT;
  v_aprobado   BOOLEAN;
BEGIN
  v_tel := REGEXP_REPLACE(COALESCE(p_data->>'telefono', ''), '\D', '', 'g');
  IF v_tel = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Falta teléfono');
  END IF;

  -- Buscar existente
  SELECT * INTO v_existente FROM clientes
  WHERE RIGHT(REGEXP_REPLACE(telefono, '\D', '', 'g'), 10) = RIGHT(v_tel, 10)
  LIMIT 1;

  IF FOUND THEN
    UPDATE clientes SET
      cp          = COALESCE(NULLIF(p_data->>'cp', ''), cp),
      colonia     = COALESCE(NULLIF(p_data->>'colonia', ''), colonia),
      municipio   = COALESCE(NULLIF(p_data->>'municipio', ''), municipio),
      estado      = COALESCE(NULLIF(p_data->>'estado', ''), estado),
      coordenadas = COALESCE(NULLIF(p_data->>'coordenadas', ''), coordenadas),
      direccion   = COALESCE(NULLIF(p_data->>'direccion', ''), direccion),
      nombre      = COALESCE(NULLIF(p_data->>'nombre', ''), nombre)
    WHERE id = v_existente.id;
    RETURN jsonb_build_object('ok', true, 'idCliente', v_existente.id, 'esNuevo', false);
  END IF;

  -- Crear nuevo
  v_tipo_id := COALESCE((p_data->>'tipoId')::INTEGER, 1);
  v_tipo := COALESCE(p_data->>'tipo', 'Consumidor');
  IF v_tipo_id = 0 THEN
    v_tipo_id := CASE LOWER(v_tipo)
      WHEN 'consumidor' THEN 1
      WHEN 'restaurante' THEN 2
      WHEN 'tienda' THEN 3
      WHEN 'tienda / abarrotes' THEN 3
      WHEN 'comerciante' THEN 4
      WHEN 'mostrador' THEN 5
      ELSE 1
    END;
  END IF;
  v_aprobado := CASE WHEN v_tipo_id IN (1,5) THEN TRUE ELSE COALESCE((p_data->>'aprobadoB2B')::BOOLEAN, FALSE) END;

  INSERT INTO clientes (
    tipo_id, tipo, nombre, nombre_comercial, rfc, telefono,
    direccion, cp, colonia, municipio, estado, coordenadas,
    id_vendedor, vendedor, aprobado_b2b
  ) VALUES (
    v_tipo_id, v_tipo, p_data->>'nombre', p_data->>'nombre', p_data->>'rfc', v_tel,
    p_data->>'direccion', p_data->>'cp', p_data->>'colonia',
    p_data->>'municipio', p_data->>'estado', p_data->>'coordenadas',
    NULLIF(p_data->>'idVendedor', '')::BIGINT,
    p_data->>'nombreVendedor',
    v_aprobado
  ) RETURNING id INTO v_id_new;

  -- Ya NO inicializamos lealtad — el ledger se crea al primer movimiento.
  RETURN jsonb_build_object('ok', true, 'idCliente', v_id_new, 'esNuevo', true);
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."registrar_o_actualizar_cliente"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."registrar_produccion_sabor"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id BIGINT;
BEGIN
  INSERT INTO produccion_diaria (
    id_lote, fecha_produccion, sabor, kilos_producidos,
    fecha_siguiente, notas
  ) VALUES (
    NULLIF(p_data->>'idLote', '')::BIGINT,
    COALESCE((p_data->>'fechaProduccion')::DATE, CURRENT_DATE),
    p_data->>'sabor',
    COALESCE((p_data->>'kilos')::NUMERIC, 0),
    NULLIF(p_data->>'fechaSiguiente', '')::DATE,
    p_data->>'notas'
  ) RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;


ALTER FUNCTION "public"."registrar_produccion_sabor"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."registrar_prospecto_desde_interno"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_id   bigint;
  v_tel  text;
begin
  v_tel := nullif(regexp_replace(coalesce(p_data->>'telefono',''), '\D', '', 'g'), '');
  v_tel := right(coalesce(v_tel,''), 10);
  if length(coalesce(v_tel,'')) < 10 then
    return jsonb_build_object('ok', false, 'error', 'telefono invalido');
  end if;

  -- ¿Ya existe un prospecto con ese teléfono? → enlazar y sumar visita
  update public.prospectos
     set num_visitas        = coalesce(num_visitas, 0) + 1,
         fecha_visita       = now(),
         origen             = coalesce(origen, p_data->>'origen'),
         id_orden_origen    = coalesce(id_orden_origen, nullif(p_data->>'id_orden','')::bigint),
         consecutivo_origen = coalesce(consecutivo_origen, nullif(p_data->>'consecutivo',''))
   where right(regexp_replace(coalesce(contacto_telefono,''), '\D', '', 'g'), 10) = v_tel
   returning id into v_id;

  if found then
    return jsonb_build_object('ok', true, 'id', v_id, 'dedup', true);
  end if;

  -- Si no existe, insertar nuevo prospecto enlazado
  insert into public.prospectos (
    nombre_negocio, tipo_negocio, contacto_telefono,
    latitud, longitud, coordenadas,
    score, notas, distancia_metros,
    id_vendedor, nombre_vendedor,
    num_visitas, fecha_visita, estatus,
    origen, id_orden_origen, consecutivo_origen
  ) values (
    coalesce(nullif(p_data->>'nombre',''), '(Sin nombre)'),
    coalesce(nullif(p_data->>'tipo',''), 'consumidor'),
    v_tel,
    nullif(p_data->>'lat','')::numeric,
    nullif(p_data->>'lng','')::numeric,
    nullif(p_data->>'coordenadas',''),
    null,
    p_data->>'notas',
    null,
    nullif(p_data->>'id_vendedor','')::bigint,
    coalesce(p_data->>'nombre_vendedor',''),
    1,
    now(),
    coalesce(nullif(p_data->>'estatus',''), 'sampling'),
    p_data->>'origen',
    nullif(p_data->>'id_orden','')::bigint,
    nullif(p_data->>'consecutivo','')
  )
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'dedup', false);
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


ALTER FUNCTION "public"."registrar_prospecto_desde_interno"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reporte_cobros"("p_data" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_fecha_ini DATE;
  v_fecha_fin DATE;
  v_resumen JSONB;
  v_por_vendedor JSONB;
BEGIN
  v_fecha_ini := COALESCE((p_data->>'fechaIni')::DATE, CURRENT_DATE);
  v_fecha_fin := COALESCE((p_data->>'fechaFin')::DATE, CURRENT_DATE);

  -- Resumen por método de pago × estatus
  SELECT jsonb_build_object(
    'efectivoConfirmado',     COALESCE(SUM(total) FILTER (WHERE tipo_pago_id = 1 AND estatus_caja = 'confirmado'), 0),
    'efectivoPendiente',      COALESCE(SUM(total) FILTER (WHERE tipo_pago_id = 1 AND estatus_caja = 'pendiente_entrega'), 0),
    'transferConfirmada',     COALESCE(SUM(total) FILTER (WHERE tipo_pago_id = 2 AND estatus_caja = 'confirmado'), 0),
    'transferPendiente',      COALESCE(SUM(total) FILTER (WHERE tipo_pago_id = 2 AND estatus_caja = 'pendiente_confirmacion'), 0),
    'tarjetaConfirmada',      COALESCE(SUM(total) FILTER (WHERE tipo_pago_id = 3 AND estatus_caja = 'confirmado'), 0),
    'tarjetaPendiente',       COALESCE(SUM(total) FILTER (WHERE tipo_pago_id = 3 AND estatus_caja = 'pendiente_confirmacion'), 0),
    'totalCobrado',           COALESCE(SUM(total) FILTER (WHERE estatus_pago = 'Pagado' AND COALESCE(tipo_interno,'') = ''), 0),
    'numPedidos',             COUNT(*) FILTER (WHERE estatus_pago = 'Pagado' AND COALESCE(tipo_interno,'') = '')
  ) INTO v_resumen
  FROM ordenes
  WHERE fecha_orden::DATE BETWEEN v_fecha_ini AND v_fecha_fin
    AND estatus_pedido <> 'Cancelado';

  -- Detalle por vendedor
  SELECT COALESCE(jsonb_agg(t), '[]'::JSONB) INTO v_por_vendedor FROM (
    SELECT
      COALESCE(id_vendedor, 0) AS "idVendedor",
      COALESCE(nombre_vendedor, 'Sin vendedor') AS "nombreVendedor",
      COUNT(*) AS "numPedidos",
      SUM(total) AS "totalCobrado",
      SUM(total) FILTER (WHERE tipo_pago_id = 1) AS "efectivo",
      SUM(total) FILTER (WHERE tipo_pago_id = 1 AND estatus_caja = 'pendiente_entrega') AS "efectivoPendiente",
      SUM(total) FILTER (WHERE tipo_pago_id = 2) AS "transferencia",
      SUM(total) FILTER (WHERE tipo_pago_id = 2 AND estatus_caja = 'pendiente_confirmacion') AS "transferPendiente",
      SUM(total) FILTER (WHERE tipo_pago_id = 3) AS "tarjeta"
    FROM ordenes
    WHERE fecha_orden::DATE BETWEEN v_fecha_ini AND v_fecha_fin
      AND estatus_pago = 'Pagado'
      AND estatus_pedido <> 'Cancelado'
      AND COALESCE(tipo_interno,'') = ''
    GROUP BY id_vendedor, nombre_vendedor
    ORDER BY SUM(total) DESC
  ) t;

  RETURN jsonb_build_object(
    'ok', true,
    'fechaIni', v_fecha_ini,
    'fechaFin', v_fecha_fin,
    'resumen', v_resumen,
    'porVendedor', v_por_vendedor
  );
END;
$$;


ALTER FUNCTION "public"."reporte_cobros"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resumen_gastos"("p_data" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_mes_ini DATE;
  v_mes_fin DATE;
  v_dias_periodo INTEGER;
  v_total_mes NUMERIC := 0;
  v_aprobados NUMERIC := 0;
  v_pendientes NUMERIC := 0;
  v_rechazados NUMERIC := 0;
  v_por_categoria JSONB;
BEGIN
  v_mes_ini := DATE_TRUNC('month', CURRENT_DATE)::DATE;
  v_mes_fin := (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')::DATE;

  SELECT
    COALESCE(SUM(monto), 0),
    COALESCE(SUM(monto) FILTER (WHERE estatus = 'aprobado'), 0),
    COALESCE(SUM(monto) FILTER (WHERE estatus = 'pendiente'), 0),
    COALESCE(SUM(monto) FILTER (WHERE estatus = 'rechazado'), 0)
  INTO v_total_mes, v_aprobados, v_pendientes, v_rechazados
  FROM gastos WHERE fecha BETWEEN v_mes_ini AND v_mes_fin;

  SELECT COALESCE(jsonb_object_agg(categoria, monto_total), '{}'::JSONB) INTO v_por_categoria
  FROM (
    SELECT categoria, SUM(monto)::NUMERIC(12,2) AS monto_total
    FROM gastos
    WHERE fecha BETWEEN v_mes_ini AND v_mes_fin
    GROUP BY categoria
  ) t;

  RETURN jsonb_build_object(
    'ok', true,
    'mesIni', v_mes_ini,
    'mesFin', v_mes_fin,
    'totalMes', v_total_mes,
    'aprobados', v_aprobados,
    'pendientes', v_pendientes,
    'rechazados', v_rechazados,
    'porCategoria', v_por_categoria
  );
END;
$$;


ALTER FUNCTION "public"."resumen_gastos"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_config_secciones"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_rol TEXT;
  v_secciones TEXT[];
BEGIN
  v_rol := LOWER(COALESCE(p_data->>'rol', ''));
  IF v_rol = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Falta rol');
  END IF;

  -- Convertir array JSON a TEXT[]
  IF jsonb_typeof(p_data->'secciones') = 'array' THEN
    SELECT ARRAY_AGG(value::TEXT) INTO v_secciones
    FROM jsonb_array_elements_text(p_data->'secciones');
  ELSE
    v_secciones := '{}';
  END IF;

  INSERT INTO config_secciones (rol, secciones)
  VALUES (v_rol, v_secciones)
  ON CONFLICT (rol) DO UPDATE SET
    secciones = EXCLUDED.secciones,
    fecha_actualizacion = NOW();

  RETURN jsonb_build_object('ok', true);
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."set_config_secciones"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_coordenadas_gps"("p_telefono" "text", "p_gps" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tel  text;
  v_rows int;
begin
  v_tel := right(regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g'), 10);
  if length(v_tel) < 10 then
    return jsonb_build_object('ok', false, 'error', 'telefono invalido');
  end if;
  update public.clientes
     set coordenadas_gps = nullif(btrim(coalesce(p_gps, '')), '')
   where right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) = v_tel;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('ok', true, 'actualizados', v_rows);
end;
$$;


ALTER FUNCTION "public"."set_coordenadas_gps"("p_telefono" "text", "p_gps" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_cuota_vendedor"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id_vend BIGINT;
  v_mes INTEGER;
  v_anio INTEGER;
  v_cuota NUMERIC;
BEGIN
  v_id_vend := COALESCE((p_data->>'idVendedor')::BIGINT, 0);
  v_mes := COALESCE((p_data->>'mes')::INTEGER, 0);
  v_anio := COALESCE((p_data->>'anio')::INTEGER, 0);
  v_cuota := COALESCE((p_data->>'cuota')::NUMERIC, 0);

  IF v_id_vend = 0 OR v_mes = 0 OR v_anio = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Faltan datos: idVendedor/mes/anio');
  END IF;

  INSERT INTO cuotas_vendedor (id_vendedor, mes, anio, cuota)
  VALUES (v_id_vend, v_mes, v_anio, v_cuota)
  ON CONFLICT (id_vendedor, mes, anio) DO UPDATE SET
    cuota = EXCLUDED.cuota,
    fecha_actualizacion = NOW();

  RETURN jsonb_build_object('ok', true, 'cuota', v_cuota);
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."set_cuota_vendedor"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_lealtad_config"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_g     jsonb := COALESCE(p_data->'generacion', '{}'::jsonb);
  v_r     jsonb := COALESCE(p_data->'redencion',  '{}'::jsonb);
  v_ppp   numeric := GREATEST(0, COALESCE((v_g->>'puntos_por_peso')::numeric, 0.01));
  v_base  text    := COALESCE(NULLIF(v_g->>'base',''), 'total');
  v_gact  boolean := COALESCE((v_g->>'activo')::boolean, true);
  v_vpm   numeric := GREATEST(0, COALESCE((v_r->>'valor_punto_mxn')::numeric, 0.10));
  v_pct   int     := LEAST(99, GREATEST(0, COALESCE((v_r->>'pct_max_pedido')::int, 50)));  -- NUNCA 100
  v_pmin  numeric := GREATEST(0, COALESCE((v_r->>'pago_minimo_mxn')::numeric, 1));
  v_pminc int     := GREATEST(0, COALESCE((v_r->>'puntos_minimos_canje')::int, 0));
  v_ract  boolean := COALESCE((v_r->>'activo')::boolean, true);
  v_cfg   jsonb;
BEGIN
  IF v_base NOT IN ('total','subtotal') THEN v_base := 'total'; END IF;

  v_cfg := jsonb_build_object(
    'generacion',  jsonb_build_object('activo',v_gact,'puntos_por_peso',v_ppp,'base',v_base,'momento','pago_y_entrega'),
    'redencion',   jsonb_build_object('activo',v_ract,'valor_punto_mxn',v_vpm,'pct_max_pedido',v_pct,'pago_minimo_mxn',v_pmin,'puntos_minimos_canje',v_pminc),
    'segmentacion',jsonb_build_object('modo','todos_iguales')
  );

  INSERT INTO config_produccion (clave, valor, descripcion, fecha_actualizacion)
  VALUES ('lealtad', v_cfg, 'Reglas Crunchy Club (editable desde admin)', now())
  ON CONFLICT (clave) DO UPDATE
    SET valor = EXCLUDED.valor, fecha_actualizacion = now();

  RETURN jsonb_build_object('ok', true, 'data', v_cfg);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."set_lealtad_config"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_mayoreo_config"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_minimos jsonb := coalesce(p_data->'minimos', '{}'::jsonb);
begin
  insert into public.config_produccion (clave, valor, descripcion, fecha_actualizacion)
  values ('mayoreo',
          jsonb_build_object('minimos', v_minimos),
          'Mínimos de compra por presentación para canal mayorista',
          now())
  on conflict (clave) do update
    set valor = jsonb_build_object('minimos', v_minimos),
        fecha_actualizacion = now();

  return jsonb_build_object('ok', true, 'minimos', v_minimos);
end;
$$;


ALTER FUNCTION "public"."set_mayoreo_config"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_opt_in_promos"("p_telefono" "text", "p_acepta" boolean, "p_origen" "text" DEFAULT 'checkout'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tel  text;
  v_rows int;
begin
  -- Normaliza: últimos 10 dígitos (ignora +52, espacios, guiones).
  v_tel := right(regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g'), 10);
  if length(v_tel) < 10 then
    return jsonb_build_object('ok', false, 'error', 'telefono invalido');
  end if;

  if coalesce(p_acepta, false) then
    -- Alta de consentimiento (checkout o perfil)
    update public.clientes
       set acepta_promos       = true,
           acepta_promos_fecha  = now(),
           acepta_promos_origen = coalesce(p_origen, 'checkout')
     where right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) = v_tel;
  else
    -- Baja de consentimiento (desde el perfil)
    update public.clientes
       set acepta_promos       = false,
           acepta_promos_fecha  = null,
           acepta_promos_origen = coalesce(p_origen, 'perfil')
     where right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) = v_tel;
  end if;

  get diagnostics v_rows = row_count;
  return jsonb_build_object('ok', true, 'actualizados', v_rows, 'acepta', coalesce(p_acepta, false));
end;
$$;


ALTER FUNCTION "public"."set_opt_in_promos"("p_telefono" "text", "p_acepta" boolean, "p_origen" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_secciones_vendedor"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_id_vend BIGINT;
  v_secciones TEXT[];
BEGIN
  v_id_vend := COALESCE((p_data->>'idVendedor')::BIGINT, 0);
  IF v_id_vend = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Falta idVendedor');
  END IF;

  IF jsonb_typeof(p_data->'secciones') = 'array' THEN
    SELECT ARRAY_AGG(value::TEXT) INTO v_secciones
    FROM jsonb_array_elements_text(p_data->'secciones');
  ELSE
    v_secciones := NULL;
  END IF;

  -- Si secciones está vacío, devolver al default del rol (null en columna)
  UPDATE vendedores SET
    secciones = CASE WHEN v_secciones IS NULL OR ARRAY_LENGTH(v_secciones, 1) IS NULL THEN NULL ELSE v_secciones END,
    fecha_actualizacion = NOW()
  WHERE id = v_id_vend;

  RETURN jsonb_build_object('ok', true);
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."set_secciones_vendedor"("p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_ubicacion_cliente"("p_telefono" "text", "p_coordenadas" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_tel text := right(regexp_replace(coalesce(p_telefono,''), '\D', '', 'g'), 10);
  v_id bigint;
  v_nombre text;
begin
  if length(v_tel) <> 10 then
    return jsonb_build_object('ok', false, 'error', 'Teléfono inválido');
  end if;
  if coalesce(trim(p_coordenadas), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'Coordenadas vacías');
  end if;

  update public.clientes
     set coordenadas     = p_coordenadas,
         coordenadas_gps = p_coordenadas
   where right(regexp_replace(telefono, '\D', '', 'g'), 10) = v_tel
   returning id, nombre into v_id, v_nombre;

  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'Cliente no encontrado');
  end if;
  return jsonb_build_object('ok', true, 'idCliente', v_id, 'nombre', v_nombre);
end;
$$;


ALTER FUNCTION "public"."set_ubicacion_cliente"("p_telefono" "text", "p_coordenadas" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."siguiente_consecutivo"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_num INTEGER;
BEGIN
  v_num := nextval('seq_consecutivo_pedido');
  RETURN 'PED-' || LPAD(v_num::TEXT, 5, '0');
END;
$$;


ALTER FUNCTION "public"."siguiente_consecutivo"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_reconciliar_lote"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_id bigint;
begin
  if TG_TABLE_NAME = 'ordenes' then
    v_id := NEW.id;
  else
    v_id := NEW.id_orden;
  end if;
  perform public.fn_reconciliar_pedido(v_id);
  return null;
end;
$$;


ALTER FUNCTION "public"."trg_reconciliar_lote"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_fecha_actualizacion"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.fecha_actualizacion = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_fecha_actualizacion"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validar_cupon"("p_codigo" "text", "p_telefono" "text" DEFAULT NULL::"text", "p_id_cliente" bigint DEFAULT NULL::bigint, "p_total_compra" numeric DEFAULT 0, "p_segmento_cliente" "text" DEFAULT 'consumidor'::"text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $_$
DECLARE
  v_cupon cupones%ROWTYPE;
  v_usos_usuario INTEGER;
BEGIN
  -- Buscar cupón por código
  SELECT * INTO v_cupon FROM cupones WHERE codigo = UPPER(p_codigo) LIMIT 1;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Cupón no encontrado');
  END IF;

  -- Activo
  IF NOT v_cupon.activo THEN
    RETURN json_build_object('ok', false, 'error', 'Cupón desactivado');
  END IF;

  -- Vigencia
  IF v_cupon.vigencia_inicio > NOW() THEN
    RETURN json_build_object('ok', false, 'error', 'Cupón aún no vigente');
  END IF;
  IF v_cupon.vigencia_fin < NOW() THEN
    RETURN json_build_object('ok', false, 'error', 'Cupón expirado');
  END IF;

  -- Usos máximos
  IF v_cupon.usos_maximos > 0 AND v_cupon.usos_actuales >= v_cupon.usos_maximos THEN
    RETURN json_build_object('ok', false, 'error', 'Cupón agotado');
  END IF;

  -- Compra mínima
  IF p_total_compra < v_cupon.compra_minima THEN
    RETURN json_build_object(
      'ok', false,
      'error', format('Compra mínima $%s', v_cupon.compra_minima)
    );
  END IF;

  -- Segmento
  IF v_cupon.segmento <> 'todos' AND v_cupon.segmento <> p_segmento_cliente THEN
    RETURN json_build_object('ok', false, 'error', 'Cupón no aplicable a tu tipo de cuenta');
  END IF;

  -- Un uso por usuario
  IF v_cupon.un_uso_por_usuario THEN
    SELECT COUNT(*) INTO v_usos_usuario FROM cupones_uso
    WHERE id_cupon = v_cupon.id
      AND (
        (p_telefono IS NOT NULL AND telefono = p_telefono)
        OR (p_id_cliente IS NOT NULL AND id_cliente = p_id_cliente)
      );
    IF v_usos_usuario > 0 THEN
      RETURN json_build_object('ok', false, 'error', 'Ya usaste este cupón antes');
    END IF;
  END IF;

  -- OK: devolver cupón completo
  RETURN json_build_object(
    'ok', true,
    'cupon', json_build_object(
      'id', v_cupon.id,
      'codigo', v_cupon.codigo,
      'tipo', v_cupon.tipo,
      'valor', v_cupon.valor,
      'descripcion', v_cupon.descripcion
    )
  );
END;
$_$;


ALTER FUNCTION "public"."validar_cupon"("p_codigo" "text", "p_telefono" "text", "p_id_cliente" bigint, "p_total_compra" numeric, "p_segmento_cliente" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validar_vendedor_pin"("p_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_telefono TEXT;
  v_pin      TEXT;
  v_tel_norm TEXT;
  v_vendedor vendedores%ROWTYPE;
BEGIN
  v_telefono := COALESCE(p_data->>'telefono', '');
  v_pin      := COALESCE(p_data->>'pin', '');

  IF v_telefono = '' OR v_pin = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Faltan datos');
  END IF;

  v_tel_norm := REGEXP_REPLACE(v_telefono, '\D', '', 'g');

  -- Buscar vendedor por teléfono (últimos 10 dígitos)
  SELECT * INTO v_vendedor FROM vendedores
  WHERE RIGHT(REGEXP_REPLACE(COALESCE(telefono, ''), '\D', '', 'g'), 10) = RIGHT(v_tel_norm, 10)
    AND activo = TRUE
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Vendedor no encontrado o inactivo');
  END IF;

  -- Verificar PIN
  IF v_vendedor.pin_hash IS NULL OR v_vendedor.pin_hash = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Vendedor sin PIN configurado');
  END IF;

  IF v_vendedor.pin_hash <> crypt(v_pin, v_vendedor.pin_hash) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PIN incorrecto');
  END IF;

  -- OK
  RETURN jsonb_build_object(
    'ok', true,
    'vendedor', jsonb_build_object(
      'id', v_vendedor.id,
      'nombre', v_vendedor.nombre,
      'telefono', v_vendedor.telefono,
      'email', v_vendedor.email,
      'rol', v_vendedor.rol,
      'direccionPuntoVenta', v_vendedor.direccion_punto_venta,
      'cpPuntoVenta', v_vendedor.cp_punto_venta
    )
  );
END;
$$;


ALTER FUNCTION "public"."validar_vendedor_pin"("p_data" "jsonb") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."app_config" (
    "clave" "text" NOT NULL,
    "valor" "text" NOT NULL,
    "actualizado" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."app_config" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."caja_dias" (
    "id" bigint NOT NULL,
    "id_punto" bigint NOT NULL,
    "fecha" "date" NOT NULL,
    "saldo_apertura" numeric(12,2) DEFAULT 0 NOT NULL,
    "saldo_cierre_declarado" numeric(12,2),
    "saldo_cierre_calculado" numeric(12,2),
    "diferencia" numeric(12,2),
    "estatus" "text" DEFAULT 'abierta'::"text" NOT NULL,
    "abierta_por" "text",
    "fecha_apertura" timestamp with time zone DEFAULT "now"() NOT NULL,
    "cerrada_por" "text",
    "fecha_cierre" timestamp with time zone,
    "notas_apertura" "text",
    "notas_cierre" "text",
    "fecha_actualizacion" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."caja_dias" OWNER TO "postgres";


COMMENT ON TABLE "public"."caja_dias" IS 'Apertura y cierre diario por punto de caja';



CREATE SEQUENCE IF NOT EXISTS "public"."caja_dias_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."caja_dias_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."caja_dias_id_seq" OWNED BY "public"."caja_dias"."id";



CREATE TABLE IF NOT EXISTS "public"."caja_movimientos" (
    "id" bigint NOT NULL,
    "id_caja_dia" bigint,
    "id_punto" bigint NOT NULL,
    "fecha" timestamp with time zone DEFAULT "now"() NOT NULL,
    "tipo" "text" NOT NULL,
    "monto" numeric(12,2) NOT NULL,
    "id_orden" bigint,
    "consecutivo_pedido" "text",
    "id_gasto" bigint,
    "id_punto_destino" bigint,
    "id_mov_pareja" bigint,
    "descripcion" "text",
    "actor" "text",
    "fecha_registro" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."caja_movimientos" OWNER TO "postgres";


COMMENT ON TABLE "public"."caja_movimientos" IS 'Ledger de movimientos de caja. NUNCA UPDATE — solo INSERT.';



CREATE SEQUENCE IF NOT EXISTS "public"."caja_movimientos_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."caja_movimientos_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."caja_movimientos_id_seq" OWNED BY "public"."caja_movimientos"."id";



CREATE TABLE IF NOT EXISTS "public"."caja_puntos" (
    "id" bigint NOT NULL,
    "codigo" "text" NOT NULL,
    "nombre" "text" NOT NULL,
    "tipo" "text" NOT NULL,
    "fondo_minimo" numeric(12,2) DEFAULT 0,
    "activo" boolean DEFAULT true NOT NULL,
    "orden_display" integer DEFAULT 0,
    "fecha_creacion" timestamp with time zone DEFAULT "now"() NOT NULL,
    "id_vendedor" bigint,
    "subtipo" "text"
);


ALTER TABLE "public"."caja_puntos" OWNER TO "postgres";


COMMENT ON TABLE "public"."caja_puntos" IS 'Catálogo de cajas a trackear (efectivo + banco)';



COMMENT ON COLUMN "public"."caja_puntos"."id_vendedor" IS 'Si es caja personal de vendedor, su ID. NULL para cajas centrales.';



COMMENT ON COLUMN "public"."caja_puntos"."subtipo" IS 'mostrador|vendedor_personal|banco_general';



CREATE SEQUENCE IF NOT EXISTS "public"."caja_puntos_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."caja_puntos_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."caja_puntos_id_seq" OWNED BY "public"."caja_puntos"."id";



CREATE TABLE IF NOT EXISTS "public"."canjes_historial" (
    "id" bigint NOT NULL,
    "id_cliente" bigint NOT NULL,
    "id_premio" bigint,
    "nombre_premio" "text" NOT NULL,
    "puntos_usados" integer NOT NULL,
    "id_movimiento" bigint,
    "estatus" "text" DEFAULT 'aplicado'::"text" NOT NULL,
    "fecha" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."canjes_historial" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."canjes_historial_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."canjes_historial_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."canjes_historial_id_seq" OWNED BY "public"."canjes_historial"."id";



CREATE TABLE IF NOT EXISTS "public"."clientes" (
    "id" bigint NOT NULL,
    "tipo_id" integer,
    "tipo" "text",
    "nombre" "text" NOT NULL,
    "nombre_comercial" "text",
    "rfc" "text",
    "telefono" "text",
    "direccion" "text",
    "cp" "text",
    "colonia" "text",
    "municipio" "text",
    "estado" "text",
    "coordenadas" "text",
    "latitud" numeric(10,7),
    "longitud" numeric(10,7),
    "id_vendedor" bigint,
    "vendedor" "text",
    "aprobado_b2b" boolean DEFAULT true NOT NULL,
    "fecha_creacion" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fecha_actualizacion" timestamp with time zone DEFAULT "now"() NOT NULL,
    "acepta_promos" boolean DEFAULT false NOT NULL,
    "acepta_promos_fecha" timestamp with time zone,
    "acepta_promos_origen" "text",
    "coordenadas_gps" "text"
);


ALTER TABLE "public"."clientes" OWNER TO "postgres";


COMMENT ON TABLE "public"."clientes" IS 'Maestro de clientes (B2C y B2B)';



COMMENT ON COLUMN "public"."clientes"."tipo_id" IS '1=Consumidor 2=Restaurante 3=Tienda 4=Comerciante 5=Mostrador';



CREATE SEQUENCE IF NOT EXISTS "public"."clientes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."clientes_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."clientes_id_seq" OWNED BY "public"."clientes"."id";



CREATE TABLE IF NOT EXISTS "public"."config_produccion" (
    "clave" "text" NOT NULL,
    "valor" "jsonb" NOT NULL,
    "descripcion" "text",
    "fecha_actualizacion" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."config_produccion" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."config_secciones" (
    "rol" "text" NOT NULL,
    "secciones" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "fecha_actualizacion" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."config_secciones" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cuotas_vendedor" (
    "id" bigint NOT NULL,
    "id_vendedor" bigint NOT NULL,
    "mes" integer NOT NULL,
    "anio" integer NOT NULL,
    "cuota" numeric(12,2) DEFAULT 0 NOT NULL,
    "fecha_actualizacion" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "cuotas_vendedor_mes_check" CHECK ((("mes" >= 1) AND ("mes" <= 12)))
);


ALTER TABLE "public"."cuotas_vendedor" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."cuotas_vendedor_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."cuotas_vendedor_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."cuotas_vendedor_id_seq" OWNED BY "public"."cuotas_vendedor"."id";



CREATE TABLE IF NOT EXISTS "public"."cupones" (
    "id" bigint NOT NULL,
    "codigo" "text" NOT NULL,
    "descripcion" "text",
    "tipo" "text" DEFAULT 'descuento_pct'::"text" NOT NULL,
    "valor" numeric(10,2) DEFAULT 0 NOT NULL,
    "vigencia_inicio" timestamp with time zone DEFAULT "now"() NOT NULL,
    "vigencia_fin" timestamp with time zone NOT NULL,
    "usos_maximos" integer DEFAULT 0,
    "usos_actuales" integer DEFAULT 0 NOT NULL,
    "compra_minima" numeric(10,2) DEFAULT 0,
    "segmento" "text" DEFAULT 'todos'::"text" NOT NULL,
    "un_uso_por_usuario" boolean DEFAULT true NOT NULL,
    "activo" boolean DEFAULT true NOT NULL,
    "fecha_creacion" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fecha_actualizacion" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cupones" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."cupones_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."cupones_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."cupones_id_seq" OWNED BY "public"."cupones"."id";



CREATE TABLE IF NOT EXISTS "public"."cupones_uso" (
    "id" bigint NOT NULL,
    "id_cupon" bigint NOT NULL,
    "codigo" "text" NOT NULL,
    "id_cliente" bigint,
    "telefono" "text",
    "id_orden" "text",
    "monto_descuento" numeric(10,2) DEFAULT 0 NOT NULL,
    "fecha" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cupones_uso" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."cupones_uso_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."cupones_uso_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."cupones_uso_id_seq" OWNED BY "public"."cupones_uso"."id";



CREATE TABLE IF NOT EXISTS "public"."encuestas" (
    "id" bigint NOT NULL,
    "id_orden" bigint NOT NULL,
    "id_cliente" bigint,
    "telefono" "text",
    "sabor" integer,
    "textura" integer,
    "sal" "text",
    "recompra" "text",
    "app_facilidad" integer,
    "comentario" "text",
    "utm_campaign" "text",
    "creado_en" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "encuestas_app_facilidad_check" CHECK ((("app_facilidad" >= 1) AND ("app_facilidad" <= 5))),
    CONSTRAINT "encuestas_recompra_check" CHECK (("recompra" = ANY (ARRAY['si'::"text", 'tal_vez'::"text", 'no'::"text"]))),
    CONSTRAINT "encuestas_sabor_check" CHECK ((("sabor" >= 1) AND ("sabor" <= 5))),
    CONSTRAINT "encuestas_sal_check" CHECK (("sal" = ANY (ARRAY['poca'::"text", 'justa'::"text", 'mucha'::"text"]))),
    CONSTRAINT "encuestas_textura_check" CHECK ((("textura" >= 1) AND ("textura" <= 5)))
);


ALTER TABLE "public"."encuestas" OWNER TO "postgres";


COMMENT ON TABLE "public"."encuestas" IS 'Encuesta post-entrega: producto (sabor/textura/sal/recompra) + app (facilidad/comentario). 1 por orden.';



ALTER TABLE "public"."encuestas" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."encuestas_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."eventos_navegacion" (
    "id" bigint NOT NULL,
    "session_id" "text",
    "id_cliente" bigint,
    "evento" "text" NOT NULL,
    "params" "jsonb",
    "utm_source" "text",
    "utm_medium" "text",
    "utm_campaign" "text",
    "path" "text",
    "creado_en" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."eventos_navegacion" OWNER TO "postgres";


ALTER TABLE "public"."eventos_navegacion" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."eventos_navegacion_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."gastos" (
    "id" bigint NOT NULL,
    "fecha" "date" DEFAULT CURRENT_DATE NOT NULL,
    "categoria" "text" NOT NULL,
    "subcategoria" "text",
    "descripcion" "text",
    "monto" numeric(12,2) NOT NULL,
    "moneda" "text" DEFAULT 'MXN'::"text" NOT NULL,
    "metodo_pago" "text",
    "proveedor" "text",
    "rfc_proveedor" "text",
    "tiene_factura" boolean DEFAULT false NOT NULL,
    "ticket_url" "text",
    "notas" "text",
    "id_vendedor" bigint,
    "nombre_vendedor" "text",
    "estatus" "text" DEFAULT 'pendiente'::"text" NOT NULL,
    "motivo_rechazo" "text",
    "aprobado_por" "text",
    "fecha_aprobacion" timestamp with time zone,
    "fecha_creacion" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fecha_actualizacion" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fuente_dinero" "text"
);


ALTER TABLE "public"."gastos" OWNER TO "postgres";


COMMENT ON TABLE "public"."gastos" IS 'Gastos operativos con aprobación admin.';



COMMENT ON COLUMN "public"."gastos"."fuente_dinero" IS 'Crunchy | Inversion | Otro — fuente del dinero usado';



CREATE SEQUENCE IF NOT EXISTS "public"."gastos_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."gastos_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."gastos_id_seq" OWNED BY "public"."gastos"."id";



CREATE TABLE IF NOT EXISTS "public"."gastos_insumos" (
    "id" bigint NOT NULL,
    "id_gasto" bigint NOT NULL,
    "insumo" "text" NOT NULL,
    "unidad" "text",
    "cantidad" numeric(12,3),
    "precio_unitario" numeric(10,2),
    "subtotal" numeric(12,2)
);


ALTER TABLE "public"."gastos_insumos" OWNER TO "postgres";


COMMENT ON TABLE "public"."gastos_insumos" IS 'Líneas detalladas de insumos dentro de un gasto.';



CREATE SEQUENCE IF NOT EXISTS "public"."gastos_insumos_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."gastos_insumos_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."gastos_insumos_id_seq" OWNED BY "public"."gastos_insumos"."id";



CREATE TABLE IF NOT EXISTS "public"."insumos" (
    "id" bigint NOT NULL,
    "nombre" "text" NOT NULL,
    "unidad" "text" DEFAULT 'kg'::"text" NOT NULL,
    "unidad_compra" "text",
    "costo_unidad" numeric(10,2) DEFAULT 0,
    "stock_actual" numeric(12,3) DEFAULT 0,
    "stock_minimo" numeric(10,3) DEFAULT 0,
    "proveedor" "text",
    "activo" boolean DEFAULT true NOT NULL,
    "fecha_creacion" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."insumos" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."insumos_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."insumos_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."insumos_id_seq" OWNED BY "public"."insumos"."id";



CREATE TABLE IF NOT EXISTS "public"."inventario_fisico" (
    "id" bigint NOT NULL,
    "fecha" "date" DEFAULT CURRENT_DATE NOT NULL,
    "sabor" "text" NOT NULL,
    "kilos_contados" numeric(10,2) NOT NULL,
    "kilos_sistema" numeric(10,2),
    "diferencia" numeric(10,2),
    "notas" "text",
    "registrado_por" "text",
    "fecha_creacion" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."inventario_fisico" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."inventario_fisico_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."inventario_fisico_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."inventario_fisico_id_seq" OWNED BY "public"."inventario_fisico"."id";



CREATE TABLE IF NOT EXISTS "public"."jornadas" (
    "id" bigint NOT NULL,
    "id_vendedor" bigint NOT NULL,
    "nombre_vendedor" "text",
    "fecha" "date" DEFAULT CURRENT_DATE NOT NULL,
    "hora_inicio" timestamp with time zone DEFAULT "now"() NOT NULL,
    "hora_cierre" timestamp with time zone,
    "coords_entrada" "text",
    "coords_salida" "text",
    "en_planta_entrada" boolean DEFAULT false NOT NULL,
    "en_planta_salida" boolean,
    "actividades" "text"[],
    "notas_inicio" "text",
    "notas_cierre" "text",
    "duracion_minutos" integer,
    "estatus" "text" DEFAULT 'abierta'::"text" NOT NULL,
    "fecha_creacion" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fecha_actualizacion" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."jornadas" OWNER TO "postgres";


COMMENT ON TABLE "public"."jornadas" IS 'Jornadas laborales con GPS de entrada/salida y actividades del día';



CREATE SEQUENCE IF NOT EXISTS "public"."jornadas_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."jornadas_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."jornadas_id_seq" OWNED BY "public"."jornadas"."id";



CREATE TABLE IF NOT EXISTS "public"."lealtad_movimientos" (
    "id" bigint NOT NULL,
    "id_cliente" bigint NOT NULL,
    "tipo" "text" NOT NULL,
    "puntos" integer NOT NULL,
    "id_orden" bigint,
    "consecutivo" "text",
    "id_premio" bigint,
    "nombre_premio" "text",
    "monto_origen" numeric(12,2),
    "nota" "text",
    "actor" "text",
    "fecha" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lealtad_movimientos" OWNER TO "postgres";


COMMENT ON TABLE "public"."lealtad_movimientos" IS 'Ledger Crunchy Club. Saldo = SUM(puntos). NUNCA actualizar filas: solo INSERT.';



CREATE SEQUENCE IF NOT EXISTS "public"."lealtad_movimientos_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."lealtad_movimientos_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."lealtad_movimientos_id_seq" OWNED BY "public"."lealtad_movimientos"."id";



CREATE TABLE IF NOT EXISTS "public"."lotes_produccion" (
    "id" bigint NOT NULL,
    "id_lote" "text",
    "fecha" "date" DEFAULT CURRENT_DATE NOT NULL,
    "kilos_totales" numeric(10,2) DEFAULT 0 NOT NULL,
    "kilos_vendidos" numeric(10,2) DEFAULT 0 NOT NULL,
    "kilos_disponibles" numeric(10,2) GENERATED ALWAYS AS (("kilos_totales" - "kilos_vendidos")) STORED,
    "estatus" "text" DEFAULT 'Activo'::"text" NOT NULL,
    "notas" "text",
    "fecha_cierre" timestamp with time zone,
    "fecha_creacion" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fecha_actualizacion" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lotes_produccion" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."lotes_produccion_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."lotes_produccion_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."lotes_produccion_id_seq" OWNED BY "public"."lotes_produccion"."id";



CREATE TABLE IF NOT EXISTS "public"."ordenes" (
    "id" bigint NOT NULL,
    "consecutivo" "text" NOT NULL,
    "canal" "text" DEFAULT 'web'::"text" NOT NULL,
    "id_cliente" bigint,
    "nombre_cliente" "text",
    "id_vendedor" bigint,
    "nombre_vendedor" "text",
    "fecha_orden" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fecha_entrega" timestamp with time zone,
    "fecha_entrega_real" timestamp with time zone,
    "fecha_pago" timestamp with time zone,
    "tipo_pago_id" integer,
    "tipo_pago" "text",
    "estatus_pedido" "text" DEFAULT 'Pendiente'::"text" NOT NULL,
    "estatus_pago" "text" DEFAULT 'Pendiente'::"text" NOT NULL,
    "subtotal" numeric(12,2) DEFAULT 0 NOT NULL,
    "descuento" numeric(12,2) DEFAULT 0 NOT NULL,
    "total" numeric(12,2) DEFAULT 0 NOT NULL,
    "notas" "text",
    "cp" "text",
    "colonia" "text",
    "municipio" "text",
    "estado" "text",
    "direccion" "text",
    "coordenadas" "text",
    "zona_entrega" "text" DEFAULT 'cdmx'::"text",
    "stripe_payment_id" "text",
    "cupon_codigo" "text",
    "tipo_interno" "text",
    "idempotency_key" "text",
    "actualizado_por" "text",
    "total_letras" "text",
    "fecha_registro" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fecha_actualizacion" timestamp with time zone DEFAULT "now"() NOT NULL,
    "estatus_caja" "text",
    "fecha_confirmacion_caja" timestamp with time zone,
    "confirmado_por" "text",
    "estado_pago" "text",
    "stripe_session_id" "text",
    "stripe_payment_intent" "text",
    "pagado_en" timestamp with time zone,
    "ultimo_recordatorio_pago" timestamp with time zone,
    "recordatorios_pago_enviados" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."ordenes" OWNER TO "postgres";


COMMENT ON COLUMN "public"."ordenes"."canal" IS 'web|vendedor|mostrador|tienda|restaurante|interno';



COMMENT ON COLUMN "public"."ordenes"."tipo_interno" IS 'Si no es vacío, el pedido no cuenta en ventas $: sampling|demo|regalo|merma';



COMMENT ON COLUMN "public"."ordenes"."idempotency_key" IS 'Clave para evitar duplicar pedido si se reintenta el envío';



COMMENT ON COLUMN "public"."ordenes"."estatus_caja" IS 'NULL=no aplica (no pagado/cancelado/interno) | pendiente_entrega (efectivo en bolsillo vendedor) | pendiente_confirmacion (transferencia/tarjeta sin verificar) | confirmado (ya en caja correspondiente)';



CREATE TABLE IF NOT EXISTS "public"."ordenes_detalle" (
    "id" bigint NOT NULL,
    "id_orden" bigint NOT NULL,
    "consecutivo_orden" "text",
    "id_producto" "text",
    "sabor" "text",
    "presentacion" "text",
    "tipo_venta" "text",
    "cantidad" numeric(10,3) DEFAULT 0 NOT NULL,
    "gramos_vendidos" numeric(10,2) DEFAULT 0,
    "precio_unitario" numeric(10,2) DEFAULT 0,
    "descuento" numeric(10,2) DEFAULT 0,
    "subtotal" numeric(12,2) DEFAULT 0 NOT NULL,
    "precio_kg" numeric(10,2) DEFAULT 0,
    "notas_linea" "text",
    "fecha" timestamp with time zone DEFAULT "now"() NOT NULL,
    "kg_descontado_lote" numeric DEFAULT 0 NOT NULL,
    "id_lote_descontado" "text"
);


ALTER TABLE "public"."ordenes_detalle" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."ordenes_detalle_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."ordenes_detalle_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."ordenes_detalle_id_seq" OWNED BY "public"."ordenes_detalle"."id";



CREATE SEQUENCE IF NOT EXISTS "public"."ordenes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."ordenes_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."ordenes_id_seq" OWNED BY "public"."ordenes"."id";



CREATE TABLE IF NOT EXISTS "public"."otp_codigos" (
    "id" bigint NOT NULL,
    "telefono" "text" NOT NULL,
    "email" "text",
    "codigo_hash" "text" NOT NULL,
    "expira_en" timestamp with time zone NOT NULL,
    "usado" boolean DEFAULT false NOT NULL,
    "intentos" integer DEFAULT 0 NOT NULL,
    "creado" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."otp_codigos" OWNER TO "postgres";


ALTER TABLE "public"."otp_codigos" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."otp_codigos_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE OR REPLACE VIEW "public"."saldos_lealtad" AS
 SELECT "id_cliente",
    (COALESCE("sum"("puntos"), (0)::bigint))::integer AS "puntos_actuales",
    (COALESCE("sum"("puntos") FILTER (WHERE ("puntos" > 0)), (0)::bigint))::integer AS "puntos_ganados_historico",
    (COALESCE("abs"("sum"("puntos") FILTER (WHERE ("puntos" < 0))), (0)::bigint))::integer AS "puntos_canjeados_historico",
    "count"(*) AS "num_movimientos",
    "max"("fecha") AS "fecha_ultimo_movimiento",
    "count"(*) FILTER (WHERE ("tipo" = 'canje'::"text")) AS "num_canjes",
    "count"(*) FILTER (WHERE ("tipo" = 'generacion'::"text")) AS "num_generaciones"
   FROM "public"."lealtad_movimientos"
  GROUP BY "id_cliente";


ALTER VIEW "public"."saldos_lealtad" OWNER TO "postgres";


COMMENT ON VIEW "public"."saldos_lealtad" IS 'Saldo por cliente. Vista en vivo.';



CREATE OR REPLACE VIEW "public"."pasivo_lealtad" AS
 SELECT (COALESCE("sum"("puntos_actuales"), (0)::bigint))::integer AS "puntos_pasivo_total",
    "count"(*) FILTER (WHERE ("puntos_actuales" > 0)) AS "clientes_con_saldo",
    "round"("avg"("puntos_actuales") FILTER (WHERE ("puntos_actuales" > 0)), 2) AS "promedio_saldo_activo",
    "max"("puntos_actuales") AS "saldo_maximo",
    (((COALESCE("sum"("puntos_actuales"), (0)::bigint))::numeric * 1.00))::numeric(12,2) AS "pasivo_pesos_estimado"
   FROM "public"."saldos_lealtad";


ALTER VIEW "public"."pasivo_lealtad" OWNER TO "postgres";


COMMENT ON VIEW "public"."pasivo_lealtad" IS 'Pasivo total de la compañía en puntos (deuda con clientes).';



CREATE TABLE IF NOT EXISTS "public"."premios" (
    "id" bigint NOT NULL,
    "nombre" "text" NOT NULL,
    "descripcion" "text",
    "puntos_costo" integer NOT NULL,
    "imagen_url" "text",
    "stock" integer DEFAULT '-1'::integer,
    "activo" boolean DEFAULT true NOT NULL,
    "fecha_creacion" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."premios" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."premios_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."premios_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."premios_id_seq" OWNED BY "public"."premios"."id";



CREATE TABLE IF NOT EXISTS "public"."produccion_diaria" (
    "id" bigint NOT NULL,
    "id_lote" bigint,
    "fecha_produccion" "date" DEFAULT CURRENT_DATE NOT NULL,
    "sabor" "text" NOT NULL,
    "kilos_producidos" numeric(10,2) DEFAULT 0 NOT NULL,
    "kilos_vendidos" numeric(10,2) DEFAULT 0 NOT NULL,
    "kilos_disponibles" numeric(10,2) GENERATED ALWAYS AS (("kilos_producidos" - "kilos_vendidos")) STORED,
    "fecha_siguiente" "date",
    "notas" "text",
    "activo" boolean DEFAULT true NOT NULL,
    "fecha_creacion" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fecha_actualizacion" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."produccion_diaria" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."produccion_diaria_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."produccion_diaria_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."produccion_diaria_id_seq" OWNED BY "public"."produccion_diaria"."id";



CREATE TABLE IF NOT EXISTS "public"."productos" (
    "id" bigint NOT NULL,
    "sabor" "text" NOT NULL,
    "presentacion" "text" NOT NULL,
    "gramos" numeric(8,2) DEFAULT 0,
    "precio_consumidor" numeric(10,2) DEFAULT 0 NOT NULL,
    "precio_tienda" numeric(10,2) DEFAULT 0 NOT NULL,
    "precio_restaurante" numeric(10,2) DEFAULT 0 NOT NULL,
    "precio_mostrador" numeric(10,2) DEFAULT 0 NOT NULL,
    "precio_granel_kg" numeric(10,2) DEFAULT 0 NOT NULL,
    "tipo_venta" integer DEFAULT 1 NOT NULL,
    "activo" boolean DEFAULT true NOT NULL,
    "imagen_url" "text",
    "descuento_pct" numeric(5,2) DEFAULT 0,
    "fecha_creacion" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fecha_actualizacion" timestamp with time zone DEFAULT "now"() NOT NULL,
    "descripcion" "text",
    "orden" smallint,
    "precio_mayorista" numeric
);


ALTER TABLE "public"."productos" OWNER TO "postgres";


COMMENT ON TABLE "public"."productos" IS 'Catálogo de papas fritas. Bebidas viven en productos_bebidas (tabla aparte)';



COMMENT ON COLUMN "public"."productos"."tipo_venta" IS '1 = pieza (bolsas), 2 = granel (kg)';



COMMENT ON COLUMN "public"."productos"."descuento_pct" IS 'Descuento porcentual (0-100). Si > 0, aplica promoción.';



CREATE TABLE IF NOT EXISTS "public"."productos_bebidas" (
    "id" bigint NOT NULL,
    "nombre" "text" NOT NULL,
    "categoria" "text" DEFAULT 'bebida'::"text" NOT NULL,
    "tipo_bebida" "text" NOT NULL,
    "sabor" "text",
    "presentacion" "text",
    "precio" numeric(10,2) DEFAULT 0 NOT NULL,
    "codigo_barras" "text",
    "imagen_url" "text",
    "activo" boolean DEFAULT true NOT NULL,
    "fecha_creacion" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fecha_actualizacion" timestamp with time zone DEFAULT "now"() NOT NULL,
    "descripcion" "text",
    "orden" smallint
);


ALTER TABLE "public"."productos_bebidas" OWNER TO "postgres";


COMMENT ON TABLE "public"."productos_bebidas" IS 'Catálogo de bebidas (refrescos, aguas, jugos, etc) - migrado desde hoja Sheets productos_bebidas';



COMMENT ON COLUMN "public"."productos_bebidas"."tipo_bebida" IS 'Refresco, Agua, Jugo, Energizante, Cerveza, Otro';



COMMENT ON COLUMN "public"."productos_bebidas"."activo" IS 'Si false, aparece en el catálogo como AGOTADO';



CREATE SEQUENCE IF NOT EXISTS "public"."productos_bebidas_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."productos_bebidas_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."productos_bebidas_id_seq" OWNED BY "public"."productos_bebidas"."id";



CREATE SEQUENCE IF NOT EXISTS "public"."productos_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."productos_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."productos_id_seq" OWNED BY "public"."productos"."id";



CREATE TABLE IF NOT EXISTS "public"."prospectos" (
    "id" bigint NOT NULL,
    "nombre_negocio" "text" NOT NULL,
    "tipo_negocio" "text",
    "contacto_nombre" "text",
    "contacto_telefono" "text",
    "email" "text",
    "direccion" "text",
    "colonia" "text",
    "codigo_postal" "text",
    "municipio" "text",
    "estado" "text",
    "coordenadas" "text",
    "latitud" numeric(10,7),
    "longitud" numeric(10,7),
    "distancia_metros" numeric(12,2),
    "score" integer DEFAULT 0,
    "estatus" "text" DEFAULT 'pendiente'::"text" NOT NULL,
    "notas" "text",
    "id_vendedor" bigint,
    "nombre_vendedor" "text",
    "fecha_visita" timestamp with time zone,
    "num_visitas" integer DEFAULT 0 NOT NULL,
    "id_cliente_convertido" bigint,
    "fecha_descarte" timestamp with time zone,
    "motivo_descarte" "text",
    "fecha_creacion" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fecha_actualizacion" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ref" "text",
    "tipo_cliente" "text",
    "calle" "text",
    "origen" "text",
    "id_orden_origen" bigint,
    "consecutivo_origen" "text"
);


ALTER TABLE "public"."prospectos" OWNER TO "postgres";


COMMENT ON TABLE "public"."prospectos" IS 'Prospección comercial: bases de datos compradas, leads de ruta, etc.';



COMMENT ON COLUMN "public"."prospectos"."distancia_metros" IS 'Distancia desde la planta (calculada al insertar)';



COMMENT ON COLUMN "public"."prospectos"."score" IS 'Score de calidad 0-100 (calculado en frontend o admin)';



COMMENT ON COLUMN "public"."prospectos"."ref" IS 'Referencia externa del origen (ID de la base de datos comprada o sistema legacy)';



COMMENT ON COLUMN "public"."prospectos"."tipo_cliente" IS 'Clasificación B2B sugerida: BRONCE, PLATA, ORO';



COMMENT ON COLUMN "public"."prospectos"."calle" IS 'Solo el nombre de la calle (separado del número)';



CREATE SEQUENCE IF NOT EXISTS "public"."prospectos_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."prospectos_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."prospectos_id_seq" OWNED BY "public"."prospectos"."id";



CREATE OR REPLACE VIEW "public"."saldo_caja_actual" AS
SELECT
    NULL::bigint AS "id_punto",
    NULL::"text" AS "codigo",
    NULL::"text" AS "nombre",
    NULL::"text" AS "tipo",
    NULL::numeric(12,2) AS "fondo_minimo",
    NULL::numeric(12,2) AS "saldo_actual",
    NULL::numeric(12,2) AS "variacion_hoy",
    NULL::bigint AS "movimientos_hoy",
    NULL::"text" AS "estatus_dia_actual",
    NULL::bigint AS "id_caja_dia_actual";


ALTER VIEW "public"."saldo_caja_actual" OWNER TO "postgres";


COMMENT ON VIEW "public"."saldo_caja_actual" IS 'Saldo total de cada punto de caja + actividad del día';



CREATE SEQUENCE IF NOT EXISTS "public"."seq_consecutivo_pedido"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."seq_consecutivo_pedido" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stock_terminado" (
    "id" bigint NOT NULL,
    "id_lote" "text" NOT NULL,
    "sabor" "text" NOT NULL,
    "presentacion" "text" NOT NULL,
    "piezas" integer DEFAULT 0 NOT NULL,
    "gramos_unitarios" integer NOT NULL,
    "fecha" "date" DEFAULT CURRENT_DATE NOT NULL,
    "registrado_por" "text",
    "fecha_creacion" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."stock_terminado" OWNER TO "postgres";


ALTER TABLE "public"."stock_terminado" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."stock_terminado_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."uso_insumos" (
    "id" bigint NOT NULL,
    "id_lote" bigint,
    "id_insumo" bigint,
    "nombre_insumo" "text" NOT NULL,
    "cantidad" numeric(12,3) NOT NULL,
    "unidad" "text",
    "costo_unitario" numeric(10,2),
    "costo_total" numeric(12,2),
    "fecha" timestamp with time zone DEFAULT "now"() NOT NULL,
    "registrado_por" "text"
);


ALTER TABLE "public"."uso_insumos" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."uso_insumos_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."uso_insumos_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."uso_insumos_id_seq" OWNED BY "public"."uso_insumos"."id";



CREATE TABLE IF NOT EXISTS "public"."vendedores" (
    "id" bigint NOT NULL,
    "nombre" "text" NOT NULL,
    "telefono" "text",
    "email" "text",
    "rol" "text" DEFAULT 'Vendedor'::"text" NOT NULL,
    "activo" boolean DEFAULT true NOT NULL,
    "fecha_alta" "date" DEFAULT CURRENT_DATE,
    "pin_hash" "text",
    "direccion_punto_venta" "text",
    "cp_punto_venta" "text",
    "secciones" "text"[],
    "fecha_actualizacion" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."vendedores" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."vendedores_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."vendedores_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."vendedores_id_seq" OWNED BY "public"."vendedores"."id";



CREATE OR REPLACE VIEW "public"."vendedores_publico" AS
 SELECT "id",
    "nombre",
    "telefono",
    "email",
    "rol",
    "activo",
    "fecha_alta",
    "direccion_punto_venta",
    "cp_punto_venta",
    "secciones",
    "fecha_actualizacion"
   FROM "public"."vendedores";


ALTER VIEW "public"."vendedores_publico" OWNER TO "postgres";


COMMENT ON VIEW "public"."vendedores_publico" IS 'Vista pública de vendedores sin exponer pin_hash. Usar esta en lugar de la tabla directa.';



CREATE OR REPLACE VIEW "public"."vista_inventario" AS
 SELECT "sabor",
    ("sum"("kilos_producidos"))::numeric(10,2) AS "kilos_producidos_total",
    ("sum"("kilos_vendidos"))::numeric(10,2) AS "kilos_vendidos_total",
    ("sum"("kilos_disponibles"))::numeric(10,2) AS "kilos_disponibles",
    "max"("fecha_produccion") AS "ultima_produccion",
    "min"("fecha_siguiente") FILTER (WHERE ("fecha_siguiente" > CURRENT_DATE)) AS "proxima_produccion",
    ("sum"("kilos_disponibles") < (1)::numeric) AS "stock_bajo"
   FROM "public"."produccion_diaria"
  WHERE ("activo" = true)
  GROUP BY "sabor";


ALTER VIEW "public"."vista_inventario" OWNER TO "postgres";


COMMENT ON VIEW "public"."vista_inventario" IS 'Inventario actual por sabor en kilos. Agregado de produccion_diaria.';



CREATE TABLE IF NOT EXISTS "public"."zonas_vendedor" (
    "id" bigint NOT NULL,
    "id_vendedor" bigint NOT NULL,
    "tipo_ruta" "text" DEFAULT 'mixta'::"text",
    "cp_inicio" "text",
    "cp_fin" "text",
    "colonia" "text",
    "dia_semana" integer,
    "prioridad" integer DEFAULT 0,
    "descripcion" "text",
    "activo" boolean DEFAULT true NOT NULL,
    "fecha_creacion" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."zonas_vendedor" OWNER TO "postgres";


COMMENT ON TABLE "public"."zonas_vendedor" IS 'Asignación de zonas/rutas a vendedores. Hoy vacía: cliente busca por nombre. Futuro: rutas preventa/reparto por día.';



CREATE SEQUENCE IF NOT EXISTS "public"."zonas_vendedor_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."zonas_vendedor_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."zonas_vendedor_id_seq" OWNED BY "public"."zonas_vendedor"."id";



ALTER TABLE ONLY "public"."caja_dias" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."caja_dias_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."caja_movimientos" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."caja_movimientos_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."caja_puntos" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."caja_puntos_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."canjes_historial" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."canjes_historial_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."clientes" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."clientes_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."cuotas_vendedor" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."cuotas_vendedor_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."cupones" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."cupones_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."cupones_uso" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."cupones_uso_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."gastos" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."gastos_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."gastos_insumos" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."gastos_insumos_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."insumos" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."insumos_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."inventario_fisico" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."inventario_fisico_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."jornadas" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."jornadas_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."lealtad_movimientos" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."lealtad_movimientos_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."lotes_produccion" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."lotes_produccion_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."ordenes" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."ordenes_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."ordenes_detalle" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."ordenes_detalle_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."premios" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."premios_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."produccion_diaria" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."produccion_diaria_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."productos" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."productos_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."productos_bebidas" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."productos_bebidas_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."prospectos" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."prospectos_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."uso_insumos" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."uso_insumos_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."vendedores" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."vendedores_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."zonas_vendedor" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."zonas_vendedor_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."app_config"
    ADD CONSTRAINT "app_config_pkey" PRIMARY KEY ("clave");



ALTER TABLE ONLY "public"."caja_dias"
    ADD CONSTRAINT "caja_dias_id_punto_fecha_key" UNIQUE ("id_punto", "fecha");



ALTER TABLE ONLY "public"."caja_dias"
    ADD CONSTRAINT "caja_dias_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."caja_movimientos"
    ADD CONSTRAINT "caja_movimientos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."caja_puntos"
    ADD CONSTRAINT "caja_puntos_codigo_key" UNIQUE ("codigo");



ALTER TABLE ONLY "public"."caja_puntos"
    ADD CONSTRAINT "caja_puntos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."canjes_historial"
    ADD CONSTRAINT "canjes_historial_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clientes"
    ADD CONSTRAINT "clientes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clientes"
    ADD CONSTRAINT "clientes_telefono_key" UNIQUE ("telefono");



ALTER TABLE ONLY "public"."config_produccion"
    ADD CONSTRAINT "config_produccion_pkey" PRIMARY KEY ("clave");



ALTER TABLE ONLY "public"."config_secciones"
    ADD CONSTRAINT "config_secciones_pkey" PRIMARY KEY ("rol");



ALTER TABLE ONLY "public"."cuotas_vendedor"
    ADD CONSTRAINT "cuotas_vendedor_id_vendedor_mes_anio_key" UNIQUE ("id_vendedor", "mes", "anio");



ALTER TABLE ONLY "public"."cuotas_vendedor"
    ADD CONSTRAINT "cuotas_vendedor_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cupones"
    ADD CONSTRAINT "cupones_codigo_key" UNIQUE ("codigo");



ALTER TABLE ONLY "public"."cupones"
    ADD CONSTRAINT "cupones_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cupones_uso"
    ADD CONSTRAINT "cupones_uso_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."encuestas"
    ADD CONSTRAINT "encuestas_id_orden_key" UNIQUE ("id_orden");



ALTER TABLE ONLY "public"."encuestas"
    ADD CONSTRAINT "encuestas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."eventos_navegacion"
    ADD CONSTRAINT "eventos_navegacion_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."gastos_insumos"
    ADD CONSTRAINT "gastos_insumos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."gastos"
    ADD CONSTRAINT "gastos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."insumos"
    ADD CONSTRAINT "insumos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventario_fisico"
    ADD CONSTRAINT "inventario_fisico_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."jornadas"
    ADD CONSTRAINT "jornadas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lealtad_movimientos"
    ADD CONSTRAINT "lealtad_movimientos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lotes_produccion"
    ADD CONSTRAINT "lotes_produccion_id_lote_key" UNIQUE ("id_lote");



ALTER TABLE ONLY "public"."lotes_produccion"
    ADD CONSTRAINT "lotes_produccion_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ordenes"
    ADD CONSTRAINT "ordenes_consecutivo_key" UNIQUE ("consecutivo");



ALTER TABLE ONLY "public"."ordenes_detalle"
    ADD CONSTRAINT "ordenes_detalle_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ordenes"
    ADD CONSTRAINT "ordenes_idempotency_key_key" UNIQUE ("idempotency_key");



ALTER TABLE ONLY "public"."ordenes"
    ADD CONSTRAINT "ordenes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."otp_codigos"
    ADD CONSTRAINT "otp_codigos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."premios"
    ADD CONSTRAINT "premios_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."produccion_diaria"
    ADD CONSTRAINT "produccion_diaria_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."productos_bebidas"
    ADD CONSTRAINT "productos_bebidas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."productos"
    ADD CONSTRAINT "productos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."prospectos"
    ADD CONSTRAINT "prospectos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stock_terminado"
    ADD CONSTRAINT "stock_terminado_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."uso_insumos"
    ADD CONSTRAINT "uso_insumos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vendedores"
    ADD CONSTRAINT "vendedores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."zonas_vendedor"
    ADD CONSTRAINT "zonas_vendedor_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_bebidas_activo" ON "public"."productos_bebidas" USING "btree" ("activo");



CREATE INDEX "idx_bebidas_codigo" ON "public"."productos_bebidas" USING "btree" ("codigo_barras") WHERE ("codigo_barras" IS NOT NULL);



CREATE INDEX "idx_bebidas_tipo" ON "public"."productos_bebidas" USING "btree" ("tipo_bebida");



CREATE INDEX "idx_caja_dias_estatus" ON "public"."caja_dias" USING "btree" ("estatus");



CREATE INDEX "idx_caja_dias_fecha" ON "public"."caja_dias" USING "btree" ("fecha" DESC);



CREATE INDEX "idx_caja_dias_punto" ON "public"."caja_dias" USING "btree" ("id_punto", "fecha" DESC);



CREATE INDEX "idx_caja_mov_dia" ON "public"."caja_movimientos" USING "btree" ("id_caja_dia");



CREATE INDEX "idx_caja_mov_fecha" ON "public"."caja_movimientos" USING "btree" ("fecha" DESC);



CREATE INDEX "idx_caja_mov_gasto" ON "public"."caja_movimientos" USING "btree" ("id_gasto") WHERE ("id_gasto" IS NOT NULL);



CREATE INDEX "idx_caja_mov_orden" ON "public"."caja_movimientos" USING "btree" ("id_orden") WHERE ("id_orden" IS NOT NULL);



CREATE INDEX "idx_caja_mov_punto" ON "public"."caja_movimientos" USING "btree" ("id_punto", "fecha" DESC);



CREATE INDEX "idx_caja_mov_tipo" ON "public"."caja_movimientos" USING "btree" ("tipo");



CREATE INDEX "idx_caja_puntos_vendedor" ON "public"."caja_puntos" USING "btree" ("id_vendedor") WHERE ("id_vendedor" IS NOT NULL);



CREATE INDEX "idx_canjes_hist_cliente" ON "public"."canjes_historial" USING "btree" ("id_cliente");



CREATE INDEX "idx_clientes_b2b" ON "public"."clientes" USING "btree" ("aprobado_b2b") WHERE ("tipo_id" = ANY (ARRAY[2, 3]));



CREATE INDEX "idx_clientes_telefono" ON "public"."clientes" USING "btree" ("telefono");



CREATE INDEX "idx_clientes_tipo" ON "public"."clientes" USING "btree" ("tipo_id");



CREATE INDEX "idx_clientes_vendedor" ON "public"."clientes" USING "btree" ("id_vendedor");



CREATE INDEX "idx_cuotas_vendedor" ON "public"."cuotas_vendedor" USING "btree" ("id_vendedor", "anio" DESC, "mes" DESC);



CREATE INDEX "idx_cup_uso_cliente" ON "public"."cupones_uso" USING "btree" ("id_cliente");



CREATE INDEX "idx_cup_uso_codigo" ON "public"."cupones_uso" USING "btree" ("codigo");



CREATE INDEX "idx_cup_uso_telefono" ON "public"."cupones_uso" USING "btree" ("telefono");



CREATE INDEX "idx_cupones_codigo" ON "public"."cupones" USING "btree" ("codigo") WHERE ("activo" = true);



CREATE INDEX "idx_cupones_vigencia" ON "public"."cupones" USING "btree" ("vigencia_fin") WHERE ("activo" = true);



CREATE INDEX "idx_detalle_orden" ON "public"."ordenes_detalle" USING "btree" ("id_orden");



CREATE INDEX "idx_detalle_producto" ON "public"."ordenes_detalle" USING "btree" ("id_producto");



CREATE INDEX "idx_eventos_cliente" ON "public"."eventos_navegacion" USING "btree" ("id_cliente");



CREATE INDEX "idx_eventos_evento" ON "public"."eventos_navegacion" USING "btree" ("evento");



CREATE INDEX "idx_eventos_fecha" ON "public"."eventos_navegacion" USING "btree" ("creado_en");



CREATE INDEX "idx_eventos_session" ON "public"."eventos_navegacion" USING "btree" ("session_id");



CREATE INDEX "idx_gas_ins_gasto" ON "public"."gastos_insumos" USING "btree" ("id_gasto");



CREATE INDEX "idx_gastos_categoria" ON "public"."gastos" USING "btree" ("categoria");



CREATE INDEX "idx_gastos_estatus" ON "public"."gastos" USING "btree" ("estatus");



CREATE INDEX "idx_gastos_fecha" ON "public"."gastos" USING "btree" ("fecha" DESC);



CREATE INDEX "idx_gastos_vendedor" ON "public"."gastos" USING "btree" ("id_vendedor");



CREATE INDEX "idx_insumos_activo" ON "public"."insumos" USING "btree" ("activo");



CREATE INDEX "idx_inv_fisico_fecha" ON "public"."inventario_fisico" USING "btree" ("fecha" DESC);



CREATE INDEX "idx_jornadas_estatus" ON "public"."jornadas" USING "btree" ("estatus") WHERE ("estatus" = 'abierta'::"text");



CREATE INDEX "idx_jornadas_fecha" ON "public"."jornadas" USING "btree" ("fecha" DESC);



CREATE INDEX "idx_jornadas_vendedor" ON "public"."jornadas" USING "btree" ("id_vendedor");



CREATE INDEX "idx_lealtad_mov_cliente" ON "public"."lealtad_movimientos" USING "btree" ("id_cliente");



CREATE INDEX "idx_lealtad_mov_fecha" ON "public"."lealtad_movimientos" USING "btree" ("fecha" DESC);



CREATE INDEX "idx_lealtad_mov_orden" ON "public"."lealtad_movimientos" USING "btree" ("id_orden") WHERE ("id_orden" IS NOT NULL);



CREATE INDEX "idx_lealtad_mov_tipo" ON "public"."lealtad_movimientos" USING "btree" ("tipo");



CREATE INDEX "idx_lotes_estatus" ON "public"."lotes_produccion" USING "btree" ("estatus");



CREATE INDEX "idx_lotes_fecha" ON "public"."lotes_produccion" USING "btree" ("fecha" DESC);



CREATE INDEX "idx_ordenes_canal" ON "public"."ordenes" USING "btree" ("canal");



CREATE INDEX "idx_ordenes_cliente" ON "public"."ordenes" USING "btree" ("id_cliente");



CREATE INDEX "idx_ordenes_consecutivo" ON "public"."ordenes" USING "btree" ("consecutivo");



CREATE INDEX "idx_ordenes_cupon" ON "public"."ordenes" USING "btree" ("cupon_codigo") WHERE ("cupon_codigo" IS NOT NULL);



CREATE INDEX "idx_ordenes_estado_pago" ON "public"."ordenes" USING "btree" ("estado_pago");



CREATE INDEX "idx_ordenes_estatus" ON "public"."ordenes" USING "btree" ("estatus_pedido");



CREATE INDEX "idx_ordenes_estatus_caja" ON "public"."ordenes" USING "btree" ("estatus_caja") WHERE (("estatus_caja" IS NOT NULL) AND ("estatus_caja" <> 'confirmado'::"text"));



CREATE INDEX "idx_ordenes_fecha" ON "public"."ordenes" USING "btree" ("fecha_orden" DESC);



CREATE INDEX "idx_ordenes_recordatorio_pago" ON "public"."ordenes" USING "btree" ("estatus_pago", "estatus_pedido", "fecha_orden");



CREATE INDEX "idx_ordenes_stripe_session" ON "public"."ordenes" USING "btree" ("stripe_session_id");



CREATE INDEX "idx_ordenes_vendedor" ON "public"."ordenes" USING "btree" ("id_vendedor");



CREATE INDEX "idx_ordenes_vendedor_caja" ON "public"."ordenes" USING "btree" ("id_vendedor", "estatus_caja") WHERE ("estatus_caja" = ANY (ARRAY['pendiente_entrega'::"text", 'pendiente_confirmacion'::"text"]));



CREATE INDEX "idx_otp_creado" ON "public"."otp_codigos" USING "btree" ("creado");



CREATE INDEX "idx_otp_tel" ON "public"."otp_codigos" USING "btree" ("telefono", "usado");



CREATE INDEX "idx_prod_fecha" ON "public"."produccion_diaria" USING "btree" ("fecha_produccion" DESC);



CREATE INDEX "idx_prod_lote" ON "public"."produccion_diaria" USING "btree" ("id_lote");



CREATE INDEX "idx_prod_sabor" ON "public"."produccion_diaria" USING "btree" ("sabor");



CREATE INDEX "idx_productos_activo" ON "public"."productos" USING "btree" ("activo");



CREATE INDEX "idx_productos_sabor" ON "public"."productos" USING "btree" ("sabor");



CREATE INDEX "idx_productos_tipo_venta" ON "public"."productos" USING "btree" ("tipo_venta");



CREATE INDEX "idx_prospectos_cp" ON "public"."prospectos" USING "btree" ("codigo_postal");



CREATE INDEX "idx_prospectos_estatus" ON "public"."prospectos" USING "btree" ("estatus");



CREATE INDEX "idx_prospectos_ref" ON "public"."prospectos" USING "btree" ("ref");



CREATE INDEX "idx_prospectos_score" ON "public"."prospectos" USING "btree" ("score" DESC);



CREATE INDEX "idx_prospectos_tipo_cliente" ON "public"."prospectos" USING "btree" ("tipo_cliente");



CREATE INDEX "idx_prospectos_vendedor" ON "public"."prospectos" USING "btree" ("id_vendedor");



CREATE INDEX "idx_stock_terminado_lote" ON "public"."stock_terminado" USING "btree" ("id_lote");



CREATE INDEX "idx_uso_insumos_fecha" ON "public"."uso_insumos" USING "btree" ("fecha" DESC);



CREATE INDEX "idx_uso_insumos_lote" ON "public"."uso_insumos" USING "btree" ("id_lote");



CREATE INDEX "idx_vendedores_activo" ON "public"."vendedores" USING "btree" ("activo") WHERE ("activo" = true);



CREATE INDEX "idx_vendedores_nombre_lower" ON "public"."vendedores" USING "btree" ("lower"("nombre"));



CREATE INDEX "idx_vendedores_telefono" ON "public"."vendedores" USING "btree" ("telefono") WHERE ("telefono" IS NOT NULL);



CREATE INDEX "idx_zonas_cp" ON "public"."zonas_vendedor" USING "btree" ("cp_inicio", "cp_fin") WHERE ("activo" = true);



CREATE INDEX "idx_zonas_vendedor" ON "public"."zonas_vendedor" USING "btree" ("id_vendedor") WHERE ("activo" = true);



CREATE OR REPLACE VIEW "public"."saldo_caja_actual" AS
 SELECT "p"."id" AS "id_punto",
    "p"."codigo",
    "p"."nombre",
    "p"."tipo",
    "p"."fondo_minimo",
    (COALESCE("sum"("m"."monto"), (0)::numeric))::numeric(12,2) AS "saldo_actual",
    (COALESCE("sum"("m"."monto") FILTER (WHERE (("m"."fecha")::"date" = CURRENT_DATE)), (0)::numeric))::numeric(12,2) AS "variacion_hoy",
    "count"("m"."id") FILTER (WHERE (("m"."fecha")::"date" = CURRENT_DATE)) AS "movimientos_hoy",
    ( SELECT "caja_dias"."estatus"
           FROM "public"."caja_dias"
          WHERE (("caja_dias"."id_punto" = "p"."id") AND ("caja_dias"."fecha" = CURRENT_DATE))
         LIMIT 1) AS "estatus_dia_actual",
    ( SELECT "caja_dias"."id"
           FROM "public"."caja_dias"
          WHERE (("caja_dias"."id_punto" = "p"."id") AND ("caja_dias"."fecha" = CURRENT_DATE))
         LIMIT 1) AS "id_caja_dia_actual"
   FROM ("public"."caja_puntos" "p"
     LEFT JOIN "public"."caja_movimientos" "m" ON (("m"."id_punto" = "p"."id")))
  WHERE ("p"."activo" = true)
  GROUP BY "p"."id";



CREATE OR REPLACE TRIGGER "trg_bebidas_actualizacion" BEFORE UPDATE ON "public"."productos_bebidas" FOR EACH ROW EXECUTE FUNCTION "public"."update_fecha_actualizacion"();



CREATE OR REPLACE TRIGGER "trg_caja_confirmar_pedido" AFTER INSERT OR UPDATE OF "estatus_caja" ON "public"."ordenes" FOR EACH ROW EXECUTE FUNCTION "public"."caja_generar_movimiento_al_confirmar"();



CREATE OR REPLACE TRIGGER "trg_caja_dias_actualizacion" BEFORE UPDATE ON "public"."caja_dias" FOR EACH ROW EXECUTE FUNCTION "public"."update_fecha_actualizacion"();



CREATE OR REPLACE TRIGGER "trg_caja_mov_gasto" AFTER INSERT OR UPDATE ON "public"."gastos" FOR EACH ROW EXECUTE FUNCTION "public"."caja_movimiento_por_gasto"();



CREATE OR REPLACE TRIGGER "trg_caja_mov_pedido" BEFORE INSERT OR UPDATE ON "public"."ordenes" FOR EACH ROW EXECUTE FUNCTION "public"."caja_movimiento_por_pedido"();



CREATE OR REPLACE TRIGGER "trg_clientes_actualizacion" BEFORE UPDATE ON "public"."clientes" FOR EACH ROW EXECUTE FUNCTION "public"."update_fecha_actualizacion"();



CREATE OR REPLACE TRIGGER "trg_cupones_actualizacion" BEFORE UPDATE ON "public"."cupones" FOR EACH ROW EXECUTE FUNCTION "public"."update_fecha_actualizacion"();



CREATE OR REPLACE TRIGGER "trg_descontar_inventario" AFTER INSERT ON "public"."ordenes_detalle" FOR EACH ROW EXECUTE FUNCTION "public"."descontar_inventario_pedido"();



CREATE OR REPLACE TRIGGER "trg_detalle_reconciliar" AFTER INSERT ON "public"."ordenes_detalle" FOR EACH ROW EXECUTE FUNCTION "public"."trg_reconciliar_lote"();



CREATE OR REPLACE TRIGGER "trg_gastos_actualizacion" BEFORE UPDATE ON "public"."gastos" FOR EACH ROW EXECUTE FUNCTION "public"."update_fecha_actualizacion"();



CREATE OR REPLACE TRIGGER "trg_jornadas_actualizacion" BEFORE UPDATE ON "public"."jornadas" FOR EACH ROW EXECUTE FUNCTION "public"."update_fecha_actualizacion"();



CREATE OR REPLACE TRIGGER "trg_lotes_actualizacion" BEFORE UPDATE ON "public"."lotes_produccion" FOR EACH ROW EXECUTE FUNCTION "public"."update_fecha_actualizacion"();



CREATE OR REPLACE TRIGGER "trg_ordenes_actualizacion" BEFORE UPDATE ON "public"."ordenes" FOR EACH ROW EXECUTE FUNCTION "public"."update_fecha_actualizacion"();



CREATE OR REPLACE TRIGGER "trg_ordenes_reconciliar" AFTER UPDATE OF "estatus_pedido" ON "public"."ordenes" FOR EACH ROW EXECUTE FUNCTION "public"."trg_reconciliar_lote"();



CREATE OR REPLACE TRIGGER "trg_otorgar_puntos" AFTER INSERT OR UPDATE ON "public"."ordenes" FOR EACH ROW EXECUTE FUNCTION "public"."otorgar_puntos_al_confirmar"();



CREATE OR REPLACE TRIGGER "trg_prod_actualizacion" BEFORE UPDATE ON "public"."produccion_diaria" FOR EACH ROW EXECUTE FUNCTION "public"."update_fecha_actualizacion"();



CREATE OR REPLACE TRIGGER "trg_productos_actualizacion" BEFORE UPDATE ON "public"."productos" FOR EACH ROW EXECUTE FUNCTION "public"."update_fecha_actualizacion"();



CREATE OR REPLACE TRIGGER "trg_prospectos_actualizacion" BEFORE UPDATE ON "public"."prospectos" FOR EACH ROW EXECUTE FUNCTION "public"."update_fecha_actualizacion"();



ALTER TABLE ONLY "public"."caja_dias"
    ADD CONSTRAINT "caja_dias_id_punto_fkey" FOREIGN KEY ("id_punto") REFERENCES "public"."caja_puntos"("id");



ALTER TABLE ONLY "public"."caja_movimientos"
    ADD CONSTRAINT "caja_movimientos_id_caja_dia_fkey" FOREIGN KEY ("id_caja_dia") REFERENCES "public"."caja_dias"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."caja_movimientos"
    ADD CONSTRAINT "caja_movimientos_id_punto_destino_fkey" FOREIGN KEY ("id_punto_destino") REFERENCES "public"."caja_puntos"("id");



ALTER TABLE ONLY "public"."caja_movimientos"
    ADD CONSTRAINT "caja_movimientos_id_punto_fkey" FOREIGN KEY ("id_punto") REFERENCES "public"."caja_puntos"("id");



ALTER TABLE ONLY "public"."canjes_historial"
    ADD CONSTRAINT "canjes_historial_id_movimiento_fkey" FOREIGN KEY ("id_movimiento") REFERENCES "public"."lealtad_movimientos"("id");



ALTER TABLE ONLY "public"."canjes_historial"
    ADD CONSTRAINT "canjes_historial_id_premio_fkey" FOREIGN KEY ("id_premio") REFERENCES "public"."premios"("id");



ALTER TABLE ONLY "public"."cuotas_vendedor"
    ADD CONSTRAINT "cuotas_vendedor_id_vendedor_fkey" FOREIGN KEY ("id_vendedor") REFERENCES "public"."vendedores"("id");



ALTER TABLE ONLY "public"."cupones_uso"
    ADD CONSTRAINT "cupones_uso_id_cupon_fkey" FOREIGN KEY ("id_cupon") REFERENCES "public"."cupones"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."encuestas"
    ADD CONSTRAINT "encuestas_id_orden_fkey" FOREIGN KEY ("id_orden") REFERENCES "public"."ordenes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."gastos_insumos"
    ADD CONSTRAINT "gastos_insumos_id_gasto_fkey" FOREIGN KEY ("id_gasto") REFERENCES "public"."gastos"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ordenes_detalle"
    ADD CONSTRAINT "ordenes_detalle_id_orden_fkey" FOREIGN KEY ("id_orden") REFERENCES "public"."ordenes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."produccion_diaria"
    ADD CONSTRAINT "produccion_diaria_id_lote_fkey" FOREIGN KEY ("id_lote") REFERENCES "public"."lotes_produccion"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."uso_insumos"
    ADD CONSTRAINT "uso_insumos_id_insumo_fkey" FOREIGN KEY ("id_insumo") REFERENCES "public"."insumos"("id");



ALTER TABLE ONLY "public"."uso_insumos"
    ADD CONSTRAINT "uso_insumos_id_lote_fkey" FOREIGN KEY ("id_lote") REFERENCES "public"."lotes_produccion"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."zonas_vendedor"
    ADD CONSTRAINT "zonas_vendedor_id_vendedor_fkey" FOREIGN KEY ("id_vendedor") REFERENCES "public"."vendedores"("id");



CREATE POLICY "Autenticados leen todo" ON "public"."productos_bebidas" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Autenticados leen todo en productos" ON "public"."productos" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Autenticados leen todos los cupones" ON "public"."cupones" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Autenticados modifican cupones" ON "public"."cupones" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Autenticados modifican productos" ON "public"."productos" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Autenticados pueden modificar" ON "public"."productos_bebidas" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Bebidas activas son públicas para lectura" ON "public"."productos_bebidas" FOR SELECT TO "authenticated", "anon" USING (("activo" = true));



CREATE POLICY "Clientes escritura" ON "public"."clientes" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "Clientes lectura" ON "public"."clientes" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "Cupones activos lectura pública" ON "public"."cupones" FOR SELECT TO "authenticated", "anon" USING (("activo" = true));



CREATE POLICY "Cupones uso escritura" ON "public"."cupones_uso" FOR INSERT TO "authenticated", "anon" WITH CHECK (true);



CREATE POLICY "Cupones uso lectura" ON "public"."cupones_uso" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "Detalle escritura" ON "public"."ordenes_detalle" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "Detalle lectura" ON "public"."ordenes_detalle" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "Jornadas escritura" ON "public"."jornadas" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "Jornadas lectura" ON "public"."jornadas" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "Ordenes escritura" ON "public"."ordenes" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "Ordenes lectura" ON "public"."ordenes" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "Premios admin escribe" ON "public"."premios" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "Premios públicos" ON "public"."premios" FOR SELECT TO "authenticated", "anon" USING (("activo" = true));



CREATE POLICY "Productos activos son públicos para lectura" ON "public"."productos" FOR SELECT TO "authenticated", "anon" USING (("activo" = true));



CREATE POLICY "Prospectos escritura" ON "public"."prospectos" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "Prospectos lectura autenticados" ON "public"."prospectos" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "TEMPORAL anon escribe cupones" ON "public"."cupones" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "TEMPORAL anon escribe productos" ON "public"."productos" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "TEMPORAL anon puede escribir (quitar tras migración)" ON "public"."productos_bebidas" TO "anon" USING (true) WITH CHECK (true);



ALTER TABLE "public"."app_config" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."caja_dias" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "caja_dias_escritura" ON "public"."caja_dias" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "caja_dias_lectura" ON "public"."caja_dias" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "caja_mov_escritura" ON "public"."caja_movimientos" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "caja_mov_lectura" ON "public"."caja_movimientos" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."caja_movimientos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."caja_puntos" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "caja_puntos_escritura" ON "public"."caja_puntos" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "caja_puntos_lectura" ON "public"."caja_puntos" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "canjes_hist_escritura" ON "public"."canjes_historial" FOR INSERT TO "authenticated", "anon" WITH CHECK (true);



CREATE POLICY "canjes_hist_lectura" ON "public"."canjes_historial" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."canjes_historial" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."clientes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."config_produccion" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."config_secciones" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cp" ON "public"."config_produccion" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "cs" ON "public"."config_secciones" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "cuotas_v" ON "public"."cuotas_vendedor" TO "authenticated", "anon" USING (true) WITH CHECK (true);



ALTER TABLE "public"."cuotas_vendedor" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cupones" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cupones_uso" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."encuestas" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."eventos_navegacion" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "gas_ins_escritura" ON "public"."gastos_insumos" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "gas_ins_lectura" ON "public"."gastos_insumos" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."gastos" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "gastos_escritura" ON "public"."gastos" TO "authenticated", "anon" USING (true) WITH CHECK (true);



ALTER TABLE "public"."gastos_insumos" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "gastos_lectura" ON "public"."gastos" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."insumos" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "insumos_escritura" ON "public"."insumos" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "insumos_lectura" ON "public"."insumos" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "inv_fis_escritura" ON "public"."inventario_fisico" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "inv_fis_lectura" ON "public"."inventario_fisico" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."inventario_fisico" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."jornadas" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lealtad_mov_escritura" ON "public"."lealtad_movimientos" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "lealtad_mov_lectura" ON "public"."lealtad_movimientos" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."lealtad_movimientos" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lotes_escritura" ON "public"."lotes_produccion" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "lotes_lectura" ON "public"."lotes_produccion" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."lotes_produccion" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ordenes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ordenes_detalle" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."otp_codigos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."premios" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "prod_escritura" ON "public"."produccion_diaria" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "prod_lectura" ON "public"."produccion_diaria" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."produccion_diaria" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."productos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."productos_bebidas" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."prospectos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stock_terminado" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "stock_terminado_escritura" ON "public"."stock_terminado" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "stock_terminado_lectura" ON "public"."stock_terminado" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "uso_ins_escritura" ON "public"."uso_insumos" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "uso_ins_lectura" ON "public"."uso_insumos" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."uso_insumos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vendedores" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vendedores_escritura" ON "public"."vendedores" TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "vendedores_lectura" ON "public"."vendedores" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."zonas_vendedor" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "zv" ON "public"."zonas_vendedor" TO "authenticated", "anon" USING (true) WITH CHECK (true);





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






















































































































































GRANT ALL ON FUNCTION "public"."abrir_caja_dia"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."abrir_caja_dia"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."abrir_caja_dia"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."actualizar_estatus_pedido"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."actualizar_estatus_pedido"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."actualizar_estatus_pedido"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."actualizar_tipo_cliente"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."actualizar_tipo_cliente"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."actualizar_tipo_cliente"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."agregar_movimiento_lealtad"("p_id_cliente" bigint, "p_tipo" "text", "p_puntos" integer, "p_id_orden" bigint, "p_consecutivo" "text", "p_id_premio" bigint, "p_nombre_premio" "text", "p_monto_origen" numeric, "p_nota" "text", "p_actor" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."agregar_movimiento_lealtad"("p_id_cliente" bigint, "p_tipo" "text", "p_puntos" integer, "p_id_orden" bigint, "p_consecutivo" "text", "p_id_premio" bigint, "p_nombre_premio" "text", "p_monto_origen" numeric, "p_nota" "text", "p_actor" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."agregar_movimiento_lealtad"("p_id_cliente" bigint, "p_tipo" "text", "p_puntos" integer, "p_id_orden" bigint, "p_consecutivo" "text", "p_id_premio" bigint, "p_nombre_premio" "text", "p_monto_origen" numeric, "p_nota" "text", "p_actor" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."agregar_punto"("p_id_cliente" bigint, "p_nombre" "text", "p_telefono" "text", "p_puntos" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."agregar_punto"("p_id_cliente" bigint, "p_nombre" "text", "p_telefono" "text", "p_puntos" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."agregar_punto"("p_id_cliente" bigint, "p_nombre" "text", "p_telefono" "text", "p_puntos" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."aplicar_cupon"("p_codigo" "text", "p_id_cliente" bigint, "p_telefono" "text", "p_id_orden" "text", "p_monto_descuento" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."aplicar_cupon"("p_codigo" "text", "p_id_cliente" bigint, "p_telefono" "text", "p_id_orden" "text", "p_monto_descuento" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."aplicar_cupon"("p_codigo" "text", "p_id_cliente" bigint, "p_telefono" "text", "p_id_orden" "text", "p_monto_descuento" numeric) TO "service_role";



GRANT ALL ON FUNCTION "public"."aprobar_cliente_b2b"("p_id_cliente" bigint, "p_aprobar" boolean, "p_actor" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."aprobar_cliente_b2b"("p_id_cliente" bigint, "p_aprobar" boolean, "p_actor" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."aprobar_cliente_b2b"("p_id_cliente" bigint, "p_aprobar" boolean, "p_actor" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."aprobar_gasto"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."aprobar_gasto"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."aprobar_gasto"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."buscar_cliente_telefono"("p_telefono" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."buscar_cliente_telefono"("p_telefono" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."buscar_cliente_telefono"("p_telefono" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."buscar_clientes_ubicacion"("p_q" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."buscar_clientes_ubicacion"("p_q" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."buscar_clientes_ubicacion"("p_q" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."buscar_vendedor_por_telefono"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."buscar_vendedor_por_telefono"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."buscar_vendedor_por_telefono"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."buscar_vendedores"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."buscar_vendedores"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."buscar_vendedores"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."caja_generar_movimiento_al_confirmar"() TO "anon";
GRANT ALL ON FUNCTION "public"."caja_generar_movimiento_al_confirmar"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."caja_generar_movimiento_al_confirmar"() TO "service_role";



GRANT ALL ON FUNCTION "public"."caja_movimiento_por_gasto"() TO "anon";
GRANT ALL ON FUNCTION "public"."caja_movimiento_por_gasto"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."caja_movimiento_por_gasto"() TO "service_role";



GRANT ALL ON FUNCTION "public"."caja_movimiento_por_pedido"() TO "anon";
GRANT ALL ON FUNCTION "public"."caja_movimiento_por_pedido"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."caja_movimiento_por_pedido"() TO "service_role";



GRANT ALL ON FUNCTION "public"."cambiar_pin_vendedor"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."cambiar_pin_vendedor"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cambiar_pin_vendedor"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."canjear_premio"("p_id_cliente" bigint, "p_id_premio" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."canjear_premio"("p_id_cliente" bigint, "p_id_premio" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."canjear_premio"("p_id_cliente" bigint, "p_id_premio" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."canjear_premio"("p_id_cliente" bigint, "p_id_premio" bigint, "p_actor" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."canjear_premio"("p_id_cliente" bigint, "p_id_premio" bigint, "p_actor" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."canjear_premio"("p_id_cliente" bigint, "p_id_premio" bigint, "p_actor" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."cerrar_caja_dia"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."cerrar_caja_dia"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cerrar_caja_dia"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."confirmar_caja_pedido"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."confirmar_caja_pedido"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."confirmar_caja_pedido"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."convertir_prospecto_a_cliente"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."convertir_prospecto_a_cliente"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."convertir_prospecto_a_cliente"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."corregir_metodo_pago_pedido"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."corregir_metodo_pago_pedido"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."corregir_metodo_pago_pedido"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."crear_caja_vendedor"("p_id_vendedor" bigint, "p_nombre" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."crear_caja_vendedor"("p_id_vendedor" bigint, "p_nombre" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."crear_caja_vendedor"("p_id_vendedor" bigint, "p_nombre" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."crear_pedido"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."crear_pedido"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."crear_pedido"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."dashboard_resumen"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."dashboard_resumen"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dashboard_resumen"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."descontar_inventario_pedido"() TO "anon";
GRANT ALL ON FUNCTION "public"."descontar_inventario_pedido"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."descontar_inventario_pedido"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_reconciliar_pedido"("p_id_orden" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."fn_reconciliar_pedido"("p_id_orden" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_reconciliar_pedido"("p_id_orden" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_config_secciones"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."get_config_secciones"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_config_secciones"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_cuota_vendedor"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."get_cuota_vendedor"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_cuota_vendedor"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_estado_tienda"("p_telefono" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_estado_tienda"("p_telefono" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_estado_tienda"("p_telefono" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_lealtad_config"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_lealtad_config"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_lealtad_config"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_mayoreo_config"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_mayoreo_config"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_mayoreo_config"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_opt_in_promos"("p_telefono" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_opt_in_promos"("p_telefono" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_opt_in_promos"("p_telefono" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_secciones_usuario"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."get_secciones_usuario"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_secciones_usuario"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_tracking_pedido"("p_id_orden" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_tracking_pedido"("p_id_orden" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_tracking_pedido"("p_id_orden" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."guardar_encuesta"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."guardar_encuesta"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."guardar_encuesta"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."importar_prospectos_bulk"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."importar_prospectos_bulk"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."importar_prospectos_bulk"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."metricas_regalo_mes"("p_anio" integer, "p_mes" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."metricas_regalo_mes"("p_anio" integer, "p_mes" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."metricas_regalo_mes"("p_anio" integer, "p_mes" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."obtener_caja_dia"("p_fecha" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."obtener_caja_dia"("p_fecha" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."obtener_caja_dia"("p_fecha" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."obtener_cajas_vendedores"() TO "anon";
GRANT ALL ON FUNCTION "public"."obtener_cajas_vendedores"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."obtener_cajas_vendedores"() TO "service_role";



GRANT ALL ON FUNCTION "public"."obtener_cliente_con_stats"("p_telefono" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."obtener_cliente_con_stats"("p_telefono" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."obtener_cliente_con_stats"("p_telefono" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."obtener_encuesta_pendiente"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."obtener_encuesta_pendiente"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."obtener_encuesta_pendiente"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."obtener_encuestas_cliente"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."obtener_encuestas_cliente"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."obtener_encuestas_cliente"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."obtener_fecha_entrega"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."obtener_fecha_entrega"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."obtener_fecha_entrega"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."obtener_pendientes_caja"() TO "anon";
GRANT ALL ON FUNCTION "public"."obtener_pendientes_caja"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."obtener_pendientes_caja"() TO "service_role";



GRANT ALL ON FUNCTION "public"."obtener_vendedor_por_cp"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."obtener_vendedor_por_cp"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."obtener_vendedor_por_cp"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."obtener_vendedores"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."obtener_vendedores"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."obtener_vendedores"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."otorgar_puntos_al_confirmar"() TO "anon";
GRANT ALL ON FUNCTION "public"."otorgar_puntos_al_confirmar"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."otorgar_puntos_al_confirmar"() TO "service_role";



GRANT ALL ON FUNCTION "public"."reasignar_lote_pedido"("p_id_orden" bigint, "p_id_lote" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."reasignar_lote_pedido"("p_id_orden" bigint, "p_id_lote" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reasignar_lote_pedido"("p_id_orden" bigint, "p_id_lote" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."reasignar_vendedor_cliente"("p_id_cliente" bigint, "p_id_vendedor" bigint, "p_nombre_vendedor" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."reasignar_vendedor_cliente"("p_id_cliente" bigint, "p_id_vendedor" bigint, "p_nombre_vendedor" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reasignar_vendedor_cliente"("p_id_cliente" bigint, "p_id_vendedor" bigint, "p_nombre_vendedor" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."rechazar_gasto"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."rechazar_gasto"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."rechazar_gasto"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."registrar_entrega_vendedor"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."registrar_entrega_vendedor"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."registrar_entrega_vendedor"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."registrar_evento"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."registrar_evento"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."registrar_evento"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."registrar_lote"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."registrar_lote"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."registrar_lote"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."registrar_movimiento_caja"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."registrar_movimiento_caja"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."registrar_movimiento_caja"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."registrar_o_actualizar_cliente"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."registrar_o_actualizar_cliente"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."registrar_o_actualizar_cliente"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."registrar_produccion_sabor"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."registrar_produccion_sabor"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."registrar_produccion_sabor"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."registrar_prospecto_desde_interno"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."registrar_prospecto_desde_interno"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."registrar_prospecto_desde_interno"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."reporte_cobros"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."reporte_cobros"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reporte_cobros"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."resumen_gastos"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."resumen_gastos"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resumen_gastos"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_config_secciones"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."set_config_secciones"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_config_secciones"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_coordenadas_gps"("p_telefono" "text", "p_gps" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."set_coordenadas_gps"("p_telefono" "text", "p_gps" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_coordenadas_gps"("p_telefono" "text", "p_gps" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_cuota_vendedor"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."set_cuota_vendedor"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_cuota_vendedor"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_lealtad_config"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."set_lealtad_config"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_lealtad_config"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_mayoreo_config"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."set_mayoreo_config"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_mayoreo_config"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_opt_in_promos"("p_telefono" "text", "p_acepta" boolean, "p_origen" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."set_opt_in_promos"("p_telefono" "text", "p_acepta" boolean, "p_origen" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_opt_in_promos"("p_telefono" "text", "p_acepta" boolean, "p_origen" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_secciones_vendedor"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."set_secciones_vendedor"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_secciones_vendedor"("p_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_ubicacion_cliente"("p_telefono" "text", "p_coordenadas" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."set_ubicacion_cliente"("p_telefono" "text", "p_coordenadas" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_ubicacion_cliente"("p_telefono" "text", "p_coordenadas" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."siguiente_consecutivo"() TO "anon";
GRANT ALL ON FUNCTION "public"."siguiente_consecutivo"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."siguiente_consecutivo"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_reconciliar_lote"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_reconciliar_lote"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_reconciliar_lote"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_fecha_actualizacion"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_fecha_actualizacion"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_fecha_actualizacion"() TO "service_role";



GRANT ALL ON FUNCTION "public"."validar_cupon"("p_codigo" "text", "p_telefono" "text", "p_id_cliente" bigint, "p_total_compra" numeric, "p_segmento_cliente" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."validar_cupon"("p_codigo" "text", "p_telefono" "text", "p_id_cliente" bigint, "p_total_compra" numeric, "p_segmento_cliente" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."validar_cupon"("p_codigo" "text", "p_telefono" "text", "p_id_cliente" bigint, "p_total_compra" numeric, "p_segmento_cliente" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."validar_vendedor_pin"("p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."validar_vendedor_pin"("p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."validar_vendedor_pin"("p_data" "jsonb") TO "service_role";


















GRANT ALL ON TABLE "public"."app_config" TO "service_role";



GRANT ALL ON TABLE "public"."caja_dias" TO "anon";
GRANT ALL ON TABLE "public"."caja_dias" TO "authenticated";
GRANT ALL ON TABLE "public"."caja_dias" TO "service_role";



GRANT ALL ON SEQUENCE "public"."caja_dias_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."caja_dias_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."caja_dias_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."caja_movimientos" TO "anon";
GRANT ALL ON TABLE "public"."caja_movimientos" TO "authenticated";
GRANT ALL ON TABLE "public"."caja_movimientos" TO "service_role";



GRANT ALL ON SEQUENCE "public"."caja_movimientos_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."caja_movimientos_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."caja_movimientos_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."caja_puntos" TO "anon";
GRANT ALL ON TABLE "public"."caja_puntos" TO "authenticated";
GRANT ALL ON TABLE "public"."caja_puntos" TO "service_role";



GRANT ALL ON SEQUENCE "public"."caja_puntos_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."caja_puntos_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."caja_puntos_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."canjes_historial" TO "anon";
GRANT ALL ON TABLE "public"."canjes_historial" TO "authenticated";
GRANT ALL ON TABLE "public"."canjes_historial" TO "service_role";



GRANT ALL ON SEQUENCE "public"."canjes_historial_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."canjes_historial_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."canjes_historial_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."clientes" TO "anon";
GRANT ALL ON TABLE "public"."clientes" TO "authenticated";
GRANT ALL ON TABLE "public"."clientes" TO "service_role";



GRANT ALL ON SEQUENCE "public"."clientes_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."clientes_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."clientes_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."config_produccion" TO "anon";
GRANT ALL ON TABLE "public"."config_produccion" TO "authenticated";
GRANT ALL ON TABLE "public"."config_produccion" TO "service_role";



GRANT ALL ON TABLE "public"."config_secciones" TO "anon";
GRANT ALL ON TABLE "public"."config_secciones" TO "authenticated";
GRANT ALL ON TABLE "public"."config_secciones" TO "service_role";



GRANT ALL ON TABLE "public"."cuotas_vendedor" TO "anon";
GRANT ALL ON TABLE "public"."cuotas_vendedor" TO "authenticated";
GRANT ALL ON TABLE "public"."cuotas_vendedor" TO "service_role";



GRANT ALL ON SEQUENCE "public"."cuotas_vendedor_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."cuotas_vendedor_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."cuotas_vendedor_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."cupones" TO "anon";
GRANT ALL ON TABLE "public"."cupones" TO "authenticated";
GRANT ALL ON TABLE "public"."cupones" TO "service_role";



GRANT ALL ON SEQUENCE "public"."cupones_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."cupones_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."cupones_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."cupones_uso" TO "anon";
GRANT ALL ON TABLE "public"."cupones_uso" TO "authenticated";
GRANT ALL ON TABLE "public"."cupones_uso" TO "service_role";



GRANT ALL ON SEQUENCE "public"."cupones_uso_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."cupones_uso_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."cupones_uso_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."encuestas" TO "anon";
GRANT ALL ON TABLE "public"."encuestas" TO "authenticated";
GRANT ALL ON TABLE "public"."encuestas" TO "service_role";



GRANT ALL ON SEQUENCE "public"."encuestas_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."encuestas_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."encuestas_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."eventos_navegacion" TO "anon";
GRANT ALL ON TABLE "public"."eventos_navegacion" TO "authenticated";
GRANT ALL ON TABLE "public"."eventos_navegacion" TO "service_role";



GRANT ALL ON SEQUENCE "public"."eventos_navegacion_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."eventos_navegacion_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."eventos_navegacion_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."gastos" TO "anon";
GRANT ALL ON TABLE "public"."gastos" TO "authenticated";
GRANT ALL ON TABLE "public"."gastos" TO "service_role";



GRANT ALL ON SEQUENCE "public"."gastos_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."gastos_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."gastos_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."gastos_insumos" TO "anon";
GRANT ALL ON TABLE "public"."gastos_insumos" TO "authenticated";
GRANT ALL ON TABLE "public"."gastos_insumos" TO "service_role";



GRANT ALL ON SEQUENCE "public"."gastos_insumos_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."gastos_insumos_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."gastos_insumos_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."insumos" TO "anon";
GRANT ALL ON TABLE "public"."insumos" TO "authenticated";
GRANT ALL ON TABLE "public"."insumos" TO "service_role";



GRANT ALL ON SEQUENCE "public"."insumos_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."insumos_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."insumos_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."inventario_fisico" TO "anon";
GRANT ALL ON TABLE "public"."inventario_fisico" TO "authenticated";
GRANT ALL ON TABLE "public"."inventario_fisico" TO "service_role";



GRANT ALL ON SEQUENCE "public"."inventario_fisico_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."inventario_fisico_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."inventario_fisico_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."jornadas" TO "anon";
GRANT ALL ON TABLE "public"."jornadas" TO "authenticated";
GRANT ALL ON TABLE "public"."jornadas" TO "service_role";



GRANT ALL ON SEQUENCE "public"."jornadas_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."jornadas_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."jornadas_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lealtad_movimientos" TO "anon";
GRANT ALL ON TABLE "public"."lealtad_movimientos" TO "authenticated";
GRANT ALL ON TABLE "public"."lealtad_movimientos" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lealtad_movimientos_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lealtad_movimientos_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lealtad_movimientos_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lotes_produccion" TO "anon";
GRANT ALL ON TABLE "public"."lotes_produccion" TO "authenticated";
GRANT ALL ON TABLE "public"."lotes_produccion" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lotes_produccion_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lotes_produccion_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lotes_produccion_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."ordenes" TO "anon";
GRANT ALL ON TABLE "public"."ordenes" TO "authenticated";
GRANT ALL ON TABLE "public"."ordenes" TO "service_role";



GRANT ALL ON TABLE "public"."ordenes_detalle" TO "anon";
GRANT ALL ON TABLE "public"."ordenes_detalle" TO "authenticated";
GRANT ALL ON TABLE "public"."ordenes_detalle" TO "service_role";



GRANT ALL ON SEQUENCE "public"."ordenes_detalle_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."ordenes_detalle_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."ordenes_detalle_id_seq" TO "service_role";



GRANT ALL ON SEQUENCE "public"."ordenes_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."ordenes_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."ordenes_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."otp_codigos" TO "service_role";



GRANT ALL ON SEQUENCE "public"."otp_codigos_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."otp_codigos_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."otp_codigos_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."saldos_lealtad" TO "anon";
GRANT ALL ON TABLE "public"."saldos_lealtad" TO "authenticated";
GRANT ALL ON TABLE "public"."saldos_lealtad" TO "service_role";



GRANT ALL ON TABLE "public"."pasivo_lealtad" TO "anon";
GRANT ALL ON TABLE "public"."pasivo_lealtad" TO "authenticated";
GRANT ALL ON TABLE "public"."pasivo_lealtad" TO "service_role";



GRANT ALL ON TABLE "public"."premios" TO "anon";
GRANT ALL ON TABLE "public"."premios" TO "authenticated";
GRANT ALL ON TABLE "public"."premios" TO "service_role";



GRANT ALL ON SEQUENCE "public"."premios_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."premios_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."premios_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."produccion_diaria" TO "anon";
GRANT ALL ON TABLE "public"."produccion_diaria" TO "authenticated";
GRANT ALL ON TABLE "public"."produccion_diaria" TO "service_role";



GRANT ALL ON SEQUENCE "public"."produccion_diaria_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."produccion_diaria_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."produccion_diaria_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."productos" TO "anon";
GRANT ALL ON TABLE "public"."productos" TO "authenticated";
GRANT ALL ON TABLE "public"."productos" TO "service_role";



GRANT ALL ON TABLE "public"."productos_bebidas" TO "anon";
GRANT ALL ON TABLE "public"."productos_bebidas" TO "authenticated";
GRANT ALL ON TABLE "public"."productos_bebidas" TO "service_role";



GRANT ALL ON SEQUENCE "public"."productos_bebidas_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."productos_bebidas_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."productos_bebidas_id_seq" TO "service_role";



GRANT ALL ON SEQUENCE "public"."productos_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."productos_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."productos_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."prospectos" TO "anon";
GRANT ALL ON TABLE "public"."prospectos" TO "authenticated";
GRANT ALL ON TABLE "public"."prospectos" TO "service_role";



GRANT ALL ON SEQUENCE "public"."prospectos_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."prospectos_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."prospectos_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."saldo_caja_actual" TO "anon";
GRANT ALL ON TABLE "public"."saldo_caja_actual" TO "authenticated";
GRANT ALL ON TABLE "public"."saldo_caja_actual" TO "service_role";



GRANT ALL ON SEQUENCE "public"."seq_consecutivo_pedido" TO "anon";
GRANT ALL ON SEQUENCE "public"."seq_consecutivo_pedido" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."seq_consecutivo_pedido" TO "service_role";



GRANT ALL ON TABLE "public"."stock_terminado" TO "anon";
GRANT ALL ON TABLE "public"."stock_terminado" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_terminado" TO "service_role";



GRANT ALL ON SEQUENCE "public"."stock_terminado_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."stock_terminado_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."stock_terminado_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."uso_insumos" TO "anon";
GRANT ALL ON TABLE "public"."uso_insumos" TO "authenticated";
GRANT ALL ON TABLE "public"."uso_insumos" TO "service_role";



GRANT ALL ON SEQUENCE "public"."uso_insumos_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."uso_insumos_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."uso_insumos_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."vendedores" TO "anon";
GRANT ALL ON TABLE "public"."vendedores" TO "authenticated";
GRANT ALL ON TABLE "public"."vendedores" TO "service_role";



GRANT ALL ON SEQUENCE "public"."vendedores_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."vendedores_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."vendedores_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."vendedores_publico" TO "anon";
GRANT ALL ON TABLE "public"."vendedores_publico" TO "authenticated";
GRANT ALL ON TABLE "public"."vendedores_publico" TO "service_role";



GRANT ALL ON TABLE "public"."vista_inventario" TO "anon";
GRANT ALL ON TABLE "public"."vista_inventario" TO "authenticated";
GRANT ALL ON TABLE "public"."vista_inventario" TO "service_role";



GRANT ALL ON TABLE "public"."zonas_vendedor" TO "anon";
GRANT ALL ON TABLE "public"."zonas_vendedor" TO "authenticated";
GRANT ALL ON TABLE "public"."zonas_vendedor" TO "service_role";



GRANT ALL ON SEQUENCE "public"."zonas_vendedor_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."zonas_vendedor_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."zonas_vendedor_id_seq" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































drop extension if exists "pg_net";

drop policy "caja_dias_escritura" on "public"."caja_dias";

drop policy "caja_dias_lectura" on "public"."caja_dias";

drop policy "caja_mov_escritura" on "public"."caja_movimientos";

drop policy "caja_mov_lectura" on "public"."caja_movimientos";

drop policy "caja_puntos_escritura" on "public"."caja_puntos";

drop policy "caja_puntos_lectura" on "public"."caja_puntos";

drop policy "canjes_hist_escritura" on "public"."canjes_historial";

drop policy "canjes_hist_lectura" on "public"."canjes_historial";

drop policy "Clientes escritura" on "public"."clientes";

drop policy "Clientes lectura" on "public"."clientes";

drop policy "cp" on "public"."config_produccion";

drop policy "cs" on "public"."config_secciones";

drop policy "cuotas_v" on "public"."cuotas_vendedor";

drop policy "Cupones activos lectura pública" on "public"."cupones";

drop policy "Cupones uso escritura" on "public"."cupones_uso";

drop policy "Cupones uso lectura" on "public"."cupones_uso";

drop policy "gastos_escritura" on "public"."gastos";

drop policy "gastos_lectura" on "public"."gastos";

drop policy "gas_ins_escritura" on "public"."gastos_insumos";

drop policy "gas_ins_lectura" on "public"."gastos_insumos";

drop policy "insumos_escritura" on "public"."insumos";

drop policy "insumos_lectura" on "public"."insumos";

drop policy "inv_fis_escritura" on "public"."inventario_fisico";

drop policy "inv_fis_lectura" on "public"."inventario_fisico";

drop policy "Jornadas escritura" on "public"."jornadas";

drop policy "Jornadas lectura" on "public"."jornadas";

drop policy "lealtad_mov_escritura" on "public"."lealtad_movimientos";

drop policy "lealtad_mov_lectura" on "public"."lealtad_movimientos";

drop policy "lotes_escritura" on "public"."lotes_produccion";

drop policy "lotes_lectura" on "public"."lotes_produccion";

drop policy "Ordenes escritura" on "public"."ordenes";

drop policy "Ordenes lectura" on "public"."ordenes";

drop policy "Detalle escritura" on "public"."ordenes_detalle";

drop policy "Detalle lectura" on "public"."ordenes_detalle";

drop policy "Premios admin escribe" on "public"."premios";

drop policy "Premios públicos" on "public"."premios";

drop policy "prod_escritura" on "public"."produccion_diaria";

drop policy "prod_lectura" on "public"."produccion_diaria";

drop policy "Productos activos son públicos para lectura" on "public"."productos";

drop policy "Bebidas activas son públicas para lectura" on "public"."productos_bebidas";

drop policy "Prospectos escritura" on "public"."prospectos";

drop policy "Prospectos lectura autenticados" on "public"."prospectos";

drop policy "stock_terminado_escritura" on "public"."stock_terminado";

drop policy "stock_terminado_lectura" on "public"."stock_terminado";

drop policy "uso_ins_escritura" on "public"."uso_insumos";

drop policy "uso_ins_lectura" on "public"."uso_insumos";

drop policy "vendedores_escritura" on "public"."vendedores";

drop policy "vendedores_lectura" on "public"."vendedores";

drop policy "zv" on "public"."zonas_vendedor";

revoke delete on table "public"."app_config" from "anon";

revoke insert on table "public"."app_config" from "anon";

revoke references on table "public"."app_config" from "anon";

revoke select on table "public"."app_config" from "anon";

revoke trigger on table "public"."app_config" from "anon";

revoke truncate on table "public"."app_config" from "anon";

revoke update on table "public"."app_config" from "anon";

revoke delete on table "public"."app_config" from "authenticated";

revoke insert on table "public"."app_config" from "authenticated";

revoke references on table "public"."app_config" from "authenticated";

revoke select on table "public"."app_config" from "authenticated";

revoke trigger on table "public"."app_config" from "authenticated";

revoke truncate on table "public"."app_config" from "authenticated";

revoke update on table "public"."app_config" from "authenticated";

revoke delete on table "public"."otp_codigos" from "anon";

revoke insert on table "public"."otp_codigos" from "anon";

revoke references on table "public"."otp_codigos" from "anon";

revoke select on table "public"."otp_codigos" from "anon";

revoke trigger on table "public"."otp_codigos" from "anon";

revoke truncate on table "public"."otp_codigos" from "anon";

revoke update on table "public"."otp_codigos" from "anon";

revoke delete on table "public"."otp_codigos" from "authenticated";

revoke insert on table "public"."otp_codigos" from "authenticated";

revoke references on table "public"."otp_codigos" from "authenticated";

revoke select on table "public"."otp_codigos" from "authenticated";

revoke trigger on table "public"."otp_codigos" from "authenticated";

revoke truncate on table "public"."otp_codigos" from "authenticated";

revoke update on table "public"."otp_codigos" from "authenticated";


  create policy "caja_dias_escritura"
  on "public"."caja_dias"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "caja_dias_lectura"
  on "public"."caja_dias"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "caja_mov_escritura"
  on "public"."caja_movimientos"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "caja_mov_lectura"
  on "public"."caja_movimientos"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "caja_puntos_escritura"
  on "public"."caja_puntos"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "caja_puntos_lectura"
  on "public"."caja_puntos"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "canjes_hist_escritura"
  on "public"."canjes_historial"
  as permissive
  for insert
  to anon, authenticated
with check (true);



  create policy "canjes_hist_lectura"
  on "public"."canjes_historial"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "Clientes escritura"
  on "public"."clientes"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "Clientes lectura"
  on "public"."clientes"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "cp"
  on "public"."config_produccion"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "cs"
  on "public"."config_secciones"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "cuotas_v"
  on "public"."cuotas_vendedor"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "Cupones activos lectura pública"
  on "public"."cupones"
  as permissive
  for select
  to anon, authenticated
using ((activo = true));



  create policy "Cupones uso escritura"
  on "public"."cupones_uso"
  as permissive
  for insert
  to anon, authenticated
with check (true);



  create policy "Cupones uso lectura"
  on "public"."cupones_uso"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "gastos_escritura"
  on "public"."gastos"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "gastos_lectura"
  on "public"."gastos"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "gas_ins_escritura"
  on "public"."gastos_insumos"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "gas_ins_lectura"
  on "public"."gastos_insumos"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "insumos_escritura"
  on "public"."insumos"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "insumos_lectura"
  on "public"."insumos"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "inv_fis_escritura"
  on "public"."inventario_fisico"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "inv_fis_lectura"
  on "public"."inventario_fisico"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "Jornadas escritura"
  on "public"."jornadas"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "Jornadas lectura"
  on "public"."jornadas"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "lealtad_mov_escritura"
  on "public"."lealtad_movimientos"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "lealtad_mov_lectura"
  on "public"."lealtad_movimientos"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "lotes_escritura"
  on "public"."lotes_produccion"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "lotes_lectura"
  on "public"."lotes_produccion"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "Ordenes escritura"
  on "public"."ordenes"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "Ordenes lectura"
  on "public"."ordenes"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "Detalle escritura"
  on "public"."ordenes_detalle"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "Detalle lectura"
  on "public"."ordenes_detalle"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "Premios admin escribe"
  on "public"."premios"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "Premios públicos"
  on "public"."premios"
  as permissive
  for select
  to anon, authenticated
using ((activo = true));



  create policy "prod_escritura"
  on "public"."produccion_diaria"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "prod_lectura"
  on "public"."produccion_diaria"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "Productos activos son públicos para lectura"
  on "public"."productos"
  as permissive
  for select
  to anon, authenticated
using ((activo = true));



  create policy "Bebidas activas son públicas para lectura"
  on "public"."productos_bebidas"
  as permissive
  for select
  to anon, authenticated
using ((activo = true));



  create policy "Prospectos escritura"
  on "public"."prospectos"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "Prospectos lectura autenticados"
  on "public"."prospectos"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "stock_terminado_escritura"
  on "public"."stock_terminado"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "stock_terminado_lectura"
  on "public"."stock_terminado"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "uso_ins_escritura"
  on "public"."uso_insumos"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "uso_ins_lectura"
  on "public"."uso_insumos"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "vendedores_escritura"
  on "public"."vendedores"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



  create policy "vendedores_lectura"
  on "public"."vendedores"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "zv"
  on "public"."zonas_vendedor"
  as permissive
  for all
  to anon, authenticated
using (true)
with check (true);



