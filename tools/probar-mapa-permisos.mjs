#!/usr/bin/env node
// tools/probar-mapa-permisos.mjs — comprueba docs/mapa/datos/permisos.js contra la base.
// Regla 58: se verifica con un método distinto del que hizo el cambio. El generador cruza
// listas en JavaScript; esto lo recalcula en SQL y compara. Solo LEE producción.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROD = 'xbyzarzyxiugrucyjwfn';
const dir = mkdtempSync(join(tmpdir(), 'probar-permisos-'));
const sql = (q) => {
  const f = join(dir, 'q.sql'); writeFileSync(f, q);
  const out = execSync(`supabase db query --linked --project-ref ${PROD} -o json --file "${f}"`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const i = out.indexOf('{');
  return i < 0 ? [] : (JSON.parse(out.slice(i)).rows || []);
};
let fallos = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos++; };

const win = {};
new Function('window', readFileSync('docs/mapa/datos/permisos.js', 'utf8'))(win);
const P = win.MAPA.permisos;

// La misma pregunta, en SQL: qué secciones ve de verdad cada usuario.
const real = sql(`
  select v.nombre,
         case when v.secciones is not null and array_length(v.secciones,1) > 0
              then v.secciones else coalesce(c.secciones, '{}') end secciones
    from vendedores v
    left join config_secciones c on c.rol = lower(trim(v.rol))
   order by v.id`);
rmSync(dir, { recursive: true, force: true });

ok(P.efectivo.length === real.length, `${real.length} usuarios`);
for (const r of real) {
  const mio = P.efectivo.find(u => u.nombre === r.nombre);
  const a = (mio ? mio.secciones : []).slice().sort().join(',');
  const b = (r.secciones || []).slice().sort().join(',');
  ok(a === b, `${r.nombre}: ${b || '(ninguna)'}`);
}

// Y el dato que motivó la herramienta: las secciones que no puede abrir nadie.
for (const s of P.catalogo) {
  const esperado = real.filter(r => (r.secciones || []).includes(s)).map(r => r.nombre);
  const dado = P.alcance[s] || [];
  ok(esperado.slice().sort().join(',') === dado.slice().sort().join(','),
     `alcance de ${s}: ${dado.length ? dado.join(', ') : 'NADIE'}`);
}
ok(P.muertas.every(s => (P.alcance[s] || []).length === 0), 'muertas coincide con alcance vacío');

console.log(fallos ? `\n${fallos} problema(s).\n` : `\nTodo en orden.\n`);
process.exit(fallos ? 1 : 0);
