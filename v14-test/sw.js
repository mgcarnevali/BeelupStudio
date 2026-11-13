// Versión de prueba en /v14-test/: caché propia; sólo limpia sus propias cachés.
const CACHE = 'beelup-studio-v14-test-12';
const ASSETS = ['./', './index.html', './style.css', './app.js', './studio.js', './picker.js', './remux.js', './icon.svg', './manifest.webmanifest',
  './fonts/inter-var.woff2', './fonts/barlow-condensed-500.woff2', './fonts/barlow-condensed-600.woff2', './fonts/barlow-condensed-700.woff2',
  './fonts/jbmono-400.woff2', './fonts/jbmono-500.woff2'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('beelup-studio-v14-test') && key !== CACHE).map(key => caches.delete(key))))); self.clients.claim(); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Siempre se revalida con el servidor (sin usar copias de la caché HTTP del navegador).
  event.respondWith(fetch(event.request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(response => { if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); } return response; }).catch(() => caches.match(event.request, { ignoreSearch: true })));
});
