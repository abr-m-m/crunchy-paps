-- Historico del cuaderno de produccion (ene-jul 2026)
--
-- 58 fotos de las notas que llevaba a mano la persona de produccion antes de que
-- existiera la app. 1,131 hechos transcritos. Detalle completo del trabajo en
-- cambios/2026-10-25-historico-cuaderno.md (fuera del repo).
--
-- POR QUE UN ESQUEMA APARTE Y NO DENTRO DE `ordenes`
-- Meterlo en las tablas operativas disparara los triggers de puntos, lote y caja,
-- consumiria consecutivos PED-xxxxx y mezclaria dato estimado con dato cierto en las
-- mismas tablas. Aparte, si la transcripcion sale mal se borra el esquema y no pasa nada.
--
-- LA REGLA QUE ORDENA EL DISENO
-- Las tablas guardan lo que el cuaderno DICE. Todo lo inferido -una presentacion
-- supuesta, un precio aplicado, el vendedor deducido- se resuelve en las VISTAS.
-- Asi, cuando un criterio resulte mal se corrige con un CREATE OR REPLACE VIEW y no
-- reescribiendo 1,131 renglones. Es la regla 63 (una herramienta que copia la logica
-- que mide, repite) y la regla 5 (comprobar que el dato existe y es fiel antes de
-- construir el tablero).
--
-- ESTA MIGRACION NO TRAE DATOS. El repo es PUBLICO y el historico lleva nombres de
-- clientes y montos de caja. La carga se genera en local (historico/, ignorado) y se
-- aplica aparte, con aprobacion por ejecucion.

create schema if not exists historico;

comment on schema historico is
  'Cuaderno de produccion ene-jul 2026, transcrito el 25 oct 2026. Solo lectura analitica. '
  'Nunca lo leen las pantallas de la app: no son pedidos de la app y no deben mezclarse.';

-- ---------------------------------------------------------------------------
-- 1. Las paginas del cuaderno
-- ---------------------------------------------------------------------------
create table if not exists historico.paginas (
  pag        int primary key,
  archivo    text not null,
  fecha_min  date,
  fecha_max  date,
  notas      text
);

comment on table historico.paginas is
  'Una fila por foto. El numero de archivo == el numero de pagina del cuaderno. '
  'Van de la 2 a la 59: LA PAGINA 1 NO EXISTE entre las fotos.';

-- ---------------------------------------------------------------------------
-- 2. Los hechos: la transcripcion LITERAL
-- ---------------------------------------------------------------------------
create table if not exists historico.hechos (
  id        bigint generated always as identity primary key,
  pag       int  not null references historico.paginas(pag),
  fecha     date,
  dia       text,
  dia_cuadra boolean,
  tipo      text not null,
  para      text,
  sabor     text,
  pres      text,
  cant      numeric,
  monto     numeric,
  pagado    boolean,
  texto     text not null,
  conf      text not null,
  duda      text,
  constraint hechos_tipo_ck check (tipo in
    ('pedido','venta_local','inventario','caja','produccion','compra','nota','aceite','precio')),
  constraint hechos_conf_ck check (conf in ('alta','media','baja'))
);

create index if not exists hechos_fecha_idx on historico.hechos (fecha);
create index if not exists hechos_tipo_idx  on historico.hechos (tipo);
create index if not exists hechos_pag_idx   on historico.hechos (pag);

comment on table historico.hechos is
  'Un renglon por hecho, tal como esta escrito. `texto` es la transcripcion literal y es '
  'la fuente: si una columna estructurada resulta mal, se corrige contra `texto`.';
comment on column historico.hechos.para is
  'El destinatario TAL COMO lo escribio el cuaderno. Puede ser "Vendedor > Cliente", solo '
  'un cliente o solo un vendedor. No se normaliza aqui: eso lo hace bi.h_pedidos.';
comment on column historico.hechos.dia_cuadra is
  'true si el dia de la semana escrito cuadra con esa fecha en 2026. El ano NO esta en el '
  'cuaderno: se dedujo de aqui, y cuadran 1,123 de 1,123.';
comment on column historico.hechos.conf is
  'Confianza de la LECTURA, no del dato. `duda` dice que no se pudo resolver.';

-- ---------------------------------------------------------------------------
-- 3. De que encabezado cuelga cada bloque (la segunda pasada por las fotos)
-- ---------------------------------------------------------------------------
create table if not exists historico.vendedores (
  id       bigint generated always as identity primary key,
  pag      int not null references historico.paginas(pag),
  fecha    date,
  cliente  text,
  vendedor text,
  conf     text not null,
  nota     text,
  constraint vendedores_conf_ck check (conf in ('alta','media','baja'))
);

create index if not exists vendedores_busca_idx on historico.vendedores (pag, fecha, cliente);

comment on table historico.vendedores is
  'El cuaderno no tiene "destinatario": tiene a la ayudante anotando que armar POR VENDEDOR '
  'y debajo el cliente. Esta tabla guarda esa jerarquia, leida de la estructura visual de '
  'cada pagina. vendedor NULL = la pagina no lo dice.';

-- ---------------------------------------------------------------------------
-- 4. Alias: el mismo negocio escrito de varias formas
-- ---------------------------------------------------------------------------
create table if not exists historico.alias (
  nombre_cuaderno text primary key,
  cliente         text not null
);

-- La vista busca el alias con lower(). Sin este indice, dos escrituras del mismo
-- nombre que solo difieren en mayusculas son DOS claves primarias validas que casan
-- LAS DOS y duplican la linea de pedido. Paso de verdad con un cliente, y lo cazo la
-- calibracion de bi.h_pedidos contra un numero ya conocido: 673 filas donde los
-- hechos son 666, y 1,974 piezas donde son 1,948.
-- La clave primaria no bastaba: distingue mayusculas y la consulta no.
-- Cuando una columna se busca normalizada, la unicidad va sobre la forma normalizada.
create unique index if not exists alias_sin_mayusculas_idx
  on historico.alias (lower(nombre_cuaderno));

comment on table historico.alias is
  'El cliente mas grande del cuaderno aparece con cuatro nombres distintos y por separado '
  'ninguno destaca. Sin esta tabla, cualquier ranking reparte a un cliente grande en varios '
  'chicos y hace ver la cartera mas diversificada de lo que era. '
  'OJO AL CONTRARIO: dos clientes con nombres parecidos pueden ser negocios DISTINTOS. Hay '
  'un caso confirmado porque los dos aparecen en dias consecutivos de la misma pagina. '
  'Fusionar por parecido es tan costoso como no fusionar.';

-- ---------------------------------------------------------------------------
-- 5. Que cliente es de que vendedor, con vigencia
-- ---------------------------------------------------------------------------
create table if not exists historico.clientes (
  id            bigint generated always as identity primary key,
  cliente       text not null,
  vendedor      text,
  vigente_desde date,
  vigente_hasta date,
  tipo          text,
  canal         text,
  origen        text not null,
  por_que       text,
  constraint clientes_tipo_ck   check (tipo is null or tipo in ('tienda','persona')),
  constraint clientes_origen_ck check (origen in ('encabezado del cuaderno','memoria de Abraham'))
);

create index if not exists clientes_busca_idx on historico.clientes (cliente);

comment on table historico.clientes is
  'Mapa cliente -> vendedor. La vigencia NO es decorativa: existe por un caso real en que '
  'dos negocios compartieron el mismo nombre a secas y uno de ellos adopto un apellido para '
  'distinguirse, justo cuando el otro aparecio. Hasta esa fecha el nombre corto era de un '
  'vendedor y desde ella del otro. Sin vigencia, ese cliente se asigna mal medio periodo.';
comment on column historico.clientes.origen is
  'DOS CLASES DE DATO, y no valen igual: "encabezado del cuaderno" sale de lo que la '
  'ayudante escribio; "memoria de Abraham" sale de lo que recordo el 25 oct 2026. '
  'bi.h_pedidos lo expone para que un tablero pueda separarlos.';
comment on column historico.clientes.canal is
  'Como llego el cliente (ej. instagram). NO es el vendedor: son dos dimensiones y fundirlas '
  'pierde la que no se guarde.';

-- ---------------------------------------------------------------------------
-- 6. Los criterios inferidos, editables
-- ---------------------------------------------------------------------------
create table if not exists historico.supuestos (
  clave   text primary key,
  valor   jsonb not null,
  por_que text not null
);

comment on table historico.supuestos is
  'Cada criterio que NO esta en el cuaderno pero hace falta para analizarlo, con su '
  'justificacion. Cambiar un criterio es un UPDATE aqui, no tocar los hechos.';

-- ---------------------------------------------------------------------------
-- 7. Cerrado. RLS y GRANT son dos cerraduras distintas (regla 41): las dos.
-- ---------------------------------------------------------------------------
alter table historico.paginas    enable row level security;
alter table historico.hechos     enable row level security;
alter table historico.vendedores enable row level security;
alter table historico.alias      enable row level security;
alter table historico.clientes   enable row level security;
alter table historico.supuestos  enable row level security;

-- RLS activa y CERO politicas: ni anon ni authenticated leen una sola fila.
-- Solo service_role, que la salta por definicion.
revoke all on schema historico from public;
revoke all on all tables in schema historico from public;
grant usage on schema historico to service_role;
grant select, insert, update, delete on all tables in schema historico to service_role;
