-- ============================================================================
--  Darle de comer al motor de costeo
--
--  Diseno: cambios/2026-11-21-frente-a-costos.md
--
--  EL MOTOR YA ESTABA. `costo_sku`, `costo_base_kg`, `costo_insumo`, la columna
--  `ordenes_detalle.costo_unitario` y el disparador que congela el costo al
--  vender llevan desplegados desde octubre. Lo que no habia era COMIDA: las
--  siete tablas de costeo estaban en CERO y por eso `costo_sku` devolvia null
--  y 0 de 183 lineas estaban costeadas.
--
--  LOS NUMEROS LOS DIO ABRAHAM el 21 nov 2026, porque no estan en ningun otro
--  sitio: se busco en el cuaderno historico y **no esta el costo de la materia
--  prima**. Sus 27 compras son gasto general -bolsas, gas, jabon, leche,
--  fumigacion- y sus 38 registros de produccion anotan HORAS DE FREIR
--  («Lunes 16 Febrero, freir 9:00-2:00»), no kilos. Ni un kilo de papa, ni un
--  precio, ni un rendimiento.
--
--    «60 kg de papa dan aprox 14 o 15 kg de papa frita, la papa ahorita en
--     promedio $23, el bidon en 750 y dura aprox 6 tandas»
--
--  De ahi: ((60 x 23) + (750 / 6)) / 14.5 = **$103.79 por kilo de base**.
--
--  CALIBRADO CONTRA UN HECHO SABIDO antes de creerle (regla 60): con ese costo,
--  el margen sale 68% en la bolsa de 100 g al consumidor y 45% en el kilo a
--  tienda. Son margenes plausibles para botana y ninguno sale negativo ni
--  absurdo, asi que la lectura de los numeros es correcta.
--
--  ─────────────────────────────────────────────────────────────────────────
--  LO QUE ESTE COSTO **NO** INCLUYE, y hay que decirlo cada vez que se mire:
--  bolsa, etiqueta, sal, sazonador, gas y mano de obra. **Es un PISO, no el
--  costo.** El margen real es MENOR que el que salga de aqui. Se deja asi, y
--  no con los insumos puestos sin precio, por una razon concreta: a
--  `costo_base_kg` le falta UN costo y devuelve null, o sea que meter la sal
--  sin su precio apagaria el costeo entero. Mas vale un piso declarado que
--  ningun numero. Queda escrito en `recetas.nota`, que es donde lo va a leer
--  quien audite.
--  ─────────────────────────────────────────────────────────────────────────
--
--  POR QUE EL ACEITE SE MIDE EN BIDONES Y NO EN LITROS: Abraham dio el precio
--  del bidon y las tandas que aguanta, no los litros. Modelarlo por bidon usa
--  el dato que existe en vez de inventar una conversion.
--
--  POR QUE `vigente_desde` ES HOY Y NO ENERO: $23 es el precio de HOY. Fechar
--  esto en enero pondria el precio de noviembre en las ventas de marzo y
--  fabricaria una historia de margenes que nadie midio. Las 183 lineas viejas
--  se quedan SIN costear, que es la verdad. Recostear el pasado necesita los
--  precios de entonces y es trabajo aparte (`costo_origen = 'reconstruido'`).
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

-- ── 1. Los dos insumos que hoy tienen precio conocido ───────────────────────
insert into public.insumos (nombre, unidad, unidad_compra, costo_unidad, activo, tipo)
select 'Papa', 'kg', 'kg', 23, true, 'materia_prima'
 where not exists (select 1 from public.insumos where nombre = 'Papa');

insert into public.insumos (nombre, unidad, unidad_compra, costo_unidad, activo, tipo)
select 'Aceite', 'bidón', 'bidón', 750, true, 'materia_prima'
 where not exists (select 1 from public.insumos where nombre = 'Aceite');

-- El precio vigente vive en `insumos_costos`, no en `insumos.costo_unidad`:
-- `costo_insumo` lee de aqui, y asi un cambio de precio no borra el anterior.
insert into public.insumos_costos (id_insumo, costo_unidad, vigente_desde, fuente, nota)
select i.id, 23, current_date, 'capturado',
       'Precio promedio declarado el 21 nov 2026. Lo dijo Abraham el 21 nov 2026. No hay factura detras: es lo que dice que esta pagando.'
  from public.insumos i
 where i.nombre = 'Papa'
   and not exists (select 1 from public.insumos_costos c
                    where c.id_insumo = i.id and c.vigente_desde = current_date);

insert into public.insumos_costos (id_insumo, costo_unidad, vigente_desde, fuente, nota)
select i.id, 750, current_date, 'capturado',
       'Bidón completo, dicho por Abraham el 21 nov 2026. Aguanta unas 6 tandas; el reparto por tanda vive en la receta.'
  from public.insumos i
 where i.nombre = 'Aceite'
   and not exists (select 1 from public.insumos_costos c
                    where c.id_insumo = i.id and c.vigente_desde = current_date);

-- ── 2. La receta de la base: una tanda ──────────────────────────────────────
-- 60 kg de papa + un sexto de bidon rinden 14.5 kg de papa frita.
-- 14.5 es el punto medio de «14 o 15». La diferencia no es cosmetica: a 14 el
-- kilo sale en $107.50 y a 15 en $100.33, un 7% de diferencia que se mueve
-- entero al margen. Queda anotado para que quien lo mire sepa que es un rango.
insert into public.recetas (tipo, id_producto, rinde_cantidad, rinde_unidad, vigente_desde, activa, nota)
select 'base', null, 14.5, 'kg', current_date, true,
       'Una tanda: 60 kg de papa + 1/6 de bidón de aceite rinden 14-15 kg (se usa 14.5). ' ||
       'PISO, NO COSTO COMPLETO: faltan sal, sazonador, gas y mano de obra, así que el ' ||
       'margen que salga de aquí es MAYOR que el real. Números dichos por Abraham el 21 nov 2026.'
 where not exists (select 1 from public.recetas where tipo = 'base' and activa
                     and vigente_desde = current_date);

insert into public.receta_lineas (id_receta, id_insumo, cantidad, unidad)
select r.id, i.id, 60, 'kg'
  from public.recetas r, public.insumos i
 where r.tipo = 'base' and r.vigente_desde = current_date and i.nombre = 'Papa'
   and not exists (select 1 from public.receta_lineas l where l.id_receta = r.id and l.id_insumo = i.id);

insert into public.receta_lineas (id_receta, id_insumo, cantidad, unidad)
select r.id, i.id, round(1.0/6.0, 6), 'bidón'
  from public.recetas r, public.insumos i
 where r.tipo = 'base' and r.vigente_desde = current_date and i.nombre = 'Aceite'
   and not exists (select 1 from public.receta_lineas l where l.id_receta = r.id and l.id_insumo = i.id);

-- ── 3. Una receta por SKU empaquetado ───────────────────────────────────────
-- Se GENERAN desde `productos`, no se transcriben: son 28 y transcribir 28 ids
-- a mano es 28 oportunidades de equivocarse. `kg_base` sale de los gramos de la
-- presentacion, que es exacto: una bolsa de 250 g lleva 250 g de base.
-- SIN LINEAS todavia: la bolsa no tiene precio conocido. Como `costo_sku` suma
-- las lineas con `coalesce(...,0)` y solo se cae si a una le FALTA el costo,
-- una receta sin lineas devuelve el costo de la base, que es justo el piso.
--  es NOT NULL tambien para un SKU: una receta de SKU rinde
-- UNA pieza, que es la unidad en la que se vende y en la que el disparador
-- guarda .
insert into public.recetas (tipo, id_producto, kg_base, rinde_cantidad, rinde_unidad, vigente_desde, activa, nota)
select 'sku', p.id, p.gramos / 1000.0, 1, 'pieza', current_date, true,
       'Generada de productos.gramos el 21 nov 2026. Sin bolsa ni etiqueta: no se sabe su precio.'
  from public.productos p
 where p.activo and p.gramos is not null and p.gramos > 0
   and not exists (select 1 from public.recetas r
                    where r.tipo = 'sku' and r.id_producto = p.id and r.vigente_desde = current_date);

-- ── 4. El granel se costea por lo que PESÓ, no por una receta fija ──────────
-- Una linea de granel lleva `cantidad = 1` y el peso real en `gramos_vendidos`
-- -comprobado en produccion: cinco lineas, todas con cantidad 1 y gramos de 136
-- a 1000-. Con una receta de `kg_base` fijo, 136 g y 1 kg costarian lo mismo.
-- El resto del disparador NO cambia: se copia tal cual del que esta en
-- produccion y solo se le anade la rama del granel, delante de las otras dos.
create or replace function public.trg_detalle_costear()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_fecha date;
  v_base  numeric;
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

  -- GRANEL: el peso manda. `cantidad` es 1 y los gramos van aparte, asi que el
  -- costo unitario ES el de esos gramos. No lleva bolsa, asi que es base pura.
  if coalesce(NEW.gramos_vendidos, 0) > 0 then
    v_base := public.costo_base_kg(v_fecha);
    if v_base is not null then
      NEW.costo_unitario := round(v_base * NEW.gramos_vendidos / 1000.0, 4);
    end if;
  elsif NEW.id_producto ~ '^[0-9]+$' then
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
