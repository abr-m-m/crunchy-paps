-- 18 sep 2026 — Crunchy Club: el cliente ve su saldo y de dónde sale (pedido de Abraham).
--
-- lealtad_movimientos está cerrada por RLS (sin políticas): el cliente la lee solo por este RPC,
-- que lo identifica por su sesión (resolver_sesion_cliente), como obtener_cliente_con_stats.
-- Devuelve el saldo (la suma del ledger, igual que saldos_lealtad) y los últimos 50 movimientos,
-- cada uno con su pedido cuando lo tiene.

create or replace function public.mis_puntos(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_tel  text;
  v_id   bigint;
  v_movs jsonb;
begin
  v_tel := public.resolver_sesion_cliente(p_token);
  if v_tel is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida o expirada');
  end if;
  select c.id into v_id from public.clientes c where c.telefono = v_tel order by c.id limit 1;
  if v_id is null then
    return jsonb_build_object('ok', true, 'saldo', 0, 'movimientos', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'fecha', m.fecha, 'tipo', m.tipo, 'puntos', m.puntos,
           'consecutivo', m.consecutivo, 'monto', m.monto_origen, 'nota', m.nota)
         order by m.fecha desc, m.id desc), '[]'::jsonb)
    into v_movs
    from (select * from public.lealtad_movimientos
           where id_cliente = v_id order by fecha desc, id desc limit 50) m;

  return jsonb_build_object('ok', true,
    'saldo', coalesce((select sum(puntos) from public.lealtad_movimientos where id_cliente = v_id), 0),
    'movimientos', v_movs);
end $fn$;
revoke all on function public.mis_puntos(text) from public;
grant execute on function public.mis_puntos(text) to anon, authenticated;
