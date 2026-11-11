const SHELL = 'undertale-shell-v13';
const DATA = 'undertale-cache-v1';
const ROOT = new URL('./', self.location).href;
const STATIC = ['./', './index.html', './style.css', './app.js', './assets.json', './fonts/8bitoperator-jve.woff', './fonts/8bitoperator-plus.woff', './fonts/8bitoperator-plus-bold.woff', './runtime/butterscotch.mjs', './runtime/audio-buffer.mjs', './runtime/butterscotch.wasm'];
self.addEventListener('install', event => event.waitUntil((async () => {
  await (await caches.open(SHELL)).addAll(STATIC.map(path => new Request(new URL(path, ROOT).href,{cache:'reload'})));
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
function isolated(response) {
  if (!response.ok || response.type === 'opaque') return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
}
self.addEventListener('fetch', event => {
  const {request} = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || !url.href.startsWith(ROOT)) return;
  const isGame = url.href.startsWith(new URL('game/', ROOT).href);
  if (!isGame && !STATIC.some(path => new URL(path, ROOT).href === url.href)) return;
  // Audio range requests must not poison the full-file cache with a 206 response.
  event.respondWith((async () => {
    const cache = await caches.open(isGame ? DATA : SHELL);
    const fullRequest = new Request(request.url, {credentials:'same-origin'});
    let response = await cache.match(fullRequest);
    if (!response) {
      response = await fetch(fullRequest);
      if (response.status === 200) {
        const saved = response.clone();
        event.waitUntil(cache.put(fullRequest, saved).catch(error => console.warn('Cache write failed', error)));
      }
    }
    if (request.headers.has('range') && response.status === 200) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range'));
      if (range && (range[1] || range[2])) {
        const blob = await response.blob();
        const start = range[1] ? Number(range[1]) : Math.max(0, blob.size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), blob.size - 1) : blob.size - 1;
        if (start > end || start >= blob.size) return new Response(null, {status:416,headers:{'Content-Range':`bytes */${blob.size}`}});
        return new Response(blob.slice(start,end+1),{status:206,headers:{'Content-Type':response.headers.get('Content-Type') || 'application/octet-stream','Content-Range':`bytes ${start}-${end}/${blob.size}`,'Content-Length':String(end-start+1),'Accept-Ranges':'bytes'}});
      }
    }
    return request.mode === 'navigate' ? isolated(response) : response;
  })());
});
