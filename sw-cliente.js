// Service worker do app do cliente (/app) — NETWORK-FIRST.
// Existe por dois motivos: o Chrome só oferece "Instalar app" quando há SW com handler
// de fetch, e o cliente costuma abrir o app com internet ruim.
// Regra de ouro: /api/ NUNCA é cacheado — saldo, cobrança e status têm que vir da rede,
// senão o cliente vê consumo velho e acha que foi roubado.
const CACHE = 'move-cliente-v1';
const CASCA = ['/app', '/app/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CASCA)).catch(() => null));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;     // não intercepta terceiros
  if (url.pathname.startsWith('/api/')) return;   // dados sempre da rede
  if (!url.pathname.startsWith('/app') && !url.pathname.startsWith('/icon-')) return;

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      const cache = await caches.open(CACHE);
      cache.put(req, fresh.clone()).catch(() => null);
      return fresh;
    } catch {
      const hit = await caches.match(req);
      return hit || caches.match('/app');
    }
  })());
});
