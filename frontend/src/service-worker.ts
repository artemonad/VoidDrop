/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

// Self-destructing Service Worker to programmatically clear old PWA caches and unregister
self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event: ExtendableEvent) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            // Delete all cache databases
            return Promise.all(keys.map((key) => caches.delete(key)));
        }).then(() => {
            // Unregister the service worker itself
            return self.registration.unregister();
        }).then(() => {
            // Force reload all open pages under this service worker's control
            return self.clients.matchAll();
        }).then((clients) => {
            clients.forEach((client) => {
                if (client.url && typeof client.navigate === 'function') {
                    client.navigate(client.url);
                }
            });
        })
    );
});
