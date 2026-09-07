-- ═══════════════════════════════════════════════════════════════════════════
-- Arreglar las tres funciones que escriben columnas que no existen
-- 6 sep 2026 · ver cambios/2026-09-06-auditoria-prospeccion-produccion.md
--
-- PL/pgSQL no valida nombres de columna al crear la función (check_function_bodies
-- comprueba sintaxis, no identificadores) y los campos de un RECORD se resuelven
-- en EJECUCIÓN. Por eso estas tres se aplicaron limpiamente y llevan meses
-- reventando en la primera llamada:
--
--   1. guardar_cupon                        → cupones.fecha_inicio/fecha_fin/monto_minimo
--   2. convertir_prospecto_a_cliente_interno → prospectos.tipo/.telefono/... y clientes.notas
--   3. importar_prospectos_bulk_interno      → prospectos.tipo/tipo_id/nombre/telefono/cp/fecha_alta
--
-- Dos de ellas llevan EXCEPTION WHEN OTHERS y devolvían ok:true igualmente, que
-- es por lo que nadie lo vio: la importación decía «✅ Prueba exitosa: 0 creado(s)».
--
-- SE ARREGLA EL SQL, NO LA APP. Las tres leen ahora las claves que el navegador
-- YA manda, así que esto no necesita desplegar `index.html`: el arreglo entra
-- entero por el dashboard. Es también el orden de menor daño (PLAN.md §1.3): si
-- algo saliera mal, la app sigue exactamente como está hoy.
--
-- Se corrigen SOLO los nombres y lo que sin ello dejaría la función inútil. No
-- se añade funcionalidad: los prospectos importados siguen sin quedar atribuidos
-- a un vendedor, igual que hoy, y eso es una decisión aparte.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1) guardar_cupon — crear y editar cupones
-- ───────────────────────────────────────────────────────────────────────────
-- Roto por partida doble desde 20260905010000: leía del payload `fecha_inicio`,
-- `fecha_fin` y `monto_minimo` —claves que la app NUNCA manda; manda
-- `vigencia_inicio`, `vigencia_fin` y `compra_minima` (index.html:16162)— y
-- escribía esos mismos nombres como columnas, que tampoco existen.
--
-- `validar_cupon` sí lee `vigencia_inicio`, así que los cupones YA creados
-- funcionan en el checkout: lo único roto era crear y editar.
--
-- Sin `revoke`: la app lo llama con la llave pública y el candado es la
-- comprobación de sesión y sección de dentro. Es deliberado, no un olvido.
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
    -- `segmento` es NOT NULL DEFAULT 'todos' y la app SÍ lo manda (cf-segmento);
    -- la versión rota ni lo escribía, así que se perdía. Se incluye con el valor
    -- por defecto de la columna como red.
    -- `un_uso_por_usuario` NO se escribe a propósito: la app no lo manda y su
    -- default es TRUE. Ponerlo aquí con un coalesce a false habría vuelto
    -- reutilizable por cliente cada cupón nuevo, que es dinero.
    insert into public.cupones (codigo, descripcion, tipo, valor, activo,
                                vigencia_inicio, vigencia_fin, usos_maximos,
                                compra_minima, segmento)
    values (upper(trim(v_c->>'codigo')), v_c->>'descripcion',
            coalesce(nullif(v_c->>'tipo',''), 'descuento_pct'),
            (v_c->>'valor')::numeric, coalesce((v_c->>'activo')::boolean, true),
            coalesce((v_c->>'vigencia_inicio')::timestamptz, now()),
            (v_c->>'vigencia_fin')::timestamptz,
            (v_c->>'usos_maximos')::int,
            coalesce((v_c->>'compra_minima')::numeric, 0),
            coalesce(nullif(v_c->>'segmento',''), 'todos'))
    returning id into v_id;
    return jsonb_build_object('ok', true, 'id', v_id, 'creado', true);
  end if;

  update public.cupones c set
    descripcion        = coalesce(v_c->>'descripcion', c.descripcion),
    tipo               = coalesce(v_c->>'tipo', c.tipo),
    valor              = coalesce((v_c->>'valor')::numeric, c.valor),
    activo             = coalesce((v_c->>'activo')::boolean, c.activo),
    vigencia_inicio    = coalesce((v_c->>'vigencia_inicio')::timestamptz, c.vigencia_inicio),
    vigencia_fin       = coalesce((v_c->>'vigencia_fin')::timestamptz, c.vigencia_fin),
    usos_maximos       = coalesce((v_c->>'usos_maximos')::int, c.usos_maximos),
    compra_minima      = coalesce((v_c->>'compra_minima')::numeric, c.compra_minima),
    segmento           = coalesce(nullif(v_c->>'segmento',''), c.segmento),
    fecha_actualizacion = now()
  where c.id = v_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Cupón no encontrado');
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'creado', false);
end;
$$;

comment on function public.guardar_cupon(jsonb) is
  'Crea o actualiza un cupón. Corregida el 6 sep 2026: escribía vigencia_inicio/vigencia_fin/compra_minima con los nombres fecha_inicio/fecha_fin/monto_minimo, que no existen — ver cambios/2026-09-06-auditoria-prospeccion-produccion.md';


-- ───────────────────────────────────────────────────────────────────────────
-- 2) convertir_prospecto_a_cliente_interno
-- ───────────────────────────────────────────────────────────────────────────
-- Se arregla el _interno: el envoltorio público (20260901050000) solo comprueba
-- la sesión y delega. Tocar el envoltorio no habría cambiado nada.
--
-- La tabla `prospectos` se reformó y esta función se quedó con los nombres
-- viejos: leía v_prospecto.tipo / .tipo_id / .nombre / .telefono / .cp de un
-- RECORD —campos que no existen y que PL/pgSQL solo resuelve al ejecutar—,
-- insertaba `clientes.notas`, que tampoco existe, y marcaba el prospecto con
-- `id_cliente_creado` / `fecha_conversion` en vez de `id_cliente_convertido`.
--
-- Evidencia de que nunca funcionó: de 1.132 prospectos, CERO en estatus
-- 'convertido'.
--
-- Dos correcciones que no son de nombre y por qué se hacen igual:
--   · `tipo_id` no existe en prospectos, así que se DERIVA de `tipo_negocio`
--     (2 restaurante · 4 mayorista · 3 tienda por defecto), que es el mapa que
--     usa crear_pedido (20260915000000:140). Antes era COALESCE(.tipo_id, 3).
--   · El teléfono que teclea el vendedor cuando el prospecto no tiene se USA.
--     Antes se pedía en pantalla y se ignoraba, y el cliente nacía sin teléfono
--     — inservible, porque todo el padrón se busca por teléfono.
--   · La nota «Convertido desde prospecto #N» se retira: `clientes` no tiene
--     columna `notas` y el rastro ya existe en prospectos.id_cliente_convertido.
create or replace function public.convertir_prospecto_a_cliente_interno(p_data jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id_prospecto    bigint;
  v_telefono        text;
  v_id_vendedor     bigint;
  v_nombre_vendedor text;
  v_prospecto       record;
  v_id_cliente      bigint;
  v_tel_norm        text;
  v_tel_final       text;
  v_tipo_id         integer;
begin
  v_id_prospecto    := coalesce((p_data->>'id')::bigint, 0);
  v_telefono        := coalesce(p_data->>'telefono', '');
  v_id_vendedor     := nullif(p_data->>'idVendedor', '')::bigint;
  v_nombre_vendedor := p_data->>'nombreVendedor';

  if v_id_prospecto = 0 and v_telefono = '' then
    return jsonb_build_object('ok', false, 'error', 'Faltan datos');
  end if;

  if v_id_prospecto > 0 then
    select * into v_prospecto from prospectos where id = v_id_prospecto limit 1;
  else
    v_tel_norm := regexp_replace(v_telefono, '\D', '', 'g');
    select * into v_prospecto from prospectos
    where right(regexp_replace(coalesce(contacto_telefono,''), '\D', '', 'g'), 10)
        = right(v_tel_norm, 10)
    limit 1;
  end if;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Prospecto no encontrado');
  end if;

  -- El teléfono del prospecto manda; si no tiene, el que tecleó el vendedor.
  v_tel_final := coalesce(nullif(v_prospecto.contacto_telefono, ''), nullif(v_telefono, ''));
  if v_tel_final is null then
    return jsonb_build_object('ok', false, 'error', 'El prospecto no tiene teléfono y no se recibió uno');
  end if;
  v_tel_norm := regexp_replace(v_tel_final, '\D', '', 'g');

  select id into v_id_cliente from clientes
  where right(regexp_replace(coalesce(telefono,''), '\D', '', 'g'), 10) = right(v_tel_norm, 10)
  limit 1;

  if found then
    update clientes set
      id_vendedor         = v_id_vendedor,
      vendedor            = v_nombre_vendedor,
      fecha_actualizacion = now()
    where id = v_id_cliente;
  else
    v_tipo_id := case
      when lower(coalesce(v_prospecto.tipo_negocio,'')) like '%restaurante%' then 2
      when lower(coalesce(v_prospecto.tipo_negocio,'')) like '%mayorista%'
        or lower(coalesce(v_prospecto.tipo_negocio,'')) like '%distribuidor%' then 4
      else 3
    end;

    insert into clientes (
      tipo, tipo_id, nombre, telefono, direccion, cp, colonia, municipio, estado,
      id_vendedor, vendedor, aprobado_b2b
    ) values (
      coalesce(nullif(v_prospecto.tipo_negocio,''), 'Tienda / Abarrotes'),
      v_tipo_id,
      v_prospecto.nombre_negocio,
      v_tel_final,
      v_prospecto.direccion,
      v_prospecto.codigo_postal,
      v_prospecto.colonia,
      v_prospecto.municipio,
      v_prospecto.estado,
      v_id_vendedor,
      v_nombre_vendedor,
      false   -- aún no aprobado B2B; el admin lo aprueba luego
    ) returning id into v_id_cliente;
  end if;

  update prospectos set
    estatus               = 'convertido',
    id_cliente_convertido = v_id_cliente,
    fecha_actualizacion   = now()
  where id = v_prospecto.id;

  return jsonb_build_object('ok', true, 'idCliente', v_id_cliente,
                            'msg', 'Prospecto convertido a cliente');
exception
  when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;

revoke all on function public.convertir_prospecto_a_cliente_interno(jsonb)
  from public, anon, authenticated;

comment on function public.convertir_prospecto_a_cliente_interno(jsonb) is
  'Convierte un prospecto en cliente. Corregida el 6 sep 2026: usaba los nombres viejos de prospectos (tipo/nombre/telefono/cp) y clientes.notas, que no existen — ver cambios/2026-09-06-auditoria-prospeccion-produccion.md';


-- ───────────────────────────────────────────────────────────────────────────
-- 3) importar_prospectos_bulk_interno
-- ───────────────────────────────────────────────────────────────────────────
-- Escribía seis columnas inexistentes (tipo, tipo_id, nombre, telefono, cp,
-- fecha_alta) y buscaba duplicados por prospectos.telefono, que tampoco existe.
-- Cada fila reventaba, el EXCEPTION de dentro del bucle la guardaba en
-- `errores`, y la función devolvía ok:true igualmente: en pantalla salía
-- «✅ Prueba exitosa: 0 creado(s)».
--
-- Las claves del payload son las que YA manda el navegador (index.html:12917):
-- nombre · tipo · telefono · direccion · colonia · codigoPostal · lat · lng ·
-- score · distanciaMetros · ref · calle · tierOriginal · idExterno.
--
-- Dos cambios que no son de nombre:
--   · `estatus` nace 'pendiente', no 'nuevo'. Es el valor vivo: 1.130 de los
--     1.132 prospectos lo llevan, y la pantalla lo usa 19 veces contra 4.
--   · `ok` deja de ser siempre true: es false si no se creó nada Y hubo errores.
--     Un «éxito» con cero filas es peor que un error, y es exactamente lo que
--     escondió este fallo durante meses.
create or replace function public.importar_prospectos_bulk_interno(p_data jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_lista            jsonb;
  v_item             jsonb;
  v_telefono         text;
  v_tel_norm         text;
  v_count_creados    integer := 0;
  v_count_duplicados integer := 0;
  v_errores          jsonb   := '[]'::jsonb;
  v_lat              numeric;
  v_lng              numeric;
begin
  v_lista := p_data->'prospectos';
  if jsonb_typeof(v_lista) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'prospectos debe ser un array');
  end if;

  for v_item in select * from jsonb_array_elements(v_lista)
  loop
    begin
      v_telefono := coalesce(v_item->>'telefono', '');
      v_tel_norm := regexp_replace(v_telefono, '\D', '', 'g');

      -- Saltar si ya existe como prospecto o como cliente.
      if v_tel_norm <> '' and length(v_tel_norm) >= 10 then
        if exists (
          select 1 from prospectos
          where right(regexp_replace(coalesce(contacto_telefono,''), '\D', '', 'g'), 10)
              = right(v_tel_norm, 10)
        ) or exists (
          select 1 from clientes
          where right(regexp_replace(coalesce(telefono,''), '\D', '', 'g'), 10)
              = right(v_tel_norm, 10)
        ) then
          v_count_duplicados := v_count_duplicados + 1;
          continue;
        end if;
      end if;

      v_lat := nullif(v_item->>'lat','')::numeric;
      v_lng := nullif(v_item->>'lng','')::numeric;

      insert into prospectos (
        nombre_negocio, tipo_negocio, contacto_telefono,
        direccion, calle, colonia, codigo_postal, municipio, estado,
        latitud, longitud, coordenadas, distancia_metros, score, ref,
        estatus, origen, notas
      ) values (
        v_item->>'nombre',
        coalesce(nullif(v_item->>'tipo',''), 'Tienda / Abarrotes'),
        nullif(v_telefono, ''),
        v_item->>'direccion',
        v_item->>'calle',
        v_item->>'colonia',
        nullif(v_item->>'codigoPostal',''),
        v_item->>'municipio',
        v_item->>'estado',
        v_lat,
        v_lng,
        case when v_lat is not null and v_lng is not null
             then v_lat::text || ',' || v_lng::text end,
        coalesce(nullif(v_item->>'distanciaMetros','')::numeric, 0),
        coalesce(nullif(v_item->>'score','')::int, 3),
        nullif(v_item->>'ref',''),
        coalesce(nullif(v_item->>'estatus',''), 'pendiente'),
        'csv',
        -- El CSV trae tier e id externo y hasta hoy se tiraban: van a notas.
        nullif(coalesce(v_item->>'notas',
                        concat_ws(' · ',
                                  nullif(v_item->>'tierOriginal',''),
                                  nullif(v_item->>'idExterno',''))), '')
      );
      v_count_creados := v_count_creados + 1;
    exception
      when others then
        v_errores := v_errores || jsonb_build_object('item', v_item, 'error', sqlerrm);
    end;
  end loop;

  return jsonb_build_object(
    'ok', (v_count_creados > 0 or jsonb_array_length(v_errores) = 0),
    'creados', v_count_creados,
    'duplicados', v_count_duplicados,
    'errores', v_errores
  );
end;
$$;

revoke all on function public.importar_prospectos_bulk_interno(jsonb)
  from public, anon, authenticated;

comment on function public.importar_prospectos_bulk_interno(jsonb) is
  'Importa prospectos en lote desde CSV. Corregida el 6 sep 2026: escribía seis columnas inexistentes y devolvía ok:true aunque no creara nada — ver cambios/2026-09-06-auditoria-prospeccion-produccion.md';
