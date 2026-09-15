// Crunchy Paps — Service Worker mínimo
// Permite "instalar" la PWA y muestra el splash con icon. No cachea HTML
// para garantizar que siempre tomen la versión más reciente del index.html.

// v2 (15 sep 2026): push «Pedido nuevo». Subir la versión obliga a los
// clientes instalados a tomar este worker.
const CACHE_NAME = 'crunchy-paps-v2';
const ASSETS_CACHE = [
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_CACHE))
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

// Network-first para todo (especialmente HTML y API).
// Solo los íconos/manifest se sirven del cache si la red falla.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Solo manejar GET
  if (event.request.method !== 'GET') return;

  // Para íconos y manifest: cache-first (cambian poco)
  if (ASSETS_CACHE.some(a => url.pathname.endsWith(a))) {
    event.respondWith(
      caches.match(event.request).then(r => r || fetch(event.request))
    );
    return;
  }

  // Para todo lo demás (incluido index.html y /api/sheets): network-first
  // Si la red falla, intentamos cache (no debería caer en index.html porque no lo cacheamos).
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
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
    for (const c of lista) {
      if ('focus' in c) { c.navigate(url); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
