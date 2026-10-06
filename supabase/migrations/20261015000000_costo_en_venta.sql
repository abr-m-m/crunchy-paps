-- 20261015000000_costo_en_venta.sql
-- El costo se CONGELA al vender (cambios/2026-09-23-costeo-y-margen/diseno.md, D11).
--
-- POR QUE CONGELAR: si el margen se recalculara al vuelo, una compra de papa mas cara reescribiria
-- hacia atras la historia de margenes de todos los pedidos. El precio ya se congela asi —lo cotiza
-- el servidor y se guarda en la linea—; el costo hace lo mismo.
--
-- POR QUE UN TRIGGER Y NO TOCAR LAS DOS FUNCIONES: las dos puertas que escriben lineas son
-- crear_pedido (19,484 bytes) y editar_pedido_interno (12,135 bytes), las dos mas delicadas del
-- sistema. Reemplazarlas enteras para anadir dos columnas es mucho riesgo por poco beneficio
-- (regla 24: el peligro no es dejar el fallo, es lo que te traes por la puerta que abres). Un
-- BEFORE INSERT cubre las dos a la vez, cubre cualquier puerta futura, y hace estructuralmente
-- imposible el fallo de la regla 59 —aplicar la regla en un sitio y olvidarla en el de al lado—.
-- El precio: es implicito, y quien lea crear_pedido no lo vera. Por eso este comentario y la
-- entrada en diseno.md.

alter table public.ordenes_detalle
  add column if not exists costo_unitario numeric,
  add column if not exists costo_origen   text
    check (costo_origen in ('capturado','reconstruido'));

comment on column public.ordenes_detalle.costo_unitario is
  'Costo unitario congelado al escribir la linea. Lo pone trg_detalle_costear (BEFORE INSERT). '
  'NULL = sin costear: no habia receta o faltaba el costo de un insumo. Nunca 0.';
comment on column public.ordenes_detalle.costo_origen is
  'capturado = costeado al vender. reconstruido = recosteado despues con los costos historicos '
  'en papel (tarea 6). Un margen reconstruido tiene que verse reconstruido.';

create or replace function public.trg_detalle_costear()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_fecha date;
begin
  -- Ya viene puesto: es el recosteo del pasado (tarea 6), que trae su propio valor y su origen.
  -- No se pisa.
  if NEW.costo_unitario is not null then
    return NEW;
  end if;

  -- La fecha de la LINEA, no la de hoy: una linea anadida al editar un pedido viejo se costea con
  -- los precios del dia en que se escribe, que es cuando de verdad se compromete el insumo.
  -- Los defaults ya estan aplicados cuando corre un BEFORE INSERT, asi que NEW.fecha viene lleno.
  v_fecha := coalesce(NEW.fecha::date, current_date);

  if NEW.id_producto ~ '^[0-9]+$' then
    NEW.costo_unitario := public.costo_sku(NEW.id_producto::bigint, v_fecha);
  elsif NEW.id_producto ~ '^b[0-9]+$' then
    -- Las bebidas son REVENTA: no tienen receta, su costo es el de compra. El prefijo 'b' es la
    -- razon de que id_producto sea text; sin esta rama, el cast de arriba reventaria.
    select b.costo into NEW.costo_unitario
      from public.productos_bebidas b
     where b.id = substring(NEW.id_producto from 2)::bigint;
  end if;

  -- Si no se pudo costear, la linea queda en NULL y SIN origen: «sin costear», nunca 0 (D12).
  -- Un 0 aqui se leeria como margen del 100 %, que es peor que no tener el dato.
  if NEW.costo_unitario is not null then
    NEW.costo_origen := coalesce(NEW.costo_origen, 'capturado');
  end if;

  return NEW;
end $$;

drop trigger if exists trg_detalle_costear on public.ordenes_detalle;
create trigger trg_detalle_costear
  before insert on public.ordenes_detalle
  for each row execute function public.trg_detalle_costear();

revoke all on function public.trg_detalle_costear() from public;
