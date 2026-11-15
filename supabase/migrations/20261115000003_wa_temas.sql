-- ============================================================================
--  Temas del agente, con su alcance — editables desde /agente
--
--  IDEA DE ABRAHAM (15 nov 2026): «definir temas y el alcance de cada uno».
--
--  QUE RESUELVE. Hoy «las recetas se contestan en 2-3 frases» esta escrito en el
--  codigo, asi que afinarlo depende de un despliegue. Como temas en la base, lo
--  mueve el.
--
--  LA LINEA QUE NO SE CRUZA: el prompt entero NO va a la base. Hay frases ahi
--  que son invariantes de seguridad -«nunca calcules un total», «el nivel lo
--  pone el servidor»- y lo que se puede editar desde una pantalla se puede
--  romper desde una pantalla. Esas se quedan en el repo, donde pasan por seis
--  pruebas y por el CI. Los temas van ENCIMA, nunca en lugar de ellas.
--
--  EL ALCANCE ES LISTA CERRADA, no texto libre: cuatro valores que el codigo
--  sabe traducir a una instruccion. Si fuera texto libre, cada tema seria un
--  parrafo nuevo sin revisar llegando a un cliente, que es justo lo que se
--  queria evitar dejando el prompt fuera.
--
--  EL TOPE DE 12 TAMBIEN ES A PROPOSITO: cada tema son tokens en CADA mensaje,
--  y un prompt con cuarenta reglas se cumple peor que uno con diez. El limite
--  protege de las dos cosas.
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

create table if not exists public.wa_temas (
  id            bigserial primary key,
  tema          text not null,
  -- responde : contesta normal, con herramientas si hacen falta
  -- breve    : 2-3 frases y vuelve al negocio, SIN herramientas
  -- deriva   : lo pasa con el equipo (necesita avisar_a configurado)
  -- no       : no entra, redirige al catalogo
  alcance       text not null check (alcance in ('responde', 'breve', 'deriva', 'no')),
  nota          text,                      -- una linea opcional de matiz
  ejemplos      text,                      -- como lo pide un cliente, separado por |
  activo        boolean not null default true,
  orden         integer not null default 100,
  creado_en     timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create unique index if not exists wa_temas_tema_unico on public.wa_temas (lower(trim(tema)));

-- Cerrada por RLS y sin politicas: la llave publica no lee ni escribe una fila.
-- Se entra solo por los RPC de abajo (reglas 41 y 37).
alter table public.wa_temas enable row level security;
revoke all on public.wa_temas from anon, authenticated;
revoke all on sequence public.wa_temas_id_seq from anon, authenticated;

-- Los temas con los que arranca: son EXACTAMENTE las decisiones ya tomadas,
-- escritas hasta ahora en el prompt. Asi el comportamiento no cambia al
-- desplegar esto; lo unico que cambia es quien puede editarlo.
insert into public.wa_temas (tema, alcance, nota, ejemplos, orden)
select * from (values
  ('Precios y sabores',   'responde', 'Usa el catalogo. Nunca cites precios de memoria.',
     'a como la de 100g|que sabores tienen', 10),
  ('Pedidos y entregas',  'responde', 'Usa mis_pedidos y fecha_entrega.',
     'donde va mi pedido|cuando me entregan', 20),
  ('Recetas y cocina',    'breve',    'Es comida: no cortes en seco, pero no des la receta entera.',
     'como hago chilaquiles|con que acompano', 30),
  ('Quejas y reclamos',   'deriva',   'Recoge el folio y que paso. No prometas solucion ni plazo.',
     'no me llego|me cobraron de mas', 40),
  ('Cancelar o cambiar',  'deriva',   'NUNCA lo hagas tu: mueve lote, caja, puntos y reembolsos.',
     'cancelame el pedido|cambiame la direccion', 50),
  ('Vender en mi tienda', 'deriva',   'Es una oportunidad de negocio: pasala con nombre y zona.',
     'quiero vender sus papas|son distribuidores', 60),
  ('Trabajo y vacantes',  'deriva',   null, 'hay vacantes|buscan repartidores', 70),
  ('Fuera del negocio',   'no',       'Politica, salud, consejos personales. Redirige al catalogo.',
     null, 80)
) as t(tema, alcance, nota, ejemplos, orden)
 where not exists (select 1 from public.wa_temas);

-- ── Lectura para el agente ──────────────────────────────────────────────────
-- Solo los activos y en orden. La usa api/whatsapp.js con la llave de servicio.
create or replace function public.wa_temas_vigentes()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'tema', tema, 'alcance', alcance, 'nota', nota, 'ejemplos', ejemplos)
         order by orden, id), '[]'::jsonb)
    from public.wa_temas where activo;
$$;

revoke all on function public.wa_temas_vigentes() from public, anon, authenticated;
grant execute on function public.wa_temas_vigentes() to service_role;

-- ── Escritura desde /agente ─────────────────────────────────────────────────
-- Declarativa, como set_rutas: llega la lista entera y se reemplaza. Mas simple
-- de razonar que altas y bajas sueltas, y deja el estado final a la vista.
create or replace function public.set_wa_temas(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_temas jsonb := coalesce(p_data->'temas', '[]'::jsonb);
  v_t     jsonb;
  v_i     integer := 0;
  v_vistos text[] := '{}';
  v_clave  text;
begin
  if not public.sesion_es_dueno(p_data->>'token') then
    return jsonb_build_object('ok', false, 'error', 'No autorizado');
  end if;
  if jsonb_typeof(v_temas) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'temas_no_es_lista');
  end if;
  -- El tope vive AQUI y no solo en la pantalla: un limite que solo existe en el
  -- formulario es una sugerencia.
  if jsonb_array_length(v_temas) > 12 then
    return jsonb_build_object('ok', false, 'error', 'demasiados_temas', 'max', 12);
  end if;

  for v_t in select * from jsonb_array_elements(v_temas) loop
    v_i := v_i + 1;
    if coalesce(trim(v_t->>'tema'), '') = '' then
      return jsonb_build_object('ok', false, 'error', 'tema_sin_nombre', 'fila', v_i);
    end if;
    if coalesce(v_t->>'alcance', '') not in ('responde', 'breve', 'deriva', 'no') then
      return jsonb_build_object('ok', false, 'error', 'alcance_invalido',
        'fila', v_i, 'tema', v_t->>'tema');
    end if;
    -- Dos temas con el mismo nombre dejarian al modelo con dos reglas para lo
    -- mismo; se rechaza aqui en vez de dejar que gane la ultima.
    v_clave := lower(trim(v_t->>'tema'));
    if v_clave = any(v_vistos) then
      return jsonb_build_object('ok', false, 'error', 'tema_repetido', 'tema', v_t->>'tema');
    end if;
    v_vistos := v_vistos || v_clave;
  end loop;

  -- El `where` NO sobra: PostgREST corre con la proteccion `safeupdate`, que
  -- rechaza un DELETE sin WHERE con 21000. Por CLI funcionaba -otra sesion- y
  -- fallaba desde la pagina, que es donde importa. Visto el 15 nov 2026.
  delete from public.wa_temas where id is not null;
  insert into public.wa_temas (tema, alcance, nota, ejemplos, activo, orden)
  select trim(x->>'tema'), x->>'alcance', nullif(trim(coalesce(x->>'nota', '')), ''),
         nullif(trim(coalesce(x->>'ejemplos', '')), ''),
         coalesce((x->>'activo')::boolean, true), (n * 10)
    from jsonb_array_elements(v_temas) with ordinality as e(x, n);

  return jsonb_build_object('ok', true, 'temas', public.wa_temas_vigentes(),
    'guardados', jsonb_array_length(v_temas));
end;
$$;

revoke all on function public.set_wa_temas(jsonb) from public;
grant execute on function public.set_wa_temas(jsonb) to anon, authenticated, service_role;

comment on table public.wa_temas is
  'Temas del agente de WhatsApp y su alcance, editables en /agente. El alcance es lista cerrada '
  '(responde|breve|deriva|no) a proposito: texto libre seria un parrafo sin revisar llegando a un '
  'cliente. Los invariantes de seguridad siguen en el prompt del repo, no aqui.';

-- La pantalla necesita los temas y el catalogo de alcances. Se anaden a
-- wa_agente_admin para que /agente siga cargando todo en UNA llamada.
create or replace function public.wa_temas_admin(p_token text)
returns jsonb
language sql
-- SIN `stable`, y no es un olvido: `sesion_es_dueno` llama a
-- resolver_sesion_vendedor, que hace UPDATE de `ultimo_uso`. PostgREST ejecuta
-- las funciones `stable` en transaccion de SOLO LECTURA, asi que con stable
-- esto devuelve 25006 "cannot execute UPDATE in a read-only transaction".
-- Paso identico con `radar_informe` en noviembre y se repitio aqui el 15 nov:
-- cualquier funcion que valide sesion NO puede ser stable.
security definer
set search_path = public, pg_temp
as $$
  select case when public.sesion_es_dueno(p_token) then
    jsonb_build_object(
      'ok', true,
      'temas', coalesce((select jsonb_agg(jsonb_build_object(
                 'tema', tema, 'alcance', alcance, 'nota', nota,
                 'ejemplos', ejemplos, 'activo', activo) order by orden, id)
                 from public.wa_temas), '[]'::jsonb),
      'alcances', jsonb_build_array('responde', 'breve', 'deriva', 'no'),
      'max', 12)
  else jsonb_build_object('ok', false, 'error', 'No autorizado') end;
$$;

revoke all on function public.wa_temas_admin(text) from public;
grant execute on function public.wa_temas_admin(text) to anon, authenticated, service_role;
