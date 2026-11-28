#!/usr/bin/env node
// tools/probar-aparato.mjs — «Ponerle nombre al aparato» contra STAGING
// (20261127000012 y ...13). Uso: node tools/probar-aparato.mjs
// Necesita `node tools/ver-en-staging.mjs` corriendo.
//
// POR QUE POR POSTGREST Y NO POR SQL. Lo que hay que comprobar es que el codigo
// del aparato viaja desde el NAVEGADOR hasta la lista de sesiones. Una prueba
// por SQL se salta justo ese tramo y diria «todo bien» aunque el cliente no
// mandara nada (regla 31: una prueba que no puede decirte si llego al codigo
// que prueba no es una prueba).
//
// Regla 13: se mira la RESPUESTA de cada llamada, no solo que no truene.
const cfgTxt = await (await fetch('http://localhost:8794/api/config.js')).text();
const { SUPABASE_URL, SUPABASE_ANON_KEY, ENTORNO } = JSON.parse(
  cfgTxt.replace(/^window\.__CP_CONFIG__ = /, '').replace(/;\s*$/, ''));
if (ENTORNO !== 'staging') { console.error('No es staging: ' + SUPABASE_URL); process.exit(1); }
const H = { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' };
const rpc = async (n, b) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${n}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { _http: r.status, _texto: t.slice(0, 200) }; }
};

const AP = 'pruebaap' + Date.now().toString(36).slice(-4);
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36';
let fallos = 0;
const ok = (c, m, visto) => { console.log((c ? '  ok    ' : '  FALLA ') + m + (c ? '' : `  → ${JSON.stringify(visto)}`)); if (!c) fallos++; };
const entrar = (tel, extra) => rpc('validar_vendedor_pin', { p_data: { telefono: tel, pin: '1234', userAgent: UA_ANDROID, ...extra } });
const dela = (ses, id) => (ses.sesiones || []).find(x => x.aparatoId === id);

console.log('\n── 1. Entrar SIN id del aparato: la sesion queda sin codigo ──');
const vieja = await entrar('5500000003', {});                 // Carla, vendedora
ok(!!vieja?.token, 'login de Carla devuelve token', vieja);

console.log('\n── 2. Entrar CON id del aparato ──');
const nueva = await entrar('5500000005', { aparatoId: AP });  // Elsa, vendedora
ok(!!nueva?.token, 'login de Elsa devuelve token', nueva);

console.log('\n── 3. Entrar con un id MALFORMADO: se ignora, y se entra igual ──');
const malo = await entrar('5500000006', { aparatoId: 'NO-VALE!! ' + 'x'.repeat(90) });
ok(!!malo?.token, 'login de Fausto devuelve token igual', malo);

console.log('\n── 4. La lista del dueño ──');
const duenio = await entrar('5500000001', { aparatoId: AP + 'd' });   // Ana, Admin
ok(!!duenio?.token, 'login de Ana (dueña) devuelve token', duenio);
const ses1 = await rpc('sesiones_abiertas', { p_data: { token: duenio.token } });
ok(!!ses1?.ok, 'sesiones_abiertas responde ok', ses1);

const elsa = dela(ses1, AP);
ok(!!elsa, `la sesion de Elsa trae aparatoId=${AP}`, (ses1.sesiones || []).map(x => x.aparatoId));
ok(!!elsa && elsa.nombre === null, 'y todavia SIN nombre (es lo que hay que mirar)', elsa?.nombre);
ok(!!elsa && elsa.aparato === 'Android · Chrome', 'con su descripcion del user-agent', elsa?.aparato);
const laDeCarla = (ses1.sesiones || []).find(x => x.vendedor.startsWith('Carla'));
ok(!!laDeCarla && laDeCarla.aparatoId === null, 'la de Carla (sin id) viene en null → «Sin código»', laDeCarla);
const laDeFausto = (ses1.sesiones || []).find(x => x.vendedor.startsWith('Fausto'));
ok(!!laDeFausto && laDeFausto.aparatoId === null, 'la del id malformado tambien, sin fila basura', laDeFausto);

console.log('\n── 5. Bautizarlo ──');
const bau = await rpc('nombrar_aparato', { p_data: { token: duenio.token, id: AP, nombre: 'Teléfono de Elsa' } });
ok(!!bau?.ok, 'nombrar_aparato responde ok', bau);
const ses2 = await rpc('sesiones_abiertas', { p_data: { token: duenio.token } });
ok(dela(ses2, AP)?.nombre === 'Teléfono de Elsa', 'la lista ya dice «Teléfono de Elsa»', dela(ses2, AP)?.nombre);

console.log('\n── 6. Una vendedora NO puede ver la lista ni bautizar ──');
const comoElsa = await rpc('sesiones_abiertas', { p_data: { token: nueva.token } });
ok(comoElsa?.ok === false && comoElsa?.error === 'solo_dueno', 'sesiones_abiertas con token de vendedora → solo_dueno', comoElsa);
const bauElsa = await rpc('nombrar_aparato', { p_data: { token: nueva.token, id: AP, nombre: 'mio' } });
ok(bauElsa?.ok === false && bauElsa?.error === 'solo_dueno', 'nombrar_aparato con token de vendedora → solo_dueno', bauElsa);
const bauNada = await rpc('nombrar_aparato', { p_data: { token: duenio.token, id: 'noexiste1', nombre: 'x' } });
ok(bauNada?.error === 'no_existe', 'bautizar un aparato que no existe → no_existe', bauNada);

console.log('\n── 7. Dos personas en el MISMO telefono: un aparato, dos sesiones ──');
// Carla y no Gina: el PIN de Gina en staging no es 1234 y el primer intento
// devolvio «PIN incorrecto». El fallo estaba en la premisa de la prueba, no en
// el codigo, y solo se supo por mirar la respuesta (regla 13).
const otraVez = await entrar('5500000003', { aparatoId: AP });
ok(!!otraVez?.token, 'el segundo login entra', otraVez);
const ses3 = await rpc('sesiones_abiertas', { p_data: { token: duenio.token } });
const conEseAp = (ses3.sesiones || []).filter(x => x.aparatoId === AP);
ok(conEseAp.length === 2, 'dos sesiones distintas apuntan al mismo aparato', conEseAp.length);
// `every` sobre un array vacio devuelve true: sin el `length` esta asercion
// pasaba cuando NO habia encontrado ninguna sesion (regla 54).
ok(conEseAp.length > 0 && conEseAp.every(x => x.nombre === 'Teléfono de Elsa'),
   'y las dos lo llaman «Teléfono de Elsa»', conEseAp.map(x => x.nombre));

console.log(`\n${fallos === 0 ? 'TODO EN ORDEN' : fallos + ' FALLO(S)'}\n`);
process.exit(fallos === 0 ? 0 : 1);
