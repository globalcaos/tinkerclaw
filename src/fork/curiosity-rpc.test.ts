/**
 * FORK 2026-05-30 — tests for the curiosity RPC handlers (J8 THALAMUS, 2a/2b).
 *
 * Test target: src/fork/curiosity-rpc.ts. We drive the handlers directly with a stub
 * GatewayRequestHandlerOptions and capture broadcasts via onAgentEvent (same approach
 * as agent-events.test.ts). Persistence is redirected to a temp dir via OPENCLAW_HOME.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  onAgentEvent,
  resetAgentEventsForTest,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import { forkCuriosityHandlers } from "./curiosity-rpc.js";
import { readGaps } from "./curiosity-store.js";

let tmpHome: string;
let prevHome: string | undefined;

beforeAll(() => {
  prevHome = process.env.OPENCLAW_HOME;
});
afterAll(() => {
  if (prevHome === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = prevHome;
  }
});

beforeEach(() => {
  resetAgentEventsForTest();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "curiosity-rpc-home-"));
  process.env.OPENCLAW_HOME = tmpHome;
});
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** Drive a handler and capture (respond args, emitted events). */
async function call(
  method: keyof typeof forkCuriosityHandlers,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: unknown; events: AgentEventPayload[] }> {
  const events: AgentEventPayload[] = [];
  const stop = onAgentEvent((e) => events.push(e));
  let captured: { ok: boolean; result?: unknown; error?: unknown } = { ok: false };
  const respond = (ok: boolean, result?: unknown, error?: unknown) => {
    captured = { ok, result, error };
  };
  await forkCuriosityHandlers[method]!({
    params,
    respond,
    // unused by these handlers but required by the type
    isWebchatConnect: () => false,
  } as never);
  stop();
  return { ...captured, events };
}

describe("fork.curiosity.logGap (2a)", () => {
  it("appends exactly one Gap and broadcasts phase='curiosity-gap-detected' with the sessionKey threaded", async () => {
    const { ok, result, events } = await call("fork.curiosity.logGap", {
      topic: "spanish corporate tax",
      source: "lcm-entropy",
      importance: 0.8,
      knowledgeAdjacency: 0.3,
      userRelevance: 0.9,
      sessionKey: "agent:main:main",
      runId: "run-x",
    });
    expect(ok).toBe(true);
    expect((result as { persisted: boolean }).persisted).toBe(true);

    const gapEvents = events.filter(
      (e) => (e.data as { phase?: string }).phase === "curiosity-gap-detected",
    );
    expect(gapEvents).toHaveLength(1);
    const data = gapEvents[0]!.data as Record<string, unknown>;
    expect(data.topic).toBe("spanish corporate tax");
    expect(data.source).toBe("lcm-entropy");
    expect(data.adjacency).toBe(0.3); // knowledgeAdjacency mapped -> adjacency
    expect(data.sessionKey).toBe("agent:main:main");
    expect(gapEvents[0]!.sessionKey).toBe("agent:main:main");

    const persisted = readGaps({ sinceDays: 1 });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.topic).toBe("spanish corporate tax");
    expect(persisted[0]!.source).toBe("lcm-entropy");
  });

  it("rejects when topic is missing", async () => {
    const { ok, error, events } = await call("fork.curiosity.logGap", { source: "manual" });
    expect(ok).toBe(false);
    expect(error).toBeTruthy();
    expect(
      events.filter((e) => (e.data as { phase?: string }).phase === "curiosity-gap-detected"),
    ).toHaveLength(0);
  });

  it("coerces an unknown source to 'manual'", async () => {
    const { result } = await call("fork.curiosity.logGap", { topic: "x", source: "bogus" });
    expect((result as { ok: boolean }).ok).toBe(true);
    const persisted = readGaps({ sinceDays: 1 });
    expect(persisted[0]!.source).toBe("manual");
  });
});

describe("fork.curiosity.topGaps + resolveGap (2b)", () => {
  it("returns the prioritized open queue, and resolveGap drops a gap from the next call", async () => {
    const a = await call("fork.curiosity.logGap", {
      topic: "alpha",
      source: "manual",
      importance: 0.9,
    });
    await call("fork.curiosity.logGap", { topic: "beta", source: "manual", importance: 0.1 });
    const aId = (a.result as { id: string }).id;

    const top = await call("fork.curiosity.topGaps", { k: 5 });
    expect(top.ok).toBe(true);
    const gaps = (top.result as { gaps: Array<{ gap: { topic: string }; priority: number }> }).gaps;
    expect(gaps.length).toBe(2);
    expect(gaps[0]!.gap.topic).toBe("alpha"); // higher importance ranks first

    const resolved = await call("fork.curiosity.resolveGap", {
      id: aId,
      by: "tester",
      source: "web-search",
    });
    expect(resolved.ok).toBe(true);
    const resolveEvents = resolved.events.filter(
      (e) => (e.data as { phase?: string }).phase === "curiosity-gap-resolved",
    );
    expect(resolveEvents).toHaveLength(1);

    const after = await call("fork.curiosity.topGaps", { k: 5 });
    const afterGaps = (after.result as { gaps: Array<{ gap: { topic: string } }> }).gaps;
    expect(afterGaps.map((g) => g.gap.topic)).toEqual(["beta"]);
  });

  it("resolveGap on an unknown id returns an error", async () => {
    const r = await call("fork.curiosity.resolveGap", { id: "does-not-exist" });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
