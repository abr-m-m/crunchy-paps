-- 27 nov 2026 — El costo no sale de la casa
--
-- Abraham, pensando el hand held desde el lado del vendedor:
--
--   «Promociones y su margen es MIO, el club es del cliente, el catalogo es
--    del cliente/consumidor y vendedor. El margen de las promociones es mio,
--    no del vendedor. El tiene que saber QUE OFRECER para que el cliente
--    compre desde su app o para que el registre el pedido.»
--
-- El panel ya respetaba eso: el tablero manda el margen solo si la sesion es
-- del dueño, y asi esta escrito en `src/panel.js`. Pero la regla vivia SOLO en
-- la pantalla. Por debajo, `costo_sku` y sus hermanas las podia ejecutar
-- `anon`, y la llave anon viaja en el navegador por diseño: cualquiera con las
-- herramientas de desarrollo -un vendedor, una tienda, un curioso- podia
-- preguntar cuanto cuesta producir una bolsa.
--
-- Esconder el numero en la pantalla no es un permiso (regla 35). Aqui se cierra
-- donde importa.
--
-- NO ROMPE NADA, y se miro antes: ninguna pantalla las llama directo. Quien las
-- usa son otras funciones -`promocion_margen`, `precios_admin`, el tablero- y
-- todas son SECURITY DEFINER, asi que corren con los permisos de su dueño y no
-- con los de quien llama. El unico que pierde algo es quien las llamaba a mano.

begin;

revoke execute on function public.costo_sku(bigint, date)      from anon, authenticated;
revoke execute on function public.costo_base_kg(date)          from anon, authenticated;
revoke execute on function public.costo_insumo(bigint, date)   from anon, authenticated;
revoke execute on function public.pct_margen(numeric, numeric) from anon, authenticated;

commit;
