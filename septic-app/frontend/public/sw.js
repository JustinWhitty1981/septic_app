/*
 * The app shell cache. DRV-12: "usable with no network after launch".
 *
 * The outbox solves half of that sentence — a driver can *record* things offline. This file
 * solves the other half, which is that without it there is no app to record them in: with no
 * signal, the browser cannot fetch index.html, cannot fetch the bundle, and shows a blank
 * page. Everything the driver taps next is irrelevant.
 *
 * ## Why nothing is precached
 *
 * CRA hashes every asset filename, so a build-time list of files to install would be wrong
 * after the next `npm run build` and would fail in the one situation it exists for — a
 * device that has been offline long enough to miss the update. Instead the cache is filled
 * as the app is used, so whatever the driver loaded online the last time they had signal is
 * what loads offline. The cost is honest and worth stating: a driver who installs the app and
 * immediately drives into a dead zone has nothing cached, and there is no version of this
 * file that fixes that without a precache manifest the build would have to generate.
 *
 * ## What must never be cached
 *
 * Anything under /api/auth/. A login response carries a bearer token, and the Cache API is
 * not a secure store — it is plain storage readable by any script that runs on this origin,
 * it survives a logout, and it survives the token being revoked server-side. Caching it would
 * mean a tablet signed out in the office could quietly present a stale session at the next
 * jobsite. The write endpoints are safe by construction: they are not GET, and non-GET
 * requests are not intercepted at all.
 */

const VERSION = 'v1';
const SHELL_CACHE = `septic-shell-${VERSION}`;
const API_CACHE = `septic-api-${VERSION}`;

/** Never stored, never served from store. */
const NEVER_CACHE = ['/api/auth/'];

function isNeverCache(url) {
  return NEVER_CACHE.some((p) => url.pathname.indexOf(p) === 0);
}

self.addEventListener('install', () => {
  // No precache to fetch. Taking effect immediately is what lets a driver's first online
  // launch start filling the cache at once rather than after a reload.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          // Old versions have to go, or a year of updates leaves a phone holding every
          // bundle this app has ever shipped.
          names.filter((n) => n.indexOf('septic-') === 0 && n !== SHELL_CACHE && n !== API_CACHE)
            .map((n) => caches.delete(n))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return; // writes go straight to the network, or to nowhere

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // fonts and anything else are their own problem
  if (isNeverCache(url)) return;

  if (url.pathname.indexOf('/api/') === 0) {
    event.respondWith(apiRead(request, url));
    return;
  }

  event.respondWith(shell(request, url));
});

/**
 * Network first, cache only when the network failed.
 *
 * A dispatch list is the opposite of a stylesheet: serving a stale one quietly is how a
 * driver pumps a site the office already moved to another truck. So the cache is a fallback,
 * never a shortcut, and the response is marked so the app can say so out loud instead of
 * letting the driver assume the list in front of them is today's.
 */
async function apiRead(request, url) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(API_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) {
      return new Response(await cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers: new Headers({ ...Object.fromEntries(cached.headers.entries()), 'X-Served-From': 'cache' }),
      });
    }
    // Nothing cached and nothing to ask. A JSON 503 is what lets the screen say "no signal"
    // rather than hanging on a request that will never settle.
    return new Response(
      JSON.stringify({ success: false, message: 'Offline, and this day has not been loaded yet.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Stale while revalidate.
 *
 * The right way round for a bundle: an old copy of the app is enormously better than no app,
 * and it does not matter that the copy is a week old. The dispatch list above is the one
 * place where being current matters, which is why the two have opposite strategies.
 */
async function shell(request, url) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);

  if (cached) {
    network; // kicked off in the background; the caller never waits for it
    return cached;
  }
  const fresh = await network;
  if (fresh) return fresh;
  return new Response('Offline, and this file was never cached.', { status: 503 });
}
