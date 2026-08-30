// ============================================================================
//  Crunchy Paps — Configuración pública por entorno
//  Vercel Serverless Function · /api/config.js
//
//  Devuelve JavaScript que define window.__CP_CONFIG__ antes de que arranque
//  la app. Se carga desde el <head> de index.html con un <script src> clásico,
//  que se ejecuta ANTES del <script type="module"> (los módulos son diferidos).
//
//  POR QUÉ EXISTE
//  --------------
//  Antes, la URL y la llave anon de Supabase estaban escritas a mano en
//  index.html. Consecuencia: TODOS los entornos —producción, cada preview de
//  Vercel y cada sesión local— hablaban con la base de PRODUCCIÓN. Ese es el
//  hallazgo 16: una rama de prueba escribía sobre datos de clientes reales.
//
//  Ojo con el matiz: la URL y la llave anon NO son secretos. Viajan al
//  navegador por diseño y siguen siendo visibles en las peticiones de red. Lo
//  que protege los datos son las políticas RLS (ACCESOS.md §3.0). El objetivo
//  de este endpoint no es esconderlas, sino que cada entorno hable con SU base.
//
//  VARIABLES DE ENTORNO EN VERCEL
//  ------------------------------
//    SUPABASE_URL         — ya existe en el proyecto
//    SUPABASE_ANON_KEY    — puede no existir todavía; ver PUBLIC_* abajo
//
//  Opcionalmente, para separar explícitamente lo público de lo del backend:
//    PUBLIC_SUPABASE_URL
//    PUBLIC_SUPABASE_ANON_KEY
//  Si están definidas, tienen prioridad.
//
//  Configura Production con el proyecto de producción y Preview con el de
//  staging (dkwatbsaidlfjqjnfyrk). Ahí es donde se cierra el hallazgo 16.
//
//  REGLA DE ORO
//  ------------
//  Aquí SOLO se exponen las claves de la lista blanca de abajo. Jamás volcar
//  process.env completo: SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, las llaves de
//  Twilio, Resend y Stripe viven en el mismo entorno y filtrarlas al navegador
//  daría acceso total a la base saltándose RLS.
// ============================================================================

module.exports = async (req, res) => {
  // Lista blanca explícita. Nada más sale de aquí.
  const config = {
    SUPABASE_URL:
      process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
    SUPABASE_ANON_KEY:
      process.env.PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '',
    // 'production' | 'preview' | 'development'. Lo pone Vercel solo.
    ENTORNO: process.env.VERCEL_ENV || 'development'
  };

  const faltantes = [];
  if (!config.SUPABASE_URL) faltantes.push('SUPABASE_URL');
  if (!config.SUPABASE_ANON_KEY) faltantes.push('SUPABASE_ANON_KEY');

  // Fallar en voz alta, no en silencio: sin config la app no debe adivinar.
  if (faltantes.length) {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(
      'window.__CP_CONFIG__ = ' + JSON.stringify({ ENTORNO: config.ENTORNO, ERROR: true }) + ';\n' +
      'console.error("[CP] /api/config.js sin variables de entorno: ' +
      faltantes.join(', ') + '. Configúralas en Vercel → Settings → Environment Variables.");\n'
    );
  }

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  // Se cachea en el borde: no es una invocación de función por cada visita.
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400');
  res.status(200).send('window.__CP_CONFIG__ = ' + JSON.stringify(config) + ';\n');
};
