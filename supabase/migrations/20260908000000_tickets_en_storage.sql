-- ═══════════════════════════════════════════════════════════════════════════
-- Tickets de gasto: de Google Drive a Supabase Storage (fase 4)
--
-- La última acción que quedaba en Apps Script. El navegador mandaba la foto en
-- base64 por /api/sheets, y de ahí a Drive. Eso arrastraba dos problemas:
--
--   1. El comentario del código lo decía: "bug del proxy >16KB". El límite de
--      5 MB del selector se vuelve ~6.7 MB en base64, muy por encima de lo que
--      admite el cuerpo de una función serverless. Por eso esta acción nunca
--      salió de Apps Script.
--   2. Los enlaces de Drive son "cualquiera con el enlace": un ticket de gasto
--      es un documento contable y quedaba accesible a quien tuviera la URL.
--
-- La solución de los dos es la misma: el archivo va del NAVEGADOR DIRECTO a
-- Storage con una URL firmada de un solo uso. No pasa por Vercel, así que el
-- límite de cuerpo deja de existir.
--
-- El bucket es PRIVADO. Para verlo hace falta una URL firmada de corta vida, y
-- para obtenerla hay que poder ver el gasto al que pertenece.
--
-- QUIÉN VE QUÉ: no se inventa una regla nueva. El ticket hereda la del gasto,
-- que ya existía en obtener_gastos: admin ve todos, un vendedor solo los suyos.
-- ═══════════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tickets', 'tickets', false, 5242880,
        array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Sin políticas sobre storage.objects a propósito: nadie llega al bucket con la
-- llave anon. El único camino es una URL firmada, que se emite con service_role
-- desde /api/ticket después de comprobar la sesión.

-- ── ¿PUEDE ESTA SESIÓN TOCAR EL TICKET DE ESTE GASTO? ──────────────────────
-- La usa /api/ticket antes de firmar nada, tanto para subir como para ver.
create or replace function public.autorizar_ticket_gasto(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare
  v_id      bigint;
  v_rol     text;
  v_admin   boolean;
  v_gasto   record;
begin
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.sesion_exige_seccion(p_data->>'token', 'gastos') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  select g.id, g.id_vendedor, g.ticket_url into v_gasto
    from public.gastos g
   where g.id = nullif(p_data->>'idGasto','')::bigint;

  if v_gasto.id is null then
    return jsonb_build_object('ok', false, 'error', 'Gasto no encontrado');
  end if;

  -- Misma regla que obtener_gastos: el ticket no puede ser más visible que el
  -- gasto del que cuelga.
  v_admin := lower(trim(coalesce(v_rol,''))) in ('admin','administrador');
  if not (v_admin or v_gasto.id_vendedor = v_id) then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  return jsonb_build_object(
    'ok',         true,
    'idGasto',    v_gasto.id,
    'ticketUrl',  v_gasto.ticket_url,
    'idVendedor', v_id
  );
end $fn$;

-- Solo la llave de servicio: esto lo consulta /api/ticket, nunca el navegador.
revoke all on function public.autorizar_ticket_gasto(jsonb) from public, anon, authenticated;
grant execute on function public.autorizar_ticket_gasto(jsonb) to service_role;
