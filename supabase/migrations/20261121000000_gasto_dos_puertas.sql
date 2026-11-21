-- ============================================================================
--  El gasto se captura por DOS puertas, y solo hay UN sitio que escribe
--
--  Diseno: cambios/2026-11-21-capturar-el-gasto.md
--
--  QUE SE ENCONTRO ANTES DE ESCRIBIR ESTO (y cambio el plan):
--  La pantalla de gastos YA EXISTE, es completa -once campos, foto del ticket
--  incluida- y Abraham SI la ve (`gastos` esta en sus `vendedores.secciones`).
--  No habia nada que construir ahi. Lo que falta no es la puerta: es que el
--  gasto ocurre en la calle y la pantalla pide sentarse.
--
--  Por eso se abre una SEGUNDA puerta -la foto del ticket por WhatsApp- y NO
--  se toca la primera.
--
--  LA REGLA QUE ORDENA TODO ESTO: dos puertas que escriben lo mismo por su
--  cuenta son dos verdades esperando a separarse (regla 63: una copia que
--  nadie compara, repite). Asi que la escritura se saca a
--  `guardar_gasto_interno` y las dos puertas la llaman. `guardar_gasto` queda
--  igual de puertas afuera: mismo nombre, mismo payload, misma respuesta.
--
--  LA APROBACION NO SE QUITA: SE DEJA DE PAGAR DOS VECES
--  Decision de Abraham, 21 nov: «No descartemos las aprobaciones, solo que no
--  sea un punto de friccion.»
--
--  El agente TIENE que preguntar antes de escribir, porque lee el monto de una
--  foto y puede leerlo mal. Ese «si» ya existe. Asi que ese mismo «si» ES la
--  aprobacion cuando quien lo dice puede aprobar. Un paso, no dos.
--
--  Y lo que NO cambia:
--  * El modelo NUNCA escribe `estatus`, `aprobado_por`, `fecha_aprobacion` ni
--    `motivo_rechazo`. Se le quitan del payload aunque los mande. Lo unico que
--    puede pasar es un booleano `aprobar` que significa «la persona dijo que
--    si»; QUIEN decide si esa persona puede aprobar es el servidor, mirando su
--    rol, y es el servidor quien estampa los campos.
--  * Si quien escribe NO es admin, el gasto nace 'pendiente' pase lo que pase.
--    Un repartidor confirma el dato; no aprueba el dinero.
--  Es la regla 10 -el navegador no decide dinero- aplicada al modelo, que es
--  el navegador de hoy, sin convertir la aprobacion en un tramite.
--
--  El canal queda escrito en `aprobado_por` («… · WhatsApp»), para que una
--  revision pueda separar lo aprobado por voz de lo aprobado mirando.
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

-- ── 0. El AREA del negocio a la que pertenece el costo ───────────────
-- Las siete `categoria` que existen mezclan QUE se compro ("Empaque") con
-- PARA QUE parte del negocio ("Logistica"), asi que hoy un acumulado por
-- area no sale: la gasolina del reparto cae en Logistica y el sueldo del
-- repartidor en Nomina, junto al de produccion. `categoria` se queda
-- diciendo QUE; `area` dice DE QUIEN ES EL COSTO. Es lo que falta para la
-- metrica que importa -«¿el reparto vende o solo carga?»-, porque el margen
-- de ruta resta los gastos DEL REPARTO y hoy estan en tres categorias.
--
-- Decision de Abraham, 21 nov, al preguntar si preventa y reparto podrian
-- registrar gastos. NO pueden -ni por la app ni por aqui: las dos puertas
-- exigen la misma seccion-, y de esa pregunta salio esto.

alter table public.gastos add column if not exists area text;

comment on column public.gastos.area is
  'A que parte del negocio pertenece el costo (Produccion / Reparto / Preventa / '
  'Administracion / Marketing). Distinto de `categoria`, que dice QUE se compro. '
  'Nullable: lo viejo no se clasifica a la fuerza.';

-- Cerrado por omision, como todo lo demas (regla 37): si no es una de las
-- cinco, no entra. El agente es un escritor nuevo y una errata suya partiria
-- el acumulado en silencio.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gastos_area_valida') then
    alter table public.gastos
      add constraint gastos_area_valida check (
        area is null or area in
          ('Producción', 'Reparto', 'Preventa', 'Administración', 'Marketing')
      );
  end if;
end $$;

create index if not exists idx_gastos_area_fecha on public.gastos (area, fecha);

-- ── La normalizacion: 'produccion' y 'Producción' son la misma area ─────────
create or replace function public.gasto_area_normal(p_area text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  -- `translate` y no `unaccent`: la extension no esta instalada en este
--   proyecto —comprobado, no supuesto— y una funcion nueva no es el sitio
--   para pedir una extension nueva.
  select case translate(lower(trim(coalesce(p_area, ''))),
                        'áéíóúüñ', 'aeiouun')
    when 'produccion'     then 'Producción'
    when 'reparto'        then 'Reparto'
    when 'preventa'       then 'Preventa'
    when 'administracion' then 'Administración'
    when 'admin'          then 'Administración'
    when 'marketing'      then 'Marketing'
    when 'mercadotecnia'  then 'Marketing'
    else null
  end;
$$;

revoke all on function public.gasto_area_normal(text) from public, anon, authenticated;
grant execute on function public.gasto_area_normal(text) to service_role, authenticated;

-- ── 1. El unico sitio que escribe en `gastos` ───────────────────────────────
-- Es el cuerpo que tenia `guardar_gasto`, tal cual, sin la busqueda de sesion.
-- No se "mejora" nada al moverlo: si cambia el comportamiento, el cambio se
-- esconde dentro de un refactor y nadie lo ve.
create or replace function public.guardar_gasto_interno(
  p_id_vendedor bigint,
  p_admin       boolean,
  p_campos      jsonb,
  p_id          bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id    bigint := p_id;
  v_c     jsonb  := coalesce(p_campos, '{}'::jsonb);
  v_clave text;
  v_permitidas constant text[] := array[
    'fecha','categoria','subcategoria','descripcion','monto','moneda','metodo_pago',
    'proveedor','rfc_proveedor','tiene_factura','ticket_url','notas','estatus',
    'motivo_rechazo','aprobado_por','fecha_aprobacion','fuente_dinero','area'
  ];
begin
  if p_id_vendedor is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  -- Lista blanca, cerrado por omision (regla 37). Un campo que no esta aqui no
  -- se ignora: se rechaza, para que quien lo mando se entere.
  for v_clave in select jsonb_object_keys(v_c) loop
    if not (v_clave = any(v_permitidas)) then
      return jsonb_build_object('ok', false, 'error', 'Campo no permitido: ' || v_clave);
    end if;
  end loop;

  if v_id is null then
    -- El vendedor sale de QUIEN LLAMA, nunca del payload: nadie registra
    -- gastos a nombre de otro.
    -- DEFECTO QUE YA ESTABA, Y LO ENCONTRO LA PRUEBA, no la lectura:
    -- `aprobado_por`, `fecha_aprobacion` y `motivo_rechazo` estaban en la lista
    -- blanca -o sea, se ACEPTABAN al crear- pero no estaban en este INSERT, asi
    -- que se tiraban en silencio y solo se aplicaban al editar. Un gasto podia
    -- nacer 'aprobado' SIN constancia de quien lo aprobo. Se arreglan aqui
    -- porque es el rastro del dinero, no un detalle de forma.
    insert into public.gastos (fecha, categoria, subcategoria, descripcion, monto,
      moneda, metodo_pago, proveedor, rfc_proveedor, tiene_factura, ticket_url,
      notas, estatus, fuente_dinero, id_vendedor, nombre_vendedor,
      aprobado_por, fecha_aprobacion, motivo_rechazo, area)
    values (coalesce((v_c->>'fecha')::date, current_date), v_c->>'categoria',
      v_c->>'subcategoria', v_c->>'descripcion', (v_c->>'monto')::numeric,
      coalesce(nullif(v_c->>'moneda',''), 'MXN'), v_c->>'metodo_pago',
      v_c->>'proveedor', v_c->>'rfc_proveedor',
      coalesce((v_c->>'tiene_factura')::boolean, false), v_c->>'ticket_url',
      v_c->>'notas', coalesce(nullif(v_c->>'estatus',''), 'pendiente'),
      v_c->>'fuente_dinero', p_id_vendedor,
      (select v.nombre from public.vendedores v where v.id = p_id_vendedor),
      v_c->>'aprobado_por', (v_c->>'fecha_aprobacion')::timestamptz,
      v_c->>'motivo_rechazo', public.gasto_area_normal(v_c->>'area'))
    returning id into v_id;
    return jsonb_build_object('ok', true, 'id', v_id, 'creado', true);
  end if;

  update public.gastos g set
    fecha            = coalesce((v_c->>'fecha')::date, g.fecha),
    categoria        = coalesce(v_c->>'categoria', g.categoria),
    subcategoria     = coalesce(v_c->>'subcategoria', g.subcategoria),
    descripcion      = coalesce(v_c->>'descripcion', g.descripcion),
    monto            = coalesce((v_c->>'monto')::numeric, g.monto),
    metodo_pago      = coalesce(v_c->>'metodo_pago', g.metodo_pago),
    proveedor        = coalesce(v_c->>'proveedor', g.proveedor),
    rfc_proveedor    = coalesce(v_c->>'rfc_proveedor', g.rfc_proveedor),
    tiene_factura    = coalesce((v_c->>'tiene_factura')::boolean, g.tiene_factura),
    ticket_url       = coalesce(v_c->>'ticket_url', g.ticket_url),
    notas            = coalesce(v_c->>'notas', g.notas),
    estatus          = coalesce(v_c->>'estatus', g.estatus),
    motivo_rechazo   = coalesce(v_c->>'motivo_rechazo', g.motivo_rechazo),
    aprobado_por     = coalesce(v_c->>'aprobado_por', g.aprobado_por),
    fecha_aprobacion = coalesce((v_c->>'fecha_aprobacion')::timestamptz, g.fecha_aprobacion),
    fuente_dinero    = coalesce(v_c->>'fuente_dinero', g.fuente_dinero),
    area             = coalesce(public.gasto_area_normal(v_c->>'area'), g.area),
    fecha_actualizacion = now()
  where g.id = v_id and (p_admin or g.id_vendedor = p_id_vendedor);

  if not found then return jsonb_build_object('ok', false, 'error', 'Gasto no encontrado'); end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'creado', false);
end $$;

revoke all on function public.guardar_gasto_interno(bigint, boolean, jsonb, bigint)
  from public, anon, authenticated;

-- ── 2. Puerta 1: la pantalla de siempre. No cambia de puertas afuera ────────
create or replace function public.guardar_gasto(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id_vend bigint; v_rol text;
begin
  select s.id_vendedor, s.rol into v_id_vend, v_rol
    from public.sesion_exige_seccion(p_data->>'token', 'gastos') s;
  if v_id_vend is null then return jsonb_build_object('ok', false, 'error', 'No autorizado'); end if;

  return public.guardar_gasto_interno(
    v_id_vend,
    lower(trim(coalesce(v_rol,''))) in ('admin','administrador'),
    coalesce(p_data->'campos', '{}'::jsonb),
    nullif(p_data->>'id','')::bigint
  );
end $$;

-- ── 3. Puerta 2: la foto del ticket por WhatsApp ────────────────────────────
-- Identifica por TELEFONO, no por token: el agente corre con la llave de
-- servicio y no tiene sesion de nadie. Quien escribe tiene que ser un vendedor
-- con la seccion `gastos` en su lista personal -la misma condicion que exige
-- `sesion_exige_seccion` en la otra puerta-.
create or replace function public.wa_registrar_gasto(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tel    text := regexp_replace(coalesce(p_data->>'telefono',''), '[^0-9]', '', 'g');
  v_ident  jsonb;
  v_vend   bigint;
  v_rol    text;
  v_sec    text[];
  v_nombre text;
  v_admin  boolean;
  v_c      jsonb := coalesce(p_data->'campos', '{}'::jsonb);
  -- «La persona dijo que si». NO es «aprobado»: quien decide eso es el rol.
  v_dijo_si boolean := coalesce((p_data->>'aprobar')::boolean, false);
begin
  if v_tel = '' then
    return jsonb_build_object('ok', false, 'error', 'Sin telefono');
  end if;

  v_ident := public.wa_identidad(v_tel);
  v_vend  := nullif(v_ident->>'idVendedor','')::bigint;
  v_rol   := v_ident->>'rol';

  if v_vend is null then
    return jsonb_build_object('ok', false, 'error', 'Quien escribe no es del equipo');
  end if;

  select v.secciones, v.nombre into v_sec, v_nombre
    from public.vendedores v where v.id = v_vend;
  if not ('gastos' = any(coalesce(v_sec, array[]::text[]))) then
    return jsonb_build_object('ok', false, 'error', 'Sin permiso de gastos');
  end if;

  -- EL MODELO NO ESCRIBE EL FLUJO DE APROBACION. Los cuatro campos se le quitan
  -- al payload aunque los mande; el servidor los estampa mas abajo, o no.
  -- Quitarlos aqui -y no confiar en que el prompt se lo pida- es la diferencia
  -- entre un permiso y una frase (regla 35).
  v_c := v_c - 'estatus' - 'aprobado_por' - 'fecha_aprobacion' - 'motivo_rechazo';

  if (v_c->>'monto') is null or (v_c->>'monto')::numeric <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Falta el monto');
  end if;
  if coalesce(v_c->>'categoria','') = '' then
    return jsonb_build_object('ok', false, 'error', 'Falta la categoria');
  end if;

  -- EL «SI» VALE COMO APROBACION SOLO SI QUIEN LO DICE PUEDE APROBAR.
  -- Para el dueno, confirmar el monto leido de la foto y aprobarlo son el
  -- mismo acto: ya dijo que si a una cifra y un proveedor concretos. Para
  -- cualquier otro, su «si» confirma el DATO y el gasto queda pendiente.
  v_admin := lower(trim(coalesce(v_rol,''))) in ('admin','administrador');
  if v_dijo_si and v_admin then
    v_c := v_c
      || jsonb_build_object('estatus', 'aprobado')
      -- El canal queda escrito: una revision puede separar lo aprobado por
      -- WhatsApp de lo aprobado mirando la pantalla.
      || jsonb_build_object('aprobado_por', coalesce(v_nombre, 'Desconocido') || ' · WhatsApp')
      || jsonb_build_object('fecha_aprobacion', now()::text);
  end if;

  -- `p_admin` va en false a proposito: por esta puerta solo se CREA, nunca se
  -- edita el gasto de otro. El id tambien va en null por lo mismo.
  return public.guardar_gasto_interno(v_vend, false, v_c, null);
end $$;

revoke all on function public.wa_registrar_gasto(jsonb) from public, anon, authenticated;
grant execute on function public.wa_registrar_gasto(jsonb) to service_role;
