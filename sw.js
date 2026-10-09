// Service worker : met l'application (pas l'audio, qui est dans IndexedDB) en cache, par version.
importScripts('version.js');
const CACHE = 'lecteur-app-' + self.APP_VERSION;                    // l'application : un cache par version
const TOOLS = 'lecteur-tools-' + self.TOOLS_VERSION;                // les gros composants WebAssembly : cache séparé, mis en cache à la première utilisation
const TOOL_PATHS = ['/vendor/ffmpeg/', '/vendor/opus/'];
const SHELL = ['./', 'index.html', 'styles.css', 'themes.js', 'app.js', 'ogg-opus.js', 'drive.js', 'meta.js', 'version.js',
  'stretch.js', 'stretch-core.js', 'stretch-worker.js', 'vendor/signalsmith/signalsmith-stretch-wasm.js',
  'opus-pack.js', 'convert-core.js', 'convert-worker.js', 'converter.js', 'converter-lib.js', 'vendor/VERSIONS.json',
  'vendor/opus-decoder.min.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];

// Installation : tout ou rien. 'reload' contourne le cache HTTP pour ne pas figer des fichiers périmés.
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
  // pas de skipWaiting automatique : l'utilisateur choisit quand mettre à jour (pas de coupure en pleine lecture)
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('lecteur-') && k !== CACHE && k !== TOOLS) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;   // Google Drive, etc. : réseau direct, jamais mis en cache ici
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') return caches.match('index.html');
    const res = await fetch(req);
    if (res.status === 200 && TOOL_PATHS.some(p => url.pathname.includes(p))) await (await caches.open(TOOLS)).put(req, res.clone());
    return res;
  })());
});

self.addEventListener('message', e => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });
