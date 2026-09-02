-- ═══════════════════════════════════════════════════════════════════════════
-- Insumos y consumibles salen de Google Sheets (fase 2)
--
-- Seis de las nueve acciones que quedaban en Apps Script viven aquí:
--   get_insumos · guardar_insumos · get_consumibles · guardar_consumibles
--   registrar_uso_insumo · get_uso_insumo
--
-- POR QUÉ CLAVE/VALOR Y NO COLUMNAS.
-- La tabla `insumos` que ya existía (vacía, 0 filas en producción) es un
-- CATÁLOGO: un renglón por insumo, con nombre, unidad, costo y proveedor. La
-- app no maneja eso. Manda un saco plano de claves, y buena parte se genera
-- en tiempo de ejecución a partir de dos listas del front:
--
--   SABORES_COND          -> cond_<sabor>_kg,     cond_<sabor>_min
--   PRESENTACIONES_BOLSAS -> bolsa_<pres>_piezas, bolsa_<pres>_min
--                            etiq_<pres>_piezas,  etiq_<pres>_min
--
-- Con columnas fijas, añadir un sabor exigiría una migración. Clave/valor no
-- es un atajo aquí: es el modelo que corresponde a un formulario cuyo conjunto
-- de campos lo decide el front.
--
-- El valor se guarda como jsonb, no como texto, para que un número siga siendo
-- número al volver (aceite_calidad es el único campo de texto).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.insumos_estado (
  grupo           text        not null,
  clave           text        not null,
  valor           jsonb       not null,
  actualizado     timestamptz not null default now(),
  actualizado_por bigint      references public.vendedores(id),
  primary key (grupo, clave),
  constraint insumos_estado_grupo_valido check (grupo in ('insumos','consumibles')),
  constraint insumos_estado_clave_valida check (char_length(clave) between 1 and 64)
);

comment on table public.insumos_estado is
  'Estado de insumos y consumibles. Clave/valor porque el front genera parte de las claves desde SABORES_COND y PRESENTACIONES_BOLSAS.';

-- Nadie llega a la tabla directamente: solo por los RPC de abajo.
alter table public.insumos_estado enable row level security;
revoke select, insert, update, delete, truncate on public.insumos_estado from anon;
revoke select, insert, update, delete, truncate on public.insumos_estado from authenticated;

-- ── LECTURA ────────────────────────────────────────────────────────────────
create or replace function public.obtener_insumos_estado(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare
  v_id    bigint;
  v_grupo text;
  v_vals  jsonb;
begin
  -- Autorizar ANTES de validar: si no, el mensaje de error enseña las reglas
  -- a quien no tiene permiso de conocerlas.
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'produccion') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  v_grupo := coalesce(p_data->>'grupo', 'insumos');
  if v_grupo not in ('insumos','consumibles') then
    return jsonb_build_object('ok', false, 'error', 'Grupo inválido');
  end if;

  select coalesce(jsonb_object_agg(clave, valor), '{}'::jsonb) into v_vals
    from public.insumos_estado where grupo = v_grupo;

  return jsonb_build_object('ok', true, 'valores', v_vals);
end $fn$;

-- ── ESCRITURA ──────────────────────────────────────────────────────────────
create or replace function public.guardar_insumos_estado(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare
  v_id    bigint;
  v_grupo text;
  v_vals  jsonb;
  v_n     int;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'produccion') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  v_grupo := coalesce(p_data->>'grupo', 'insumos');
  if v_grupo not in ('insumos','consumibles') then
    return jsonb_build_object('ok', false, 'error', 'Grupo inválido');
  end if;

  v_vals := p_data->'valores';
  if v_vals is null or jsonb_typeof(v_vals) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'Faltan valores');
  end if;

  -- Tope defensivo: el formulario manda ~37 claves. Nadie necesita mandar
  -- miles, y sin tope una sola llamada podría llenar la tabla.
  if (select count(*) from jsonb_object_keys(v_vals)) > 200 then
    return jsonb_build_object('ok', false, 'error', 'Demasiadas claves');
  end if;

  insert into public.insumos_estado (grupo, clave, valor, actualizado, actualizado_por)
  select v_grupo, k.clave, v_vals -> k.clave, now(), v_id
    from jsonb_object_keys(v_vals) as k(clave)
   -- Se ignora en silencio lo que no encaje, en vez de abortar el guardado
   -- entero por una clave rara: el formulario no tiene forma de generarlas.
   where char_length(k.clave) between 1 and 64
     and jsonb_typeof(v_vals -> k.clave) in ('number','string')
  on conflict (grupo, clave) do update
     set valor           = excluded.valor,
         actualizado     = excluded.actualizado,
         actualizado_por = excluded.actualizado_por;

  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'guardadas', v_n);
end $fn$;

-- ── USO DE INSUMOS ─────────────────────────────────────────────────────────
-- `uso_insumos` ya existía y su forma sí encaja, así que se reutiliza tal cual.
create or replace function public.registrar_uso_insumo(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare
  v_id     bigint;
  v_nombre text;
  v_cant   numeric;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'produccion') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  v_nombre := nullif(btrim(coalesce(p_data->>'tipo','')), '');
  if v_nombre is null then
    return jsonb_build_object('ok', false, 'error', 'Falta el tipo de insumo');
  end if;

  begin
    v_cant := (p_data->>'cantidad')::numeric;
  exception when others then
    v_cant := null;
  end;
  if v_cant is null or v_cant <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Cantidad inválida');
  end if;

  -- Ni la fecha ni el vendedor vienen del cliente. El navegador mandaba ambos
  -- y ninguno era comprobable: quien registra sale del token, y la hora, del
  -- reloj del servidor.
  insert into public.uso_insumos (nombre_insumo, cantidad, fecha, registrado_por)
  values (v_nombre, v_cant, now(),
          (select v.nombre from public.vendedores v where v.id = v_id));

  return jsonb_build_object('ok', true);
end $fn$;

create or replace function public.obtener_uso_insumo(p_data jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $fn$
declare
  v_id   bigint;
  v_tipo text;
  v_lim  int;
  v_regs jsonb;
begin
  select s.id_vendedor into v_id
    from public.sesion_exige_seccion(p_data->>'token', 'produccion') s;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  v_tipo := nullif(btrim(coalesce(p_data->>'tipo','')), '');
  v_lim  := least(greatest(coalesce(nullif(p_data->>'limite','')::int, 3), 1), 50);

  -- `vendedor` sale de registrado_por: el historial lo pinta entre paréntesis,
  -- y sin él la línea mostraría "(undefined)".
  select coalesce(jsonb_agg(jsonb_build_object(
           'fecha',    u.fecha,
           'tipo',     u.nombre_insumo,
           'cantidad', u.cantidad,
           'vendedor', coalesce(u.registrado_por, '—'))), '[]'::jsonb)
    into v_regs
    from (select * from public.uso_insumos
           where v_tipo is null or nombre_insumo = v_tipo
           order by fecha desc
           limit v_lim) u;

  return jsonb_build_object('ok', true, 'registros', v_regs);
end $fn$;

-- ── PERMISOS ───────────────────────────────────────────────────────────────
-- El navegador llama con la llave anon; la cerradura está dentro de cada
-- función, en sesion_exige_seccion.
grant execute on function public.obtener_insumos_estado(jsonb) to anon, authenticated, service_role;
grant execute on function public.guardar_insumos_estado(jsonb) to anon, authenticated, service_role;
grant execute on function public.registrar_uso_insumo(jsonb)   to anon, authenticated, service_role;
grant execute on function public.obtener_uso_insumo(jsonb)     to anon, authenticated, service_role;
