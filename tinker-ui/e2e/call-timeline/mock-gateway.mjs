/**
 * Mock gateway + static server for the CALL TIMELINE's "the last run stays on screen" checks
 * (context-window-panel.md §5.3, FORK 2026-10-02).
 *
 * Serves the built `tinker-ui/dist` under /tinker/ and speaks just enough of the gateway protocol on the same port:
 * the connect handshake, one session, a short chat history, and the anatomy rows the timeline backfills from
 * (`/tinker/api/context-anatomy/<session>`, one row per turn, as the real table holds). It binds to 127.0.0.1 only,
 * never connects to anything else, and serves no /api/ui-state.
 *
 * Control (HTTP, same port):
 *   POST /__mock/run  {runId}  streams one finished run of two model calls over ~4 s (turn-phase, lifecycle, `call`
 *                              send/usage/end, thinking and chat deltas, a tool between the calls), then adds the
 *                              run's anatomy row, as the gateway writes one per turn.
 *   POST /__mock/prep {runId}  a new prompt being prepared: a turn-phase tick and a lifecycle start, no call.
 *   POST /__mock/end  {runId}  ends that run without a call (lifecycle end).
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
const SESSION = "agent:main:main";

/** Three older turns the backfill finds before anything runs live. */
const anatomy = [1, 2, 3].map((i) => ({
  runId: `old-${i}`,
  timestampMs: Date.parse("2026-10-02T08:00:00Z") + i * 600_000,
  durationMs: 20_000,
  responseTokens: 300 * i,
  contextSent: { totalTokens: 20_000 + i * 1_000 },
}));

const sockets = new Set();
const send = (event, payload) => {
  const frame = JSON.stringify({ type: "event", event, payload });
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(frame);
  }
};
const agent = (runId, stream, data) => send("agent", { runId, sessionKey: SESSION, stream, data });
const chat = (runId, state, text) =>
  send("chat", {
    runId,
    sessionKey: SESSION,
    state,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamRun(runId) {
  const startedAt = Date.now();
  const call = (data) => agent(runId, "call", { lane: "cc-bridge", t: Date.now(), ...data });
  agent(runId, "turn-phase", { phase: "prepare" });
  await sleep(200);
  agent(runId, "lifecycle", { phase: "start", model: "mock-model" });
  await sleep(100);
  call({ phase: "send", callIndex: 0, promptTokensEstimate: 24_000 });
  await sleep(300);
  // Each usage frame carries the call's itemised prompt, summing to its billed parts, as the
  // tinker-bridge sends it from the CLI's transcript (call-telemetry.ts CallComposition).
  call({
    phase: "usage",
    callIndex: 0,
    input: 3_000,
    cacheRead: 21_000,
    cacheWrite: 0,
    composition: {
      moralCode: 3_000,
      systemPrompt: 9_000,
      injectedFiles: 3_000,
      skills: 2_000,
      toolSchemas: 4_000,
      conversation: 1_500,
      toolResults: 0,
      userMessage: 1_500,
    },
  });
  for (let i = 1; i <= 9; i++) {
    await sleep(100);
    agent(runId, "thinking", { text: "t".repeat(140 * i) });
  }
  await sleep(100);
  agent(runId, "tool", {
    phase: "start",
    toolCallId: `${runId}-t1`,
    name: "read",
    args: { path: "x" },
  });
  await sleep(50);
  call({ phase: "end", callIndex: 0, output: 420, stopReason: "tool_use" });
  await sleep(450);
  agent(runId, "tool", { phase: "result", toolCallId: `${runId}-t1`, isError: false });
  await sleep(100);
  call({ phase: "send", callIndex: 1, promptTokensEstimate: 24_500 });
  await sleep(200);
  call({
    phase: "usage",
    callIndex: 1,
    input: 500,
    cacheRead: 24_000,
    cacheWrite: 0,
    composition: {
      moralCode: 3_000,
      systemPrompt: 9_000,
      injectedFiles: 3_000,
      skills: 2_000,
      toolSchemas: 4_000,
      conversation: 1_600,
      toolResults: 400,
      userMessage: 1_500,
    },
  });
  let text = "";
  for (let i = 1; i <= 9; i++) {
    await sleep(100);
    text += "The answer, streaming in. ";
    chat(runId, "delta", text);
  }
  await sleep(100);
  call({ phase: "end", callIndex: 1, output: 260, stopReason: "end_turn" });
  await sleep(100);
  agent(runId, "lifecycle", { phase: "end" });
  chat(runId, "final", text);
  anatomy.push({
    runId,
    timestampMs: startedAt,
    durationMs: Date.now() - startedAt,
    responseTokens: 680,
    contextSent: { totalTokens: 24_000 },
  });
}

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
  if (url.pathname.startsWith("/tinker/api/context-anatomy/")) {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(anatomy));
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
  req.on("end", async () => {
    const j = body ? JSON.parse(body) : {};
    if (url.pathname === "/__mock/run") await streamRun(j.runId);
    if (url.pathname === "/__mock/prep") {
      agent(j.runId, "turn-phase", { phase: "prepare" });
      await sleep(200);
      agent(j.runId, "lifecycle", { phase: "start", model: "mock-model" });
    }
    if (url.pathname === "/__mock/end") agent(j.runId, "lifecycle", { phase: "end" });
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
          label: "Main",
          title: "Main",
          updatedAt: Date.now(),
          kind: "direct",
          model: "mock-model",
        },
      ],
      count: 1,
    };
  if (method === "chat.history") {
    const t0 = Date.parse("2026-10-02T08:00:00Z");
    const messages = [1, 2, 3, 4].map((i) => ({
      role: i % 2 ? "user" : "assistant",
      content: [{ type: "text", text: `message ${i}` }],
      timestamp: t0 + i * 60_000,
      __openclaw: { id: `m-${i}` },
    }));
    return { sessionKey: String(params?.sessionKey ?? SESSION), messages };
  }
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
