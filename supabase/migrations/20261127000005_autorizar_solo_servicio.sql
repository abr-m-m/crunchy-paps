-- 27 nov 2026 — `autorizar_enlace_pago` solo para la llave de servicio
--
-- Al comprobar la migracion anterior en produccion, el ACL salio asi:
--
--   postgres=X | authenticated=X | service_role=X
--
-- `authenticated` no lo puse yo: son los privilegios por omision de Supabase
-- sobre funciones nuevas. Revoque de `public` y de `anon`, y me falto ese
-- (regla 42: una funcion nueva reparte EXECUTE sola, y hay que quitarselo).
--
-- No es un agujero -la funcion comprueba la sesion igual, y esta app no usa
-- Supabase Auth, asi que nadie tiene ese rol-, pero esta funcion solo debe
-- poder llamarla la Edge Function con la llave de servicio. Si la pudiera
-- llamar el navegador, saltarsela seria tan facil como no llamarla.

begin;
revoke all on function public.autorizar_enlace_pago(jsonb) from public, anon, authenticated;
grant execute on function public.autorizar_enlace_pago(jsonb) to service_role;
commit;
