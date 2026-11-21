-- ============================================================================
--  `wa_identidad` dice tambien si quien escribe puede registrar gastos
--
--  Diseno: cambios/2026-11-21-capturar-el-gasto.md
--
--  UN SOLO CAMBIO: la clave `puedeGastos` en los DOS caminos de salida. El
--  cuerpo NO se transcribio: se saco con `pg_get_functiondef` -que trae la
--  cabecera entera, no solo el cuerpo- y se le insertaron las dos lineas.
--  Dentro vive el `case` que decide el NIVEL DE PRECIO (D6).
--
--  GENERADA DESDE PRODUCCION, no desde staging, despues de descubrir que las
--  dos copias no eran identicas: staging guardaba `dueÃ±o` donde produccion
--  guarda `dueño`. Una migracion que reemplaza una funcion se genera de la
--  copia que va a reemplazar, o se lleva por delante lo que esa copia tuviera.
--  Y la lectura se decodifica como UTF-8 a mano: la codificacion del sistema,
--  en Windows, convierte una eñe en dos caracteres sin avisar.
--
--  Para que sirve: el agente solo ofrece la herramienta de gastos a quien
--  puede usarla. NO es el permiso -ese lo da `wa_registrar_gasto` mirando la
--  misma seccion en el servidor-; es para no prometer algo que luego falla.
--
--  Aplicar: staging y produccion, en ese orden.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.wa_identidad(p_telefono text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tel text := right(regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g'), 10);
  v_cli clientes%rowtype;
  v_ven vendedores%rowtype;
  v_rol text;
  v_dueno boolean := false;
begin
  if length(v_tel) <> 10 then
    return jsonb_build_object('ok', false, 'error', 'telefono_invalido');
  end if;

  -- El dueño primero, porque hoy puede no estar en `clientes` en absoluto.
  -- Solo vendedores ACTIVOS: dar de baja a alguien tiene que quitarle esto.
  select * into v_ven from public.vendedores
   where activo
     and right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) = v_tel
   order by id
   limit 1;

  if v_ven.id is not null then
    v_rol   := lower(btrim(coalesce(v_ven.rol, '')));
    v_dueno := v_rol in ('admin', 'administrador');
  end if;

  select * into v_cli from clientes
   where right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) = v_tel
   limit 1;

  if v_cli.id is null then
    -- No es un error: es alguien que escribe por primera vez. Consumidor.
    return jsonb_build_object(
      'ok', true, 'esCliente', false, 'idCliente', null, 'nombre', v_ven.nombre,
      'nivel', 'consumidor', 'aprobadoB2B', false, 'idRuta', null,
      'esVendedor', v_ven.id is not null, 'esDueno', v_dueno,
      'rol', v_ven.rol, 'idVendedor', v_ven.id,
      -- Si trae la seccion `gastos`, el agente le ofrece registrar uno.
      -- Es la MISMA lista que exige la pantalla; aqui solo se lee para
      -- saber que herramienta mostrar. Quien autoriza de verdad sigue
      -- siendo `wa_registrar_gasto`, en el servidor (regla 35:
      -- esconder un boton no es un permiso, y ensenarlo tampoco lo da).
      'puedeGastos', 'gastos' = any(coalesce(v_ven.secciones, array[]::text[])));
  end if;

  return jsonb_build_object(
    'ok', true,
    'esCliente', true,
    'idCliente', v_cli.id,
    'nombre', v_cli.nombre,
    'aprobadoB2B', coalesce(v_cli.aprobado_b2b, false),
    'idRuta', v_cli.id_ruta,
    -- ESTE `case` NO SE TOCO. Es el que decide el precio (D6).
    'nivel', case
      when not coalesce(v_cli.aprobado_b2b, false) then 'consumidor'
      when v_cli.tipo_id = 2 then 'restaurante'
      when v_cli.tipo_id = 3 then 'tienda'
      when v_cli.tipo_id = 4 then 'mayorista'
      else 'consumidor'
    end,
    -- Lo nuevo va APARTE, sin rozar lo de arriba.
    'esVendedor', v_ven.id is not null,
    'esDueno', v_dueno,
    'rol', v_ven.rol,
    'idVendedor', v_ven.id,
      -- Si trae la seccion `gastos`, el agente le ofrece registrar uno.
      -- Es la MISMA lista que exige la pantalla; aqui solo se lee para
      -- saber que herramienta mostrar. Quien autoriza de verdad sigue
      -- siendo `wa_registrar_gasto`, en el servidor (regla 35:
      -- esconder un boton no es un permiso, y ensenarlo tampoco lo da).
      'puedeGastos', 'gastos' = any(coalesce(v_ven.secciones, array[]::text[]))
  );
end;
$function$;
