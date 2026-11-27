-- 27 nov 2026 — El restaurante es un canal propio, y cada promocion tiene CLAVE
--
-- Abraham, probando el Excel de diciembre: «Canal: ¿por que restaurante entra
-- en tienda? Cada uno es independiente».
--
-- Tenia razon. Hasta hoy `promocion_mejor` metia al restaurante en el publico
-- «tiendas», y ademas `promocion_margen` NO lo miraba al comprobar el piso: se
-- le cobraba con `precio_restaurante` un descuento aprobado sobre
-- `precio_tienda`. Hoy no hacia daño -el precio de restaurante esta entre
-- 7.7 % y 10.4 % por encima del de tienda, asi que deja mas margen-, pero eso
-- es suerte, no una garantia, y bastaba con que bajara un precio para que el
-- piso dejara de proteger un canal EN SILENCIO.
--
-- Se puede cambiar sin romper nada porque se miro antes: las 4 promociones que
-- existen (1 en produccion, 3 en staging) son TODAS de publico «todos», asi que
-- ninguna cambia de destinatario con esto.
--
-- Y la CLAVE. El importador del Excel era idempotente por NOMBRE: cambiar el
-- titulo de una promocion en la hoja no la corregia, CREABA OTRA. Ahora cada
-- promocion tiene una clave estable -`CP2612-C01`: Crunchy Paps, año y mes de
-- la vigencia, publico, consecutivo- que la genera el servidor cuando la celda
-- viene vacia. El nombre vuelve a ser lo que es: el titulo que ve el cliente.

begin;

-- ── 1. El catalogo de publicos ────────────────────────────────────────────
alter table public.promociones drop constraint if exists promociones_publico_check;
alter table public.promociones add constraint promociones_publico_check
  check (publico in ('consumidores', 'tiendas', 'restaurantes', 'todos'));

-- ── 2. La clave ───────────────────────────────────────────────────────────
alter table public.promociones add column if not exists clave text;
-- UNICA, porque es una identidad. Parcial: las promociones viejas pueden no
-- tenerla todavia y NULL no choca con NULL.
create unique index if not exists promociones_clave_uk
  on public.promociones (clave) where clave is not null;
comment on column public.promociones.clave is
  'Identidad estable de la promocion (CP2612-C01). La genera promocion_clave_nueva si no se da. 27 nov 2026.';

-- ── 3. Quien genera la clave ──────────────────────────────────────────────
create or replace function public.promocion_clave_nueva(p_desde date, p_publico text)
returns text language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_pre text;
  v_n   int;
begin
  v_pre := 'CP' || to_char(coalesce(p_desde, current_date), 'YYMM') || '-' ||
           case lower(coalesce(p_publico, 'todos'))
             when 'consumidores' then 'C'
             when 'tiendas'      then 'T'
             when 'restaurantes' then 'R'
             else 'X' end;
  -- El consecutivo sale de lo que YA existe con ese prefijo, no de un contador
  -- aparte: un contador y la tabla se separan el dia que alguien borra una
  -- fila, y entonces la clave choca contra el indice unico.
  select coalesce(max(nullif(regexp_replace(pr.clave, '^.*[^0-9]', ''), '')::int), 0) + 1
    into v_n
    from public.promociones pr
   where pr.clave like v_pre || '%';
  return v_pre || lpad(v_n::text, 2, '0');
end;
$fn$;
revoke all on function public.promocion_clave_nueva(date, text) from public, anon, authenticated;
comment on function public.promocion_clave_nueva(date, text) is
  'La siguiente clave libre de ese mes y ese publico. 27 nov 2026.';


-- ── 3b. Las promociones de antes tambien tienen identidad ─────────────────
-- Sin esto se quedarian con clave NULL hasta que alguien volviera a guardarlas,
-- y una promocion sin identidad es justo lo que esto venia a quitar.
-- FILA POR FILA, no en un UPDATE de golpe: `promocion_clave_nueva` lee el
-- maximo de la tabla, y dentro de una sola sentencia todas verian el mismo
-- estado y se llevarian la MISMA clave, contra el indice unico.
do $$
declare r record;
begin
  for r in select id, desde, publico from public.promociones where clave is null order by id loop
    update public.promociones
       set clave = public.promocion_clave_nueva(r.desde, r.publico)
     where id = r.id;
  end loop;
end $$;

-- ── 4. El restaurante, canal propio ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.promocion_mejor(p_id_producto bigint, p_nivel text, p_fecha date, p_id_cliente bigint DEFAULT NULL::bigint)
 RETURNS TABLE(id_promocion bigint, precio_unitario numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_p     productos%rowtype;
  v_base  numeric;
  v_grupo text;
begin
  if p_id_producto is null then return; end if;
  select * into v_p from public.productos where id = p_id_producto;
  if v_p.id is null or not coalesce(v_p.activo, true) or coalesce(v_p.descontinuado, false) then return; end if;

  -- 27 nov 2026. Antes el restaurante entraba en las promociones de
  -- «tiendas». Abraham: «cada uno es independiente», y tiene razon: tiene su
  -- propio precio de lista, su propio margen y su propia forma de comprar, asi
  -- que una promo pensada para una tienda de barrio no es la misma que para
  -- una cocina. El mayorista sigue sin entrar NUNCA, como en el Club.
  v_grupo := case lower(coalesce(p_nivel, 'consumidor'))
               when 'tienda' then 'tiendas'
               when 'restaurante' then 'restaurantes'
               when 'mayorista' then null
               else 'consumidores' end;
  if v_grupo is null then return; end if;

  v_base := case lower(coalesce(p_nivel, 'consumidor'))
              when 'tienda'      then v_p.precio_tienda
              when 'restaurante' then v_p.precio_restaurante
              when 'mostrador'   then v_p.precio_mostrador
              else v_p.precio_consumidor end;
  if v_base is null then return; end if;

  return query
  select pr.id, public.precio_promocional(v_base, pr.tipo, pr.valor) as precio
    from public.promociones pr
    cross join lateral public.promocion_consumo(pr.id) c
   where pr.activa
     and pr.tipo in ('porcentaje', 'precio_fijo')
     and coalesce(p_fecha, current_date) between pr.desde and pr.hasta
     and (pr.publico = 'todos' or pr.publico = v_grupo)
     -- LOS TRES TOPES. Un NULL no limita nada.
     and (pr.limite_total is null or c.usos < pr.limite_total)
     and (pr.presupuesto  is null or c.gastado < pr.presupuesto)
     and (pr.limite_por_cliente is null or p_id_cliente is null
          or public.promocion_usos_de(pr.id, p_id_cliente) < pr.limite_por_cliente)
     and exists (
       select 1 from public.promocion_items i
        where i.id_promocion = pr.id
          and ((i.id_producto is not null and i.id_producto = v_p.id)
            or (i.id_producto is null
                and (coalesce(i.sabor, '') = '' or i.sabor = v_p.sabor)
                and (coalesce(i.presentacion, '') = '' or i.presentacion = v_p.presentacion))))
   order by precio asc, pr.id asc
   limit 1;
end;
$function$;


-- ── 5. El piso de margen mira los TRES canales ────────────────────────────
CREATE OR REPLACE FUNCTION public.promocion_margen(p_promocion bigint)
 RETURNS TABLE(id_producto bigint, sabor text, presentacion text, canal text, precio_lista numeric, precio_promo numeric, costo numeric, margen_pct numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  pr public.promociones%rowtype;
begin
  select * into pr from public.promociones where id = p_promocion;
  if pr.id is null then return; end if;

  return query
  with canales as (
    -- 27 nov 2026: FALTABA EL RESTAURANTE. `promocion_mejor` si le servia
    -- promociones -con `precio_restaurante`- y aqui no se comprobaba su
    -- margen: se cobraba a un canal cuyo piso nadie habia mirado. No hacia
    -- daño porque hoy su precio esta entre 7.7 % y 10.4 % POR ENCIMA del de
    -- tienda, pero eso es suerte, no una garantia.
    select c.canal from (values ('consumidor'), ('tienda'), ('restaurante')) as c(canal)
    where (pr.publico = 'todos')
       or (pr.publico = 'consumidores'  and c.canal = 'consumidor')
       or (pr.publico = 'tiendas'       and c.canal = 'tienda')
       or (pr.publico = 'restaurantes'  and c.canal = 'restaurante')
  ),
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
           case c.canal when 'tienda'      then s.precio_tienda
                        when 'restaurante' then s.precio_restaurante
                        else s.precio_consumidor end as lista
      from skus s cross join canales c
  )
  select b.id, b.sabor, b.presentacion, b.canal,
         round(b.lista, 2) as precio_lista,
         v.promo as precio_promo,
         round(ct.costo, 2) as costo,
         case when v.promo > 0 and ct.costo is not null
              then round((v.promo - ct.costo) / v.promo * 100, 1) end as margen_pct
    from base b
    -- El MISMO precio que se va a cobrar. Antes aqui habia un `round(...,2)`
    -- propio, y por eso la consola enseñaba $30.40 de un producto que se
    -- cobra a $30: el margen salia calculado sobre un precio inexistente.
    cross join lateral (select public.precio_promocional(b.lista, pr.tipo, pr.valor) as promo) v
    cross join lateral (select public.costo_sku(b.id, current_date) as costo) ct
   where b.lista is not null;
end;
$function$;


-- ── 6. guardar_promocion: valida el publico y lleva la clave ──────────────
CREATE OR REPLACE FUNCTION public.guardar_promocion(p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  j        jsonb := p_data->'promocion';
  v_id     bigint;
  v_act    public.promociones%rowtype;
  v_nombre text; v_tipo text; v_valor numeric; v_pub text; v_desde date; v_hasta date;
  v_clave  text;
  v_activa boolean; v_acum boolean; v_gancho boolean; v_aterriza text; v_desc text; v_img text;
  v_items  jsonb; v_tramos jsonb; v_item jsonb;
  v_piso   numeric; v_peor numeric; v_actor text;
  v_lpc integer; v_lt integer; v_pres numeric;
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
  -- La clave es la IDENTIDAD de la promocion. Si no viene, se genera; si la
  -- promocion ya tenia una, se conserva: cambiarla seria crear otra cosa.
  v_clave    := coalesce(nullif(btrim(j->>'clave'), ''), v_act.clave);
  v_aterriza := coalesce(nullif(lower(trim(j->>'aterrizaEn')), ''), v_act.aterriza_en, 'promocion');
  v_activa   := coalesce((j->>'activa')::boolean, v_act.activa, true);
  v_acum     := coalesce((j->>'acumulableConCupon')::boolean, v_act.acumulable_con_cupon, false);
  v_gancho   := coalesce((j->>'esGancho')::boolean, v_act.es_gancho, false);
  begin v_valor := coalesce(nullif(j->>'valor', '')::numeric, v_act.valor); exception when others then v_valor := null; end;
  -- Los tres topes. Mandar la clave vacia los QUITA (sin tope); no mandarla
  -- los deja como estaban, que es lo que hace el resto de esta funcion.
  begin
    v_lpc  := case when j ? 'limitePorCliente' then nullif(j->>'limitePorCliente','')::integer else v_act.limite_por_cliente end;
    v_lt   := case when j ? 'limiteTotal'      then nullif(j->>'limiteTotal','')::integer      else v_act.limite_total end;
    v_pres := case when j ? 'presupuesto'      then nullif(j->>'presupuesto','')::numeric      else v_act.presupuesto end;
  exception when others then
    v_lpc := v_act.limite_por_cliente; v_lt := v_act.limite_total; v_pres := v_act.presupuesto;
  end;
  if v_lpc is not null and v_lpc <= 0 then return jsonb_build_object('ok', false, 'error', 'limite', 'mensaje', 'El limite por cliente debe ser mayor que 0.'); end if;
  if v_lt  is not null and v_lt  <= 0 then return jsonb_build_object('ok', false, 'error', 'limite', 'mensaje', 'El limite total debe ser mayor que 0.'); end if;
  if v_pres is not null and v_pres <= 0 then return jsonb_build_object('ok', false, 'error', 'limite', 'mensaje', 'El presupuesto debe ser mayor que 0.'); end if;
  begin
    v_desde := coalesce(nullif(j->>'desde', '')::date, v_act.desde);
    v_hasta := coalesce(nullif(j->>'hasta', '')::date, v_act.hasta);
  exception when others then v_desde := null; v_hasta := null; end;

  if v_nombre is null then return jsonb_build_object('ok', false, 'error', 'nombre', 'mensaje', 'Ponle nombre.'); end if;
  -- El publico se valida AQUI con un mensaje que se entiende. Sin esto, un
  -- valor raro revienta contra el `check` de la tabla y la pantalla enseña un
  -- error de Postgres.
  if v_pub not in ('consumidores', 'tiendas', 'restaurantes', 'todos') then
    return jsonb_build_object('ok', false, 'error', 'publico',
      'mensaje', 'El publico vale consumidores, tiendas, restaurantes o todos. ' ||
                 'El mayorista nunca entra en promociones.');
  end if;
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
    insert into public.promociones (clave, nombre, descripcion, imagen, tipo, valor, publico, desde, hasta,
                                    activa, acumulable_con_cupon, es_gancho, aterriza_en, creado_por,
                                    limite_por_cliente, limite_total, presupuesto)
    values (coalesce(v_clave, public.promocion_clave_nueva(v_desde, v_pub)), v_nombre, v_desc, v_img, v_tipo, v_valor, v_pub, v_desde, v_hasta,
            v_activa, v_acum, v_gancho, v_aterriza, v_actor,
            v_lpc, v_lt, v_pres)
    returning id into v_id;
  else
    update public.promociones
       set clave = coalesce(v_clave, public.promocion_clave_nueva(v_desde, v_pub)),
           nombre = v_nombre, descripcion = v_desc, imagen = v_img, tipo = v_tipo, valor = v_valor,
           publico = v_pub, desde = v_desde, hasta = v_hasta, activa = v_activa,
           acumulable_con_cupon = v_acum, es_gancho = v_gancho, aterriza_en = v_aterriza,
           limite_por_cliente = v_lpc, limite_total = v_lt, presupuesto = v_pres,
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

  select pr.clave into v_clave from public.promociones pr where pr.id = v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'clave', v_clave, 'peorMargen', v_peor, 'pisoMargen', v_piso,
    'limitePorCliente', v_lpc, 'limiteTotal', v_lt, 'presupuesto', v_pres,
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
$function$;


-- ── 7. La consola necesita ver la clave ───────────────────────────────────
-- Una identidad que el servidor genera y la pantalla no enseña no le sirve a
-- nadie: es la que hay que escribir en la hoja del mes siguiente.
CREATE OR REPLACE FUNCTION public.promociones_admin(p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
                   'id', pr.id, 'clave', pr.clave, 'nombre', pr.nombre, 'descripcion', pr.descripcion,
                   'imagen', pr.imagen, 'tipo', pr.tipo, 'valor', pr.valor,
                   'publico', pr.publico, 'desde', pr.desde, 'hasta', pr.hasta,
                   'activa', pr.activa, 'acumulable_con_cupon', pr.acumulable_con_cupon,
                   'es_gancho', pr.es_gancho, 'aterriza_en', pr.aterriza_en,
                   'limitePorCliente', pr.limite_por_cliente,
                   'limiteTotal', pr.limite_total,
                   'presupuesto', pr.presupuesto,
                   -- Lo gastado viaja con la promocion, como el margen: es el
                   -- dato con el que se decide si todavia sirve.
                   'consumo', (select to_jsonb(c) from public.promocion_consumo(pr.id) c),
                   'items', coalesce((select jsonb_agg(jsonb_build_object(
                              'id', i.id, 'idProducto', i.id_producto, 'sabor', i.sabor,
                              'presentacion', i.presentacion, 'cantidad', i.cantidad))
                              from public.promocion_items i where i.id_promocion = pr.id), '[]'::jsonb),
                   'tramos', coalesce((select jsonb_agg(jsonb_build_object(
                              'desdeMonto', t.desde_monto, 'valor', t.valor) order by t.desde_monto)
                              from public.promocion_tramos t where t.id_promocion = pr.id), '[]'::jsonb),
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
$function$;

commit;
