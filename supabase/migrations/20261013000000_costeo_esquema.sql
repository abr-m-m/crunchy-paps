-- 20261013000000_costeo_esquema.sql
-- El costeo estándar (cambios/2026-09-23-costeo-y-margen/diseno.md §1).
--
-- El problema medido en producción el 23 sep 2026: `productos` tiene SIETE columnas de precio
-- (consumidor, tienda, restaurante, mostrador, mayorista, granel_kg, caja_3/6/12) y CERO de
-- costo, y las cuatro tablas que registrarían el costo estaban vacías: `insumos`, `uso_insumos`,
-- `gastos_insumos` e `insumos_estado`. Con 35 productos activos, ninguno tenía margen calculable.
--
-- `insumos` existía sin usar; aquí empieza a servir. El costo lleva VIGENCIA (D15) porque sin ella
-- recalcular el margen de una venta de junio usaría el precio de la papa de HOY y mentiría — y la
-- reconstrucción del pasado con los costos que Abraham guarda en papel (D10) sería imposible.
--
-- El hueco de claves …07 a …12 es deliberado: ver «Restricciones globales» del plan.

alter table public.insumos
  add column if not exists tipo text
    check (tipo in ('materia_prima','empaque','servicio'));

-- Una bebida es REVENTA: no tiene receta, su costo es lo que cuesta comprarla.
alter table public.productos_bebidas
  add column if not exists costo numeric;

-- ── El costo de un insumo a lo largo del tiempo ──────────────────────────────
create table if not exists public.insumos_costos (
  id            bigint generated always as identity primary key,
  id_insumo     bigint not null references public.insumos(id) on delete cascade,
  costo_unidad  numeric not null check (costo_unidad >= 0),
  vigente_desde date    not null,
  -- 'reconstruido' = del papel de Abraham, no verificable contra una factura. Un margen del
  -- pasado tiene que VERSE reconstruido, igual que las 38 cajas del 22 sep nacieron con
  -- saldo_cierre_declarado NULL: dice la verdad sobre su propio origen.
  fuente        text    not null default 'capturado'
                  check (fuente in ('capturado','reconstruido')),
  nota          text,
  creado_en     timestamptz not null default now(),
  unique (id_insumo, vigente_desde)
);
create index if not exists ix_insumos_costos_busqueda
  on public.insumos_costos (id_insumo, vigente_desde desc);

-- ── Las recetas: dos niveles, porque así se produce ──────────────────────────
-- Todo se produce en BASE (Natural) y los sabores se arman bajo demanda (CLAUDE.md §1).
-- Receta 'base': qué hace falta para 1 kg de base. Receta 'sku': kg_base más empaque y sazonador.
create table if not exists public.recetas (
  id             bigint generated always as identity primary key,
  tipo           text not null check (tipo in ('base','sku')),
  id_producto    bigint references public.productos(id) on delete cascade,
  rinde_cantidad numeric not null check (rinde_cantidad > 0),
  rinde_unidad   text    not null,
  kg_base        numeric check (kg_base >= 0),
  vigente_desde  date    not null,
  activa         boolean not null default true,
  nota           text,
  creado_en      timestamptz not null default now(),
  -- Una receta de base no cuelga de un producto y no consume base; una de SKU hace las dos cosas.
  check ((tipo = 'base' and id_producto is null and kg_base is null)
      or (tipo = 'sku'  and id_producto is not null and kg_base is not null))
);
create unique index if not exists ux_recetas_base_vigencia
  on public.recetas (vigente_desde) where tipo = 'base';
create unique index if not exists ux_recetas_sku_vigencia
  on public.recetas (id_producto, vigente_desde) where tipo = 'sku';

create table if not exists public.receta_lineas (
  id        bigint generated always as identity primary key,
  id_receta bigint  not null references public.recetas(id) on delete cascade,
  id_insumo bigint  not null references public.insumos(id),
  cantidad  numeric not null check (cantidad > 0),
  unidad    text    not null,
  unique (id_receta, id_insumo)
);

-- ── Qué categorías de `gastos` son FIJAS (D14) ───────────────────────────────
-- No es una tabla de gastos: es la marca que separa lo que alimenta el PUNTO DE EQUILIBRIO
-- (renta, luz, agua) de lo que ya está dentro del costo por kg. Prorratear los fijos al kg haría
-- SUBIR el costo por bolsa el mes que se vende poco —agosto 2026 cerró en cero— y fijar precios
-- contra eso significaría subirlos justo cuando peor va el mes (D2).
create table if not exists public.gastos_categorias (
  categoria text primary key,
  es_fijo   boolean not null default false
);

-- ── Cerradas: se leen y se escriben solo por RPC (tarea 3 del plan) ──────────
alter table public.insumos_costos    enable row level security;
alter table public.recetas           enable row level security;
alter table public.receta_lineas     enable row level security;
alter table public.gastos_categorias enable row level security;

-- ── El costo vigente de un insumo en una fecha ───────────────────────────────
-- NULL si no había ninguno todavía: un costo ausente NO es cero (D12). Un 0 aquí se propagaría
-- como un margen del 100 % y se leería como una ganancia perfecta.
create or replace function public.costo_insumo(p_id bigint, p_fecha date)
returns numeric
language sql stable security definer set search_path = public, pg_temp
as $$
  select c.costo_unidad
    from public.insumos_costos c
   where c.id_insumo = p_id
     and c.vigente_desde <= p_fecha
   order by c.vigente_desde desc
   limit 1;
$$;

-- Regla 42: una función nueva concede EXECUTE a PUBLIC por defecto. Esto no es decoración.
-- No se concede a `anon`: solo la usan otras funciones del servidor y los RPC de la tarea 3.
revoke all on function public.costo_insumo(bigint, date) from public;
