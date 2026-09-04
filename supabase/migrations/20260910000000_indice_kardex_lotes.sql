-- Índice para el kárdex de lotes (PLAN.md §3.1)
--
-- La consulta que lo necesita vive en obtener_kardex_lotes
-- (20260903010000_lecturas_pedidos_prospectos.sql):
--
--     from public.ordenes_detalle d
--     left join public.ordenes o on o.id = d.id_orden
--    where d.kg_descontado_lote > 0
--      and (v_lote is null or d.id_lote_descontado = v_lote)
--    order by d.id desc
--    limit v_limit
--
-- Hoy `ordenes_detalle` solo tiene índices en `id_orden` e `id_producto`, así que
-- esa consulta hace un recorrido secuencial completo y ordena en memoria. Con 67
-- pedidos en producción no se nota; el hallazgo 08 del diagnóstico es de los que
-- están dormidos por volumen, no de los que no existen.
--
-- ── Por qué UN índice y no los dos que decía el diagnóstico ──
--
-- El diagnóstico pedía índices en `consecutivo_orden` y en `id_lote_descontado`.
-- Al buscar quién consulta cada columna (3 sep 2026):
--
--   * `id_lote_descontado` — sí se filtra, en la consulta de arriba. Justificado.
--   * `consecutivo_orden`  — NO se filtra ni se ordena por ella en ningún sitio.
--     Aparece como columna proyectada en el jsonb de salida del kárdex, en una
--     lista de INSERT, y en index.html:9067 como respaldo de visualización
--     (`l.consecutivo_orden || o.consecutivo || ...`), leída de una fila ya
--     devuelta. Un índice ahí sería coste de escritura en cada alta de línea de
--     pedido, a cambio de ninguna lectura más rápida. No se crea.
--
-- ── Por qué parcial y compuesto ──
--
-- `kg_descontado_lote > 0` está en el WHERE siempre, así que como predicado
-- parcial deja fuera del índice las filas que la consulta nunca mira (bebidas y
-- demás no-papa descuentan 0 kg).
--
-- `(id_lote_descontado, id DESC)` sirve los dos casos de la consulta: con lote,
-- busca por el primer campo y ya viene ordenado por el segundo, sin ordenación
-- adicional; sin lote (`v_lote is null`), sigue cubriendo el conjunto del
-- predicado parcial.
--
-- Aditivo y reversible: no toca ninguna fila. Para deshacerlo,
--   drop index if exists public.idx_detalle_kardex_lote;

create index if not exists idx_detalle_kardex_lote
  on public.ordenes_detalle (id_lote_descontado, id desc)
  where kg_descontado_lote > 0;

comment on index public.idx_detalle_kardex_lote is
  'Sirve obtener_kardex_lotes: filtro por lote + orden por id desc, sobre las líneas que descontaron kg. Creado 3 sep 2026, PLAN.md §3.1.';
