-- ============================================================================
--  CIERRE FINAL — revocar SELECT en ordenes, ordenes_detalle y prospectos
-- ----------------------------------------------------------------------------
--  Es el último paso del §3.0. Con las 16 lecturas movidas a RPCs con sesión y
--  la última —el leer-sumar-escribir de num_visitas— sustituida por un
--  incremento atómico, ya no queda nada en `index.html` que lea estas tablas
--  directamente. Verificado por grep: cero referencias.
--
--  Lo que se cierra hoy con esto:
--    · `ordenes`         67 pedidos con nombre, teléfono y dirección de cliente
--    · `ordenes_detalle` qué compró cada quien
--    · `prospectos`      1.132 negocios con geolocalización
--
--  Las escrituras ya estaban cerradas (20260901060000). Esto retira lo último
--  que quedaba: la lectura.
-- ============================================================================

revoke select on public.ordenes         from anon;
revoke select on public.ordenes_detalle from anon;
revoke select on public.prospectos      from anon;

comment on table public.ordenes is
  'RLS Etapa B (2 sep 2026): CERRADA a anon. Lectura por obtener_pedidos / obtener_pedido / obtener_regalos_cliente; escritura por crear_pedido, actualizar_estatus_pedido y actualizar_campos_pedido. Contiene datos personales de clientes (LFPDPPP).';
comment on table public.ordenes_detalle is
  'RLS Etapa B (2 sep 2026): CERRADA a anon. Lectura por obtener_detalle_pedidos / obtener_pedido / obtener_kardex_lotes. La app nunca le escribe: lo hacen los triggers y crear_pedido.';
comment on table public.prospectos is
  'RLS Etapa B (2 sep 2026): CERRADA a anon. 1.132 negocios con geolocalización. Lectura por obtener_prospectos; escritura por crear_prospecto, actualizar_prospecto e importar_prospectos_bulk.';
