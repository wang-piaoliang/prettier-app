/* prettier · Service Worker
   只缓存应用外壳（HTML/CSS/JS/图标）。
   照片和记录走鉴权接口，一律不进 Cache Storage —— 那是共享缓存，
   私密内容留在里面，换人登录或设备被别人拿到都可能被翻出来。

   改动外壳后把 VERSION 加一，旧缓存会在 activate 时清掉。 */

const VERSION = 'prettier-v76';

// 路径一律用 './'，不要写成 index.html：
// Cloudflare 的静态资源托管会把 /index.html 307 重定向到 /，
// 而 cache.addAll 遇到重定向响应会直接抛错，整个 SW 就装不上。
const SHELL = [
  './',
  './offline.html',
  './assets/app.css',
  './assets/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 接口请求直接放行，不碰缓存
  if (url.pathname.startsWith('/api/')) return;
  // 跨域的一律不管（同步 Worker 在另一个域上）
  if (url.origin !== self.location.origin) return;

  // 导航请求：网络优先，断网回退到离线页
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('./', copy));
          return res;
        })
        .catch(() => caches.match('./').then((r) => r || caches.match('./offline.html')))
    );
    return;
  }

  // 外壳资源：网络优先，缓存只做离线兜底。
  // 曾用缓存优先 + 版本号失效，结果改了代码重新部署后，
  // 装过的设备一直拿旧的 app.js —— 排查了很久才发现是 SW 在发旧文件。
  // 应用本来就要联网取数据，网络优先没有额外代价，却少一整类"改了没生效"的问题。
  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req))
  );
});
