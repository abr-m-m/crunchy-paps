-- ============================================================================
--  Cerrar la escritura de catálogo y cupones + distinguir agotado de descontinuado
-- ----------------------------------------------------------------------------
--  DOS COSAS QUE VAN JUNTAS PORQUE TOCAN LAS MISMAS TABLAS
--
--  1) UN AGUJERO QUE CUESTA DINERO
--     `anon` podía escribir en `productos`, `productos_bebidas` y `cupones`.
--     Verificado: un PATCH con la llave publicada devolvía HTTP 204. Es decir,
--     cualquiera podía:
--       · poner `precio_consumidor = 1` en todo el catálogo
--       · crearse un cupón de descuento del 100% y usarlo
--     Lo segundo es peor: no hace falta ni que nadie se dé cuenta del cambio de
--     precios, basta con un código propio.
--
--  2) AGOTADO ≠ DESCONTINUADO (decisión de Abraham, 5 sep 2026)
--     Al empezar a aplicarse el filtro `activo = true`, los productos
--     desactivados dejaron de llegar al navegador. Pero `index.html` estaba
--     escrito para mostrarlos como "No disponible", y ese comportamiento es
--     deseable para lo agotado temporalmente — no para lo descontinuado.
--
--     Se resuelve SIN tocar la interfaz: `activo` conserva su significado
--     («se puede comprar ahora»), que es lo que la app ya usa para pintar
--     "No disponible". Se añade `descontinuado`, y es ESO lo que la política
--     oculta. Resultado:
--
--       activo=true,  descontinuado=false -> se compra
--       activo=false, descontinuado=false -> se ve, marcado "No disponible"
--       cualquiera,   descontinuado=true  -> no llega al navegador
--
--     La interfaz existente sigue funcionando sin cambios.
--
--  Producción tiene hoy 0 productos inactivos (35 y 2), así que el relleno es
--  trivial y nadie nota nada al aplicarlo.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
--  1. Columna `descontinuado`
-- ────────────────────────────────────────────────────────────────────────────
alter table public.productos
  add column if not exists descontinuado boolean not null default false;
alter table public.productos_bebidas
  add column if not exists descontinuado boolean not null default false;

comment on column public.productos.descontinuado is
  'true = fuera del catálogo, no llega al navegador. Distinto de activo=false, que significa agotado temporalmente y SÍ se muestra como "No disponible".';
comment on column public.productos_bebidas.descontinuado is
  'true = fuera del catálogo. Ver productos.descontinuado.';

-- ────────────────────────────────────────────────────────────────────────────
--  2. La política oculta lo descontinuado, no lo agotado
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare p record;
begin
  for p in
    select tablename, policyname from pg_policies
     where schemaname='public' and tablename in ('productos','productos_bebidas')
       and 'anon' = any(roles) and cmd in ('SELECT','ALL')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

create policy "Catálogo público (oculta lo descontinuado)"
  on public.productos for select to anon, authenticated
  using (descontinuado = false);

create policy "Bebidas públicas (oculta lo descontinuado)"
  on public.productos_bebidas for select to anon, authenticated
  using (descontinuado = false);

-- ────────────────────────────────────────────────────────────────────────────
--  3. Cerrar la escritura
-- ────────────────────────────────────────────────────────────────────────────
revoke insert, update, delete, truncate on public.productos         from anon;
revoke insert, update, delete, truncate on public.productos_bebidas from anon;
revoke insert, update, delete, truncate on public.cupones           from anon;

-- ────────────────────────────────────────────────────────────────────────────
--  4. RPCs de escritura, con sesión y lista blanca de columnas
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.actualizar_producto(p_data jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id_vend bigint;
  v_id      bigint := (p_data->>'id')::bigint;
  v_campos  jsonb  := coalesce(p_data->'campos', '{}'::jsonb);
  v_clave   text;
  v_permitidas constant text[] := array[
    'sabor','presentacion','gramos','precio_consumidor','precio_tienda',
    'precio_restaurante','precio_mostrador','precio_granel_kg','precio_mayorista',
    'tipo_venta','activo','descontinuado','imagen_url','descuento_pct',
    'descripcion','orden'
  ];
begin
  select s.id_vendedor into v_id_vend
    from public.sesion_exige_seccion(p_data->>'token', 'productos') s;
  if v_id_vend is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'Falta id');
  end if;

  for v_clave in select jsonb_object_keys(v_campos) loop
    if not (v_clave = any(v_permitidas)) then
      return jsonb_build_object('ok', false, 'error', 'Campo no permitido: ' || v_clave);
    end if;
  end loop;

  update public.productos p set
    sabor              = coalesce(v_campos->>'sabor', p.sabor),
    presentacion       = coalesce(v_campos->>'presentacion', p.presentacion),
    gramos             = coalesce((v_campos->>'gramos')::numeric, p.gramos),
    precio_consumidor  = coalesce((v_campos->>'precio_consumidor')::numeric, p.precio_consumidor),
    precio_tienda      = coalesce((v_campos->>'precio_tienda')::numeric, p.precio_tienda),
    precio_restaurante = coalesce((v_campos->>'precio_restaurante')::numeric, p.precio_restaurante),
    precio_mostrador   = coalesce((v_campos->>'precio_mostrador')::numeric, p.precio_mostrador),
    precio_granel_kg   = coalesce((v_campos->>'precio_granel_kg')::numeric, p.precio_granel_kg),
    precio_mayorista   = coalesce((v_campos->>'precio_mayorista')::numeric, p.precio_mayorista),
    tipo_venta         = coalesce((v_campos->>'tipo_venta')::int, p.tipo_venta),
    activo             = coalesce((v_campos->>'activo')::boolean, p.activo),
    descontinuado      = coalesce((v_campos->>'descontinuado')::boolean, p.descontinuado),
    imagen_url         = coalesce(v_campos->>'imagen_url', p.imagen_url),
    descuento_pct      = coalesce((v_campos->>'descuento_pct')::numeric, p.descuento_pct),
    descripcion        = coalesce(v_campos->>'descripcion', p.descripcion),
    orden              = coalesce((v_campos->>'orden')::smallint, p.orden),
    fecha_actualizacion = now()
  where p.id = v_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Producto no encontrado');
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- Crear o actualizar una bebida. Se unifican porque el panel usa el mismo
-- formulario para las dos cosas.
create or replace function public.guardar_bebida(p_data jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id_vend bigint;
  v_id      bigint := nullif(p_data->>'id','')::bigint;
  v_c       jsonb  := coalesce(p_data->'campos', '{}'::jsonb);
begin
  select s.id_vendedor into v_id_vend
    from public.sesion_exige_seccion(p_data->>'token', 'productos') s;
  if v_id_vend is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  if v_id is null then
    if coalesce(v_c->>'nombre','') = '' or coalesce(v_c->>'tipo_bebida','') = '' then
      return jsonb_build_object('ok', false, 'error', 'Faltan nombre y tipo de bebida');
    end if;
    insert into public.productos_bebidas
      (nombre, categoria, tipo_bebida, sabor, presentacion, precio, codigo_barras,
       imagen_url, activo, descripcion, orden, descontinuado)
    values
      (v_c->>'nombre', v_c->>'categoria', v_c->>'tipo_bebida', v_c->>'sabor',
       v_c->>'presentacion', (v_c->>'precio')::numeric, v_c->>'codigo_barras',
       v_c->>'imagen_url', coalesce((v_c->>'activo')::boolean, true),
       v_c->>'descripcion', (v_c->>'orden')::smallint,
       coalesce((v_c->>'descontinuado')::boolean, false))
    returning id into v_id;
    return jsonb_build_object('ok', true, 'id', v_id, 'creado', true);
  end if;

  update public.productos_bebidas b set
    nombre        = coalesce(v_c->>'nombre', b.nombre),
    categoria     = coalesce(v_c->>'categoria', b.categoria),
    tipo_bebida   = coalesce(v_c->>'tipo_bebida', b.tipo_bebida),
    sabor         = coalesce(v_c->>'sabor', b.sabor),
    presentacion  = coalesce(v_c->>'presentacion', b.presentacion),
    precio        = coalesce((v_c->>'precio')::numeric, b.precio),
    codigo_barras = coalesce(v_c->>'codigo_barras', b.codigo_barras),
    imagen_url    = coalesce(v_c->>'imagen_url', b.imagen_url),
    activo        = coalesce((v_c->>'activo')::boolean, b.activo),
    descontinuado = coalesce((v_c->>'descontinuado')::boolean, b.descontinuado),
    descripcion   = coalesce(v_c->>'descripcion', b.descripcion),
    orden         = coalesce((v_c->>'orden')::smallint, b.orden),
    fecha_actualizacion = now()
  where b.id = v_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Bebida no encontrada');
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'creado', false);
end;
$$;

-- Cupones: crear o actualizar. Es la tabla con los CÓDIGOS de descuento, así
-- que escribir aquí es poder regalarse dinero.
create or replace function public.guardar_cupon(p_data jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id_vend bigint;
  v_id      bigint := nullif(p_data->>'id','')::bigint;
  v_c       jsonb  := coalesce(p_data->'campos', '{}'::jsonb);
begin
  select s.id_vendedor into v_id_vend
    from public.sesion_exige_seccion(p_data->>'token', 'cupones') s;
  if v_id_vend is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  if v_id is null then
    if coalesce(v_c->>'codigo','') = '' then
      return jsonb_build_object('ok', false, 'error', 'Falta el código');
    end if;
    insert into public.cupones (codigo, descripcion, tipo, valor, activo,
                                fecha_inicio, fecha_fin, usos_maximos, monto_minimo)
    values (upper(trim(v_c->>'codigo')), v_c->>'descripcion',
            coalesce(nullif(v_c->>'tipo',''), 'descuento_pct'),
            (v_c->>'valor')::numeric, coalesce((v_c->>'activo')::boolean, true),
            (v_c->>'fecha_inicio')::timestamptz, (v_c->>'fecha_fin')::timestamptz,
            (v_c->>'usos_maximos')::int, (v_c->>'monto_minimo')::numeric)
    returning id into v_id;
    return jsonb_build_object('ok', true, 'id', v_id, 'creado', true);
  end if;

  update public.cupones c set
    descripcion  = coalesce(v_c->>'descripcion', c.descripcion),
    tipo         = coalesce(v_c->>'tipo', c.tipo),
    valor        = coalesce((v_c->>'valor')::numeric, c.valor),
    activo       = coalesce((v_c->>'activo')::boolean, c.activo),
    fecha_inicio = coalesce((v_c->>'fecha_inicio')::timestamptz, c.fecha_inicio),
    fecha_fin    = coalesce((v_c->>'fecha_fin')::timestamptz, c.fecha_fin),
    usos_maximos = coalesce((v_c->>'usos_maximos')::int, c.usos_maximos),
    monto_minimo = coalesce((v_c->>'monto_minimo')::numeric, c.monto_minimo)
  where c.id = v_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Cupón no encontrado');
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'creado', false);
end;
$$;
