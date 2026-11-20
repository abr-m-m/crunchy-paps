#!/usr/bin/env node
// tools/probar-wa-dueno.mjs — que los agentes sepan quién es el dueño.
//
// ESCRIBE EN STAGING (dkwatbsaidlfjqjnfyrk) y limpia lo suyo.
//
// Lo que vigila, y por qué cada cosa:
//
//   - LA GUARDA DEL DINERO (D6). `wa_identidad` es quien decide el NIVEL DE
//     PRECIO, y este cambio le añade campos. La aserción que importa no es que
//     `esDueno` salga true: es que **el nivel de un cliente NO cambie** por ser
//     también vendedor. Si alguien un día «simplifica» metiendo el rol en el
//     case del nivel, un tendero podría cotizar a otro precio y nadie se
//     enteraría hasta la factura. Por eso la prueba crea a propósito un cliente
//     que ADEMÁS es vendedor, que es el caso que nadie piensa en probar.
//
//   - QUE `administrador2` NO SEA DUEÑO. Es un rol real del proyecto que
//     parece admin y no lo es (`ruta_del_dia`: solo `admin` y `administrador`
//     ven todas las rutas). Una comparación floja lo dejaría pasar.
//
//   - QUE EL DUEÑO NO ACABE DE PROSPECTO. Al soltar su número de `clientes`,
//     Abraham pasó a ser un desconocido para el agente: sin este salto, el
//     siguiente mensaje suyo lo mete en la lista de tienditas por visitar.
//
// Diseño: cambios/2026-11-20-el-equipo-completo.md
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STG = 'dkwatbsaidlfjqjnfyrk';
const dir = mkdtempSync(join(tmpdir(), 'wa-dueno-'));
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
  return c.rows || [];
}
const una = (q) => sql(q)[0];
const ident = (tel) => una(`select public.wa_identidad('${tel}') as j;`).j;

// Los vendedores sembrados en staging. El de rol `Administrador2` es la trampa.
const ADMIN   = '5215500000001';   // id 1, rol "Admin"
const MOSTR   = '5215500000002';   // id 2, rol "Mostrador"
const ADMIN2  = '5215500000004';   // id 4, rol "Administrador2" — PARECE y NO ES
const COLA_T  = '5599800001';      // el cliente de mentira del caso D6
const TEMP    = '5215599800001';
// OJO: un numero DISTINTO para el desconocido. La primera version reuso `TEMP`,
// que para entonces ya existia como cliente del caso D6, asi que `wa_prospecto`
// contestaba `esCliente: true` — correctamente— y la prueba lo leia como fallo.
// Era un error de la prueba, no del codigo.
const DESCON  = '5215599800002';
const COLA_D  = '5599800002';

const limpiar = () => sql(`
  delete from prospectos where right(regexp_replace(coalesce(contacto_telefono,''),'[^0-9]','','g'),10)
    in ('${COLA_T}','${COLA_D}','5500000001','5500000002','5500000004');
  delete from clientes where right(regexp_replace(coalesce(telefono,''),'[^0-9]','','g'),10) in ('${COLA_T}','${COLA_D}');
`);

try {
  limpiar();

  console.log('\nEl dueño se reconoce');
  {
    const r = ident(ADMIN);
    ok(r.ok === true, 'ok = true');
    ok(r.esDueno === true, `esDueno = true (dio ${r.esDueno})`);
    ok(r.esVendedor === true, 'y tambien esVendedor');
    ok(String(r.rol).toLowerCase() === 'admin', `devuelve el rol tal cual: ${r.rol}`);
    ok(Number(r.idVendedor) === 1, `y el id del vendedor (${r.idVendedor})`);
  }

  console.log('\n«Administrador2» NO es dueño — parece y no es');
  {
    const r = ident(ADMIN2);
    ok(r.esVendedor === true, 'si es vendedor');
    ok(r.esDueno === false, `pero NO es dueño (dio ${r.esDueno})`);
  }

  console.log('\nUn vendedor de mostrador tampoco');
  {
    const r = ident(MOSTR);
    ok(r.esVendedor === true, 'es vendedor');
    ok(r.esDueno === false, 'y no es dueño');
  }

  console.log('\nUn desconocido sigue siendo un desconocido');
  {
    const r = ident('5215599777777');
    ok(r.esCliente === false && r.esVendedor === false && r.esDueno === false,
      'ni cliente, ni vendedor, ni dueño');
    ok(r.nivel === 'consumidor', 'y su nivel sigue siendo consumidor');
    ok(r.rol === null, 'sin rol');
  }

  console.log('\nLA GUARDA DEL DINERO (D6): ser vendedor NO cambia el nivel de precio');
  {
    // Un cliente de verdad que ADEMAS tiene el telefono de un vendedor.
    // Es el caso que nadie piensa en probar, y el que se rompe si alguien mete
    // el rol dentro del `case` que calcula el nivel.
    sql(`insert into clientes (nombre, telefono, tipo, tipo_id, aprobado_b2b)
         values ('Tienda de Prueba D6', '${COLA_T}', 'Tienda / Abarrotes', 3, true);`);
    sql(`update vendedores set telefono = '${COLA_T}' where id = 3;`);
    try {
      const r = ident(TEMP);
      ok(r.esCliente === true, 'lo ve como cliente');
      ok(r.esVendedor === true, 'y tambien como vendedor');
      ok(r.nivel === 'tienda',
        `y su nivel sale de CLIENTES, no del rol: ${r.nivel} (debe ser 'tienda')`);
      ok(r.aprobadoB2B === true, 'y aprobadoB2B se conserva');
    } finally {
      sql(`update vendedores set telefono = '5500000003' where id = 3;`);
    }
  }

  console.log('\nEl dueño NO acaba en la lista de prospectos');
  {
    const r = una(`select public.wa_prospecto('${ADMIN}', 'Abraham') as j;`).j;
    ok(r.ok === true, 'la funcion contesta ok');
    ok(r.idProspecto === null, `no crea prospecto (dio ${JSON.stringify(r.idProspecto)})`);
    ok(r.esVendedor === true, 'y dice por que: es vendedor');
    const n = una(`select count(*)::int n from prospectos
      where right(regexp_replace(coalesce(contacto_telefono,''),'[^0-9]','','g'),10)='5500000001';`).n;
    ok(n === 0, `y no hay ninguna fila suya (hay ${n})`);
  }

  console.log('\nPero un desconocido de verdad SI sigue dando de alta');
  {
    // Sin esto, el salto podria haber apagado la funcion entera y nadie lo veria.
    const r = una(`select public.wa_prospecto('${DESCON}', 'Quien sea') as j;`).j;
    ok(r.nuevo === true || r.idProspecto !== null,
      `el desconocido si entra (nuevo=${r.nuevo}, id=${r.idProspecto})`);
  }
} finally {
  limpiar();
  const q = una(`select count(*)::int n from prospectos
    where right(regexp_replace(coalesce(contacto_telefono,''),'[^0-9]','','g'),10) in ('${COLA_T}','${COLA_D}','5500000001');`);
  console.log(`\nlimpieza: quedan ${q.n} filas de prueba`);
  if (q.n !== 0) fallos++;
  rmSync(dir, { recursive: true, force: true });
}

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
