// vite.config.mjs — Fase 0 (cambios/2026-09-19-partir-monolito/diseno.md).
// index.html en la raíz es la entrada; public/ se copia tal cual; dist/ lo publica Vercel.
import { defineConfig } from 'vite';

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
});
