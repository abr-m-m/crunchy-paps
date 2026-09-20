#!/usr/bin/env node
// tools/probar-imagen-reto.mjs — api/imagen-reto.js en proceso contra STAGING: valida al dueño, emite la URL
// firmada de subida a contenido/retos/, y el PUT deja un archivo público. Las llaves salen del CLI de Supabase
// (secret) como hace ver-en-staging.mjs con la publishable. Escribe un PNG de 1×1 en el bucket de staging.
// Uso: node tools/probar-imagen-reto.mjs
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const STG = 'dkwatbsaidlfjqjnfyrk';
// --reveal: sin él, el CLI devuelve las secretas recortadas y Supabase responde «Invalid API key».
const out = execFileSync('supabase', ['projects', 'api-keys', '--project-ref', STG, '--reveal', '--output-format', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const j = JSON.parse(out.slice(out.search(/[\[{]/)));
const lista = Array.isArray(j) ? j : (j.keys || j.data || []);
const secreta = lista.find(k => k.type === 'secret' || String(k.api_key || '').startsWith('sb_secret_'))?.api_key;
const anon = lista.find(k => k.type === 'publishable' || String(k.api_key || '').startsWith('sb_publishable_'))?.api_key;
if (!secreta || !anon) { console.error('El CLI no devolvió las llaves de staging.'); process.exit(1); }
process.env.SUPABASE_URL = `https://${STG}.supabase.co`;
process.env.SUPABASE_SERVICE_ROLE_KEY = secreta;
const handler = require('../api/imagen-reto.js');
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

const llamar = (body) => new Promise((resolve) => {
  const res = { _s: 200, setHeader() {}, status(s) { this._s = s; return this; }, json(o) { resolve({ status: this._s, json: o }); }, end() { resolve({ status: this._s, json: null }); } };
  handler({ method: 'POST', body, headers: {}, on() {} }, res);
});
const rpc = async (n, b) => (await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: { apikey: anon, authorization: `Bearer ${anon}`, 'content-type': 'application/json' }, body: JSON.stringify(b) })).json();
const ana = await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000001', pin: '1234' } });
const carla = await rpc('validar_vendedor_pin', { p_data: { telefono: '5500000003', pin: '1234' } });

const sin = await llamar({ mimeType: 'image/png' });
ok(sin.status === 401, `sin token → ${sin.status}`);
const noDueno = await llamar({ token: carla?.token, mimeType: 'image/png' });
ok(noDueno.status === 403, `Carla → ${noDueno.status}`);
const malTipo = await llamar({ token: ana?.token, mimeType: 'text/html' });
ok(malTipo.status === 400, `text/html → ${malTipo.status}`);
const bien = await llamar({ token: ana?.token, mimeType: 'image/png' });
ok(bien.status === 200 && bien.json?.ok === true && /^retos\/[0-9a-f-]{36}\.png$/.test(bien.json?.ruta || '') && String(bien.json?.url).includes('/storage/v1/object/upload/sign/contenido/'),
  `Ana → ${bien.status}, ruta ${bien.json?.ruta}`);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
if (bien.status === 200 && bien.json?.url) {
  const put = await fetch(bien.json.url, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png });
  const pub = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/public/contenido/${bien.json.ruta}`);
  ok(put.ok && pub.ok && pub.headers.get('content-type') === 'image/png' && (await pub.arrayBuffer()).byteLength === png.length,
    `PUT → ${put.status}; público → ${pub.status} ${pub.headers.get('content-type')}`);
} else ok(false, `PUT omitido: no hubo URL firmada (${JSON.stringify(bien.json)})`);
console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en orden.');
process.exitCode = fallos ? 1 : 0;
