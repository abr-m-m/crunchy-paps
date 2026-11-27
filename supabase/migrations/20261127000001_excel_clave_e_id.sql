-- 27 nov 2026 — El Excel del mes: clave, id de producto y el canal cerrado
--
-- Abraham, probando el archivo de diciembre:
--
--   «Integrar un id_promocion… Integrar id_producto y mantener sku, que es la
--    descripcion… Canal: ¿por que restaurante entra en tienda? Cada uno es
--    independiente.»
--
-- 1. CLAVE. El importador era idempotente por NOMBRE: cambiar el titulo de una
--    promocion en la hoja no la corregia, CREABA OTRA. Ahora la identidad es
--    `promociones.clave` (`CP2612-C01`), que genera el servidor si la celda
--    viene vacia. El nombre vuelve a ser solo el titulo que ve el cliente.
--    El respaldo por nombre se queda para las hojas escritas sin la columna.
--
-- 2. ID DE PRODUCTO CON EL SKU DE TESTIGO. Lo valioso de llevar los dos no es
--    tener el dato repetido: es que TIENEN QUE COINCIDIR. Si no concuerdan, la
--    fila se para diciendo «el id 7 es Habanero 250g, no Feroz 250g». No puede
--    ser obligatorio: una regla por SABOR no tiene un id.
--
-- 3. EL RESTAURANTE ES UN CANAL PROPIO (ver 20261127000000). Y «b2b» deja de
--    valer: ahora seria adivinar cual de los dos, que es elegirle el precio.
--
-- Y de paso, el numero que enseñaba el informe: decia «skus: 1» de una promo
-- por sabor que mueve CINCO precios, porque contaba REGLAS. Ahora dice las dos
-- cosas, `reglas` y `skus`, y `skus` sale de `promocion_margen`, que es quien
-- sabe de verdad a cuantos productos llega (regla 63: no se recuenta aparte).

begin;

CREATE OR REPLACE FUNCTION public.promociones_importar(p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    -- `clave` es la LLAVE DE AGRUPACION (lo que decide que filas son la misma
    -- promocion); `clave_dada` es la que escribio la persona, o NULL. Son dos
    -- cosas distintas y mezclarlas fue la tentacion: agrupar por nombre cuando
    -- no hay clave sigue haciendo falta.
    n int, nombre text, clave text, clave_dada text, id_prod bigint,
    desde date, hasta date, sku text, item jsonb,
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
      -- OJO: aqui NO vale un 'id' a secas. En esta hoja «id» es el del
      -- PRODUCTO, y aceptarlo para las dos cosas convertiria un id de producto
      -- en la identidad de la promocion.
      r_clave  text := public.promocion_col(f.valor, array['clave','clavepromocion','idpromocion','codigo','codigopromocion']);
      r_idprod text := public.promocion_col(f.valor, array['idproducto','idprod','idsku','productoid']);
      r_pct    text := public.promocion_col(f.valor, array['descuento','descuentopct','pctdescuento','porcentaje','descuentoporcentaje','pct']);
      r_canal  text := public.promocion_col(f.valor, array['canal','publico','canalventa']);
      r_seg    text := public.promocion_col(f.valor, array['segmento','segmentacion','segmentocliente']);
      r_pres   text := public.promocion_col(f.valor, array['presupuesto','presupuestomax','presupuestoasociado']);
      r_lpc    text := public.promocion_col(f.valor, array['limiteporcliente','limitecliente','maxporcliente','topeporcliente']);
      r_lt     text := public.promocion_col(f.valor, array['limitetotal','maxtotal','topetotal','limitepromocionestotales']);
      r_gancho text := public.promocion_col(f.valor, array['gancho','esgancho','promociondegancho']);
      e_desde  date; e_hasta date; e_pct numeric; e_pres numeric; e_lpc int; e_lt int;
      e_item   jsonb; e_canal text; e_err text := ''; e_gancho boolean := false;
      e_idprod bigint; e_real text;
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

      -- EL ID MANDA Y EL SKU ES TESTIGO. Lo valioso de llevar los dos no es
      -- tener el dato dos veces: es que TIENEN QUE COINCIDIR. Dos campos que
      -- deben concordar cazan la fila copiada a medias; uno solo, no.
      begin e_idprod := nullif(btrim(coalesce(r_idprod, '')), '')::bigint;
      exception when others then e_idprod := null;
        e_err := e_err || 'el id de producto no es un numero; '; end;

      if e_idprod is not null then
        select p.sabor || ' ' || p.presentacion into e_real
          from public.productos p
         where p.id = e_idprod and coalesce(p.activo, true) and not coalesce(p.descontinuado, false);
        if e_real is null then
          e_err := e_err || 'el id de producto ' || e_idprod || ' no esta en el catalogo activo; ';
        else
          e_item := jsonb_build_object('idProducto', e_idprod);
          -- El testigo. Si el texto no es el de ese id, la fila NO se aplica a
          -- ninguno de los dos: se para y se dice cual es cual.
          if r_sku is not null and lower(btrim(r_sku)) <> lower(e_real) then
            e_err := e_err || 'el id ' || e_idprod || ' es «' || e_real ||
                     '», no «' || r_sku || '»; ';
          end if;
        end if;
      elsif r_sku is null then
        e_err := e_err || 'sin sku ni id de producto; ';
      else
        -- Sin id, vale lo de siempre: un id, «Sabor Presentacion», un sabor
        -- entero o una presentacion entera. Las reglas POR SABOR no tienen id,
        -- asi que la columna nueva no puede ser obligatoria.
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
                   -- 27 nov 2026: el restaurante deja de viajar con las
                   -- tiendas. «Cada uno es independiente» -Abraham-, y es
                   -- verdad: otro precio de lista, otro margen, otra forma de
                   -- comprar. «b2b» ya no vale: ahora es ambiguo, y adivinar
                   -- cual de los dos queria decir seria elegirle el precio.
                   when 'restaurante' then 'restaurantes'
                   when 'restaurantes' then 'restaurantes'
                   else null end;
      if e_canal is null then
        if lower(btrim(coalesce(r_canal, ''))) = 'mayorista' then
          e_err := e_err || 'el mayorista nunca entra en promociones (ya compra al precio mas bajo); ';
        else
          e_err := e_err || 'canal «' || r_canal ||
                   '»: vale consumidor, tienda, restaurante o todos; ';
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

      -- La llave de agrupacion es la CLAVE si la hay, y si no el nombre. Asi
      -- una hoja sin claves se sigue comportando como siempre.
      insert into _imp values (f.n, r_nombre,
                               lower(btrim(coalesce(nullif(btrim(coalesce(r_clave, '')), ''), r_nombre, ''))),
                               nullif(btrim(coalesce(r_clave, '')), ''), e_idprod,
                               e_desde, e_hasta,
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
    select clave, min(clave_dada) as clave_dada, count(distinct clave_dada) as d9,
           min(n) as n, min(nombre) as nombre, count(*) as filas,
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
    if greatest(g.d1, g.d2, g.d3, g.d4, g.d5, g.d6, g.d7, g.d8, g.d9) > 1 then
      v_malas := v_malas || jsonb_build_array(jsonb_build_object(
        'fila', g.n, 'nombre', g.nombre,
        'mensaje', 'las ' || g.filas || ' filas de esta promocion no dicen lo mismo en vigencias, descuento, canal o topes: solo el sku puede cambiar entre ellas'));
    end if;
  end loop;

  -- ── 4d. Guardar, delegando en guardar_promocion ─────────────────────────
  if jsonb_array_length(v_malas) = 0 then
    for g in
      select clave, min(clave_dada) as clave_dada,
             min(n) as n, min(nombre) as nombre, min(desde) as desde, max(hasta) as hasta,
             min(pct) as pct, min(canal) as canal, min(presupuesto) as presupuesto,
             min(lpc) as lpc, min(lt) as lt, bool_or(gancho) as gancho,
             jsonb_agg(distinct item) as items, count(*) as filas
        from _imp group by clave order by min(n)
    loop
      -- Por CLAVE primero: es la identidad. El nombre es el respaldo para las
      -- promociones de antes del 27 nov 2026, que todavia no tienen una, y
      -- para una hoja escrita sin la columna.
      v_id := null;
      if g.clave_dada is not null then
        select pr.id into v_id from public.promociones pr
         where lower(btrim(pr.clave)) = lower(btrim(g.clave_dada)) limit 1;
      end if;
      if v_id is null then
        select pr.id into v_id from public.promociones pr
         where lower(btrim(pr.nombre)) = lower(btrim(g.nombre)) order by pr.id limit 1;
      end if;

      v_r := public.guardar_promocion(jsonb_build_object(
        'token', p_data->>'token',
        'promocion', jsonb_build_object(
          'id', v_id, 'clave', g.clave_dada,
          'nombre', g.nombre, 'tipo', 'porcentaje', 'valor', g.pct,
          'publico', g.canal, 'desde', g.desde, 'hasta', g.hasta,
          'activa', true, 'esGancho', g.gancho,
          'limitePorCliente', g.lpc, 'limiteTotal', g.lt, 'presupuesto', g.presupuesto,
          'items', g.items)));

      if coalesce((v_r->>'ok')::boolean, false) then
        if v_id is null then v_nuevas := v_nuevas + 1; else v_edit := v_edit + 1; end if;
        v_rep := v_rep || jsonb_build_array(jsonb_build_object(
          'fila', g.n, 'nombre', g.nombre,
          -- La clave que QUEDO, no la que se mando: si la genero el servidor,
          -- esta es la unica forma de enterarse.
          'clave', v_r->>'clave',
          'accion', case when v_id is null then 'nueva' else 'actualizada' end,
          -- `reglas` son las filas de item; `skus` son los PRODUCTOS que tocan.
          -- Antes aqui se enseñaba el numero de reglas con el nombre «skus», y
          -- una promo por sabor decia «1» moviendo cinco precios.
          'reglas', jsonb_array_length(g.items),
          -- OJO: el id de la promocion RECIEN guardada sale de la respuesta,
          -- no de `v_id`, que vale NULL cuando la promocion es nueva. Con
          -- `v_id` aqui, toda promocion nueva habria dicho «0 SKU».
          'skus', (select count(*) from public.promocion_margen((v_r->>'id')::bigint) m
                    where m.canal = (case g.canal when 'consumidores' then 'consumidor'
                                                  when 'tiendas' then 'tienda'
                                                  when 'restaurantes' then 'restaurante'
                                                  else 'consumidor' end)),
          'filas', g.filas,
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
$function$;


revoke all on function public.promociones_importar(jsonb) from public, anon;
grant execute on function public.promociones_importar(jsonb) to anon, authenticated;
comment on function public.promociones_importar(jsonb) is
  'Carga el Excel del mes. Identidad por CLAVE, id de producto con el sku de testigo, canal cerrado. 27 nov 2026.';

commit;
