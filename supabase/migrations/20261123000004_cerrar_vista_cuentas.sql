-- ════════════════════════════════════════════════════════════════════════════
--  CERRAR public.cuentas — la vista que se saltaba la RLS
--  23 nov 2026. Aparecio al aplicar el endurecimiento de RLS, revisando por que
--  `cuentas` seguia concediendo CRUD a `anon` despues de la limpieza.
--
--  QUE ES. Una VISTA de 1,172 filas, propiedad de `postgres` y SIN
--  `security_invoker`. Una vista asi ejecuta con los permisos de su DUENO, no
--  con los de quien la llama: se salta la RLS de las tablas que lee. Y lo que
--  lee son nombre, vendedor, score, ultima visita, ultimo pedido, dias sin
--  comprar y etapa — la lista de clientes y prospectos.
--
--  POR QUE NO ESTABA FILTRANDO HOY. Porque devuelve
--  `401 permission denied for function ruta_para`: la vista llama a una
--  funcion que `anon` no puede ejecutar. Eso es un ACCIDENTE, no un candado.
--  El dia que alguien conceda ese EXECUTE -o que la vista deje de llamarla-
--  empieza a repartir 1,172 nombres sin que nadie toque una politica.
--
--  Es exactamente la regla 41 al reves: aqui no habia dos cerraduras, habia
--  CERO, y lo que tapaba era una tercera cosa que nadie puso ahi a proposito.
--
--  QUIEN LA USA DE VERDAD: `ruta_del_dia`, que es `security definer` y corre
--  como `postgres`, asi que no le afecta quitarle el permiso a `anon`.
--  La app no la lee: solo lee `productos`, `productos_bebidas` y
--  `vista_inventario` (medido en el codigo, no supuesto).
--
--  Se ponen LAS DOS cerraduras:
--    1. revocar el acceso de `anon` y `authenticated`;
--    2. `security_invoker`, para que la vista deje de prestar los permisos de
--       su dueno aunque alguien vuelva a conceder el acceso.
--  Ninguna tabla tiene FORCE ROW LEVEL SECURITY, asi que el camino que importa
--  -`ruta_del_dia` corriendo como postgres- no cambia de comportamiento.
-- ════════════════════════════════════════════════════════════════════════════

revoke all on public.cuentas from anon, authenticated;

alter view public.cuentas set (security_invoker = true);

-- `vista_inventario` se queda alcanzable por `anon`: la app la lee de verdad y
-- solo expone sabor y kilos agregados, ningun dato de persona. Es la unica
-- vista de `public` que `anon` necesita, y queda dicho aqui para que la
-- proxima revision no tenga que volver a averiguarlo.
