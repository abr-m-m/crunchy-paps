-- ============================================================================
--  wa_crear_pedido — el agente de WhatsApp levanta pedidos SIN llevar credencial
--
--  POR QUE EXISTE. `crear_pedido` exige un `token` que resuelve contra
--  `sesiones_vendedor` con `expira_en > now()`, y esas sesiones duran DOCE HORAS.
--  Medido en produccion el 14 nov 2026: 4 sesiones en total, cero vivas, la
--  ultima caducada en octubre. Un WA_VENDEDOR_TOKEN fijo en Vercel habria
--  funcionado media jornada y despues `sesion_requerida` para siempre — la misma
--  trampa del token de Meta, que tambien parecia resuelto y caducaba en una hora.
--
--  LO QUE HACE. Abre una sesion de vendedor que vive DENTRO de la transaccion,
--  llama a crear_pedido y la borra. El token no existe fuera de aqui: no esta en
--  Vercel, ni en el repo, ni en un log. El agente se autoriza con lo que ya tiene
--  por necesidad —la llave de servicio— y no gana un permiso nuevo.
--
--  Y DE PASO BLINDA D6. El nivel de precio se resuelve AQUI, desde el telefono,
--  con wa_identidad. Lo que mande el cliente HTTP en `tipoCliente` se pisa con el
--  operador `||`. Antes, que una tienda no comprara a precio de mayorista
--  dependia de que una linea de api/whatsapp.js dijera `id.nivel`; ahora no
--  depende de Node en absoluto. El unico punto de fallo del diseno deja de estar
--  en el sitio mas facil de tocar.
--
--  Aplicar: staging primero, probar, y produccion con aprobacion aparte.
-- ============================================================================

-- ── El vendedor del agente ──────────────────────────────────────────────────
-- Uno propio, no Abraham: para que los pedidos se distingan en el panel y para
-- que la sesion efimera no cargue con permisos de administrador. Rol 'Vendedor',
-- el mas bajo que existe. `pin_hash` NULL a proposito: esta cuenta NO inicia
-- sesion por PIN, asi que no hay PIN que adivinar ni que filtrar.
insert into public.vendedores (nombre, rol, activo, fecha_alta, secciones)
select 'Agente WhatsApp', 'Vendedor', true, now(), array['pedidos']::text[]
 where not exists (select 1 from public.vendedores where nombre = 'Agente WhatsApp');

create or replace function public.wa_crear_pedido(p_telefono text, p_data jsonb)
returns jsonb
language plpgsql
security definer
-- search_path fijo: un SECURITY DEFINER con search_path mutable es escalable
-- (regla 43).
set search_path = public, pg_temp
as $$
declare
  v_ident jsonb;
  v_nivel text;
  v_vend  bigint;
  v_rol   text;
  v_token text;
  v_hash  text;
  v_res   jsonb;
begin
  -- 1) La identidad sale del TELEFONO, aqui dentro. El telefono lo verifico Meta
  --    al firmar el webhook; el nivel no viaja nunca desde fuera.
  v_ident := public.wa_identidad(p_telefono);
  if coalesce(v_ident->>'ok', 'false') <> 'true' then
    return jsonb_build_object('ok', false, 'error', 'identidad_invalida');
  end if;
  v_nivel := v_ident->>'nivel';

  -- 2) Cerrado por omision: solo estos tres levantan pedido por WhatsApp. La
  --    lista va aqui y no en el prompt, porque un permiso que vive en una frase
  --    no es un permiso (regla 35). Y se decide por NIVEL, no por el flag
  --    aprobado_b2b, que se contradice con el tipo en clientes reales.
  if v_nivel not in ('tienda', 'restaurante', 'mayorista') then
    return jsonb_build_object('ok', false, 'error', 'no_puede_pedir');
  end if;

  select v.id, v.rol into v_vend, v_rol
    from public.vendedores v
   where v.nombre = 'Agente WhatsApp' and coalesce(v.activo, true)
   limit 1;
  if v_vend is null then
    return jsonb_build_object('ok', false, 'error', 'sin_vendedor_agente');
  end if;

  -- 3) La sesion efimera. gen_random_bytes, no un contador ni algo derivado del
  --    reloj: Math.random() y sus parientes no sirven para una credencial
  --    (regla 46). Un minuto de vida y, aun asi, se borra abajo: el minuto es
  --    por si algo revienta de un modo que no habiamos pensado, no el plan.
  -- Calificadas con su esquema: pgcrypto vive en `extensions`, y con el
  -- search_path fijo de arriba no se alcanza por nombre corto. PL/pgSQL no
  -- valida nombres al CREAR la funcion (regla 22), asi que esto se creo sin
  -- una queja y reventaba al ejecutarse. Lo caza crear un pedido de verdad,
  -- no leer el 'aplicada' del CLI.
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash  := encode(extensions.digest(v_token, 'sha256'), 'hex');

  insert into public.sesiones_vendedor
    (token_hash, id_vendedor, rol, creada_en, expira_en, revocada, user_agent)
  values
    (v_hash, v_vend, v_rol, now(), now() + interval '1 minute', false, 'wa-agente');

  -- 4) El pedido. Las claves de la derecha PISAN a las que mando el cliente
  --    HTTP: aunque api/whatsapp.js mandara tipoCliente 'mayorista' para una
  --    tienda, aqui se corrige. `total` NO se pisa: ese viene de la cotizacion y
  --    es lo que crear_pedido compara para detectar precio_cambiado.
  v_res := public.crear_pedido(
    p_data || jsonb_build_object(
      'token',         v_token,
      'tipoCliente',   v_nivel,
      'idCliente',     v_ident->'idCliente',
      'nombreCliente', coalesce(nullif(v_ident->>'nombre', ''), p_data->>'nombreCliente'),
      'telefono',      p_telefono,
      'canal',         'whatsapp',
      'idVendedor',    v_vend,
      'nombreVendedor','Agente WhatsApp'
    ));

  -- 5) La sesion muere aqui. Si crear_pedido hubiera lanzado, la transaccion
  --    entera se revierte y el INSERT de arriba tampoco queda: por los dos
  --    caminos, el token no sobrevive a esta llamada.
  delete from public.sesiones_vendedor where token_hash = v_hash;

  return v_res;
end;
$$;

-- Dos cerraduras, no una (regla 41), y una funcion nueva concede EXECUTE a
-- PUBLIC por defecto (regla 42): hay que quitarlo explicitamente.
revoke all on function public.wa_crear_pedido(text, jsonb) from public, anon, authenticated;
grant execute on function public.wa_crear_pedido(text, jsonb) to service_role;

comment on function public.wa_crear_pedido(text, jsonb) is
  'Pedido desde el agente de WhatsApp. El nivel de precio se resuelve del telefono '
  'con wa_identidad y PISA lo que venga en p_data. La sesion de vendedor vive solo '
  'dentro de esta transaccion. Solo service_role.';
