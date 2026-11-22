-- ============================================================================
--  La seccion «Costos» entra en el catalogo del servidor
--
--  Diseno: cambios/2026-11-21-frente-a-costos.md
--
--  Es una pantalla SOLO DEL DUENO, y por eso basta con anadirla a `todas`:
--  `sesion_secciones` devuelve `todas` cuando el rol esta en `roles_dueno`
--  ('admin', 'administrador') y NUNCA mira la lista personal en ese caso. Un
--  socio ('administrador2') o un vendedor solo la tendrian si alguien se la
--  pusiera a mano en `vendedores.secciones`, y nadie se la pone.
--
--  LA SEGUNDA CERRADURA (regla 41: RLS y GRANT son dos cerraduras distintas, y
--  aqui son la seccion y el RPC). Que la seccion no se conceda NO es lo que
--  protege el dato: `costos_resumen`, `margen_resumen` y `punto_equilibrio`
--  comprueban `sesion_es_dueno` por su cuenta. Si manana alguien anadiera
--  'costos' a la lista de un vendedor por error, veria la pantalla VACIA, no
--  los margenes. Esconder un boton no es un permiso (regla 35).
--
--  EL CUERPO SE GENERO DE `pg_get_functiondef` CONTRA PRODUCCION, no se
--  transcribio: el 21 nov una funcion copiada de staging llego con `dueÃ±o`
--  donde produccion tenia `dueño`, y solo se vio comparando md5(prosrc).
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sesion_secciones(p_token text)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
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
    'gastos','jornadas','productos','cupones','resumen','cuenta','armado','ruta',
    'reparto','entregas','costos'
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
  -- El rol vigente se relee de la tabla, no del token.
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
  -- Mismo añadido que hace la interfaz para mostrador (array_append, no ||).
  if v_rol_l = 'mostrador' then
    if not ('productos' = any(v_secs)) then v_secs := array_append(v_secs, 'productos'); end if;
    if not ('cupones'   = any(v_secs)) then v_secs := array_append(v_secs, 'cupones');   end if;
  end if;
  return v_secs;
end $function$
;

-- `create or replace` CONSERVA los permisos de la funcion que ya existia, pero
-- se deja explicito: esta solo la llaman los RPCs y el servidor, nunca el
-- navegador con la llave publica.
revoke all on function public.sesion_secciones(text) from public, anon, authenticated;
grant execute on function public.sesion_secciones(text) to service_role;
