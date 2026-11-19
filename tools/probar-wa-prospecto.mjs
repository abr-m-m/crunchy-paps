#!/usr/bin/env node
// tools/probar-wa-prospecto.mjs — wa_prospecto (20261118000001).
//
// ESCRIBE EN STAGING (dkwatbsaidlfjqjnfyrk) y limpia lo suyo al terminar.
// Corre el SQL con la CLI de Supabase, no por PostgREST: la llave de servicio
// no se puede sacar del CLI y esta funcion solo la alcanza `service_role`.
//
// Lo que vigila, y por que cada cosa:
//
//   - QUE NO DUPLIQUE. El caso que mas vale no es el desconocido nuevo: es una
//     de las 1,129 tienditas de la lista fria escribiendo por WhatsApp. Si eso
//     creara una fila nueva, la tiendita quedaria partida en dos y la ruta
//     visitaria a una de las mitades.
//
//   - QUE NO PISE LO AJENO. A un prospecto que ya existe se le tocan DOS fechas
//     y nada mas: ni `notas`, ni `estatus`, ni `score`, ni el vendedor. Esta
//     prueba los guarda antes y los compara despues, uno por uno.
//
//   - QUE NO SE CUELE EN LA RUTA DEL DIA. Un prospecto sin direccion no puede
//     aparecer en la ruta de nadie, porque `ruta_para(null, null)` es null y
//     `ruta_del_dia` filtra por igualdad. Esa es la propiedad que hace seguro
//     meter consumidores en la misma tabla que las tienditas, asi que se mide
//     en vez de suponerse.
//
// Diseno: cambios/2026-11-18-wa-prospecto.md
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STG = 'dkwatbsaidlfjqjnfyrk';
const dir = mkdtempSync(join(tmpdir(), 'wa-prospecto-'));

let fallos = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

// La CLI toma la consulta por archivo: pasarla como argumento rompe en cuanto
// empieza por un comentario `--`, que la CLI lee como bandera.
function sql(q) {
  const f = join(dir, 'q.sql');
  writeFileSync(f, q, 'utf8');
  const salida = execFileSync('supabase',
    ['db', 'query', '--linked', '--project-ref', STG, '-f', f],
    { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const i = salida.indexOf('{');
  const j = salida.lastIndexOf('}');
  const cuerpo = JSON.parse(salida.slice(i, j + 1).replace(/,\s*\n\}/, '\n}'));
  if (cuerpo.error) throw new Error(JSON.stringify(cuerpo.error));
  return cuerpo.rows || [];
}
const una = (q) => sql(q)[0];

// Los tres telefonos de mentira. Cola de 10 digitos, que es con lo que empareja.
const NUEVO    = '5215599900001';   // nunca ha existido
const SIN_NOMBRE = '5215599900002'; // escribe sin nombre de perfil
const YA_FRIO  = '5215599900003';   // ya es prospecto de la lista fria
const COLAS = "('5599900001','5599900002','5599900003')";

function limpiar() {
  sql(`delete from prospectos
        where right(regexp_replace(coalesce(contacto_telefono,''),'[^0-9]','','g'),10) in ${COLAS};`);
}

try {
  limpiar();

  console.log('\nCaso 1 — un numero que nunca habia escrito');
  {
    const r = una(`select public.wa_prospecto('${NUEVO}', 'Abarrotes Lupita') as j;`).j;
    ok(r.ok === true, 'ok = true');
    ok(r.esCliente === false, 'no es cliente');
    ok(r.nuevo === true, 'lo marca como NUEVO');
    ok(Number.isFinite(Number(r.idProspecto)), `devuelve el id (${r.idProspecto})`);

    const p = una(`select nombre_negocio, contacto_nombre, contacto_telefono, origen, estatus,
                          score, primer_wa_en is not null as tiene_primero,
                          ultimo_wa_en is not null as tiene_ultimo
                     from prospectos where id = ${r.idProspecto};`);
    ok(p.nombre_negocio === 'Abarrotes Lupita', `nombre_negocio = ${p.nombre_negocio}`);
    ok(p.contacto_nombre === 'Abarrotes Lupita', 'y tambien el nombre de contacto');
    ok(p.contacto_telefono === '5599900001', `el telefono se guarda a 10 digitos (${p.contacto_telefono})`);
    ok(p.origen === 'whatsapp', 'origen = whatsapp');
    ok(p.estatus === 'pendiente', 'estatus = pendiente, como cualquier prospecto (D2)');
    ok(p.tiene_primero && p.tiene_ultimo, 'quedan puestas las dos fechas');
  }

  console.log('\nCaso 2 — el MISMO numero escribe otra vez: no se duplica');
  {
    const antes = una(`select id, primer_wa_en::text as primero, ultimo_wa_en::text as ultimo
                         from prospectos
                        where right(regexp_replace(contacto_telefono,'[^0-9]','','g'),10) = '5599900001';`);
    const r = una(`select public.wa_prospecto('${NUEVO}', 'Abarrotes Lupita') as j;`).j;
    ok(r.nuevo === false, 'ya NO es nuevo');
    ok(String(r.idProspecto) === String(antes.id), 'devuelve el MISMO id');

    const n = una(`select count(*)::int as n from prospectos
                    where right(regexp_replace(contacto_telefono,'[^0-9]','','g'),10) = '5599900001';`).n;
    ok(n === 1, `sigue habiendo UNA sola fila (hay ${n})`);

    const d = una(`select primer_wa_en::text as primero, ultimo_wa_en >= '${antes.ultimo}'::timestamptz as avanzo
                     from prospectos where id = ${antes.id};`);
    ok(d.primero === antes.primero, 'primer_wa_en NO se volvio a escribir');
    ok(d.avanzo === true, 'ultimo_wa_en si avanzo');
  }

  console.log('\nCaso 3 — sin nombre de perfil, nombre_negocio no puede quedar nulo');
  {
    const r = una(`select public.wa_prospecto('${SIN_NOMBRE}', '') as j;`).j;
    const p = una(`select nombre_negocio, contacto_nombre from prospectos where id = ${r.idProspecto};`);
    ok(typeof p.nombre_negocio === 'string' && p.nombre_negocio.length > 0,
      `nombre_negocio = "${p.nombre_negocio}"`);
    ok(p.nombre_negocio.includes('5599900002'), 'y lleva el telefono, para poder reconocerlo');
    ok(p.contacto_nombre === null, 'el nombre de contacto si queda nulo: no se inventa');
  }

  console.log('\nCaso 4 — una tiendita de la lista fria escribe: se marca, NO se pisa');
  {
    const id = una(`insert into prospectos
        (nombre_negocio, contacto_telefono, notas, estatus, score, id_vendedor, nombre_vendedor,
         colonia, codigo_postal, origen)
      values ('Mini Super Don Chuy','5599900003','Dijo que lo piensa en enero','contactado',
              77, 1, 'Abraham', 'Santiago Norte', '08240', null)
      returning id;`).id;
    const antes = una(`select notas, estatus, score, id_vendedor, nombre_vendedor, colonia,
                              codigo_postal, origen from prospectos where id = ${id};`);

    const r = una(`select public.wa_prospecto('${YA_FRIO}', 'Chuy') as j;`).j;
    ok(r.nuevo === false, 'no la duplica');
    ok(String(r.idProspecto) === String(id), 'devuelve el id de la tiendita que ya existia');

    const n = una(`select count(*)::int as n from prospectos
                    where right(regexp_replace(contacto_telefono,'[^0-9]','','g'),10) = '5599900003';`).n;
    ok(n === 1, `sigue habiendo UNA sola fila (hay ${n})`);

    const d = una(`select notas, estatus, score, id_vendedor, nombre_vendedor, colonia,
                          codigo_postal, origen, primer_wa_en is not null as marcada
                     from prospectos where id = ${id};`);
    for (const campo of ['notas', 'estatus', 'score', 'id_vendedor', 'nombre_vendedor',
                         'colonia', 'codigo_postal', 'origen']) {
      ok(d[campo] === antes[campo],
        `${campo} intacto (${JSON.stringify(antes[campo])} -> ${JSON.stringify(d[campo])})`);
    }
    ok(d.marcada === true, 'y queda marcada la fecha del WhatsApp');
  }

  console.log('\nCaso 5 — un CLIENTE no se vuelve prospecto');
  {
    const c = una(`select telefono from clientes
                    where length(regexp_replace(coalesce(telefono,''),'[^0-9]','','g')) >= 10
                    order by id limit 1;`);
    if (!c) {
      ok(false, 'no hay ningun cliente en staging con telefono: el caso no se pudo probar');
    } else {
      const r = una(`select public.wa_prospecto('${c.telefono}', 'Quien sea') as j;`).j;
      ok(r.esCliente === true, 'lo reconoce como cliente');
      ok(r.idProspecto === null, 'y NO crea prospecto');
    }
  }

  console.log('\nCaso 6 — un telefono invalido no escribe nada');
  {
    const antes = una('select count(*)::int as n from prospectos;').n;
    for (const malo of ['', '123', 'hola', 'null']) {
      const r = una(`select public.wa_prospecto('${malo}', 'X') as j;`).j;
      ok(r.ok === false && r.error === 'telefono_invalido', `"${malo}" se rechaza`);
    }
    const d = una('select count(*)::int as n from prospectos;').n;
    ok(d === antes, `y no nacio ninguna fila (${antes} -> ${d})`);
  }

  console.log('\nCaso 7 — LO QUE HACE SEGURO EL DISENO: no entra a la ruta de nadie');
  {
    // Sin CP y sin colonia, `ruta_para` es null, y `ruta_del_dia` filtra con
    // `where ruta_para(...) = v_ruta.id`, que con null nunca es verdadero.
    const d = una(`select public.ruta_para(
                       nullif(regexp_replace(coalesce(codigo_postal,''),'[^0-9]','','g'),''),
                       colonia) as ruta
                     from prospectos
                    where right(regexp_replace(contacto_telefono,'[^0-9]','','g'),10) = '5599900001';`);
    ok(d.ruta === null, `el prospecto de WhatsApp no cae en ninguna ruta (dio ${d.ruta})`);

    const n = una(`select count(*)::int as n from rutas where activa;`).n;
    ok(n > 0, `y no es que no haya rutas: hay ${n} activas`);

    // La tiendita del caso 4 SI tiene CP, y por eso SI cae en una ruta: eso
    // prueba que el null de arriba viene de no tener direccion y no de que
    // `ruta_para` este rota.
    const t = una(`select public.ruta_para('08240', colonia) as ruta from prospectos
                    where right(regexp_replace(contacto_telefono,'[^0-9]','','g'),10) = '5599900003';`);
    ok(t.ruta !== null, `y una con CP si cae en una ruta (${t.ruta}): ruta_para no esta rota`);
  }
} finally {
  limpiar();
  const q = una(`select count(*)::int as n from prospectos
                  where right(regexp_replace(coalesce(contacto_telefono,''),'[^0-9]','','g'),10) in ${COLAS};`);
  console.log(`\nlimpieza: quedan ${q.n} filas de prueba`);
  if (q.n !== 0) fallos++;
  rmSync(dir, { recursive: true, force: true });
}

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
