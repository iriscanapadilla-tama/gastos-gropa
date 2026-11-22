// Service worker: permite instalar la app en el celular y abrirla rápido.
// Las páginas se piden primero al servidor (siempre la versión más nueva);
// la copia guardada solo se usa si no hay conexión. Los datos (/api) nunca
// se guardan aquí.
const CACHE = 'gastos-v6';
const SHELL = ['/', '/app.js', '/estilos.css', '/manifest.webmanifest', '/iconos/iris-192.png', '/iconos/iris-apple-180.png'];
// Si la red tarda más de esto, se abre la copia guardada (señal débil).
const NETWORK_TIMEOUT = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const fromCache = () => caches.match(e.request).then((r) => r || caches.match('/'));
  const fromNetwork = fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  });
  e.respondWith(new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done && r) { done = true; resolve(r); } };
    const timer = setTimeout(() => fromCache().then((r) => { if (r) finish(r); }), NETWORK_TIMEOUT);
    fromNetwork
      .then((r) => { clearTimeout(timer); finish(r); })
      .catch(() => { clearTimeout(timer); fromCache().then((r) => finish(r || Response.error())); });
  }));
});
