-- ════════════════════════════════════════════════════════════════════════════
--  CERRAR LA REVISION DE RLS — quitar las dos cerraduras que sobran
--  23 nov 2026. Era la pieza del mapa que llevaba meses al 80 %.
--
--  LO QUE SE MIDIO EN PRODUCCION ANTES DE TOCAR NADA, y lo que NO era:
--
--    · 54 de 54 tablas con RLS activa. Ninguna sin ella.
--    · 43 funciones `security definer` con `search_path` mutable, 12
--      alcanzables por `anon`. SUENA a escalada (regla 43), pero la consulta
--      que podia refutarlo dice que no: `anon` no tiene CREATE en `public`,
--      no puede crear esquemas, y su `search_path` de rol no se toca. Es
--      ENDURECIMIENTO, no un agujero. Se dice asi y no mas: este proyecto ya
--      pago 25 dias de alarma de seguridad infundada.
--    · Las politicas `using (true)` sobre ordenes, prospectos, gastos... NO
--      abren nada: `anon` no tiene GRANT sobre esas tablas. Dos cerraduras, y
--      aguanta la otra (regla 41).
--
--  LO QUE SI ES UN ARMA CARGADA, que es distinto de un agujero:
--
--    40 tablas conceden SELECT/INSERT/UPDATE/DELETE al rol `authenticated`,
--    y 24 politicas dicen `using (true)`. Hoy no pasa nada porque
--    `auth.users` esta VACIA: nadie puede ser `authenticated`. El dia que se
--    encienda Supabase Auth -o que alguien emita un JWT- las dos cosas se
--    juntan y 40 tablas quedan abiertas de par en par, incluidas `ordenes`,
--    `clientes` y `caja_movimientos`. Ninguna de las dos es peligrosa sola.
--    Por eso se quitan las dos.
--
--  LO QUE LA APP NECESITA DE VERDAD, medido en el codigo: solo lee directo
--  `productos`, `productos_bebidas` y `vista_inventario`. TODO lo demas pasa
--  por RPC `security definer`, que no mira las politicas. Asi que quitar esto
--  no deja a la app sin nada — y se comprueba abriendo la app, no leyendo.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Las politicas `using (true)` ─────────────────────────────────────────
-- Una politica PERMISIVA se combina con OR (regla 40): basta UNA que diga
-- `true` para que la tabla quede abierta a quien tenga el GRANT. Dejarlas
-- puestas «porque el GRANT las tapa» es confiar en una sola cerradura.
drop policy if exists "Autenticados leen todos los cupones" on public.cupones;
drop policy if exists "Autenticados modifican cupones"      on public.cupones;
drop policy if exists "gastos_escritura"                    on public.gastos;
drop policy if exists "gastos_lectura"                      on public.gastos;
drop policy if exists "gas_ins_escritura"                   on public.gastos_insumos;
drop policy if exists "gas_ins_lectura"                     on public.gastos_insumos;
drop policy if exists "Jornadas escritura"                  on public.jornadas;
drop policy if exists "Jornadas lectura"                    on public.jornadas;
drop policy if exists "lotes_escritura"                     on public.lotes_produccion;
drop policy if exists "lotes_lectura"                       on public.lotes_produccion;
drop policy if exists "Ordenes escritura"                   on public.ordenes;
drop policy if exists "Ordenes lectura"                     on public.ordenes;
drop policy if exists "Detalle escritura"                   on public.ordenes_detalle;
drop policy if exists "Detalle lectura"                     on public.ordenes_detalle;
drop policy if exists "prod_escritura"                      on public.produccion_diaria;
drop policy if exists "prod_lectura"                        on public.produccion_diaria;
drop policy if exists "Prospectos escritura"                on public.prospectos;
drop policy if exists "Prospectos lectura autenticados"     on public.prospectos;
drop policy if exists "stock_terminado_escritura"           on public.stock_terminado;
drop policy if exists "stock_terminado_lectura"             on public.stock_terminado;
-- En productos y bebidas se quitan SOLO las de `true`. La del catalogo
-- publico -`descontinuado = false`- se queda: es la que deja que la app lea
-- el catalogo sin sesion, y es lo UNICO que lee directo.
drop policy if exists "Autenticados leen todo en productos" on public.productos;
drop policy if exists "Autenticados modifican productos"    on public.productos;
drop policy if exists "Autenticados leen todo"              on public.productos_bebidas;
drop policy if exists "Autenticados pueden modificar"       on public.productos_bebidas;

-- ── 2. Los GRANT que sobran ─────────────────────────────────────────────────
-- Seis tablas conceden CRUD completo a `anon` desde que nacieron. Hoy no
-- entra nadie porque tienen RLS con CERO politicas, pero es la misma apuesta a
-- una sola cerradura.
revoke all on public.encuestas            from anon;
revoke all on public.eventos_navegacion   from anon;
revoke all on public.gastos_categorias    from anon;
revoke all on public.insumos_costos       from anon;
revoke all on public.receta_lineas        from anon;
revoke all on public.recetas              from anon;

-- Y el rol `authenticated`, que hoy no lo usa nadie (auth.users esta vacia).
-- Se le quita el CRUD de todas las tablas de `public` menos las tres que la
-- app lee directo. Si algun dia se enciende Supabase Auth, que haya que
-- CONCEDER a mano lo que se necesite, no que ya este concedido todo.
do $$
declare r record;
begin
  for r in
    select distinct table_name
      from information_schema.role_table_grants
     where table_schema = 'public' and grantee = 'authenticated'
       and privilege_type in ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE')
       and table_name not in ('productos', 'productos_bebidas', 'premios')
  loop
    execute format('revoke select, insert, update, delete, truncate on public.%I from authenticated', r.table_name);
  end loop;
end $$;

-- `anon` conserva SELECT solo donde la app lo necesita de verdad.
grant select on public.productos         to anon, authenticated;
grant select on public.productos_bebidas to anon, authenticated;
grant select on public.premios           to anon, authenticated;
grant select on public.vista_inventario  to anon, authenticated;

-- ── 3. El `search_path` de las `security definer` ───────────────────────────
-- No es un agujero hoy -ver arriba- pero es gratis cerrarlo, y deja de
-- depender de que `anon` nunca pueda crear objetos. Se hace por REGLA y no
-- con una lista de 43 nombres: una lista se queda vieja en cuanto alguien
-- escribe la funcion 44.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
       and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) x
                        where x like 'search_path=%')
  loop
    execute format('alter function %s set search_path = public, extensions, pg_temp', r.sig);
  end loop;
end $$;
