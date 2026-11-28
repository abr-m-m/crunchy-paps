-- 27 nov 2026 — Guardar las reglas del Club ya no borra la generosidad
--
-- `set_lealtad_config_interno` RECONSTRUYE el objeto entero con
-- `jsonb_build_object`, así que cualquier clave que no esté listada se pierde
-- al guardar. Con la generosidad por canal recién añadida, eso significaba:
-- Abraham pone «vendedor x0.5», luego entra a cambiar los puntos por peso, le
-- da a Guardar, y la generosidad desaparece **sin que nada lo diga**.
--
-- Es la misma familia que el `catch` vacío al lado de una escritura: no falla,
-- solo pierde. Y se habría notado semanas después, al no cuadrar los puntos.
--
-- Aquí se añade a la reconstrucción, con su saneo:
--   · solo números, y nunca negativos
--   · se quitan los que valgan exactamente 1, que es lo mismo que no estar:
--     así la configuración guarda lo que se decidió y no ruido
--   · si no queda ninguno, la clave no se escribe

begin;

create or replace function public.set_lealtad_config_interno(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
DECLARE
  v_g     jsonb := COALESCE(p_data->'generacion', '{}'::jsonb);
  v_r     jsonb := COALESCE(p_data->'redencion',  '{}'::jsonb);
  v_ppp   numeric := GREATEST(0, COALESCE((v_g->>'puntos_por_peso')::numeric, 0.01));
  v_base  text    := COALESCE(NULLIF(v_g->>'base',''), 'total');
  v_gact  boolean := COALESCE((v_g->>'activo')::boolean, true);
  v_vpm   numeric := GREATEST(0, COALESCE((v_r->>'valor_punto_mxn')::numeric, 0.10));
  v_pct   int     := LEAST(99, GREATEST(0, COALESCE((v_r->>'pct_max_pedido')::int, 50)));  -- NUNCA 100
  v_pmin  numeric := GREATEST(0, COALESCE((v_r->>'pago_minimo_mxn')::numeric, 1));
  v_pminc int     := GREATEST(0, COALESCE((v_r->>'puntos_minimos_canje')::int, 0));
  v_ract  boolean := COALESCE((v_r->>'activo')::boolean, true);
  v_gen   jsonb;
  v_cfg   jsonb;
  v_gcfg  jsonb;
BEGIN
  IF v_base NOT IN ('total','subtotal','neto') THEN v_base := 'total'; END IF;

  -- ── La generosidad por canal ────────────────────────────────────────────
  -- Un multiplicador por canal. Lo que vale 1 NO se guarda: «ausente» ya
  -- significa 1, y guardar unos que no hacen nada es ruido que después hay
  -- que leer para descubrir que no decía nada.
  SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb) INTO v_gen
    FROM (
      SELECT lower(btrim(e.key)) AS k, GREATEST(0, (e.value #>> '{}')::numeric) AS v
        FROM jsonb_each(COALESCE(v_g->'generosidad', '{}'::jsonb)) e
       WHERE (e.value #>> '{}') ~ '^[0-9]+([.][0-9]+)?$'
    ) s
   WHERE s.v <> 1;

  v_gcfg := jsonb_build_object('activo',v_gact,'puntos_por_peso',v_ppp,
                               'base',v_base,'momento','pago_y_entrega');
  IF v_gen <> '{}'::jsonb THEN
    v_gcfg := v_gcfg || jsonb_build_object('generosidad', v_gen);
  END IF;

  v_cfg := jsonb_build_object(
    'generacion',  v_gcfg,
    'redencion',   jsonb_build_object('activo',v_ract,'valor_punto_mxn',v_vpm,'pct_max_pedido',v_pct,'pago_minimo_mxn',v_pmin,'puntos_minimos_canje',v_pminc),
    'segmentacion',jsonb_build_object('modo','todos_iguales')
  );

  INSERT INTO config_produccion (clave, valor, descripcion, fecha_actualizacion)
  VALUES ('lealtad', v_cfg, 'Reglas Crunchy Club (editable desde admin)', now())
  ON CONFLICT (clave) DO UPDATE
    SET valor = EXCLUDED.valor, fecha_actualizacion = now();

  RETURN jsonb_build_object('ok', true, 'data', v_cfg);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$fn$;

commit;
