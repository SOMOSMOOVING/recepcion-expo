/* Service Worker — Recepción Expo Mooving
   Para que el link abra aunque en la puerta no haya señal: guarda la página y
   los logos la primera vez que se abre con conexión.

   VERSION tiene que ser igual a APP_VERSION del index.html, y SHELL tiene que
   tener los logos de LOGO (los controla test/app.test.mjs): al publicar una
   versión nueva, cambian los dos. */
const VERSION = "v1";
const PREFIJO = "recepcion-expo-";
const CACHE = PREFIJO + VERSION;
const SHELL = ["./", "./index.html", "./assets/logo-claro.png", "./assets/logo-oscuro.png"];
const FUENTES = ["fonts.googleapis.com", "fonts.gstatic.com"];
const ESPERA_RED_MS = 3000;   // con señal que conecta pero no contesta, no dejar la pantalla en blanco

self.addEventListener("install", e => {
  // si algún archivo falla, la instalación sigue: sin caché la app anda igual con señal
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

/* Borra solo las versiones viejas de ESTA app. La app de pedidos está en el
   mismo sitio (somosmooving.github.io) y comparte los cachés: los suyos no se
   tocan, que sin ellos no anda sin señal. */
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(claves => Promise.all(claves.filter(k => k.startsWith(PREFIJO) && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ¿Es la app? (la raíz o index.html). Otras páginas del sitio, como el
   diseño, no se guardan como si fueran la app. */
function esLaApp(url) {
  const raiz = new URL("./", self.registration.scope).pathname;
  return url.pathname === raiz || url.pathname === raiz + "index.html";
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // NUNCA tocar Supabase: son datos vivos (y POST en su mayoría)
  if (url.hostname.endsWith(".supabase.co")) return;

  // la app: primero la red (así llega la versión nueva); si no contesta a
  // tiempo o no hay señal, la guardada
  if (url.origin === location.origin && esLaApp(url)) {
    const deLaRed = fetch(req).then(r => {
      if (r.ok) { const copia = r.clone(); caches.open(CACHE).then(c => c.put("./index.html", copia)); }
      return r;
    });
    const aTiempo = new Promise(ok => setTimeout(ok, ESPERA_RED_MS)).then(() => caches.match("./index.html"));
    e.respondWith(
      Promise.race([deLaRed.catch(() => caches.match("./index.html")), aTiempo])
        .then(r => r || deLaRed)   // sin copia guardada: esperar a la red lo que haga falta
    );
    return;
  }

  // logos, fuentes y demás: lo guardado, y si no está, de la red (y se guarda)
  if (url.origin === location.origin || FUENTES.includes(url.hostname)) {
    e.respondWith(
      caches.match(req).then(guardado => guardado || fetch(req).then(r => {
        if (r.ok || r.type === "opaque") { const copia = r.clone(); caches.open(CACHE).then(c => c.put(req, copia)); }
        return r;
      }))
    );
  }
});
