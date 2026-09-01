/* A tombstone, not a service worker.
 *
 * The app used to be served at `/` and registered a service worker there, so every browser
 * that ever opened this instance has one scoped to the whole origin. The app now lives at
 * `/app/` and registers `/app/sw.js` instead — but the old registration does not go away on
 * its own, and while it is alive it is the thing answering for `/`: it would keep handing
 * returning visitors a cached copy of the application where the project site now is.
 *
 * So `/sw.js` still exists, and what it does is uninstall itself. The browser fetches this
 * file on the next navigation in scope, sees bytes that differ from the worker it has, and
 * installs it — at which point it deletes every cache this origin accumulated and unregisters.
 * The page that triggered it is then reloaded once, uncontrolled, and gets the real site.
 *
 * Nothing new registers this. It is reached only by a browser that already has the old worker,
 * and on a client that never had one it is simply a file nobody asks for. Deleting it is safe
 * once no browser in the wild still carries a registration from before the move — which is not
 * a date anybody can know, so it stays.
 */
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Caches are per-origin, not per-registration: unregistering alone would leave the old
    // app shell sitting in storage forever, counting against the origin's quota.
    await Promise.all((await caches.keys()).map(key => caches.delete(key)))
    await self.registration.unregister()
    // Reload whatever is open. These clients are still controlled by this worker for the
    // life of their current page; a navigation is what hands them back to the network.
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      client.navigate(client.url).catch(() => {})
    }
  })())
})

// No fetch handler on purpose. A worker with none is transparent — every request goes to the
// network as if it were not there, which is exactly what is wanted for the minutes between
// this activating and the last tab reloading.
