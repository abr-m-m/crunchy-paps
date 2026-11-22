-- ============================================================================
--  EL COSTO COMPLETO: bolsa, etiqueta y mano de obra
--
--  Diseno: cambios/2026-11-21-frente-a-costos.md
--
--  DE DONDE SALEN ESTOS NUMEROS. De ningun sitio nuevo: los dijo Abraham el
--  25 oct 2026 y llevan un mes escritos en `historico/modelo.py`, con su nota
--  y su procedencia. El 21 nov se los iba a volver a preguntar -segunda vez en
--  el mismo dia que pido un dato que ya estaba transcrito-.
--
--    Bolsa de celofan : «el 100 g no pasa de $1; el 250 g, 500 g y 1 kg no
--                        pasan de $2.50». Es un TECHO declarado, no una medida:
--                        el cuaderno no trae ningun precio por bolsa.
--    Etiqueta         : el ticket de impresion cobra por TABLOIDE ($11) y cada
--                        uno trae ~20 etiquetas de 100 g -> $0.55 por pieza.
--    Mano de obra     : $350 por dia trabajado, «lo que ganaba Daniela por dia
--                        de freir», mas 1 dia de embolsado por dia de freido.
--
--  POR QUE LA MANO DE OBRA ES UN INSUMO POR DIA Y NO UN COSTO POR KILO. Porque
--  el precio es un hecho ($350 el dia) y la cantidad es una DECISION (cuantos
--  dias lleva una tanda). Separarlos deja que subir el sueldo sea un precio
--  nuevo y cambiar la forma de trabajar sea una linea de receta -y que las dos
--  cosas se vean distintas en el desglose-.
--
--  EL LEVER QUE HAY QUE VER: la receta lleva 2 dias por tanda, 1 de freir y 1
--  de embolsar, que es el default del modelo. Si se embolsa el mismo dia, es 1
--  y la mano de obra por kilo se parte a la mitad ($46.60 -> $23.30). No se
--  esconde dentro de un numero: es una linea de receta que se edita.
--
--  POR QUE SE FECHAN EN ENERO. Porque son costos ESTRUCTURALES que existieron
--  todo el tiempo: la papa se embolso y alguien la frio tambien en febrero.
--  Fecharlos hoy dejaria el pasado costeado a medias, que es justo lo que este
--  frente vino a arreglar. Van como `reconstruido`, que es lo que son.
--
--  EL GRANEL NO LLEVA NINGUNO DE LOS DOS DE EMPAQUE, y es correcto: no hay
--  bolsa ni etiqueta. Si lleva mano de obra, porque se frio.
--
--  LA BOLSA SE SACA DEL TAMANO QUE DICE LA RECETA, no de una lista de cuatro
--  tamanos escrita a mano. El primer intento la escribio a mano y staging
--  -que tiene una presentacion de 50 g que produccion no tiene- dejo CUATRO
--  recetas sin bolsa EN SILENCIO: el `case` devolvia null, el join las tiraba,
--  y su costo quedaba sin empaque sin que nada avisara. Ahora se crea una
--  bolsa por cada tamano que de verdad existe, y al final un bloque COMPRUEBA
--  que ninguna receta activa quedo sin bolsa o sin etiqueta: si falta una, la
--  migracion revienta y no se aplica a medias.
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

-- ── Como se llama la bolsa de un tamano ─────────────────────────────────────
-- Una sola definicion, usada por los inserts de abajo: si el nombre se arma en
-- cada sitio, un dia dos sitios no coinciden y aparece una bolsa duplicada o
-- una receta sin empaque.
create or replace function public.nombre_bolsa(p_kg numeric)
returns text language sql immutable set search_path = pg_temp as $fn$
  select case when p_kg is null then null
              when p_kg >= 1 then 'Bolsa celofán ' || trim(to_char(p_kg, 'FM999990.99')) || 'kg'
              else 'Bolsa celofán ' || trim(to_char(p_kg * 1000, 'FM999990')) || 'g' end;
$fn$;

-- Regla 42: una funcion nueva concede EXECUTE a PUBLIC por defecto. Esta no
-- expone nada -recibe un numero, devuelve un texto- pero la regla no se aplica
-- segun lo grave que parezca cada caso, o deja de aplicarse.
revoke all on function public.nombre_bolsa(numeric) from public, anon, authenticated;
grant execute on function public.nombre_bolsa(numeric) to service_role;

-- ── Los insumos que faltaban ────────────────────────────────────────────────
-- Que algo sea un insumo es una DECISION, y se toma aqui, no la toma el agente
-- al leer un ticket (regla del ticket: no crea catalogo).
insert into public.insumos (nombre, unidad, activo, tipo)
select v.nombre, v.unidad, true, v.tipo
  from (values
    ('Etiqueta',     'pieza',         'empaque'),
    ('Mano de obra', 'día trabajado', 'servicio')
  ) as v(nombre, unidad, tipo)
 where not exists (select 1 from public.insumos i where i.nombre = v.nombre);

-- Una bolsa por cada tamano que EXISTE en las recetas activas.
insert into public.insumos (nombre, unidad, activo, tipo)
select distinct public.nombre_bolsa(r.kg_base), 'pieza', true, 'empaque'
  from public.recetas r
 where r.tipo = 'sku' and r.activa and r.id_producto is not null
   and r.kg_base is not null
   and not exists (select 1 from public.insumos i
                    where i.nombre = public.nombre_bolsa(r.kg_base));

-- ── Sus precios, fechados en enero y marcados como lo que son ───────────────
insert into public.insumos_costos (id_insumo, costo_unidad, vigente_desde, fuente, nota)
select i.id, v.costo, '2026-01-09'::date, 'reconstruido', v.nota
  from (values
    ('Etiqueta',     0.55,
     'Del ticket de impresión: cobra por TABLOIDE ($11) y cada uno trae ~20 etiquetas de 100 g. Una etiqueta grande probablemente cuesta más: hueco conocido.'),
    ('Mano de obra', 350.00,
     'Abraham, 25 oct 2026: $350 por día trabajado, «lo que ganaba Daniela por día de freír».')
  ) as v(nombre, costo, nota)
  join public.insumos i on i.nombre = v.nombre
 where not exists (select 1 from public.insumos_costos c
                    where c.id_insumo = i.id and c.vigente_desde = '2026-01-09'::date);

-- El precio de la bolsa sale de las DOS frases de Abraham del 25 oct 2026:
-- hasta 100 g no pasa de $1; por encima, no pasa de $2.50. Un tamano que el no
-- nombro -los 50 g de staging- hereda el tramo que le toca, y su nota lo DICE,
-- para que nadie lo lea como un precio dicho.
insert into public.insumos_costos (id_insumo, costo_unidad, vigente_desde, fuente, nota)
select distinct i.id,
       case when r.kg_base <= 0.10 then 1.00 else 2.50 end,
       '2026-01-09'::date, 'reconstruido',
       'Abraham, 25 oct 2026: «el 100 g no pasa de $1; el 250 g, 500 g y 1 kg no pasan de $2.50». TECHO declarado, no medido: el cuaderno no trae ningún precio por bolsa.'
       || case when r.kg_base not in (0.10, 0.25, 0.50, 1.00)
               then ' Este tamaño NO lo nombró: hereda el tramo que le toca.' else '' end
  from public.recetas r
  join public.insumos i on i.nombre = public.nombre_bolsa(r.kg_base)
 where r.tipo = 'sku' and r.activa and r.id_producto is not null and r.kg_base is not null
   and not exists (select 1 from public.insumos_costos c
                    where c.id_insumo = i.id and c.vigente_desde = '2026-01-09'::date);

-- ── La mano de obra entra en la receta BASE, por tanda ──────────────────────
-- Ahi es donde pertenece: se paga por producir kilos, no por empaquetar un SKU
-- concreto, y asi la heredan todas las presentaciones Y el granel.
insert into public.receta_lineas (id_receta, id_insumo, cantidad, unidad)
select r.id, i.id, 2, 'día trabajado'
  from public.recetas r
  join public.insumos i on i.nombre = 'Mano de obra'
 where r.tipo = 'base' and r.activa
   and not exists (select 1 from public.receta_lineas rl
                    where rl.id_receta = r.id and rl.id_insumo = i.id);

-- ── La bolsa de SU tamano y la etiqueta, en cada receta de SKU ──────────────
insert into public.receta_lineas (id_receta, id_insumo, cantidad, unidad)
select r.id, i.id, 1, 'pieza'
  from public.recetas r
  join public.insumos i on i.nombre = public.nombre_bolsa(r.kg_base)
 where r.tipo = 'sku' and r.activa and r.id_producto is not null and r.kg_base is not null
   and not exists (select 1 from public.receta_lineas rl
                    where rl.id_receta = r.id and rl.id_insumo = i.id);

insert into public.receta_lineas (id_receta, id_insumo, cantidad, unidad)
select r.id, i.id, 1, 'pieza'
  from public.recetas r
  join public.insumos i on i.nombre = 'Etiqueta'
 where r.tipo = 'sku' and r.activa and r.id_producto is not null
   and not exists (select 1 from public.receta_lineas rl
                    where rl.id_receta = r.id and rl.id_insumo = i.id);

-- ── LA COMPROBACION, que es la razon de que esto no pueda fallar callado ────
do $cmp$
declare
  v_sin_bolsa int;
  v_sin_etiq  int;
  v_sin_costo int;
begin
  select count(*) into v_sin_bolsa from public.recetas r
   where r.tipo = 'sku' and r.activa and r.id_producto is not null
     and not exists (select 1 from public.receta_lineas rl
                       join public.insumos i on i.id = rl.id_insumo
                      where rl.id_receta = r.id and i.nombre like 'Bolsa celof%');

  select count(*) into v_sin_etiq from public.recetas r
   where r.tipo = 'sku' and r.activa and r.id_producto is not null
     and not exists (select 1 from public.receta_lineas rl
                       join public.insumos i on i.id = rl.id_insumo
                      where rl.id_receta = r.id and i.nombre = 'Etiqueta');

  select count(*) into v_sin_costo from public.recetas r
   where r.tipo = 'sku' and r.activa and r.id_producto is not null
     and public.costo_sku(r.id_producto, current_date) is null;

  if v_sin_bolsa > 0 or v_sin_etiq > 0 or v_sin_costo > 0 then
    raise exception 'Empaque incompleto: % recetas sin bolsa, % sin etiqueta, % SKU que dejaron de costear. La migracion no se aplica a medias.',
      v_sin_bolsa, v_sin_etiq, v_sin_costo;
  end if;
end $cmp$;
