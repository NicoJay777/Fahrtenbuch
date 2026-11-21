// Offline-Speicher für die App-Dateien. Bei jeder Auslieferung VERSION erhöhen.
const VERSION = "fb-v4";
const FILES = [
  "./", "index.html", "style.css", "app.js", "config.js", "manifest.webmanifest",
  "icon-180.png", "icon-192.png", "icon-512.png",
  "vendor/supabase.js", "vendor/jspdf.umd.min.js", "vendor/jspdf.plugin.autotable.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting())); // am Browser-Cache vorbei
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return; // Supabase & Co. nie cachen
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) =>
      hit || fetch(e.request).catch(() => caches.match("index.html"))
    )
  );
});
