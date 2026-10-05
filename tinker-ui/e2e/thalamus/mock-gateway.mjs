/**
 * Mock gateway + static server for the Thalamus v4 panel checks (charter phase G).
 *
 * Serves the built `tinker-ui/dist` under /tinker/ (with `window.__TINKER_CONFIG` injected) and speaks just enough of the
 * gateway protocol on the same port: the connect handshake, a session list, a chat history, and `thalamus.panel`. It
 * binds to 127.0.0.1 only and never connects to anything else. Every method it does not know answers with an
 * "unknown method" error, which is exactly what a gateway without the plugin does: that is the off state.
 *
 * Control (HTTP, same port): POST /__mock/state {thalamus?: "absent" | "ok" | "error", panel?: object, message?: string}
 * replaces the canned answer; GET /__mock/calls returns and clears the log of every method the page called.
 *
 * Usage: node mock-gateway.mjs --port 18996 --dist ../../dist
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []),
);
const PORT = Number(args.port ?? 18996);
const DIST = resolve(here, args.dist ?? "../../dist");
const TAB = "agent:main:tinker:mocktab";

const state = { thalamus: "absent", panel: null, message: "gateway timed out", calls: [] };

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/__mock/")) return control(req, res, url);
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
      `<head><script>window.__TINKER_CONFIG={token:"mock"};</script>`,
    );
    res.writeHead(200, { "content-type": "text/html" }).end(html);
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});

function control(req, res, url) {
  if (url.pathname === "/__mock/calls") {
    const out = state.calls.splice(0);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = body ? JSON.parse(body) : {};
    if (url.pathname === "/__mock/state") Object.assign(state, j);
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
}

const wss = new WebSocketServer({ server });
const session = () => ({
  key: TAB,
  sessionKey: TAB,
  label: "Mock chat",
  title: "Mock chat",
  updatedAt: Date.now(),
  kind: "direct",
  model: "mock",
});

function answer(method) {
  if (method === "connect")
    return {
      type: "hello-ok",
      protocol: 3,
      server: { version: "mock" },
      features: { methods: [], events: [] },
      snapshot: {},
      policy: {},
    };
  if (method === "sessions.list") return { sessions: [session()], count: 1 };
  if (method === "chat.history") return { sessionKey: TAB, messages: [] };
  if (method === "sessions.subscribe") return {};
  // The Models panel draws only once the page has its model catalog; these are the few methods that make it paint.
  if (method === "config.models")
    return {
      primary: "claude-code/claude-opus-5",
      fallbacks: [],
      models: {
        "claude-code/claude-opus-5": { alias: "Opus 5", rank: 1 },
        "claude-code/claude-sonnet-5-5": { alias: "Sonnet 5.5", rank: 2 },
        "claude-code/claude-haiku-4-5": { alias: "Haiku 4.5", rank: 3 },
        "xai/grok-4.7": { alias: "Grok 4.7", rank: 4 },
      },
      authProfiles: {},
      authOrder: {},
    };
  if (method === "budget.status") return {};
  if (method === "prefrontal.status")
    return { concurrencyCap: 6, cores: 8, policyPath: "/home/user/.openclaw/orca-policy.md" };
  if (method === "prefrontal.routes") return { routes: [] };
  if (method === "thalamus.panel") {
    if (state.thalamus === "absent") throw new Error(`unknown method: ${method}`);
    if (state.thalamus === "error") throw new Error(state.message);
    return { ok: true, ...state.panel };
  }
  throw new Error(`unknown method: ${method}`);
}

wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "n", ts: Date.now() },
    }),
  );
  ws.on("message", (raw) => {
    let f;
    try {
      f = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (f.type !== "req") return;
    state.calls.push({ method: f.method });
    try {
      ws.send(JSON.stringify({ type: "res", id: f.id, ok: true, payload: answer(f.method) }));
    } catch (e) {
      ws.send(
        JSON.stringify({
          type: "res",
          id: f.id,
          ok: false,
          error: { code: "UNAVAILABLE", message: String(e.message ?? e) },
        }),
      );
    }
  });
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`mock gateway on http://127.0.0.1:${PORT}/tinker/`),
);
