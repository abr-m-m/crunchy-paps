-- ============================================================================
--  Que la linea POR PIEZA se costee por su RECETA, no por su peso
--
--  Diseno: cambios/2026-11-21-frente-a-costos.md
--
--  EL DEFECTO. `trg_detalle_costear` abria con:
--
--      if coalesce(NEW.gramos_vendidos, 0) > 0 then   -- «granel»
--
--  pensando que solo el granel llena `gramos_vendidos`. No es asi: TODA linea
--  por pieza de papa lo lleva, con el peso de su presentacion. Medido en
--  produccion el 21 nov 2026, de 143 lineas de papa:
--
--      Por Pieza · 100g   65 lineas   gramos = 100 siempre
--      Por Pieza · 250g   49 lineas   gramos = 250 siempre
--      Por Pieza · 500g   14 lineas   gramos = 500 siempre
--      Por Pieza · 1kg     3 lineas   gramos = 1000 siempre
--      A granel · Granel  11 lineas   gramos = 45 a 1000, cantidad = 1
--
--  Asi que la rama de granel se comia TODAS las lineas de pieza y `costo_sku`
--  -la funcion que lee la receta- no se llamaba nunca.
--
--  POR QUE NO SE VIO. Porque hoy los dos caminos dan el MISMO numero al
--  centavo: la receta de un SKU de 100 g es 0.1 kg de base y nada mas, asi que
--  receta y peso coinciden ($12.9621 por los dos lados, comprobado).
--
--  POR QUE IMPORTA MANANA. El siguiente paso del frente A es meter BOLSA,
--  ETIQUETA, SAL y SAZONADOR en las recetas de SKU. Con la rama vieja, esos
--  insumos se habrian anadido a la receta y el costo de las bolsas NO HABRIA
--  CAMBIADO: el empaque desaparecia en silencio y el margen seguiria saliendo
--  mas alto de lo que es. Un defecto que solo aparece cuando el suelo se
--  mueve, y el suelo se mueve la semana que viene.
--
--  EL ARREGLO. El criterio no es «quien devuelve null», que esconde el dia en
--  que aparece una receta, sino LO QUE LA LINEA ES:
--
--    * bebida (`b123`)  -> costo de compra. Es reventa, no se produce.
--    * A granel         -> base x peso. No lleva bolsa y el peso es la unica
--                          verdad (136 g y 1 kg no pueden costar lo mismo).
--    * por pieza        -> SU RECETA. Es la linea que llevara el empaque.
--
--  Una linea por pieza cuyo SKU no tenga receta queda SIN COSTEAR, a
--  proposito: es un hueco que hay que ver, no rellenar por peso a escondidas.
--  Comprobado el 21 nov 2026: los 28 SKU de papa activos tienen receta, asi
--  que este cambio no deja de costear ni una linea de las que hay.
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

create or replace function public.trg_detalle_costear()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_fecha  date;
  v_base   numeric;
  v_granel boolean;
begin
  -- Ya viene puesto: es el recosteo del pasado, que trae su propio valor y su
  -- origen. No se pisa.
  if NEW.costo_unitario is not null then
    return NEW;
  end if;

  -- La fecha de la LINEA, no la de hoy: una linea anadida al editar un pedido
  -- viejo se costea con los precios del dia en que se escribe, que es cuando
  -- de verdad se compromete el insumo. Los defaults ya estan aplicados cuando
  -- corre un BEFORE INSERT, asi que NEW.fecha viene lleno.
  v_fecha := coalesce(NEW.fecha::date, current_date);

  -- Que la linea sea granel es un HECHO de la linea, no una consecuencia de
  -- que una funcion devuelva null. Se mira por los dos campos que lo dicen.
  v_granel := coalesce(NEW.tipo_venta, '') = 'A granel'
           or coalesce(NEW.presentacion, '') = 'Granel';

  if NEW.id_producto ~ '^b[0-9]+$' then
    -- Las bebidas son REVENTA: no tienen receta, su costo es el de compra. El
    -- prefijo 'b' es la razon de que id_producto sea text.
    select b.costo into NEW.costo_unitario
      from public.productos_bebidas b
     where b.id = substring(NEW.id_producto from 2)::bigint;

  elsif v_granel then
    -- GRANEL: `cantidad` es 1 y los gramos van aparte, asi que el costo
    -- unitario ES el de esos gramos. Base pura, sin bolsa.
    if coalesce(NEW.gramos_vendidos, 0) > 0 then
      v_base := public.costo_base_kg(v_fecha);
      if v_base is not null then
        NEW.costo_unitario := round(v_base * NEW.gramos_vendidos / 1000.0, 4);
      end if;
    end if;

  elsif NEW.id_producto ~ '^[0-9]+$' then
    -- POR PIEZA: su receta. Aqui entraran bolsa, etiqueta, sal y sazonador, y
    -- por eso tiene que ser este camino y no el peso.
    NEW.costo_unitario := public.costo_sku(NEW.id_producto::bigint, v_fecha);
  end if;

  -- Si no se pudo costear, la linea queda en NULL y SIN origen: «sin costear»,
  -- nunca 0. Un 0 aqui se leeria como margen del 100 %, que es peor que no
  -- tener el dato.
  if NEW.costo_unitario is not null then
    NEW.costo_origen := coalesce(NEW.costo_origen, 'capturado');
  end if;

  return NEW;
end $function$;
