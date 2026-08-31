-- ============================================================================
--  ETAPA B — Exigir sesión y sección en las mutaciones de personal
-- ----------------------------------------------------------------------------
--  Hallazgo 22: 32 funciones escribían sin comprobar credencial, y las 66 de la
--  API eran ejecutables por `anon`. Las 10 sin uso ya se retiraron
--  (supabase/urgente/20260831_revocar_rpcs_sin_uso.sql). Aquí van las 22 que la
--  app SÍ usa, y que por tanto necesitan el despliegue conjunto.
--
--  ⚠️ ARCHIVO GENERADO a partir de una tabla de mapeo función->sección. Con 22
--  envolturas casi idénticas, escribirlas a mano es pedir un error de dedo.
--
--  MÉTODO: el mismo que con los RPCs de finanzas. Cada función se renombra a
--  `<nombre>_interno` y pierde el permiso de ejecución (desaparece de la API);
--  una envoltura con el nombre original valida sesión y sección, y delega. La
--  lógica de negocio NO se toca.
--
--  MAPEO (por qué cada una pide lo que pide)
--    dueño       set_secciones_vendedor, set_config_secciones, set_cuota_vendedor,
--                set_lealtad_config, set_mayoreo_config
--                -> conceden permisos o fijan reglas del negocio. Solo el dueño.
--    gastos      aprobar_gasto, rechazar_gasto
--    caja        abrir_caja_dia, cerrar_caja_dia, registrar_movimiento_caja,
--                confirmar_caja_pedido
--    pedidos     actualizar_estatus_pedido, corregir_metodo_pago_pedido,
--                reasignar_lote_pedido
--                -> las dos primeras permiten MARCAR UN PEDIDO COMO PAGADO
--    b2b         reasignar_vendedor_cliente, aprobar_cliente_b2b,
--                actualizar_tipo_cliente
--    produccion  registrar_lote, registrar_produccion_sabor
--    prospeccion importar_prospectos_bulk, convertir_prospecto_a_cliente,
--                registrar_prospecto_desde_interno
--
--  NO se tocan las de cara al cliente (crear_pedido, registrar_o_actualizar_cliente,
--  guardar_encuesta, aplicar_cupon): un cliente sin sesión legítimamente hace su
--  pedido. Acotarlas es otro problema y necesita sesión de cliente.
-- ============================================================================

-- ¿La sesión pertenece a un rol dueño? Misma definición estricta que
-- sesion_secciones: 'admin' y 'administrador' exactos, para que los perfiles de
-- socio (administrador2) se puedan recortar.
create or replace function public.sesion_es_dueno(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
declare v_rol text; v_id bigint;
begin
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.resolver_sesion_vendedor(p_token) s;
  if v_id is null then return false; end if;
  -- El rol vigente se relee de la tabla, no del token.
  select lower(trim(v.rol)) into v_rol
    from public.vendedores v where v.id = v_id and v.activo = true;
  return coalesce(v_rol, '') in ('admin', 'administrador');
end;
$fn$;

revoke all on function public.sesion_es_dueno(text) from public, anon, authenticated;


alter function public.set_secciones_vendedor(jsonb) rename to set_secciones_vendedor_interno;
revoke all on function public.set_secciones_vendedor_interno(jsonb) from public, anon, authenticated;
create or replace function public.set_secciones_vendedor(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.set_secciones_vendedor_interno(p_data);
end $fn$;

alter function public.set_config_secciones(jsonb) rename to set_config_secciones_interno;
revoke all on function public.set_config_secciones_interno(jsonb) from public, anon, authenticated;
create or replace function public.set_config_secciones(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.set_config_secciones_interno(p_data);
end $fn$;

alter function public.set_cuota_vendedor(jsonb) rename to set_cuota_vendedor_interno;
revoke all on function public.set_cuota_vendedor_interno(jsonb) from public, anon, authenticated;
create or replace function public.set_cuota_vendedor(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.set_cuota_vendedor_interno(p_data);
end $fn$;

alter function public.set_lealtad_config(jsonb) rename to set_lealtad_config_interno;
revoke all on function public.set_lealtad_config_interno(jsonb) from public, anon, authenticated;
create or replace function public.set_lealtad_config(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.set_lealtad_config_interno(p_data);
end $fn$;

alter function public.set_mayoreo_config(jsonb) rename to set_mayoreo_config_interno;
revoke all on function public.set_mayoreo_config_interno(jsonb) from public, anon, authenticated;
create or replace function public.set_mayoreo_config(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.set_mayoreo_config_interno(p_data);
end $fn$;

alter function public.aprobar_gasto(jsonb) rename to aprobar_gasto_interno;
revoke all on function public.aprobar_gasto_interno(jsonb) from public, anon, authenticated;
create or replace function public.aprobar_gasto(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'gastos') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.aprobar_gasto_interno(p_data);
end $fn$;

alter function public.rechazar_gasto(jsonb) rename to rechazar_gasto_interno;
revoke all on function public.rechazar_gasto_interno(jsonb) from public, anon, authenticated;
create or replace function public.rechazar_gasto(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'gastos') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.rechazar_gasto_interno(p_data);
end $fn$;

alter function public.abrir_caja_dia(jsonb) rename to abrir_caja_dia_interno;
revoke all on function public.abrir_caja_dia_interno(jsonb) from public, anon, authenticated;
create or replace function public.abrir_caja_dia(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'caja') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.abrir_caja_dia_interno(p_data);
end $fn$;

alter function public.cerrar_caja_dia(jsonb) rename to cerrar_caja_dia_interno;
revoke all on function public.cerrar_caja_dia_interno(jsonb) from public, anon, authenticated;
create or replace function public.cerrar_caja_dia(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'caja') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.cerrar_caja_dia_interno(p_data);
end $fn$;

alter function public.registrar_movimiento_caja(jsonb) rename to registrar_movimiento_caja_interno;
revoke all on function public.registrar_movimiento_caja_interno(jsonb) from public, anon, authenticated;
create or replace function public.registrar_movimiento_caja(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'caja') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.registrar_movimiento_caja_interno(p_data);
end $fn$;

alter function public.confirmar_caja_pedido(jsonb) rename to confirmar_caja_pedido_interno;
revoke all on function public.confirmar_caja_pedido_interno(jsonb) from public, anon, authenticated;
create or replace function public.confirmar_caja_pedido(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'caja') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.confirmar_caja_pedido_interno(p_data);
end $fn$;

alter function public.actualizar_estatus_pedido(jsonb) rename to actualizar_estatus_pedido_interno;
revoke all on function public.actualizar_estatus_pedido_interno(jsonb) from public, anon, authenticated;
create or replace function public.actualizar_estatus_pedido(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'pedidos') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.actualizar_estatus_pedido_interno(p_data);
end $fn$;

alter function public.corregir_metodo_pago_pedido(jsonb) rename to corregir_metodo_pago_pedido_interno;
revoke all on function public.corregir_metodo_pago_pedido_interno(jsonb) from public, anon, authenticated;
create or replace function public.corregir_metodo_pago_pedido(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'pedidos') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.corregir_metodo_pago_pedido_interno(p_data);
end $fn$;

alter function public.actualizar_tipo_cliente(jsonb) rename to actualizar_tipo_cliente_interno;
revoke all on function public.actualizar_tipo_cliente_interno(jsonb) from public, anon, authenticated;
create or replace function public.actualizar_tipo_cliente(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'b2b') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.actualizar_tipo_cliente_interno(p_data);
end $fn$;

alter function public.registrar_lote(jsonb) rename to registrar_lote_interno;
revoke all on function public.registrar_lote_interno(jsonb) from public, anon, authenticated;
create or replace function public.registrar_lote(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'produccion') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.registrar_lote_interno(p_data);
end $fn$;

alter function public.registrar_produccion_sabor(jsonb) rename to registrar_produccion_sabor_interno;
revoke all on function public.registrar_produccion_sabor_interno(jsonb) from public, anon, authenticated;
create or replace function public.registrar_produccion_sabor(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'produccion') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.registrar_produccion_sabor_interno(p_data);
end $fn$;

alter function public.importar_prospectos_bulk(jsonb) rename to importar_prospectos_bulk_interno;
revoke all on function public.importar_prospectos_bulk_interno(jsonb) from public, anon, authenticated;
create or replace function public.importar_prospectos_bulk(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'prospeccion') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.importar_prospectos_bulk_interno(p_data);
end $fn$;

alter function public.convertir_prospecto_a_cliente(jsonb) rename to convertir_prospecto_a_cliente_interno;
revoke all on function public.convertir_prospecto_a_cliente_interno(jsonb) from public, anon, authenticated;
create or replace function public.convertir_prospecto_a_cliente(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'prospeccion') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.convertir_prospecto_a_cliente_interno(p_data);
end $fn$;

alter function public.registrar_prospecto_desde_interno(jsonb) rename to registrar_prospecto_desde_interno_interno;
revoke all on function public.registrar_prospecto_desde_interno_interno(jsonb) from public, anon, authenticated;
create or replace function public.registrar_prospecto_desde_interno(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'prospeccion') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.registrar_prospecto_desde_interno_interno(p_data);
end $fn$;

-- ────────────────────────────────────────────────────────────────────────────
--  Las tres con argumentos posicionales. La envoltura añade p_token al final
--  con DEFAULT NULL, así que la firma sigue resolviéndose igual y el token
--  viaja como parámetro con nombre desde PostgREST.
-- ────────────────────────────────────────────────────────────────────────────

alter function public.aprobar_cliente_b2b(bigint, boolean, text) rename to aprobar_cliente_b2b_interno;
revoke all on function public.aprobar_cliente_b2b_interno(bigint, boolean, text) from public, anon, authenticated;
create or replace function public.aprobar_cliente_b2b(
  p_id_cliente bigint, p_aprobar boolean, p_actor text default 'admin'::text, p_token text default null)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_token, 'b2b') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.aprobar_cliente_b2b_interno(p_id_cliente, p_aprobar, p_actor);
end $fn$;

alter function public.reasignar_lote_pedido(bigint, text) rename to reasignar_lote_pedido_interno;
revoke all on function public.reasignar_lote_pedido_interno(bigint, text) from public, anon, authenticated;
create or replace function public.reasignar_lote_pedido(
  p_id_orden bigint, p_id_lote text, p_token text default null)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_token, 'pedidos') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.reasignar_lote_pedido_interno(p_id_orden, p_id_lote);
end $fn$;

alter function public.reasignar_vendedor_cliente(bigint, bigint, text) rename to reasignar_vendedor_cliente_interno;
revoke all on function public.reasignar_vendedor_cliente_interno(bigint, bigint, text) from public, anon, authenticated;
create or replace function public.reasignar_vendedor_cliente(
  p_id_cliente bigint, p_id_vendedor bigint, p_nombre_vendedor text, p_token text default null)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_token, 'b2b') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.reasignar_vendedor_cliente_interno(p_id_cliente, p_id_vendedor, p_nombre_vendedor);
end $fn$;

-- ────────────────────────────────────────────────────────────────────────────
--  reporte_cobros: envuelta Y retirada de la API
-- ────────────────────────────────────────────────────────────────────────────
--  La migración 20260901020000 le puso envoltura con sesión, y después la
--  auditoría (hallazgo 22) confirmó que la app NO la llama. Se deja la
--  envoltura por si algún día se usa, pero se retira de la API: lo que no se
--  usa no debe estar expuesto. Sin este revoke, una aplicación desde cero
--  volvería a exponerla, porque `create or replace` de una función nueva
--  concede EXECUTE a PUBLIC por defecto.
revoke all on function public.reporte_cobros(jsonb) from public, anon, authenticated;
