-- Bug: NEW.estatus_caja es NULL en todo pedido recien creado, y
-- `NULL <> 'confirmado'` evalua a NULL (no a TRUE), asi que la guarda
-- `IF NEW.estatus_caja <> 'confirmado' THEN RETURN NEW; END IF;` no
-- frenaba nada: el trigger escribia la fila venta_efectivo/venta_tarjeta/
-- venta_transferencia en caja_movimientos AL CREARSE el pedido, este haya
-- quedado pagado o no. Y cuando el pedido de verdad se pagaba despues, la
-- guarda de idempotencia (EXISTS ... WHERE id_orden = NEW.id) encontraba
-- esa fila prematura y se saltaba la correcta: la fila prematura quedaba
-- como el registro de venta de facto, con la fecha de creacion y sin
-- id_caja_dia.
--
-- Medido en produccion (solo lectura, por el controller) el 2 oct 2026:
-- de 69 filas venta_*, todas se escribieron al crear el pedido. 11 son
-- legitimas (pedidos de mostrador nacidos ya pagados y confirmados en el
-- mismo INSERT: ese camino es correcto y debe seguir funcionando). 49 son
-- ventas reales anotadas en la fecha equivocada (34 de ellas pagadas otro
-- dia, hasta 87 dias despues). 9 son de pedidos que nunca se pagaron:
-- dinero que nunca existio.
--
-- Arreglo: la guarda se vuelve NULL-safe con coalesce. Es el UNICO cambio
-- de esta migracion; el resto del cuerpo se copio verbatim (con `sed -n`)
-- de 20260830203059_remote_schema.sql. La funcion original no lleva
-- `security definer` ni `set search_path` (solo `language plpgsql`); se
-- preserva exactamente asi, sin agregar ninguno de los dos.
--
-- La funcion hermana `caja_movimiento_por_pedido()` ya usa
-- `NEW.estatus_caja IS NULL` (correcto, NULL-safe) y NO se toca aqui.

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
  IF coalesce(NEW.estatus_caja, '') <> 'confirmado' THEN RETURN NEW; END IF;
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
