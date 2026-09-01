-- ============================================================================
--  Políticas anuladas por una política `true` al lado
-- ----------------------------------------------------------------------------
--  EL HALLAZGO
--  -----------
--  Tres tablas tenían una política acotada Y otra permisiva a la vez:
--
--    productos          (activo = true)  +  true
--    productos_bebidas  (activo = true)  +  true
--    cupones            (activo = true)  +  true
--
--  En Postgres las políticas PERMISIVAS se combinan con OR. La política `true`
--  que está al lado **anula por completo** el filtro `activo = true`. El
--  acotado que parecía proteger esas tablas no hacía absolutamente nada.
--
--  Es de los fallos que peor se ven en una revisión rápida: la política
--  correcta está ahí, escrita, y da la impresión de que el trabajo está hecho.
--
--  CONSECUENCIA CONCRETA
--  ---------------------
--  · `cupones` se podía leer entera, con los CÓDIGOS de descuento, incluidos
--    los inactivos. Cualquiera con la llave publicada podía cosecharlos.
--  · `productos` y `productos_bebidas` exponían los artículos DESACTIVADOS:
--    descontinuados, o productos aún no lanzados.
--
--  QUÉ SE HACE
--  -----------
--  · `cupones`: se cierra del todo. La app solo la lee desde el panel de admin
--    (un único GET), y el cliente nunca la consulta — los cupones se validan
--    por `validar_cupon`, que es un RPC. Se añade `obtener_cupones` con sesión.
--  · `productos` y `productos_bebidas`: se elimina la política `true` para que
--    el filtro `activo = true` empiece a aplicarse de verdad. El panel de admin
--    necesita ver también los inactivos, así que pasa por `obtener_catalogo_admin`.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
--  1. Eliminar las políticas permisivas que anulaban el acotado
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare p record;
begin
  for p in
    select tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and tablename in ('productos', 'productos_bebidas', 'cupones')
       and 'anon' = any(roles)
       and cmd in ('SELECT', 'ALL')
       -- Solo las que NO filtran nada: se conservan las de `activo = true`.
       and (qual is null or btrim(qual) = 'true')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
    raise notice 'Eliminada política permisiva % en %', p.policyname, p.tablename;
  end loop;
end $$;

-- `cupones` se cierra por completo: el cliente no la lee nunca.
revoke select on public.cupones from anon;

comment on table public.cupones is
  'RLS (5 sep 2026): CERRADA a anon. Contiene los CÓDIGOS de descuento. Se leía entera porque una política `true` anulaba el filtro `activo = true`. El cliente valida cupones por validar_cupon (RPC); el panel usa obtener_cupones.';
comment on table public.productos is
  'RLS (5 sep 2026): anon solo ve `activo = true`. Antes una política `true` al lado anulaba ese filtro y exponía los productos desactivados. El panel usa obtener_catalogo_admin.';
comment on table public.productos_bebidas is
  'RLS (5 sep 2026): anon solo ve `activo = true`. Mismo caso que productos.';

-- ────────────────────────────────────────────────────────────────────────────
--  2. Lectura de cupones para el panel
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.obtener_cupones(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id    bigint;
  v_filas jsonb;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'cupones') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.fecha_creacion desc), '[]'::jsonb)
    into v_filas
    from (select c.* from public.cupones c order by c.fecha_creacion desc limit 500) t;

  return jsonb_build_object('ok', true, 'cupones', v_filas);
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
--  3. Catálogo completo para el panel (incluye desactivados)
-- ────────────────────────────────────────────────────────────────────────────
--  El cliente ve solo lo activo por política; el panel necesita todo para poder
--  reactivar un producto o revisar un descontinuado.
create or replace function public.obtener_catalogo_admin(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id    bigint;
  v_prod  jsonb;
  v_beb   jsonb;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'productos') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.sabor, t.presentacion), '[]'::jsonb)
    into v_prod from (select p.* from public.productos p) t;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb)
    into v_beb from (select b.* from public.productos_bebidas b) t;

  return jsonb_build_object('ok', true, 'productos', v_prod, 'bebidas', v_beb);
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
--  4. Búsqueda de bebida por código de barras (panel)
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.buscar_bebida_por_codigo(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id     bigint;
  v_codigo text := trim(coalesce(p_data->>'codigo', ''));
  v_filas  jsonb;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'productos') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  if v_codigo = '' then
    return jsonb_build_object('ok', true, 'bebidas', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) into v_filas
    from public.productos_bebidas b where b.codigo_barras = v_codigo;

  return jsonb_build_object('ok', true, 'bebidas', v_filas);
end;
$$;
