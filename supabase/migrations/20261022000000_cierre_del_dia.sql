-- 20261022000000_cierre_del_dia.sql
-- El cierre del dia del vendedor (cambios/2026-09-24-motor-comercial/diseno.md §B.4).
--
-- Lo que el vendedor ve al terminar: cuantas visitas hizo, cuantos pedidos levanto y por cuanto.
-- `programadas` y las paradas sin resultado NO salen de aqui: ya las calcula `ruta_del_dia` en su
-- `avance`, y el panel las tiene en memoria. Pedirlas dos veces seria inventar una segunda fuente
-- para el mismo numero, que es exactamente lo que no queremos.
--
-- Cuenta SOLO lo del dia y SOLO lo de ese vendedor. Un cierre que sume lo de ayer, o lo de otro,
-- le dice a alguien que trabajo cuando no.

create or replace function public.cierre_del_dia(p_data jsonb)
returns jsonb
-- NO es `stable`: `sesion_exige_seccion` ESCRIBE (refresca la sesion), y PostgREST corre las
-- funciones `stable` en una transaccion de solo lectura. Con `stable` esto devuelve
-- «405 cannot execute UPDATE in a read-only transaction». Cazado por la prueba el 24 sep 2026.
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
declare
  v_vend  bigint;
  v_fecha date;
begin
  -- Autorizar ANTES de validar: si no, el mensaje de error ensena las reglas a quien no tiene
  -- permiso de conocerlas.
  select s.id_vendedor into v_vend
    from public.sesion_exige_seccion(p_data->>'token', 'ruta') s;
  if v_vend is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  -- La fecha del cliente NO se usa para «hoy»: el dia lo pone el reloj del servidor en CDMX, como
  -- en `ruta_del_dia`. Un telefono con la fecha mal puesta no debe cambiar lo que se reporta.
  begin
    v_fecha := coalesce((p_data->>'fecha')::date,
                        (now() at time zone 'America/Mexico_City')::date);
  exception when others then
    v_fecha := (now() at time zone 'America/Mexico_City')::date;
  end;

  return jsonb_build_object(
    'ok', true,
    'fecha', v_fecha,
    'vendedor', (select v.nombre from public.vendedores v where v.id = v_vend),
    'visitadas', (select count(*) from public.visitas v
                   where v.id_vendedor = v_vend
                     and (v.creada_en at time zone 'America/Mexico_City')::date = v_fecha),
    'conPedido', (select count(*) from public.visitas v
                   where v.id_vendedor = v_vend
                     and (v.creada_en at time zone 'America/Mexico_City')::date = v_fecha
                     and v.resultado in ('pedido', 'convertido')),
    'pedidos', (select count(*) from public.ordenes o
                 where o.id_vendedor = v_vend
                   and (o.fecha_orden at time zone 'America/Mexico_City')::date = v_fecha
                   and coalesce(o.tipo_interno, '') = '' and o.estatus_pedido <> 'Cancelado'),
    -- Venta NETA: subtotal menos descuento, sin envio. La misma definicion de siempre
    -- (CLAUDE.md §4). No se inventa una segunda aqui.
    'monto', coalesce((select sum(o.subtotal - coalesce(o.descuento, 0)) from public.ordenes o
                        where o.id_vendedor = v_vend
                          and (o.fecha_orden at time zone 'America/Mexico_City')::date = v_fecha
                          and coalesce(o.tipo_interno, '') = '' and o.estatus_pedido <> 'Cancelado'), 0));
end $$;

revoke all on function public.cierre_del_dia(jsonb) from public;
grant execute on function public.cierre_del_dia(jsonb) to anon;
