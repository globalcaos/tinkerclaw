/**
 * FORK 2026-05-30 — tests for the prefrontal NO-MATCH trail-event extension (J8, 2e).
 *
 * Test target: the NO-MATCH branch in src/fork/prefrontal-state-rpc.ts
 * fork.prefrontal.trailEvent. Verifies the additive kind="NO-MATCH" emits the
 * structured payload, that only knowledge-gap NO-MATCHes write a curiosity Gap, and
 * that legacy kinds remain untouched (backward-compat). Persistence -> temp dir via
 * OPENCLAW_HOME.
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
import { readGaps, dedupeGaps } from "./curiosity-store.js";
import { forkPrefrontalStateHandlers } from "./prefrontal-state-rpc.js";

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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "no-match-home-"));
  process.env.OPENCLAW_HOME = tmpHome;
});
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function trail(
  params: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: unknown; events: AgentEventPayload[] }> {
  const events: AgentEventPayload[] = [];
  const stop = onAgentEvent((e) => events.push(e));
  let captured: { ok: boolean; result?: unknown; error?: unknown } = { ok: false };
  await forkPrefrontalStateHandlers["fork.prefrontal.trailEvent"]!({
    params,
    respond: (ok: boolean, result?: unknown, error?: unknown) => {
      captured = { ok, result, error };
    },
    isWebchatConnect: () => false,
  } as never);
  stop();
  return { ...captured, events };
}

function trailEvents(events: AgentEventPayload[]) {
  return events.filter((e) => (e.data as { phase?: string }).phase === "prefrontal-trail-event");
}

describe("fork.prefrontal.trailEvent kind=NO-MATCH (2e)", () => {
  it("emits the structured payload with phase + kind threaded and resolutionType classified", async () => {
    const { ok, events } = await trail({
      kind: "NO-MATCH",
      recipeName: "compile-paper",
      stepName: "render-figures",
      toolName: "d2",
      reason: "unknown tool",
      sessionKey: "agent:main:main",
    });
    expect(ok).toBe(true);
    const te = trailEvents(events);
    expect(te).toHaveLength(1);
    const data = te[0]!.data as Record<string, unknown>;
    expect(data.kind).toBe("NO-MATCH");
    expect(data.recipeName).toBe("compile-paper");
    expect(data.stepName).toBe("render-figures");
    expect(data.toolName).toBe("d2");
    expect(data.reason).toBe("unknown tool");
    expect(data.resolutionType).toBe("knowledge-gap");
    expect(data.sessionKey).toBe("agent:main:main");
  });

  it("a knowledge-gap NO-MATCH appends exactly one curiosity Gap", async () => {
    const { result } = await trail({
      kind: "NO-MATCH",
      recipeName: "r",
      toolName: "frobnicate",
      reason: "no such command",
    });
    expect((result as { gapId?: string }).gapId).toBeTruthy();
    const gaps = readGaps({ sinceDays: 1 });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.source).toBe("no-match");
    expect(gaps[0]!.toolName).toBe("frobnicate");
    expect(gaps[0]!.resolutionType).toBe("knowledge-gap");
    expect(gaps[0]!.topic).toBe("use frobnicate");
  });

  it("a recoverable (permission) NO-MATCH emits the trail event but writes NO Gap", async () => {
    const { ok, events, result } = await trail({
      kind: "NO-MATCH",
      recipeName: "r",
      toolName: "calendar.write",
      reason: "permission denied",
    });
    expect(ok).toBe(true);
    expect((events[0]!.data as { resolutionType?: string }).resolutionType).toBe("recoverable");
    expect((result as { gapId?: string }).gapId).toBeUndefined();
    expect(readGaps({ sinceDays: 1 })).toHaveLength(0);
  });

  it("an external-outage NO-MATCH emits the trail event but writes NO Gap", async () => {
    const { events } = await trail({
      kind: "NO-MATCH",
      recipeName: "r",
      toolName: "weather-api",
      reason: "connection timed out",
    });
    expect((events[0]!.data as { resolutionType?: string }).resolutionType).toBe("external-outage");
    expect(readGaps({ sinceDays: 1 })).toHaveLength(0);
  });

  it("dedupe: three identical (recipe,tool,reason) failures collapse to one buffered gap with frequency:3", async () => {
    for (let i = 0; i < 3; i++) {
      await trail({
        kind: "NO-MATCH",
        recipeName: "r",
        toolName: "frobnicate",
        reason: "no such command",
      });
    }
    const deduped = dedupeGaps(readGaps({ sinceDays: 1 }));
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.frequency).toBe(3);
  });

  it("backward-compat: a legacy kind=note still works and writes NO gap", async () => {
    const { ok, events } = await trail({ kind: "note", message: "dispatching task 3" });
    expect(ok).toBe(true);
    const te = trailEvents(events);
    expect(te).toHaveLength(1);
    expect((te[0]!.data as { kind?: string }).kind).toBe("note");
    expect((te[0]!.data as { resolutionType?: unknown }).resolutionType).toBeUndefined();
    expect(readGaps({ sinceDays: 1 })).toHaveLength(0);
  });

  it("rejects a legacy kind with no message", async () => {
    const { ok, error } = await trail({ kind: "note" });
    expect(ok).toBe(false);
    expect(error).toBeTruthy();
  });

  it("NO-MATCH derives a default message when none is supplied", async () => {
    const { ok, events } = await trail({
      kind: "NO-MATCH",
      toolName: "d2",
      reason: "unknown tool",
    });
    expect(ok).toBe(true);
    const msg = (trailEvents(events)[0]!.data as { message?: string }).message;
    expect(msg).toContain("d2");
  });
});
