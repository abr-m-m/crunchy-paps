-- 20261020000000_cuentas.sql
-- El CRM comercial (cambios/2026-09-24-motor-comercial/diseno.md §A).
--
-- La etapa de una cuenta se CALCULA de los pedidos y las visitas, no se escribe (D7). Un estado
-- escrito a mano se desincroniza de los pedidos y nadie se entera: hoy 1,129 de 1,132 prospectos
-- dicen `pendiente` sin que nada lo haya comprobado. Con esto, si una tienda compra es cliente
-- aunque nadie toque un boton.
--
-- Prospectos y clientes siguen siendo DOS tablas (D2). Esto es una VISTA: no migra ni una fila, y
-- `crear_pedido`, `ruta_del_dia`, `reparto_del_dia` y el planeador siguen leyendo lo que leen hoy.

-- ── 0. La columna que la vista necesita (la llena la tarea 2) ────────────────
-- Cuantas piezas le quedan a la tienda en el anaquel. Es lo que el preventista mira de todos modos
-- para saber que reponer, y es la unica forma de distinguir «la tienda compro» de «la tienda
-- vendio». De ahi saldra la cadencia real que sustituya al supuesto de 21 dias (D8).
alter table public.visitas
  add column if not exists piezas_en_anaquel integer
    check (piezas_en_anaquel is null or piezas_en_anaquel >= 0);

-- ── 1. Los CP con apostrofo ─────────────────────────────────────────────────
-- Los 1,131 de 1,132 estan guardados como '08930, artefacto de importar desde Excel. HOY NO ROMPE
-- NADA porque `ruta_del_dia` limpia con regexp_replace al vuelo; el dato sucio es una trampa puesta
-- para la siguiente consulta que alguien escriba sin saberlo. Con el CP crudo, `ruta_para` manda el
-- 100 % de los prospectos FUERA DE RUTA; con el limpio reparte 382 / 356 / 352 y 42 fuera.
update public.prospectos
   set codigo_postal = nullif(regexp_replace(coalesce(codigo_postal, ''), '[^0-9]', '', 'g'), '')
 where codigo_postal ~ '[^0-9]';

create or replace function public.trg_prospecto_limpiar_cp()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  NEW.codigo_postal := nullif(regexp_replace(coalesce(NEW.codigo_postal, ''), '[^0-9]', '', 'g'), '');
  return NEW;
end $$;

drop trigger if exists trg_prospecto_limpiar_cp on public.prospectos;
create trigger trg_prospecto_limpiar_cp
  before insert or update of codigo_postal on public.prospectos
  for each row execute function public.trg_prospecto_limpiar_cp();

revoke all on function public.trg_prospecto_limpiar_cp() from public;

-- ── 2. El CHECK que faltaba ─────────────────────────────────────────────────
-- `estatus` era texto libre. Se restringe a lo que YA esta en uso mas los dos estados que son
-- decision humana. La etapa del CRM va aparte y se calcula: esta columna NO es la etapa.
update public.prospectos set estatus = 'pendiente'
 where estatus is null
    or estatus not in ('pendiente','contactado','sampling','descartado','convertido');

alter table public.prospectos drop constraint if exists prospectos_estatus_chk;
alter table public.prospectos
  add constraint prospectos_estatus_chk
  check (estatus in ('pendiente','contactado','sampling','descartado','convertido'));

-- ── 3. La vista de cuentas ──────────────────────────────────────────────────
create or replace view public.cuentas as
with ped as (
  select o.id_cliente,
         count(*)                as pedidos,
         max(o.fecha_orden)::date as ultimo_pedido
    from public.ordenes o
   where coalesce(o.tipo_interno, '') = '' and o.estatus_pedido <> 'Cancelado'
     and o.id_cliente is not null and o.id_cliente <> 999999
   group by o.id_cliente),
vis_p as (
  select distinct on (v.id_prospecto)
         v.id_prospecto, v.resultado, v.creada_en, v.piezas_en_anaquel
    from public.visitas v where v.id_prospecto is not null
   order by v.id_prospecto, v.creada_en desc),
vis_c as (
  select distinct on (v.id_cliente)
         v.id_cliente, v.resultado, v.creada_en, v.piezas_en_anaquel
    from public.visitas v where v.id_cliente is not null
   order by v.id_cliente, v.creada_en desc)
select 'p' || p.id                as id_cuenta,
       'prospecto'::text          as origen,
       p.id                       as id_origen,
       p.nombre_negocio           as nombre,
       public.ruta_para(p.codigo_postal, p.colonia) as id_ruta,
       p.id_vendedor,
       coalesce(p.score, 0)::int  as score,
       vp.creada_en               as ultima_visita,
       vp.piezas_en_anaquel,
       null::date                 as ultimo_pedido,
       null::int                  as dias_sin_comprar,
       0::bigint                  as pedidos,
       case when vp.resultado in ('no_le_interesa','ya_no_existe') then 'descartado'
            when vp.resultado = 'sampling'   then 'muestra'
            when vp.resultado = 'interesado' then 'interesado'
            when vp.creada_en is not null    then 'contactado'
            else 'pendiente' end  as etapa
  from public.prospectos p
  left join vis_p vp on vp.id_prospecto = p.id
union all
select 'c' || c.id,
       'cliente'::text,
       c.id,
       coalesce(nullif(c.nombre_comercial, ''), nullif(c.nombre, ''), 'Sin nombre'),
       c.id_ruta,
       c.id_vendedor,
       0::int,
       vc.creada_en,
       vc.piezas_en_anaquel,
       pe.ultimo_pedido,
       case when pe.ultimo_pedido is null then null
            else (current_date - pe.ultimo_pedido)::int end,
       coalesce(pe.pedidos, 0),
       -- El orden de precedencia es el de §A y NO es arbitrario: descartado gana a todo, y
       -- `dormido` gana a `activo` porque lo que importa de una tienda que compro dos veces y
       -- lleva un mes callada es que esta callada. Los 21 dias son un supuesto DECLARADO (D8):
       -- hoy no hay dato de recompra porque cero tiendas han repetido.
       case when vc.resultado in ('no_le_interesa','ya_no_existe') then 'descartado'
            when pe.ultimo_pedido is not null and pe.ultimo_pedido < current_date - 21 then 'dormido'
            when coalesce(pe.pedidos, 0) >= 2 then 'activo'
            when coalesce(pe.pedidos, 0) = 1  then 'cliente'
            when vc.resultado = 'sampling'    then 'muestra'
            when vc.resultado = 'interesado'  then 'interesado'
            when vc.creada_en is not null     then 'contactado'
            else 'pendiente' end
  from public.clientes c
  left join vis_c vc on vc.id_cliente = c.id
  left join ped   pe on pe.id_cliente = c.id;

comment on view public.cuentas is
  'Prospectos y clientes en una sola lista, con la etapa CALCULADA de los pedidos y las visitas '
  '(diseno §A, D7). No se escribe: un UPDATE aqui no significa nada. Las dos tablas de origen '
  'siguen siendo las de siempre.';
