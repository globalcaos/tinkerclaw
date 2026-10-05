#!/usr/bin/env node
/* Refresh Obramat session cookies from the user's shared Chrome tab via the
 * browser relay's CDP endpoint. Writes the cookie jar (mode 0600).
 *
 * Prereq: the user has an obramat.es tab open with THEIR store selected
 * (the store context is baked into the `customer_context` cookie) and has
 * shared that tab through the browser relay.
 *
 * Usage:  node refresh_cookies.js [cdpPort]
 *   cdpPort            default $OBRAMAT_CDP_PORT, else 18792 (relay default)
 *   OBRAMAT_COOKIE_FILE  where to write (default <skill>/state/cookies.json)
 *   OBRAMAT_STORE        optional; warn if the tab has a different store selected
 *   OBRAMAT_WS_MODULE    optional path to the `ws` package, only needed on
 *                        Node < 22 (Node 22+ has a built-in WebSocket)
 *
 * Safety: talks to the relay on loopback only, keeps cookies whose domain is
 * obramat.es only, and never prints a cookie value.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const WS = globalThis.WebSocket || require(process.env.OBRAMAT_WS_MODULE || "ws");
const PORT = process.argv[2] || process.env.OBRAMAT_CDP_PORT || "18792";
const OUT = process.env.OBRAMAT_COOKIE_FILE || path.join(__dirname, "..", "state", "cookies.json");
const EXPECTED = (process.env.OBRAMAT_STORE || "").trim();

const isObramat = (domain) => /(^|\.)obramat\.es$/i.test((domain || "").replace(/^\./, ""));

function getTargets() {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}/json/list`, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function storeOf(cookies) {
  const c = cookies.find((x) => x.name === "customer_context");
  if (!c) return null;
  try {
    const ctx = JSON.parse(decodeURIComponent(c.value));
    const s =
      (ctx.stores_name || []).find((x) => String(x.id) === String(ctx.main_store)) ||
      (ctx.stores_name || [])[0];
    return {
      id: ctx.main_store || (s && s.id) || null,
      name: s ? String(s.name || "").replace(/\+/g, " ") : null,
    };
  } catch (e) {
    return null;
  }
}

const fold = (s) =>
  (s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

(async () => {
  const targets = await getTargets();
  const t = targets.find((x) => {
    if (x.type !== "page") return false;
    try {
      return isObramat(new URL(x.url).hostname);
    } catch (e) {
      return false;
    }
  });
  if (!t) {
    console.error("NO_OBRAMAT_PAGE: ask the user to open + share an obramat.es tab");
    process.exit(2);
  }
  const ws = new WS(t.webSocketDebuggerUrl);
  const timeout = setTimeout(() => {
    console.error("TIMEOUT");
    process.exit(2);
  }, 20000);
  ws.onerror = (e) => {
    console.error("WS_ERR", (e && e.message) || "websocket error");
    process.exit(2);
  };
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Network.getAllCookies" }));
  ws.onmessage = (ev) => {
    const d = JSON.parse(String(ev.data));
    if (d.id !== 1) return;
    clearTimeout(timeout);
    if (d.error) {
      console.error("CDP_ERR", JSON.stringify(d.error));
      process.exit(3);
    }
    const cookies = ((d.result && d.result.cookies) || []).filter((c) => isObramat(c.domain));
    if (!cookies.some((c) => c.name === "datadome")) {
      console.error("NO_DATADOME_COOKIE — is the tab on obramat.es and past the bot check?");
      process.exit(4);
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(cookies, null, 1), { mode: 0o600 });
    fs.chmodSync(OUT, 0o600);
    const store = storeOf(cookies);
    console.log(`OK: ${cookies.length} cookies written to ${OUT}`);
    console.log(
      `STORE: ${store && store.name ? `${store.name} (id ${store.id})` : "unknown — pick a store on obramat.es and refresh again"}`,
    );
    if (EXPECTED && store && store.name && fold(store.name) !== fold(EXPECTED)) {
      console.error(
        `WARN_STORE_MISMATCH: tab has '${store.name}', OBRAMAT_STORE is '${EXPECTED}' — switch store in the tab and refresh again`,
      );
    }
    try {
      ws.close();
    } catch (e) {
      /* ignore */
    }
    process.exit(0);
  };
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(2);
});
