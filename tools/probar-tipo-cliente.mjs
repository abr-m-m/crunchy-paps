#!/usr/bin/env node
// tools/probar-tipo-cliente.mjs — prueba `tipoDesdeCliente` de src/app.js (MAP-003).
//
// Se extrae la función REAL del fuente y se corre; no se reescribe aquí una copia.
// Regla 4: una prueba que copia el código solo demuestra que la copia funciona — y en
// este mismo frente ya costó caro, porque la matriz de permisos del mapa copió la
// función equivocada y acusó a la app de un fallo que no existía.
//
// Los valores de `tipo` NO son inventados: son los que hay hoy en `clientes` de
// producción, leídos el 24 sep 2026 (40 filas: «Consumidor» y «Tienda / Abarrotes»),
// más los de TIPO_LABELS, que es lo que el panel escribe al dar de alta.
// Regla 55: probar con el payload real.
//
// Uso: node tools/probar-tipo-cliente.mjs

import { readFileSync } from 'node:fs';

const fuente = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const m = fuente.match(/function tipoDesdeCliente\(cliente\) \{[\s\S]*?\n\}/);
if (!m) {
  console.error('No se encontró `tipoDesdeCliente` en src/app.js. ¿Se renombró?');
  process.exit(1);
}
const tipoDesdeCliente = new Function(`${m[0]}; return tipoDesdeCliente;`)();

const casos = [
  // [lo que trae clientes.tipo, canal esperado, por qué importa]
  [{ tipo: 'Consumidor' },          'consumidor',  'el 87% de las filas de producción'],
  [{ tipo: 'Tienda / Abarrotes' },  'tienda',      'el valor real de las 5 tiendas'],
  [{ tipo: 'Restaurante' },         'restaurante', 'de TIPO_LABELS'],
  [{ tipo: 'Mayorista' },           'mayorista',   'de TIPO_LABELS'],
  [{ tipo: 'Mostrador' },           'consumidor',  'mostrador NO es un canal de cliente: cae a consumidor'],
  [{ tipo: 'TIENDA' },              'tienda',      'mayúsculas, por si alguien edita a mano'],
  [{ tipo: 'Abarrotes la Esquina' },'tienda',      'la subcadena «abarrotes» basta'],
  [{ tipo: 'Distribuidor' },        'mayorista',   'sinónimo aceptado a propósito'],
  [{ tipo: '' },                    'consumidor',  'texto vacío'],
  [{ tipo: null },                  'consumidor',  'columna en NULL'],
  [{},                              'consumidor',  'cliente sin la clave'],
  [null,                            'consumidor',  'sin cliente: no debe reventar'],
];

let fallos = 0;
for (const [cliente, esperado, porque] of casos) {
  let real;
  try { real = tipoDesdeCliente(cliente); }
  catch (e) { real = 'LANZÓ: ' + e.message; }
  const ok = real === esperado;
  if (!ok) fallos++;
  console.log(`  ${ok ? 'ok   ' : 'FALLA'} ${JSON.stringify(cliente).padEnd(34)} → ${String(real).padEnd(12)} ${porque}`);
}

// La comprobación que de verdad protege MAP-003: si las dos derivaciones de un mismo
// cliente no coinciden, el arreglo no sirve de nada. Se compara contra la tabla de
// decisión del servidor (`crear_pedido`, 20260930000008_ingreso_bruto_neto.sql:123-131),
// que va por `tipo_id`. El front va por el TEXTO, y esa asimetría es MAP-008; aquí se
// comprueba que al menos COINCIDEN para los valores que produce el panel.
const PORNIVEL = { 1: 'consumidor', 2: 'restaurante', 3: 'tienda', 4: 'mayorista' };
const DEL_PANEL = { 1: 'Consumidor', 2: 'Restaurante', 3: 'Tienda / Abarrotes', 4: 'Mayorista' };
console.log('\n  El front y el servidor tienen que decir lo mismo para cada tipo_id:');
for (const [id, texto] of Object.entries(DEL_PANEL)) {
  const front = tipoDesdeCliente({ tipo: texto });
  const servidor = PORNIVEL[id];
  const ok = front === servidor;
  if (!ok) fallos++;
  console.log(`  ${ok ? 'ok   ' : 'FALLA'} tipo_id ${id} (${texto.padEnd(18)}) front=${front.padEnd(12)} servidor=${servidor}`);
}

console.log(fallos ? `\n  ${fallos} caso(s) fallaron.` : '\n  Todo en orden.');
process.exit(fallos ? 1 : 0);
