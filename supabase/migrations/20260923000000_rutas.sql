-- 20260923000000_rutas.sql
-- R1 · Rutas mínimas (cambios/2026-09-15-rutas-armado-reparto.md). Re-ejecutable.
-- Una ruta es una zona geográfica fija (colonias y rangos de CP) con días de
-- reparto. La tienda recibe su ruta sola (trigger) y se corrige en el panel;
-- una ruta puesta a mano nunca se pisa. El pedido guarda la ruta del momento.

-- ── 1. Tablas y columnas ────────────────────────────────────────────────────
create table if not exists public.rutas (
  id             bigserial primary key,
  nombre         text not null unique,
  color          text not null default '#ffd200',
  dias           int[] not null default '{}',          -- 0 = domingo … 6 = sábado
  activa         boolean not null default true,
  orden          int not null default 0,
  notas          text,
  creada_en      timestamptz not null default now(),
  actualizada_en timestamptz not null default now()
);
create table if not exists public.rutas_cobertura (
  id       bigserial primary key,
  id_ruta  bigint not null references public.rutas(id) on delete cascade,
  tipo     text not null check (tipo in ('colonia', 'cp')),
  valor    text not null,
  cp_hasta text
);
create index if not exists rutas_cobertura_ruta on public.rutas_cobertura(id_ruta);
alter table public.rutas enable row level security;
alter table public.rutas_cobertura enable row level security;
revoke all on table public.rutas, public.rutas_cobertura from public, anon, authenticated;
alter table public.clientes add column if not exists id_ruta bigint references public.rutas(id) on delete set null;
alter table public.ordenes  add column if not exists id_ruta bigint references public.rutas(id) on delete set null;

-- ── 2. Casar colonias sin acentos ni mayúsculas (sin depender de unaccent) ──
create or replace function public.normalizar_colonia(p text) returns text
language sql immutable as $fn$
  select lower(regexp_replace(translate(coalesce(p, ''), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN'), '\s+', ' ', 'g'));
$fn$;

-- La colonia manda sobre el CP (es más precisa); entre rutas, el orden.
create or replace function public.ruta_para(p_cp text, p_colonia text) returns bigint
language sql stable security definer set search_path = public, extensions, pg_temp as $fn$
  select r.id
    from public.rutas r
    join public.rutas_cobertura c on c.id_ruta = r.id
   where r.activa
     and ((c.tipo = 'colonia' and coalesce(p_colonia, '') <> ''
           and public.normalizar_colonia(c.valor) = public.normalizar_colonia(p_colonia))
       or (c.tipo = 'cp' and coalesce(p_cp, '') <> ''
           and p_cp between c.valor and coalesce(c.cp_hasta, c.valor)))
   order by (c.tipo = 'colonia') desc, r.orden, r.id
   limit 1;
$fn$;
revoke all on function public.ruta_para(text, text) from public, anon, authenticated;

-- ── 3. Triggers: la ruta se calcula solo cuando no hay una puesta ──────────
create or replace function public.trg_clientes_ruta_fn() returns trigger
language plpgsql as $fn$
begin
  if new.id_ruta is null then
    new.id_ruta := public.ruta_para(new.cp, new.colonia);
  end if;
  return new;
end $fn$;
drop trigger if exists trg_clientes_ruta on public.clientes;
create trigger trg_clientes_ruta
  before insert or update of cp, colonia, aprobado_b2b on public.clientes
  for each row execute function public.trg_clientes_ruta_fn();

-- El pedido lleva la ruta del cliente; el consumidor sin ruta, la de su CP
-- (solo agrupa el reparto, no cambia su fecha; decisión D7 del 15 sep).
create or replace function public.trg_ordenes_ruta_fn() returns trigger
language plpgsql as $fn$
begin
  if new.id_ruta is null then
    if new.id_cliente is not null then
      select c.id_ruta into new.id_ruta from public.clientes c where c.id = new.id_cliente;
    end if;
    if new.id_ruta is null then
      new.id_ruta := public.ruta_para(new.cp, new.colonia);
    end if;
  end if;
  return new;
end $fn$;
drop trigger if exists trg_ordenes_ruta on public.ordenes;
create trigger trg_ordenes_ruta
  before insert on public.ordenes
  for each row execute function public.trg_ordenes_ruta_fn();

-- ── 4. Lectura pública ──────────────────────────────────────────────────────
create or replace function public.get_rutas(p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare v jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'nombre', r.nombre, 'color', r.color, 'dias', to_jsonb(r.dias),
           'activa', r.activa, 'orden', r.orden,
           'cobertura', (select coalesce(jsonb_agg(jsonb_build_object('tipo', c.tipo, 'valor', c.valor, 'cpHasta', c.cp_hasta) order by c.tipo, c.valor), '[]'::jsonb)
                           from public.rutas_cobertura c where c.id_ruta = r.id)
         ) order by r.orden, r.id), '[]'::jsonb)
    into v
    from public.rutas r
   where r.activa or coalesce((p_data->>'incluirInactivas')::boolean, false);
  return jsonb_build_object('ok', true, 'rutas', v);
end $fn$;
revoke all on function public.get_rutas(jsonb) from public;
grant execute on function public.get_rutas(jsonb) to anon, authenticated;

-- ── 5. Escritura: solo el dueño; reemplaza el conjunto; valida cobertura ───
create or replace function public.set_rutas(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  r jsonb; c jsonb; v_id bigint; v_ids bigint[] := '{}'; v_n int := 0; v_dup text;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  if jsonb_typeof(p_data->'rutas') <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'Faltan rutas');
  end if;
  -- Validar antes de escribir: una colonia o un CP en dos rutas.
  select string_agg(y.valor, ', ') into v_dup
    from (select min(x.valor) as valor
            from (select public.normalizar_colonia(cc->>'valor') || '|' || (cc->>'tipo') as clave,
                         cc->>'valor' as valor, rr->>'nombre' as ruta
                    from jsonb_array_elements(p_data->'rutas') rr,
                         jsonb_array_elements(coalesce(rr->'cobertura', '[]'::jsonb)) cc) x
           group by x.clave having count(distinct x.ruta) > 1) y;
  if v_dup is not null then
    return jsonb_build_object('ok', false, 'error', 'Cobertura repetida en dos rutas: ' || v_dup);
  end if;
  -- Dos rutas con el mismo nombre en la misma petición.
  select string_agg(y.nombre, ', ') into v_dup
    from (select lower(trim(rr->>'nombre')) as nombre from jsonb_array_elements(p_data->'rutas') rr
           group by 1 having count(*) > 1) y;
  if v_dup is not null then
    return jsonb_build_object('ok', false, 'error', 'Dos rutas con el mismo nombre: ' || v_dup);
  end if;
  for r in select * from jsonb_array_elements(p_data->'rutas') loop
    if coalesce(trim(r->>'nombre'), '') = '' then
      return jsonb_build_object('ok', false, 'error', 'Una ruta sin nombre');
    end if;
    v_id := coalesce(nullif(r->>'id', '')::bigint,
                     (select ru.id from public.rutas ru where lower(ru.nombre) = lower(trim(r->>'nombre'))),
                     nextval('public.rutas_id_seq'));
    insert into public.rutas (id, nombre, color, dias, activa, orden, actualizada_en)
    values (v_id,
            trim(r->>'nombre'), coalesce(nullif(r->>'color', ''), '#ffd200'),
            coalesce((select array_agg((d)::int) from jsonb_array_elements_text(coalesce(r->'dias', '[]'::jsonb)) d), '{}'),
            coalesce((r->>'activa')::boolean, true), v_n, now())
    on conflict (id) do update
      set nombre = excluded.nombre, color = excluded.color, dias = excluded.dias,
          activa = excluded.activa, orden = excluded.orden, actualizada_en = now()
    returning id into v_id;
    v_ids := v_ids || v_id; v_n := v_n + 1;
    delete from public.rutas_cobertura where id_ruta = v_id;
    for c in select * from jsonb_array_elements(coalesce(r->'cobertura', '[]'::jsonb)) loop
      if (c->>'tipo') in ('colonia', 'cp') and coalesce(trim(c->>'valor'), '') <> '' then
        insert into public.rutas_cobertura (id_ruta, tipo, valor, cp_hasta)
        values (v_id, c->>'tipo', trim(c->>'valor'), nullif(trim(c->>'cpHasta'), ''));
      end if;
    end loop;
  end loop;
  -- Las que no vienen se desactivan, no se borran: hay pedidos que las citan.
  update public.rutas set activa = false, actualizada_en = now()
   where activa and not (id = any(v_ids));
  perform setval('public.rutas_id_seq', greatest((select coalesce(max(id), 0) from public.rutas), 1));
  return jsonb_build_object('ok', true, 'rutas', v_n);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'Ya existe otra ruta con ese nombre: ' || coalesce(trim(r->>'nombre'), '?'));
end $fn$;
revoke all on function public.set_rutas(jsonb) from public;
grant execute on function public.set_rutas(jsonb) to anon, authenticated;

-- ── 6. Reasignar la ruta de una tienda (sección b2b) ────────────────────────
create or replace function public.reasignar_ruta_cliente(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_id bigint; v_rol text;
  v_cli  bigint := nullif(p_data->>'idCliente', '')::bigint;
  v_ruta bigint := nullif(p_data->>'idRuta', '')::bigint;
  v_nom  text;
begin
  select s.id_vendedor, s.rol into v_id, v_rol from public.sesion_exige_seccion(p_data->>'token', 'b2b') s;
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'No autorizado'); end if;
  if v_cli is null then return jsonb_build_object('ok', false, 'error', 'Falta el cliente'); end if;
  if v_ruta is not null and not exists (select 1 from public.rutas where id = v_ruta) then
    return jsonb_build_object('ok', false, 'error', 'Ruta inexistente');
  end if;
  update public.clientes set id_ruta = v_ruta where id = v_cli;
  if not found then return jsonb_build_object('ok', false, 'error', 'Cliente no encontrado'); end if;
  select nombre into v_nom from public.rutas where id = v_ruta;
  return jsonb_build_object('ok', true, 'idRuta', v_ruta, 'ruta', v_nom);
end $fn$;
revoke all on function public.reasignar_ruta_cliente(jsonb) from public;
grant execute on function public.reasignar_ruta_cliente(jsonb) to anon, authenticated;

-- ── 7. Fecha de entrega v3: con teléfono de una tienda con ruta, el próximo día de ruta ──
create or replace function public.obtener_fecha_entrega(p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_cfg   jsonb := public.get_hora_limite_config();
  v_ahora timestamp := (now() at time zone 'America/Mexico_City');
  v_hoy   date := v_ahora::date;
  v_antes boolean := v_ahora::time < (v_cfg->>'hora')::time;
  v_dias  int := case when v_antes then (v_cfg->>'diasNormal')::int else (v_cfg->>'diasTarde')::int end;
  v_fecha date := v_hoy + v_dias;
  v_msg   text;
  v_ruta_nombre text; v_ruta_dias int[];
  v_i int := 0;
begin
  if coalesce(p_data->>'telefono', '') <> '' then
    select r.nombre, r.dias into v_ruta_nombre, v_ruta_dias
      from public.clientes c join public.rutas r on r.id = c.id_ruta
     where c.telefono = p_data->>'telefono' and c.tipo_id in (2, 3, 4)
       and r.activa and array_length(r.dias, 1) > 0
     limit 1;
  end if;
  if v_ruta_nombre is not null then
    -- Primer día de ruta a partir de la fecha que da la hora límite.
    while v_i < 7 and not (extract(dow from v_fecha + v_i)::int = any(v_ruta_dias)) loop
      v_i := v_i + 1;
    end loop;
    v_fecha := v_fecha + v_i;
    v_msg := 'Tu ruta ' || v_ruta_nombre || ' entrega '
          || array_to_string(array(select case d when 0 then 'domingo' when 1 then 'lunes' when 2 then 'martes'
                                                when 3 then 'miércoles' when 4 then 'jueves' when 5 then 'viernes'
                                                else 'sábado' end
                                     from unnest(v_ruta_dias) d order by d), ' y ')
          || '; pedidos después de las ' || (v_cfg->>'hora') || ' salen en la siguiente';
  else
    if (v_cfg->>'evitarDomingos')::boolean and extract(dow from v_fecha) = 0 then
      v_fecha := v_fecha + 1;
    end if;
    v_msg := case
      when v_antes and v_dias = 1 then 'Pedidos antes de las ' || (v_cfg->>'hora') || ' se entregan mañana'
      when v_antes then 'Pedidos antes de las ' || (v_cfg->>'hora') || ' se entregan en ' || v_dias || ' días'
      else 'Después de las ' || (v_cfg->>'hora') || ' la entrega es en ' || v_dias || ' días'
    end;
    if not exists (select 1 from public.lotes_produccion
                    where lower(coalesce(estatus, '')) <> 'cerrado' and coalesce(kilos_disponibles, 0) > 0) then
      v_msg := v_msg || ' · sin lote activo, la fecha puede moverse';
    end if;
  end if;
  return jsonb_build_object(
    'ok', true,
    'fecha', to_char(v_fecha, 'YYYY-MM-DD'),
    'fechaDisplay', to_char(v_fecha, 'TMDay DD "de" TMMonth'),
    'msg', v_msg);
end $fn$;
revoke all on function public.obtener_fecha_entrega(jsonb) from public;
grant execute on function public.obtener_fecha_entrega(jsonb) to anon, authenticated;

-- ── 8. cola_armado con la ruta de cada pedido (misma función de 20260921 + ruta) ──
create or replace function public.cola_armado(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
declare
  v_id bigint; v_rol text;
  v_fecha date;
  v_desde timestamptz;
  v_cfg jsonb;
  v_nuevos jsonb; v_resumen jsonb; v_pedidos jsonb; v_porconf jsonb; v_tot jsonb;
begin
  select s.id_vendedor, s.rol into v_id, v_rol
    from public.sesion_exige_seccion(p_data->>'token', 'armado') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  v_cfg   := public.get_hora_limite_config();
  v_fecha := coalesce(nullif(p_data->>'fecha', '')::date,
                      (now() at time zone 'America/Mexico_City')::date + 1);
  v_desde := coalesce(nullif(p_data->>'desde', '')::timestamptz, now() - interval '24 hours');

  select coalesce(jsonb_agg(r.fila order by r.fila->>'sabor', r.fila->>'presentacion'), '[]'::jsonb)
    into v_resumen
    from (
      select jsonb_build_object(
               'sabor', l.sabor, 'presentacion', l.presentacion,
               'piezas', sum(l.piezas), 'kg', round(sum(l.kg)::numeric, 3),
               'cajas', (select coalesce(jsonb_agg(jsonb_build_object('piezasPorCaja', c.ppc, 'cajas', c.n)), '[]'::jsonb)
                           from (select l2.piezas_por_caja as ppc, sum(l2.cantidad / l2.piezas_por_caja) as n
                                   from public.lineas_armado_interno(v_fecha) l2
                                  where l2.sabor = l.sabor and l2.presentacion = l.presentacion
                                    and coalesce(l2.piezas_por_caja, 0) > 0
                                  group by l2.piezas_por_caja) c)
             ) as fila
        from public.lineas_armado_interno(v_fecha) l
       group by l.sabor, l.presentacion
    ) r;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'consecutivo', o.consecutivo, 'cliente', o.nombre_cliente,
           'negocio', c.nombre_comercial, 'canal', o.canal, 'idVendedor', o.id_vendedor,
           'vendedor', o.nombre_vendedor, 'tipoInterno', coalesce(o.tipo_interno, ''),
           'total', o.total, 'fechaOrden', o.fecha_orden,
           'armadoEn', o.armado_en, 'armadoPor', o.armado_por,
           'idRuta', o.id_ruta, 'ruta', ru.nombre, 'rutaColor', ru.color, 'rutaOrden', ru.orden,
           'lineas', (select coalesce(jsonb_agg(jsonb_build_object(
                        'sabor', l.sabor, 'presentacion', l.presentacion, 'tipoVenta', l.tipo_venta,
                        'cantidad', l.cantidad, 'piezasPorCaja', l.piezas_por_caja,
                        'gramos', l.gramos_vendidos, 'kg', round(l.kg::numeric, 3)) order by l.sabor), '[]'::jsonb)
                        from public.lineas_armado_interno(v_fecha) l where l.id_orden = o.id)
         ) order by o.armado_en nulls first, ru.orden nulls last, o.fecha_orden), '[]'::jsonb)
    into v_pedidos
    from public.ordenes o
    left join public.clientes c on c.id = o.id_cliente
    left join public.rutas ru on ru.id = o.id_ruta
   where o.fecha_entrega::date = v_fecha
     and o.estatus_pedido = 'En proceso';

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'consecutivo', o.consecutivo, 'cliente', o.nombre_cliente,
           'negocio', c.nombre_comercial, 'canal', o.canal, 'total', o.total, 'fechaOrden', o.fecha_orden,
           'idRuta', o.id_ruta, 'ruta', ru.nombre, 'rutaColor', ru.color, 'rutaOrden', ru.orden
         ) order by o.fecha_orden), '[]'::jsonb)
    into v_porconf
    from public.ordenes o
    left join public.clientes c on c.id = o.id_cliente
    left join public.rutas ru on ru.id = o.id_ruta
   where o.fecha_entrega::date = v_fecha
     and o.estatus_pedido = 'Pendiente';

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'consecutivo', o.consecutivo, 'fechaOrden', o.fecha_orden,
           'cliente', o.nombre_cliente, 'negocio', c.nombre_comercial, 'canal', o.canal,
           'total', o.total, 'estatus', o.estatus_pedido, 'fechaEntrega', o.fecha_entrega::date,
           'idRuta', o.id_ruta, 'ruta', ru.nombre, 'rutaColor', ru.color, 'rutaOrden', ru.orden,
           'lineasResumen', (select string_agg(trim_scale(d.cantidad)::text || ' × ' || d.sabor || ' ' || d.presentacion, ' · ')
                               from public.ordenes_detalle d where d.id_orden = o.id)
         ) order by o.fecha_orden desc), '[]'::jsonb)
    into v_nuevos
    from (select * from public.ordenes o2
           where o2.fecha_orden > v_desde and o2.estatus_pedido <> 'Cancelado'
           order by o2.fecha_orden desc limit 50) o
    left join public.clientes c on c.id = o.id_cliente
    left join public.rutas ru on ru.id = o.id_ruta;

  select jsonb_build_object(
           'pedidos', count(distinct o.id),
           'armados', count(distinct o.id) filter (where o.armado_en is not null),
           'kg', round(coalesce(sum(l.kg), 0)::numeric, 3),
           'piezas', coalesce(sum(l.piezas), 0))
    into v_tot
    from public.ordenes o
    left join public.lineas_armado_interno(v_fecha) l on l.id_orden = o.id
   where o.fecha_entrega::date = v_fecha
     and o.estatus_pedido = 'En proceso';

  return jsonb_build_object(
    'ok', true, 'fecha', to_char(v_fecha, 'YYYY-MM-DD'), 'horaLimite', v_cfg->>'hora',
    'nuevos', v_nuevos, 'resumen', v_resumen, 'pedidos', v_pedidos,
    'porConfirmar', v_porconf, 'totales', v_tot);
end;
$fn$;
revoke all on function public.cola_armado(jsonb) from public;
grant execute on function public.cola_armado(jsonb) to anon, authenticated;
