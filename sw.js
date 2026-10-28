const CACHE_NAME = 'watchlist-v4';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // Same-origin only; posters and fonts go straight to their CDNs.
  if (!req.url.startsWith(self.location.origin)) return;
  // The app's own API is live (and the Claude part is metered): never cached here.
  if (new URL(req.url).pathname.startsWith('/api/')) return;

  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    e.respondWith(htmlStrategy(req));
    return;
  }
  e.respondWith(caches.match(req).then(cached => cached || fetch(req)));
});

// Network-first for the page so new code shows up when online, with a short
// timeout so a spotty connection falls back to the cached shell.
async function htmlStrategy(req) {
  let cached;
  try { cached = (await caches.match(req)) || (await caches.match('/')); } catch (e) {}
  try {
    const net = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500))
    ]);
    if (net && net.ok) {
      caches.open(CACHE_NAME).then(c => c.put('/', net.clone())).catch(() => {});
      return net;
    }
    return cached || net;
  } catch (e) {
    return cached || fetch(req);
  }
}
