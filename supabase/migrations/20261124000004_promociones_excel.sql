-- 24 nov 2026 — El Excel del mes de las promociones.
--
-- Dictado por Abraham: «La consola me sirve para promociones basicas y
-- sencillas, por lo mismo planteaba excel, columnas que definen la
-- configuracion de la promocion. (Vigencias, sku, % descuento, canal,
-- segmentacion, presupuesto, limite por cliente, limite total)».
--
-- Un plan del mes no se teclea promocion por promocion: se escribe en una hoja
-- y se carga. Pero una hoja que mueve precios es dinero, asi que:
--
--  1. QUIEN INTERPRETA LA HOJA ES EL SERVIDOR. El navegador solo convierte el
--     .xlsx en filas y las manda TAL CUAL, con sus cabeceras. Elegir que
--     columna es el descuento es decidir un precio, y eso no lo decide el
--     navegador (regla 10).
--  2. TODO O NADA. Un mes aplicado a medias es peor que no aplicado: unos SKU
--     con descuento y otros no, y nadie sabe cuales. Si una fila falla, no se
--     escribe ninguna.
--  3. SE PUEDE ENSAYAR. `probar: true` corre EXACTAMENTE el mismo camino
--     -incluido el piso de margen- y al final lo deshace. No es una
--     comprobacion parecida hecha aparte: es la de verdad, sin escribir
--     (regla 63: una herramienta que copia la logica que mide no mide).
--     Y es lo que pasa POR OMISION: si la clave no viene, no se escribe nada.
--  4. LOS ERRORES VIENEN TODOS JUNTOS. Abortar en el primero obliga a subir el
--     archivo cinco veces para enterarse de cinco cosas.
--  5. NO SE REESCRIBE LA REGLA. Cada promocion se guarda llamando a
--     `guardar_promocion`, la misma que usa la consola, asi que el piso de
--     margen, la validacion de SKU y los topes valen igual. Si aqui se
--     copiara la validacion, en tres meses diria otra cosa.
--
-- IDEMPOTENTE POR NOMBRE: una promocion cuyo nombre ya existe se ACTUALIZA.
-- Sin esto, corregir una celda y volver a subir el archivo crea doce
-- promociones duplicadas, que es el error obvio de esta clase de pantalla.
-- Consecuencia a la vista: el archivo es LA configuracion, asi que una celda
-- vacia QUITA el tope, y volver a subirlo reactiva una promocion pausada.
--
-- LA SEGMENTACION NO EXISTE TODAVIA (frente F al 0 %). La columna va en la
-- plantilla porque Abraham la dicto y porque asi el dia que exista no hay que
-- cambiar el formato del archivo; mientras, solo acepta «todos» y lo DICE. Una
-- columna que se lee y se ignora en silencio es peor que una que se rechaza.

begin;

-- ── 1. Leer una celda sin pelearse con la cabecera ────────────────────────
-- «% descuento», «%Descuento», «porcentaje » y «DESCUENTO» son la misma
-- columna. Se normaliza la llave (minusculas, sin acentos, sin nada que no sea
-- letra o numero) y se compara contra la lista de nombres que valen.
create or replace function public.promocion_col(p_fila jsonb, p_nombres text[])
returns text language sql immutable as $fn$
  select f.v
    from jsonb_each_text(p_fila) f(k, v)
   where regexp_replace(translate(lower(f.k), 'áàäéèëíìïóòöúùüñ', 'aaaeeeiiiooouuun'), '[^a-z0-9]', '', 'g')
         = any(p_nombres)
     and nullif(btrim(f.v), '') is not null
   limit 1;
$fn$;
revoke all on function public.promocion_col(jsonb, text[]) from public, anon, authenticated;
comment on function public.promocion_col(jsonb, text[]) is
  'Una celda de una fila de Excel por el nombre de su columna, normalizando la cabecera. 24 nov 2026.';

-- ── 2. Una fecha escrita por una persona o por Excel ──────────────────────
-- Excel no manda «2026-12-01»: manda 46357, los dias desde el 30/12/1899. Si
-- no se entiende, se devuelve NULL y la fila sale con error; nunca se adivina.
create or replace function public.promocion_fecha(p_v text)
returns date language plpgsql immutable as $fn$
declare s text := nullif(btrim(coalesce(p_v, '')), '');
begin
  if s is null then return null; end if;
  -- Serie de Excel. El rango 20000-90000 es 1954-2146: asi un «2026» suelto
  -- en la celda NO se lee como fecha, se rechaza.
  if s ~ '^[0-9]+([.][0-9]+)?$' then
    if floor(s::numeric) between 20000 and 90000 then
      return date '1899-12-30' + floor(s::numeric)::integer;
    end if;
    return null;
  end if;
  if s ~ '^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}' then return to_date(substr(s, 1, 10), 'YYYY-MM-DD'); end if;
  -- Dia primero, que es como se escribe en Mexico. La plantilla pide AAAA-MM-DD
  -- justamente para no depender de esto.
  if s ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$' then return to_date(s, 'DD/MM/YYYY'); end if;
  return null;
exception when others then return null;
end;
$fn$;
revoke all on function public.promocion_fecha(text) from public, anon, authenticated;

-- ── 3. El texto de la columna «sku» → el item de guardar_promocion ────────
-- Vale el id, «Sabor Presentacion», un sabor solo (todas sus presentaciones) o
-- una presentacion sola (todos los sabores en esa bolsa). Se devuelve SIEMPRE
-- la escritura que tiene la base, no la que escribio la persona:
-- `promocion_items` compara el texto exacto, y «naturales» no es «Naturales».
create or replace function public.promocion_sku_a_item(p_texto text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_t   text := nullif(btrim(coalesce(p_texto, '')), '');
  v_id  bigint;
  v_can text;
begin
  if v_t is null then return null; end if;

  if v_t ~ '^[0-9]+$' then
    select p.id into v_id from public.productos p
     where p.id = v_t::bigint and coalesce(p.activo, true) and not coalesce(p.descontinuado, false);
    if v_id is null then return null; end if;
    return jsonb_build_object('idProducto', v_id);
  end if;

  select p.id into v_id from public.productos p
   where lower(btrim(coalesce(p.sabor, '') || ' ' || coalesce(p.presentacion, ''))) = lower(v_t)
     and coalesce(p.activo, true) and not coalesce(p.descontinuado, false)
   limit 1;
  if v_id is not null then return jsonb_build_object('idProducto', v_id); end if;

  select p.sabor into v_can from public.productos p
   where lower(p.sabor) = lower(v_t)
     and coalesce(p.activo, true) and not coalesce(p.descontinuado, false)
   limit 1;
  if v_can is not null then return jsonb_build_object('sabor', v_can); end if;

  select p.presentacion into v_can from public.productos p
   where lower(p.presentacion) = lower(v_t)
     and coalesce(p.activo, true) and not coalesce(p.descontinuado, false)
   limit 1;
  if v_can is not null then return jsonb_build_object('presentacion', v_can); end if;

  return null;
end;
$fn$;
revoke all on function public.promocion_sku_a_item(text) from public, anon, authenticated;

-- ── 4. El importador ──────────────────────────────────────────────────────
create or replace function public.promociones_importar(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_filas  jsonb   := coalesce(p_data->'filas', '[]'::jsonb);
  -- Por omision NO escribe. Un valor por omision que escribe es un valor por
  -- omision que muerde.
  v_probar boolean := coalesce((p_data->>'probar')::boolean, true);
  v_rep    jsonb   := '[]'::jsonb;
  v_malas  jsonb   := '[]'::jsonb;
  v_nuevas int := 0; v_edit int := 0;
  f        record;
  g        record;
  v_id     bigint;
  v_r      jsonb;
  v_n      int := 0;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'solo_dueno');
  end if;
  if jsonb_typeof(v_filas) <> 'array' or jsonb_array_length(v_filas) = 0 then
    return jsonb_build_object('ok', false, 'error', 'vacio', 'mensaje', 'El archivo no trae filas.');
  end if;
  if jsonb_array_length(v_filas) > 500 then
    return jsonb_build_object('ok', false, 'error', 'muchas', 'mensaje', 'Mas de 500 filas. Partelo en dos archivos.');
  end if;

  drop table if exists _imp;
  create temp table _imp (
    n int, nombre text, clave text, desde date, hasta date, sku text, item jsonb,
    pct numeric, canal text, segmento text, presupuesto numeric,
    lpc int, lt int, gancho boolean, err text
  ) on commit drop;

  -- ── 4a. Cada celda, leida y juzgada ─────────────────────────────────────
  for f in select e.valor, e.n from jsonb_array_elements(v_filas) with ordinality e(valor, n) loop
    declare
      r_nombre text := nullif(btrim(coalesce(public.promocion_col(f.valor, array['nombre','promocion','nombredelapromocion']), '')), '');
      r_desde  text := public.promocion_col(f.valor, array['desde','vigenciadesde','inicio','vigencia','desdefecha']);
      r_hasta  text := public.promocion_col(f.valor, array['hasta','vigenciahasta','fin','hastafecha']);
      r_sku    text := public.promocion_col(f.valor, array['sku','producto','skuproducto','productos']);
      r_pct    text := public.promocion_col(f.valor, array['descuento','descuentopct','pctdescuento','porcentaje','descuentoporcentaje','pct']);
      r_canal  text := public.promocion_col(f.valor, array['canal','publico','canalventa']);
      r_seg    text := public.promocion_col(f.valor, array['segmento','segmentacion','segmentocliente']);
      r_pres   text := public.promocion_col(f.valor, array['presupuesto','presupuestomax','presupuestoasociado']);
      r_lpc    text := public.promocion_col(f.valor, array['limiteporcliente','limitecliente','maxporcliente','topeporcliente']);
      r_lt     text := public.promocion_col(f.valor, array['limitetotal','maxtotal','topetotal','limitepromocionestotales']);
      r_gancho text := public.promocion_col(f.valor, array['gancho','esgancho','promociondegancho']);
      e_desde  date; e_hasta date; e_pct numeric; e_pres numeric; e_lpc int; e_lt int;
      e_item   jsonb; e_canal text; e_err text := ''; e_gancho boolean := false;
    begin
      -- Una fila completamente vacia no es un error: se salta.
      if r_nombre is null and r_sku is null and r_pct is null and r_desde is null then
        continue;
      end if;

      if r_nombre is null then e_err := e_err || 'sin nombre; '; end if;

      e_desde := public.promocion_fecha(r_desde);
      e_hasta := public.promocion_fecha(r_hasta);
      if e_desde is null then e_err := e_err || 'fecha «desde» que no se entiende (AAAA-MM-DD); '; end if;
      if e_hasta is null then e_err := e_err || 'fecha «hasta» que no se entiende (AAAA-MM-DD); '; end if;
      if e_desde is not null and e_hasta is not null and e_hasta < e_desde then
        e_err := e_err || '«hasta» antes de «desde»; ';
      end if;

      begin e_pct := nullif(btrim(replace(coalesce(r_pct, ''), '%', '')), '')::numeric;
      exception when others then e_pct := null; end;
      if e_pct is null then e_err := e_err || 'descuento vacio o que no es un numero; ';
      elsif e_pct <= 0 or e_pct > 100 then e_err := e_err || 'el descuento va entre 0 y 100; '; end if;

      if r_sku is null then
        e_err := e_err || 'sin sku; ';
      else
        e_item := public.promocion_sku_a_item(r_sku);
        if e_item is null then
          e_err := e_err || 'el sku «' || r_sku || '» no esta en el catalogo activo; ';
        end if;
      end if;

      e_canal := case lower(coalesce(btrim(r_canal), 'todos'))
                   when '' then 'todos'
                   when 'todos' then 'todos' when 'ambos' then 'todos' when 'todo' then 'todos'
                   when 'consumidor' then 'consumidores' when 'consumidores' then 'consumidores'
                   when 'web' then 'consumidores' when 'mostrador' then 'consumidores'
                   when 'tienda' then 'tiendas' when 'tiendas' then 'tiendas'
                   when 'restaurante' then 'tiendas' when 'b2b' then 'tiendas'
                   else null end;
      if e_canal is null then
        if lower(btrim(coalesce(r_canal, ''))) = 'mayorista' then
          e_err := e_err || 'el mayorista nunca entra en promociones (ya compra al precio mas bajo); ';
        else
          e_err := e_err || 'canal «' || r_canal || '»: vale consumidor, tienda o todos; ';
        end if;
      end if;

      if r_seg is not null and lower(btrim(r_seg)) not in ('todos', 'todo', 'general', '-') then
        e_err := e_err || 'la segmentacion por cliente todavia no existe: por ahora solo «todos»; ';
      end if;

      begin e_pres := nullif(btrim(replace(replace(coalesce(r_pres, ''), '$', ''), ',', '')), '')::numeric;
      exception when others then e_pres := null; e_err := e_err || 'presupuesto que no es un numero; '; end;
      if e_pres is not null and e_pres <= 0 then e_err := e_err || 'el presupuesto debe ser mayor que 0; '; end if;

      begin e_lpc := nullif(btrim(coalesce(r_lpc, '')), '')::int;
      exception when others then e_lpc := null; e_err := e_err || 'limite por cliente que no es entero; '; end;
      begin e_lt := nullif(btrim(coalesce(r_lt, '')), '')::int;
      exception when others then e_lt := null; e_err := e_err || 'limite total que no es entero; '; end;
      if e_lpc is not null and e_lpc <= 0 then e_err := e_err || 'el limite por cliente debe ser mayor que 0; '; end if;
      if e_lt  is not null and e_lt  <= 0 then e_err := e_err || 'el limite total debe ser mayor que 0; '; end if;

      e_gancho := lower(btrim(coalesce(r_gancho, ''))) in ('si', 'sí', 'x', 'true', 'verdadero', '1');

      insert into _imp values (f.n, r_nombre, lower(btrim(coalesce(r_nombre, ''))), e_desde, e_hasta,
                               r_sku, e_item, e_pct, e_canal, r_seg, e_pres, e_lpc, e_lt, e_gancho,
                               nullif(btrim(trim(trailing '; ' from e_err)), ''));
    end;
  end loop;

  select count(*) into v_n from _imp;
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'error', 'vacio', 'mensaje', 'Todas las filas estan vacias.');
  end if;

  -- ── 4b. Errores de forma, TODOS juntos ──────────────────────────────────
  select coalesce(jsonb_agg(jsonb_build_object('fila', n, 'nombre', nombre, 'mensaje', err) order by n), '[]'::jsonb)
    into v_malas from _imp where err is not null;

  -- ── 4c. Las filas de una misma promocion tienen que decir lo MISMO ──────
  -- Si dos filas de «Octubre Habanero» dicen 5 % y 7 %, elegir una en silencio
  -- seria cobrar un precio que nadie escribio.
  for g in
    select clave, min(n) as n, min(nombre) as nombre, count(*) as filas,
           count(distinct coalesce(desde::text, '~'))       as d1,
           count(distinct coalesce(hasta::text, '~'))       as d2,
           count(distinct coalesce(pct::text, '~'))         as d3,
           count(distinct coalesce(canal, '~'))             as d4,
           count(distinct coalesce(presupuesto::text, '~')) as d5,
           count(distinct coalesce(lpc::text, '~'))         as d6,
           count(distinct coalesce(lt::text, '~'))          as d7,
           count(distinct gancho::text)                     as d8
      from _imp group by clave
  loop
    if greatest(g.d1, g.d2, g.d3, g.d4, g.d5, g.d6, g.d7, g.d8) > 1 then
      v_malas := v_malas || jsonb_build_array(jsonb_build_object(
        'fila', g.n, 'nombre', g.nombre,
        'mensaje', 'las ' || g.filas || ' filas de esta promocion no dicen lo mismo en vigencias, descuento, canal o topes: solo el sku puede cambiar entre ellas'));
    end if;
  end loop;

  -- ── 4d. Guardar, delegando en guardar_promocion ─────────────────────────
  if jsonb_array_length(v_malas) = 0 then
    for g in
      select clave, min(n) as n, min(nombre) as nombre, min(desde) as desde, max(hasta) as hasta,
             min(pct) as pct, min(canal) as canal, min(presupuesto) as presupuesto,
             min(lpc) as lpc, min(lt) as lt, bool_or(gancho) as gancho,
             jsonb_agg(distinct item) as items, count(*) as filas
        from _imp group by clave order by min(n)
    loop
      select pr.id into v_id from public.promociones pr
       where lower(btrim(pr.nombre)) = g.clave order by pr.id limit 1;

      v_r := public.guardar_promocion(jsonb_build_object(
        'token', p_data->>'token',
        'promocion', jsonb_build_object(
          'id', v_id, 'nombre', g.nombre, 'tipo', 'porcentaje', 'valor', g.pct,
          'publico', g.canal, 'desde', g.desde, 'hasta', g.hasta,
          'activa', true, 'esGancho', g.gancho,
          'limitePorCliente', g.lpc, 'limiteTotal', g.lt, 'presupuesto', g.presupuesto,
          'items', g.items)));

      if coalesce((v_r->>'ok')::boolean, false) then
        if v_id is null then v_nuevas := v_nuevas + 1; else v_edit := v_edit + 1; end if;
        v_rep := v_rep || jsonb_build_array(jsonb_build_object(
          'fila', g.n, 'nombre', g.nombre,
          'accion', case when v_id is null then 'nueva' else 'actualizada' end,
          'skus', jsonb_array_length(g.items), 'filas', g.filas,
          'pct', g.pct, 'canal', g.canal, 'desde', g.desde, 'hasta', g.hasta,
          'limitePorCliente', g.lpc, 'limiteTotal', g.lt, 'presupuesto', g.presupuesto,
          'gancho', g.gancho, 'peorMargen', v_r->'peorMargen'));
      else
        v_malas := v_malas || jsonb_build_array(jsonb_build_object(
          'fila', g.n, 'nombre', g.nombre,
          'mensaje', coalesce(v_r->>'mensaje', v_r->>'error', 'el servidor la rechazo sin decir por que')));
      end if;
    end loop;
  end if;

  -- ── 4e. Todo o nada, y el ensayo ────────────────────────────────────────
  if jsonb_array_length(v_malas) > 0 then
    raise exception 'cp_deshacer';
  elsif v_probar then
    raise exception 'cp_ensayo';
  end if;

  return jsonb_build_object('ok', true, 'ensayo', false,
    'resumen', jsonb_build_object('filas', v_n, 'promociones', jsonb_array_length(v_rep),
                                  'nuevas', v_nuevas, 'actualizadas', v_edit),
    'promociones', v_rep, 'errores', '[]'::jsonb);

exception
  when others then
    -- Las dos salidas deliberadas. El RAISE deshace TODO lo que escribio el
    -- bucle; las variables no se deshacen, asi que el informe sobrevive.
    if sqlerrm = 'cp_deshacer' then
      return jsonb_build_object('ok', false, 'error', 'filas', 'ensayo', true,
        'mensaje', 'No se escribio nada: ' || jsonb_array_length(v_malas) || ' problema(s).',
        'resumen', jsonb_build_object('filas', v_n, 'promociones', jsonb_array_length(v_rep),
                                      'nuevas', v_nuevas, 'actualizadas', v_edit),
        'promociones', v_rep, 'errores', v_malas);
    elsif sqlerrm = 'cp_ensayo' then
      return jsonb_build_object('ok', true, 'ensayo', true,
        'mensaje', 'Ensayo: esto es lo que haria, y no se escribio nada.',
        'resumen', jsonb_build_object('filas', v_n, 'promociones', jsonb_array_length(v_rep),
                                      'nuevas', v_nuevas, 'actualizadas', v_edit),
        'promociones', v_rep, 'errores', '[]'::jsonb);
    end if;
    raise;
end;
$fn$;
revoke all on function public.promociones_importar(jsonb) from public, anon;
grant execute on function public.promociones_importar(jsonb) to anon, authenticated;
comment on function public.promociones_importar(jsonb) is
  'Carga el Excel del mes: agrupa las filas por nombre, delega en guardar_promocion, es todo-o-nada y por omision solo ENSAYA. 24 nov 2026.';

commit;
