/**
 * Mock gateway + static server for the amygdala UI checks (design doc §9, Phase F).
 *
 * Serves the built `tinker-ui/dist` under /tinker/ (with `window.__TINKER_CONFIG` injected) and speaks just enough of the
 * gateway protocol on the same port: the connect handshake, a session list, a chat history, and the `amygdala2.*` methods.
 * It never connects to anything else. Every method it does not know answers with an error, which is exactly what a gateway
 * without the plugin does — that is the inert-state test.
 *
 * Control (HTTP, same port): POST /__mock/state {status?, feed?, history?, amygdala?: boolean} replaces the canned answers;
 * POST /__mock/event {event, payload} pushes an event to every socket; GET /__mock/calls returns and clears the log of
 * every method the page called (the writes label/answer/rewind/approve/undo are recorded here, not performed).
 *
 * Usage: node mock-gateway.mjs --port 18995 --dist ../../dist
 */
import { createReadStream, existsSync, statSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc),
      [],
    ),
);
const PORT = Number(args.port ?? 18995);
const DIST = resolve(here, args.dist ?? "../../dist");
const TAB = "agent:main:tinker:mocktab";

const state = { amygdala: true, status: null, feed: {}, history: [], calls: [], rewindReply: null };

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
    if (url.pathname === "/__mock/event") broadcast(j.event, j.payload);
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
}

const wss = new WebSocketServer({ server });
const sockets = new Set();
function broadcast(event, payload) {
  const frame = JSON.stringify({ type: "event", event, payload });
  for (const s of sockets) if (s.readyState === 1) s.send(frame);
}

const session = () => ({
  key: TAB,
  sessionKey: TAB,
  label: "Mock chat",
  title: "Mock chat",
  updatedAt: Date.now(),
  kind: "direct",
  model: "mock",
});

function answer(method, params) {
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
  if (method === "chat.history") return { sessionKey: TAB, messages: state.history };
  if (method === "sessions.subscribe") return {};
  if (method.startsWith("amygdala2.")) {
    if (!state.amygdala) throw new Error(`unknown method: ${method}`);
    if (method === "amygdala2.status") return state.status;
    if (method === "amygdala2.feed") return { status: state.status, ...state.feed };
    if (method === "amygdala2.rewind") {
      state.calls.push({ method, params });
      return (
        state.rewindReply ?? {
          ok: true,
          restoredPrompt: "the refused request",
          forkSessionId: "fork-1",
        }
      );
    }
    state.calls.push({ method, params });
    return { ok: true };
  }
  throw new Error(`unknown method: ${method}`);
}

wss.on("connection", (ws) => {
  sockets.add(ws);
  ws.on("close", () => sockets.delete(ws));
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
    if (!f.method.startsWith("amygdala2.") || !state.amygdala)
      state.calls.push({ method: f.method });
    try {
      const payload = answer(f.method, f.params);
      ws.send(JSON.stringify({ type: "res", id: f.id, ok: true, payload }));
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
