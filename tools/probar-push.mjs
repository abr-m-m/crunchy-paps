#!/usr/bin/env node
// tools/probar-push.mjs — Ejercita /api/push-enviar en local con el cuerpo que
// manda el Database Webhook de Supabase. Lee .env.push (VAPID_*, PUSH_WEBHOOK_SECRET,
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY de STAGING). Comprueba el valor que vuelve.
// Uso: node tools/probar-push.mjs [consecutivo]
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

if (!existsSync('.env.push')) { console.error('Falta .env.push (ver cambios/2026-09-14-cola-de-pedidos/plan-4-push.md, tarea 2, paso 6).'); process.exit(1); }
for (const ln of readFileSync('.env.push', 'utf8').split('\n')) {
  const m = ln.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
if (!/dkwatbsaidlfjqjnfyrk/.test(process.env.SUPABASE_URL || '')) { console.error('El arnés solo corre contra STAGING'); process.exit(1); }

const handler = createRequire(import.meta.url)('../api/push-enviar.js');
const res = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, end() { return r; } }; return r; };
const llamar = async (headers, body) => { const r = res(); await handler({ method: 'POST', headers, body }, r); return r; };
let fallos = 0; const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

const record = { id: 0, consecutivo: process.argv[2] || 'PED-PRUEBA', nombre_cliente: 'Tienda Prueba', canal: 'tienda', total: 420, tipo_interno: '' };
const sin = await llamar({}, { type: 'INSERT', table: 'ordenes', record });
ok(sin.code === 401 && sin.body === null, `sin secreto → ${sin.code} sin cuerpo`);
const H = { authorization: 'Bearer ' + process.env.PUSH_WEBHOOK_SECRET };
const upd = await llamar(H, { type: 'UPDATE', table: 'ordenes', record });
ok(upd.code === 200 && upd.body?.ignorado === true, 'UPDATE → ignorado');
const r = await llamar(H, { type: 'INSERT', table: 'ordenes', record });
ok(r.code === 200 && r.body?.ok === true, `INSERT → ${JSON.stringify(r.body)}`);
ok(Number.isInteger(r.body?.suscripciones), `denominador: ${r.body?.suscripciones} suscripción(es) en staging`);

console.log(fallos ? `\n${fallos} fallo(s).` : '\nTodo en orden.');
// Sin process.exit: web-push deja una conexión cerrándose y en Windows
// process.exit dispara «Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)».
process.exitCode = fallos ? 1 : 0;
