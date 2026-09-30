const CACHE_NAME = 'ottawa-river-navigator-v5';
const CORE_ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './hydro/hydro_1550A.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin) return;

  const isNavigation = request.mode === 'navigate';
  const isCoreAsset = CORE_ASSETS.some(asset => {
    const assetUrl = new URL(asset, self.registration.scope);
    return assetUrl.href === url.href;
  });

  if (!isNavigation && !isCoreAsset) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then(cached => {
        if (cached) return cached;
        if (isNavigation) return caches.match('./index.html');
        return Response.error();
      }))
  );
});
