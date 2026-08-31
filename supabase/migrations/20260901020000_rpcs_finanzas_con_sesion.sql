-- ============================================================================
--  ETAPA B — Exigir sesión en los RPCs de finanzas y personal
-- ----------------------------------------------------------------------------
--  HALLAZGO 19: los RPCs no autorizaban a nadie. Con solo la llave anon, sin
--  sesión, cualquiera obtenía:
--
--    dashboard_resumen        ventas del mes y desglose diario
--    resumen_gastos           gastos del mes
--    reporte_cobros           cobros pendientes por método de pago
--    obtener_vendedores       padrón de personal con correos y teléfonos
--    obtener_pendientes_caja  pendientes de caja
--    metricas_regalo_mes      métricas de regalos
--
--  MÉTODO: ENVOLVER, NO REESCRIBIR
--  --------------------------------
--  Cada función se renombra a `<nombre>_interno` y se le retira el permiso de
--  ejecución, con lo que desaparece de la API. En su lugar se crea una
--  envoltura con el nombre original que valida la sesión y delega.
--
--  Se hace así a propósito: la lógica de negocio —fórmulas de ventas, cálculos
--  de cobros— NO se toca. Reescribir esos cuerpos para insertarles un `if`
--  arriba arriesgaría introducir un error de transcripción en código financiero
--  que hoy funciona. La envoltura es verificable de un vistazo.
--
--  NIVEL DE PERMISO: se exige SESIÓN VÁLIDA de vendedor, no rol Admin.
--  ⚠️ DECISIÓN PENDIENTE PARA ABRAHAM: ¿debe un vendedor ver las ventas de toda
--  la empresa, los gastos y los cobros? Si la respuesta es no, basta con
--  descomentar el bloque `v_rol not in (...)` en las tres funciones de finanzas.
--  No se decidió aquí porque depende de cómo estén organizados los permisos
--  internos, y restringir de más dejaría a un vendedor sin su pantalla.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
--  1. dashboard_resumen
-- ────────────────────────────────────────────────────────────────────────────
alter function public.dashboard_resumen(jsonb) rename to dashboard_resumen_interno;
revoke all on function public.dashboard_resumen_interno(jsonb) from public, anon, authenticated;

create or replace function public.dashboard_resumen(p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare v_id bigint; v_rol text;
begin
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.resolver_sesion_vendedor(p_data->>'token') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida o expirada');
  end if;
  -- Para restringir a admin, descomentar:
  -- if v_rol not in ('Admin','Administrador') then
  --   return jsonb_build_object('ok', false, 'error', 'No autorizado');
  -- end if;
  return public.dashboard_resumen_interno(p_data);
end $$;

-- ────────────────────────────────────────────────────────────────────────────
--  2. resumen_gastos
-- ────────────────────────────────────────────────────────────────────────────
alter function public.resumen_gastos(jsonb) rename to resumen_gastos_interno;
revoke all on function public.resumen_gastos_interno(jsonb) from public, anon, authenticated;

create or replace function public.resumen_gastos(p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare v_id bigint; v_rol text;
begin
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.resolver_sesion_vendedor(p_data->>'token') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida o expirada');
  end if;
  -- if v_rol not in ('Admin','Administrador') then
  --   return jsonb_build_object('ok', false, 'error', 'No autorizado');
  -- end if;
  return public.resumen_gastos_interno(p_data);
end $$;

-- ────────────────────────────────────────────────────────────────────────────
--  3. reporte_cobros
-- ────────────────────────────────────────────────────────────────────────────
--  Nota: index.html NO lo llama. Estaba expuesto sin usarse — superficie de
--  ataque gratuita. Se blinda igual en vez de borrarlo, por si algo externo lo
--  usa; si se confirma que nadie lo llama, conviene eliminarlo.
alter function public.reporte_cobros(jsonb) rename to reporte_cobros_interno;
revoke all on function public.reporte_cobros_interno(jsonb) from public, anon, authenticated;

create or replace function public.reporte_cobros(p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare v_id bigint; v_rol text;
begin
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.resolver_sesion_vendedor(p_data->>'token') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida o expirada');
  end if;
  -- if v_rol not in ('Admin','Administrador') then
  --   return jsonb_build_object('ok', false, 'error', 'No autorizado');
  -- end if;
  return public.reporte_cobros_interno(p_data);
end $$;

-- ────────────────────────────────────────────────────────────────────────────
--  4. obtener_vendedores
-- ────────────────────────────────────────────────────────────────────────────
--  Este es el que anulaba la Etapa A: la tabla `vendedores` quedó cerrada, pero
--  este RPC seguía entregando el mismo padrón con correos y teléfonos.
alter function public.obtener_vendedores(jsonb) rename to obtener_vendedores_interno;
revoke all on function public.obtener_vendedores_interno(jsonb) from public, anon, authenticated;

create or replace function public.obtener_vendedores(p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare v_id bigint; v_rol text;
begin
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.resolver_sesion_vendedor(p_data->>'token') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida o expirada');
  end if;
  return public.obtener_vendedores_interno(p_data);
end $$;

-- ────────────────────────────────────────────────────────────────────────────
--  5. obtener_pendientes_caja  (no recibía parámetros)
-- ────────────────────────────────────────────────────────────────────────────
alter function public.obtener_pendientes_caja() rename to obtener_pendientes_caja_interno;
revoke all on function public.obtener_pendientes_caja_interno() from public, anon, authenticated;

create or replace function public.obtener_pendientes_caja(p_token text default null)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare v_id bigint; v_rol text;
begin
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.resolver_sesion_vendedor(p_token) s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida o expirada');
  end if;
  return public.obtener_pendientes_caja_interno();
end $$;

-- ────────────────────────────────────────────────────────────────────────────
--  6. metricas_regalo_mes
-- ────────────────────────────────────────────────────────────────────────────
alter function public.metricas_regalo_mes(integer, integer) rename to metricas_regalo_mes_interno;
revoke all on function public.metricas_regalo_mes_interno(integer, integer) from public, anon, authenticated;

create or replace function public.metricas_regalo_mes(p_anio integer, p_mes integer, p_token text default null)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare v_id bigint; v_rol text;
begin
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.resolver_sesion_vendedor(p_token) s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida o expirada');
  end if;
  return public.metricas_regalo_mes_interno(p_anio, p_mes);
end $$;
