-- 20 sep 2026 — Retos con imagen, detalle («cómo participar») y productos participantes
-- (cambios/2026-09-20-retos-detalle.md). Decidido por Abraham: la imagen se sube desde /retos; los productos
-- participantes RESTRINGEN el conteo (específicos o generales); el reto se abre en un detalle tipo «Desafío»;
-- la plantilla gana imagen, dinamica, como_participar y productos.
--
-- 1. Columnas y relleno (los retos tipo producto pasan su sabor/presentación a la lista).
-- 2. avance_reto v2: con lista, solo cuentan las líneas de la lista.
-- 3. guardar_reto v2: normaliza productos contra el catálogo; como_participar como array o texto con '|'.
-- 4. retos_admin v2 y mis_puntos v5 con los campos nuevos. sesion_es_dueno para service_role (endpoint).

begin;

-- ── 1 ─────────────────────────────────────────────────────────────────────
alter table public.retos
  add column if not exists imagen text,
  add column if not exists dinamica text not null default '',
  add column if not exists como_participar text[] not null default '{}',
  add column if not exists productos jsonb not null default '[]'::jsonb;
update public.retos r
   set productos = jsonb_build_array(jsonb_build_object(
         'id', (select p.id from public.productos p where p.sabor = r.sabor and coalesce(r.presentacion, '') <> '' and p.presentacion = r.presentacion order by p.id limit 1),
         'sabor', r.sabor, 'presentacion', nullif(r.presentacion, '')))
 where r.tipo = 'producto' and coalesce(r.sabor, '') <> '' and r.productos = '[]'::jsonb;
grant execute on function public.sesion_es_dueno(text) to service_role;

-- ── 2 ─────────────────────────────────────────────────────────────────────
create or replace function public.avance_reto(p_reto bigint, p_cliente bigint) returns numeric
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  r       public.retos%rowtype;
  v_tipo  integer;
  v_lista boolean;
  v       numeric := 0;
begin
  select * into r from public.retos where id = p_reto;
  if r.id is null or p_cliente is null then return 0; end if;
  select coalesce(tipo_id, 1) into v_tipo from public.clientes where id = p_cliente;
  if v_tipo is null or not public.reto_aplica_a(r.publico, v_tipo) then return 0; end if;
  v_lista := jsonb_typeof(r.productos) = 'array' and jsonb_array_length(r.productos) > 0;

  with ped0 as (
    select o.id, o.subtotal - coalesce(o.descuento, 0) as neto
      from public.ordenes o
     where o.id_cliente = p_cliente
       and coalesce(o.tipo_interno, '') = ''
       and o.estatus_pedido <> 'Cancelado'
       and (o.fecha_orden at time zone 'America/Mexico_City')::date between r.desde and r.hasta
       and case when v_tipo in (2, 3) then o.estatus_pedido = 'Entregado' else o.estatus_pago = 'Pagado' end
  ), lin as (
    -- Líneas compradas (no canjeadas). Con lista, solo las que están en ella (presentación nula = cualquiera).
    select d.id_orden, d.sabor, d.presentacion, d.cantidad, d.tipo_venta, d.subtotal
      from ped0 p join public.ordenes_detalle d on d.id_orden = p.id
     where coalesce(d.puntos_canje, 0) = 0
       and (not v_lista or exists (
             select 1 from jsonb_array_elements(r.productos) x
              where case when nullif(x->>'id', '') is not null then d.id_producto = x->>'id'   -- SKU concreto
                         else x->>'sabor' = d.sabor end))                                     -- sabor, cualquier presentación
  ), ped as (
    select p.* from ped0 p where not v_lista or exists (select 1 from lin l where l.id_orden = p.id)
  )
  select case r.tipo
           when 'frecuencia' then (select count(*) from ped)
           when 'monto'      then case when v_lista then (select coalesce(sum(subtotal), 0) from lin)
                                       else (select coalesce(sum(neto), 0) from ped) end
           when 'producto'   then case when v_lista then (select coalesce(sum(cantidad), 0) from lin where coalesce(tipo_venta, '') <> 'A granel')
                                       else 0 end
           when 'surtido'    then (select count(distinct sabor) from lin where coalesce(sabor, '') <> '')
           else 0 end
    into v;
  return coalesce(v, 0);
end $fn$;
revoke all on function public.avance_reto(bigint, bigint) from public, anon, authenticated;

-- ── 3 ─────────────────────────────────────────────────────────────────────
-- Normaliza una entrada de la lista contra el catálogo y la deja como SKU ({id, sabor, presentacion}) o como
-- sabor general ({id: null, sabor, presentacion: null}). Acepta: número de SKU, {id}, {sabor, presentacion},
-- 'Habanero Bolsa 50g' (→ SKU) o 'Habanero' (→ general). Abraham, 20 sep 2026: la lista se lleva por SKU.
create or replace function public.normalizar_producto_reto(p jsonb, out o_ok boolean, out o_prod jsonb, out o_texto text)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_sabor text; v_pres text; v_txt text; v_id bigint; r record;
begin
  o_ok := false; o_prod := null;
  -- 1) Número (SKU), como número o como texto de dígitos.
  v_txt := trim(both from coalesce(p#>>'{}', ''));
  if jsonb_typeof(p) = 'number' or v_txt ~ '^[0-9]+$' then
    o_texto := 'SKU ' || v_txt;
    select id, sabor, presentacion into r from public.productos where id = v_txt::bigint;
    if r.id is null then return; end if;
    o_ok := true; o_prod := jsonb_build_object('id', r.id, 'sabor', r.sabor, 'presentacion', r.presentacion); return;
  end if;
  -- 2) Objeto: {id} manda; si no, {sabor, presentacion?}.
  if jsonb_typeof(p) = 'object' then
    v_id := nullif(p->>'id', '')::bigint;
    if v_id is not null then
      o_texto := 'SKU ' || v_id;
      select id, sabor, presentacion into r from public.productos where id = v_id;
      if r.id is null then return; end if;
      o_ok := true; o_prod := jsonb_build_object('id', r.id, 'sabor', r.sabor, 'presentacion', r.presentacion); return;
    end if;
    v_sabor := nullif(trim(p->>'sabor'), ''); v_pres := nullif(trim(p->>'presentacion'), '');
    o_texto := coalesce(v_sabor, '') || coalesce(' ' || v_pres, '');
    if v_sabor is null then return; end if;
    if v_pres is null then
      select sabor into r from public.productos where lower(sabor) = lower(v_sabor) order by id limit 1;
      if r.sabor is null then return; end if;
      o_ok := true; o_prod := jsonb_build_object('id', null, 'sabor', r.sabor, 'presentacion', null); return;
    end if;
    select id, sabor, presentacion into r from public.productos where lower(sabor) = lower(v_sabor) and lower(presentacion) = lower(v_pres) order by id limit 1;
    if r.id is null then return; end if;
    o_ok := true; o_prod := jsonb_build_object('id', r.id, 'sabor', r.sabor, 'presentacion', r.presentacion); return;
  end if;
  -- 3) Texto: «Sabor Presentación» exacto (→ SKU) primero; después solo el sabor (→ general).
  o_texto := v_txt;
  if v_txt = '' then return; end if;
  select id, sabor, presentacion into r from public.productos where lower(sabor || ' ' || presentacion) = lower(v_txt) order by id limit 1;
  if r.id is not null then o_ok := true; o_prod := jsonb_build_object('id', r.id, 'sabor', r.sabor, 'presentacion', r.presentacion); return; end if;
  select sabor into r from public.productos where lower(sabor) = lower(v_txt) order by id limit 1;
  if r.sabor is not null then o_ok := true; o_prod := jsonb_build_object('id', null, 'sabor', r.sabor, 'presentacion', null); return; end if;
end $fn$;
revoke all on function public.normalizar_producto_reto(jsonb) from public, anon, authenticated;

create or replace function public.guardar_reto(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  j        jsonb := p_data->'reto';
  v_id     bigint;
  v_act    public.retos%rowtype;
  v_fila   public.retos%rowtype;
  v_nombre text; v_tipo text; v_meta numeric; v_bono integer; v_desde date; v_hasta date; v_pub text;
  v_activo boolean; v_desc text; v_actor text;
  v_imagen text; v_dinamica text; v_pasos text[]; v_prods jsonb; v_x jsonb; v_n record;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  if j is null or jsonb_typeof(j) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'reto_requerido', 'mensaje', 'Falta el reto.');
  end if;
  v_id := nullif(j->>'id', '')::bigint;
  if v_id is not null then
    select * into v_act from public.retos where id = v_id;
    if v_act.id is null then return jsonb_build_object('ok', false, 'error', 'no_existe', 'mensaje', 'Ese reto no existe.'); end if;
  end if;

  v_nombre := coalesce(nullif(trim(j->>'nombre'), ''), v_act.nombre);
  v_desc   := coalesce(j->>'descripcion', v_act.descripcion, '');
  v_tipo   := coalesce(nullif(lower(trim(j->>'tipo')), ''), v_act.tipo);
  v_pub    := coalesce(nullif(lower(trim(j->>'publico')), ''), v_act.publico, 'todos');
  v_activo := coalesce((j->>'activo')::boolean, v_act.activo, true);
  begin v_meta := coalesce(nullif(j->>'meta', '')::numeric, v_act.meta); exception when others then v_meta := null; end;
  begin v_bono := coalesce(nullif(j->>'bono', '')::integer, v_act.bono); exception when others then v_bono := null; end;
  begin
    v_desde := coalesce(nullif(j->>'desde', '')::date, v_act.desde);
    v_hasta := coalesce(nullif(j->>'hasta', '')::date, v_act.hasta);
  exception when others then v_desde := null; v_hasta := null; end;
  v_imagen   := case when j ? 'imagen' then nullif(trim(j->>'imagen'), '') else v_act.imagen end;
  v_dinamica := coalesce(j->>'dinamica', v_act.dinamica, '');
  -- como_participar: array de textos, o un texto con pasos separados por '|'.
  if j ? 'como_participar' then
    if jsonb_typeof(j->'como_participar') = 'array' then
      select coalesce(array_agg(trim(x)) filter (where trim(x) <> ''), '{}') into v_pasos from jsonb_array_elements_text(j->'como_participar') x;
    else
      select coalesce(array_agg(trim(x)) filter (where trim(x) <> ''), '{}') into v_pasos from unnest(string_to_array(coalesce(j->>'como_participar', ''), '|')) x;
    end if;
  else
    v_pasos := coalesce(v_act.como_participar, '{}');
  end if;
  -- productos: array de {sabor, presentacion} o de textos; también un texto con '|'.
  if j ? 'productos' then
    v_prods := '[]'::jsonb;
    if jsonb_typeof(j->'productos') = 'array' then
      for v_x in select value from jsonb_array_elements(j->'productos') loop
        select * into v_n from public.normalizar_producto_reto(v_x);
        if not v_n.o_ok then return jsonb_build_object('ok', false, 'error', 'producto_desconocido', 'mensaje', 'Ese producto no está en el catálogo: ' || coalesce(v_n.o_texto, '')); end if;
        v_prods := v_prods || v_n.o_prod;
      end loop;
    else
      for v_x in select to_jsonb(trim(t)) from unnest(string_to_array(coalesce(j->>'productos', ''), '|')) t where trim(t) <> '' loop
        select * into v_n from public.normalizar_producto_reto(v_x);
        if not v_n.o_ok then return jsonb_build_object('ok', false, 'error', 'producto_desconocido', 'mensaje', 'Ese producto no está en el catálogo: ' || coalesce(v_n.o_texto, '')); end if;
        v_prods := v_prods || v_n.o_prod;
      end loop;
    end if;
  elsif nullif(trim(j->>'sabor'), '') is not null then
    -- Compatibilidad: la /retos anterior manda sabor (+ presentación opcional) en vez de productos.
    select * into v_n from public.normalizar_producto_reto(jsonb_build_object('sabor', trim(j->>'sabor'), 'presentacion', nullif(trim(j->>'presentacion'), '')));
    if not v_n.o_ok then return jsonb_build_object('ok', false, 'error', 'producto_desconocido', 'mensaje', 'Ese producto no está en el catálogo: ' || coalesce(v_n.o_texto, '')); end if;
    v_prods := jsonb_build_array(v_n.o_prod);
  else
    v_prods := coalesce(v_act.productos, '[]'::jsonb);
  end if;

  if v_nombre is null then return jsonb_build_object('ok', false, 'error', 'nombre_requerido', 'mensaje', 'Ponle nombre al reto.'); end if;
  if v_tipo is null or v_tipo not in ('frecuencia', 'producto', 'monto', 'surtido') then
    return jsonb_build_object('ok', false, 'error', 'tipo_invalido', 'mensaje', 'Tipo: frecuencia, producto, monto o surtido.');
  end if;
  if v_meta is null or v_meta <= 0 then return jsonb_build_object('ok', false, 'error', 'meta_invalida', 'mensaje', 'La meta debe ser mayor que 0.'); end if;
  if v_bono is null or v_bono <= 0 then return jsonb_build_object('ok', false, 'error', 'bono_invalido', 'mensaje', 'El bono debe ser un entero mayor que 0.'); end if;
  if v_desde is null or v_hasta is null or v_hasta < v_desde then
    return jsonb_build_object('ok', false, 'error', 'fechas_invalidas', 'mensaje', 'Fechas AAAA-MM-DD, y «hasta» no antes de «desde».');
  end if;
  if v_pub not in ('consumidores', 'tiendas', 'todos') then
    return jsonb_build_object('ok', false, 'error', 'publico_invalido', 'mensaje', 'Público: consumidores, tiendas o todos.');
  end if;
  if v_tipo = 'producto' and jsonb_array_length(v_prods) = 0 then
    return jsonb_build_object('ok', false, 'error', 'productos_requeridos', 'mensaje', 'Un reto de piezas necesita al menos un producto.');
  end if;

  select coalesce(nombre, 'dueño') into v_actor from public.vendedores
   where id = (select s.id_vendedor from public.resolver_sesion_vendedor(p_data->>'token') s);

  if v_id is null then
    insert into public.retos (nombre, descripcion, tipo, meta, sabor, presentacion, bono, desde, hasta, publico, activo, creado_por,
                              imagen, dinamica, como_participar, productos)
    values (v_nombre, v_desc, v_tipo, v_meta, v_prods->0->>'sabor', v_prods->0->>'presentacion', v_bono, v_desde, v_hasta, v_pub, v_activo, v_actor,
            v_imagen, v_dinamica, v_pasos, v_prods)
    returning * into v_fila;
  else
    update public.retos
       set nombre = v_nombre, descripcion = v_desc, tipo = v_tipo, meta = v_meta,
           sabor = v_prods->0->>'sabor', presentacion = v_prods->0->>'presentacion',
           bono = v_bono, desde = v_desde, hasta = v_hasta, publico = v_pub, activo = v_activo, actualizado_en = now(),
           imagen = v_imagen, dinamica = v_dinamica, como_participar = v_pasos, productos = v_prods
     where id = v_id
    returning * into v_fila;
  end if;
  return jsonb_build_object('ok', true, 'reto', to_jsonb(v_fila));
end $fn$;
revoke all on function public.guardar_reto(jsonb) from public;
grant execute on function public.guardar_reto(jsonb) to anon, authenticated;

-- ── 4 ─────────────────────────────────────────────────────────────────────
create or replace function public.retos_admin(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare v jsonb;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'nombre', r.nombre, 'descripcion', r.descripcion, 'tipo', r.tipo, 'meta', r.meta,
    'sabor', r.sabor, 'presentacion', r.presentacion, 'bono', r.bono, 'desde', r.desde, 'hasta', r.hasta,
    'publico', r.publico, 'activo', r.activo, 'creado_en', r.creado_en,
    'imagen', r.imagen, 'dinamica', r.dinamica, 'como_participar', to_jsonb(r.como_participar), 'productos', r.productos,
    'participantes', (select count(distinct o.id_cliente)
                        from public.ordenes o join public.clientes c on c.id = o.id_cliente
                       where coalesce(o.tipo_interno, '') = '' and o.estatus_pedido <> 'Cancelado'
                         and (o.fecha_orden at time zone 'America/Mexico_City')::date between r.desde and r.hasta
                         and public.reto_aplica_a(r.publico, coalesce(c.tipo_id, 1))
                         and case when coalesce(c.tipo_id, 1) in (2, 3) then o.estatus_pedido = 'Entregado'
                                  else o.estatus_pago = 'Pagado' end),
    'cumplidos', (select count(*) from (select id_cliente from public.lealtad_movimientos
                                          where tipo = 'reto' and id_premio = r.id
                                          group by id_cliente having sum(puntos) > 0) x),
    'puntos_dados', (select coalesce(sum(puntos), 0) from public.lealtad_movimientos where tipo = 'reto' and id_premio = r.id)
  ) order by r.activo desc, r.hasta desc, r.id desc), '[]'::jsonb)
    into v from public.retos r;
  return jsonb_build_object('ok', true, 'retos', v,
    'sabores', (select coalesce(jsonb_agg(distinct sabor), '[]'::jsonb) from public.productos
                 where not coalesce(descontinuado, false) and coalesce(sabor, '') <> ''),
    'presentaciones', (select coalesce(jsonb_agg(distinct presentacion), '[]'::jsonb) from public.productos
                        where not coalesce(descontinuado, false) and coalesce(presentacion, '') <> ''),
    'productos', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'sabor', sabor, 'presentacion', presentacion, 'imagen_url', coalesce(imagen_url, '')) order by sabor, presentacion), '[]'::jsonb)
                    from public.productos where not coalesce(descontinuado, false) and coalesce(sabor, '') <> ''));
end $fn$;
revoke all on function public.retos_admin(jsonb) from public;
grant execute on function public.retos_admin(jsonb) to anon, authenticated;

create or replace function public.mis_puntos(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_tel  text;
  v_id   bigint;
  v_movs jsonb;
  v_pend jsonb;
  v_pv   integer;
  v_neg  integer;
  v_lote timestamptz;
  v_tipo integer;
  v_retos jsonb;
begin
  v_tel := public.resolver_sesion_cliente(p_token);
  if v_tel is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida o expirada');
  end if;
  select c.id into v_id from public.clientes c where c.telefono = v_tel order by c.id limit 1;
  if v_id is null then
    return jsonb_build_object('ok', true, 'saldo', 0, 'movimientos', '[]'::jsonb, 'pendientes', '[]'::jsonb);
  end if;

  -- Lo vencido se escribe antes de sumar: el saldo nunca muestra un punto vencido, aunque el cron no corra.
  perform public.vencer_puntos(v_id);

  select coalesce(jsonb_agg(jsonb_build_object(
           'fecha', m.fecha, 'tipo', m.tipo, 'puntos', m.puntos,
           'consecutivo', m.consecutivo, 'monto', m.monto_origen, 'nota', m.nota, 'premio', m.nombre_premio)
         order by m.fecha desc, m.id desc), '[]'::jsonb)
    into v_movs
    from (select * from public.lealtad_movimientos
           where id_cliente = v_id order by fecha desc, id desc limit 50) m;

  select coalesce(jsonb_agg(jsonb_build_object('fecha', d.creada_en, 'puntos', d.puntos, 'consecutivo', d.consecutivo)
                            order by d.creada_en desc), '[]'::jsonb)
    into v_pend
    from public.canje_devoluciones d where d.id_cliente = v_id and d.estado = 'pendiente';

  -- Lo que vence en los próximos 30 días, y cuándo vence el paquete vivo más viejo (FIFO).
  v_pv := public.puntos_por_vencer(v_id, now() + interval '30 days');
  if v_pv > 0 then
    select -coalesce(sum(puntos), 0) into v_neg
      from public.lealtad_movimientos where id_cliente = v_id and puntos < 0;
    select min(l.fecha) into v_lote
      from (select fecha, sum(puntos) over (order by fecha, id) as acum
              from public.lealtad_movimientos where id_cliente = v_id and puntos > 0) l
     where l.acum > v_neg;
  end if;

  -- Retos activos y vigentes del público del cliente, con su avance (solo lectura; el bono lo escribe el trigger).
  select coalesce(tipo_id, 1) into v_tipo from public.clientes where id = v_id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'nombre', r.nombre, 'descripcion', r.descripcion, 'tipo', r.tipo, 'meta', r.meta,
           'sabor', r.sabor, 'presentacion', r.presentacion, 'bono', r.bono, 'hasta', r.hasta,
           'imagen', r.imagen, 'dinamica', r.dinamica, 'como_participar', to_jsonb(r.como_participar),
           'productos', (select coalesce(jsonb_agg(jsonb_build_object(
                           'id', p->'id', 'sabor', p->>'sabor', 'presentacion', p->>'presentacion',
                           'imagen_url', (select pr.imagen_url from public.productos pr
                                           where case when nullif(p->>'id', '') is not null then pr.id = (p->>'id')::bigint
                                                      else pr.sabor = p->>'sabor' end
                                             and coalesce(pr.imagen_url, '') <> '' order by pr.id limit 1))), '[]'::jsonb)
                          from jsonb_array_elements(r.productos) p),
           'avance', public.avance_reto(r.id, v_id),
           'cumplido', coalesce((select sum(puntos) from public.lealtad_movimientos
                                  where id_cliente = v_id and tipo = 'reto' and id_premio = r.id), 0) > 0)
         order by r.hasta, r.id), '[]'::jsonb)
    into v_retos
    from public.retos r
   where r.activo and public.reto_aplica_a(r.publico, v_tipo)
     and (now() at time zone 'America/Mexico_City')::date between r.desde and r.hasta;

  return jsonb_build_object('ok', true,
    'saldo', coalesce((select sum(puntos) from public.lealtad_movimientos where id_cliente = v_id), 0),
    'movimientos', v_movs, 'pendientes', v_pend,
    'por_vencer', case when v_pv > 0 then jsonb_build_object('puntos', v_pv, 'fecha', v_lote + interval '12 months') end,
    'retos', v_retos);
end $fn$;
revoke all on function public.mis_puntos(text) from public;
grant execute on function public.mis_puntos(text) to anon, authenticated;
grant execute on function public.mis_puntos(text) to anon, authenticated;

commit;
