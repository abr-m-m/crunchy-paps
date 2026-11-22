-- ============================================================================
--  El costeo, con los 35 tickets de compra que ya estaban transcritos
--
--  Diseno: cambios/2026-11-21-frente-a-costos.md
--
--  ESTA MIGRACION CORRIGE A `20261121000004_costeo_siembra.sql`, QUE ESTABA MAL.
--
--  Aquella sembro el costeo con un solo precio dicho de palabra -la papa a $23-
--  despues de concluir que el costo historico "no existia". Esa conclusion era
--  FALSA y salio de mirar en un solo sitio: se busco en `historico.hechos` y no
--  estaba. Si estaba, en `historico/tickets/tickets.ndjson`: **35 renglones
--  transcritos y validados el 25 oct 2026**, de `material/Fotos
--  crunchy-insumos-produccion/`, cuyo propio documento decia «Nada en base de
--  datos todavia». Se leyo «no esta en la base» como «no existe».
--
--  Lo encontro Abraham: «Antes de construir a ciegas asegurate que tenemos la
--  informacion de lo ya construido completa.»
--
--  QUE CAMBIA, Y NO ES POCO:
--
--  1. EL PRECIO DE LA PAPA VA FECHADO, no es un punto. Los 22 tickets dicen que
--     se movio **3.6 veces**: $10.00 el 2 feb 2026 y $36.00 el 31 may. Costear
--     con una media reparte mal el costo entre meses que difieren asi. Por eso
--     `insumos_costos` tiene `vigente_desde` — y ahora se usa de verdad.
--
--  2. EL RENDIMIENTO ES 15.02 kg POR COSTAL DE 60 kg (25.0 por ciento), MEDIDO sobre 9
--     jornadas y confirmado por tres caminos independientes. Era lo unico que
--     el cuaderno no podia dar, y estaba resuelto desde el 25 oct. Antes se uso
--     14.5 de memoria.
--
--  3. ENTRAN EL GAS Y «OTROS». Del modelo de punto de equilibrio: 200 L de
--     aceite y $4,500 de gas para 367.5 kg de producto en el periodo del
--     cuaderno; $3.24/kg de sal, limpieza y fumigacion. Faltaban los tres.
--
--  EL NUMERO ERA 23 por ciento MAS BARATO DE LO QUE DEBIA. Con la papa a $23: antes
--  $103.79 por kilo de base; ahora ~$128. Un margen inflado 23 por ciento en una
--  decision de precio no es un detalle de precision: es la diferencia entre
--  cobrar bien y regalar.
--
--  Y LO QUE DE VERDAD IMPORTA, que estaba escrito desde octubre y no se leyo:
--  **el margen del canal tienda se comprimio de 71 a 34 por ciento** entre jun 2025 y
--  jun 2026, solo por la papa, antes de aceite, gas, bolsas y trabajo. El canal
--  tienda es el de volumen.
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

-- ── 1. Los insumos que faltaban ─────────────────────────────────────────────
insert into public.insumos (nombre, unidad, unidad_compra, activo, tipo)
select v.nombre, v.unidad, v.unidad, true, v.tipo
  from (values ('Gas', 'L', 'materia_prima'),
               ('Otros insumos', 'kg producto', 'materia_prima')) v(nombre, unidad, tipo)
 where not exists (select 1 from public.insumos i where i.nombre = v.nombre);

-- La unidad del aceite pasa a decir su tamano: los tickets son de bidon de 20 L
-- y sin eso nadie puede convertir a litros mas adelante.
update public.insumos set unidad = 'bidón 20L', unidad_compra = 'bidón 20L'
 where nombre = 'Aceite' and unidad <> 'bidón 20L';

-- ── 2. LA SERIE DE PRECIOS, de los tickets ──────────────────────────────────
-- Ni un precio tecleado: todos salen de `historico/tickets/tickets.ndjson`, que
-- cuadra al centavo ticket por ticket. Cada fila lleva su nota con el archivo
-- de la foto y el proveedor, para que se pueda volver al papel.
insert into public.insumos_costos (id_insumo, costo_unidad, vigente_desde, fuente, nota)
  select i.id, 698.0000, '2025-07-27'::date, 'capturado', 'Ticket A6.jpeg, Corporativo Comercial Los Anicetos, Central de Abasto, pedido 264016.' from public.insumos i where i.nombre = 'Aceite'
union all
  select i.id, 671.0000, '2025-08-31'::date, 'capturado', 'Ticket A8.jpeg, Corporativo Comercial Los Anicetos, Central de Abasto, pedido 266208.' from public.insumos i where i.nombre = 'Aceite'
union all
  select i.id, 726.0000, '2026-02-02'::date, 'capturado', 'Ticket A2.jpeg, Grupo Zorro Abarrotero (El Cazador), Central de Abastos, ticket 00100049.' from public.insumos i where i.nombre = 'Aceite'
union all
  select i.id, 700.5000, '2026-02-22'::date, 'capturado', 'Ticket A3.jpeg, Corporativo Comercial Los Anicetos, Central de Abasto, pedido 278016.' from public.insumos i where i.nombre = 'Aceite'
union all
  select i.id, 700.5000, '2026-03-08'::date, 'capturado', 'Ticket A7.jpeg, Corporativo Comercial Los Anicetos, Central de Abasto, pedido 278953.' from public.insumos i where i.nombre = 'Aceite'
union all
  select i.id, 721.5000, '2026-04-12'::date, 'capturado', 'Ticket A4.jpeg, Corporativo Comercial Los Anicetos, Central de Abasto, pedido 280864.' from public.insumos i where i.nombre = 'Aceite'
union all
  select i.id, 860.4000, '2026-05-25'::date, 'capturado', 'Ticket A1.jpeg, Grupo Zorro Abarrotero, ticket 00503006.' from public.insumos i where i.nombre = 'Aceite'
union all
  select i.id, 723.5000, '2026-06-21'::date, 'capturado', 'Ticket A5.jpeg, Corporativo Comercial Los Anicetos (H62), Central de Abasto, pedido 779077.' from public.insumos i where i.nombre = 'Aceite'
union all
  select i.id, 10.6400, '2025-04-09'::date, 'capturado', 'Ticket G1.jpeg, Global Gas / G.G. Gas (Hidrogas), remision 5996874.' from public.insumos i where i.nombre = 'Gas'
union all
  select i.id, 10.6400, '2025-05-29'::date, 'capturado', 'Ticket G2.jpeg, Gas Metropolitano / Hidrogas, pedido 4843000.' from public.insumos i where i.nombre = 'Gas'
union all
  select i.id, 10.5899, '2025-06-14'::date, 'capturado', 'Ticket G3.jpeg, Regio Gas, Planta Santa Clara, Ecatepec, nota 101022502313.' from public.insumos i where i.nombre = 'Gas'
union all
  select i.id, 22.0000, '2024-08-03'::date, 'capturado', 'Ticket P4.jpeg, Casa Caballero U-129, Central de Abasto CDMX, ticket 12547.' from public.insumos i where i.nombre = 'Papa'
union all
  select i.id, 24.0000, '2024-08-24'::date, 'capturado', 'Ticket P8.jpeg, Casa Caballero U-129, Central de Abasto CDMX, ticket 13795.' from public.insumos i where i.nombre = 'Papa'
union all
  select i.id, 13.0000, '2025-06-01'::date, 'capturado', 'Ticket P1.jpeg, Casa Caballero U-129, Central de Abasto CDMX, nota 5266.' from public.insumos i where i.nombre = 'Papa'
union all
  select i.id, 14.0000, '2025-06-15'::date, 'capturado', 'Promedio por peso de 2 tickets del mismo dia (P7.jpeg, P7.jpeg): 70 kg a $18 y 140 kg a $12. Calidades distintas en el mismo viaje.' from public.insumos i where i.nombre = 'Papa'
union all
  select i.id, 13.0000, '2025-07-01'::date, 'capturado', 'Ticket P2.jpeg, Casa Caballero U-129, Central de Abasto CDMX, nota 4252.' from public.insumos i where i.nombre = 'Papa'
union all
  select i.id, 15.0000, '2025-07-06'::date, 'capturado', 'Ticket P6.jpeg, Casa Caballero U-129, Central de Abasto CDMX, ticket 35294.' from public.insumos i where i.nombre = 'Papa'
union all
  select i.id, 15.5000, '2025-07-27'::date, 'capturado', 'Ticket P5.jpeg, Casa Caballero U-129, Central de Abasto CDMX, ticket 36905.' from public.insumos i where i.nombre = 'Papa'
union all
  select i.id, 15.0000, '2025-08-17'::date, 'capturado', 'Ticket P3.jpeg, Casa Caballero U-129, Central de Abasto CDMX, ticket 38533.' from public.insumos i where i.nombre = 'Papa'
union all
  select i.id, 16.0000, '2025-08-31'::date, 'capturado', 'Ticket P9.jpeg, Casa Caballero U-129, Central de Abasto CDMX, ticket 39550.' from public.insumos i where i.nombre = 'Papa'
union all
  select i.id, 16.5000, '2026-01-18'::date, 'capturado', 'Ticket P10.jpeg, Casa Caballero U-129, Central de Abasto CDMX, ticket 49293.' from public.insumos i where i.nombre = 'Papa'
union all
  select i.id, 10.0000, '2026-02-02'::date, 'capturado', 'Ticket P11.jpeg, Casa Caballero U-129, Central de Abasto CDMX, ticket 50260.' from public.insumos i where i.nombre = 'Papa'
union all
  select i.id, 16.5000, '2026-02-22'::date, 'capturado', 'Promedio por peso de 2 tickets del mismo dia (P12.jpeg, P12.jpeg): 60 kg a $18.5 y 120 kg a $15.5. Calidades distintas en el mismo viaje.' from public.insumos i where i.nombre = 'Papa'
union all
  select i.id, 19.0000, '2026-03-08'::date, 'capturado', 'Ticket P13.jpeg, Casa Caballero U-129, Central de Abasto CDMX, ticket 53059.' from public.insumos i where i.nombre = 'Papa'
union all
  select i.id, 20.0000, '2026-03-29'::date, 'capturado', 'Ticket P14.jpeg, Casa Caballero U-129, Central de Abasto CDMX, ticket 54772.' from public.insumos i where i.nombre = 'Papa'
union all
  select i.id, 26.0000, '2026-04-12'::date, 'capturado', 'Ticket P15.jpeg, Casa Caballero U-129, Central de Abasto CDMX, ticket 56004.' from public.insumos i where i.nombre = 'Papa'
union all
  select i.id, 27.0000, '2026-04-26'::date, 'capturado', 'Ticket P16.jpeg, Casa Caballero U-129, Central de Abasto CDMX, ticket 57235.' from public.insumos i where i.nombre = 'Papa'
union all
  select i.id, 28.0000, '2026-05-10'::date, 'capturado', 'Ticket P17.jpeg, Casa Caballero U-129, Central de Abasto CDMX, ticket 58439.' from public.insumos i where i.nombre = 'Papa'
union all
  select i.id, 36.0000, '2026-05-31'::date, 'capturado', 'Ticket P18.jpeg, Casa Caballero U-129, Central de Abasto CDMX, ticket 60232.' from public.insumos i where i.nombre = 'Papa'
union all
  select i.id, 33.0000, '2026-06-07'::date, 'capturado', 'Ticket P19.jpeg, Casa Caballero U-129, Central de Abasto CDMX, ticket 60913.' from public.insumos i where i.nombre = 'Papa'
union all
  select i.id, 33.0000, '2026-06-21'::date, 'capturado', 'Ticket P20.jpeg, Casa Caballero U-129, Central de Abasto CDMX, ticket 62091.' from public.insumos i where i.nombre = 'Papa'
on conflict (id_insumo, vigente_desde) do update
  set costo_unidad = excluded.costo_unidad, nota = excluded.nota;

-- El gas y «otros» no tienen ticket por unidad de producto: su costo sale del
-- modelo, repartiendo lo gastado en el periodo entre los kilos producidos.
insert into public.insumos_costos (id_insumo, costo_unidad, vigente_desde, fuente, nota)
select i.id, 12.2449, '2026-01-09'::date, 'reconstruido',
       'Del modelo de punto de equilibrio: $4,500 de gas en 5 cargas / 367.5 kg de producto.'
  from public.insumos i where i.nombre = 'Gas'
on conflict (id_insumo, vigente_desde) do nothing;

insert into public.insumos_costos (id_insumo, costo_unidad, vigente_desde, fuente, nota)
select i.id, 3.2400, '2026-01-09'::date, 'reconstruido',
       'Del modelo: sal, limpieza y fumigacion, $3.24 por kg de producto.'
  from public.insumos i where i.nombre = 'Otros insumos'
on conflict (id_insumo, vigente_desde) do nothing;

-- Lo que dijo Abraham HOY, que es mas reciente que el ultimo ticket (jun 2026).
-- Se deja aparte y fechado hoy: no pisa la serie, la continua.
insert into public.insumos_costos (id_insumo, costo_unidad, vigente_desde, fuente, nota)
select i.id, 23, current_date, 'capturado',
       'Dicho por Abraham el 21 nov 2026: «la papa ahorita en promedio $23». '
       'Cinco meses despues del ultimo ticket, que fue a $33.'
  from public.insumos i where i.nombre = 'Papa'
on conflict (id_insumo, vigente_desde) do update set costo_unidad = excluded.costo_unidad;

insert into public.insumos_costos (id_insumo, costo_unidad, vigente_desde, fuente, nota)
select i.id, 750, current_date, 'capturado',
       'Dicho por Abraham el 21 nov 2026. El ultimo ticket, jun 2026, fue a $723.50.'
  from public.insumos i where i.nombre = 'Aceite'
on conflict (id_insumo, vigente_desde) do update set costo_unidad = excluded.costo_unidad;

-- ── 3. LA RECETA, con el rendimiento MEDIDO ─────────────────────────────────
-- Se reemplaza la de hoy, que usaba 14.5 de memoria. 15.02 esta medido sobre 9
-- jornadas y confirmado tres veces: las compras son multiplos de costal, el
-- cuaderno cuadra, y Abraham lo confirmo.
update public.recetas set activa = false
 where tipo = 'base' and vigente_desde = current_date;

insert into public.recetas (tipo, id_producto, rinde_cantidad, rinde_unidad, vigente_desde, activa, nota)
values ('base', null, 15.02, 'kg', '2026-01-09', true,
  'Una tanda = un costal de 60 kg. Rinde 15.02 kg de producto (25.0 por ciento), MEDIDO sobre 9 '
  'jornadas del cuaderno y confirmado por tres caminos: las compras son multiplos de '
  'costal, el cuaderno cuadra y Abraham lo confirmo el 25 oct 2026. '
  'Lleva papa, aceite, gas y otros (sal, limpieza, fumigacion). '
  'SIGUE FALTANDO: bolsa, etiqueta y mano de obra, asi que el margen real es MENOR.')
on conflict do nothing;

insert into public.receta_lineas (id_receta, id_insumo, cantidad, unidad)
select r.id, i.id, v.cant, v.unidad
  from public.recetas r,
       public.insumos i,
       (values ('Papa', 60.0, 'kg'),
               ('Aceite', 0.4087, 'bidón 20L'),
               ('Gas', 17.29, 'L'),
               ('Otros insumos', 15.02, 'kg producto')) v(nombre, cant, unidad)
 where r.tipo = 'base' and r.activa and r.vigente_desde = '2026-01-09'
   and i.nombre = v.nombre
   and not exists (select 1 from public.receta_lineas l
                    where l.id_receta = r.id and l.id_insumo = i.id);

-- Las recetas de SKU se refechan al inicio del cuaderno para que el pasado
-- tambien se pueda costear: con `vigente_desde` en hoy, una venta de marzo no
-- encontraba receta y salia sin costo aunque ya haya precio de papa de marzo.
update public.recetas set vigente_desde = '2026-01-09'
 where tipo = 'sku' and activa and vigente_desde = current_date;
