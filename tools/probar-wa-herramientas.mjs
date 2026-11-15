#!/usr/bin/env node
// tools/probar-wa-herramientas.mjs — la lista blanca de herramientas del agente.
//
// Sin red y sin base. Lo que vigila es una propiedad de SEGURIDAD que se rompe en
// silencio: que NINGUNA herramienta acepte el nivel de precio, ni un precio, ni un
// total, como parametro. Eso lo resuelve el servidor (wa_identidad) y entra por
// argumento. El dia que alguien lo anada al esquema "para que el modelo pueda
// elegir", un consumidor podria pedir precio de mayorista y nadie se enteraria
// hasta ver la factura.
//
// RECORRE EL ESQUEMA EN PROFUNDIDAD, y eso no es un detalle. La primera version de
// esta prueba miraba solo `input_schema.properties`, el primer nivel. Cuando llego
// `cotizar`, sus parametros de verdad quedaron dentro de `lineas.items.properties`,
// donde la prueba no miraba: habria dado VERDE con un campo `precio` ahi. Una
// asercion que comprueba la forma en vez de la propiedad que importa (regla 53).
//
// La lista depende de QUIEN escribe (`herramientasPara(id)`), asi que se comprueban
// los cuatro niveles y el desconocido. Un permiso que solo existe en el prompt no
// es un permiso (regla 35): lo que no esta en la lista no le llega al modelo.
//
// Plan: cambios/2026-11-12-agente-whatsapp-plan.md, tareas 5 y 6.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { herramientasPara, COLUMNA_PRECIO, sistema, MAX_LINEAS } = require('../api/whatsapp.js');

let fallos = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

// Los cinco perfiles que pueden escribir. El ultimo es el que no esta en la base.
const PERFILES = [
  { nombre: 'Ana', nivel: 'consumidor', esCliente: true, telefono: '5215500000001' },
  { nombre: 'Tienda Lupita', nivel: 'tienda', esCliente: true, telefono: '5215500000002' },
  { nombre: 'Taqueria', nivel: 'restaurante', esCliente: true, telefono: '5215500000003' },
  { nombre: 'Central', nivel: 'mayorista', esCliente: true, telefono: '5215500000004' },
  { nombre: '', nivel: 'consumidor', esCliente: false, telefono: '5215500000005' },
];

// Todos los nombres de propiedad del esquema, a cualquier profundidad.
function propiedadesHondas(esquema, salida = []) {
  if (!esquema || typeof esquema !== 'object') return salida;
  if (esquema.properties) {
    for (const [clave, sub] of Object.entries(esquema.properties)) {
      salida.push(clave);
      propiedadesHondas(sub, salida);
    }
  }
  if (esquema.items) propiedadesHondas(esquema.items, salida);
  return salida;
}

console.log('\nLa lista blanca esta cerrada, y depende de QUIEN escribe');
// Las de lectura las tiene todo el mundo. `crear_pedido` ESCRIBE, y solo aparece
// para quien puede pedir: a un consumidor no le llega en la peticion, asi que no
// es que el modelo "decida no usarla" (regla 35).
const LEEN = 'catalogo,cotizar,fecha_entrega,mis_pedidos';
const PIDEN = 'catalogo,cotizar,crear_pedido,fecha_entrega,mis_pedidos';
for (const p of PERFILES) {
  const nombres = herramientasPara(p).map((h) => h.name).sort().join(',');
  const esperado = ['tienda', 'restaurante', 'mayorista'].includes(p.nivel) ? PIDEN : LEEN;
  ok(nombres === esperado, `${p.nivel}${p.esCliente ? '' : ' (desconocido)'}: ${nombres}`);
}

const TODAS = herramientasPara(PERFILES[1]);          // tienda: las cinco
const SOLO_LEE = herramientasPara(PERFILES[0]);       // consumidor: las cuatro

console.log('\nLa UNICA que escribe es crear_pedido, y no esta en la lista del consumidor');
const SOSPECHOSAS = /crear|guardar|borrar|eliminar|actualizar|editar|enviar|cancelar/i;
for (const h of SOLO_LEE) {
  ok(!SOSPECHOSAS.test(h.name), `consumidor: ${h.name} no tiene nombre de escritura`);
}
const escriben = TODAS.filter((h) => SOSPECHOSAS.test(h.name)).map((h) => h.name);
ok(escriben.join(',') === 'crear_pedido', `tienda: la unica que escribe es ${escriben.join(',') || 'ninguna'}`);

console.log('\nNINGUNA acepta nivel, precio ni total como parametro (la que importa)');
const PROHIBIDOS = /nivel|precio|total|subtotal|descuento|tipoCliente|tipo_cliente|aprobado|canal/i;
for (const h of TODAS) {
  const props = propiedadesHondas(h.input_schema);
  const malos = props.filter((p) => PROHIBIDOS.test(p));
  ok(malos.length === 0,
    `${h.name}: {${props.join(', ') || 'sin parametros'}} — ${malos.length ? 'TRAE ' + malos.join(', ') : 'sin campos de dinero'}`);
}

console.log('\nLos esquemas son estrictos y cerrados, hasta el fondo');
function cerradoHasta(esquema) {
  if (!esquema || typeof esquema !== 'object') return true;
  if (esquema.type === 'object' && esquema.additionalProperties !== false) return false;
  if (esquema.properties) {
    for (const sub of Object.values(esquema.properties)) if (!cerradoHasta(sub)) return false;
  }
  if (esquema.items && !cerradoHasta(esquema.items)) return false;
  return true;
}
for (const h of TODAS) {
  ok(h.strict === true, `${h.name} va con strict`);
  ok(cerradoHasta(h.input_schema), `${h.name} no admite propiedades extra en ningun nivel`);
  ok(typeof h.description === 'string' && h.description.length > 20, `${h.name} tiene descripcion util`);
}

console.log('\ncotizar pide piezas y pone techo a la lista');
const cotizar = TODAS.find((h) => h.name === 'cotizar');
const lineas = cotizar.input_schema.properties.lineas;
ok(lineas.maxItems === MAX_LINEAS, `tope de ${MAX_LINEAS} lineas en el esquema`);
ok(lineas.minItems === 1, 'y al menos una');
const campos = Object.keys(lineas.items.properties).sort().join(',');
ok(campos === 'caja,cantidad,idProducto', `la linea lleva exactamente {${campos}}`);
// El plan pedia sabor y presentacion. Se quitaron: el servidor los devuelve, y
// pedirlos solo anade sitios donde el modelo se equivoca sin que se note.
ok(!campos.includes('sabor') && !campos.includes('presentacion'),
  'y NO sabor ni presentacion: los pone el servidor');
ok(/PIEZAS/.test(lineas.items.properties.cantidad.description),
  'la cantidad dice PIEZAS, no cajas (confundirlo multiplica el pedido por doce)');

console.log('\nHay columna de precio para los cuatro niveles, y son distintas');
for (const n of ['consumidor', 'tienda', 'restaurante', 'mayorista']) {
  ok(typeof COLUMNA_PRECIO[n] === 'string' && COLUMNA_PRECIO[n].startsWith('precio_'),
    `${n} -> ${COLUMNA_PRECIO[n]}`);
}
ok(new Set(Object.values(COLUMNA_PRECIO)).size === 4, 'los cuatro apuntan a columnas DISTINTAS');

console.log('\nEl prompt le prohibe inventar y le prohibe sumar');
const s = sistema(PERFILES[1]);
for (const h of TODAS) ok(s.includes(h.name), `el prompt menciona ${h.name}`);
ok(/nunca inventes/i.test(s), 'le prohibe inventar precios, sabores y fechas');
ok(/nunca calcules un total/i.test(s), 'y le prohibe calcular un total el mismo');
ok(!/fechaDisplay/.test(s), 'fechaDisplay no aparece por ningun lado (viene en espanglish)');

console.log('\nEl consumidor no compra por caja y el prompt se lo dice');
ok(/no compra por caja/i.test(sistema(PERFILES[0])), 'consumidor: cotiza por pieza');
ok(/multiplos exactos/i.test(sistema(PERFILES[1])), 'tienda: la caja solo en multiplos exactos');

console.log('\ncrear_pedido pide fecha y no acepta nada de dinero');
const crear = TODAS.find((h) => h.name === 'crear_pedido');
const suyas = Object.keys(crear.input_schema.properties).sort().join(',');
ok(suyas === 'fechaEntrega,lineas,notas', `lleva {${suyas}}`);
ok(/AAAA-MM-DD/.test(crear.input_schema.properties.fechaEntrega.description),
  'y dice el formato de la fecha');
// El modelo no manda token, ni tipoCliente, ni total: eso lo pone el servidor.
// Ya lo cubre el barrido de arriba, pero aqui se nombra, que es donde se busca.
for (const prohibido of ['token', 'tipoCliente', 'total', 'idCliente', 'canal']) {
  ok(!propiedadesHondas(crear.input_schema).includes(prohibido), `  sin ${prohibido}`);
}
// Y el prompt tiene que exigir confirmacion ANTES de escribir en la base.
ok(/CONFIRMAR el total/i.test(sistema(PERFILES[1])),
  'el prompt exige que el cliente confirme el total antes de crearlo');
ok(/PENDIENTE/.test(sistema(PERFILES[1])), 'y que se le diga que queda pendiente');

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
