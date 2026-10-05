#!/usr/bin/env node
/**
 * Self-test of mock-gateway.mjs's protocol emulation, no browser: a tiny scenario, one WS client.
 * Checks the snapshot timeline, the afterSeq/epoch cursor emulation (incl. a hidden local anchor),
 * run binding on chat.send, the epoch shift, frame order and the drop control.
 *
 *   node selftest.mjs [--dist <dir>]      exit 1 on any failure
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WT = process.env.HARNESS_WORKTREE ?? fileURLToPath(new URL("../../../", import.meta.url));
const WebSocket = createRequire(path.join(WT, "package.json"))("ws");
const HERE = path.dirname(new URL(import.meta.url).pathname);
const distArg = process.argv.indexOf("--dist");
const DIST = distArg > 0 ? process.argv[distArg + 1] : path.join(HERE, "..", "dist-develop");
const E0 = 1791003843374;
const K = "agent:main:tinker:selftest";
const RUN = "run-from-capture-1";
const user = {
  role: "user",
  content: [{ type: "text", text: "hi" }],
  timestamp: E0 + 1000,
  __openclaw: { id: "u1", seq: 1 },
  idempotencyKey: RUN,
};
const imp = (id, ts, text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp: E0 + ts,
  __openclaw: { importedFrom: "claude-cli", externalId: id },
});
const scenario = {
  name: "selftest",
  session: K,
  mainSession: "agent:main:main",
  epoch0: E0,
  prerollMs: 300,
  end: 3000,
  runs: [{ id: RUN, bind: "page-send" }],
  history: {
    [K]: [
      {
        at: -1,
        tag: "before",
        messages: [],
        cursor: { epoch: null, firstSeq: 0, lastSeq: 0, hasMoreBefore: false, reset: false },
      },
      {
        at: 800,
        tag: "after",
        messages: [user, imp("a1", 2000, "narration"), imp("a2", 3000, "answer")],
        cursor: { epoch: "E1", firstSeq: 1, lastSeq: 2, hasMoreBefore: false, reset: false },
        hiddenLocal: [{ seq: 2, timestamp: E0 + 3500 }],
      },
    ],
  },
  frames: [
    {
      at: 100,
      event: "chat",
      seq: true,
      payload: {
        runId: RUN,
        sessionKey: K,
        state: "delta",
        message: { role: "assistant", content: [{ type: "text", text: "a" }], timestamp: E0 + 100 },
      },
    },
    {
      at: 150,
      event: "agent",
      seq: false,
      payload: {
        runId: RUN,
        sessionKey: K,
        stream: "tool",
        data: { phase: "start" },
        ts: E0 + 150,
      },
    },
    {
      at: 200,
      event: "chat",
      seq: true,
      payload: {
        runId: RUN,
        sessionKey: K,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ab" }],
          timestamp: E0 + 200,
        },
      },
    },
  ],
  actions: [],
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mock-selftest-"));
const scenFile = path.join(tmp, "s.json");
fs.writeFileSync(scenFile, JSON.stringify(scenario));
const portFile = path.join(tmp, "port");
const mock = spawn(
  process.execPath,
  [
    path.join(HERE, "mock-gateway.mjs"),
    "--scenario",
    scenFile,
    "--dist",
    DIST,
    "--port",
    "0",
    "--port-file",
    portFile,
  ],
  { stdio: "ignore" },
);
const failures = [];
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(what);
};
try {
  for (let i = 0; i < 50 && !fs.existsSync(portFile); i++)
    await new Promise((r) => setTimeout(r, 100));
  const port = Number(fs.readFileSync(portFile, "utf-8"));
  const base = `http://127.0.0.1:${port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const events = [];
  const pending = new Map();
  let n = 0;
  ws.on("message", (raw) => {
    const f = JSON.parse(String(raw));
    if (f.type === "res") pending.get(f.id)?.(f);
    else if (f.type === "event" && f.event !== "connect.challenge") events.push(f);
  });
  await new Promise((r) => ws.on("open", r));
  const req = (method, params) =>
    new Promise((ok) => {
      const id = `s${++n}`;
      pending.set(id, ok);
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  const hello = await req("connect", {});
  check(
    hello.ok && hello.payload.snapshot.sessionDefaults.mainSessionKey === "agent:main:main",
    "connect answers hello-ok with the main session",
  );
  const h0 = await req("chat.history", { sessionKey: K, limit: 100 });
  check(h0.payload.messages.length === 0, "before the clock starts the first snapshot is served");
  const start = await (await fetch(`${base}/__mock/start`, { method: "POST", body: "{}" })).json();
  const delta = start.delta;
  const sent = await req("chat.send", {
    sessionKey: K,
    message: "hi",
    idempotencyKey: "page-key-1",
  });
  check(
    sent.payload.runId === "page-key-1" && sent.payload.status === "started",
    "chat.send acks with the page's key",
  );
  await new Promise((r) => setTimeout(r, 1000));
  const fr = events.map((e) => `${e.event}:${e.payload.state ?? e.payload.stream}:${e.seq ?? "-"}`);
  check(
    fr.join(",") === "chat:delta:1,agent:tool:-,chat:final:2",
    "frames go out in order, seq per connection, none for a seq-less frame",
    fr.join(","),
  );
  check(
    events.every((e) => e.payload.runId === "page-key-1"),
    "every frame carries the page's run id",
  );
  check(
    events[0].payload.message.timestamp === E0 + 100 + delta,
    "epoch values are shifted onto the replay clock",
  );
  const h1 = await req("chat.history", { sessionKey: K, limit: 1000 });
  check(
    h1.payload.messages.length === 3 && h1.payload.cursor.epoch === "E1",
    "after `at` the next snapshot is served",
  );
  check(
    h1.payload.messages[0].idempotencyKey === "page-key-1",
    "history rows carry the page's key once bound",
  );
  const h2 = await req("chat.history", { sessionKey: K, afterSeq: 2, epoch: "E1", limit: 1000 });
  check(
    h2.payload.messages.length === 0 &&
      h2.payload.cursor.firstSeq === 2 &&
      h2.payload.cursor.reset === false,
    "afterSeq on a hidden anchor serves only newer imports (none)",
    JSON.stringify(h2.payload.cursor),
  );
  const h3 = await req("chat.history", { sessionKey: K, afterSeq: 1, epoch: "E1", limit: 1000 });
  check(
    h3.payload.messages.length === 2,
    "afterSeq 1 serves the imports at or after row 1's time",
    String(h3.payload.messages.length),
  );
  const h4 = await req("chat.history", { sessionKey: K, afterSeq: 2, epoch: "OLD", limit: 1000 });
  check(
    h4.payload.cursor.reset === true && h4.payload.messages.length === 3,
    "a stale epoch is answered with a reset tail",
  );
  const closed = new Promise((r) => ws.on("close", r));
  await fetch(`${base}/__mock/drop`, { method: "POST", body: JSON.stringify({ ms: 500 }) });
  await Promise.race([closed, new Promise((r) => setTimeout(r, 1000))]);
  check(ws.readyState === WebSocket.CLOSED, "drop closes the socket");
  const log = await (await fetch(`${base}/__mock/log`)).json();
  check(
    log.some((r) => r.kind === "bind" && r.idempotencyKey === "page-key-1"),
    "the log records the bind",
  );
} catch (e) {
  check(false, "selftest crashed", String(e?.stack ?? e));
} finally {
  mock.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} FAILED` : "\nALL PASS");
process.exit(failures.length ? 1 : 0);
