/// <reference lib="WebWorker" />
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import {
  NetworkFirst,
  StaleWhileRevalidate,
  CacheFirst,
} from "workbox-strategies";
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { ExpirationPlugin } from "workbox-expiration";

declare const self: ServiceWorkerGlobalScope;

// With registerType: "autoUpdate" + strategies: "injectManifest", the custom
// service worker must opt into skipWaiting/clientsClaim itself — vite-plugin-pwa
// only injects these automatically for the generateSW strategy. Without them a
// newly deployed SW installs but stays in the "waiting" state indefinitely, so
// returning users keep being served the old precached index.html and hashed
// chunks (i.e. they never see new UI like the invoice Save button) until every
// tab is closed. Activating immediately lets the injected autoUpdate registrar
// reload open clients onto the fresh build.
self.skipWaiting();
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

cleanupOutdatedCaches();

precacheAndRoute(self.__WB_MANIFEST);

registerRoute(
  ({ url }) =>
    url.pathname.includes("/api/") ||
    url.pathname.startsWith("/api"),
  new NetworkFirst({
    cacheName: "api-cache",
    networkTimeoutSeconds: 10,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
);

registerRoute(
  ({ request }) =>
    request.destination === "script" ||
    request.destination === "style",
  new StaleWhileRevalidate({
    cacheName: "static-assets",
    plugins: [new CacheableResponsePlugin({ statuses: [0, 200] })],
  }),
);

registerRoute(
  ({ request }) => request.destination === "image",
  new CacheFirst({
    cacheName: "image-assets",
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 60, maxAgeSeconds: 30 * 24 * 60 * 60 }),
    ],
  }),
);

registerRoute(
  ({ request, url }) =>
    request.mode === "navigate" &&
    !url.pathname.startsWith("/api") &&
    !url.pathname.startsWith("/downloads") &&
    !url.pathname.startsWith("/uploads"),
  async ({ request }) => {
    try {
      return await fetch(request);
    } catch {
      const cached = await caches.match("offline.html");
      return cached ?? new Response("You are offline.", { status: 503 });
    }
  },
);
