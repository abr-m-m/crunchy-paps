-- 27 nov 2026 — Qué aparatos tienen una sesión abierta, y cómo cerrarla
--
-- Abraham, al decidir que el teléfono del vendedor será de la empresa:
-- «existe el riesgo de que él mismo nunca vuelva. ¿Cómo nos blindamos ante un
-- robo del equipo?».
--
-- Lo que está en riesgo no es el dinero —los cobros entran a su cuenta de
-- Stripe y el costo ya no se consulta desde fuera— sino la libreta: teléfonos,
-- direcciones y coordenadas de clientes y prospectos.
--
-- MEDIDO ANTES DE CONSTRUIR: había 4 sesiones de vendedor vivas en producción
-- y NINGUNA decía en qué aparato estaba, y no existía forma de cerrar una. La
-- única protección era que el privilegio caduca a las 12 h: un teléfono
-- perdido a las 9 de la mañana daba acceso hasta las 9 de la noche.
--
-- Dos funciones, y las dos solo para el dueño.
--
-- EL HASH COMO IDENTIFICADOR. `sesiones_vendedor` no tiene columna `id`: su
-- llave es el `token_hash`. Se expone ese hash a la consola y no pasa nada: es
-- un SHA-256 del token y no se puede invertir, así que conocerlo no permite
-- entrar. Lo que permite es cerrar esa sesión, que es justo lo que se quiere.

begin;

-- ── 1. Qué aparatos están dentro ──────────────────────────────────────────
create or replace function public.sesiones_abiertas(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_yo bigint;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'solo_dueno');
  end if;
  select s.id_vendedor into v_yo from public.resolver_sesion_vendedor(p_data->>'token') s;

  return jsonb_build_object('ok', true, 'sesiones', coalesce((
    select jsonb_agg(jsonb_build_object(
             'hash',      s.token_hash,
             'vendedor',  coalesce(v.nombre, 'vendedor ' || s.id_vendedor),
             'rol',       s.rol,
             'aparato',   public.aparato_de(s.user_agent),
             'desde',     s.creada_en,
             'ultimoUso', s.ultimo_uso,
             'expira',    s.expira_en,
             -- Para que la consola no ofrezca cerrarle la puerta a quien está
             -- mirando la pantalla.
             'esLaMia',   s.id_vendedor = v_yo
               and s.token_hash = encode(digest(p_data->>'token', 'sha256'), 'hex'))
           order by s.ultimo_uso desc nulls last, s.creada_en desc)
      from public.sesiones_vendedor s
      left join public.vendedores v on v.id = s.id_vendedor
     where not s.revocada and s.expira_en > now()), '[]'::jsonb));
end;
$fn$;
revoke all on function public.sesiones_abiertas(jsonb) from public, anon;
grant execute on function public.sesiones_abiertas(jsonb) to anon, authenticated;

-- ── 2. El nombre legible del aparato ──────────────────────────────────────
-- Un user-agent entero no se lee. Se saca lo poco que sirve para reconocerlo
-- en una lista: qué es y con qué navegador. Si no hay dato, se dice, porque
-- «desconocido» es informacion y un hueco en blanco no.
create or replace function public.aparato_de(p_ua text)
returns text language sql immutable as $fn$
  select case
    when coalesce(btrim(p_ua), '') = '' then 'sin registrar'
    else trim(
      case when p_ua ilike '%iphone%'  then 'iPhone'
           when p_ua ilike '%ipad%'    then 'iPad'
           when p_ua ilike '%android%' then 'Android'
           when p_ua ilike '%windows%' then 'Windows'
           when p_ua ilike '%mac os%'  then 'Mac'
           else 'otro' end
      || ' · ' ||
      case when p_ua ilike '%edg/%'     then 'Edge'
           when p_ua ilike '%chrome/%'  then 'Chrome'
           when p_ua ilike '%firefox/%' then 'Firefox'
           when p_ua ilike '%safari/%'  then 'Safari'
           else 'navegador' end)
  end;
$fn$;
revoke all on function public.aparato_de(text) from public, anon, authenticated;

-- ── 3. Cerrar una ─────────────────────────────────────────────────────────
-- No se borra la fila: se revoca. Un registro de que esa sesion existio y
-- cuando se cerro vale mas que una tabla limpia el dia que haya que explicar
-- que paso con un telefono.
create or replace function public.cerrar_sesion_de(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_hash text := nullif(btrim(coalesce(p_data->>'hash', '')), '');
  v_n    int;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'solo_dueno');
  end if;
  if v_hash is null then
    return jsonb_build_object('ok', false, 'error', 'falta_hash');
  end if;
  -- Cerrar TODAS las de ese vendedor de un golpe, cuando se pide asi: si el
  -- telefono se perdio, cerrar una sola no sirve de nada.
  if coalesce((p_data->>'todasDelVendedor')::boolean, false) then
    update public.sesiones_vendedor set revocada = true
     where id_vendedor = (select id_vendedor from public.sesiones_vendedor where token_hash = v_hash)
       and not revocada and expira_en > now();
  else
    update public.sesiones_vendedor set revocada = true
     where token_hash = v_hash and not revocada;
  end if;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'cerradas', v_n);
end;
$fn$;
revoke all on function public.cerrar_sesion_de(jsonb) from public, anon;
grant execute on function public.cerrar_sesion_de(jsonb) to anon, authenticated;

commit;
