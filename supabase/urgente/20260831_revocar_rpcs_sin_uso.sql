-- ============================================================================
--  🔴 PARCHE URGENTE 2 — retirar de la API las funciones que nadie llama
-- ----------------------------------------------------------------------------
--  ⚠️  FUERA DE migrations/ A PROPÓSITO. Se aplica a mano, hoy.
--
--  HALLAZGO 22 (31 ago 2026). La auditoría de mutaciones
--  (`node tools/auditar-mutaciones.mjs`) encontró 32 funciones que ESCRIBEN sin
--  comprobar ninguna credencial, y una consulta a producción confirmó que
--  **las 66 funciones de la API son ejecutables por `anon`**.
--
--  De esas, DIEZ no las llama nadie: ni `index.html` ni `api/*.js` las
--  mencionan una sola vez (verificado por grep). Son superficie de ataque pura,
--  sin contrapartida. Entre ellas:
--
--    agregar_punto / agregar_movimiento_lealtad -> REGALARSE puntos de lealtad
--    canjear_premio (2 versiones)               -> canjear premios con ellos
--    crear_caja_vendedor                        -> crear puntos de caja
--    registrar_entrega_vendedor                 -> mover dinero en caja
--    buscar_cliente_telefono                    -> buscar clientes por teléfono
--
--  Regalarse puntos y canjearlos es pérdida económica directa, hoy, con la
--  llave que está publicada en el repo público.
--
--  POR QUÉ ES SEGURO APLICARLO YA
--  ------------------------------
--  1. Ninguna es invocada por la app ni por las funciones serverless.
--  2. `agregar_movimiento_lealtad` SÍ se llama internamente (4 PERFORM desde
--     otras funciones), pero esas llamadas ocurren dentro de funciones
--     SECURITY DEFINER cuyo dueño es `postgres`, que conserva el permiso.
--     Revocárselo a anon no las afecta.
--  3. No depende de la infraestructura de sesiones de la Etapa B.
--
--  Retirar el permiso de ejecución las hace desaparecer de PostgREST: pasan a
--  responder 404. Siguen existiendo en la base y se pueden volver a exponer
--  cuando se necesiten, ya con sesión.
--
--  APLICAR CON:
--    supabase link --project-ref xbyzarzyxiugrucyjwfn
--    supabase db query --linked -f supabase/urgente/20260831_revocar_rpcs_sin_uso.sql
--    supabase link --project-ref dkwatbsaidlfjqjnfyrk        <- volver a staging
-- ============================================================================

do $$
declare
  f record;
  -- Verificadas una por una: 0 apariciones en index.html y en api/*.js.
  sin_uso constant text[] := array[
    'agregar_punto',
    'agregar_movimiento_lealtad',
    'canjear_premio',              -- tiene 2 sobrecargas; el bucle las cubre
    'crear_caja_vendedor',
    'registrar_entrega_vendedor',
    'buscar_cliente_telefono',
    'obtener_cajas_vendedores',
    'get_cuota_vendedor',
    'obtener_vendedor_por_cp',
    'reporte_cobros'
  ];
begin
  for f in
    select p.oid::regprocedure as firma, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any(sin_uso)
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.firma);
    raise notice 'Retirada de la API: %', f.firma;
  end loop;
end $$;

-- Comprobación: ninguna debe quedar ejecutable por anon.
select p.proname,
       has_function_privilege('anon', p.oid, 'execute') as anon_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('agregar_punto','agregar_movimiento_lealtad','canjear_premio',
                     'crear_caja_vendedor','registrar_entrega_vendedor',
                     'buscar_cliente_telefono','obtener_cajas_vendedores',
                     'get_cuota_vendedor','obtener_vendedor_por_cp','reporte_cobros')
 order by 1;
