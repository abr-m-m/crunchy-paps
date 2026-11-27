-- 27 nov 2026 — La clave distingue CAMPAÑA y CANAL
--
-- Abraham: «Dentro del id de la promocion deberiamos diferenciar entre canales
-- para poder medir un post mortem e identificar como va una misma promo sobre
-- diferentes tipos de canal.»
--
-- La clave de esta mañana ya llevaba el canal -`CP2612-C01`-, pero el numero
-- corria POR CANAL, asi que `CP2612-C01` y `CP2612-T01` podian ser dos ideas
-- que no tienen nada que ver. No habia forma de preguntar «¿como le fue a ESTA
-- promocion en cada canal?», que es justo lo que se mira en un post mortem.
--
-- Se le da la vuelta: el numero es la CAMPAÑA y la letra es el CANAL.
--
--     CP2612-01C   CP2612-01T   CP2612-01R
--     └─ la misma campaña ─┘    └─ canales distintos
--
-- Lo que se escribe en la hoja es la campaña; la letra la pone el servidor
-- segun el canal de esa fila. Pegar la misma clave en el bloque de consumidor y
-- en el de tienda crea DOS promociones hermanas, que es exactamente lo que hace
-- falta para compararlas.

begin;

-- ── 1. El generador: campaña + canal ──────────────────────────────────────
-- DROP primero, y no `create or replace`: la firma cambia (lleva un tercer
-- parametro) y `create or replace` con otra firma CREA UNA SEGUNDA funcion. Las
-- llamadas de dos argumentos se vuelven ambiguas y abortan. Ya paso con
-- `promocion_mejor` el 24 de noviembre.
drop function if exists public.promocion_clave_nueva(date, text);

create or replace function public.promocion_clave_nueva(p_desde date, p_publico text, p_pista text default null)
returns text language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_let  text;
  v_camp text;
  v_n    int;
begin
  v_let := case lower(coalesce(p_publico, 'todos'))
             when 'consumidores' then 'C'
             when 'tiendas'      then 'T'
             when 'restaurantes' then 'R'
             else 'X' end;

  v_camp := upper(btrim(coalesce(p_pista, '')));
  -- Si la pista ya trae la letra del canal al final, se le quita: la que manda
  -- es la del canal de ESTA promocion. Pegar `CP2612-01C` en una fila de tienda
  -- quiere decir «la misma campaña, pero para tiendas», no «llamala C».
  if v_camp ~ '[0-9][CTRX]$' then
    v_camp := left(v_camp, length(v_camp) - 1);
  end if;

  if v_camp = '' then
    -- Campaña nueva: el siguiente numero libre del mes, mirando TODAS las
    -- claves de ese mes sea cual sea su canal, para que dos campañas distintas
    -- nunca compartan numero.
    v_camp := 'CP' || to_char(coalesce(p_desde, current_date), 'YYMM') || '-';
    select coalesce(max(substring(pr.clave from '^CP[0-9]{4}-([0-9]+)')::int), 0) + 1
      into v_n
      from public.promociones pr
     where pr.clave like v_camp || '%';
    v_camp := v_camp || lpad(coalesce(v_n, 1)::text, 2, '0');
  end if;

  return v_camp || v_let;
end;
$fn$;
revoke all on function public.promocion_clave_nueva(date, text, text) from public, anon, authenticated;
comment on function public.promocion_clave_nueva(date, text, text) is
  'La clave CP2612-01C: campaña (el numero) + canal (la letra). La pista es la campaña. 27 nov 2026.';

-- ── 2. Las claves de esta mañana, al formato nuevo ────────────────────────
-- `CP2611-X01` -> `CP2611-01X`. Fila por fila por la misma razon de siempre.
do $$
declare r record; v_nueva text;
begin
  for r in select id, clave from public.promociones
            where clave ~ '^CP[0-9]{4}-[CTRX][0-9]+$' order by id loop
    v_nueva := regexp_replace(r.clave, '^(CP[0-9]{4}-)([CTRX])([0-9]+)$', '\1\3\2');
    update public.promociones set clave = v_nueva where id = r.id;
  end loop;
end $$;


-- ── 3. guardar_promocion ──────────────────────────────────────────────────
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
  -- Lo que se escribe es la CAMPAÑA; la letra del canal la pone el servidor.
  -- Asi dos promociones de la misma idea en canales distintos comparten el
  -- tronco de la clave y se pueden sumar despues.
  v_clave    := public.promocion_clave_nueva(
                  v_desde, v_pub, coalesce(nullif(btrim(j->>'clave'), ''), v_act.clave));
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
  -- Dos promociones no pueden compartir clave: es una identidad. Si la
  -- calculada ya es de otra, se dice en vez de reventar contra el indice.
  if exists (select 1 from public.promociones pr
              where pr.clave = v_clave and pr.id is distinct from v_id) then
    return jsonb_build_object('ok', false, 'error', 'clave_ocupada',
      'mensaje', 'La clave ' || v_clave || ' ya es de otra promocion. ' ||
                 'Cambia la campaña o el canal.');
  end if;

    insert into public.promociones (clave, nombre, descripcion, imagen, tipo, valor, publico, desde, hasta,
                                    activa, acumulable_con_cupon, es_gancho, aterriza_en, creado_por,
                                    limite_por_cliente, limite_total, presupuesto)
    values (v_clave, v_nombre, v_desc, v_img, v_tipo, v_valor, v_pub, v_desde, v_hasta,
            v_activa, v_acum, v_gancho, v_aterriza, v_actor,
            v_lpc, v_lt, v_pres)
    returning id into v_id;
  else
    update public.promociones
       set clave = v_clave,
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


-- ── 4. promociones_importar ───────────────────────────────────────────────
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
      -- El CANAL entra en la llave de agrupacion. Sin esto, escribir la misma
      -- campaña para consumidor y para tienda -que es justo para lo que sirve-
      -- las juntaba en una sola promocion y saltaba «las filas no dicen lo
      -- mismo». Ahora son dos promociones hermanas.
      insert into _imp values (f.n, r_nombre,
                               lower(btrim(coalesce(nullif(btrim(coalesce(r_clave, '')), ''), r_nombre, '')))
                                 || '|' || coalesce(e_canal, '~'),
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
        -- Por nombre Y publico: dos hermanas de canales distintos pueden
        -- llamarse igual, y sin el publico las dos encontrarian la misma.
        select pr.id into v_id from public.promociones pr
         where lower(btrim(pr.nombre)) = lower(btrim(g.nombre))
           and pr.publico = g.canal
         order by pr.id limit 1;
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

-- ── 5. El post mortem: la campaña, abierta por canal ──────────────────────
-- Para lo que Abraham pidio: ver como le fue a UNA misma promocion en cada
-- tipo de cliente. Se mide DESDE LOS PEDIDOS, nunca de un contador, igual que
-- los topes: un contador y la realidad se separan y nadie se entera.
create or replace function public.promocion_postmortem(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_desde date := coalesce(nullif(p_data->>'desde', '')::date, current_date - 365);
  v_hasta date := coalesce(nullif(p_data->>'hasta', '')::date, current_date + 365);
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'solo_dueno');
  end if;

  return (
    with uso as (
      select d.id_promocion,
             count(distinct d.id_orden) as pedidos,
             count(distinct o.id_cliente) filter (where o.id_cliente is not null) as clientes,
             sum(coalesce(d.cantidad, 0))  as piezas,
             sum(coalesce(d.descuento, 0)) as descuento,
             sum(coalesce(d.subtotal, 0))  as ingreso
        from public.ordenes_detalle d
        join public.ordenes o on o.id = d.id_orden
       where d.id_promocion is not null
         -- Las mismas dos condiciones de siempre para «venta real».
         and coalesce(o.tipo_interno, '') = ''
         and o.estatus_pedido <> 'Cancelado'
       group by d.id_promocion
    ),
    filas as (
      select pr.id, pr.clave,
             -- La campaña es la clave sin la letra del canal.
             case when pr.clave ~ '[0-9][CTRX]$'
                  then left(pr.clave, length(pr.clave) - 1) else pr.clave end as campana,
             pr.nombre, pr.publico, pr.tipo, pr.valor, pr.desde, pr.hasta, pr.activa, pr.es_gancho,
             pr.limite_total, pr.limite_por_cliente, pr.presupuesto,
             coalesce(u.pedidos, 0) as pedidos, coalesce(u.clientes, 0) as clientes,
             coalesce(u.piezas, 0) as piezas,
             coalesce(u.descuento, 0) as descuento, coalesce(u.ingreso, 0) as ingreso,
             (select min(m.margen_pct) from public.promocion_margen(pr.id) m) as peor_margen
        from public.promociones pr
        left join uso u on u.id_promocion = pr.id
       where pr.desde <= v_hasta and pr.hasta >= v_desde
    )
    select jsonb_build_object('ok', true, 'desde', v_desde, 'hasta', v_hasta,
      'campanas', coalesce((
        select jsonb_agg(z.x order by z.campana desc)
          from (
            select f.campana,
                   jsonb_build_object(
                     'campana',   f.campana,
                     'nombre',    min(f.nombre),
                     'canales',   count(*),
                     'pedidos',   sum(f.pedidos),
                     'clientes',  sum(f.clientes),
                     'piezas',    sum(f.piezas),
                     'descuento', sum(f.descuento),
                     'ingreso',   sum(f.ingreso),
                     'filas', jsonb_agg(jsonb_build_object(
                        'id', f.id, 'clave', f.clave, 'nombre', f.nombre, 'publico', f.publico,
                        'tipo', f.tipo, 'valor', f.valor, 'desde', f.desde, 'hasta', f.hasta,
                        'activa', f.activa, 'gancho', f.es_gancho,
                        'pedidos', f.pedidos, 'clientes', f.clientes, 'piezas', f.piezas,
                        'descuento', f.descuento, 'ingreso', f.ingreso,
                        'peorMargen', f.peor_margen, 'limiteTotal', f.limite_total,
                        'limitePorCliente', f.limite_por_cliente, 'presupuesto', f.presupuesto)
                        order by f.clave)) as x
              from filas f group by f.campana) z), '[]'::jsonb))
  );
end;
$fn$;
revoke all on function public.promocion_postmortem(jsonb) from public, anon;
grant execute on function public.promocion_postmortem(jsonb) to anon, authenticated;
comment on function public.promocion_postmortem(jsonb) is
  'Como le fue a cada campaña, abierta por canal. Se mide desde los pedidos. 27 nov 2026.';


commit;
