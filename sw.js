/* INK service worker — offline app shell, share target */
const CACHE = 'ink-v15';
const SHELL = ['./', './index.html', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png',
  './icon-maskable-192.png', './icon-maskable-512.png',
  './ink.css', './ink-reader.css',
  './ink-app.js', './ink-util.js', './ink-ui.js', './ink-db.js', './ink-settings.js', './ink-lib.js', './ink-meta.js', './ink-zip.js',
  './ink-import.js', './ink-covers.js', './ink-cards.js', './ink-home.js', './ink-browse.js', './ink-search.js', './ink-settings-ui.js',
  './ink-onboard.js', './ink-stats.js', './ink-night.js', './ink-dict.js', './ink-pdfjs.js', './ink-comic-src.js',
  './ink-reader.js', './ink-selbar.js', './ink-engine-epub.js', './ink-epub-content.js', './ink-engine-pdf.js', './ink-engine-comic.js',
  './vendor-pdf.min.mjs', './vendor-pdf.worker.min.mjs'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== 'ink-share').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        const cache = await caches.open('ink-share');
        let i = 0;
        for (const f of form.getAll('books')) {
          if (!f || !f.name) continue;
          await cache.put('/shared/' + (i++) + Date.now(), new Response(f, { headers: { 'x-name': encodeURIComponent(f.name), 'content-type': f.type || 'application/octet-stream' } }));
        }
      } catch (err) { /* ignore */ }
      return Response.redirect('./index.html?shared=1', 303);
    })());
    return;
  }
  if (req.method !== 'GET') return;
  if (url.origin === location.origin) {
    // stale-while-revalidate for the app itself; vendor files are big and immutable → cache first
    const vendor = /vendor-/.test(url.pathname);
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req, { ignoreSearch: true });
      if (vendor && hit) return hit;
      const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
      return hit || (await net) || (req.mode === 'navigate' ? c.match('./index.html') : Response.error());
    }));
    return;
  }
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }).catch(() => null);
      return hit || (await net) || Response.error();
    }));
  }
});
