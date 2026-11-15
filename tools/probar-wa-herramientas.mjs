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
const {
  herramientasPara, COLUMNA_PRECIO, sistema, POR_DEFECTO, cotizarLineas, usarAjustesDePrueba,
} = require('../api/whatsapp.js');

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

console.log('\nNINGUN esquema lleva algo que `strict: true` rechace');
// EL CASO QUE TUMBO PRODUCCION. El 14 nov 2026 `cotizar` salio con `maxItems: 20`
// en `lineas` y la API devolvio 400 en CADA mensaje:
//
//   tools.3.custom: For 'array' type, property 'maxItems' is not supported
//
// El agente contestaba "se me trabo el sistema" a todo, y lo encontro Abraham
// escribiendole, no yo. Ninguna de las seis pruebas lo cazo porque todas miraban
// el esquema que YO escribi, no si el destinatario lo acepta: comprobar la forma
// en vez de la propiedad que importa (regla 53).
//
// `strict` acepta tipos, enum, const, anyOf, allOf, $ref y
// additionalProperties:false, y NINGUN limite. Los helpers tipados del SDK
// (betaZodTool) quitan los limites solos y validan en cliente; estos esquemas van
// a mano -decision mia, para poder sumar los tokens de todas las vueltas-, asi
// que aqui no hay quien los quite. Esta lista es el precio de esa decision.
//
// NO sustituye a probar contra la API: una lista negra solo conoce lo que ya
// mordio. Si aparece un 400 de esquema que esta prueba no vio venir, la palabra
// nueva se anade AQUI, con su fecha.
const PROHIBIDAS_POR_STRICT = [
  'minItems', 'maxItems', 'uniqueItems', 'contains',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern',
  'minProperties', 'maxProperties', 'patternProperties',
  'not', 'oneOf', 'if', 'then', 'else', 'dependentSchemas',
];
function palabrasDelEsquema(e, out = []) {
  if (!e || typeof e !== 'object') return out;
  for (const [k, v] of Object.entries(e)) {
    out.push(k);
    if (k === 'required') continue;                     // es una lista de nombres
    if (k === 'properties' && v && typeof v === 'object') {
      for (const sub of Object.values(v)) palabrasDelEsquema(sub, out);
    } else if (v && typeof v === 'object') {
      palabrasDelEsquema(v, out);
    }
  }
  return out;
}
for (const h of TODAS) {
  const usadas = palabrasDelEsquema(h.input_schema);
  const malas = PROHIBIDAS_POR_STRICT.filter((p) => usadas.includes(p));
  ok(malas.length === 0,
    `${h.name}: ${malas.length ? 'LLEVA ' + malas.join(', ') + ' — la API devolvera 400' : 'limpio'}`);
}

console.log('\nY el tope de lineas vive en el CODIGO, que es donde se cumple');
// Un limite que solo existe en el esquema es una sugerencia al modelo. Este se
// cumple sin tocar la red, antes de preguntarle a nadie.
const MAX_LINEAS = POR_DEFECTO.max_lineas;
ok(typeof MAX_LINEAS === 'number' && MAX_LINEAS > 0, `max_lineas por defecto = ${MAX_LINEAS}`);
const muchas = Array.from({ length: MAX_LINEAS + 1 },
  (_, i) => ({ idProducto: i + 1, cantidad: 1, caja: 0 }));
const rTope = await cotizarLineas(muchas, 'tienda');
ok(rTope.ok === false && rTope.error === 'demasiadas_lineas',
  `${MAX_LINEAS + 1} lineas -> ${rTope.ok ? 'COTIZO' : rTope.error}`);

console.log('\ncotizar pide piezas, no cajas');
const cotizar = TODAS.find((h) => h.name === 'cotizar');
const lineas = cotizar.input_schema.properties.lineas;
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

// El largo no es estilo: la salida cuesta 5x la entrada, y la primera respuesta
// con herramientas del 14 nov 2026 gasto 895 tokens -7 sabores y 5 pedidos,
// correcta y correctisima, pero una pared de texto en un telefono-.
ok(/6 lineas o menos/.test(s), 'le pone techo de 6 lineas');
ok(/no listes tambien sus pedidos/.test(s), 'y le dice que conteste solo lo que preguntaron');
ok(/No te disculpes/.test(s), 'y que no cuente la historia interna del sistema al cliente');

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

console.log('\nPasar con una persona: no se ofrece si no hay a quien avisar');
// ESTE ES EL INVARIANTE. El prompt llevaba desde el 14 nov 2026 ofreciendo
// "te lo paso con el equipo" sin que existiera forma de pasarlo: el agente se
// saltaba su propia regla de no prometer lo que no puede cumplir, y nadie se
// entero porque los avisos no iban a ningun sitio. Con avisar_a vacio, ni la
// herramienta existe ni el prompt la nombra.
usarAjustesDePrueba({ avisar_a: [] });
for (const p of PERFILES) {
  const n = herramientasPara(p).map((h) => h.name);
  ok(!n.includes('pasar_con_una_persona'), `${p.nivel}: sin destinos, no esta la herramienta`);
}
ok(!/pasar_con_una_persona/.test(sistema(PERFILES[1])), 'y el prompt no la menciona');

console.log('\n   Con un destino puesto, aparece para todos');
usarAjustesDePrueba({ avisar_a: ['5215500000099'] });
for (const p of PERFILES) {
  const n = herramientasPara(p).map((h) => h.name);
  ok(n.includes('pasar_con_una_persona'), `${p.nivel}: con destino, si esta`);
}
const sAviso = sistema(PERFILES[1]);
ok(/pasar_con_una_persona/.test(sAviso), 'y el prompt la menciona');

console.log('\n   Los tres escenarios estan en su descripcion');
const esc = herramientasPara(PERFILES[1]).find((h) => h.name === 'pasar_con_una_persona');
ok(/hablar con una persona/i.test(esc.description), '1. el cliente lo pide');
ok(/cancelar un pedido/i.test(esc.description), '2. algo que no puede hacer');
ok(/reclamo/i.test(esc.description), '3. reclamo o cliente molesto');
ok(/NO la uses para dudas de producto/i.test(esc.description), 'y lo que NO escala');

console.log('\n   Y el agente tiene prohibido cancelar');
ok(/NO puedes cancelar/i.test(sAviso), 'el prompt se lo prohibe explicitamente');
ok(/no digas que esta hecho/i.test(sAviso), 'y le dice que no finja que lo hizo');

console.log('\nEl nombre del dueno no sale en nada que lea un cliente');
for (const p of PERFILES) {
  ok(!/Abraham/i.test(sistema(p)), `${p.nivel}: el prompt no nombra al dueno`);
}
for (const h of herramientasPara(PERFILES[1])) {
  ok(!/Abraham/i.test(h.description), `${h.name}: su descripcion tampoco`);
}

usarAjustesDePrueba({});   // se deja como estaba

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
