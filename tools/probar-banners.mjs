// ============================================================================
//  Prueba de /api/banners — la puerta por la que se escribe el carrusel
//
//  Corre la funcion DE VERDAD (api/banners.js) con la red falseada, y le da
//  el payload REAL del front (regla 55). El caso que importa es el primero:
//  el `banners.json` que esta HOY en produccion, que pide el sabor «Natural»
//  cuando la base tiene «Naturales». Si esta prueba no lo rechaza, la pantalla
//  nueva no sirve de nada, porque el fallo que arregla es ese.
//
//  Se vio fallar antes de darla por buena (regla 54): con la comprobacion de
//  sabores quitada, el caso 1 pasa y la prueba lo canta.
//
//    node tools/probar-banners.mjs
// ============================================================================
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.SUPABASE_URL = 'https://falso.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'llave-de-mentira';

// El catalogo tal como esta en PRODUCCION el 24 nov 2026 (medido:
// 7 sabores x 5 presentaciones, 35 SKU activos). Lo que importa de esta
// tabla es que «Natural» NO esta y «Naturales» si.
const SABORES = ['Adobada Hot', 'Crunchy Mix', 'Feroz', 'Habanero', 'Naturales', 'Queso Cheddar', 'Queso Jalapeño'];
const PRESENTACIONES = ['100g', '250g', '500g', '1kg', 'Granel'];
const PRODUCTOS = [];
let id = 1;
for (const s of SABORES) for (const p of PRESENTACIONES) PRODUCTOS.push({ id: id++, sabor: s, presentacion: p });

const ARCHIVOS = ['banner/promo1.jpg', 'banner/promo2.jpg', 'banner/promo3.jpg', 'banner/promo4.jpg', 'banner/banners.json']
  .map((n) => ({ name: n.replace('banner/', '') }));

let escrito = null;      // lo ultimo que la funcion intento guardar
let esDueno = true;

global.fetch = async (url, opc) => {
  const u = String(url);
  const resp = (cuerpo, ok = true) => ({ ok, status: ok ? 200 : 500, text: async () => JSON.stringify(cuerpo) });
  if (u.includes('/rpc/sesion_es_dueno')) return resp(esDueno);
  if (u.includes('/rest/v1/productos')) return resp(PRODUCTOS);
  if (u.includes('/storage/v1/object/list/')) return resp(ARCHIVOS);
  if (u.includes('/storage/v1/object/contenido/banner/banners.json')) {
    escrito = opc && opc.body;
    return resp({ Key: 'contenido/banner/banners.json' });
  }
  throw new Error('la prueba no esperaba esta llamada: ' + u);
};

const handler = require('../api/banners.js');

function llamar(cuerpo) {
  return new Promise((resolve) => {
    const req = { method: 'POST', body: cuerpo, on() {} };
    const res = {
      setHeader() {}, statusCode: 200,
      status(s) { this.statusCode = s; return this; },
      json(o) { resolve({ estado: this.statusCode, cuerpo: o }); },
    };
    handler(req, res);
  });
}

// ── Los casos ───────────────────────────────────────────────────────────────
// El primero es literalmente lo que sirve produccion ahora mismo.
const PRODUCCION_HOY = [
  { img: 'promo1.jpg', destino: 'catalogo', sabor: 'Natural', presentacion: '1kg' },
  { img: 'promo2.jpg', destino: 'catalogo', presentacion: '1kg' },
  { img: 'promo3.jpg', destino: 'catalogo', sabor: 'Feroz', presentacion: '100g' },
  { img: 'promo4.jpg', destino: 'catalogo', presentacion: '250g' },
];

const CASOS = [
  ['el banners.json que sirve produccion HOY (sabor «Natural»)', PRODUCCION_HOY, false, 'Natural'],
  ['el mismo, con el sabor que SI existe', PRODUCCION_HOY.map((b, i) => i === 0 ? { ...b, sabor: 'Naturales' } : b), true, null],
  ['una imagen que no esta en Storage', [{ img: 'no-existe.jpg' }], false, 'Storage'],
  ['un destino inventado', [{ img: 'promo1.jpg', destino: 'tesoreria' }], false, 'desconocido'],
  ['un producto que no existe', [{ img: 'promo1.jpg', destino: 'producto', productoId: 99999 }], false, 'producto'],
  ['catalogo sin sabor ni presentacion', [{ img: 'promo1.jpg', destino: 'catalogo' }], false, 'necesita'],
  ['una presentacion que no existe', [{ img: 'promo1.jpg', destino: 'catalogo', presentacion: '2kg' }], false, '2kg'],
  ['salirse de la carpeta con ../', [{ img: '../productos/x.jpg' }], false, 'imagen'],
  ['sin imagen', [{ destino: 'premia' }], false, 'imagen'],
  ['un banner que solo se mira', [{ img: 'promo2.jpg' }], true, null],
];

let fallos = 0;
console.log('\n  PRUEBA DE /api/banners\n');

for (const [nombre, banners, deberiaPasar, trozo] of CASOS) {
  escrito = null;
  const r = await llamar({ token: 't', banners });
  const paso = r.estado === 200 && r.cuerpo.ok === true;
  let mal = null;
  if (paso !== deberiaPasar) {
    mal = deberiaPasar ? 'deberia haberse guardado y no' : 'SE GUARDO, y no deberia';
  } else if (!deberiaPasar) {
    if (trozo && !String(r.cuerpo.error || '').includes(trozo)) {
      mal = 'rechazado, pero el motivo no menciona «' + trozo + '»: ' + r.cuerpo.error;
    } else if (escrito !== null) {
      mal = 'rechazado PERO escribio en Storage';   // no debe tocar nada si algo falla
    }
  } else if (escrito === null) {
    mal = 'dijo que si pero no escribio nada';
  }
  if (mal) { fallos++; console.log('  FALLA  ' + nombre + '\n         ' + mal); }
  else console.log('  ok     ' + nombre + (deberiaPasar ? '' : '  → ' + r.cuerpo.error));
}

// Una sesion que no es del dueño no pasa, aunque todo lo demas cuadre.
esDueno = false;
const r = await llamar({ token: 't', banners: [{ img: 'promo2.jpg' }] });
if (r.estado !== 403) { fallos++; console.log('  FALLA  una sesion que no es del dueño deberia dar 403, dio ' + r.estado); }
else console.log('  ok     una sesion que no es del dueño no entra  → 403');
esDueno = true;

// Y que lo que se guarda sea lo que se espera, no solo «ok».
escrito = null;
await llamar({ token: 't', banners: [{ img: 'banner/promo3.jpg', destino: 'catalogo', sabor: 'Feroz', presentacion: '100g', basura: 1 }] });
const guardado = JSON.parse(escrito || '[]');
const bien = guardado.length === 1 && guardado[0].img === 'promo3.jpg' && guardado[0].basura === undefined;
if (!bien) { fallos++; console.log('  FALLA  lo guardado no es lo esperado: ' + escrito); }
else console.log('  ok     guarda el nombre sin la carpeta y tira los campos de mas');

console.log('\n  ' + (fallos ? fallos + ' FALLO(S)' : 'Todo bien') + '\n');
process.exit(fallos ? 1 : 0);
