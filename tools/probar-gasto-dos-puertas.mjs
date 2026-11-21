#!/usr/bin/env node
// tools/probar-gasto-dos-puertas.mjs — el gasto por dos puertas, un solo escritor.
//
// LO QUE DE VERDAD VIGILA ESTA PRUEBA, y son tres cosas:
//
//   1. QUE EL REFACTOR NO CAMBIO LA PUERTA VIEJA. `guardar_gasto` se partio en
//      dos para que la pantalla y WhatsApp no escriban cada una por su lado
//      (regla 63). Un refactor que "de paso" cambia el comportamiento esconde
//      el cambio dentro del movimiento y nadie lo ve.
//
//   2. QUE EL MODELO NO PUEDA APROBAR DINERO ESCRIBIENDO UN CAMPO. Mandar
//      `estatus: 'aprobado'` en los campos tiene que NO servir de nada. Si un
//      dia sirve, el agente puede aprobarse gastos solo.
//
//   3. QUE EL «SI» VALGA COMO APROBACION SOLO PARA QUIEN PUEDE APROBAR.
//      Mismo payload, dos personas, dos resultados.
//
// Escribe en STAGING y limpia lo que escribe. No toca produccion.
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wa = require('../api/whatsapp.js');

const STG = 'dkwatbsaidlfjqjnfyrk';
const dir = mkdtempSync(join(tmpdir(), 'gasto-'));
let fallos = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

function sql(q) {
  const f = join(dir, 'q.sql');
  writeFileSync(f, q, 'utf8');
  const out = execFileSync('supabase',
    ['db', 'query', '--linked', '--project-ref', STG, '-f', f],
    { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const c = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1).replace(/,\s*\n\}/, '\n}'));
  if (c.error) throw new Error(JSON.stringify(c.error));
  return (c.rows || [])[0];
}

// Ana es `Admin` pero no trae `gastos`; Diego trae `gastos` pero es
// `Administrador2`. Se le presta la seccion a Ana para tener las dos mitades,
// y se le quita al final: la prueba no deja el mundo distinto a como lo encontro.
const ANA = '5500000001';     // Admin          -> SI puede aprobar
const DIEGO = '5500000004';   // Administrador2 -> NO puede aprobar
const AJENO = '5500000003';   // Vendedor sin la seccion

try {
  sql("update vendedores set secciones = array_append(coalesce(secciones,array[]::text[]),'gastos') where id=1 and not ('gastos' = any(coalesce(secciones,array[]::text[])));");

  console.log('\nLas funciones existen y estan cerradas por omision');
  {
    const r = sql(`select
        (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='guardar_gasto_interno') interno,
        (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='wa_registrar_gasto') wa,
        has_function_privilege('anon','public.wa_registrar_gasto(jsonb)','execute') anon_wa,
        has_function_privilege('service_role','public.wa_registrar_gasto(jsonb)','execute') sr_wa;`);
    ok(Number(r.interno) === 1, 'existe `guardar_gasto_interno`');
    ok(Number(r.wa) === 1, 'existe `wa_registrar_gasto`');
    // Regla 42: una funcion nueva concede EXECUTE a PUBLIC por omision.
    ok(r.anon_wa === false, '`anon` NO la puede ejecutar');
    ok(r.sr_wa === true, '`service_role` si');
  }

  console.log('\nLa puerta vieja no cambio de comportamiento');
  {
    // Un campo fuera de la lista blanca se RECHAZA, no se ignora. Es lo que
    // hacia antes y lo que tiene que seguir haciendo.
    const r = sql(`select public.guardar_gasto_interno(1, true,
        '{"monto":"10","categoria":"Otros","colado":"x"}'::jsonb) as j;`).j;
    ok(r.ok === false && /Campo no permitido/.test(r.error || ''),
      'un campo fuera de la lista blanca se rechaza: ' + (r.error || ''));
  }
  {
    const r = sql(`select public.guardar_gasto_interno(1, true,
        '{"monto":"11.50","categoria":"Otros","descripcion":"prueba refactor"}'::jsonb) as j;`).j;
    ok(r.ok === true && r.creado === true, 'crea y devuelve `creado: true`');
    const f = sql(`select id_vendedor, nombre_vendedor, estatus, monto::text
                     from gastos where id = ${Number(r.id)};`);
    // El vendedor sale de QUIEN LLAMA, no del payload.
    ok(Number(f.id_vendedor) === 1, '`id_vendedor` sale de quien llama, no del payload');
    ok(f.estatus === 'pendiente', 'nace `pendiente` si nadie dice otra cosa');
    sql(`delete from gastos where id = ${Number(r.id)};`);
  }

  console.log('\nQuien no es del equipo, o no trae la seccion, no entra');
  {
    const a = sql(`select public.wa_registrar_gasto('{"telefono":"5215599999999",
        "campos":{"monto":"50","categoria":"Otros"}}'::jsonb) as j;`).j;
    ok(a.ok === false, 'un numero desconocido no puede registrar gastos');
    const b = sql(`select public.wa_registrar_gasto('{"telefono":"${AJENO}",
        "campos":{"monto":"50","categoria":"Otros"}}'::jsonb) as j;`).j;
    ok(b.ok === false && /permiso/i.test(b.error || ''),
      'un vendedor sin la seccion `gastos` tampoco: ' + (b.error || ''));
  }

  console.log('\nFaltando el monto o la categoria, no escribe');
  {
    const a = sql(`select public.wa_registrar_gasto('{"telefono":"${ANA}",
        "campos":{"categoria":"Otros"}}'::jsonb) as j;`).j;
    ok(a.ok === false && /monto/i.test(a.error || ''), 'sin monto: ' + (a.error || ''));
    const b = sql(`select public.wa_registrar_gasto('{"telefono":"${ANA}",
        "campos":{"monto":"0"}}'::jsonb) as j;`).j;
    ok(b.ok === false, 'monto cero tampoco');
  }

  console.log('');
  console.log('EL MODELO NO APRUEBA DINERO ESCRIBIENDO UN CAMPO (la que importa)');
  {
    // Esto es lo que intentaria un modelo que "ayuda": mandar el estatus ya
    // puesto. Tiene que no servir de nada.
    const r = sql(`select public.wa_registrar_gasto('{"telefono":"${ANA}",
        "campos":{"monto":"99","categoria":"Otros","estatus":"aprobado",
                  "aprobado_por":"el agente"}}'::jsonb) as j;`).j;
    ok(r.ok === true, 'el gasto se registra');
    const f = sql(`select estatus, coalesce(aprobado_por,'') ap from gastos where id = ${Number(r.id)};`);
    ok(f.estatus === 'pendiente',
      `el \`estatus\` que mando el modelo se ignoro (quedo '${f.estatus}')`);
    ok(f.ap === '', 'y `aprobado_por` quedo vacio, no "el agente"');
    sql(`delete from gastos where id = ${Number(r.id)};`);
  }

  console.log('');
  console.log('El «si» vale como aprobacion SOLO para quien puede aprobar');
  {
    // Mismo payload, dos personas. Ana es Admin; Diego es Administrador2 y
    // trae la seccion, pero no esta en la lista de quien aprueba -que es la
    // MISMA lista que usa la pantalla, no una nueva-.
    const a = sql(`select public.wa_registrar_gasto('{"telefono":"${ANA}","aprobar":true,
        "campos":{"monto":"163","categoria":"Empaque","proveedor":"Prueba"}}'::jsonb) as j;`).j;
    const fa = sql(`select estatus, coalesce(aprobado_por,'') ap, fecha_aprobacion is not null tiene_fecha
                      from gastos where id = ${Number(a.id)};`);
    ok(fa.estatus === 'aprobado', 'Ana (Admin) dice que si -> queda aprobado');
    ok(/· WhatsApp$/.test(fa.ap), 'y el canal queda escrito: ' + fa.ap);
    ok(fa.tiene_fecha === true, 'con su fecha de aprobacion');

    const b = sql(`select public.wa_registrar_gasto('{"telefono":"${DIEGO}","aprobar":true,
        "campos":{"monto":"163","categoria":"Empaque","proveedor":"Prueba"}}'::jsonb) as j;`).j;
    const fb = sql(`select estatus from gastos where id = ${Number(b.id)};`);
    ok(fb.estatus === 'pendiente',
      `Diego (Administrador2) dice que si -> sigue pendiente (quedo '${fb.estatus}')`);

    sql(`delete from gastos where id in (${Number(a.id)}, ${Number(b.id)});`);
  }

  console.log('');
  console.log('El AREA se normaliza, porque ahora escribe un modelo y no un <select>');
  {
    // Un `<select>` manda siempre la misma cadena. Un modelo manda
    // 'produccion', 'PRODUCCIÓN' o 'Producción' segun el dia. Las tres tienen
    // que caer en la MISMA fila o el acumulado se parte en tres y nadie se
    // entera hasta que los numeros no cuadran.
    const casos = [['produccion', 'Producción'], ['REPARTO', 'Reparto'],
                   ['Administración', 'Administración'], ['mercadotecnia', 'Marketing']];
    for (const [manda, espera] of casos) {
      const r = sql(`select public.gasto_area_normal('${manda}') as a;`);
      ok(r.a === espera, `'${manda}' -> '${r.a}'`);
    }
    const basura = sql("select public.gasto_area_normal('contabilidad creativa') as a;");
    ok(basura.a === null, 'un area inventada se queda en null, no entra a la tabla');
  }
  {
    const r = sql(`select public.wa_registrar_gasto('{"telefono":"${ANA}",
        "campos":{"monto":"500","categoria":"Logística","area":"reparto"}}'::jsonb) as j;`).j;
    const f = sql(`select coalesce(area,'(null)') a from gastos where id = ${Number(r.id)};`);
    ok(f.a === 'Reparto', `por WhatsApp el area llega normalizada: ${f.a}`);
    sql(`delete from gastos where id = ${Number(r.id)};`);
  }
  {
    // La restriccion es la segunda cerradura (regla 41): si alguien escribiera
    // sin pasar por la normalizacion, la tabla lo rechaza igual.
    let reventó = false;
    try { sql("insert into gastos (categoria, monto, area) values ('Otros', 1, 'Pirotecnia');"); }
    catch { reventó = true; }
    ok(reventó, 'la tabla rechaza un area fuera de las cinco, aunque se escriba directo');
  }

  console.log('\nLa foto del ticket viaja y se guarda');
  {
    const r = sql(`select public.wa_registrar_gasto('{"telefono":"${ANA}",
        "campos":{"monto":"44","categoria":"Otros","ticket_url":"tickets/2026/prueba.jpg"}}'::jsonb) as j;`).j;
    const f = sql(`select coalesce(ticket_url,'') t from gastos where id = ${Number(r.id)};`);
    ok(f.t === 'tickets/2026/prueba.jpg', '`ticket_url` llega entero');
    sql(`delete from gastos where id = ${Number(r.id)};`);
  }
  console.log('\nLa herramienta solo existe para quien trae la seccion');
  {
    wa.usarAjustesDePrueba({ avisar_a: ['5215500000099'] });
    const con = wa.herramientasPara({
      nombre: 'Abraham', nivel: 'consumidor', esCliente: false, esVendedor: true,
      esDueno: true, rol: 'Administrador', puedeGastos: true, telefono: '5215540801794',
    }).map((h) => h.name);
    const sin = wa.herramientasPara({
      nombre: 'Jocelyn', nivel: 'consumidor', esCliente: false, esVendedor: true,
      esDueno: false, rol: 'Vendedor', puedeGastos: false, telefono: '5215500000011',
    }).map((h) => h.name);
    const tendero = wa.herramientasPara({ nombre: 'Lupita', nivel: 'tienda', esCliente: true })
      .map((h) => h.name);
    ok(con.includes('registrar_gasto'), 'el dueño la tiene');
    ok(!sin.includes('registrar_gasto'), 'un vendedor SIN la seccion no la tiene');
    ok(!tendero.includes('registrar_gasto'), 'un tendero tampoco');
    wa.usarAjustesDePrueba({});
  }

  console.log('\nEl prompt no se contradice (se IMPRIME, no se lee el codigo)');
  {
    // La ultima vez que di un prompt por bueno leyendo el codigo, se
    // contradecia en tres sitios. Aqui se mira el texto que de verdad sale.
    const conGastos = wa.sistema({
      nombre: 'Abraham', nivel: 'consumidor', esCliente: false, esVendedor: true,
      esDueno: true, rol: 'Administrador', puedeGastos: true, telefono: '5215540801794',
    });
    const sinGastos = wa.sistema({ nombre: 'Lupita', nivel: 'tienda', esCliente: true });
    ok(/registrar_gasto/.test(conGastos), 'a quien puede, el prompt se lo dice');
    ok(!/registrar_gasto/.test(sinGastos), 'a quien no puede, NO se lo menciona');
    ok(/Tu NO apruebas gastos/.test(conGastos),
      'y le deja claro que el no aprueba');
    // Lo que no puede pasar: prometerle que aprueba y a la vez que no.
    ok(!/puedes aprobar gastos/i.test(conGastos), 'no hay una frase que diga lo contrario');
  }

  console.log('\nUna foto se reconoce y no deja el turno vacio');
  {
    const cuerpo = (m) => ({ entry: [{ changes: [{ value: {
      contacts: [{ profile: { name: 'Abraham' } }], messages: [m] } }] }] });
    const foto = wa.sacarMensaje(cuerpo({
      id: 'wamid.1', from: '5215540801794', type: 'image',
      image: { id: '998877', mime_type: 'image/jpeg', caption: 'gasolina del martes' },
    }));
    ok(foto.imagenId === '998877', 'saca el id de la foto');
    ok(foto.pieDeFoto === 'gasolina del martes', 'y el pie de foto');
    ok(foto.texto === '', 'el texto viene vacio, que es lo que rompia el turno');

    const texto = wa.sacarMensaje(cuerpo({
      id: 'wamid.2', from: '5215540801794', type: 'text', text: { body: 'hola' },
    }));
    ok(texto.imagenId === '' && texto.texto === 'hola',
      'un mensaje de texto sigue igual que siempre');
  }
} finally {
  // La prueba no deja el mundo distinto a como lo encontro.
  try { sql("update vendedores set secciones = array_remove(secciones,'gastos') where id=1;"); } catch {}
  try { sql("delete from gastos where descripcion = 'prueba refactor' or proveedor = 'Prueba';"); } catch {}
  rmSync(dir, { recursive: true, force: true });
}

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
