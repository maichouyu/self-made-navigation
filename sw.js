/* sw.js — 自製導航 v3.9 PWA */
'use strict';

const VERSION = 'nav-v3.9.1';
const SHELL_CACHE = `${VERSION}-shell`;
const TILE_CACHE = `${VERSION}-tiles`;
const MAX_TILE_ENTRIES = 600;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// 這些主機的請求一律走網路，不快取（即時資料）
const NETWORK_ONLY_HOSTS = [
  'navigation.leochang101817.workers.dev',
  'router.project-osrm.org',
  'graphhopper.com',
  'api.leochangrainapi.com',
  'weatherapp.leochang101817.workers.dev',
];

function isTileRequest(url) {
  return /(^|\.)tile\.openstreetmap\.org$/.test(url.hostname);
}

function isNetworkOnly(url) {
  return NETWORK_ONLY_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS.map(u => new Request(u, { cache: 'reload' }))))
      .catch((err) => {
        // 個別 CDN 失敗不要讓整個 install 失敗；至少本檔可離線
        console.warn('[SW] shell precache partial failure', err);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(k => k !== SHELL_CACHE && k !== TILE_CACHE)
          .map(k => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// 只允許同源導覽請求被快取回退
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // 1) 即時資料：永不快取
  if (isNetworkOnly(url)) {
    event.respondWith(fetch(req).catch(() => new Response(
      JSON.stringify({ ok: false, error: 'OFFLINE' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )));
    return;
  }

  // 2) 圖磚：cache-first，限制數量
  if (isTileRequest(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(TILE_CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && (res.ok || res.type === 'opaque')) {
            cache.put(req, res.clone()).then(() => trimCache(cache, MAX_TILE_ENTRIES)).catch(() => {});
          }
          return res;
        } catch (e) {
          return new Response('', { status: 504, statusText: 'Tile offline' });
        }
      })()
    );
    return;
  }

  // 3) 導覽請求：network-first，離線回 index.html
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          // no-cache：繞過 GitHub Pages 的 HTTP 快取(max-age=600)，每次向伺服器驗證最新 HTML
          const res = await fetch(req, { cache: 'no-cache' });
          if (res && res.ok) {
            const cache = await caches.open(SHELL_CACHE);
            cache.put('./index.html', res.clone()).catch(() => {});
          }
          return res;
        } catch (e) {
          const cache = await caches.open(SHELL_CACHE);
          return (await cache.match('./index.html')) ||
            new Response('離線中，且尚未快取導航頁面', {
              status: 503,
              headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        }
      })()
    );
    return;
  }

  // 4) 其他靜態資源（CDN 的 Leaflet 等）：stale-while-revalidate
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
          return res;
        })
        .catch(() => null);
      return hit || (await network) || new Response('', { status: 504 });
    })()
  );
});

async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const remove = keys.length - maxEntries;
  for (let i = 0; i < remove; i++) {
    await cache.delete(keys[i]);
  }
}
