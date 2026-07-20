// sw.js — Arete Monitor PWA service worker.
// Precache the app shell; serve cache-first with background refresh so the
// app opens instantly (and offline shows the shell), while updates arrive on
// the next load. Realm traffic is WebSocket and never touches this worker.

const VERSION = 'arete-monitor-pwa-v3';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './monitor.css',
  './mobile.css',
  './browser-arete.js',
  './renderer.js',
  './arete-model.js',
  './monitor.js',
  './connections.js',
  './contexts.js',
  './graph.js',
  './logo.png',
  './icon-192.png',
  './icon-512.png',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // registry fetches etc. go direct
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fresh = fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
