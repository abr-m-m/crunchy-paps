-- ============================================================================
--  REVERSIÓN de la Etapa A de RLS
-- ----------------------------------------------------------------------------
--  ⚠️  ESTE ARCHIVO VIVE FUERA DE migrations/ A PROPÓSITO.
--      `supabase db push` NO debe aplicarlo nunca. Se corre a mano, y solo si
--      la Etapa A rompió algo en producción y hace falta volver atrás YA.
--
--  ⚠️  APLICARLO REABRE LA BASE. Deja otra vez a `anon` con lectura y escritura
--      sobre datos personales, contabilidad y pin_hash de vendedores. Es una
--      salida de emergencia, no un estado aceptable: si hay que usarlo, el
--      siguiente paso es arreglar la causa y volver a cerrar.
--
--  Uso:  supabase db query --linked -f supabase/rollback/20260831000000_rls_etapa_a_REVERTIR.sql
-- ============================================================================

-- 1. Devolver los GRANTs
grant select, insert, update, delete on
  public.vendedores, public.caja_dias, public.caja_movimientos,
  public.caja_puntos, public.canjes_historial, public.cupones_uso,
  public.config_produccion, public.config_secciones, public.cuotas_vendedor,
  public.zonas_vendedor, public.insumos, public.inventario_fisico,
  public.uso_insumos, public.lealtad_movimientos, public.premios
to anon;

-- 2. Recrear las políticas permisivas, tal como estaban
create policy "vendedores_lectura"      on public.vendedores          for select to authenticated, anon using (true);
create policy "vendedores_escritura"    on public.vendedores          to authenticated, anon using (true) with check (true);
create policy "caja_dias_lectura"       on public.caja_dias           for select to authenticated, anon using (true);
create policy "caja_dias_escritura"     on public.caja_dias           to authenticated, anon using (true) with check (true);
create policy "caja_mov_lectura"        on public.caja_movimientos    for select to authenticated, anon using (true);
create policy "caja_mov_escritura"      on public.caja_movimientos    to authenticated, anon using (true) with check (true);
create policy "caja_puntos_lectura"     on public.caja_puntos         for select to authenticated, anon using (true);
create policy "caja_puntos_escritura"   on public.caja_puntos         to authenticated, anon using (true) with check (true);
create policy "canjes_hist_lectura"     on public.canjes_historial    for select to authenticated, anon using (true);
create policy "canjes_hist_escritura"   on public.canjes_historial    for insert to authenticated, anon with check (true);
create policy "Cupones uso lectura"     on public.cupones_uso         for select to authenticated, anon using (true);
create policy "Cupones uso escritura"   on public.cupones_uso         for insert to authenticated, anon with check (true);
create policy "cp"                      on public.config_produccion   to authenticated, anon using (true) with check (true);
create policy "cs"                      on public.config_secciones    to authenticated, anon using (true) with check (true);
create policy "cuotas_v"                on public.cuotas_vendedor     to authenticated, anon using (true) with check (true);
create policy "zv"                      on public.zonas_vendedor      to authenticated, anon using (true) with check (true);
create policy "insumos_lectura"         on public.insumos             for select to authenticated, anon using (true);
create policy "insumos_escritura"       on public.insumos             to authenticated, anon using (true) with check (true);
create policy "inv_fis_lectura"         on public.inventario_fisico   for select to authenticated, anon using (true);
create policy "inv_fis_escritura"       on public.inventario_fisico   to authenticated, anon using (true) with check (true);
create policy "uso_ins_lectura"         on public.uso_insumos         for select to authenticated, anon using (true);
create policy "uso_ins_escritura"       on public.uso_insumos         to authenticated, anon using (true) with check (true);
create policy "lealtad_mov_lectura"     on public.lealtad_movimientos for select to authenticated, anon using (true);
create policy "lealtad_mov_escritura"   on public.lealtad_movimientos to authenticated, anon using (true) with check (true);
create policy "Premios admin escribe"   on public.premios             to authenticated, anon using (true) with check (true);

-- 3. Devolver los permisos sobre las vistas
grant select, insert, update, delete on public.vendedores_publico to anon;
grant select, insert, update, delete on public.saldo_caja_actual  to anon;
grant select, insert, update, delete on public.saldos_lealtad     to anon;
grant select, insert, update, delete on public.pasivo_lealtad     to anon;
grant select, insert, update, delete on public.vista_inventario   to anon;

-- 4. Devolver los triggers a SECURITY INVOKER
--    (rara vez hace falta: convertirlos a DEFINER no rompe nada por sí solo)
alter function public.caja_movimiento_por_gasto()            security invoker;
alter function public.caja_movimiento_por_pedido()           security invoker;
alter function public.caja_generar_movimiento_al_confirmar() security invoker;
alter function public.descontar_inventario_pedido()          security invoker;
alter function public.trg_reconciliar_lote()                 security invoker;
