// Zeiko Drive service worker (scope /): app-shell caching + Web Share Target (files
// shared from other apps are stashed in IndexedDB, then the app uploads them to My Drive). Never
// caches API or file bytes.
const SHELL = 'zk-shell-v2';
const BASE = '';
// The Worker's own pages and bytes, never the app: the API, downloads, previews, archives, ad
// pages, unsubscribe links, shared links (64 letters and digits, then the signature).
const NEVER = /^\/(api|d|z|p|ad|berhenti|__dev)\/|^\/[0-9A-Za-z]{64}\//;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll([`${BASE}/drive`]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('zk-share-target', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files', { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function stashShared(request) {
  const form = await request.formData();
  const files = form.getAll('files').filter((f) => typeof f !== 'string');
  const db = await idb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    for (const f of files) tx.objectStore('files').add(f);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return Response.redirect(`${BASE}/drive?shared=${files.length}`, 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (e.request.method === 'POST' && url.pathname === `${BASE}/share-target`) {
    e.respondWith(stashShared(e.request));
    return;
  }
  if (e.request.method !== 'GET' || NEVER.test(url.pathname)) return;
  if (e.request.mode === 'navigate') {
    // Network first; offline → cached shell.
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok && res.headers.get('content-type')?.includes('text/html')) {
            const copy = res.clone();
            void caches.open(SHELL).then((c) => c.put(`${BASE}/drive`, copy));
          }
          return res;
        })
        .catch(() => caches.match(`${BASE}/drive`).then((r) => r || Response.error())),
    );
    return;
  }
  if (url.pathname.startsWith(`${BASE}/assets/`)) {
    // Hashed build assets are immutable.
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              void caches.open(SHELL).then((c) => c.put(e.request, copy));
            }
            return res;
          }),
      ),
    );
  }
});
