/**
 * Mock gateway + static server for the Thalamus full-deploy PAGE checks (2026-10-02): the dial wording, the S / D / B letters
 * on the picker, the effort right-click, the card's kept / moved / cooling lines, and the refusal strip's retry button.
 *
 * Serves the built `tinker-ui/dist` under /tinker/ and speaks just enough of the gateway protocol on one port. It binds to
 * 127.0.0.1 only. It keeps what a real gateway keeps for these checks: the suggestions file (same rules as
 * src/infra/thalamus-tier-defaults.ts applyThalamusDefaultsRequest: a model new to a stop gets effort low, `{tier, effort}`
 * sets the effort of the stop's model, `model: null` clears), and a per-tab model override that `chat.send` leaves behind
 * (the inline `/model` directive is persisted on the session; `model: "auto"` clears it).
 *
 * Control (HTTP, same port): POST /__mock/state {...} replaces canned state; POST /__mock/event {event, payload} pushes an event
 * to every socket; GET /__mock/calls returns and clears the log of every call, with params.
 *
 * Usage: node mock-gateway.mjs --port 18997 --dist <built dist>
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
const TAB = "agent:main:tinker:mocktab";

const state = {
  amygdala: true,
  status: null,
  feed: {},
  history: [],
  calls: [],
  rewindReply: null,
  /** { smart|default|budget: {model, effort?} } */
  suggestions: {},
  /** true: answer only the old high / medium / low view, as a gateway from before the build does. */
  legacyOnly: false,
  /** thalamus.retryPick answer: {pick}, or "absent" for an older gateway. */
  retry: "absent",
  override: null,
};

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
  ...(state.override
    ? { providerOverride: state.override.provider, modelOverride: state.override.model }
    : {}),
});

const TIERS = ["smart", "default", "budget"];
const LEGACY = { smart: "high", default: "medium", budget: "low" };
function thalamusDefaults(p) {
  if (p.tier !== undefined) {
    const tier = p.tier;
    if (!TIERS.includes(tier)) throw new Error("tier must be smart | default | budget");
    const cur = state.suggestions[tier];
    if (p.model === undefined && p.effort !== undefined) {
      if (!cur) throw new Error("that stop has no model yet; assign a model first");
      state.suggestions[tier] = { model: cur.model, effort: p.effort };
    } else if (p.model === null || p.model === "") {
      delete state.suggestions[tier];
    } else {
      const kept = cur?.model === p.model ? cur.effort : undefined;
      state.suggestions[tier] = { model: p.model, effort: p.effort ?? kept ?? "low" };
    }
  }
  const defaults = Object.fromEntries(
    TIERS.filter((t) => state.suggestions[t]).map((t) => [LEGACY[t], state.suggestions[t].model]),
  );
  return state.legacyOnly ? { defaults } : { defaults, suggestions: state.suggestions };
}

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
  if (method === "prefrontal.thalamusDefaults") {
    state.calls.push({ method, params });
    return thalamusDefaults(params ?? {});
  }
  if (method === "thalamus.retryPick") {
    state.calls.push({ method, params });
    if (state.retry === "absent") throw new Error(`unknown method: ${method}`);
    return { ok: true, ...state.retry };
  }
  if (method === "chat.send") {
    state.calls.push({ method, params });
    if (params?.model === "auto") state.override = null;
    else if (params?.model) {
      const i = params.model.indexOf("/");
      state.override = { provider: params.model.slice(0, i), model: params.model.slice(i + 1) };
    }
    return { status: "started", runId: params?.idempotencyKey };
  }
  if (method === "sessions.rewind" || method === "sessions.patch") {
    state.calls.push({ method, params });
    return method === "sessions.rewind"
      ? (state.rewindReply ?? { ok: true, restoredPrompt: "the refused request" })
      : {};
  }
  if (method.startsWith("amygdala2.")) {
    if (!state.amygdala) throw new Error(`unknown method: ${method}`);
    if (method === "amygdala2.status") return state.status;
    if (method === "amygdala2.feed") return { status: state.status, ...state.feed };
    state.calls.push({ method, params });
    if (method === "amygdala2.rewind")
      return (
        state.rewindReply ?? {
          ok: true,
          restoredPrompt: "the refused request",
          forkSessionId: "fork-1",
        }
      );
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
