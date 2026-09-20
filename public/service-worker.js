// Crunchy Paps — Service Worker
//
// v3 (19 sep 2026): index.html se sirve DESDE CACHÉ y se revalida en segundo
// plano (stale-while-revalidate). Antes era network-first sin caché de HTML
// «para que siempre tomen la versión más reciente»; el precio era una pantalla
// en blanco con red lenta y ninguna app sin red (diagnóstico del 19 sep 2026,
// cambios/2026-09-19-rendimiento-diagnostico.md). Decisión de Abraham: la
// última que bajaste abre al instante; si al revalidar llegó una distinta, la
// página recibe {versionNueva:true} y enseña «Hay una versión nueva ·
// Actualizar». Nunca se recarga sola.
//
// Subir la versión obliga a los clientes instalados a tomar este worker y
// borra las cachés anteriores (activate).
const CACHE_NAME = 'crunchy-paps-v3';
const ASSETS_CACHE = [
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
];
// Una sola copia de index.html para cualquier navegación a la raíz: `/?ir=armado`,
// `/?track=…` y los UTM comparten el mismo archivo. La página sigue viendo su URL.
const CLAVE_INDEX = '/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => Promise.all([
      cache.addAll(ASSETS_CACHE),
      // Precarga de index.html para que la SEGUNDA apertura ya salga de caché
      // (la primera la sirve el worker anterior o ninguno). Si falla, no
      // impide instalar: la navegación siguiente lo guardará.
      cache.add(CLAVE_INDEX).catch(() => {}),
    ]))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function esIndex(request, url) {
  return request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html');
}

function esHTMLValido(resp) {
  return !!resp && resp.ok && /text\/html/.test(resp.headers.get('content-type') || '');
}

// ¿Cambió index.html? Con ETag (Vercel lo manda) basta compararlos; sin ETag
// (el servidor local de staging) se compara el cuerpo.
async function esDistinta(guardada, nueva) {
  const e1 = guardada.headers.get('etag'), e2 = nueva.headers.get('etag');
  if (e1 && e2) return e1 !== e2;
  const [t1, t2] = await Promise.all([guardada.text(), nueva.text()]);
  return t1 !== t2;
}

function avisarVersionNueva() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
    lista.forEach((c) => { try { c.postMessage({ versionNueva: true }); } catch (_e) {} });
  });
}

async function servirIndex(event) {
  const cache = await caches.open(CACHE_NAME);
  const guardada = await cache.match(CLAVE_INDEX);
  // Copia para comparar después: el cuerpo de `guardada` se lo lleva la página.
  const guardadaCopia = guardada ? guardada.clone() : null;

  const traer = fetch(event.request).then(async (resp) => {
    if (!esHTMLValido(resp)) return resp;   // un 404/500 nunca pisa la copia buena
    const paraCache = resp.clone();
    const paraComparar = resp.clone();
    await cache.put(CLAVE_INDEX, paraCache);
    if (guardadaCopia && await esDistinta(guardadaCopia, paraComparar)) await avisarVersionNueva();
    return resp;
  });

  if (guardada) {
    // Abre al instante con la copia; la revalidación sigue aunque la página ya pintó.
    event.waitUntil(traer.catch(() => {}));
    return guardada;
  }
  // Sin copia: red, como siempre (si falla, falla a la vista, igual que antes).
  return traer;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Solo manejar GET
  if (event.request.method !== 'GET') return;

  // index.html: caché primero, revalidación en segundo plano.
  if (esIndex(event.request, url)) {
    event.respondWith(servirIndex(event));
    return;
  }

  // Para íconos y manifest: cache-first (cambian poco)
  if (ASSETS_CACHE.some(a => url.pathname.endsWith(a))) {
    event.respondWith(
      caches.match(event.request).then(r => r || fetch(event.request))
    );
    return;
  }

  // Para todo lo demás (/api/*, /planeador, /retos…): network-first, como antes.
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// ── Push «Pedido nuevo» (cola de pedidos, entrega 4) ──────────────────────
// El servidor manda {titulo, cuerpo, tag, url}. Si el cuerpo no es JSON,
// se enseña como texto. Al tocar la notificación se abre (o enfoca) la app
// en Armado.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_e) { d = { cuerpo: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.titulo || 'Crunchy Paps', {
    body: d.cuerpo || '',
    tag: d.tag || 'pedido',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: d.url || '/?ir=armado' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/?ir=armado';
  // Si la app ya está abierta se enfoca y se le AVISA por mensaje a dónde ir:
  // `navigate` solo funciona en ventanas que este worker controla, y tras un
  // despliegue la ventana abierta puede seguir siendo del worker anterior
  // (15 sep 2026: la notificación enfocaba la app y no llegaba a Armado).
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
    const c = lista.find((w) => 'focus' in w);
    if (c) {
      return c.focus().then((w) => { try { (w || c).postMessage({ ir: 'armado' }); } catch (_e) {} return w; });
    }
    return self.clients.openWindow(url);
  }));
});
