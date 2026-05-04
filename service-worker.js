// Crunchy Paps — Service Worker mínimo
// Permite "instalar" la PWA y muestra el splash con icon. No cachea HTML
// para garantizar que siempre tomen la versión más reciente del index.html.

const CACHE_NAME = 'crunchy-paps-v1';
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
