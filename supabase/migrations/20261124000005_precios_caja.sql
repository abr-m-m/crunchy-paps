-- 24 nov 2026 — Los precios de caja, en la consola de precios.
--
-- Abraham: «antes ya habiamos definido precios por caja. Integramos de 3 6 y
-- 12 pzas. ¿Por que ahora hace falta?».
--
-- Tiene razon a medias, y la mitad que falta es la que importa. El 13 sep 2026
-- se construyo el MECANISMO entero -la caja se guarda como piezas,
-- `ordenes_detalle.piezas_por_caja` recuerda cual era, y `crear_pedido` cobra
-- `cajas × precio_caja` sin aplicar el descuento de lista-. Lo que nunca se
-- puso son los NUMEROS. Medido hoy:
--
--   produccion   0 de 35 productos con precio de caja, y 0 lineas vendidas asi
--   staging      58 filas con precio de caja... de las que 56 son basura de los
--                tests (`EDIT-319519`, `EDITDBG17-…`). La unica real es
--                Naturales Bolsa 50g con precio_caja_12 = 300, que es
--                LITERALMENTE la linea de humo del documento del 13 sep.
--
-- Y no habia donde escribirlos: `/productos` no tiene campos de caja y
-- `guardar_precios` ni siquiera menciona `precio_caja`. No era trabajo de
-- teclear: era una pieza que nadie habia contado.
--
-- POR QUE NO SE NOTO: con precio_caja en NULL la caja se vende igual, a
-- piezas × precio del canal. El tendero compra su caja de 6 y paga lo mismo
-- que comprando 6 sueltas. No esta roto; lo que no existe es el DESCUENTO por
-- comprar caja, que es el unico motivo de venderla asi.
--
-- Esta migracion solo abre la puerta para escribirlos. Los numeros los decide
-- Abraham, y la pantalla le ensenia al lado lo que necesita para decidir: lo
-- que paga por pieza, el margen que deja y cuanto baja respecto a comprar
-- sueltas.
--
-- LO QUE NO HACE, A PROPOSITO: no impone un piso de margen. Esta pantalla se
-- diseño el 23 nov con el margen AL LADO y sin piso -el dueño manda sobre su
-- precio de lista-, y las promociones si tienen piso porque son otra cosa.
-- Inventar aqui una regla que la pantalla de al lado no tiene seria la via
-- rapida a dos verdades distintas sobre el mismo numero.

begin;

-- ── 1. Lo que ve la pantalla ──────────────────────────────────────────────
-- Copiada de la que corre en produccion; lo unico que cambia son las tres
-- claves nuevas.
CREATE OR REPLACE FUNCTION public.precios_admin(p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_r jsonb;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'solo_dueno');
  end if;
  select coalesce(jsonb_agg(x order by x->>'gramos', x->>'sabor'), '[]'::jsonb) into v_r
    from (
      select jsonb_build_object(
               'id', p.id, 'sabor', p.sabor, 'presentacion', p.presentacion,
               'gramos', p.gramos,
               'consumidor', p.precio_consumidor, 'mostrador', p.precio_mostrador,
               'restaurante', p.precio_restaurante, 'tienda', p.precio_tienda,
               'mayorista', p.precio_mayorista, 'granel_kg', p.precio_granel_kg,
               'descuento', p.descuento_pct,
               -- La caja: un solo precio para tienda y mayorista, como se
               -- decidio el 13 sep. NULL o 0 = sin precio de caja, y entonces
               -- la caja cuesta piezas × precio del canal.
               'caja_3', p.precio_caja_3, 'caja_6', p.precio_caja_6,
               'caja_12', p.precio_caja_12,
               'canje_activo', p.canje_activo, 'puntos_canje', p.puntos_canje,
               'imagen', p.imagen_url,
               -- El costo viene del motor, no se copia aqui (regla 63). Asi la
               -- pantalla puede enseniar el margen sin recalcularlo mal.
               'costo', round(public.costo_sku(p.id, current_date), 2)
             ) x
        from public.productos p
       where p.activo and coalesce(p.descontinuado, false) = false
    ) t;
  return jsonb_build_object(
    'ok', true,
    'productos', v_r,
    'valor_punto', coalesce((select (valor->'redencion'->>'valor_punto_mxn')::numeric
                               from public.config_produccion where clave = 'lealtad'), 0.30)
  );
end $function$;

-- ── 2. Lo que se guarda ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guardar_precios(p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_fila   jsonb;
  v_id     bigint;
  v_n      integer := 0;
  v_malos  text[] := '{}';
  v_gramos integer;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'solo_dueno');
  end if;

  for v_fila in select * from jsonb_array_elements(coalesce(p_data->'cambios', '[]'::jsonb))
  loop
    v_id := nullif(v_fila->>'id', '')::bigint;
    if v_id is null then
      v_malos := v_malos || 'fila sin id'; continue;
    end if;
    -- El navegador NO decide dinero: un precio negativo, un descuento fuera
    -- de 0-100 o un canje negativo se rechazan aqui aunque la pantalla los
    -- haya dejado escribir.
    if exists (select 1 from jsonb_each_text(v_fila) e
                where e.key in ('consumidor','mostrador','restaurante','tienda',
                                'mayorista','granel_kg','puntos_canje',
                                'caja_3','caja_6','caja_12')
                  and e.value <> '' and e.value::numeric < 0) then
      v_malos := v_malos || ('id ' || v_id || ': valor negativo'); continue;
    end if;
    if (v_fila ? 'descuento') and nullif(v_fila->>'descuento','') is not null
       and ((v_fila->>'descuento')::numeric < 0 or (v_fila->>'descuento')::numeric > 100) then
      v_malos := v_malos || ('id ' || v_id || ': descuento fuera de 0-100'); continue;
    end if;
    -- Una caja de granel no existe: la caja son PIEZAS de un solo sabor.
    if (v_fila ? 'caja_3' or v_fila ? 'caja_6' or v_fila ? 'caja_12') then
      select p.gramos into v_gramos from public.productos p where p.id = v_id;
      if v_gramos is null then
        v_malos := v_malos || ('id ' || v_id || ': el granel no se vende por caja'); continue;
      end if;
    end if;

    update public.productos p set
      precio_consumidor  = coalesce(nullif(v_fila->>'consumidor','')::numeric,  p.precio_consumidor),
      precio_mostrador   = coalesce(nullif(v_fila->>'mostrador','')::numeric,   p.precio_mostrador),
      precio_restaurante = coalesce(nullif(v_fila->>'restaurante','')::numeric, p.precio_restaurante),
      precio_tienda      = coalesce(nullif(v_fila->>'tienda','')::numeric,      p.precio_tienda),
      precio_mayorista   = coalesce(nullif(v_fila->>'mayorista','')::numeric,   p.precio_mayorista),
      precio_granel_kg   = coalesce(nullif(v_fila->>'granel_kg','')::numeric,   p.precio_granel_kg),
      descuento_pct      = coalesce(nullif(v_fila->>'descuento','')::numeric,   p.descuento_pct),
      -- La caja SI se puede vaciar, y los demas precios no: un precio de lista
      -- en NULL deja un producto sin precio, pero una caja en NULL es un estado
      -- legitimo -«esta no se vende por caja»- y es como nacieron los 35. Por
      -- eso aqui manda `? clave`: si la clave viene vacia, se BORRA; si no
      -- viene, se queda como estaba.
      precio_caja_3      = case when v_fila ? 'caja_3'  then nullif(v_fila->>'caja_3','')::numeric  else p.precio_caja_3 end,
      precio_caja_6      = case when v_fila ? 'caja_6'  then nullif(v_fila->>'caja_6','')::numeric  else p.precio_caja_6 end,
      precio_caja_12     = case when v_fila ? 'caja_12' then nullif(v_fila->>'caja_12','')::numeric else p.precio_caja_12 end,
      puntos_canje       = coalesce(nullif(v_fila->>'puntos_canje','')::integer, p.puntos_canje),
      canje_activo       = coalesce((v_fila->>'canje_activo')::boolean,         p.canje_activo),
      -- La ruta la arma /api/imagen con lista blanca; aqui solo se guarda.
      imagen_url         = coalesce(nullif(v_fila->>'imagen',''),               p.imagen_url),
      fecha_actualizacion = now()
     where p.id = v_id and p.activo;
    if found then v_n := v_n + 1; end if;
  end loop;

  return jsonb_build_object('ok', true, 'guardados', v_n,
                            'rechazados', to_jsonb(v_malos));
end $function$;

commit;
