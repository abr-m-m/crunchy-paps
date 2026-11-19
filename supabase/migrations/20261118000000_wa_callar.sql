-- ============================================================================
--  El agente se calla al pasar con una persona
--
--  Diseno: cambios/2026-11-18-wa-callar-al-escalar.md
--
--  `pasar_con_una_persona` existe desde el 15 nov 2026 y avisa bien, pero el
--  agente SIGUE CONTESTANDO despues de avisar. O sea: le dice al cliente «te
--  paso con el equipo» y acto seguido vuelve a atenderlo el mismo robot. Es
--  justo lo que su propio prompt tiene prohibido —no prometer lo que no se
--  cumple— y llevaba asi desde que la herramienta nacio.
--
--  La columna `bloqueado` ya existia (migracion 20261113000000) y el handler ya
--  la respeta, pero NADIE LA ESCRIBE NUNCA. El silencio funcionaba; lo que no
--  habia era quien lo encendiera.
--
--  D1 — SE CALLA POR TIEMPO, NO PARA SIEMPRE. Un numero de la Cloud API no se
--  abre en el telefono, asi que no hay bandeja donde Abraham conteste desde el
--  numero del agente: el contesta desde su WhatsApp personal. Si el silencio
--  fuera permanente y ese dia no contestara, el cliente se quedaria hablando
--  con una pared — peor que una respuesta imperfecta. El silencio caduca solo.
--
--  D2 — `bloqueado` NO SE TOCA. Sigue siendo el mudo manual y permanente, un
--  UPDATE a mano para una conversacion que hay que apagar del todo. Son dos
--  cosas distintas y compartir interruptor haria que apagar a alguien para
--  siempre y pasarlo con una persona fueran lo mismo.
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

-- ── 1. Hasta cuando esta callada una conversacion ───────────────────────────
-- NULL = no esta callada. Una fecha en el pasado tampoco calla: el codigo
-- compara contra now(), no mira si hay valor.
alter table public.wa_conversaciones
  add column if not exists callado_hasta timestamptz;

comment on column public.wa_conversaciones.callado_hasta is
  'Hasta cuando el agente no contesta esta conversacion, tras pasarla con una '
  'persona. NULL o pasado = contesta. Distinto de `bloqueado`, que es el mudo '
  'manual y permanente.';

-- ── 2. `callar_horas` entra en los rangos ───────────────────────────────────
-- wa_rangos es la UNICA fuente de los limites: `set_wa_ajustes` recorre sus
-- claves para validar, y `wa_agente_admin` las devuelve para pintar el
-- formulario. Asi que anadir la clave aqui basta para que el ajuste se pueda
-- guardar, se valide y aparezca — sin tocar ninguna de las dos funciones.
-- Una copia que nadie compara, miente (regla 63): por eso no hay una segunda
-- lista de rangos en ningun sitio.
--
-- 1 a 72 horas. El minimo es 1 porque callarse menos de una hora no le da
-- tiempo a nadie a contestar; el maximo son tres dias, que ya es demasiado
-- para que un cliente espere sin que nadie le escriba.
create or replace function public.wa_rangos()
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'tope_por_numero',  jsonb_build_array(1, 500),
    'tope_global',      jsonb_build_array(1, 5000),
    'max_turnos',       jsonb_build_array(2, 100),
    'max_vueltas',      jsonb_build_array(1, 12),
    'max_lineas',       jsonb_build_array(1, 50),
    'max_piezas_linea', jsonb_build_array(1, 100000),
    'avisos_por_dia',   jsonb_build_array(0, 50),
    'callar_horas',     jsonb_build_array(1, 72)
  );
$$;

grant execute on function public.wa_rangos() to anon, authenticated, service_role;
