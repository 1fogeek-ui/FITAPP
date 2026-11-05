// Tempo · service worker : notifications du coach + ouverture de l'appli même sans réseau.
const SHELL = "tempo-shell-v1";

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Page d'accueil : toujours la version la plus récente quand il y a du réseau ; la dernière copie sinon.
self.addEventListener("fetch", (event) => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return; // les appels vers Supabase ne passent jamais par ici
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const res = await fetch(req.url, { cache: "no-cache", credentials: "same-origin" });
        if (res.ok) { const c = await caches.open(SHELL); await c.put("./", res.clone()); }
        return res;
      } catch (e) {
        const c = await caches.open(SHELL);
        return (await c.match("./")) || Response.error();
      }
    })());
  }
});

// Réception d'un message du coach
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : "" }; }
  const title = d.title || "Tempo";
  const options = { body: d.body || "", icon: d.icon || "icon-192.png", badge: d.badge || "badge-96.png", tag: d.tag || "tempo", renotify: !!d.tag, data: { url: d.url || "./" } };
  // Safari exige qu'une notification soit toujours affichée à la réception d'un message ; on prévient aussi les pages ouvertes (la cloche se met à jour)
  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    pages.forEach((c) => c.postMessage({ type: "push" }));
  })());
});

// Un appui sur la notification ouvre (ou ramène au premier plan) l'appli
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) { if (c.url.startsWith(self.registration.scope) && "focus" in c) { c.postMessage({ type: "open-inbox" }); return c.focus(); } } // appli déjà ouverte : on y ouvre la cloche
    return self.clients.openWindow(target); // sinon l'adresse se termine par #messages : l'appli ouvre la cloche au démarrage
  })());
});
