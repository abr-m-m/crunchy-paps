-- ============================================================================
--  RLS — ETAPA A: cerrar lo que el navegador NUNCA toca directamente
-- ----------------------------------------------------------------------------
--  Contexto (ACCESOS.md §3.0): las 26 tablas de negocio tenían políticas
--  `TO anon USING (true) WITH CHECK (true)` SIN cláusula FOR, lo que concede
--  los cuatro comandos —SELECT, INSERT, UPDATE y DELETE— al rol anónimo. Con
--  la llave anon publicada en el repo, cualquiera podía borrar órdenes,
--  alterar la contabilidad o reescribir el pin_hash de un vendedor.
--
--  POR QUÉ ESTA ETAPA ES SEGURA
--  ---------------------------
--  Se inventariaron TODAS las llamadas del navegador (grep de `supabaseCall` y
--  de `/rest/v1/` en index.html). El navegador toca directamente 13 tablas:
--
--    clientes, cupones, gastos, gastos_insumos, jornadas, lotes_produccion,
--    ordenes, ordenes_detalle, produccion_diaria, productos,
--    productos_bebidas, prospectos, stock_terminado
--
--  Esas NO se tocan aquí: van en la Etapa B, cuando sus llamadas directas se
--  hayan movido a RPCs. Esta etapa cierra únicamente las que el navegador
--  alcanza SOLO a través de RPCs `SECURITY DEFINER`, que ignoran RLS por
--  correr como su dueño (postgres). Se verificó que las 65 funciones que la
--  app invoca son DEFINER.
--
--  QUÉ INCLUYE
--  -----------
--    1. Triggers INVOKER -> DEFINER (si no, romperían al cerrar caja_movimientos)
--    2. Vistas: quitar a anon los permisos que no necesita
--    3. Tablas solo-RPC: eliminar las políticas permisivas de anon
--    4. GRANTs de escritura de anon en esas tablas (defensa en profundidad)
--
--  REVERSIÓN
--  ---------
--  supabase/rollback/20260831000000_rls_etapa_a_REVERTIR.sql
--  (fuera de migrations/ a propósito: `db push` no debe aplicarlo nunca)
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
--  1. TRIGGERS: INVOKER -> DEFINER
-- ────────────────────────────────────────────────────────────────────────────
--  Estas funciones se disparan por operaciones que el navegador SÍ hace como
--  anon (PATCH ordenes, POST gastos, INSERT ordenes_detalle) y escriben en
--  tablas que esta migración cierra (caja_movimientos, lotes_produccion...).
--  Siendo INVOKER corren como anon y fallarían. Como son maquinaria interna y
--  no reciben entrada del usuario más allá de NEW/OLD, corresponde que corran
--  con los privilegios de su dueño.
--
--  Se fija search_path explícitamente: una función SECURITY DEFINER con
--  search_path mutable es escalable por un atacante que cree objetos que
--  sombreen a los del esquema esperado.

alter function public.caja_movimiento_por_gasto()            security definer;
alter function public.caja_movimiento_por_gasto()            set search_path = public, pg_temp;

alter function public.caja_movimiento_por_pedido()           security definer;
alter function public.caja_movimiento_por_pedido()           set search_path = public, pg_temp;

alter function public.caja_generar_movimiento_al_confirmar() security definer;
alter function public.caja_generar_movimiento_al_confirmar() set search_path = public, pg_temp;

alter function public.descontar_inventario_pedido()          security definer;
alter function public.descontar_inventario_pedido()          set search_path = public, pg_temp;

alter function public.trg_reconciliar_lote()                 security definer;
alter function public.trg_reconciliar_lote()                 set search_path = public, pg_temp;

-- update_fecha_actualizacion solo modifica NEW, no escribe en otras tablas.
-- Se deja como está: convertirla no aporta nada y toca 9 triggers.

-- ────────────────────────────────────────────────────────────────────────────
--  2. VISTAS
-- ────────────────────────────────────────────────────────────────────────────
--  Las 5 vistas son propiedad de postgres y NO son security_invoker, así que
--  consultan sus tablas base con los privilegios del dueño: SALTAN EL RLS.
--  Además anon tenía sobre ellas DELETE, INSERT, UPDATE, TRUNCATE y TRIGGER.
--  Sin esto, cerrar las tablas no serviría de nada: `vendedores_publico`
--  seguiría entregando el correo y el teléfono de los 8 vendedores, y
--  `saldo_caja_actual` la contabilidad completa.

revoke all on public.vendedores_publico  from anon;
revoke all on public.saldo_caja_actual   from anon;
revoke all on public.saldos_lealtad      from anon;
revoke all on public.pasivo_lealtad      from anon;

-- vista_inventario SÍ la lee el navegador (1 llamada GET). Se le deja
-- únicamente SELECT; nada de escribir sobre una vista.
revoke all    on public.vista_inventario from anon;
grant  select on public.vista_inventario to   anon;

-- ────────────────────────────────────────────────────────────────────────────
--  3. TABLAS SOLO-RPC: eliminar políticas permisivas de anon
-- ────────────────────────────────────────────────────────────────────────────
--  Con RLS activo y SIN política para anon, el resultado es negar: cero filas
--  en lectura y error en escritura. Los RPCs DEFINER siguen funcionando porque
--  corren como postgres, que es dueño de las tablas y no está sujeto a RLS
--  (no se usa FORCE ROW LEVEL SECURITY).

do $$
declare
  t text;
  p text;
  objetivo text[] := array[
    'vendedores',           -- contiene pin_hash, email y teléfono
    'caja_dias',            -- contabilidad
    'caja_movimientos',     -- contabilidad
    'caja_puntos',
    'canjes_historial',
    'cupones_uso',
    'config_produccion',
    'config_secciones',
    'cuotas_vendedor',
    'zonas_vendedor',
    'insumos',
    'inventario_fisico',
    'uso_insumos',
    'lealtad_movimientos'
  ];
begin
  foreach t in array objetivo loop
    for p in
      select policyname from pg_policies
      where schemaname = 'public' and tablename = t and 'anon' = any(roles)
    loop
      execute format('drop policy %I on public.%I', p, t);
      raise notice 'Eliminada política % en %', p, t;
    end loop;
  end loop;
end $$;

-- premios: caso aparte. Tenía DOS políticas:
--   "Premios públicos"     FOR SELECT USING (activo = true)  <- correcta, se conserva
--   "Premios admin escribe" ALL USING(true) WITH CHECK(true) <- se elimina
-- El catálogo de premios activos es información pública del programa de
-- lealtad; escribirlo no lo es.
drop policy if exists "Premios admin escribe" on public.premios;

-- ────────────────────────────────────────────────────────────────────────────
--  4. GRANTs (defensa en profundidad)
-- ────────────────────────────────────────────────────────────────────────────
--  Con RLS cerrado los GRANTs ya no bastan para entrar, pero dejarlos abiertos
--  significa que reactivar una política por error vuelve a abrir la escritura
--  de golpe. Se retiran los cuatro comandos y se devuelve SELECT solo donde
--  hace falta (premios, que conserva lectura pública acotada por su política).

revoke insert, update, delete, truncate on
  public.vendedores, public.caja_dias, public.caja_movimientos,
  public.caja_puntos, public.canjes_historial, public.cupones_uso,
  public.config_produccion, public.config_secciones, public.cuotas_vendedor,
  public.zonas_vendedor, public.insumos, public.inventario_fisico,
  public.uso_insumos, public.lealtad_movimientos, public.premios
from anon;

revoke select on
  public.vendedores, public.caja_dias, public.caja_movimientos,
  public.caja_puntos, public.canjes_historial, public.cupones_uso,
  public.config_produccion, public.config_secciones, public.cuotas_vendedor,
  public.zonas_vendedor, public.insumos, public.inventario_fisico,
  public.uso_insumos, public.lealtad_movimientos
from anon;

-- ────────────────────────────────────────────────────────────────────────────
--  5. CONSTANCIA
-- ────────────────────────────────────────────────────────────────────────────
comment on table public.vendedores is
  'RLS Etapa A (30 ago 2026): sin acceso directo de anon. Se alcanza solo por RPCs SECURITY DEFINER (validar_vendedor_pin, obtener_vendedores, buscar_vendedores). Contiene pin_hash: nunca reabrir a anon.';

comment on table public.caja_movimientos is
  'RLS Etapa A (30 ago 2026): sin acceso directo de anon. Se escribe por triggers SECURITY DEFINER y por rpc/registrar_movimiento_caja.';
