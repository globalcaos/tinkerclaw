// pdf-review offline (2026-11-10): reading, comments and paragraph edits must work on a long flight with no
// connection. Registered by viewer/web/offline.js,
// only on a secure origin (the tailnet HTTPS door), with scope = the mount ("/pdf/" on the phone).
//   - The viewer's own files: network first (a viewer change still arrives at once), the kept copy when
//     the network fails or takes over 4 s. The whole viewer is fetched into the cache on install.
//   - A PDF under papers/: the copy kept on this device, at once (offline.js checks the server's
//     signature afterwards and fetches only a changed file). Marks saved while offline are a second
//     copy (pending/…) and win over the kept one until they reach the server.
//   - A few GET /api/… answers (source text, origin, history, the book list, bookmark, voices): network
//     first, the last answer when offline.
// The page writes the PDF copies (offline.js); this worker only reads them, so there is one writer.
const SCOPE = new URL(self.registration.scope).pathname.replace(/\/$/, ""); // "" or "/pdf"
const SHELL = "pdfreview-shell-v1";
const DOCS = "pdfreview-docs-v1";
const API = "pdfreview-api-v1";
const API_KEPT = ["/api/source", "/api/origin", "/api/history", "/api/books", "/api/bookmark", "/api/voices", "/api/editdraft", "/api/folder"];
const NET_WAIT_MS = 4000;

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    try {
      const r = await fetch(`${SCOPE}/api/offline-manifest`, { cache: "no-store" });
      const { files } = await r.json();
      // Each file on its own, so a single missing file does not fail the whole install. Code before
      // pictures and six at a time (2026-11-10): on a slow relayed link the 154 files went one per
      // second, pictures first, and the phone lost the network before pdf.mjs, the last in the list.
      const late = (f) => (/\/images\/|\/locale\/|\.(svg|png|gif|cur|ftl)$/i.test(f) ? 1 : 0);
      const queue = [...files].sort((x, y) => late(x) - late(y));
      const worker = async () => {
        for (let f = queue.shift(); f !== undefined; f = queue.shift()) {
          try {
            const res = await fetch(SCOPE + f, { cache: "no-store" });
            if (res.ok) await cache.put(SCOPE + f, res);
          } catch {}
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
    } catch (err) {
      console.error("[sw] precaching the viewer failed", err);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

const local = (path) => path.startsWith(`${SCOPE}/`) ? path.slice(SCOPE.length) : null;

async function networkFirst(req, cacheName, key = req) {
  const cache = await caches.open(cacheName);
  // A redirect (a captive Wi-Fi portal answering for the Pi) is no answer: use the kept copy.
  const net = fetch(req).then(async (res) => {
    if (res.redirected) throw new Error(`redirected to ${res.url}`);
    if (res.ok) await cache.put(key, res.clone());
    return res;
  });
  net.catch(() => {}); // a late failure after the kept copy was used is not an error
  const timeout = new Promise((r) => setTimeout(r, NET_WAIT_MS, null));
  try {
    const first = await Promise.race([net, timeout]);
    if (first) return first;
    return (await cache.match(key)) || await net;
  } catch (err) {
    const kept = await cache.match(key);
    if (kept) return kept;
    throw err;
  }
}

async function keptPdf(req, path) {
  const docs = await caches.open(DOCS);
  const hit = (await docs.match(`${SCOPE}/__pending__${path}`)) || (await docs.match(SCOPE + path));
  if (!hit) return fetch(req);
  // No Accept-Ranges: pdf.js then reads the whole body instead of asking for byte ranges.
  const h = new Headers(hit.headers);
  h.delete("Accept-Ranges");
  return new Response(hit.body, { status: 200, headers: h });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const path = local(url.pathname);
  if (path === null) return;
  if (req.method !== "GET") return;
  if (path.startsWith("/papers/") && /\.pdf$/i.test(path)) {
    // A fresh read (reload after a change, fetch ahead: offline.js fresh()) goes to the server, and the page
    // keeps the result. Marked in the URL: Chromium does not pass cache: "no-store" on to the worker.
    if (url.searchParams.has("fresh")) return;
    e.respondWith(keptPdf(req, decodeURIComponent(path)));
    return;
  }
  if (path.startsWith("/viewer/")) {
    e.respondWith(networkFirst(req, SHELL, req.mode === "navigate" ? SCOPE + path : req));
    return;
  }
  if (API_KEPT.includes(path)) {
    e.respondWith(networkFirst(req, API));
  }
});
