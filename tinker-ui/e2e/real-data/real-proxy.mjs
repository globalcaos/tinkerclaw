/**
 * A built tinker-ui against the LIVE gateway's data, read-only (2026-10-05, bug-log
 * busy-tab-history-and-eeg). Serves the dist under /tinker/, answers the connect handshake itself,
 * forwards ONLY chat.history and sessions.list to the gateway (and sessions.subscribe plus every
 * live event with FORWARD_EVENTS=1, so the page sees real runs and its busy gates engage), proxies
 * GET /tinker/api/context-anatomy, and answers everything else locally. There is no /api/ui-state,
 * so the page keeps its state in the browser context and the owner's tinker-ui-state.json is never
 * written. Nothing it forwards writes.
 *
 * Each chat.history reply is logged (--log, one JSON line per read) and can be dumped whole
 * (--dump <dir>), so a unit test can replay exactly what the page got. POST /__proxy/rows with a
 * JSON array of the page's data-oc-id values answers the oldest timestamp among them: rows are
 * keyed exactly as history-reconcile.ts historyRowIdentity keys them (an import by
 * __openclaw.externalId), or most rows go unrecognised and "the oldest row shown" lies.
 *
 * Usage: [FORWARD_EVENTS=1] node real-proxy.mjs --port 18996 [--dist <dist>] [--log <file>] [--dump <dir>]
 * An archive read (resetArchiveBefore) can hold the gateway's event loop; run one page at a time.
 */
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { WebSocketServer, WebSocket } = require("ws");

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []),
);
const PORT = Number(args.port ?? 18996);
const DIST = resolve(here, args.dist ?? "../../dist");
const LOG = args.log ?? join(os.tmpdir(), "tinker-real-data", "reads.jsonl");
mkdirSync(dirname(LOG), { recursive: true });
const GATEWAY_PORT = Number(process.env.TINKER_GATEWAY_PORT ?? 18789);
const cfg = JSON.parse(readFileSync(join(os.homedir(), ".openclaw", "openclaw.json"), "utf8"));
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || cfg?.gateway?.auth?.token || "";
const EVENTS = Boolean(process.env.FORWARD_EVENTS);
const FORWARD = new Set([
  "chat.history",
  "sessions.list",
  ...(EVENTS ? ["sessions.subscribe"] : []),
]);
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const rowTs = new Map();
const pageSockets = new Set();
let inflight = 0;
let dumpN = 0;
const idOf = (m) => {
  const oc = m?.__openclaw;
  if (typeof oc?.id === "string" && oc.id) return `oc:${oc.id}`;
  const ext = oc?.externalId ?? m?.externalId;
  return typeof ext === "string" && ext ? `ext:${ext}` : null;
};
const tsOf = (m) =>
  typeof m?.timestamp === "number"
    ? m.timestamp
    : typeof m?.timestamp === "string"
      ? Date.parse(m.timestamp)
      : null;

let upstream = null;
let upReady = null;
const upPending = new Map();
let upN = 0;
function connectUpstream() {
  upReady = new Promise((resolveReady, rejectReady) => {
    upstream = new WebSocket(`ws://127.0.0.1:${GATEWAY_PORT}`, {
      headers: { Origin: "http://127.0.0.1:18790", Authorization: `Bearer ${TOKEN}` },
    });
    upstream.on("message", (raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === "res") {
        const h = upPending.get(f.id);
        if (h) {
          upPending.delete(f.id);
          h(f);
        }
        return;
      }
      if (f.type === "event" && f.event !== "connect.challenge") {
        if (EVENTS) for (const s of pageSockets) s.send(String(raw));
        return;
      }
      if (f.type === "event" && f.event === "connect.challenge") {
        const id = `up${++upN}`;
        upPending.set(id, (r) =>
          r.ok ? resolveReady() : rejectReady(new Error(JSON.stringify(r.error))),
        );
        upstream.send(
          JSON.stringify({
            type: "req",
            id,
            method: "connect",
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: "webchat-ui",
                displayName: "Real-data harness (read-only)",
                version: "0.3",
                platform: "web",
                mode: "webchat",
              },
              role: "operator",
              scopes: ["operator.read"],
              caps: ["tool-events"],
              auth: { token: TOKEN },
            },
          }),
        );
      }
    });
    upstream.on("close", () => {
      upstream = null;
      upReady = null;
    });
    upstream.on("error", (e) => rejectReady(e));
  });
  upReady.catch(() => {});
  return upReady;
}
async function forward(method, params) {
  if (!upReady) connectUpstream();
  try {
    await upReady;
  } catch (e) {
    return {
      ok: false,
      error: { code: "UNAVAILABLE", message: `harness: gateway unreachable (${e?.message ?? e})` },
    };
  }
  return new Promise((res) => {
    const id = `up${++upN}`;
    upPending.set(id, res);
    upstream.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__proxy/rows") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let oldest = null;
      let known = 0;
      for (const id of body ? JSON.parse(body) : []) {
        const t = rowTs.get(id);
        if (t === undefined) continue;
        known++;
        if (oldest === null || t < oldest) oldest = t;
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ inflight, known, oldest }));
    });
    return;
  }
  if (url.pathname.startsWith("/tinker/api/context-anatomy/") && req.method === "GET") {
    const t0 = Date.now();
    const up = httpRequest(
      {
        host: "127.0.0.1",
        port: GATEWAY_PORT,
        path: url.pathname + url.search,
        method: "GET",
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
      (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => {
          let count = null;
          try {
            count = JSON.parse(body).count;
          } catch {}
          appendFileSync(
            LOG,
            `${JSON.stringify({ t: Date.now(), kind: "anatomy", path: url.pathname + url.search, status: r.statusCode, ms: Date.now() - t0, count })}\n`,
          );
          res.writeHead(r.statusCode ?? 502, { "content-type": "application/json" }).end(body);
        });
      },
    );
    up.on("error", () => res.writeHead(502).end("{}"));
    up.end();
    return;
  }
  if (url.pathname.startsWith("/tinker/api/")) {
    res.writeHead(404, { "content-type": "application/json" }).end("{}");
    return;
  }
  let rel = url.pathname.replace(/^\/tinker\/?/, "");
  if (rel === "" || rel === "login" || !extname(rel)) rel = "index.html";
  const file = join(DIST, rel);
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  if (rel === "index.html") {
    const html = readFileSync(file, "utf-8").replace(
      "<head>",
      `<head><script>window.__TINKER_CONFIG={token:"harness"};</script>`,
    );
    res.writeHead(200, { "content-type": "text/html" }).end(html);
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  pageSockets.add(ws);
  ws.on("close", () => pageSockets.delete(ws));
  ws.send(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "n", ts: Date.now() },
    }),
  );
  ws.on("message", async (raw) => {
    let f;
    try {
      f = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (f.type !== "req") return;
    const send = (ok, payload, error) => {
      try {
        ws.send(JSON.stringify({ type: "res", id: f.id, ok, payload, error }));
      } catch {}
    };
    if (f.method === "connect") {
      send(true, {
        type: "hello-ok",
        protocol: 3,
        server: { version: "harness" },
        features: { methods: [], events: [] },
        snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } },
        policy: {},
      });
      return;
    }
    if (f.method === "sessions.subscribe" && !EVENTS) {
      send(true, {});
      return;
    }
    if (!FORWARD.has(f.method)) {
      send(false, undefined, {
        code: "UNAVAILABLE",
        message: `harness: ${f.method} not forwarded`,
      });
      return;
    }
    const t0 = Date.now();
    inflight++;
    let r;
    try {
      r = await forward(f.method, f.params);
    } finally {
      inflight--;
    }
    if (f.method === "chat.history") {
      const rows = r.ok ? (r.payload?.messages ?? []) : [];
      let oldest = null;
      for (const m of rows) {
        const id = idOf(m);
        const t = tsOf(m);
        if (id && t !== null) rowTs.set(id, t);
        if (t !== null && (oldest === null || t < oldest)) oldest = t;
      }
      const p = { ...f.params };
      delete p.sessionKey;
      const c = r.payload?.cursor;
      appendFileSync(
        LOG,
        `${JSON.stringify({ t: Date.now(), kind: "history", sk: f.params?.sessionKey, params: p, ok: r.ok, err: r.ok ? undefined : r.error?.message, ms: Date.now() - t0, rows: rows.length, oldest, cursor: c ? { epoch: Boolean(c.epoch), firstSeq: c.firstSeq, hasMoreBefore: c.hasMoreBefore, reset: c.reset } : null, archive: r.payload?.archive ?? null })}\n`,
      );
      if (args.dump) {
        mkdirSync(args.dump, { recursive: true });
        const n = String(++dumpN).padStart(4, "0");
        writeFileSync(
          join(args.dump, `${n}-${String(f.params?.sessionKey).split(":").pop()}.json`),
          JSON.stringify({
            t: Date.now(),
            params: f.params,
            ok: r.ok,
            payload: r.payload,
            error: r.error,
          }),
        );
      }
    }
    send(r.ok, r.payload, r.error);
  });
});
server.listen(PORT, "127.0.0.1", () =>
  console.log(
    `real-data proxy on http://127.0.0.1:${PORT}/tinker/ (events ${EVENTS ? "on" : "off"})`,
  ),
);
