/**
 * Mock gateway + static server for the ADVICE LINE checks (Broca retrieval v2, phase E, FORK 2026-10-06).
 *
 * Serves the built `tinker-ui/dist` under /tinker/ and speaks just enough of the gateway protocol on the same port:
 * the connect handshake, one session, and a chat history in which some user turns carry the `<recipe_advice>` tag the
 * matcher hook appends (and one carries none, and one is a runtime notice). Binds to 127.0.0.1 only, never connects to
 * anything else, and RECORDS every request frame it receives, so a check can say "the page sent no chat.send".
 *
 * Control (HTTP, same port):
 *   POST /__mock/advice {line, sessionKey?, kind?}  broadcasts the trail event the hook emits live
 *                                                   (`prefrontal-trail-event`, kind "advice", payload.adviceLine).
 *   GET  /__mock/frames                             the request methods received so far, in order.
 *
 * Usage: node mock-gateway.mjs --port 18997 --dist ../../dist
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
const PORT = Number(args.port ?? 18997);
const DIST = resolve(here, args.dist ?? "../../dist");
const SESSION = "agent:main:tinker:advice1";

export const LINE_JEV =
  "Use: plan-family-trip, flight-scan · Inspiration: review-site (§ Build the page) · source: Jev";
export const LINE_LOCAL = "Use: acme-coding · source: local";

const tag = (source, line) => `<recipe_advice source="${source}">${line}</recipe_advice>`;
const t0 = Date.parse("2026-10-06T08:00:00Z");
const text = (role, t, i, extra = {}) => ({
  role,
  content: [{ type: "text", text: t }],
  timestamp: t0 + i * 60_000,
  __openclaw: { id: `m-${i}` },
  ...extra,
});

const messages = [
  // 1. a prompt with advice from Jev (the line must reappear after a reload, from the stored tag)
  text(
    "user",
    `Plan the summer motorhome holiday for the family\n\n---\n\n${tag("Jev", LINE_JEV)}`,
    1,
  ),
  text("assistant", "I have drafted three options: Scotland, the Alps and Brittany.", 2),
  // 2. a plain prompt, nothing appended
  text("user", "Thanks, which one is cheapest?", 3),
  text("assistant", "Brittany by a clear margin.", 4),
  // 3. a prompt with a local list and an active recipe
  text(
    "user",
    `Code the new commit diagram\n\n---\n\n<active_recipe kits="globalcaos/acme-coding" steps="4" title="Acme coding" path="/home/u/.openclaw/recipes/acme-coding/recipe.md">A plan was auto-seeded.</active_recipe>\n\n${tag("local", LINE_LOCAL)}`,
    5,
  ),
  text("assistant", "Starting with the diagram.", 6),
  // 4. a runtime notice: owed no advice, and none stored
  text("user", "[System] The gateway restarted; your plans continue.", 7),
  text("assistant", "Continuing.", 8),
  // 5. the live prompt: the advice event arrives for this one
  text("user", "Download the film Project Hail Mary in the best quality", 9),
];

const frames = [];
const sockets = new Set();
const send = (event, payload) => {
  const frame = JSON.stringify({ type: "event", event, payload });
  for (const ws of sockets) if (ws.readyState === 1) ws.send(frame);
};

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
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
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = body ? JSON.parse(body) : {};
    if (url.pathname === "/__mock/advice") {
      send("agent", {
        runId: "run-live",
        sessionKey: j.sessionKey ?? SESSION,
        stream: "lifecycle",
        data: {
          phase: "prefrontal-trail-event",
          kind: j.kind ?? "advice",
          message: j.line,
          label: "advice",
          payload: { adviceLine: j.line, adviceSource: "Jev" },
          ts: Date.now(),
          sessionKey: j.sessionKey ?? SESSION,
        },
        sessionKey: j.sessionKey ?? SESSION,
      });
    }
    if (url.pathname === "/__mock/frames") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(frames));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
}

function answer(method, params) {
  if (method === "connect")
    return {
      type: "hello-ok",
      protocol: 3,
      server: { version: "mock" },
      features: { methods: [], events: [] },
      snapshot: { sessionDefaults: { mainSessionKey: SESSION } },
      policy: {},
    };
  if (method === "sessions.list")
    return {
      sessions: [
        {
          key: SESSION,
          sessionKey: SESSION,
          label: "Advice",
          title: "Advice",
          updatedAt: Date.now(),
          kind: "direct",
          model: "mock-model",
        },
      ],
      count: 1,
    };
  if (method === "chat.history")
    return { sessionKey: String(params?.sessionKey ?? SESSION), messages };
  if (method === "sessions.subscribe") return {};
  throw new Error(`unknown method: ${method}`);
}

const wss = new WebSocketServer({ server });
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
    frames.push(f.method);
    try {
      ws.send(
        JSON.stringify({ type: "res", id: f.id, ok: true, payload: answer(f.method, f.params) }),
      );
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
