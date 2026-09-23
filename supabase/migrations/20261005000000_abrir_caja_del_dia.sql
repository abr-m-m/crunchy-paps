-- La caja del dia se abre sola cada dia.
--
-- EL PROBLEMA, medido en produccion el 22 sep 2026: caja_dias tenia UNA fila, la
-- del 9 jun 2026, y seguia 'abierta'. 6 asientos llevaban id_caja_dia y 75 NO,
-- repartidos en 31 dias distintos (8 jun -> 22 sep, $11,834.20). El mecanismo se
-- uso un dia y se abandono, asi que cerrar_caja_dia_interno (que suma por
-- id_caja_dia) llevaba tres meses sin nada que cerrar, y todo asiento nuevo
-- nacia huerfano porque la busqueda es `fecha = CURRENT_DATE and estatus =
-- 'abierta'` y no habia ninguna.
--
-- EL ARREGLO se apoya en algo que abrir_caja_dia_interno YA hace y que no habia
-- que reescribir: al abrir, ADOPTA los movimientos huerfanos de ese dia y ese
-- punto (`update caja_movimientos set id_caja_dia = ... where id_caja_dia is
-- null and id_punto = ... and fecha::DATE = ...`). Con la caja abierta cada dia,
-- el problema desaparece hacia adelante solo. Tambien devuelve la existente si
-- ya la hay, asi que llamarla dos veces no duplica: la idempotencia ya estaba.
--
-- SALDO 0 cada dia (decision de Abraham, 22 sep 2026). El acumulado no se
-- pierde: obtener_caja_dia ya expone 'saldoTotal', que suma TODOS los
-- movimientos del punto sin filtro de fecha. Arrastrar el saldo calculado del
-- dia anterior habria inventado una cifra que nadie verifico —nadie cierra ni
-- cuenta el efectivo— y un error viejo se propagaria en silencio con aspecto de
-- dato firme.
--
-- NO CIERRA NADA, y es deliberado: cerrar_caja_dia_interno compara el saldo
-- DECLARADO (lo que una persona conto) contra el calculado, y esa comparacion es
-- todo su valor. Cerrar sola seria escribir que siempre cuadra. El cierre se
-- queda humano.
--
-- HORARIO: 00:05 CDMX (`5 6 * * *` UTC; Mexico no cambia de hora, es UTC-6 todo
-- el año), cinco minutos antes del job del Club. La adopcion de huerfanos hace
-- el horario indulgente: una venta de las 00:02 se engancha igual al abrir a las
-- 00:05. La base corre en America/Mexico_City, asi que a esa hora CURRENT_DATE
-- ya es el dia nuevo.
--
-- LO QUE NO TOCA: los 75 huerfanos historicos se quedan como estan. Reengancharlos
-- exigiria abrir ~60 cajas retroactivas que alguien tendria que cerrar; es una
-- decision aparte. Y la caja del 9 jun sigue abierta: es inofensiva, porque todas
-- las busquedas son por `fecha = CURRENT_DATE`.

create or replace function public.abrir_cajas_del_dia() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r          record;
  v_res      jsonb;
  v_abiertas int := 0;
  v_ya       int := 0;
  v_detalle  jsonb := '[]'::jsonb;
begin
  for r in select id, codigo from caja_puntos where activo order by id loop
    v_res := public.abrir_caja_dia_interno(jsonb_build_object(
      'idPunto',      r.id,
      'saldoInicial', 0,
      'actor',        'cron',
      'notas',        'automática'));

    if coalesce((v_res->>'duplicado')::boolean, false) then
      v_ya := v_ya + 1;
    elsif coalesce((v_res->>'ok')::boolean, false) then
      v_abiertas := v_abiertas + 1;
    end if;

    v_detalle := v_detalle || jsonb_build_object('punto', r.codigo, 'res', v_res);
  end loop;

  return jsonb_build_object(
    'ok', true, 'fecha', current_date,
    'abiertas', v_abiertas, 'ya_estaban', v_ya, 'detalle', v_detalle);
end $$;

-- Solo la corre el cron (y postgres). No es un endpoint.
revoke all on function public.abrir_cajas_del_dia() from public, anon, authenticated;

-- cron.schedule con un nombre que ya existe lo actualiza: la migración se puede repetir.
select cron.schedule('caja-abrir-dia', '5 6 * * *', 'select public.abrir_cajas_del_dia()');

-- Y una vez ahora, para no esperar a mañana: crea la caja de hoy en cada punto
-- activo y adopta los huérfanos de hoy.
select public.abrir_cajas_del_dia();
