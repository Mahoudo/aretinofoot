const CACHE = 'aretinofoot-v24';
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

// ── Clic sur une notification → ouvrir ou focus l'app ─────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const matchId = e.notification.data?.matchId;
  const url = '/';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Si l'app est déjà ouverte → la mettre au premier plan
      const existing = list.find(c => c.url.includes(self.location.origin));
      if(existing){
        existing.focus();
        if(matchId) existing.postMessage({ type: 'OPEN_MATCH', matchId });
        return;
      }
      // Sinon ouvrir un nouvel onglet
      return clients.openWindow(url);
    })
  );
});
