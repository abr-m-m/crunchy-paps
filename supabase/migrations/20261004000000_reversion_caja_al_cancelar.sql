-- Cancelar un pedido ya cobrado devuelve el dinero en caja.
--
-- Al cancelar, de las tres consecuencias que tiene un pedido solo ocurrian dos:
--   * puntos -> revertir_puntos_al_cancelar escribe un asiento 'reversion'.
--   * lote   -> fn_reconciliar_pedido excluye 'Cancelado', asi que los kg vuelven.
--   * caja   -> NADA. El unico codigo que corria era caja_movimiento_por_pedido,
--               que pone estatus_caja en NULL y se acaba. El asiento de venta
--               positivo se quedaba en el libro para siempre.
-- Asi que esto no es una funcion nueva: es la tercera que faltaba, y se escribe
-- como hermana de trg_revertir_puntos (AFTER UPDATE ON ordenes, misma guarda de
-- entrada, security definer con search_path fijo). NO se toca
-- caja_movimiento_por_pedido: escribir en el libro desde un BEFORE es pedir
-- problemas, y el patron bueno ya estaba a la vista.
--
-- FECHA DE HOY, decision de Abraham (22 sep 2026): la venta se queda en su dia
-- —ese dinero SI entro ese dia— y la devolucion aparece el dia en que ocurre. No
-- toca dias ya cerrados ni cambia un cierre ya firmado. Es lo contrario del
-- criterio que se uso el mismo dia para limpiar los asientos fantasma, y a
-- proposito: aquellos nunca debieron existir; una cancelacion real es un hecho
-- nuevo.
--
-- LA IDEMPOTENCIA SALE DE LA ARITMETICA, no de una guarda aparte: la condicion es
-- "si el neto de los venta_% es POSITIVO", no "si tiene asiento". Con eso:
--   * los 8 asientos ya compensados a mano el 22 sep quedan fuera solos (neto 0);
--   * los internos y los de total 0 tampoco entran (nunca tuvieron asiento);
--   * cancelar dos veces no duplica: tras la primera reversion el neto es 0.
--
-- LIMITE CONOCIDO: descancelar no repone nada. Si un pedido vuelve de 'Cancelado'
-- a vivo, la reversion se queda y la caja muestra 0. Es exactamente lo que hacen
-- hoy los puntos (revertir_puntos_al_cancelar solo actua al ENTRAR en Cancelado y
-- nada re-otorga al salir), asi que se replica esa conducta en vez de inventar una
-- distinta para caja. Nada impide descancelar: actualizar_estatus_pedido_interno
-- ni menciona 'Cancelado'.
--
-- NOTA DE OPERACION: en produccion el id_caja_dia nacera NULL, porque no hay caja
-- del dia desde el 9 jun 2026 (una sola fila en caja_dias, aun 'abierta'). La
-- devolucion SI se vera en la pantalla del dia —obtener_caja_dia suma por
-- fecha::DATE— pero no entrara en ningun cierre, porque no hay cierres. Que hacer
-- con la caja del dia es una decision aparte, fuera de esta migracion.

create or replace function public.revertir_caja_al_cancelar() returns trigger
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_neto numeric;
  v_orig caja_movimientos%rowtype;
  v_id_caja bigint;
begin
  -- Solo al ENTRAR en Cancelado, igual que la hermana de puntos.
  if new.estatus_pedido <> 'Cancelado' or coalesce(old.estatus_pedido, '') = 'Cancelado' then
    return new;
  end if;

  -- El neto, no la existencia: ver "LA IDEMPOTENCIA" arriba.
  select coalesce(sum(monto), 0) into v_neto
    from caja_movimientos
   where id_orden = new.id and tipo like 'venta_%';
  if coalesce(v_neto, 0) <= 0 then
    return new;
  end if;

  -- El asiento con el que se empareja y de donde salen tipo y punto: el primero
  -- positivo, como hace editar_pedido_compensar.
  select * into v_orig from caja_movimientos
   where id_orden = new.id and tipo like 'venta_%' and monto > 0
   order by id limit 1;
  if v_orig.id is null then
    return new;
  end if;

  -- La caja abierta de HOY para ese punto, si la hay. Si no, queda NULL y el
  -- asiento se ve igualmente en la pantalla del dia, que suma por fecha.
  select id into v_id_caja from caja_dias
   where id_punto = v_orig.id_punto and fecha = current_date and estatus = 'abierta'
   limit 1;

  insert into caja_movimientos (
    id_caja_dia, id_punto, tipo, monto,
    id_orden, consecutivo_pedido, id_mov_pareja, descripcion, actor
  ) values (
    v_id_caja, v_orig.id_punto, v_orig.tipo, -v_neto,
    new.id, new.consecutivo, v_orig.id,
    'Devolución por cancelación de ' || coalesce(new.consecutivo, ''),
    coalesce(nullif(new.actualizado_por, ''), 'sistema')
  );

  return new;
end $$;

drop trigger if exists trg_revertir_caja on public.ordenes;
create trigger trg_revertir_caja
  after update on public.ordenes
  for each row execute function public.revertir_caja_al_cancelar();
