-- 27 nov 2026 — `set_coordenadas_gps` deja de aceptar a cualquiera
--
-- Encontrado triando las 174 funciones que alcanza la llave publica. La version
-- vieja era `SECURITY DEFINER`, ejecutable por `anon`, y pedia UN TELEFONO Y
-- NADA MAS:
--
--   set_coordenadas_gps(p_telefono text, p_gps text)
--
-- Quien supiera o adivinara un numero de 10 digitos reescribia las coordenadas
-- de ese cliente. Sin sesion, sin prueba de que el telefono fuera suyo.
--
-- El daño HOY era acotado y se midio antes de alarmar: 3 de 40 clientes tienen
-- valor en esa columna y el reparto se guia por `latitud`/`longitud`, no por
-- ella. Pero es una ESCRITURA sobre datos de cliente desde fuera, y eso no se
-- deja abierto porque hoy apunte a una columna poco usada.
--
-- NO SE REVOCA EL EXECUTE: la app entera habla como `anon` y las dos pantallas
-- que la llaman -el alta del propio cliente y el alta por vendedor- deben
-- seguir funcionando. La cerradura va DENTRO, como en todo el proyecto.
--
-- UN SOLO `p_token`, DOS TIPOS DE SESION. Lo llama un cliente dando de alta su
-- negocio y lo llama un vendedor dando de alta el de otro. Si el token es de
-- vendedor vale para cualquier telefono -es su trabajo-; si es de cliente, solo
-- para EL SUYO.
--
-- Y `drop function` de la firma vieja: dejarla viva seria dejar la puerta
-- abierta al lado de la cerrada.

begin;

drop function if exists public.set_coordenadas_gps(text, text);

create or replace function public.set_coordenadas_gps(
  p_telefono text,
  p_gps      text,
  p_token    text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_tel     text;
  v_quien   bigint;
  v_tel_ses text;
  v_rows    int;
begin
  v_tel := right(regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g'), 10);
  if length(v_tel) < 10 then
    return jsonb_build_object('ok', false, 'error', 'telefono invalido');
  end if;

  -- 1. ¿Es un vendedor? Entonces puede poner el GPS de cualquier negocio.
  select s.id_vendedor into v_quien
    from public.resolver_sesion_vendedor(p_token) s;

  if v_quien is null then
    -- 2. ¿Es el propio cliente? Solo puede tocar SU telefono. La comparacion
    --    se hace sobre los 10 digitos de los dos lados, porque en la base
    --    conviven «+52 55...», «55...» y variantes con espacios.
    v_tel_ses := public.resolver_sesion_cliente(p_token);
    if v_tel_ses is null
       or right(regexp_replace(v_tel_ses, '\D', '', 'g'), 10) <> v_tel then
      return jsonb_build_object('ok', false, 'error', 'sin_permiso');
    end if;
  end if;

  update public.clientes
     set coordenadas_gps = nullif(btrim(coalesce(p_gps, '')), '')
   where right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) = v_tel;
  get diagnostics v_rows = row_count;

  return jsonb_build_object('ok', true, 'actualizados', v_rows);
end;
$fn$;

revoke all on function public.set_coordenadas_gps(text, text, text) from public;
grant execute on function public.set_coordenadas_gps(text, text, text) to anon, authenticated;
comment on function public.set_coordenadas_gps(text, text, text) is
  'Guarda el GPS de validacion de un cliente. Exige sesion: de vendedor para cualquiera, de cliente solo para su propio telefono. 27 nov 2026.';

commit;
