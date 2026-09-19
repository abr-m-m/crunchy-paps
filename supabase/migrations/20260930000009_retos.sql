-- 19 sep 2026 — Crunchy Club: retos de compra (cambios/2026-09-19-retos.md).
-- Decidido por Abraham: cuatro tipos (frecuencia, producto, monto, surtido); público por reto (consumidores, tiendas o
-- todos; mayoristas nunca); un pedido cuenta cuando da puntos; el bono se revierte solo si al cancelar cae por debajo;
-- administración en /retos (computadora), con plantilla de Excel.
--
-- 1. Tabla retos, cerrada por RLS.
-- 2. reto_aplica_a, avance_reto (solo lectura), evaluar_retos (escribe el asiento 'reto' que falte; idempotente).
-- 3. Triggers de puntos: llaman a evaluar_retos.
-- 4. RPCs del dueño: retos_admin, guardar_reto, borrar_reto, retos_avance.
-- 5. mis_puntos v4: retos con avance, y 'premio' en los movimientos.

begin;

-- ── 1 ─────────────────────────────────────────────────────────────────────
create table if not exists public.retos (
  id             bigserial primary key,
  nombre         text not null,
  descripcion    text not null default '',
  tipo           text not null check (tipo in ('frecuencia', 'producto', 'monto', 'surtido')),
  meta           numeric not null check (meta > 0),
  sabor          text,
  presentacion   text,
  bono           integer not null check (bono > 0),
  desde          date not null,
  hasta          date not null,
  publico        text not null check (publico in ('consumidores', 'tiendas', 'todos')),
  activo         boolean not null default true,
  creado_por     text,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  check (hasta >= desde),
  check (tipo <> 'producto' or coalesce(sabor, '') <> '')
);
alter table public.retos enable row level security;
revoke all on table public.retos from anon, authenticated;
comment on table public.retos is 'Retos de compra del Crunchy Club. Sin tabla de avance: se calcula desde los pedidos; el bono es un asiento reto del ledger (id_premio = reto). 19 sep 2026.';

-- ── 2 ─────────────────────────────────────────────────────────────────────
create or replace function public.reto_aplica_a(p_publico text, p_tipo_cliente integer) returns boolean
language sql immutable as $fn$
  select case p_publico
           when 'todos'        then coalesce(p_tipo_cliente, 1) in (1, 2, 3)
           when 'consumidores' then coalesce(p_tipo_cliente, 1) = 1
           when 'tiendas'      then coalesce(p_tipo_cliente, 1) in (2, 3)
           else false end;
$fn$;
revoke all on function public.reto_aplica_a(text, integer) from public, anon, authenticated;

-- Lo que el cliente lleva en el reto, medido desde los pedidos que cuentan (los que dan puntos, dentro del periodo).
create or replace function public.avance_reto(p_reto bigint, p_cliente bigint) returns numeric
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  r      public.retos%rowtype;
  v_tipo integer;
  v      numeric := 0;
begin
  select * into r from public.retos where id = p_reto;
  if r.id is null or p_cliente is null then return 0; end if;
  select coalesce(tipo_id, 1) into v_tipo from public.clientes where id = p_cliente;
  if v_tipo is null or not public.reto_aplica_a(r.publico, v_tipo) then return 0; end if;

  with ped as (
    select o.id, o.subtotal - coalesce(o.descuento, 0) as neto
      from public.ordenes o
     where o.id_cliente = p_cliente
       and coalesce(o.tipo_interno, '') = ''
       and o.estatus_pedido <> 'Cancelado'
       and (o.fecha_orden at time zone 'America/Mexico_City')::date between r.desde and r.hasta
       and case when v_tipo in (2, 3) then o.estatus_pedido = 'Entregado' else o.estatus_pago = 'Pagado' end
  ), lin as (
    select d.sabor, d.presentacion, d.cantidad, d.tipo_venta
      from ped p join public.ordenes_detalle d on d.id_orden = p.id
     where coalesce(d.puntos_canje, 0) = 0
  )
  select case r.tipo
           when 'frecuencia' then (select count(*) from ped)
           when 'monto'      then (select coalesce(sum(neto), 0) from ped)
           when 'producto'   then (select coalesce(sum(cantidad), 0) from lin
                                    where sabor = r.sabor
                                      and (coalesce(r.presentacion, '') = '' or presentacion = r.presentacion)
                                      and coalesce(tipo_venta, '') <> 'A granel')
           when 'surtido'    then (select count(distinct sabor) from lin where coalesce(sabor, '') <> '')
           else 0 end
    into v;
  return coalesce(v, 0);
end $fn$;
revoke all on function public.avance_reto(bigint, bigint) from public, anon, authenticated;

-- Recalcula los retos del cliente y escribe el asiento que falte. Idempotente: compara con el ledger.
create or replace function public.evaluar_retos(p_cliente bigint) returns integer
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  r        record;
  v_tipo   integer;
  v_tiene  integer;
  v_avance numeric;
  v_n      integer := 0;
begin
  if p_cliente is null or p_cliente = 999999 then return 0; end if;
  select coalesce(tipo_id, 1) into v_tipo from public.clientes where id = p_cliente;
  if v_tipo is null or v_tipo not in (1, 2, 3) then return 0; end if;
  -- El mismo candado que canje y vencimiento: nada del mismo cliente se cruza.
  perform pg_advisory_xact_lock(hashtext('canje:' || p_cliente));
  for r in
    select * from public.retos
     where activo and public.reto_aplica_a(publico, v_tipo)
       and desde <= (now() at time zone 'America/Mexico_City')::date
     order by id
  loop
    select coalesce(sum(puntos), 0) into v_tiene from public.lealtad_movimientos
     where id_cliente = p_cliente and tipo = 'reto' and id_premio = r.id;
    v_avance := public.avance_reto(r.id, p_cliente);
    if v_avance >= r.meta and v_tiene <= 0 then
      perform public.agregar_movimiento_lealtad(p_cliente, 'reto', r.bono, null, null, r.id, r.nombre, null,
        'Reto: ' || r.nombre, 'sistema');
      v_n := v_n + 1;
    elsif v_avance < r.meta and v_tiene > 0 then
      perform public.agregar_movimiento_lealtad(p_cliente, 'reto', -v_tiene, null, null, r.id, r.nombre, null,
        'Reto ' || r.nombre || ': pedido cancelado', 'sistema');
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $fn$;
revoke all on function public.evaluar_retos(bigint) from public, anon, authenticated;

-- ── 3 ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.otorgar_puntos_al_confirmar()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- Club fase 1 (Abraham, 18 sep): el momento depende de quién compra.
--   Consumidor: al pasar a Pagado (en línea, el webhook de Stripe; contra entrega, cuando se marca).
--   Tienda y restaurante: al pasar a Entregado (no pagan en línea; la entrega va con el pago).
--   Mayorista, internos, mostrador sin cliente (999999) y cancelados: nunca.
-- Base 'neto' = subtotal - descuento: producto menos cupón, sin envío.
DECLARE
  v_cfg     jsonb;
  v_rate    numeric;
  v_base    text;
  v_monto   numeric;
  v_pts     int;
  v_tipo    int;
  v_momento boolean;
BEGIN
  IF COALESCE(NEW.tipo_interno,'') <> '' OR NEW.id_cliente IS NULL OR NEW.id_cliente = 999999
     OR NEW.estatus_pedido = 'Cancelado' THEN
    RETURN NEW;
  END IF;

  SELECT c.tipo_id INTO v_tipo FROM clientes c WHERE c.id = NEW.id_cliente;
  IF lower(COALESCE(NEW.canal,'')) = 'mayorista' OR v_tipo = 4 THEN
    RETURN NEW;
  END IF;

  IF v_tipo IN (2, 3) THEN
    v_momento := NEW.estatus_pedido = 'Entregado'
                 AND (TG_OP = 'INSERT' OR OLD.estatus_pedido IS DISTINCT FROM 'Entregado');
  ELSE
    v_momento := NEW.estatus_pago = 'Pagado'
                 AND (TG_OP = 'INSERT' OR OLD.estatus_pago IS DISTINCT FROM 'Pagado');
  END IF;
  IF NOT v_momento THEN
    RETURN NEW;
  END IF;

  -- Antidoble: neto de generación y reversión del pedido.
  IF COALESCE((SELECT sum(puntos) FROM lealtad_movimientos
                WHERE id_orden = NEW.id AND tipo IN ('generacion', 'reversion')), 0) > 0 THEN
    RETURN NEW;
  END IF;

  SELECT valor INTO v_cfg FROM config_produccion WHERE clave = 'lealtad';
  IF v_cfg IS NULL OR COALESCE((v_cfg->'generacion'->>'activo')::bool, false) = false THEN
    PERFORM public.evaluar_retos(NEW.id_cliente);
    RETURN NEW;
  END IF;

  v_rate  := COALESCE((v_cfg->'generacion'->>'puntos_por_peso')::numeric, 0);
  v_base  := COALESCE(v_cfg->'generacion'->>'base', 'total');
  v_monto := CASE v_base WHEN 'neto' THEN GREATEST(0, COALESCE(NEW.subtotal, 0) - COALESCE(NEW.descuento, 0))
                         WHEN 'subtotal' THEN NEW.subtotal ELSE NEW.total END;
  v_pts   := floor(COALESCE(v_monto, 0) * v_rate)::int;

  IF v_pts > 0 THEN
    PERFORM agregar_movimiento_lealtad(
      NEW.id_cliente, 'generacion', v_pts,
      NEW.id, NEW.consecutivo, NULL, NULL, v_monto,
      'Puntos por pedido ' || COALESCE(NEW.consecutivo,'') || CASE WHEN v_tipo IN (2, 3) THEN ' (entregado)' ELSE ' (pagado)' END,
      'sistema'
    );
  END IF;

  -- Retos (19 sep 2026): el pedido acaba de contar; se recalculan los retos del cliente.
  PERFORM public.evaluar_retos(NEW.id_cliente);

  RETURN NEW;
END;
$function$;

create or replace function public.revertir_puntos_al_cancelar() returns trigger
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare v_neto int; v_canje int; v_cli bigint;
begin
  if new.estatus_pedido = 'Cancelado' and coalesce(old.estatus_pedido, '') <> 'Cancelado' then
    -- Lo generado por la parte pagada se revierte solo.
    select coalesce(sum(puntos), 0) into v_neto
      from lealtad_movimientos
     where id_orden = new.id and tipo in ('generacion', 'reversion');
    if v_neto > 0 then
      perform agregar_movimiento_lealtad(
        new.id_cliente, 'reversion', -v_neto,
        new.id, new.consecutivo, null, null, null,
        'Reversión por cancelación de ' || coalesce(new.consecutivo, ''),
        coalesce(nullif(new.actualizado_por, ''), 'sistema'));
    end if;
    -- Lo canjeado NO regresa solo: queda una solicitud para validar (Abraham, 18 sep 2026).
    select -coalesce(sum(puntos), 0), min(id_cliente) into v_canje, v_cli
      from lealtad_movimientos
     where id_orden = new.id and tipo in ('canje', 'devolucion');
    if v_canje > 0 then
      insert into canje_devoluciones (id_orden, id_cliente, consecutivo, puntos, cancelado_por)
      values (new.id, v_cli, new.consecutivo, v_canje, nullif(new.actualizado_por, ''))
      on conflict (id_orden) do nothing;
    end if;
    -- Retos (19 sep 2026): si al cancelar cae por debajo de una meta, se quita el bono.
    perform public.evaluar_retos(new.id_cliente);
  end if;
  return new;
end $fn$;
revoke all on function public.revertir_puntos_al_cancelar() from public;

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
                        where not coalesce(descontinuado, false) and coalesce(presentacion, '') <> ''));
end $fn$;
revoke all on function public.retos_admin(jsonb) from public;
grant execute on function public.retos_admin(jsonb) to anon, authenticated;

-- Crea (sin id) o edita (con id; solo cambia lo que viene). La misma validación para formulario y plantilla.
create or replace function public.guardar_reto(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  j        jsonb := p_data->'reto';
  v_id     bigint;
  v_act    public.retos%rowtype;
  v_fila   public.retos%rowtype;
  v_nombre text; v_tipo text; v_meta numeric; v_bono integer; v_desde date; v_hasta date; v_pub text;
  v_sabor  text; v_pres text; v_activo boolean; v_desc text;
  v_actor  text;
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

  -- Cada campo: lo que viene, o lo que ya tenía (edición parcial).
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
  v_sabor := coalesce(nullif(trim(j->>'sabor'), ''), v_act.sabor);
  v_pres  := coalesce(nullif(trim(j->>'presentacion'), ''), v_act.presentacion);

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
  if v_tipo = 'producto' then
    if v_sabor is null then return jsonb_build_object('ok', false, 'error', 'sabor_requerido', 'mensaje', 'Un reto de producto necesita sabor.'); end if;
    select sabor into v_sabor from public.productos where lower(sabor) = lower(v_sabor) order by id limit 1;
    if v_sabor is null then return jsonb_build_object('ok', false, 'error', 'sabor_desconocido', 'mensaje', 'Ese sabor no está en el catálogo.'); end if;
    if v_pres is not null then
      select presentacion into v_pres from public.productos where lower(presentacion) = lower(v_pres) order by id limit 1;
      if v_pres is null then return jsonb_build_object('ok', false, 'error', 'presentacion_desconocida', 'mensaje', 'Esa presentación no está en el catálogo.'); end if;
    end if;
  else
    v_sabor := null; v_pres := null;
  end if;

  select coalesce(nombre, 'dueño') into v_actor from public.vendedores
   where id = (select s.id_vendedor from public.resolver_sesion_vendedor(p_data->>'token') s);

  if v_id is null then
    insert into public.retos (nombre, descripcion, tipo, meta, sabor, presentacion, bono, desde, hasta, publico, activo, creado_por)
    values (v_nombre, v_desc, v_tipo, v_meta, v_sabor, v_pres, v_bono, v_desde, v_hasta, v_pub, v_activo, v_actor)
    returning * into v_fila;
  else
    update public.retos
       set nombre = v_nombre, descripcion = v_desc, tipo = v_tipo, meta = v_meta, sabor = v_sabor, presentacion = v_pres,
           bono = v_bono, desde = v_desde, hasta = v_hasta, publico = v_pub, activo = v_activo, actualizado_en = now()
     where id = v_id
    returning * into v_fila;
  end if;
  return jsonb_build_object('ok', true, 'reto', to_jsonb(v_fila));
end $fn$;
revoke all on function public.guardar_reto(jsonb) from public;
grant execute on function public.guardar_reto(jsonb) to anon, authenticated;

create or replace function public.borrar_reto(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint := nullif(p_data->>'id', '')::bigint;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  if v_id is null or not exists (select 1 from public.retos where id = v_id) then
    return jsonb_build_object('ok', false, 'error', 'no_existe', 'mensaje', 'Ese reto no existe.');
  end if;
  if exists (select 1 from public.lealtad_movimientos where tipo = 'reto' and id_premio = v_id) then
    return jsonb_build_object('ok', false, 'error', 'tiene_bonos', 'mensaje', 'Este reto ya dio puntos: páusalo en vez de borrarlo.');
  end if;
  delete from public.retos where id = v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $fn$;
revoke all on function public.borrar_reto(jsonb) from public;
grant execute on function public.borrar_reto(jsonb) to anon, authenticated;

create or replace function public.retos_avance(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare v_id bigint := nullif(p_data->>'id', '')::bigint; r public.retos%rowtype; v jsonb;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  select * into r from public.retos where id = v_id;
  if r.id is null then return jsonb_build_object('ok', false, 'error', 'no_existe', 'mensaje', 'Ese reto no existe.'); end if;
  select coalesce(jsonb_agg(x order by x.cumplido desc, x.avance desc, x.nombre), '[]'::jsonb) into v
    from (
      select c.id, c.nombre,
             case coalesce(c.tipo_id, 1) when 2 then 'Restaurante' when 3 then 'Tienda' else 'Consumidor' end as tipo,
             public.avance_reto(r.id, c.id) as avance, r.meta as meta,
             coalesce((select sum(puntos) from public.lealtad_movimientos where id_cliente = c.id and tipo = 'reto' and id_premio = r.id), 0) > 0 as cumplido,
             (select max(fecha) from public.lealtad_movimientos where id_cliente = c.id and tipo = 'reto' and id_premio = r.id and puntos > 0) as fecha_bono
        from public.clientes c
       where public.reto_aplica_a(r.publico, coalesce(c.tipo_id, 1))
    ) x
   where x.avance > 0 or x.cumplido;
  return jsonb_build_object('ok', true, 'reto', to_jsonb(r), 'clientes', v);
end $fn$;
revoke all on function public.retos_avance(jsonb) from public;
grant execute on function public.retos_avance(jsonb) to anon, authenticated;

-- ── 5 ─────────────────────────────────────────────────────────────────────
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
