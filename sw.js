const CACHE = 'aretinofoot-v1';
const ASSETS = [
  '/soccerAI-app.html',
  '/manifest.json',
  '/icon-192.svg',
  '/icon-512.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Network-first for ESPN/Betclic API calls
  if (e.request.url.includes('espn.com') || e.request.url.includes('betclic') || e.request.url.includes('localhost:5502')) {
    return; // let browser handle directly
  }
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
