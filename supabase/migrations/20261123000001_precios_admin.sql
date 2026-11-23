-- ════════════════════════════════════════════════════════════════════════════
--  PRECIOS, DESCUENTOS Y TIENDA DE CANJE, desde una pantalla
--  23 nov 2026. Abraham: «cómo gestiono los precios de tienda de canje,
--  productos y descuentos. Valdría la pena una interfaz como las otras».
--
--  POR QUE HACE FALTA. Hasta hoy los precios se editaban A MANO en la tabla
--  de Supabase —asi lo dice el propio CLAUDE.md— y eso tiene dos costes que
--  ya se pagaron esta semana: cambiar 28 SKUs es un UPDATE que alguien tiene
--  que escribir bien, y el descuento_pct lleva en 0 desde siempre porque
--  encenderlo pedia abrir el tablero.
--
--  LA GUARDA. Solo el dueno (`sesion_es_dueno`). Y los numeros se validan en
--  el SERVIDOR, no en la pantalla: el navegador no decide dinero (regla 10).
-- ════════════════════════════════════════════════════════════════════════════

-- ── Leer: todo lo que la pantalla necesita, en una llamada ──────────────────
create or replace function public.precios_admin(p_data jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
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
end $$;

-- ── Escribir: una lista de cambios, validada en el servidor ─────────────────
create or replace function public.guardar_precios(p_data jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_fila   jsonb;
  v_id     bigint;
  v_n      integer := 0;
  v_malos  text[] := '{}';
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
                                'mayorista','granel_kg','puntos_canje')
                  and e.value <> '' and e.value::numeric < 0) then
      v_malos := v_malos || ('id ' || v_id || ': valor negativo'); continue;
    end if;
    if (v_fila ? 'descuento') and nullif(v_fila->>'descuento','') is not null
       and ((v_fila->>'descuento')::numeric < 0 or (v_fila->>'descuento')::numeric > 100) then
      v_malos := v_malos || ('id ' || v_id || ': descuento fuera de 0-100'); continue;
    end if;

    update public.productos p set
      precio_consumidor  = coalesce(nullif(v_fila->>'consumidor','')::numeric,  p.precio_consumidor),
      precio_mostrador   = coalesce(nullif(v_fila->>'mostrador','')::numeric,   p.precio_mostrador),
      precio_restaurante = coalesce(nullif(v_fila->>'restaurante','')::numeric, p.precio_restaurante),
      precio_tienda      = coalesce(nullif(v_fila->>'tienda','')::numeric,      p.precio_tienda),
      precio_mayorista   = coalesce(nullif(v_fila->>'mayorista','')::numeric,   p.precio_mayorista),
      precio_granel_kg   = coalesce(nullif(v_fila->>'granel_kg','')::numeric,   p.precio_granel_kg),
      descuento_pct      = coalesce(nullif(v_fila->>'descuento','')::numeric,   p.descuento_pct),
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
end $$;

-- Una funcion nueva concede EXECUTE a PUBLIC por defecto (regla 42).
revoke all on function public.precios_admin(jsonb)   from public, anon, authenticated;
revoke all on function public.guardar_precios(jsonb) from public, anon, authenticated;
grant execute on function public.precios_admin(jsonb)   to anon, authenticated;
grant execute on function public.guardar_precios(jsonb) to anon, authenticated;
