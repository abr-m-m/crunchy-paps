-- ════════════════════════════════════════════════════════════════════════════
--  REPORTES — la bandeja de entrada de lo que el equipo ve usando la app
--  23 nov 2026. Idea de Abraham: «una pagina similar al configurador de rutas
--  para ir reportando cada uno de los ajustes o nuevos features».
--
--  POR QUE UNA BANDEJA Y NO UN SEGUNDO MAPA. El mapa de trabajo vive en
--  mapa-trabajo/frentes.json y su valor es que el CRITERIO -a que frente
--  pertenece algo, que prioridad tiene- se escribe a mano con fecha. Si esta
--  pagina escribiera frentes y prioridades, habria DOS fuentes de verdad que
--  alguien tendria que casar a mano, y eso es exactamente la deuda que el
--  indice de cambios acaba de medir: 116 documentos que existen y no se
--  encuentran.
--
--  Asi que el flujo tiene dos etapas y una sola direccion:
--    capturar (esta tabla, cualquiera del equipo, desde la calle)
--      -> triar (Abraham, al abrir sesion: pasa a frentes.json o se descarta)
--  Un reporte triado deja de pesar. Uno sin triar lo cuenta el generador del
--  mapa, asi que no se puede olvidar.
--
--  LO QUE NO HACE: no tiene prioridad, ni frente, ni avance. Eso es criterio,
--  y el criterio no se captura en un formulario de la calle.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.reportes (
  id           bigserial primary key,
  texto        text        not null check (length(btrim(texto)) between 3 and 2000),
  tipo         text        not null default 'ux'
               check (tipo in ('ux', 'error', 'idea')),
  pantalla     text,                       -- la seccion donde lo vio, si la sabe
  id_vendedor  bigint      references public.vendedores(id),
  nombre       text,                       -- quien lo reporto, congelado
  foto_url     text,
  estado       text        not null default 'nuevo'
               check (estado in ('nuevo', 'triado', 'descartado')),
  nota_triaje  text,                       -- a donde fue, o por que no
  creado_en    timestamptz not null default now(),
  triado_en    timestamptz
);

create index if not exists ix_reportes_estado on public.reportes (estado, creado_en desc);

-- Cerrada por RLS y SIN politicas: la llave publica no lee ni escribe ni una
-- fila. Se entra solo por los RPC de abajo, que son security definer y
-- comprueban la sesion. Dos cerraduras, no una (regla 41).
alter table public.reportes enable row level security;
revoke all on public.reportes from anon, authenticated;

-- ── Capturar. Cualquiera del equipo con sesion de vendedor. ─────────────────
create or replace function public.reportar(p_data jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_vend  bigint;
  v_nom   text;
  v_id    bigint;
begin
  -- Reportar lo puede hacer CUALQUIERA DEL EQUIPO, no solo el dueno: ese es
  -- el punto de la pagina. El unico resolvedor de token que hay es
  -- `sesion_exige_seccion`, que pide una seccion, asi que se usa `pedidos`
  -- porque es la UNICA que tienen los 9 vendedores activos — medido el 23 nov
  -- 2026, no supuesto. Aqui significa «tiene sesion de equipo».
  -- Si algun dia un rol se queda sin `pedidos`, esta linea hay que revisarla.
  select s.id_vendedor into v_vend
    from public.sesion_exige_seccion(p_data->>'token', 'pedidos') s;
  if v_vend is null then
    return jsonb_build_object('ok', false, 'error', 'sin_sesion');
  end if;
  select v.nombre into v_nom from public.vendedores v where v.id = v_vend;

  insert into public.reportes (texto, tipo, pantalla, id_vendedor, nombre, foto_url)
  values (btrim(p_data->>'texto'),
          coalesce(nullif(p_data->>'tipo', ''), 'ux'),
          nullif(p_data->>'pantalla', ''),
          v_vend,
          v_nom,
          nullif(p_data->>'foto', ''))
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- ── Leer. Solo el dueno. ────────────────────────────────────────────────────
create or replace function public.reportes_admin(p_data jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_r jsonb;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'solo_dueno');
  end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.creado_en desc), '[]'::jsonb)
    into v_r
    from public.reportes r
   where coalesce(p_data->>'estado', 'nuevo') = 'todos'
      or r.estado = coalesce(p_data->>'estado', 'nuevo');
  return jsonb_build_object('ok', true, 'reportes', v_r);
end $$;

-- ── Triar. Solo el dueno. Un reporte triado deja de pesar. ──────────────────
create or replace function public.triar_reporte(p_data jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_estado text;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'solo_dueno');
  end if;
  v_estado := coalesce(p_data->>'estado', 'triado');
  if v_estado not in ('triado', 'descartado') then
    return jsonb_build_object('ok', false, 'error', 'estado_invalido');
  end if;
  update public.reportes
     set estado = v_estado,
         nota_triaje = nullif(p_data->>'nota', ''),
         triado_en = now()
   where id = (p_data->>'id')::bigint;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_existe');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Una funcion nueva concede EXECUTE a PUBLIC por defecto (regla 42): se quita
-- y se da a mano, que es lo unico que impide un endpoint publico por descuido.
revoke all on function public.reportar(jsonb)        from public, anon, authenticated;
revoke all on function public.reportes_admin(jsonb)  from public, anon, authenticated;
revoke all on function public.triar_reporte(jsonb)   from public, anon, authenticated;
grant execute on function public.reportar(jsonb)       to anon, authenticated;
grant execute on function public.reportes_admin(jsonb) to anon, authenticated;
grant execute on function public.triar_reporte(jsonb)  to anon, authenticated;
