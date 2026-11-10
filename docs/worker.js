// VIDAA build: replaces upstream's offline service worker, which caches this
// host's files while ignoring ?ver= and would pin stale VIDAA layer code on
// the TV. This worker wipes any cache and unregisters itself.
self.addEventListener('install', function (e) { e.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', function (e) {
    e.waitUntil(
        caches.keys()
            .then(function (names) { return Promise.all(names.map(function (n) { return caches.delete(n); })); })
            .then(function () { return self.registration.unregister(); })
    );
});
