-- 24 nov 2026 — Promociones y paquetes: la tabla y la administración.
-- El diseño, entero, en cambios/2026-11-24-promociones-diseno.md (pieza L1).
--
-- ESTA MIGRACIÓN NO CAMBIA NINGÚN PRECIO. Crea dónde viven las promociones y
-- cómo se administran; enchufarlas a `cotizar_linea` es la pieza siguiente y
-- va aparte a propósito: toca dinero y se prueba sola.
--
-- Las dos decisiones que la forman (D4 y D5 del diseño):
--  · Ninguna promoción se guarda sin mirar el margen que deja. El histórico
--    cerró en 9.2 % porque nadie veía el costo al lado del precio, y una
--    promoción es la forma más rápida de repetirlo. `promocion_margen` lo
--    calcula con el motor de costeo que ya existe y `guardar_promocion` la
--    rechaza por debajo del piso, salvo que se marque como gancho a propósito.
--  · Un paquete vive en el pedido COMO SUS LÍNEAS, con un id_promocion
--    compartido: kárdex, kg del lote, costeo y el editor ya trabajan por línea
--    y por SKU. Por eso aquí solo se añade UNA columna a ordenes_detalle.
--
-- 1. promociones, promocion_items, promocion_tramos — cerradas por RLS.
-- 2. ordenes_detalle.id_promocion.
-- 3. promocion_margen: el precio que queda y el margen, por SKU y por canal.
-- 4. RPCs del dueño: promociones_admin, guardar_promocion, borrar_promocion.

begin;

-- ── 1 ─────────────────────────────────────────────────────────────────────
create table if not exists public.promociones (
  id             bigserial primary key,
  nombre         text not null,
  descripcion    text not null default '',
  imagen         text,
  tipo           text not null check (tipo in ('porcentaje', 'precio_fijo', 'paquete')),
  valor          numeric not null check (valor > 0),
  publico        text not null check (publico in ('consumidores', 'tiendas', 'todos')),
  desde          date not null,
  hasta          date not null,
  activa         boolean not null default true,
  -- D3: por omisión NO se acumula con cupón. `descuento_cupon_para` aplica su
  -- porcentaje sobre el subtotal entero, así que sin esta bandera un cupón se
  -- montaría encima de una línea ya promocionada sin que nadie lo decidiera.
  acumulable_con_cupon boolean not null default false,
  -- Una promoción por debajo del piso de margen solo entra si se marca a
  -- propósito. Es una decisión, no un descuido.
  es_gancho      boolean not null default false,
  -- D6: lo que el banner NO tiene que saber. La promoción decide dónde cae.
  aterriza_en    text not null default 'promocion'
                 check (aterriza_en in ('promocion', 'catalogo', 'producto')),
  creado_por     text,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  check (hasta >= desde),
  check (tipo <> 'porcentaje' or valor <= 100)
);
alter table public.promociones enable row level security;
revoke all on table public.promociones from anon, authenticated;
comment on table public.promociones is
  'Promociones del catalogo y paquetes. El precio lo sigue cobrando el servidor; esta tabla es la REGLA, no el precio. Diseno: cambios/2026-11-24-promociones-diseno.md';

-- Qué cubre la promoción. Para 'paquete' cada fila es un componente y exige
-- SKU concreto; para las otras es un filtro (un SKU, un sabor, una
-- presentación, o sabor+presentación).
create table if not exists public.promocion_items (
  id            bigserial primary key,
  id_promocion  bigint not null references public.promociones(id) on delete cascade,
  id_producto   bigint references public.productos(id),
  sabor         text,
  presentacion  text,
  cantidad      integer not null default 1 check (cantidad > 0),
  check (id_producto is not null or coalesce(sabor,'') <> '' or coalesce(presentacion,'') <> '')
);
create index if not exists ix_promocion_items_promo on public.promocion_items(id_promocion);
alter table public.promocion_items enable row level security;
revoke all on table public.promocion_items from anon, authenticated;

-- D7: tramos por drop size. Vacío = un solo precio para todos.
create table if not exists public.promocion_tramos (
  id            bigserial primary key,
  id_promocion  bigint not null references public.promociones(id) on delete cascade,
  desde_monto   numeric not null check (desde_monto >= 0),
  valor         numeric not null check (valor > 0),
  unique (id_promocion, desde_monto)
);
alter table public.promocion_tramos enable row level security;
revoke all on table public.promocion_tramos from anon, authenticated;

-- ── 2 ─────────────────────────────────────────────────────────────────────
-- La única columna que cuesta D5. Sin `on delete cascade`: borrar una
-- promoción no puede borrar historia de ventas.
alter table public.ordenes_detalle
  add column if not exists id_promocion bigint references public.promociones(id) on delete set null;
comment on column public.ordenes_detalle.id_promocion is
  'Que promocion pago esta linea. Un paquete son varias lineas con el mismo id. 24 nov 2026.';

-- ── 3 ─────────────────────────────────────────────────────────────────────
-- El piso de margen vive en config_produccion para poder moverlo sin migrar.
-- 15 % es el umbral rojo que /productos ya usa en su semaforo.
insert into public.config_produccion (clave, valor)
select 'promociones', '{"piso_margen": 15}'::jsonb
where not exists (select 1 from public.config_produccion where clave = 'promociones');

-- Lo que una promoción le deja al negocio, SKU por SKU. Se mira siempre: al
-- guardar y al listar. Devuelve una fila por SKU afectado y canal aplicable.
create or replace function public.promocion_margen(p_promocion bigint)
returns table (
  id_producto bigint, sabor text, presentacion text, canal text,
  precio_lista numeric, precio_promo numeric, costo numeric, margen_pct numeric
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  pr public.promociones%rowtype;
begin
  select * into pr from public.promociones where id = p_promocion;
  if pr.id is null then return; end if;

  return query
  with canales as (
    select c.canal from (values ('consumidor'), ('tienda')) as c(canal)
    where (pr.publico = 'todos')
       or (pr.publico = 'consumidores' and c.canal = 'consumidor')
       or (pr.publico = 'tiendas'      and c.canal = 'tienda')
  ),
  -- Los SKU que toca: por id, por sabor, por presentacion, o por los dos.
  skus as (
    select distinct p.*
      from public.promocion_items i
      join public.productos p
        on (i.id_producto is not null and p.id = i.id_producto)
        or (i.id_producto is null
            and (coalesce(i.sabor, '') = '' or p.sabor = i.sabor)
            and (coalesce(i.presentacion, '') = '' or p.presentacion = i.presentacion))
     where i.id_promocion = p_promocion
       and coalesce(p.activo, true) and not coalesce(p.descontinuado, false)
  ),
  base as (
    select s.id, s.sabor, s.presentacion, c.canal,
           case c.canal when 'tienda' then s.precio_tienda else s.precio_consumidor end as lista
      from skus s cross join canales c
  )
  select b.id, b.sabor, b.presentacion, b.canal,
         round(b.lista, 2) as precio_lista,
         round(v.promo, 2) as precio_promo,
         round(ct.costo, 2) as costo,
         case when v.promo > 0 and ct.costo is not null
              then round((v.promo - ct.costo) / v.promo * 100, 1) end as margen_pct
    from base b
    cross join lateral (
      select case pr.tipo
               when 'porcentaje'  then b.lista * (1 - pr.valor / 100.0)
               when 'precio_fijo' then pr.valor
               -- En un paquete el valor es el % sobre el total del paquete, y
               -- se reparte en proporcion al valor de cada linea (D5), asi que
               -- cada SKU queda con el mismo porcentaje.
               else b.lista * (1 - pr.valor / 100.0)
             end as promo) v
    cross join lateral (select public.costo_sku(b.id, current_date) as costo) ct
   where b.lista is not null;
end;
$fn$;
revoke all on function public.promocion_margen(bigint) from public, anon, authenticated;

-- ── 4 ─────────────────────────────────────────────────────────────────────
-- VOLATILE a proposito, como `precios_admin` y `retos_admin`: PostgREST corre
-- una funcion `stable` en una transaccion de SOLO LECTURA, y comprobar la
-- sesion escribe -`resolver_sesion_vendedor` actualiza `ultimo_uso`-. Con
-- `stable` el RPC devuelve «cannot execute UPDATE in a read-only transaction»,
-- que en la pantalla se lee como «sin permiso».
create or replace function public.promociones_admin(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_piso numeric;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'solo_dueno');
  end if;
  select coalesce((valor->>'piso_margen')::numeric, 15) into v_piso
    from public.config_produccion where clave = 'promociones';

  return jsonb_build_object(
    'ok', true,
    'piso_margen', coalesce(v_piso, 15),
    'promociones', coalesce((
      select jsonb_agg(x order by x->>'nombre')
        from (
          select jsonb_build_object(
                   'id', pr.id, 'nombre', pr.nombre, 'descripcion', pr.descripcion,
                   'imagen', pr.imagen, 'tipo', pr.tipo, 'valor', pr.valor,
                   'publico', pr.publico, 'desde', pr.desde, 'hasta', pr.hasta,
                   'activa', pr.activa, 'acumulable_con_cupon', pr.acumulable_con_cupon,
                   'es_gancho', pr.es_gancho, 'aterriza_en', pr.aterriza_en,
                   'items', coalesce((select jsonb_agg(jsonb_build_object(
                              'id', i.id, 'idProducto', i.id_producto, 'sabor', i.sabor,
                              'presentacion', i.presentacion, 'cantidad', i.cantidad))
                              from public.promocion_items i where i.id_promocion = pr.id), '[]'::jsonb),
                   'tramos', coalesce((select jsonb_agg(jsonb_build_object(
                              'desdeMonto', t.desde_monto, 'valor', t.valor) order by t.desde_monto)
                              from public.promocion_tramos t where t.id_promocion = pr.id), '[]'::jsonb),
                   -- El margen viaja SIEMPRE con la promocion: es el dato que
                   -- hace falta para decidir, no un extra que se pide aparte.
                   'margen', coalesce((select jsonb_agg(jsonb_build_object(
                              'idProducto', m.id_producto, 'sabor', m.sabor,
                              'presentacion', m.presentacion, 'canal', m.canal,
                              'precioLista', m.precio_lista, 'precioPromo', m.precio_promo,
                              'costo', m.costo, 'margenPct', m.margen_pct))
                              from public.promocion_margen(pr.id) m), '[]'::jsonb),
                   'usada', exists (select 1 from public.ordenes_detalle d where d.id_promocion = pr.id)
                 ) as x
            from public.promociones pr
        ) s), '[]'::jsonb));
end;
$fn$;
revoke all on function public.promociones_admin(jsonb) from public, anon;
grant execute on function public.promociones_admin(jsonb) to anon, authenticated;

create or replace function public.guardar_promocion(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  j        jsonb := p_data->'promocion';
  v_id     bigint;
  v_act    public.promociones%rowtype;
  v_nombre text; v_tipo text; v_valor numeric; v_pub text; v_desde date; v_hasta date;
  v_activa boolean; v_acum boolean; v_gancho boolean; v_aterriza text; v_desc text; v_img text;
  v_items  jsonb; v_tramos jsonb; v_item jsonb;
  v_piso   numeric; v_peor numeric; v_actor text;
  v_n      integer;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'solo_dueno');
  end if;
  if j is null or jsonb_typeof(j) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'falta', 'mensaje', 'Falta la promoción.');
  end if;

  v_id := nullif(j->>'id', '')::bigint;
  if v_id is not null then
    select * into v_act from public.promociones where id = v_id;
    if v_act.id is null then return jsonb_build_object('ok', false, 'error', 'no_existe', 'mensaje', 'Esa promoción no existe.'); end if;
  end if;

  v_nombre   := coalesce(nullif(trim(j->>'nombre'), ''), v_act.nombre);
  v_desc     := coalesce(j->>'descripcion', v_act.descripcion, '');
  v_img      := coalesce(nullif(trim(j->>'imagen'), ''), v_act.imagen);
  v_tipo     := coalesce(nullif(lower(trim(j->>'tipo')), ''), v_act.tipo);
  v_pub      := coalesce(nullif(lower(trim(j->>'publico')), ''), v_act.publico, 'todos');
  v_aterriza := coalesce(nullif(lower(trim(j->>'aterrizaEn')), ''), v_act.aterriza_en, 'promocion');
  v_activa   := coalesce((j->>'activa')::boolean, v_act.activa, true);
  v_acum     := coalesce((j->>'acumulableConCupon')::boolean, v_act.acumulable_con_cupon, false);
  v_gancho   := coalesce((j->>'esGancho')::boolean, v_act.es_gancho, false);
  begin v_valor := coalesce(nullif(j->>'valor', '')::numeric, v_act.valor); exception when others then v_valor := null; end;
  begin
    v_desde := coalesce(nullif(j->>'desde', '')::date, v_act.desde);
    v_hasta := coalesce(nullif(j->>'hasta', '')::date, v_act.hasta);
  exception when others then v_desde := null; v_hasta := null; end;

  if v_nombre is null then return jsonb_build_object('ok', false, 'error', 'nombre', 'mensaje', 'Ponle nombre.'); end if;
  if v_tipo is null or v_tipo not in ('porcentaje', 'precio_fijo', 'paquete') then
    return jsonb_build_object('ok', false, 'error', 'tipo', 'mensaje', 'Tipo: porcentaje, precio_fijo o paquete.');
  end if;
  if v_valor is null or v_valor <= 0 then return jsonb_build_object('ok', false, 'error', 'valor', 'mensaje', 'El valor debe ser mayor que 0.'); end if;
  if v_tipo in ('porcentaje', 'paquete') and v_valor > 100 then
    return jsonb_build_object('ok', false, 'error', 'valor', 'mensaje', 'Un porcentaje no pasa de 100.');
  end if;
  if v_desde is null or v_hasta is null or v_hasta < v_desde then
    return jsonb_build_object('ok', false, 'error', 'fechas', 'mensaje', 'Fechas AAAA-MM-DD, y «hasta» no antes de «desde».');
  end if;

  v_items  := coalesce(j->'items', '[]'::jsonb);
  v_tramos := coalesce(j->'tramos', '[]'::jsonb);
  if jsonb_typeof(v_items) <> 'array' then v_items := '[]'::jsonb; end if;

  -- Si no vienen items y la promocion ya existe, se conservan los suyos.
  if jsonb_array_length(v_items) = 0 and v_id is not null then
    v_items := coalesce((select jsonb_agg(jsonb_build_object(
                 'idProducto', i.id_producto, 'sabor', i.sabor,
                 'presentacion', i.presentacion, 'cantidad', i.cantidad))
                 from public.promocion_items i where i.id_promocion = v_id), '[]'::jsonb);
  end if;
  if jsonb_array_length(v_items) = 0 then
    return jsonb_build_object('ok', false, 'error', 'items', 'mensaje', 'Di a qué productos aplica.');
  end if;
  if v_tipo = 'paquete' and jsonb_array_length(v_items) < 2 then
    return jsonb_build_object('ok', false, 'error', 'items', 'mensaje', 'Un paquete lleva al menos dos productos.');
  end if;

  -- Cada item, contra la base. Mismo criterio que /api/banners: un nombre que
  -- no existe no se guarda, porque falla en silencio meses despues.
  for v_item in select * from jsonb_array_elements(v_items) loop
    if nullif(v_item->>'idProducto', '') is not null then
      if not exists (select 1 from public.productos p where p.id = (v_item->>'idProducto')::bigint
                       and coalesce(p.activo, true) and not coalesce(p.descontinuado, false)) then
        return jsonb_build_object('ok', false, 'error', 'item', 'mensaje', 'Un producto de la lista no existe o está dado de baja.');
      end if;
    elsif v_tipo = 'paquete' then
      return jsonb_build_object('ok', false, 'error', 'item', 'mensaje', 'En un paquete cada producto se elige uno por uno.');
    else
      if coalesce(v_item->>'sabor', '') <> '' and not exists (select 1 from public.productos p where p.sabor = v_item->>'sabor') then
        return jsonb_build_object('ok', false, 'error', 'item', 'mensaje', 'El sabor «' || (v_item->>'sabor') || '» no existe en el catálogo.');
      end if;
      if coalesce(v_item->>'presentacion', '') <> '' and not exists (select 1 from public.productos p where p.presentacion = v_item->>'presentacion') then
        return jsonb_build_object('ok', false, 'error', 'item', 'mensaje', 'La presentación «' || (v_item->>'presentacion') || '» no existe.');
      end if;
    end if;
  end loop;

  select coalesce(v.nombre, 'alguien') into v_actor
    from public.resolver_sesion_vendedor(p_data->>'token') s
    join public.vendedores v on v.id = s.id_vendedor;

  if v_id is null then
    insert into public.promociones (nombre, descripcion, imagen, tipo, valor, publico, desde, hasta,
                                    activa, acumulable_con_cupon, es_gancho, aterriza_en, creado_por)
    values (v_nombre, v_desc, v_img, v_tipo, v_valor, v_pub, v_desde, v_hasta,
            v_activa, v_acum, v_gancho, v_aterriza, v_actor)
    returning id into v_id;
  else
    update public.promociones
       set nombre = v_nombre, descripcion = v_desc, imagen = v_img, tipo = v_tipo, valor = v_valor,
           publico = v_pub, desde = v_desde, hasta = v_hasta, activa = v_activa,
           acumulable_con_cupon = v_acum, es_gancho = v_gancho, aterriza_en = v_aterriza,
           actualizado_en = now()
     where id = v_id;
  end if;

  delete from public.promocion_items where id_promocion = v_id;
  insert into public.promocion_items (id_promocion, id_producto, sabor, presentacion, cantidad)
  select v_id, nullif(e->>'idProducto', '')::bigint, nullif(e->>'sabor', ''), nullif(e->>'presentacion', ''),
         greatest(1, coalesce(nullif(e->>'cantidad', '')::integer, 1))
    from jsonb_array_elements(v_items) e;

  delete from public.promocion_tramos where id_promocion = v_id;
  if jsonb_typeof(v_tramos) = 'array' then
    insert into public.promocion_tramos (id_promocion, desde_monto, valor)
    select v_id, (e->>'desdeMonto')::numeric, (e->>'valor')::numeric
      from jsonb_array_elements(v_tramos) e
     where nullif(e->>'desdeMonto','') is not null and nullif(e->>'valor','') is not null;
  end if;

  -- D4: el margen se mira SIEMPRE, y manda. Se calcula despues de guardar los
  -- items porque es lo que define que SKU toca; si no pasa el piso, se
  -- deshace la transaccion entera.
  select coalesce((valor->>'piso_margen')::numeric, 15) into v_piso
    from public.config_produccion where clave = 'promociones';
  v_piso := coalesce(v_piso, 15);
  select min(m.margen_pct), count(*) into v_peor, v_n from public.promocion_margen(v_id) m;

  if v_n = 0 then
    raise exception 'sin_skus';
  end if;
  if not v_gancho and v_peor is not null and v_peor < v_piso then
    raise exception 'margen_bajo:%:%', round(v_peor, 1), v_piso;
  end if;

  return jsonb_build_object('ok', true, 'id', v_id, 'peorMargen', v_peor, 'pisoMargen', v_piso,
    'margen', coalesce((select jsonb_agg(jsonb_build_object(
        'idProducto', m.id_producto, 'sabor', m.sabor, 'presentacion', m.presentacion,
        'canal', m.canal, 'precioLista', m.precio_lista, 'precioPromo', m.precio_promo,
        'costo', m.costo, 'margenPct', m.margen_pct)) from public.promocion_margen(v_id) m), '[]'::jsonb));
exception
  when others then
    if sqlerrm like 'margen_bajo:%' then
      return jsonb_build_object('ok', false, 'error', 'margen_bajo',
        'mensaje', 'Deja ' || split_part(sqlerrm, ':', 2) || ' % de margen y el piso es ' ||
                   split_part(sqlerrm, ':', 3) || ' %. Si es a propósito, márcala como promoción de gancho.');
    elsif sqlerrm = 'sin_skus' then
      return jsonb_build_object('ok', false, 'error', 'sin_skus', 'mensaje', 'Esa selección no toca ningún producto activo.');
    end if;
    raise;
end;
$fn$;
revoke all on function public.guardar_promocion(jsonb) from public, anon;
grant execute on function public.guardar_promocion(jsonb) to anon, authenticated;

-- Una promoción que ya cobró NO se borra: se apaga. Lo mismo que los retos con
-- bonos dados — borrarla dejaría líneas de pedido apuntando a nada.
create or replace function public.borrar_promocion(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v_id bigint;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'solo_dueno');
  end if;
  v_id := nullif(p_data->>'id', '')::bigint;
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'falta_id'); end if;
  if exists (select 1 from public.ordenes_detalle d where d.id_promocion = v_id) then
    update public.promociones set activa = false, actualizado_en = now() where id = v_id;
    return jsonb_build_object('ok', true, 'pausada', true,
      'mensaje', 'Ya se vendió con ella, así que se apagó en vez de borrarse.');
  end if;
  delete from public.promociones where id = v_id;
  return jsonb_build_object('ok', true, 'pausada', false);
end;
$fn$;
revoke all on function public.borrar_promocion(jsonb) from public, anon;
grant execute on function public.borrar_promocion(jsonb) to anon, authenticated;

commit;
