-- ============================================================================
--  Quien escribe por WhatsApp y no es cliente, queda registrado
--
--  Diseno: cambios/2026-11-18-wa-prospecto.md
--
--  Hoy un numero desconocido escribe, el agente lo atiende bien, y **no queda
--  en ningun lado**: `wa_identidad` devuelve `esCliente: false` y ahi muere.
--  Los mensajes se guardan en `wa_mensajes`, pero eso es un log, no un lead:
--  nadie abre esa tabla para planear a quien visitar. Y el plan del negocio es
--  llegar a tienditas.
--
--  D1 — VA A `prospectos`, la tabla que ya existe, y no a una nueva. Es donde
--  se trabaja de verdad: prospeccion, ruta del dia, planeador. Un lead en una
--  tabla que solo consulta Claude no es un lead, es un registro.
--
--  D2 — SIN DIRECCION NO ENTRA A NINGUNA RUTA, Y ESO ES A PROPOSITO. Medido en
--  produccion el 18 nov 2026: `ruta_para(null, null)` devuelve **null**, y
--  `ruta_del_dia` filtra con `where ruta_para(cp, colonia) = v_ruta.id`, que
--  con null nunca es verdadero. Asi que un consumidor que pregunto por sabores
--  NO aparece en la ruta de nadie — y el dia que alguien le ponga un CP, entra
--  solo, que es justo lo que se quiere. No hace falta un estatus especial para
--  apartarlo, y por eso no se inventa uno: el estatus se queda en 'pendiente',
--  como cualquier prospecto.
--
--  D3 — UN NUMERO QUE YA ES PROSPECTO NO SE DUPLICA: SE MARCA. Y ese es el caso
--  que mas vale, no el desconocido nuevo — es **una de las 1,129 tienditas de
--  la lista fria levantando la mano**. Se estampan dos columnas nuevas y NO SE
--  TOCA NADA MAS: ni `notas` (misma razon por la que `registrar_visita` no las
--  toca: son de quien las escribio), ni `estatus`, ni `score`, ni el vendedor
--  asignado, ni `origen` — que sigue diciendo de donde salio el prospecto, no
--  por donde escribio.
--
--  D4 — EL EMPAREJADO ES POR LOS ULTIMOS 10 DIGITOS, la misma regla que
--  `wa_identidad`. Si fuera otra, el mismo telefono seria dos personas
--  distintas segun quien pregunte.
--
--  Aplicar: staging primero, probar, produccion con aprobacion aparte.
-- ============================================================================

-- ── 1. Cuando escribio por WhatsApp ─────────────────────────────────────────
-- Dos columnas y no una: `primer_wa_en` no se vuelve a tocar nunca (es cuando
-- esta persona aparecio por primera vez), y `ultimo_wa_en` dice si sigue viva.
-- Con una sola se pierde una de las dos preguntas.
alter table public.prospectos
  add column if not exists primer_wa_en timestamptz,
  add column if not exists ultimo_wa_en timestamptz;

comment on column public.prospectos.primer_wa_en is
  'La primera vez que este telefono escribio al agente de WhatsApp. No se '
  'vuelve a escribir una vez puesta.';
comment on column public.prospectos.ultimo_wa_en is
  'La ultima vez que escribio. Se actualiza en cada mensaje.';

-- ── 2. El registro ──────────────────────────────────────────────────────────
create or replace function public.wa_prospecto(p_telefono text, p_nombre text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tel   text := right(regexp_replace(coalesce(p_telefono, ''), '[^0-9]', '', 'g'), 10);
  v_nom   text := nullif(btrim(coalesce(p_nombre, '')), '');
  v_id    bigint;
  v_nuevo boolean := false;
begin
  if length(v_tel) <> 10 then
    return jsonb_build_object('ok', false, 'error', 'telefono_invalido');
  end if;

  -- Un cliente no es un prospecto. `wa_identidad` ya lo sabe, pero esta funcion
  -- no depende de que quien la llame se acuerde de preguntar: la condicion se
  -- comprueba aqui, con la MISMA regla de los 10 digitos.
  if exists (select 1 from public.clientes
              where right(regexp_replace(coalesce(telefono, ''), '[^0-9]', '', 'g'), 10) = v_tel) then
    return jsonb_build_object('ok', true, 'esCliente', true, 'idProspecto', null, 'nuevo', false);
  end if;

  select id into v_id from public.prospectos
   where right(regexp_replace(coalesce(contacto_telefono, ''), '[^0-9]', '', 'g'), 10) = v_tel
   order by id
   limit 1;

  if v_id is null then
    -- `nombre_negocio` es NOT NULL y no sabemos el negocio: va el nombre del
    -- perfil de WhatsApp, que Meta manda en el webhook. Si no viene, el
    -- telefono. NO se inventa un nombre de negocio que luego alguien lea como
    -- si fuera real.
    insert into public.prospectos (nombre_negocio, contacto_nombre, contacto_telefono,
                                   origen, primer_wa_en, ultimo_wa_en)
    values (coalesce(v_nom, 'WhatsApp ' || v_tel), v_nom, v_tel,
            'whatsapp', now(), now())
    returning id into v_id;
    v_nuevo := true;
  else
    -- D3: solo las dos fechas. Lo demas es de quien lo escribio.
    update public.prospectos
       set primer_wa_en        = coalesce(primer_wa_en, now()),
           ultimo_wa_en        = now(),
           fecha_actualizacion = now()
     where id = v_id;
  end if;

  return jsonb_build_object('ok', true, 'esCliente', false,
                            'idProspecto', v_id, 'nuevo', v_nuevo);
end;
$$;

-- Regla 42: una funcion nueva concede EXECUTE a PUBLIC por defecto. Se revoca:
-- solo la alcanza la llave de servicio, que es con la que corre api/whatsapp.js.
-- Esta escribe en `prospectos`, asi que dejarla abierta a `anon` seria un
-- endpoint publico que crea filas (regla 28).
revoke all on function public.wa_prospecto(text, text) from public, anon, authenticated;
grant execute on function public.wa_prospecto(text, text) to service_role;
