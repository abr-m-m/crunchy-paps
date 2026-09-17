-- 20260926000000_prospecto_de_mi_ruta.sql
-- Ruta del día, entrega 2 (hallazgo del 16 sep): la ficha del prospecto dependía
-- de la lista de Prospección, que para un vendedor solo trae los prospectos con su
-- id_vendedor. Los de su ruta sin visitar no tienen vendedor: no podía abrirlos.
-- Regla nueva (Abraham, 16 sep): un vendedor puede abrir un prospecto si se lo
-- asignaron O si cae en la ruta que él lleva. El dueño ve todos. Re-ejecutable.
create or replace function public.obtener_prospecto(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v_vend  bigint;
  v_rol   text;
  v_id    bigint;
  v_p     public.prospectos%rowtype;
  v_ruta  bigint;
  v_dueno boolean;
begin
  select s.id_vendedor into v_vend
    from public.sesion_exige_seccion(p_data->>'token', 'prospeccion') s;
  if v_vend is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  begin
    v_id := nullif(p_data->>'id', '')::bigint;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'Falta el prospecto');
  end;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'Falta el prospecto');
  end if;
  select * into v_p from public.prospectos where id = v_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Prospecto no encontrado');
  end if;
  select lower(trim(v.rol)) into v_rol from public.vendedores v where v.id = v_vend;
  v_dueno := coalesce(v_rol, '') in ('admin', 'administrador');
  if not v_dueno and v_p.id_vendedor is distinct from v_vend then
    v_ruta := public.ruta_para(nullif(regexp_replace(coalesce(v_p.codigo_postal, ''), '[^0-9]', '', 'g'), ''), v_p.colonia);
    if v_ruta is null or not exists (select 1 from public.rutas r where r.id = v_ruta and r.activa and r.id_vendedor = v_vend) then
      return jsonb_build_object('ok', false, 'error', 'No autorizado');
    end if;
  end if;
  return jsonb_build_object('ok', true, 'prospecto', to_jsonb(v_p));
end $fn$;
revoke all on function public.obtener_prospecto(jsonb) from public;
grant execute on function public.obtener_prospecto(jsonb) to anon, authenticated;
