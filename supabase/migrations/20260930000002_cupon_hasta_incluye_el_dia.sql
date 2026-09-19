-- 18 sep 2026 — «Hasta el 30» incluye el 30 entero (decisión de Abraham).
--
-- vigencia_fin guarda el día elegido a las 00:00 de CDMX (20260930000001), y validar_cupon
-- rechazaba con vigencia_fin < now(): el cupón dejaba de servir al empezar su último día, aunque
-- la app dijera «Hasta 30 sep». Ahora vence al terminar ese día (00:00 del siguiente).
-- crear_pedido valida el cupón con esta misma función, así que el cobro sigue la misma regla.
-- Solo cambia esa línea; el resto es la función de producción (idéntica en staging).

CREATE OR REPLACE FUNCTION public.validar_cupon(p_codigo text, p_telefono text DEFAULT NULL::text, p_id_cliente bigint DEFAULT NULL::bigint, p_total_compra numeric DEFAULT 0, p_segmento_cliente text DEFAULT 'consumidor'::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
  IF v_cupon.vigencia_fin + interval '1 day' <= NOW() THEN
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
$function$;
