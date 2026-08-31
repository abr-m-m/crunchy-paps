-- ============================================================================
--  PERMISOS POR SECCIÓN, APLICADOS EN EL SERVIDOR
-- ----------------------------------------------------------------------------
--  EL PROBLEMA
--  -----------
--  El proyecto YA tiene un modelo de permisos bueno: `config_secciones` define
--  las secciones por rol, y `vendedores.secciones` permite un override por
--  persona. Pero se aplicaba SOLO en el navegador (`aplicarPermisosNavbar`
--  esconde elementos del menú). Esconder un botón no es un permiso: el RPC
--  seguía respondiendo a quien lo llamara.
--
--  Consecuencia concreta con la configuración real de producción: el rol
--  `vendedor` NO tiene `gastos` ni `caja` ni `b2b`, pero un vendedor
--  autenticado podía llamar `resumen_gastos` y ver los gastos de la empresa.
--  El menú se lo ocultaba; la base se los daba.
--
--  QUÉ HACE ESTA MIGRACIÓN
--  -----------------------
--  Traslada ese mismo modelo al servidor, sin inventar roles nuevos:
--    sesion_secciones(token)          -> secciones efectivas de esa sesión
--    sesion_exige_seccion(token, sec) -> identidad si la tiene, nada si no
--  Y hace que cada RPC de finanzas exija SU sección.
--
--  ⚠️ CAMBIO DE COMPORTAMIENTO DELIBERADO: EL ATAJO DE ADMIN SE ESTRECHA
--  --------------------------------------------------------------------
--  En el navegador, `esAdmin()` devuelve true para CUALQUIER rol que empiece
--  con "admin" (y también para 'mostrador'), y `_seccionesEfectivasVendedor`
--  le concede TODAS las secciones. Eso significa que un rol `administrador2`
--  —el perfil de socio— ve absolutamente todo, y darle un override individual
--  no sirve de nada porque el atajo gana primero.
--
--  Aquí el atajo se limita a los roles EXACTOS 'admin' y 'administrador'.
--  Cualquier otro rol, `administrador2` incluido, pasa por el camino normal:
--  override individual -> secciones del rol -> mínimo.
--
--  Efecto práctico para `administrador2` con la configuración de hoy: conserva
--  todo lo que su rol ya tenía (catalogo, pedidos, premia, b2b, produccion,
--  prospeccion, caja, gastos, jornadas, productos, cupones, cuenta) y pierde
--  solo `resumen` (el dashboard de ventas), que ningún rol tiene configurado.
--  A partir de ahí se le recorta por override individual, que es justo lo que
--  hacía falta para dar acceso parcial a finanzas.
--
--  Si prefieres que `administrador2` siga viendo todo, añade su rol a la lista
--  ROLES_DUEÑO de la función sesion_secciones. Es una línea.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
--  1. SECCIONES EFECTIVAS DE UNA SESIÓN
-- ────────────────────────────────────────────────────────────────────────────
--  Reproduce la misma precedencia que `get_secciones_usuario` y
--  `_seccionesEfectivasVendedor`, pero partiendo del TOKEN, no de un idVendedor
--  que el cliente pueda inventar.
create or replace function public.sesion_secciones(p_token text)
returns text[]
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id      bigint;
  v_rol     text;
  v_rol_l   text;
  v_over    text[];
  v_secs    text[];
  -- Roles con acceso total. Deliberadamente EXACTOS: 'administrador2' NO está
  -- aquí, para que los perfiles de socio se puedan recortar por override.
  roles_dueno constant text[] := array['admin', 'administrador'];
  -- Catálogo completo, igual que NAV_ITEM_POR_SECCION en index.html.
  todas constant text[] := array[
    'catalogo','pedidos','premia','b2b','produccion','prospeccion','caja',
    'gastos','jornadas','productos','cupones','resumen','cuenta'
  ];
begin
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.resolver_sesion_vendedor(p_token) s;

  if v_id is null then
    return array[]::text[];               -- sin sesión, sin secciones
  end if;

  v_rol_l := lower(trim(coalesce(v_rol, '')));

  if v_rol_l = any(roles_dueno) then
    return todas;
  end if;

  -- El rol vigente se relee de la tabla, no del token: si le cambias el rol a
  -- alguien, el cambio surte efecto sin esperar a que expire su sesión.
  select lower(trim(v.rol)), v.secciones into v_rol_l, v_over
    from public.vendedores v
   where v.id = v_id and v.activo = true;

  if v_rol_l is null then
    return array[]::text[];               -- vendedor desactivado
  end if;

  if v_rol_l = any(roles_dueno) then
    return todas;
  end if;

  if v_over is not null and array_length(v_over, 1) > 0 then
    v_secs := v_over;                     -- override individual manda
  else
    select c.secciones into v_secs
      from public.config_secciones c where lower(c.rol) = v_rol_l;
    if v_secs is null then
      v_secs := array['catalogo','pedidos','cuenta'];   -- mínimo seguro
    end if;
  end if;

  -- Mismo añadido que hace la interfaz para mostrador.
  -- array_append, no `||`: con `||` Postgres intenta leer la cadena como
  -- literal de array y falla con "malformed array literal".
  if v_rol_l = 'mostrador' then
    if not ('productos' = any(v_secs)) then v_secs := array_append(v_secs, 'productos'); end if;
    if not ('cupones'   = any(v_secs)) then v_secs := array_append(v_secs, 'cupones');   end if;
  end if;

  return v_secs;
end;
$$;

revoke all on function public.sesion_secciones(text) from public, anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
--  2. GUARDA REUTILIZABLE
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.sesion_exige_seccion(p_token text, p_seccion text)
returns table (id_vendedor bigint, rol text)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare v_secs text[];
begin
  v_secs := public.sesion_secciones(p_token);
  if not (p_seccion = any(v_secs)) then
    return;                               -- no tiene la sección: nada
  end if;
  return query select s.id_vendedor, s.rol
                 from public.resolver_sesion_vendedor(p_token) s;
end;
$$;

revoke all on function public.sesion_exige_seccion(text, text) from public, anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
--  3. "¿QUÉ PUEDO VER YO?" — sin poder preguntar por otros
-- ────────────────────────────────────────────────────────────────────────────
--  `get_secciones_usuario` recibe idVendedor como PARÁMETRO: cualquiera podía
--  pedir las secciones de cualquier vendedor. Se conserva para el caso del
--  consumidor (que no tiene sesión), pero ahora, si se le pasa un token, la
--  identidad sale del token y el idVendedor recibido se ignora.
create or replace function public.mis_secciones(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare v_secs text[]; v_id bigint; v_rol text;
begin
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.resolver_sesion_vendedor(p_token) s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida o expirada');
  end if;
  v_secs := public.sesion_secciones(p_token);
  return jsonb_build_object('ok', true, 'secciones', to_jsonb(v_secs),
                            'rol', v_rol, 'idVendedor', v_id);
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
--  4. LAS ENVOLTURAS DE FINANZAS AHORA EXIGEN SU SECCIÓN
-- ────────────────────────────────────────────────────────────────────────────
--  resumen  -> dashboard de ventas y métricas
--  gastos   -> gastos
--  caja     -> cobros y pendientes de caja
--  b2b      -> padrón de vendedores (selectores del panel B2B)

create or replace function public.dashboard_resumen(p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'resumen') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.dashboard_resumen_interno(p_data);
end $$;

create or replace function public.metricas_regalo_mes(p_anio integer, p_mes integer, p_token text default null)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_token, 'resumen') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.metricas_regalo_mes_interno(p_anio, p_mes);
end $$;

create or replace function public.resumen_gastos(p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'gastos') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.resumen_gastos_interno(p_data);
end $$;

create or replace function public.reporte_cobros(p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'caja') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.reporte_cobros_interno(p_data);
end $$;

create or replace function public.obtener_pendientes_caja(p_token text default null)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_token, 'caja') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.obtener_pendientes_caja_interno();
end $$;

create or replace function public.obtener_vendedores(p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare v_id bigint;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'b2b') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  return public.obtener_vendedores_interno(p_data);
end $$;

-- ────────────────────────────────────────────────────────────────────────────
--  NOTA SOBRE `resumen`
-- ────────────────────────────────────────────────────────────────────────────
--  Ningún rol de config_secciones incluye 'resumen' hoy: el dashboard se veía
--  solo por el atajo de admin del navegador. Con esta migración, un socio que
--  deba ver el dashboard necesita 'resumen' en su override individual. Es
--  exactamente la palanca que faltaba para dar acceso parcial a finanzas.
