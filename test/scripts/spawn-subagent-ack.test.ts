import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

// Burn review 2026-11-13 orchestration/F1. The CLI gave up on fork.subagents.spawn after a
// fixed 30 s and printed a plain failure, while the gateway (which allows its inner `agent`
// call 60-300 s) went on and created the child. A caller that retried then got a second
// worker for the same task. Now: the wait matches the gateway's budget, an expired wait is
// reported as UNKNOWN (exit 4, ackTimedOut), and --idempotency-key makes a retry replay the
// recorded answer, or refuse, instead of spawning again.
//
// CONTROL. Before the fix the CLI ignores OPENCLAW_SPAWN_ACK_TIMEOUT_MS and
// --idempotency-key: the first test waits 30 s and times out, the replay test sees two
// spawn RPCs.

const CLI = path.resolve(__dirname, "../../scripts/openclaw-spawn-subagent.mjs");

type Mode = "silent" | "answer" | "close";

let wss: WebSocketServer;
let stateDir: string;
let spawnCalls: number;
let mode: Mode;

beforeEach(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-ack-"));
  spawnCalls = 0;
  mode = "silent";
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  wss.on("connection", (sock) => {
    sock.send(JSON.stringify({ type: "event", event: "connect.challenge" }));
    sock.on("message", (buf) => {
      const f = JSON.parse(buf.toString());
      if (f.method === "connect") {
        sock.send(JSON.stringify({ type: "res", id: f.id, ok: true, payload: {} }));
        return;
      }
      if (f.method === "fork.subagents.spawn") {
        spawnCalls += 1;
        if (mode === "answer") {
          sock.send(
            JSON.stringify({
              type: "res",
              id: f.id,
              ok: true,
              payload: { ok: true, childSessionKey: "agent:main:subagent:x", runId: "run-1" },
            }),
          );
        } else if (mode === "close") {
          sock.close();
        }
        // "silent": never answered (a slow gateway)
      }
    });
  });
});

afterEach(async () => {
  for (const c of wss.clients) c.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function runCli(extra: string[] = []): Promise<{ code: number | null; out: unknown }> {
  const port = (wss.address() as { port: number }).port;
  const child = spawn(process.execPath, [CLI, "--task", "probe", "--json", ...extra], {
    env: {
      ...process.env,
      OPENCLAW_GATEWAY_URL: `http://127.0.0.1:${port}`,
      OPENCLAW_GATEWAY_TOKEN: "test-token",
      OPENCLAW_ADMIT: "0",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SPAWN_ACK_TIMEOUT_MS: "1500",
    },
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const code = await new Promise<number | null>((r) => child.on("close", r));
  return { code, out: JSON.parse(out.trim()) };
}

describe("openclaw-spawn-subagent ack timeout", () => {
  it("reports an unanswered spawn as ackTimedOut (exit 4), not as a plain failure", async () => {
    const r = await runCli();
    expect(r.code).toBe(4);
    expect(r.out).toMatchObject({ ok: false, ackTimedOut: true });
  }, 10_000);

  it("reports a socket closed after the spawn was sent as ackTimedOut, without waiting", async () => {
    mode = "close";
    const r = await runCli();
    expect(r.code).toBe(4);
    expect(r.out).toMatchObject({ ok: false, ackTimedOut: true });
  }, 10_000);

  it("replays the recorded answer for a repeated idempotency key instead of spawning again", async () => {
    mode = "answer";
    const first = await runCli(["--idempotency-key", "step-7"]);
    const second = await runCli(["--idempotency-key", "step-7"]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.out).toMatchObject({ ok: true, runId: "run-1", replayed: true });
    expect(spawnCalls).toBe(1);
  }, 10_000);

  it("refuses to spawn again when an earlier attempt with the same key has an unknown outcome", async () => {
    const first = await runCli(["--idempotency-key", "step-8"]);
    expect(first.code).toBe(4);
    mode = "answer";
    const second = await runCli(["--idempotency-key", "step-8"]);
    expect(second.code).toBe(4);
    expect(second.out).toMatchObject({ ok: false, ackTimedOut: true });
    expect(spawnCalls).toBe(1);
  }, 10_000);
});
