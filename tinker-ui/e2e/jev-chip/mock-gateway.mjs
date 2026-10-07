/**
 * Mock gateway + static server for the JEV CHIP checks (Jev ships dormant, phase C, FORK 2026-10-06).
 *
 * Serves a built `tinker-ui` under /tinker/ and speaks just enough of the gateway protocol on the same port: the connect
 * handshake, one session with a short history, and `jev.status` answering a state the checks change from outside. Binds to
 * 127.0.0.1 only, connects to nothing else, and RECORDS every request frame so a check can say "the page sent no chat.send".
 *
 * Control (HTTP, same port):
 *   POST /__mock/jev {state, keySource?, breakerOpen?, tokenHelpUrl?}  sets the status and broadcasts the `jev.status` event
 *                                                                     the gateway sends when the availability changes.
 *   GET  /__mock/frames                                                the request methods received so far, in order.
 *
 * `--no-jev` mimics an older gateway: `jev.status` is an unknown method.
 * Usage: node mock-gateway.mjs --port 18998 --dist /tmp/jevship/ui-new [--no-jev]
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const args = Object.fromEntries(
  argv.reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []),
);
const PORT = Number(args.port ?? 18998);
const DIST = resolve(here, args.dist ?? "../../dist");
const NO_JEV = argv.includes("--no-jev");
const SESSION = "agent:main:tinker:jevchip1";
const ENABLES = ["safety checks", "routing reads", "recipe ranking"];
const TOKEN_FILE = "/home/demo/.openclaw/jev/token";

const lineOf = (s) =>
  s.state === "dormant"
    ? `Jev: off — no token (enables: ${ENABLES.join(", ")})`
    : s.state === "rejected"
      ? "Jev: off — the token was rejected by Jev"
      : s.breakerOpen
        ? "Jev: on — paused for a moment after errors"
        : s.state === "unverified"
          ? "Jev: on — token not checked yet"
          : "Jev: on";
let status = { state: "dormant", breakerOpen: false, keySource: null };
const snapshot = () => ({
  state: status.state,
  on: status.state === "unverified" || status.state === "armed",
  keySource: status.keySource,
  reason:
    status.state === "dormant" ? "no-token" : status.state === "rejected" ? "token-rejected" : "ok",
  since: Date.now(),
  lastProbe: null,
  breakerOpen: status.breakerOpen,
  enables: ENABLES,
  tokenFile: TOKEN_FILE,
  ...(status.tokenHelpUrl ? { tokenHelpUrl: status.tokenHelpUrl } : {}),
  line: lineOf(status),
});

const t0 = Date.parse("2026-10-06T08:00:00Z");
const text = (role, t, i) => ({
  role,
  content: [{ type: "text", text: t }],
  timestamp: t0 + i * 60_000,
  __openclaw: { id: `m-${i}` },
});
const messages = [
  text("user", "What is the state of the Jev checks on this machine?", 1),
  text("assistant", "No token is set, so they are off; everything else works.", 2),
  text("user", "Thanks.", 3),
  text("assistant", "Any time.", 4),
  text("user", "Ok, one more thing.", 5),
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
    if (url.pathname === "/__mock/jev") {
      status = {
        state: j.state ?? "dormant",
        breakerOpen: j.breakerOpen === true,
        keySource: j.keySource ?? null,
        ...(j.tokenHelpUrl ? { tokenHelpUrl: j.tokenHelpUrl } : {}),
      };
      if (!NO_JEV) send("jev.status", snapshot());
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
          label: "Jev",
          title: "Jev",
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
  if (method === "jev.status" && !NO_JEV) return snapshot();
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
  console.log(
    `mock gateway on http://127.0.0.1:${PORT}/tinker/ (jev ${NO_JEV ? "absent" : "present"})`,
  ),
);
