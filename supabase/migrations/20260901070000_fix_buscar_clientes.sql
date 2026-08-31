-- ============================================================================
--  CORRECCIÓN — buscar_clientes devolvía TODOS los clientes
-- ----------------------------------------------------------------------------
--  Reportado por Abraham tras el despliegue: el buscador "no es asertivo,
--  despliega una lista independientemente del nombre que especifiques".
--
--  LA CAUSA
--  --------
--  La condición de teléfono era:
--
--      regexp_replace(coalesce(c.telefono,''), '\D', '', 'g')
--        ilike '%' || regexp_replace(v_q, '\D', '', 'g') || '%'
--
--  Al buscar por NOMBRE ("Juan"), quitarle los no-dígitos a la consulta deja
--  cadena vacía, y `telefono ilike '%%'` coincide con TODAS las filas. El `or`
--  hacía el resto: el filtro por nombre daba igual.
--
--  Es el clásico patrón «comodín vacío» y hay que buscarlo en cualquier
--  condición que construya un LIKE a partir de una entrada transformada.
--
--  LA CORRECCIÓN
--  -------------
--  La condición de teléfono solo se evalúa si la consulta REALMENTE trae
--  dígitos. Se usa `like` en vez de `ilike` para la comparación numérica: sobre
--  una cadena de dígitos, `ilike` no aporta nada y cuesta más.
-- ============================================================================

create or replace function public.buscar_clientes(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id_vendedor bigint;
  v_rol         text;
  v_q           text := trim(coalesce(p_data->>'q', ''));
  v_digitos     text;
  v_es_admin    boolean;
  v_filas       jsonb;
begin
  select s.id_vendedor, s.rol into v_id_vendedor, v_rol
    from public.resolver_sesion_vendedor(p_data->>'token') s;

  if v_id_vendedor is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida o expirada');
  end if;

  -- Mínimo 2 caracteres: evita que una búsqueda vacía haga de volcado.
  if length(v_q) < 2 then
    return jsonb_build_object('ok', true, 'clientes', '[]'::jsonb);
  end if;

  -- Vacío si la consulta no trae dígitos. NULL no: `x like '%' || null` da NULL,
  -- y aquí queremos poder comparar explícitamente contra cadena vacía.
  v_digitos := regexp_replace(v_q, '\D', '', 'g');

  v_es_admin := v_rol in ('Admin', 'Administrador');

  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
    into v_filas
    from (
      select c.*
        from public.clientes c
       where (v_es_admin or c.id_vendedor = v_id_vendedor)
         and (
           c.nombre ilike '%' || v_q || '%'
           -- El teléfono solo se compara cuando la consulta es SOLO números.
           -- Dos guardas, por dos motivos distintos:
           --   v_digitos <> ''  evita el comodín vacío ilike '%%', que devolvía
           --                    el padrón entero al buscar por nombre.
           --   sin letras       evita que "Ficticio 007" casara además con los
           --                    teléfonos que contienen 007 (070, 071, ...).
           -- Si escribes letras buscas por nombre; si escribes solo números,
           -- por teléfono. Es lo que espera quien usa el buscador.
           or ( v_digitos <> ''
                and v_q !~ '[A-Za-zÁÉÍÓÚáéíóúÑñÜü]'
                and regexp_replace(coalesce(c.telefono, ''), '\D', '', 'g')
                    like '%' || v_digitos || '%' )
         )
       order by c.nombre
       limit 10
    ) t;

  return jsonb_build_object('ok', true, 'clientes', v_filas);
end;
$$;

comment on function public.buscar_clientes(jsonb) is
  'Búsqueda de clientes acotada por sesión y rol. La condición de teléfono solo se evalúa si la consulta trae dígitos: sin esa guarda, buscar por nombre generaba el comodín vacío ilike ''%%'' y devolvía el padrón completo.';
