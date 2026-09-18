/*
 * Sideout service worker (spec 5.3: installable, offline read of the pages a player has
 * opened). Plain JavaScript on purpose: it is served as-is from public/ and registered by
 * src/components/offline/ServiceWorkerRegistration.tsx with the build sha as `?v=`, which
 * this file reads as its cache version so a new build starts from empty caches and drops
 * the old ones on activation.
 *
 * What it does, and what it deliberately does not:
 *
 * - Precaches the offline page (with the scripts and styles it references), the manifest and
 *   the icons at install.
 * - `/_next/static/*` (content-hashed, immutable): cache first.
 * - Page navigations: network first with a short timeout, the copy kept in the pages cache
 *   so the signed-in player's own event, pool and match pages open without signal; the
 *   offline page when nothing is cached.
 * - `GET /api/tournaments/*`, `/api/matches/*`, `/api/me`: network first, cached for the
 *   same offline read.
 * - Nothing else is touched: POSTs (the score outbox in src/lib/offline/ replays those),
 *   Next's RSC navigations (the framework retries them itself once the connection returns),
 *   the dev routes, and every cross-origin request go straight to the network.
 *
 * A sign-out posts `{ type: "clear-pages" }`; the pages and API caches are dropped so a
 * shared phone does not keep the previous player's pages.
 */

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const SHELL_CACHE = `sideout-shell-${VERSION}`;
const PAGES_CACHE = `sideout-pages-${VERSION}`;
const ASSETS_CACHE = `sideout-assets-${VERSION}`;
const API_CACHE = `sideout-api-${VERSION}`;
const OWN_CACHES = new Set([SHELL_CACHE, PAGES_CACHE, ASSETS_CACHE, API_CACHE]);

const OFFLINE_URL = '/offline';
const PRECACHE = [OFFLINE_URL, '/manifest.webmanifest', '/icon.svg', '/icons/icon-192.png'];
/** Navigations answered from the network within this many ms; slower than that, a cached copy wins and the fetch still refreshes the cache. */
const NAVIGATION_TIMEOUT_MS = 4000;
/** Most recent page navigations kept per version. */
const PAGES_LIMIT = 80;
const API_LIMIT = 120;

const PAGE_DENYLIST = [/^\/sign-in/, /^\/api\//, /^\/health$/, /^\/offline$/, /^\/organizer/, /^\/admin/];
const API_ALLOWLIST = [/^\/api\/tournaments(\/|$)/, /^\/api\/matches\//, /^\/api\/me$/];

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

/**
 * The offline page is a Next route: its HTML alone hydrates nothing, so the scripts and
 * stylesheets it references (content-hashed, under /_next/static) are cached with it. One
 * missing asset does not fail the install; the page then renders unhydrated, which still reads.
 */
async function precacheShell() {
  const shell = await caches.open(SHELL_CACHE);
  await shell.addAll(PRECACHE);
  const offline = await shell.match(OFFLINE_URL, { ignoreVary: true });
  if (!offline) return;
  const html = await offline.clone().text();
  const assets = new Set(Array.from(html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g), (m) => m[1]));
  const cache = await caches.open(ASSETS_CACHE);
  await Promise.all(Array.from(assets, (url) => cache.add(url).catch(() => undefined)));
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('sideout-') && !OWN_CACHES.has(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'clear-pages') {
    event.waitUntil(Promise.all([caches.delete(PAGES_CACHE), caches.delete(API_CACHE)]));
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Next's own navigations and refreshes carry the RSC header; the framework retries them when the connection returns.
  if (request.headers.get('RSC') === '1' || url.searchParams.has('_rsc')) return;

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request, ASSETS_CACHE));
    return;
  }
  if (url.pathname.startsWith('/_next/')) return;

  if (request.mode === 'navigate') {
    const cacheable = !PAGE_DENYLIST.some((re) => re.test(url.pathname));
    event.respondWith(navigationNetworkFirst(request, cacheable));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    if (API_ALLOWLIST.some((re) => re.test(url.pathname))) event.respondWith(networkFirst(request, API_CACHE, API_LIMIT));
    return;
  }

  if (PRECACHE.includes(url.pathname) || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});

/** A same-origin 200 that is safe to keep. */
function storable(response) {
  return Boolean(response) && response.ok && response.type === 'basic';
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (storable(response)) await cache.put(request, response.clone());
  return response;
}

async function networkFirst(request, cacheName, limit) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (storable(response)) {
      await cache.put(request, response.clone());
      await trim(cache, limit);
    }
    return response;
  } catch (err) {
    const hit = await cache.match(request, { ignoreVary: true });
    if (hit) return hit;
    throw err;
  }
}

/**
 * Network first for a page, but a slow network loses to a cached copy after
 * NAVIGATION_TIMEOUT_MS (the fetch keeps going and refreshes the cache when it lands).
 * With no network and no copy, the offline page.
 */
async function navigationNetworkFirst(request, cacheable) {
  const cache = await caches.open(PAGES_CACHE);
  const fromNetwork = fetch(request).then(async (response) => {
    if (cacheable && storable(response) && (response.headers.get('content-type') || '').includes('text/html')) {
      await cache.put(request, response.clone());
      await trim(cache, PAGES_LIMIT);
    }
    return response;
  });
  const cached = cacheable ? cache.match(request, { ignoreVary: true, ignoreSearch: false }) : Promise.resolve(undefined);

  const timeout = new Promise((resolve) => setTimeout(() => resolve(undefined), NAVIGATION_TIMEOUT_MS));
  try {
    const first = await Promise.race([fromNetwork, timeout]);
    if (first) return first;
    const hit = await cached;
    if (hit) return hit;
    return await fromNetwork;
  } catch (err) {
    const hit = await cached;
    if (hit) return hit;
    const offline = await (await caches.open(SHELL_CACHE)).match(OFFLINE_URL, { ignoreVary: true });
    if (offline) return offline;
    throw err;
  }
}

/** Drop the oldest entries past `limit`; the Cache API keeps insertion order. */
async function trim(cache, limit) {
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  await Promise.all(keys.slice(0, keys.length - limit).map((key) => cache.delete(key)));
}
