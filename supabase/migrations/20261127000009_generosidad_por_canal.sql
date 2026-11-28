-- 27 nov 2026 — Generosidad por canal: la arquitectura, no el cambio
--
-- Abraham: «que los puntos asociados por la venta de un vendedor sean
-- diferentes a cuando el cliente compra solo por la app o por el agente.
-- Generosidad diferenciada. Vale la pena mantenerla igual AHORA, pero dejemos
-- la arquitectura para que esto sea ajustable. En consola como el resto de
-- configuraciones del dueño.»
--
-- Un multiplicador por canal dentro de `config_produccion`, clave `lealtad`:
--
--   "generacion": { ..., "generosidad": { "web": 1, "vendedor": 1 } }
--
-- LO QUE NO ESTA ESCRITO VALE 1. Tres consecuencias buscadas: hoy no cambia
-- nada -y eso es lo que se prueba-, un canal nuevo nace normal en vez de dejar
-- de dar puntos, y borrar la clave devuelve el sistema a como estaba.
--
-- EL MULTIPLICADOR NO TOCA EL MONTO. El asiento sigue guardando lo que se
-- vendio; lo que cambia es cuantos puntos se dan por ese mismo dinero. Si
-- entrara por el monto, el historico diria que se vendio otra cosa.
--
-- Y QUEDA ESCRITO EN EL ASIENTO cuando no es 1. `lealtad_movimientos` es
-- solo-INSERT y dentro de un año nadie se va a acordar de que generosidad
-- regia ese dia; si no se escribe, el saldo no se puede explicar.
--
-- EL AGENTE SI TIENE CANAL PROPIO. Lo dije al reves primero y Abraham lo
-- cazo: `wa_crear_pedido` estampa `canal = 'whatsapp'` en el SERVIDOR -ni
-- siquiera deja que el agente lo mande-, asi que su generosidad se ajusta por
-- separado desde el primer dia. No aparecia en los datos porque todavia no ha
-- creado ningun pedido: cuatro canales usados (web, vendedor, mostrador,
-- interno) y `whatsapp` esperando su primera venta. Mirar los datos no basta
-- cuando lo que buscas aun no ha pasado.

begin;

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
  -- 27 nov 2026. Cuanto multiplica el canal por el que entro la venta.
  v_gen     numeric;
  v_canal   text;
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
    PERFORM public.evaluar_retos(NEW.id_cliente);
    RETURN NEW;
  END IF;

  v_rate  := COALESCE((v_cfg->'generacion'->>'puntos_por_peso')::numeric, 0);

  -- ── Generosidad por canal (Abraham, 27 nov 2026) ───────────────────────
  -- «Que los puntos asociados por la venta de un vendedor sean diferentes a
  --  cuando el cliente compra solo por la app o por el agente. Vale la pena
  --  mantenerla igual ahora, pero dejemos la arquitectura para que esto sea
  --  ajustable.»
  --
  -- Un multiplicador por canal, en la misma configuracion que el resto. Lo que
  -- NO esta escrito vale 1, asi que: hoy nada cambia, un canal nuevo nace
  -- normal, y borrar la clave devuelve el sistema a como estaba. Un valor por
  -- omision que altera los puntos seria un valor por omision que muerde.
  v_canal := lower(COALESCE(NEW.canal, 'web'));
  v_gen   := COALESCE(
               (v_cfg->'generacion'->'generosidad'->>v_canal)::numeric,
               (v_cfg->'generacion'->'generosidad'->>'default')::numeric,
               1);
  IF v_gen < 0 THEN v_gen := 0; END IF;
  v_base  := COALESCE(v_cfg->'generacion'->>'base', 'total');
  v_monto := CASE v_base WHEN 'neto' THEN GREATEST(0, COALESCE(NEW.subtotal, 0) - COALESCE(NEW.descuento, 0))
                         WHEN 'subtotal' THEN NEW.subtotal ELSE NEW.total END;
  -- El multiplicador entra AQUI y no en el monto: el monto es lo que se
  -- vendio y se guarda en el asiento tal cual. Lo que cambia es cuantos puntos
  -- se dan por ese mismo dinero.
  v_pts   := floor(COALESCE(v_monto, 0) * v_rate * v_gen)::int;

  IF v_pts > 0 THEN
    PERFORM agregar_movimiento_lealtad(
      NEW.id_cliente, 'generacion', v_pts,
      NEW.id, NEW.consecutivo, NULL, NULL, v_monto,
      -- El canal y el multiplicador van en la descripcion cuando no es 1: el
      -- ledger es solo-INSERT y dentro de un año nadie se va a acordar de que
      -- generosidad regia ese dia.
      'Puntos por pedido ' || COALESCE(NEW.consecutivo,'')
        || CASE WHEN v_tipo IN (2, 3) THEN ' (entregado)' ELSE ' (pagado)' END
        || CASE WHEN v_gen <> 1 THEN ' · ' || v_canal || ' x' || trim(to_char(v_gen, 'FM999990.00')) ELSE '' END,
      'sistema'
    );
  END IF;

  -- Retos (19 sep 2026): el pedido acaba de contar; se recalculan los retos del cliente.
  PERFORM public.evaluar_retos(NEW.id_cliente);

  RETURN NEW;
END;
$function$;

commit;
