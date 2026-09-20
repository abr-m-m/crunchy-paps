// Una sola vez: saca el primer <style> a src/estilos.css y el <script type="module"> a src/app.js.
// Trabaja por índices de línea localizados con anclas exactas; falla si alguna no es única.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
// Este checkout usa core.autocrlf=true (Windows): en disco index.html trae CRLF aunque
// git lo guarda en LF (comprobado con `git show HEAD:index.html`). Se normaliza a LF antes
// de partir por líneas para que las anclas comparen igual; la salida queda en LF, como ya
// está en el repo, y el próximo checkout la vuelve a convertir a CRLF sin tocar el contenido.
const html = readFileSync('index.html', 'utf8').replace(/\r\n/g, '\n');
const lineas = html.split('\n');
const unico = (pred, nombre) => { const idx = lineas.map((l, i) => pred(l) ? i : -1).filter((i) => i >= 0); if (idx.length !== 1) { console.error(`ancla no única (${idx.length}): ${nombre}`); process.exit(1); } return idx[0]; };
const iStyle = lineas.findIndex((l) => l === '<style>');                 // el primero
const fStyle = lineas.findIndex((l, i) => i > iStyle && l === '</style>');
const iMod = unico((l) => l === '<script type="module">', 'script module');
const fMod = lineas.findIndex((l, i) => i > iMod && l === '</script>');
if (iStyle < 0 || fStyle < 0 || fMod < 0) { console.error('no encontré style/module'); process.exit(1); }
mkdirSync('src', { recursive: true });
writeFileSync('src/estilos.css', lineas.slice(iStyle + 1, fStyle).join('\n') + '\n');
writeFileSync('src/app.js', lineas.slice(iMod + 1, fMod).join('\n') + '\n');
const salida = [
  ...lineas.slice(0, iStyle), '<link rel="stylesheet" href="/src/estilos.css">',
  ...lineas.slice(fStyle + 1, iMod), '<script type="module" src="/src/app.js"></script>',
  ...lineas.slice(fMod + 1),
];
writeFileSync('index.html', salida.join('\n'));
console.log(`estilos.css ${fStyle - iStyle - 1} líneas · app.js ${fMod - iMod - 1} líneas · index.html ${salida.length} líneas`);
