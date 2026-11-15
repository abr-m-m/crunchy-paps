#!/usr/bin/env node
// tools/probar-wa-herramientas.mjs — la lista blanca de herramientas del agente.
//
// Sin red y sin base. Lo que vigila es una propiedad de SEGURIDAD que se rompe en
// silencio: que NINGUNA herramienta acepte el nivel de precio como parametro.
// El nivel lo resuelve el servidor (wa_identidad) y lo cierra el closure. El dia
// que alguien lo anada al esquema "para que el modelo pueda elegir", un consumidor
// podria pedir precio de mayorista y nadie se enteraria hasta ver la factura.
//
// Plan: cambios/2026-11-12-agente-whatsapp-plan.md, tarea 5.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HERRAMIENTAS, COLUMNA_PRECIO, sistema } = require('../api/whatsapp.js');

let fallos = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

console.log('\nLa lista blanca esta cerrada');
const nombres = HERRAMIENTAS.map((h) => h.name).sort();
ok(nombres.length === 3, `hay 3 herramientas (hay ${nombres.length}: ${nombres.join(', ')})`);
ok(nombres.join(',') === 'catalogo,fecha_entrega,mis_pedidos',
  'y son exactamente catalogo, fecha_entrega y mis_pedidos');

console.log('\nNinguna escribe: son todas de lectura');
const SOSPECHOSAS = /crear|guardar|borrar|eliminar|actualizar|editar|enviar|pedido_nuevo/i;
for (const h of HERRAMIENTAS) {
  ok(!SOSPECHOSAS.test(h.name), `${h.name} no tiene nombre de escritura`);
}

console.log('\nNINGUNA acepta el nivel de precio como parametro (la que importa)');
const PROHIBIDOS = /nivel|precio|tipoCliente|tipo_cliente|aprobado|canal|descuento/i;
for (const h of HERRAMIENTAS) {
  const props = Object.keys((h.input_schema && h.input_schema.properties) || {});
  const malos = props.filter((p) => PROHIBIDOS.test(p));
  ok(malos.length === 0,
    `${h.name}: parametros ${props.length ? props.join(', ') : '(ninguno)'} — sin campos de precio`);
}

console.log('\nLos esquemas son estrictos y cerrados');
for (const h of HERRAMIENTAS) {
  ok(h.strict === true, `${h.name} va con strict`);
  ok(h.input_schema && h.input_schema.additionalProperties === false,
    `${h.name} no admite propiedades extra`);
  ok(typeof h.description === 'string' && h.description.length > 20,
    `${h.name} tiene descripcion util`);
}

console.log('\nHay columna de precio para los cuatro niveles');
for (const n of ['consumidor', 'tienda', 'restaurante', 'mayorista']) {
  ok(typeof COLUMNA_PRECIO[n] === 'string' && COLUMNA_PRECIO[n].startsWith('precio_'),
    `${n} -> ${COLUMNA_PRECIO[n]}`);
}
ok(new Set(Object.values(COLUMNA_PRECIO)).size === 4,
  'los cuatro niveles apuntan a columnas DISTINTAS');

console.log('\nEl prompt le dice al modelo que no invente');
const s = sistema({ esCliente: true, nombre: 'X', nivel: 'tienda', aprobadoB2B: true, telefono: '5215500000000' });
for (const h of HERRAMIENTAS) {
  ok(s.includes(h.name), `el prompt menciona ${h.name}`);
}
ok(/nunca inventes/i.test(s), 'y le prohibe inventar precios, sabores y fechas');

console.log('\nEl prompt NO le pasa fechaDisplay');
// obtener_fecha_entrega devuelve fechaDisplay en espanglish ("Tuesday 17 de
// November"). Si llegara al modelo, se lo diria asi a un cliente.
ok(!/fechaDisplay/.test(s), 'fechaDisplay no aparece por ningun lado del prompt');

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
