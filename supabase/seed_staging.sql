-- ============================================================================
--  SEED DE STAGING - Crunchy Paps
-- ----------------------------------------------------------------------------
--  Datos COMPLETAMENTE FICTICIOS. Ni un solo dato real de cliente.
--
--  NUNCA correr esto contra produccion. El bloque de guarda de abajo aborta
--  si no encuentra la tabla marcadora public._entorno con la fila 'staging',
--  que solo existe en el proyecto dkwatbsaidlfjqjnfyrk.
--
--  Volumenes elegidos A PROPOSITO por encima de produccion, para que los
--  hallazgos de escala dormidos (01, 03, 08) se vuelvan visibles:
--      clientes   300  (prod:   40)
--      prospectos 2000 (prod: 1132)
--      ordenes    800  (prod:   67)
--
--  Uso:  supabase db query --linked -f supabase/seed_staging.sql
-- ============================================================================

-- -- GUARDA --------------------------------------------------------------
do $guard$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = '_entorno'
  ) then
    raise exception 'ABORTADO: no existe public._entorno. Esta base NO es staging.';
  end if;

  if not exists (select 1 from public._entorno where nombre = 'staging') then
    raise exception 'ABORTADO: public._entorno no contiene la fila staging.';
  end if;

  raise notice 'Guarda OK: entorno staging confirmado.';
end
$guard$;

select setseed(0.42);

-- -- LIMPIEZA ------------------------------------------------------------
truncate table
  public.ordenes_detalle, public.ordenes, public.clientes, public.prospectos,
  public.vendedores, public.productos, public.productos_bebidas,
  public.lotes_produccion, public.caja_dias, public.caja_puntos
  restart identity cascade;

-- -- VENDEDORES (8, igual que produccion) --------------------------------
-- PIN de todos: 1234  (bcrypt real, para poder probar validar_vendedor_pin)
insert into public.vendedores (nombre, telefono, email, rol, activo, fecha_alta, pin_hash)
select
  n.nombre,
  '55000000' || lpad(n.i::text, 2, '0'),
  'vendedor' || n.i || '@ejemplo.invalid',
  case when n.i = 1 then 'Admin' when n.i = 2 then 'Mostrador' else 'Vendedor' end,
  n.i <> 8,
  date '2026-01-15' + (n.i * 7),
  extensions.crypt('1234', extensions.gen_salt('bf', 6))
from (values
  (1,'Ana Ficticia Robles'), (2,'Beto Prueba Lara'),   (3,'Carla Ejemplo Nieto'),
  (4,'Diego Muestra Vega'),  (5,'Elsa Simulada Cano'), (6,'Fausto Testigo Mora'),
  (7,'Gina Dummy Salas'),    (8,'Hugo Inactivo Ruiz')
) as n(i, nombre);

-- -- PRODUCTOS (12) ------------------------------------------------------
insert into public.productos
  (sabor, presentacion, gramos, precio_consumidor, precio_tienda, precio_restaurante,
   precio_mostrador, precio_granel_kg, tipo_venta, activo, orden, descripcion)
select
  p.sabor, p.pres, p.gr,
  p.base, round(p.base * 0.80, 2), round(p.base * 0.75, 2), round(p.base * 0.95, 2),
  round(p.base * 1000 / p.gr, 2),
  1, p.act, p.i,
  'Producto ficticio de staging'
from (values
  (1,'Natural','Bolsa 50g',    50,  35.00, true),
  (2,'Natural','Bolsa 100g',  100,  60.00, true),
  (3,'Natural','Bolsa 250g',  250, 135.00, true),
  (4,'Chile limon','Bolsa 50g',  50,  38.00, true),
  (5,'Chile limon','Bolsa 100g',100,  65.00, true),
  (6,'Chile limon','Bolsa 250g',250, 145.00, true),
  (7,'Habanero','Bolsa 50g',   50,  40.00, true),
  (8,'Habanero','Bolsa 100g', 100,  68.00, true),
  (9,'Queso','Bolsa 50g',      50,  39.00, true),
  (10,'Queso','Bolsa 100g',   100,  66.00, true),
  (11,'Mixto','Bolsa 500g',   500, 255.00, true),
  (12,'Descontinuado','Bolsa 50g', 50, 30.00, false)  -- se marca descontinuado abajo
) as p(i, sabor, pres, gr, base, act);

-- El producto 12 se llama "Descontinuado": que lo esté de verdad. Sirve de
-- fixture para comprobar que lo descontinuado NO llega al cliente, mientras que
-- lo agotado (activo=false, descontinuado=false) sí se ve como "No disponible".
update public.productos set descontinuado = true where sabor = 'Descontinuado';

-- -- PRODUCTOS BEBIDAS (6) -----------------------------------------------
insert into public.productos_bebidas
  (nombre, categoria, tipo_bebida, sabor, presentacion, precio, activo, orden, descripcion)
select b.nombre, 'Bebidas', b.tipo, b.sabor, b.pres, b.precio, true, b.i,
       'Bebida ficticia de staging'
from (values
  (1,'Agua natural 600ml','agua','Natural','600ml', 15.00),
  (2,'Refresco cola 355ml','refresco','Cola','355ml', 22.00),
  (3,'Refresco naranja 355ml','refresco','Naranja','355ml', 22.00),
  (4,'Agua mineral 355ml','agua','Mineral','355ml', 18.00),
  (5,'Jugo mango 250ml','jugo','Mango','250ml', 20.00),
  (6,'Cerveza clara 355ml','cerveza','Clara','355ml', 35.00)
) as b(i, nombre, tipo, sabor, pres, precio);

-- -- PUNTOS DE CAJA (3) --------------------------------------------------
insert into public.caja_puntos (codigo, nombre, tipo, fondo_minimo, activo, orden_display)
values ('CENTRAL','Caja Central (staging)','fijo',  1000, true, 1),
       ('MOSTRAD','Mostrador (staging)',   'fijo',   500, true, 2),
       ('RUTA01', 'Ruta 1 (staging)',      'movil',  300, true, 3);

-- -- CLIENTES (300) -----------------------------------------------------
insert into public.clientes
  (tipo, nombre, nombre_comercial, rfc, telefono, direccion, cp, colonia, municipio,
   estado, latitud, longitud, id_vendedor, vendedor, aprobado_b2b, acepta_promos, fecha_creacion)
select
  case when i % 5 = 0 then 'B2B' else 'Consumidor' end,
  'Cliente Ficticio ' || lpad(i::text, 3, '0'),
  case when i % 5 = 0 then 'Negocio Ficticio ' || lpad(i::text,3,'0') else null end,
  case when i % 5 = 0 then 'XAXX' || lpad(i::text, 6, '0') || 'X' else null end,
  '5510' || lpad(i::text, 6, '0'),
  'Calle Falsa ' || i || ', Int. ' || (i % 20 + 1),
  lpad((6000 + (i % 900))::text, 5, '0'),
  (array['Roma Norte','Condesa','Del Valle','Narvarte','Escandon','Doctores','Napoles'])[1 + i % 7],
  (array['Cuauhtemoc','Benito Juarez','Miguel Hidalgo','Coyoacan'])[1 + i % 4],
  'Ciudad de Mexico',
  round((19.30 + random() * 0.28)::numeric, 6),
  round((-99.22 + random() * 0.28)::numeric, 6),
  1 + (i % 7),
  (select v.nombre from public.vendedores v where v.id = 1 + (i % 7)),
  i % 5 = 0,
  i % 3 <> 0,
  now() - ((300 - i) || ' days')::interval
from generate_series(1, 300) as i;

-- -- PROSPECTOS (2000) --------------------------------------------------
insert into public.prospectos
  (nombre_negocio, tipo_negocio, contacto_nombre, contacto_telefono, email, direccion,
   colonia, codigo_postal, municipio, estado, latitud, longitud, score, estatus,
   id_vendedor, nombre_vendedor, num_visitas, origen, fecha_creacion)
select
  'Prospecto Ficticio ' || lpad(i::text, 4, '0'),
  (array['abarrotes','restaurante','cafeteria','bar','tienda','escuela'])[1 + i % 6],
  'Contacto Prueba ' || lpad(i::text, 4, '0'),
  '5520' || lpad(i::text, 6, '0'),
  'prospecto' || i || '@ejemplo.invalid',
  'Avenida Inventada ' || i,
  (array['Roma Norte','Condesa','Del Valle','Narvarte','Escandon','Doctores','Napoles'])[1 + i % 7],
  lpad((6000 + (i % 900))::text, 5, '0'),
  (array['Cuauhtemoc','Benito Juarez','Miguel Hidalgo','Coyoacan'])[1 + i % 4],
  'Ciudad de Mexico',
  round((19.30 + random() * 0.28)::numeric, 6),
  round((-99.22 + random() * 0.28)::numeric, 6),
  1 + (i % 100),
  (array['nuevo','contactado','visitado','descartado','convertido'])[1 + i % 5],
  1 + (i % 7),
  (select v.nombre from public.vendedores v where v.id = 1 + (i % 7)),
  i % 4,
  'staging-seed',
  now() - ((2000 - i) || ' hours')::interval
from generate_series(1, 2000) as i;

-- -- LOTES DE PRODUCCION (40) -------------------------------------------
-- kilos_disponibles es columna GENERADA: no se inserta, Postgres la calcula.
insert into public.lotes_produccion
  (id_lote, fecha, kilos_totales, kilos_vendidos, estatus, notas)
select
  'LOTE-STG-' || lpad(i::text, 4, '0'),
  current_date - (40 - i),
  k.total, k.vend,
  case when k.total - k.vend <= 0 then 'agotado' else 'activo' end,
  'Lote ficticio de staging'
from generate_series(1, 40) as i
cross join lateral (
  select 50.0::numeric as total, round((random() * 50)::numeric, 2) as vend
) as k;

-- -- DIAS DE CAJA (90 = 30 dias x 3 puntos) -----------------------------
insert into public.caja_dias
  (id_punto, fecha, saldo_apertura, saldo_cierre_declarado, saldo_cierre_calculado,
   diferencia, estatus, abierta_por, fecha_apertura)
select
  p.id,
  current_date - d,
  1000,
  1000 + round((random() * 5000)::numeric, 2),
  1000 + round((random() * 5000)::numeric, 2),
  0,
  case when d = 0 then 'abierta' else 'cerrada' end,
  'Ana Ficticia Robles',
  (current_date - d)::timestamptz + interval '8 hours'
from public.caja_puntos p
cross join generate_series(0, 29) as d;

-- -- ORDENES (800) ------------------------------------------------------
insert into public.ordenes
  (consecutivo, canal, id_cliente, nombre_cliente, id_vendedor, nombre_vendedor,
   fecha_orden, fecha_entrega, estatus_pedido, estatus_pago, subtotal, descuento, total,
   cp, colonia, municipio, estado, direccion, zona_entrega, tipo_pago, fecha_registro)
select
  'STG-' || lpad(i::text, 6, '0'),
  (array['web','tienda','mostrador','b2b','telefono'])[1 + i % 5],
  c.id, c.nombre,
  1 + (i % 7),
  (select v.nombre from public.vendedores v where v.id = 1 + (i % 7)),
  now() - ((800 - i) || ' hours')::interval,
  now() - ((800 - i) || ' hours')::interval + interval '2 days',
  (array['Pendiente','Entregado','Entregado','Entregado','Cancelado'])[1 + i % 5],
  (array['Pendiente','Pagado','Pagado','Pagado','Pendiente'])[1 + i % 5],
  0, 0, 0,
  c.cp, c.colonia, c.municipio, c.estado, c.direccion,
  'cdmx',
  (array['Efectivo','Tarjeta','Transferencia'])[1 + i % 3],
  now() - ((800 - i) || ' hours')::interval
from generate_series(1, 800) as i
join lateral (
  select cl.* from public.clientes cl where cl.id = 1 + (i % 300)
) as c on true;

-- -- DETALLE DE ORDENES (2400: 3 lineas por orden) ----------------------
insert into public.ordenes_detalle
  (id_orden, consecutivo_orden, id_producto, sabor, presentacion, tipo_venta,
   cantidad, gramos_vendidos, precio_unitario, descuento, subtotal, fecha, id_lote_descontado)
select
  o.id, o.consecutivo,
  pr.id::text, pr.sabor, pr.presentacion, 'pieza',
  q.cant, pr.gramos * q.cant, pr.precio_consumidor, 0,
  round(pr.precio_consumidor * q.cant, 2),
  o.fecha_orden,
  'LOTE-STG-' || lpad((1 + (o.id % 40))::text, 4, '0')
from public.ordenes o
cross join generate_series(1, 3) as linea
join lateral (
  select p.* from public.productos p
  where p.activo and p.id = 1 + ((o.id * 3 + linea) % 11)
) as pr on true
join lateral (select 1 + ((o.id + linea) % 4) as cant) as q on true;

-- -- RECALCULAR TOTALES DE ORDENES --------------------------------------
update public.ordenes o
set subtotal = t.suma,
    descuento = round(t.suma * (case when o.id % 10 = 0 then 0.10 else 0 end), 2),
    total     = t.suma - round(t.suma * (case when o.id % 10 = 0 then 0.10 else 0 end), 2)
from (select d.id_orden, sum(d.subtotal) as suma
      from public.ordenes_detalle d group by d.id_orden) t
where t.id_orden = o.id;

-- El vendedor 7 lleva un PIN de 6 digitos: desde 20260902010000 el minimo
-- son 6, asi que hace falta un fixture largo para probar el cambio de PIN.
-- Los otros siete conservan 1234 A PROPOSITO: reproducen los PIN de 4 digitos
-- que existen en produccion y comprueban que siguen sirviendo para entrar.
update public.vendedores
   set pin_hash = extensions.crypt('748261', extensions.gen_salt('bf', 6))
 where id = 7;

-- -- PERMISOS POR SECCION -----------------------------------------------
-- Copia de la configuracion REAL de produccion (30 ago 2026), para que las
-- pruebas de permisos midan el comportamiento de verdad y no un invento.
insert into public.config_secciones (rol, secciones) values
  ('administrador',  array['catalogo','pedidos','premia','b2b','produccion','prospeccion','caja','gastos','jornadas','productos','cupones','cuenta']),
  ('administrador2', array['catalogo','pedidos','premia','b2b','produccion','prospeccion','caja','gastos','jornadas','productos','cupones','cuenta']),
  ('consumidor',     array['catalogo','pedidos','premia','cuenta']),
  ('mostrador',      array['catalogo','pedidos','premia','b2b','produccion','caja','gastos','cuenta']),
  ('vendedor',       array['catalogo','pedidos','prospeccion','jornadas','cuenta'])
on conflict (rol) do update set secciones = excluded.secciones;

-- Perfiles de prueba. El vendedor 4 es un SOCIO con acceso PARCIAL a finanzas:
-- ve el dashboard y los gastos, pero NO los cobros. Es el escenario que motivo
-- todo este trabajo, asi que conviene que quede fijado en el seed.
update public.vendedores set rol = 'Administrador2',
       secciones = array['catalogo','pedidos','b2b','gastos','resumen','cuenta']
 where id = 4;
-- El vendedor 3 se queda sin override: usa las secciones de su rol.
update public.vendedores set secciones = null where id = 3;

-- -- RESUMEN ------------------------------------------------------------
select 'vendedores' as tabla, count(*) as filas from public.vendedores
union all select 'productos',         count(*) from public.productos
union all select 'productos_bebidas', count(*) from public.productos_bebidas
union all select 'caja_puntos',       count(*) from public.caja_puntos
union all select 'caja_dias',         count(*) from public.caja_dias
union all select 'clientes',          count(*) from public.clientes
union all select 'prospectos',        count(*) from public.prospectos
union all select 'lotes_produccion',  count(*) from public.lotes_produccion
union all select 'ordenes',           count(*) from public.ordenes
union all select 'ordenes_detalle',   count(*) from public.ordenes_detalle
order by 1;
