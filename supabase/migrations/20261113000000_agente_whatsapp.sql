-- 20261113000000_agente_whatsapp.sql
-- Agente de WhatsApp: identidad, hilo de conversacion y auditoria.
-- Diseno: cambios/2026-11-12-agente-whatsapp.md · Plan: ...-plan.md, tarea 1.
--
-- No toca nada existente: una funcion nueva y dos tablas nuevas.

-- ── T1. wa_identidad ────────────────────────────────────────────────────────
-- Una sola verdad sobre "quien escribe y a que precio".
--
-- La regla de emparejado (ultimos 10 digitos, sin separadores) y la tabla de
-- tipo_id son LAS MISMAS que usa crear_pedido en
-- 20260930000008_ingreso_bruto_neto.sql:124-134. Estan aqui, y no en el
-- JavaScript de api/whatsapp.js, para que no haya dos copias que se separen en
-- silencio: si se separaran, el agente cotizaria a un nivel y el servidor crearia
-- el pedido a otro (D5 del diseno).
--
-- buscar_cliente_telefono NO sirve para esto: devuelve `tipo` (texto) pero ni
-- tipo_id ni aprobado_b2b, que son los dos campos de los que depende el precio.
create or replace function public.wa_identidad(p_telefono text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tel text := right(regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g'), 10);
  v_cli clientes%rowtype;
begin
  if length(v_tel) <> 10 then
    return jsonb_build_object('ok', false, 'error', 'telefono_invalido');
  end if;

  select * into v_cli from clientes
   where right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) = v_tel
   limit 1;

  if v_cli.id is null then
    -- No es un error: es alguien que escribe por primera vez. Consumidor.
    return jsonb_build_object(
      'ok', true, 'esCliente', false, 'idCliente', null, 'nombre', null,
      'nivel', 'consumidor', 'aprobadoB2B', false, 'idRuta', null);
  end if;

  return jsonb_build_object(
    'ok', true,
    'esCliente', true,
    'idCliente', v_cli.id,
    'nombre', v_cli.nombre,
    'aprobadoB2B', coalesce(v_cli.aprobado_b2b, false),
    'idRuta', v_cli.id_ruta,
    'nivel', case
      when not coalesce(v_cli.aprobado_b2b, false) then 'consumidor'
      when v_cli.tipo_id = 2 then 'restaurante'
      when v_cli.tipo_id = 3 then 'tienda'
      when v_cli.tipo_id = 4 then 'mayorista'
      else 'consumidor'
    end
  );
end;
$$;

-- Regla 42: una funcion nueva concede EXECUTE a PUBLIC por defecto. Se revoca:
-- solo la alcanza la llave de servicio, que es con la que corre api/whatsapp.js.
revoke all on function public.wa_identidad(text) from public, anon, authenticated;

-- ── T2. Hilo de conversacion ────────────────────────────────────────────────
-- Un hilo por telefono, podado a los ultimos turnos por el codigo de la funcion.
create table if not exists public.wa_conversaciones (
  telefono        text primary key,
  hilo            jsonb       not null default '[]'::jsonb,
  actualizado_en  timestamptz not null default now(),
  bloqueado       boolean     not null default false
);

-- RLS activa y CERO politicas, a proposito: ni anon ni authenticated leen ni
-- escriben una sola fila. Solo la llave de servicio, que no pasa por RLS.
-- Las dos cerraduras, no una (regla 41): RLS arriba, GRANT abajo.
alter table public.wa_conversaciones enable row level security;
revoke all on table public.wa_conversaciones from anon, authenticated;

-- ── T3. Auditoria, solo-INSERT ──────────────────────────────────────────────
-- Sin esto, lo que dijo el agente vive en el telefono del cliente y en ningun
-- otro sitio. Hace falta para poder leerlo despues, cuando algo salga raro.
create table if not exists public.wa_mensajes (
  id           bigserial primary key,
  telefono     text        not null,
  direccion    text        not null check (direccion in ('entra', 'sale')),
  texto        text,
  herramientas jsonb,
  tokens       integer,
  fecha        timestamptz not null default now()
);

alter table public.wa_mensajes enable row level security;
revoke all on table public.wa_mensajes from anon, authenticated;

-- El indice por (telefono, fecha) es el que usan los dos topes de gasto; el de
-- fecha sola, el tope global.
create index if not exists ix_wa_mensajes_tel_fecha on public.wa_mensajes (telefono, fecha desc);
create index if not exists ix_wa_mensajes_fecha     on public.wa_mensajes (fecha desc);
