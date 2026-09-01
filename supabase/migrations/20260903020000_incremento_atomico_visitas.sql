-- ============================================================================
--  Incremento atómico de visitas a prospectos
-- ----------------------------------------------------------------------------
--  La app hacía leer-sumar-escribir:
--
--      GET  prospectos?id=eq.N&select=num_visitas
--      ... numVisitasActual + 1 ...
--      RPC  actualizar_prospecto { num_visitas: <ese número> }
--
--  Dos problemas. El evidente: es la última lectura directa a `prospectos`, y
--  mientras exista no se puede revocar el SELECT. El de fondo: es una condición
--  de carrera — dos visitas registradas a la vez leen el mismo valor y una se
--  pierde.
--
--  Con `incrementarVisitas`, Postgres hace `num_visitas + 1` en la propia
--  sentencia. Sin lectura previa y sin carrera.
-- ============================================================================

create or replace function public.actualizar_prospecto(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id_vend bigint;
  v_id      bigint := (p_data->>'id')::bigint;
  v_campos  jsonb  := coalesce(p_data->'campos', '{}'::jsonb);
  v_incr    boolean := coalesce((p_data->>'incrementarVisitas')::boolean, false);
  v_clave   text;
  v_permitidas constant text[] := array[
    'estatus', 'num_visitas', 'fecha_visita', 'notas', 'score',
    'motivo_descarte', 'fecha_descarte', 'contacto_nombre', 'contacto_telefono'
  ];
begin
  select s.id_vendedor into v_id_vend
    from public.sesion_exige_seccion(p_data->>'token', 'prospeccion') s;
  if v_id_vend is null then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;

  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'Falta id');
  end if;

  for v_clave in select jsonb_object_keys(v_campos) loop
    if not (v_clave = any(v_permitidas)) then
      return jsonb_build_object('ok', false,
        'error', 'Campo no permitido: ' || v_clave);
    end if;
  end loop;

  update public.prospectos p set
    estatus           = case when v_campos ? 'estatus'           then  v_campos->>'estatus'                       else p.estatus           end,
    -- El incremento gana sobre un num_visitas explícito: es la vía correcta.
    num_visitas       = case when v_incr                          then coalesce(p.num_visitas, 0) + 1
                             when v_campos ? 'num_visitas'        then (v_campos->>'num_visitas')::int
                             else p.num_visitas end,
    fecha_visita      = case when v_campos ? 'fecha_visita'      then (v_campos->>'fecha_visita')::timestamptz    else p.fecha_visita      end,
    notas             = case when v_campos ? 'notas'             then  v_campos->>'notas'                         else p.notas             end,
    score             = case when v_campos ? 'score'             then (v_campos->>'score')::int                   else p.score             end,
    motivo_descarte   = case when v_campos ? 'motivo_descarte'   then  v_campos->>'motivo_descarte'               else p.motivo_descarte   end,
    fecha_descarte    = case when v_campos ? 'fecha_descarte'    then (v_campos->>'fecha_descarte')::timestamptz  else p.fecha_descarte    end,
    contacto_nombre   = case when v_campos ? 'contacto_nombre'   then  v_campos->>'contacto_nombre'               else p.contacto_nombre   end,
    contacto_telefono = case when v_campos ? 'contacto_telefono' then  v_campos->>'contacto_telefono'             else p.contacto_telefono end,
    id_vendedor       = v_id_vend,
    nombre_vendedor   = (select v.nombre from public.vendedores v where v.id = v_id_vend)
  where p.id = v_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Prospecto no encontrado');
  end if;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;
