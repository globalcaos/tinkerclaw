import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing as replyRunTesting,
  createReplyOperation,
  type ReplyOperation,
} from "../auto-reply/reply/reply-run-registry.js";
import { initSessionState } from "../auto-reply/reply/session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  diagnosticLogger,
  logSessionStateChange,
  resetDiagnosticStateForTest,
  startDiagnosticHeartbeat,
} from "../logging/diagnostic.js";
import { createGatewayReplyPhaseProbe, startGatewayDiagnosticHeartbeat } from "./server.impl.js";
import { resolveSessionStoreKey } from "./session-store-key.js";

// FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md §7 G6, the gateway half. Wave 2b gave
// the `[diagnostic] stuck session` line a `phase=` field fed by an injected probe; no caller
// injected one, so production never printed it. Startup now starts the heartbeat through
// startGatewayDiagnosticHeartbeat, which passes a probe that reads the reply-run registry.
//
// The two holders spell a turn's key differently. The diagnostic state is keyed by the RAW
// inbound ctx.SessionKey (dispatch-from-config.ts markProcessing); the reply operation by the key
// initSessionState derives from it, which agent-runner registers as replySessionKey. Every case
// takes the registered key from initSessionState ITSELF, not from a copy of its derivation, so a
// change there that the probe does not follow fails here.
//
// CONTROL: one case starts the heartbeat exactly as startup did before this change (no probe) and
// pins that the same queued turn's line has no phase field. On the pre-change tree every other
// case fails: server.impl.ts exports neither builder.

/** Past the default 120 s stuck threshold, on the heartbeat's 30 s tick. */
const HEARTBEAT_WINDOW_MS = 150_000;

type CfgShape = "default" | "alias" | "global";

let tempDir = "";

/**
 * `default`: agent `main`, main key `main`. `alias`: the main session renamed, default agent `ops`
 * and main key `work`, where the raw and registered spellings part. `global`: one session for
 * everything.
 */
function makeCfg(shape: CfgShape): OpenClawConfig {
  const store = path.join(tempDir, "sessions.json");
  if (shape === "alias") {
    return {
      session: { store, mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    };
  }
  if (shape === "global") {
    return { session: { store, scope: "global" } };
  }
  return { session: { store } };
}

/**
 * A turn accepted but not yet at the model, built the way the pipeline builds one:
 * initSessionState derives the key, dispatch marks the RAW key processing, agent-runner registers
 * the operation (born `queued`) under the derived key. Fake timers start after the store I/O, so
 * the diagnostic clock starts with the turn.
 */
async function acceptQueuedTurn(
  ctxSessionKey: string,
  cfg: OpenClawConfig,
): Promise<{ registeredKey: string; operation: ReplyOperation }> {
  const session = await initSessionState({
    ctx: {
      Body: "hello",
      From: "user-g6",
      To: "bot-g6",
      SessionKey: ctxSessionKey,
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "direct",
      CommandAuthorized: true,
    },
    cfg,
    commandAuthorized: true,
  });
  vi.useFakeTimers();
  logSessionStateChange({
    sessionKey: ctxSessionKey,
    state: "processing",
    reason: "message_start",
  });
  const operation = createReplyOperation({
    sessionKey: session.sessionKey,
    sessionId: session.sessionId,
    resetTriggered: false,
  });
  return { registeredKey: session.sessionKey, operation };
}

function watchStuckLines(): () => string[] {
  const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => {});
  return () =>
    warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("stuck session:"));
}

const QUEUED_TURN_CASES: Array<[label: string, ctxSessionKey: string, shape: CfgShape]> = [
  ["its canonical key, as chat.send dispatches it", "agent:main:main", "default"],
  ["a short alias of the main session", "main", "alias"],
  ["a legacy main key under another default agent", "agent:main:main", "alias"],
  ["a mixed-case spelling", "Agent:Main:Main", "default"],
  ["the main key under scope global", "agent:main:main", "global"],
];

describe("gateway heartbeat: reply-op phase on the stuck-session line (prompt-queue.md G6)", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-g6-wiring-"));
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
    replyRunTesting.resetReplyRunRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    replyRunTesting.resetReplyRunRegistry();
    resetDiagnosticEventsForTest();
    resetDiagnosticStateForTest();
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(QUEUED_TURN_CASES)(
    "a queued turn dispatched under %s reads phase=queued",
    async (_label, ctxSessionKey, shape) => {
      const cfg = makeCfg(shape);
      const stuckLines = watchStuckLines();
      await acceptQueuedTurn(ctxSessionKey, cfg);
      startGatewayDiagnosticHeartbeat(() => cfg);
      vi.advanceTimersByTime(HEARTBEAT_WINDOW_MS);

      const lines = stuckLines();
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).toContain(` sessionKey=${ctxSessionKey} `);
        expect(line.endsWith(" phase=queued")).toBe(true);
      }
    },
  );

  it("finds the operation where the raw and registered keys part", async () => {
    const cfg = makeCfg("alias");
    const { registeredKey, operation } = await acceptQueuedTurn("agent:main:main", cfg);
    // The gap the probe exists for, and why it repeats initSessionState's derivation instead of
    // the gateway's store canonicalisation: for this key the two disagree (agent:main:work vs
    // agent:ops:work). Should a later change align them, drop the second assertion; the probe
    // stays correct either way.
    expect(registeredKey).not.toBe("agent:main:main");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:main:main" })).not.toBe(registeredKey);

    const getConfig = vi.fn(() => cfg);
    const probe = createGatewayReplyPhaseProbe(getConfig);
    expect(probe({ sessionKey: registeredKey })).toBe("queued");
    expect(getConfig).not.toHaveBeenCalled(); // an exact hit reads no config
    expect(probe({ sessionKey: "agent:main:main" })).toBe("queued");
    operation.setPhase("running");
    expect(probe({ sessionKey: "agent:main:main" })).toBe("running");
    expect(probe({ sessionKey: "agent:ops:elsewhere" })).toBeUndefined();
  });

  it("reads phase=none once the operation has settled", async () => {
    const cfg = makeCfg("alias");
    const stuckLines = watchStuckLines();
    const { operation } = await acceptQueuedTurn("main", cfg);
    operation.complete();
    startGatewayDiagnosticHeartbeat(() => cfg);
    vi.advanceTimersByTime(HEARTBEAT_WINDOW_MS);

    const lines = stuckLines();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.endsWith(" phase=none"))).toBe(true);
  });

  it("CONTROL: startup's pre-change call (no probe) writes no phase field", async () => {
    const cfg = makeCfg("alias");
    const stuckLines = watchStuckLines();
    await acceptQueuedTurn("main", cfg);
    startDiagnosticHeartbeat(undefined, { getConfig: () => cfg });
    vi.advanceTimersByTime(HEARTBEAT_WINDOW_MS);

    const lines = stuckLines();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.includes("phase="))).toBe(false);
  });

  it("startup starts the heartbeat through startGatewayDiagnosticHeartbeat", () => {
    // The cases above call the starter directly, so they cannot see startup go back to a bare
    // heartbeat start. The only raw start left in server.impl.ts is the one inside the starter.
    const source = fs.readFileSync(new URL("./server.impl.ts", import.meta.url), "utf8");
    expect(source.match(/\bstartDiagnosticHeartbeat\(/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/if \(diagnosticsEnabled\) \{\s*startGatewayDiagnosticHeartbeat\(\);/);
  });
});
