-- ============================================================================
--  Un area GENERAL, para lo que es de todos
--
--  Diseno: cambios/2026-11-21-capturar-el-gasto.md
--
--  LO PIDIO UN TICKET DE VERDAD. El 21 nov 2026, el primero que el agente leyo
--  por WhatsApp fue de productos de limpieza -cloro, fabuloso, escobas, $1,122
--  de Sergio Gallegos-. Abraham: «En el caso de productos de limpieza no
--  estaria asociado a un area en particular. Hagamos un area de limpieza.»
--
--  Y NO SE HIZO ASI, por una razon: «Limpieza» no es un area del negocio, es
--  lo que se compro. Las areas contestan DE QUIEN ES EL COSTO, y por eso
--  sirven para sacar el margen por ruta. Metida ahi, el dia que se compre
--  cloro para la cocina y jabon para la oficina vuelve a haber un costo que no
--  es de nadie, solo que con nombre propio.
--
--  Lo que faltaba eran DOS cosas distintas:
--    * una CATEGORIA «Limpieza» -el cloro caia en «Otros», que no dice nada-.
--      Esa no necesita migracion: `categoria` es texto libre y vive en las
--      listas de la pantalla y de la herramienta del agente.
--    * y esta area, **General**: lo que sirve a todo el negocio y no a una
--      parte. Limpieza, renta, luz, internet, contabilidad. En contabilidad
--      tiene nombre -gastos indirectos- y existe justo porque hay costos que
--      no son de un area.
--
--  LA DIFERENCIA CON DEJARLO VACIO, que es la razon de que sea un valor y no
--  un hueco: «General» AFIRMA que el costo es de todos. Un `area` en null solo
--  dice que nadie lo clasifico. Al sacar el margen por ruta, lo primero se
--  excluye o se prorratea a proposito; lo segundo se cuela.
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

alter table public.gastos drop constraint if exists gastos_area_valida;

alter table public.gastos
  add constraint gastos_area_valida check (
    area is null or area in
      ('Producción', 'Reparto', 'Preventa', 'Administración', 'Marketing', 'General')
  );

create or replace function public.gasto_area_normal(p_area text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  -- `translate` y no `unaccent`: la extension no esta instalada en este
  -- proyecto -comprobado, no supuesto- y una funcion nueva no es el sitio
  -- para pedir una extension nueva.
  select case translate(lower(trim(coalesce(p_area, ''))),
                        'áéíóúüñ', 'aeiouun')
    when 'produccion'     then 'Producción'
    when 'reparto'        then 'Reparto'
    when 'preventa'       then 'Preventa'
    when 'administracion' then 'Administración'
    when 'admin'          then 'Administración'
    when 'marketing'      then 'Marketing'
    when 'mercadotecnia'  then 'Marketing'
    when 'general'        then 'General'
    -- «Limpieza» llega aqui porque es lo que Abraham pidio primero y es lo que
    -- el agente puede mandar si alguien se lo dice asi. Se traduce a General
    -- en vez de rechazarse: el costo de limpieza ES de todo el negocio, y
    -- perder el gasto por una palabra seria peor que clasificarlo bien.
    when 'limpieza'       then 'General'
    when 'indirectos'     then 'General'
    when 'todos'          then 'General'
    else null
  end;
$$;

revoke all on function public.gasto_area_normal(text) from public, anon, authenticated;
grant execute on function public.gasto_area_normal(text) to service_role, authenticated;
