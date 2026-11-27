-- 26 nov 2026 — Cerrar tres puertas abiertas.
--
-- Abraham mando un video con 15 preguntas de ataque a apps hechas con IA. Al
-- inventariar la seguridad contra esa lista salio esto, que es la REGLA 28 de
-- la casa en vivo: «una funcion SECURITY DEFINER concedida a anon sin
-- comprobar sesion es un endpoint publico».
--
-- De las 94 funciones propias con EXECUTE para PUBLIC, 25 no nombraban
-- ninguna comprobacion de sesion. Leyendo los cuerpos -no fiandose de la
-- forma, regla 53- tres eran puertas de verdad:
--
--   buscar_clientes_ubicacion  devuelve nombre, tipo y TELEFONO de cualquier
--                              cliente con 3 letras de busqueda
--   obtener_caja_dia           devuelve la caja del dia por punto de venta
--   set_ubicacion_cliente      sobrescribe las coordenadas de cualquier
--                              cliente sabiendo solo su telefono
--
-- POR QUE ESTABAN ABIERTAS, que es lo interesante: `supabaseCall` inyecta el
-- token de sesion en toda llamada que use la convencion `p_data`, y se hace en
-- UN solo sitio justamente para que no se olvide (regla 38). Pero estas tres
-- usan ARGUMENTOS POSICIONALES (`p_q`, `p_fecha`, `p_telefono`), que ese
-- puente no toca. El patron que protege 90 funciones tenia tres agujeros por
-- donde no pasaba, y nadie lo noto porque desde la app todo funcionaba.
--
-- NO SE REVOCA EL GRANT, Y ESO ES A PROPOSITO. Aqui la sesion NO es un JWT:
-- es un token propio que viaja dentro del cuerpo, y toda la app llama como
-- `anon` con la llave publica. Revocar EXECUTE de `anon` no cerraria una
-- puerta: apagaria la app entera. La cerradura de esta casa va DENTRO de la
-- funcion (regla 41: RLS y GRANT son dos cerraduras distintas, y aqui la que
-- manda es la tercera).
--
-- HAY QUE TIRAR LA FIRMA VIEJA. `create or replace` con un parametro nuevo no
-- reemplaza: CREA OTRA, y entonces la llamada vieja se vuelve ambigua y
-- Postgres aborta. Costo cazarlo el 24 nov con `promocion_mejor`.
--
-- LO QUE NO ES UNA PUERTA, y lo digo porque yo mismo lo reporte como tal:
-- `registrar_o_actualizar_cliente` deja mandar `tipo` desde el payload, pero
-- NO da precio B2B. Al leer el cuerpo: si el cliente ya existe, el UPDATE ni
-- toca `tipo`; y al crear uno nuevo, `v_aprobado := (v_tipo_id IN (1, 5))`
-- -Consumidor y Mostrador-, asi que un «Tienda» que se registre solo nace SIN
-- aprobar, y `crear_pedido` solo sube el nivel de precio con `aprobado_b2b`.
-- Esa puerta se cerro el 21 sep 2026 y el comentario sigue ahi. Lo unico que
-- queda es una etiqueta mal puesta, que es suciedad de datos, no un agujero.

begin;

-- ── buscar_clientes_ubicacion ──
drop function if exists public.buscar_clientes_ubicacion(text);

CREATE OR REPLACE FUNCTION public.buscar_clientes_ubicacion(p_q text, p_token text default null)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_guard bigint;
  v_q      text := trim(coalesce(p_q, ''));
  v_digits text := regexp_replace(v_q, '\D', '', 'g');
  v_rows   jsonb;
begin
  select s.id_vendedor into v_guard from public.resolver_sesion_vendedor(p_token) s;
  if v_guard is null then
    return jsonb_build_object('ok', false, 'error', 'sesion_requerida');
  end if;

  if length(v_q) < 3 then
    return jsonb_build_object('ok', false, 'error', 'Búsqueda muy corta');
  end if;

  if length(v_digits) >= 4 and v_digits = regexp_replace(v_q, '\s', '', 'g') then
    -- Solo dígitos: buscar por teléfono (coincidencia al final)
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'nombre', c.nombre, 'tipo', c.tipo,
             'telefono', right(regexp_replace(c.telefono, '\D', '', 'g'), 10),
             'tieneUbicacion', coalesce(nullif(trim(coalesce(c.coordenadas,'')), ''), null) is not null))
      into v_rows
      from (select * from public.clientes
             where regexp_replace(telefono, '\D', '', 'g') like '%' || v_digits
             order by nombre nulls last
             limit 8) c;
  else
    -- Texto: buscar por nombre (contiene, sin distinguir mayúsculas)
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'nombre', c.nombre, 'tipo', c.tipo,
             'telefono', right(regexp_replace(c.telefono, '\D', '', 'g'), 10),
             'tieneUbicacion', coalesce(nullif(trim(coalesce(c.coordenadas,'')), ''), null) is not null))
      into v_rows
      from (select * from public.clientes
             where nombre ilike '%' || v_q || '%'
             order by nombre
             limit 8) c;
  end if;

  return jsonb_build_object('ok', true, 'clientes', coalesce(v_rows, '[]'::jsonb));
end;
$function$;

revoke all on function public.buscar_clientes_ubicacion(text, text) from public, anon;
grant execute on function public.buscar_clientes_ubicacion(text, text) to anon, authenticated;

-- ── obtener_caja_dia ──
drop function if exists public.obtener_caja_dia(date);

CREATE OR REPLACE FUNCTION public.obtener_caja_dia(p_fecha date default null, p_token text default null)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_guard bigint;
  v_fecha DATE;
  v_puntos JSONB;
BEGIN
  select s.id_vendedor into v_guard from public.sesion_exige_seccion(p_token, 'caja') s;
  if v_guard is null then
    return jsonb_build_object('ok', false, 'error', 'sin_permiso');
  end if;

  v_fecha := COALESCE(p_fecha, CURRENT_DATE);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'idPunto',          p.id,
    'codigo',           p.codigo,
    'nombre',           p.nombre,
    'tipo',             p.tipo,
    'fondoMinimo',      p.fondo_minimo,
    'cajaDia',          (
      SELECT row_to_json(c)
      FROM (
        SELECT id, fecha, saldo_apertura, saldo_cierre_declarado, saldo_cierre_calculado,
               diferencia, estatus, abierta_por, fecha_apertura, cerrada_por, fecha_cierre,
               notas_apertura, notas_cierre
        FROM caja_dias WHERE id_punto = p.id AND fecha = v_fecha LIMIT 1
      ) c
    ),
    'saldoTotal',       (SELECT COALESCE(SUM(monto), 0) FROM caja_movimientos WHERE id_punto = p.id),
    'totalIngresos',    (SELECT COALESCE(SUM(monto), 0) FROM caja_movimientos WHERE id_punto = p.id AND fecha::DATE = v_fecha AND monto > 0 AND tipo <> 'apertura'),
    'totalEgresos',     (SELECT COALESCE(SUM(monto), 0) FROM caja_movimientos WHERE id_punto = p.id AND fecha::DATE = v_fecha AND monto < 0),
    'numVentas',        (SELECT COUNT(*) FROM caja_movimientos WHERE id_punto = p.id AND fecha::DATE = v_fecha AND tipo LIKE 'venta%'),
    'numGastos',        (SELECT COUNT(*) FROM caja_movimientos WHERE id_punto = p.id AND fecha::DATE = v_fecha AND tipo LIKE 'gasto%'),
    'movimientos',      (
      SELECT COALESCE(jsonb_agg(row_to_json(m) ORDER BY m.fecha DESC), '[]'::JSONB)
      FROM (
        SELECT id, tipo, monto, descripcion, fecha, actor,
               id_orden, consecutivo_pedido, id_gasto, id_punto_destino
        FROM caja_movimientos WHERE id_punto = p.id AND fecha::DATE = v_fecha
        ORDER BY fecha DESC
      ) m
    )
  ) ORDER BY p.orden_display, p.id), '[]'::JSONB) INTO v_puntos
  FROM caja_puntos p
  WHERE p.activo = TRUE;

  RETURN jsonb_build_object('ok', true, 'fecha', v_fecha, 'puntos', v_puntos);
END;
$function$;

revoke all on function public.obtener_caja_dia(date, text) from public, anon;
grant execute on function public.obtener_caja_dia(date, text) to anon, authenticated;

-- ── set_ubicacion_cliente ──
drop function if exists public.set_ubicacion_cliente(text, text);

CREATE OR REPLACE FUNCTION public.set_ubicacion_cliente(p_telefono text, p_coordenadas text, p_token text default null)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_guard bigint;
  v_tel text := right(regexp_replace(coalesce(p_telefono,''), '\D', '', 'g'), 10);
  v_id bigint;
  v_nombre text;
begin
  select s.id_vendedor into v_guard from public.resolver_sesion_vendedor(p_token) s;
  if v_guard is null then
    return jsonb_build_object('ok', false, 'error', 'sesion_requerida');
  end if;

  if length(v_tel) <> 10 then
    return jsonb_build_object('ok', false, 'error', 'Teléfono inválido');
  end if;
  if coalesce(trim(p_coordenadas), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'Coordenadas vacías');
  end if;

  update public.clientes
     set coordenadas     = p_coordenadas,
         coordenadas_gps = p_coordenadas
   where right(regexp_replace(telefono, '\D', '', 'g'), 10) = v_tel
   returning id, nombre into v_id, v_nombre;

  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'Cliente no encontrado');
  end if;
  return jsonb_build_object('ok', true, 'idCliente', v_id, 'nombre', v_nombre);
end;
$function$;

revoke all on function public.set_ubicacion_cliente(text, text, text) from public, anon;
grant execute on function public.set_ubicacion_cliente(text, text, text) to anon, authenticated;

commit;
