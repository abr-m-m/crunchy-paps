-- ============================================================================
--  RECOSTEAR EL PASADO con el costo vigente de cada fecha
--
--  Diseno: cambios/2026-11-21-frente-a-costos.md
--
--  QUE HACE. Vuelve a calcular `ordenes_detalle.costo_unitario` de las lineas
--  marcadas `reconstruido`, usando el costo que regia EL DIA DE SU PEDIDO.
--
--  QUE NO TOCA, Y ES LO IMPORTANTE:
--   * Las lineas `capturado` -el costo congelado de una venta real- no se
--     miran siquiera. Esas son el registro de lo que de verdad costo, y
--     reescribirlas seria cambiar el pasado.
--   * Ninguna otra columna. Solo `costo_unitario`. El unico trigger de UPDATE
--     de la tabla es `BEFORE UPDATE OF cantidad, gramos_vendidos`, asi que no
--     se despierta: no mueve lote, ni caja, ni puntos. Comprobado antes de la
--     primera corrida, el 21 nov 2026.
--
--  CUANDO SE CORRE. Cada vez que mejora la RECONSTRUCCION del costo: cuando
--  entra un insumo que faltaba (bolsa, etiqueta, mano de obra) o cuando
--  aparecen precios de una epoca que no se tenian. No se corre «por si acaso»:
--  cambia numeros que Abraham ya vio.
--
--  COMO SE CORRE (PowerShell). RUTA COMPLETA, no relativa: la terminal de
--  Abraham suele estar en una subcarpeta y el 22 nov 2026 este comando fallo
--  dos veces con «failed to read SQL file» por darselo relativo.
--    supabase db query --linked --project-ref xbyzarzyxiugrucyjwfn -f C:\Proyectos\crunchy-paps\tools\recostear-pasado.sql
--  Staging es dkwatbsaidlfjqjnfyrk. Devuelve cuantas lineas cambio y el total.
--
--  ESTADO AL 22 nov 2026: correrlo HOY es un no-op comprobado. Las 182 lineas
--  `reconstruido` ya llevan el costo completo -el ensayo en seco cambia 0- y el
--  margen historico lee 9.2 % (jun 11.4, jul 4.5, sep 27.8). El detalle y como
--  salio, en cambios/2026-11-21-frente-a-costos.md.
--
--  ANTES DE CORRERLO, EL ENSAYO EN SECO. El mismo `case` con
--  `count(*) filter (where nuevo is not null and (viejo is null or viejo<>nuevo))`
--  en vez del UPDATE dice cuantas lineas cambiarian. Si da 0, no hay nada que
--  escribir: la nota que decia lo contrario esta vieja.
-- ============================================================================

with calc as (
  select d.id,
         case
           -- Bebida: es reventa, su costo es el de compra.
           when d.id_producto ~ '^b[0-9]+$' then
             (select b.costo from public.productos_bebidas b
               where b.id = substring(d.id_producto from 2)::bigint)
           -- Granel: base x peso. No lleva bolsa ni etiqueta.
           when coalesce(d.tipo_venta, '') = 'A granel'
             or coalesce(d.presentacion, '') = 'Granel' then
             case when coalesce(d.gramos_vendidos, 0) > 0
                  then round(public.costo_base_kg(o.fecha_orden::date)
                             * d.gramos_vendidos / 1000.0, 4) end
           -- Por pieza: SU RECETA, que es la que lleva el empaque.
           when d.id_producto ~ '^[0-9]+$' then
             public.costo_sku(d.id_producto::bigint, o.fecha_orden::date)
         end cu
    from public.ordenes_detalle d
    join public.ordenes o on o.id = d.id_orden
   where d.costo_origen = 'reconstruido'
      or d.costo_unitario is null
), upd as (
  update public.ordenes_detalle d
     set costo_unitario = c.cu,
         costo_origen   = 'reconstruido'
    from calc c
   where d.id = c.id
     and c.cu is not null
     and (d.costo_unitario is null or d.costo_unitario <> c.cu)
     and coalesce(d.costo_origen, 'reconstruido') = 'reconstruido'
  returning d.id, d.costo_unitario cu, d.cantidad
)
select count(*)                     as lineas_actualizadas,
       round(sum(cu * cantidad), 2) as costo_de_esas_lineas,
       min(cu)                      as costo_unitario_min,
       max(cu)                      as costo_unitario_max
  from upd;
