#!/usr/bin/env node
// tools/probar-paqueteria.mjs — el servidor cobra el envío cuando el pedido va por
// paquetería, y la app tiene que mandarle la clave. Necesita `node tools/ver-en-staging.mjs`.
// Uso: node tools/probar-paqueteria.mjs
import { readFileSync } from 'node:fs';
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging') { console.error('No es staging'); process.exit(1); }
const H = { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' };
const SIN_CONEXION = ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'];
const conReintento = async (fn) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 4 || !SIN_CONEXION.includes(e?.cause?.code)) throw e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); } } };
const rpc = async (n, b) => { const r = await conReintento(() => fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })); return { status: r.status, json: await r.json().catch(() => null) }; };
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

const tel = '558' + String(Date.now()).slice(-7);
const ses = (await rpc('emitir_sesion_prueba', { p_telefono: tel })).json;
const prod = (await (await fetch(`${SUPABASE_URL}/rest/v1/productos?select=id,sabor,presentacion,precio_consumidor&limit=1&order=id`, { headers: H })).json())[0];
const precio = Number(prod.precio_consumidor);
const base = { tokenCliente: ses?.token, nombre: 'Consumidor Paquetería', telefono: tel, cp: '03400', colonia: 'Álamos', direccion: 'Calle 1', zonaEntrega: 'foraneo',
  productos: [{ idProducto: String(prod.id), sabor: prod.sabor, presentacion: prod.presentacion, tipoVenta: 'Por Pieza', cantidad: 1, gramos: 0, precio, subtotal: precio }] };
ok(!!ses?.token && precio > 0, `sesión de consumidor ${tel} y producto ${prod.sabor} ${prod.presentacion} a $${precio}`);

// 1. Con la clave y el total con envío: el servidor acepta y guarda +80.
const con = (await rpc('crear_pedido', { p_data: { ...base, metodoEntrega: 'paqueteria', total: precio + 80, idempotencyKey: 'paq-' + tel + '-a' } })).json;
ok(con?.ok === true, `paquetería con metodoEntrega → ${con?.consecutivo || JSON.stringify(con).slice(0, 80)}`);
// 2. Sin la clave (lo que mandaba la app hasta hoy): precio_cambiado.
const sin = (await rpc('crear_pedido', { p_data: { ...base, total: precio + 80, idempotencyKey: 'paq-' + tel + '-b' } })).json;
ok(sin?.ok === false && sin?.error === 'precio_cambiado', `sin la clave el servidor rechaza → ${sin?.error} (envío ${sin?.envio})`);
// 3. Domicilio sin envío: acepta.
const dom = (await rpc('crear_pedido', { p_data: { ...base, metodoEntrega: 'coordinar', total: precio, idempotencyKey: 'paq-' + tel + '-c' } })).json;
ok(dom?.ok === true, `domicilio sin envío → ${dom?.consecutivo}`);
// 4. La app manda la clave: se lee del archivo, no se supone.
const html = readFileSync('index.html', 'utf8');
const i = html.indexOf('tokenCliente: (typeof tokenCliente');
ok(i > 0 && /metodoEntrega:[^\r\n]*[\r\n]/.test(html.slice(i, i + 400)), 'index.html: el payload del checkout lleva metodoEntrega');

console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en orden.');
process.exitCode = fallos ? 1 : 0;
