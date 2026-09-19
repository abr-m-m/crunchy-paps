-- 18 sep 2026 — La base trabaja en hora de CDMX.
--
-- Las 82 columnas de fecha y hora son `timestamptz`: guardan el instante exacto y no cambian.
-- Lo que cambia es la zona de cada sesión, que hoy es UTC. Con UTC, `current_date`,
-- `columna::date`, `date_trunc` y `to_char` cuentan el día en UTC: desde las 18:00 de CDMX ya es
-- «mañana». Lo hacen 26 funciones (caja del día, lista de armado por fecha de entrega, jornadas,
-- gastos, producción, reportes); las 5 que ya fijan 'America/Mexico_City' no cambian.
--
-- Efecto: los JSON salen con -06:00 en vez de +00:00 (la app los lee con new Date(), sin
-- cambio). Las filas viejas de columnas `date` escritas de noche conservan el día UTC con que
-- se guardaron.
--
-- Aplica a conexiones NUEVAS. Después de ejecutarlo, que PostgREST reconecte: basta la línea 2
-- (corta las conexiones del API; se rehacen solas en segundos).

alter database postgres set timezone to 'America/Mexico_City';

select pg_terminate_backend(pid) from pg_stat_activity
 where usename = 'authenticator' and pid <> pg_backend_pid();

-- Verificación (en una consulta aparte, y también por la API):
-- select current_setting('TimeZone'), now(), current_date;
