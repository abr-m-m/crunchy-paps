-- Reengancha los movimientos de caja que quedaron sin caja del dia.
--
-- Al 22 sep 2026, despues de que 20261005000000 abriera la caja de hoy, quedaban
-- **73 movimientos huerfanos** (id_caja_dia null) repartidos en **30 dias** y
-- **39 combinaciones (punto, fecha)**: 40 en punto_venta ($5,234.20) y 33 en
-- cuenta_banco ($6,160.00), del 8 jun al 19 sep 2026. Nacieron asi porque la
-- busqueda de caja es `fecha = CURRENT_DATE and estatus = 'abierta'` y desde el
-- 10 jun no habia ninguna.
--
-- ESTO NO CAMBIA NINGUN TOTAL QUE SE VEA EN PANTALLA: obtener_caja_dia y
-- obtener_cajas_vendedores suman por `id_punto` y `fecha::DATE`, no por
-- id_caja_dia. Lo unico que cambia es que esos 30 dias pasan a ser cerrables y
-- auditables, y que cerrar_caja_dia_interno (que si suma por id_caja_dia) deja
-- de ver esos dias vacios.
--
-- SOBRE LA CONVENCION «ledgers solo-INSERT»: CLAUDE.md dice que
-- caja_movimientos NUNCA se actualiza, y el paso 2 es un UPDATE sobre 73 filas.
-- Se hace a sabiendas y con el visto bueno de Abraham (22 sep 2026). La regla
-- protege el DINERO —monto, tipo, id_orden, fecha—, y nada de eso se toca;
-- id_caja_dia es un campo de enlace que el propio abrir_caja_dia_interno ya
-- actualiza cada vez que se abre una caja (adopta los huerfanos del dia). Esto
-- es esa misma adopcion, aplicada hacia atras.
--
-- ESTADO DE LAS CAJAS NUEVAS: **cerradas, con saldo_cierre_calculado lleno y
-- saldo_cierre_declarado en NULL** (decision de Abraham). Dice la verdad: se
-- reconstruyeron, nadie conto ese efectivo. Cerrarlas declarando lo mismo que el
-- calculo habria escrito que cuadraron sin que nadie las contara, que es justo lo
-- que se descarto al decidir que el cierre no se automatiza (20261005000000).
-- Y dejarlas abiertas habria dejado 38 dias historicos pendientes mezclados con
-- los dias de verdad.
--
-- `fecha_apertura` y `fecha_cierre` quedan en now(), no en la fecha historica: la
-- fila se escribio hoy y nadie abrio nada ese dia. Que `fecha` sea de junio y
-- `fecha_apertura` de septiembre es precisamente la señal de que es reconstruida;
-- las notas lo dicen. Tampoco se escribe el movimiento 'apertura' de 0 que
-- abrir_caja_dia_interno pondria: nadie abrio esa caja, y sumar 38 filas de 0 al
-- libro no aporta nada. Con saldo_apertura 0 y sin ese movimiento, el calculo
-- `saldo_apertura + sum(movimientos no-apertura)` da exactamente la suma del dia.
--
-- LA COLISION: `caja_dias` ya tenia una fila para (punto_venta, 9 jun) —la unica
-- caja que se abrio nunca, id 9, aun 'abierta', con $1,380 de apertura— y ese dia
-- tenia **4 huerfanos ($842)** que entraron DESPUES de abrirla, cuando la adopcion
-- ya habia ocurrido. Para esa no se crea nada: el paso 2 le engancha los 4 y la
-- caja se queda abierta, que es de Abraham. De ahi que se creen 38 y no 39.
--
-- IDEMPOTENTE por construccion: tras la primera corrida no quedan huerfanos, asi
-- que el INSERT no encuentra nada que crear y el UPDATE nada que enganchar.

-- 1. La caja que falta para cada (punto, día) con huérfanos. La del 9 jun no
--    entra aquí: ya existe.
insert into caja_dias (
  id_punto, fecha, saldo_apertura, estatus,
  saldo_cierre_calculado, saldo_cierre_declarado, diferencia,
  abierta_por, cerrada_por, fecha_cierre, notas_apertura, notas_cierre)
select x.id_punto, x.f, 0, 'cerrada',
       x.suma, null, null,
       'reenganche', 'reenganche', now(),
       'Caja reconstruida el 22 sep 2026 para enganchar los movimientos de ese día, que quedaron sueltos porque no había caja abierta.',
       'Cerrada sin saldo declarado: nadie contó el efectivo de ese día.'
  from (select m.id_punto, m.fecha::date as f, sum(m.monto) as suma
          from caja_movimientos m
         where m.id_caja_dia is null
         group by m.id_punto, m.fecha::date) x
 where not exists (
   select 1 from caja_dias d where d.id_punto = x.id_punto and d.fecha = x.f);

-- 2. Enganchar. Cubre también la caja del 9 jun, que ya existía.
update caja_movimientos m
   set id_caja_dia = d.id
  from caja_dias d
 where m.id_caja_dia is null
   and d.id_punto = m.id_punto
   and d.fecha = m.fecha::date;
