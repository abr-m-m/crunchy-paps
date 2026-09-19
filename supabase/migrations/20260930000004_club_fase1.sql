-- 18 sep 2026 — Crunchy Club, fase 1 (cambios/2026-09-18-club/diseno-canje.md). Decidido por Abraham:
-- 1 punto por cada $10 de venta neta de producto (sin envío), 1 punto = $0.30, los mayoristas no
-- generan, y los puntos que ya existen se borran. Canje en el checkout, caducidad e informe bruto/neto
-- quedan para la fase 2.
--
-- 1. set_lealtad_config_interno acepta base 'neto' (antes lo convertía en 'total').
-- 2. otorgar_puntos_al_confirmar v2: consumidor al pasar a Pagado, tienda y restaurante al pasar a
--    Entregado (Abraham, 18 sep); base 'neto' = subtotal - descuento; antidoble por neto del pedido.
-- 3. actualizar_estatus_pedido_interno deja de dar y quitar puntos (camino doble; ver el comentario).
-- 4. Trigger nuevo: al pasar a Cancelado, reversión del neto que el pedido haya generado.
-- 5. Reglas nuevas en config_produccion.
-- 6. Reinicio: un asiento 'ajuste' por cliente con -saldo (lealtad_movimientos es solo-INSERT).
--    Idempotente: con saldo 0 no inserta nada.

begin;

CREATE OR REPLACE FUNCTION public.set_lealtad_config_interno(p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  IF v_base NOT IN ('total','subtotal','neto') THEN v_base := 'total'; END IF;

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
$function$;

CREATE OR REPLACE FUNCTION public.otorgar_puntos_al_confirmar()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- Club fase 1 (Abraham, 18 sep): el momento depende de quién compra.
--   Consumidor: al pasar a Pagado (en línea, el webhook de Stripe; contra entrega, cuando se marca).
--   Tienda y restaurante: al pasar a Entregado (no pagan en línea; la entrega va con el pago).
--   Mayorista, internos, mostrador sin cliente (999999) y cancelados: nunca.
-- Base 'neto' = subtotal - descuento: producto menos cupón, sin envío.
DECLARE
  v_cfg     jsonb;
  v_rate    numeric;
  v_base    text;
  v_monto   numeric;
  v_pts     int;
  v_tipo    int;
  v_momento boolean;
BEGIN
  IF COALESCE(NEW.tipo_interno,'') <> '' OR NEW.id_cliente IS NULL OR NEW.id_cliente = 999999
     OR NEW.estatus_pedido = 'Cancelado' THEN
    RETURN NEW;
  END IF;

  SELECT c.tipo_id INTO v_tipo FROM clientes c WHERE c.id = NEW.id_cliente;
  IF lower(COALESCE(NEW.canal,'')) = 'mayorista' OR v_tipo = 4 THEN
    RETURN NEW;
  END IF;

  IF v_tipo IN (2, 3) THEN
    v_momento := NEW.estatus_pedido = 'Entregado'
                 AND (TG_OP = 'INSERT' OR OLD.estatus_pedido IS DISTINCT FROM 'Entregado');
  ELSE
    v_momento := NEW.estatus_pago = 'Pagado'
                 AND (TG_OP = 'INSERT' OR OLD.estatus_pago IS DISTINCT FROM 'Pagado');
  END IF;
  IF NOT v_momento THEN
    RETURN NEW;
  END IF;

  -- Antidoble: neto de generación y reversión del pedido.
  IF COALESCE((SELECT sum(puntos) FROM lealtad_movimientos
                WHERE id_orden = NEW.id AND tipo IN ('generacion', 'reversion')), 0) > 0 THEN
    RETURN NEW;
  END IF;

  SELECT valor INTO v_cfg FROM config_produccion WHERE clave = 'lealtad';
  IF v_cfg IS NULL OR COALESCE((v_cfg->'generacion'->>'activo')::bool, false) = false THEN
    RETURN NEW;
  END IF;

  v_rate  := COALESCE((v_cfg->'generacion'->>'puntos_por_peso')::numeric, 0);
  v_base  := COALESCE(v_cfg->'generacion'->>'base', 'total');
  v_monto := CASE v_base WHEN 'neto' THEN GREATEST(0, COALESCE(NEW.subtotal, 0) - COALESCE(NEW.descuento, 0))
                         WHEN 'subtotal' THEN NEW.subtotal ELSE NEW.total END;
  v_pts   := floor(COALESCE(v_monto, 0) * v_rate)::int;

  IF v_pts > 0 THEN
    PERFORM agregar_movimiento_lealtad(
      NEW.id_cliente, 'generacion', v_pts,
      NEW.id, NEW.consecutivo, NULL, NULL, v_monto,
      'Puntos por pedido ' || COALESCE(NEW.consecutivo,'') || CASE WHEN v_tipo IN (2, 3) THEN ' (entregado)' ELSE ' (pagado)' END,
      'sistema'
    );
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.actualizar_estatus_pedido_interno(p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
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

  -- Club fase 1: los puntos ya no se dan ni se quitan aquí. Este bloque daba FLOOR(total/100) al pasar a
  -- Pagado, sin mirar la configuración ni excluir mayoristas, y el trigger otorgar_puntos_al_confirmar
  -- volvía a dar al quedar Pagado+Entregado: 20 de 38 pedidos con puntos los recibieron dos veces.
  -- Ahora generan y revierten solo los triggers; aquí se informa lo que asentaron en esta transacción.
  SELECT COALESCE(sum(puntos) FILTER (WHERE puntos > 0), 0), COALESCE(-sum(puntos) FILTER (WHERE puntos < 0), 0)
    INTO v_puntos_dad, v_puntos_rev
    FROM lealtad_movimientos
   WHERE id_orden = v_id_orden AND tipo IN ('generacion', 'reversion') AND fecha = now();

  RETURN jsonb_build_object(
    'ok', true, 'msg', 'Estatus actualizado',
    'puntosOtorgados', v_puntos_dad,
    'puntosRevertidos', v_puntos_rev
  );
END;
$function$;

create or replace function public.revertir_puntos_al_cancelar() returns trigger
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare v_neto int;
begin
  if new.estatus_pedido = 'Cancelado' and coalesce(old.estatus_pedido, '') <> 'Cancelado' then
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
  end if;
  return new;
end $fn$;
revoke all on function public.revertir_puntos_al_cancelar() from public;
drop trigger if exists trg_revertir_puntos on public.ordenes;
create trigger trg_revertir_puntos after update of estatus_pedido on public.ordenes
  for each row execute function public.revertir_puntos_al_cancelar();

select public.set_lealtad_config_interno(jsonb_build_object(
  'generacion', jsonb_build_object('activo', true, 'base', 'neto', 'puntos_por_peso', 0.1),
  'redencion',  jsonb_build_object('activo', true, 'valor_punto_mxn', 0.3,
                  'pct_max_pedido', coalesce((select (valor->'redencion'->>'pct_max_pedido')::int from config_produccion where clave = 'lealtad'), 50),
                  'pago_minimo_mxn', 1, 'puntos_minimos_canje', 0)));

insert into public.lealtad_movimientos (id_cliente, tipo, puntos, nota, actor)
select id_cliente, 'ajuste', -sum(puntos)::int,
       'Reinicio del Crunchy Club con las reglas nuevas: 1 punto por cada $10, 1 punto = $0.30', 'Abraham Miranda'
  from public.lealtad_movimientos
 group by id_cliente
having sum(puntos) <> 0
returning id_cliente, puntos;

commit;
