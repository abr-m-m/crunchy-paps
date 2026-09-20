// vite.config.mjs — Fase 0 (cambios/2026-09-19-partir-monolito/diseno.md).
// index.html en la raíz es la entrada; public/ se copia tal cual; dist/ lo publica Vercel.
import { defineConfig } from 'vite';

// `npm run dev` contra STAGING: mismas tres rutas que ver-en-staging.mjs
// (sesión de prueba, /api/config.js, /api/imagen-reto), montadas ANTES de los
// middlewares propios de Vite — si no, su manejo estático vería /api/config.js
// en disco (CommonJS crudo) antes de que este plugin respondiera.
const staging = {
  name: 'crunchy-staging',
  async configureServer(server) {
    // Import dinámico: `vite build` no debe cargar este módulo, que pide la llave al CLI de
    // Supabase en su nivel superior y aborta si no lo encuentra. En Vercel no hay CLI.
    const { manejarStaging } = await import('./tools/staging-middleware.mjs');
    server.middlewares.use((req, res, next) => {
      manejarStaging(req, res).then((h) => { if (!h) next(); }).catch(next);
    });
  },
};

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',        // el módulo no usa await de nivel superior, pero así no hay sorpresas
    sourcemap: false,
    minify: 'esbuild',
  },
  server: { port: 5173, host: true },
  plugins: [staging],
});
