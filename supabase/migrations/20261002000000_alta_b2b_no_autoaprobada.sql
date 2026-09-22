-- ============================================================================
--  registrar_o_actualizar_cliente: el payload deja de decidir si un B2B nace
--  aprobado
-- ----------------------------------------------------------------------------
--  HALLAZGO (21 sep 2026, auditoría de mutaciones contra la base viva).
--  La función es SECURITY DEFINER y `anon` tiene EXECUTE: se alcanza con la
--  llave publishable, que viaja al navegador por diseño. Y decidía así:
--
--      v_aprobado := CASE WHEN v_tipo_id IN (1,5) THEN TRUE
--                    ELSE COALESCE((p_data->>'aprobadoB2B')::BOOLEAN, FALSE) END;
--
--  Para tipo 2/3/4 (restaurante, tienda, comerciante) el NIVEL DE APROBACIÓN
--  LO MANDABA EL LLAMADOR. Una sola petición daba de alta una tienda ya
--  aprobada:
--
--      POST /rest/v1/rpc/registrar_o_actualizar_cliente
--      {"p_data": {"telefono": "...", "tipoId": 3, "aprobadoB2B": true}}
--
--  Y eso es dinero, no solo una bandera: `crear_pedido` mira `aprobado_b2b` y
--  `tipo_id` para cobrar con `precio_tienda` / `precio_mayorista`. Con el
--  teléfono propio se pasa el OTP normalmente y se entra a precio de mayoreo,
--  saltándose entero el flujo de aprobación y `aprobar_cliente_b2b`, que sí
--  exige sesión.
--
--  NO HAY DAÑO PREVIO. Antes de escribir esto se preguntó a producción por la
--  firma que dejaría un alta desde fuera —B2B aprobado SIN vendedor asignado,
--  cuando la regla de negocio es que toda tienda tiene vendedor—:
--
--      tipo 3 (Tienda/Abarrotes): 5 clientes, 3 aprobados, 0 sin vendedor
--      tipo 2 y 4: ninguno.  Alta B2B más reciente: 13 ago 2026.
--
--  Agujero latente, no incidente.
--
--  POR QUÉ ESTA MIGRACIÓN NO NECESITA DESPLEGAR LA APP
--  ---------------------------------------------------
--  Los cuatro sitios que llaman a esta función mandan `aprobadoB2B: false`
--  (src/app.js:715, src/app.js:730, src/panel.js:158) o conservan el valor que
--  el cliente ya tenía (src/app.js:3539). Ninguno lo usa para CONCEDER nada.
--  Ignorar el campo no cambia ninguna pantalla.
--
--  QUÉ CAMBIA, EXACTAMENTE
--  -----------------------
--   1. `v_aprobado` ya no lee el payload: un B2B nace SIN aprobar, siempre.
--      Consumidor (1) y mostrador (5) siguen naciendo aprobados — no son B2B y
--      no pasan por ninguna puerta.
--   2. El `EXCEPTION WHEN OTHERS` deja de devolverle `SQLERRM` a `anon`: el
--      detalle va a RAISE WARNING (log del servidor) y el llamador recibe un
--      mensaje fijo. El `catch` SE QUEDA a propósito: quitarlo convierte
--      cualquier fallo en un 500 y hay tres llamadas que esperan
--      {ok:false, error}, una de ellas en el checkout. Eso es una decisión de
--      la revisión grande de las 8 funciones expuestas, con las llamadas
--      delante. Regla 21 sigue abierta aquí.
--   3. `search_path` fijado (regla 43). Era una de las cuatro SECURITY DEFINER
--      sin él, y la migración ya reescribe la función entera.
--
--  La rama del UPDATE no toca `aprobado_b2b` y sigue sin tocarlo: un cliente ya
--  aprobado no se desaprueba al actualizarle la dirección.
--
--  LO QUE ESTA MIGRACIÓN **NO** ARREGLA
--  ------------------------------------
--  La misma función, con un teléfono que YA existe, sobrescribe nombre,
--  dirección, cp, colonia, municipio, estado y coordenadas sin pedir sesión.
--  El teléfono se está usando como credencial al portador, y en esta app está
--  en cada pedido y cada ruta. Eso y las otras siete funciones expuestas
--  (set_ubicacion_cliente, set_coordenadas_gps, set_opt_in_promos,
--  guardar_encuesta) van en la entrega siguiente.
--
--  Re-ejecutable: CREATE OR REPLACE.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.registrar_o_actualizar_cliente(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
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

  -- ── LA PUERTA (21 sep 2026) ──────────────────────────────────────────────
  -- Antes: ELSE COALESCE((p_data->>'aprobadoB2B')::BOOLEAN, FALSE).
  -- El payload no opina. Un B2B nace sin aprobar y solo `aprobar_cliente_b2b`
  -- —que exige sesión— lo cambia. 1 y 5 no son B2B: no hay puerta que pasar.
  v_aprobado := (v_tipo_id IN (1, 5));

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
    -- El detalle al log del servidor, no al llamador: `anon` alcanza esta
    -- función y SQLERRM le entregaba el error crudo de Postgres.
    RAISE WARNING 'registrar_o_actualizar_cliente falló: % (%)', SQLERRM, SQLSTATE;
    RETURN jsonb_build_object('ok', false, 'error', 'No se pudo registrar el cliente');
END;
$function$;

COMMENT ON FUNCTION public.registrar_o_actualizar_cliente(jsonb) IS
  'Alta/actualización de cliente por teléfono. 21 sep 2026: el payload ya NO decide `aprobado_b2b` — un B2B (tipo 2/3/4) nace sin aprobar y solo aprobar_cliente_b2b, que exige sesión, lo cambia. Antes, una sola petición anónima creaba una tienda aprobada y crear_pedido le cobraba a precio de mayoreo. Sigue pendiente: con un teléfono existente sobrescribe dirección y nombre sin sesión.';
