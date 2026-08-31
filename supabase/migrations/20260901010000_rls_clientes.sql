-- ============================================================================
--  RLS — ETAPA B, primera tabla: `clientes`
-- ----------------------------------------------------------------------------
--  Cierra `clientes` a anon y mueve las 4 lecturas directas del navegador a
--  RPCs que EXIGEN una sesión de vendedor (ver 20260901000000_sesiones_vendedor).
--
--  Lo que estaba expuesto hasta hoy: los 40 clientes reales con nombre,
--  teléfono, dirección, coordenadas GPS y RFC, legibles Y BORRABLES por
--  cualquiera con la llave anon publicada en este repo. Es el corazón del
--  §3.0 de ACCESOS.md y cae bajo la LFPDPPP.
--
--  LAS 4 LLAMADAS QUE SE SUSTITUYEN (index.html)
--    9533  clientes?or=(nombre.ilike,telefono.ilike)&select=*&limit=10  -> buscar_clientes
--    9977  clientes?id=eq.N&select=telefono                             -> obtener_telefono_cliente
--    9998  clientes?id=eq.N&select=telefono                             -> obtener_telefono_cliente
--    10819 clientes?select=*&order=fecha_creacion.desc                  -> obtener_clientes
--
--  REGLA DE AUTORIZACIÓN
--    Admin      -> ve todos los clientes
--    Vendedor   -> ve únicamente los suyos (clientes.id_vendedor = su id)
--    Sin token  -> no ve nada
--
--  El filtro por vendedor deja de ser una decisión del navegador
--  (`if (esVendedor && !esAdmin())`) y pasa a ser del servidor. Antes, un
--  vendedor podía ver el padrón completo borrando esa condición en DevTools.
--
--  BONUS: `obtener_clientes` pagina de verdad (limit/offset + total). Eso
--  ataca de paso los hallazgos 01 y 03 — `select=*` sin límite real.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
--  1. LISTADO PAGINADO
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.obtener_clientes(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id_vendedor bigint;
  v_rol         text;
  v_limit       int  := least(coalesce((p_data->>'limit')::int, 50), 200);
  v_offset      int  := greatest(coalesce((p_data->>'offset')::int, 0), 0);
  v_es_admin    boolean;
  v_total       bigint;
  v_filas       jsonb;
begin
  select s.id_vendedor, s.rol into v_id_vendedor, v_rol
    from public.resolver_sesion_vendedor(p_data->>'token') s;

  if v_id_vendedor is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida o expirada');
  end if;

  v_es_admin := v_rol in ('Admin', 'Administrador');

  select count(*) into v_total
    from public.clientes c
   where v_es_admin or c.id_vendedor = v_id_vendedor;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.fecha_creacion desc), '[]'::jsonb)
    into v_filas
    from (
      select c.*
        from public.clientes c
       where v_es_admin or c.id_vendedor = v_id_vendedor
       order by c.fecha_creacion desc
       limit v_limit offset v_offset
    ) t;

  return jsonb_build_object(
    'ok', true, 'clientes', v_filas, 'total', v_total,
    'limit', v_limit, 'offset', v_offset
  );
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
--  2. BÚSQUEDA
-- ────────────────────────────────────────────────────────────────────────────
--  El texto va por parámetro y se compone con `like`: no hay concatenación de
--  SQL, así que no hay superficie de inyección.
create or replace function public.buscar_clientes(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id_vendedor bigint;
  v_rol         text;
  v_q           text := trim(coalesce(p_data->>'q', ''));
  v_es_admin    boolean;
  v_filas       jsonb;
begin
  select s.id_vendedor, s.rol into v_id_vendedor, v_rol
    from public.resolver_sesion_vendedor(p_data->>'token') s;

  if v_id_vendedor is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida o expirada');
  end if;

  -- Mínimo 2 caracteres: evita que una búsqueda vacía haga de volcado.
  if length(v_q) < 2 then
    return jsonb_build_object('ok', true, 'clientes', '[]'::jsonb);
  end if;

  v_es_admin := v_rol in ('Admin', 'Administrador');

  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
    into v_filas
    from (
      select c.*
        from public.clientes c
       where (v_es_admin or c.id_vendedor = v_id_vendedor)
         and (c.nombre ilike '%' || v_q || '%'
              or regexp_replace(coalesce(c.telefono,''), '\D', '', 'g')
                 ilike '%' || regexp_replace(v_q, '\D', '', 'g') || '%')
       order by c.nombre
       limit 10
    ) t;

  return jsonb_build_object('ok', true, 'clientes', v_filas);
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
--  3. TELÉFONO DE UN CLIENTE
-- ────────────────────────────────────────────────────────────────────────────
--  Devuelve un solo dato y nada más. Antes esto era
--  `clientes?id=eq.N&select=telefono`, que cualquiera podía recorrer en bucle
--  de 1 a 10000 para cosechar la agenda completa.
create or replace function public.obtener_telefono_cliente(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id_vendedor bigint;
  v_rol         text;
  v_id_cliente  bigint := (p_data->>'idCliente')::bigint;
  v_es_admin    boolean;
  v_tel         text;
begin
  select s.id_vendedor, s.rol into v_id_vendedor, v_rol
    from public.resolver_sesion_vendedor(p_data->>'token') s;

  if v_id_vendedor is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida o expirada');
  end if;

  if v_id_cliente is null then
    return jsonb_build_object('ok', false, 'error', 'Falta idCliente');
  end if;

  v_es_admin := v_rol in ('Admin', 'Administrador');

  select c.telefono into v_tel
    from public.clientes c
   where c.id = v_id_cliente
     and (v_es_admin or c.id_vendedor = v_id_vendedor);

  if v_tel is null then
    return jsonb_build_object('ok', false, 'error', 'Cliente no encontrado');
  end if;

  return jsonb_build_object('ok', true, 'telefono', v_tel);
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
--  4. CERRAR `clientes` A anon
-- ────────────────────────────────────────────────────────────────────────────
--  Las escrituras del cliente final no se ven afectadas: pasan por
--  registrar_o_actualizar_cliente, set_ubicacion_cliente, set_opt_in_promos y
--  demás, todos SECURITY DEFINER, que ignoran RLS por correr como postgres.

do $$
declare p text;
begin
  for p in select policyname from pg_policies
            where schemaname='public' and tablename='clientes' and 'anon' = any(roles)
  loop
    execute format('drop policy %I on public.clientes', p);
    raise notice 'Eliminada política % en clientes', p;
  end loop;
end $$;

revoke select, insert, update, delete, truncate on public.clientes from anon;

comment on table public.clientes is
  'RLS Etapa B (31 ago 2026): sin acceso directo de anon. Datos personales bajo LFPDPPP. Lectura por obtener_clientes / buscar_clientes / obtener_telefono_cliente, que exigen sesión de vendedor. Escritura por RPCs SECURITY DEFINER. NUNCA reabrir a anon.';
