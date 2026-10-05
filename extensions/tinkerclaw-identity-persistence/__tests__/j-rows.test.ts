/**
 * J4 `j.cortex.probe` — TINKER_UI_DESIGN_BIBLE/logging.md §4.12 (§9 step 9): one row per behavioral
 * probe that actually ran, label = the probe id, n1 = its single headline score.
 *
 * CONTROL: before this change runProbe writes nothing, so every expectation that a row exists
 * fails on zero emitEvent calls.
 *
 * `emitEvent` is mocked at the plugin-sdk subpath (no writer, no database) and the probe model is a
 * stub returning a fixed JSON reply, so the assertions are about the producer's CALL only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { runProbe, type ProbeLLMFn } from "../src/behavioral-probes.js";
import { createDefaultPersonaState } from "../src/persona-state.js";

type EmittedRow = { name: string; record: Record<string, unknown> };

const emitted = vi.hoisted(() => ({ rows: [] as EmittedRow[] }));

vi.mock("openclaw/plugin-sdk/fork-telemetry", () => ({
  emitEvent: (name: string, record: Record<string, unknown> = {}) => {
    emitted.rows.push({ name, record });
  },
}));

const rows = (): EmittedRow[] => emitted.rows.filter((r) => r.name === "j.cortex.probe");

beforeEach(() => {
  emitted.rows.length = 0;
});

const persona = createDefaultPersonaState("Probe", "A persona under test");

function replying(output: string): ProbeLLMFn {
  return async () => ({ output, inputTokens: 10, outputTokens: 10, model: "stub", latencyMs: 1 });
}

describe("J4 j.cortex.probe", () => {
  it("full_audit: n1 is the probe's own `overall` headline", async () => {
    await runProbe(
      "full_audit",
      "a reply",
      persona,
      20,
      replying('{"scores":{"identity_alignment":0.2,"overall":0.9},"violations":["x"]}'),
    );
    expect(rows()).toHaveLength(1);
    expect(rows()[0].record).toEqual({ label: "full_audit", n1: 0.9 });
  });

  it("style: n1 is `overall_style`", async () => {
    await runProbe(
      "style",
      "a reply",
      persona,
      5,
      replying('{"scores":{"hedging":0.1,"overall_style":0.6}}'),
    );
    expect(rows()[0].record).toEqual({ label: "style", n1: 0.6 });
  });

  it("hard_rule has no headline, so n1 is the mean compliance of its rules", async () => {
    await runProbe(
      "hard_rule",
      "a reply",
      persona,
      1,
      replying('{"scores":{"R1":1,"R2":0.5},"violations":["R2"]}'),
    );
    expect(rows()[0].record).toEqual({ label: "hard_rule", n1: 0.75 });
  });

  it("an unparsable reply is a probe that produced nothing: n1 is null, never 0", async () => {
    await runProbe("hard_rule", "a reply", persona, 1, replying("not json at all"));
    expect(rows()[0].record).toEqual({ label: "hard_rule", n1: null });
  });

  it("a probe the schedule skips writes nothing", async () => {
    // style runs every 5th turn; turn 3 is not one.
    expect(await runProbe("style", "a reply", persona, 3, replying("{}"))).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it("the raw output and violated rule ids never reach the row (L4)", async () => {
    await runProbe(
      "hard_rule",
      "a reply",
      persona,
      1,
      replying('{"scores":{"R1":0},"violations":["SECRET_RULE"],"reasoning":"free text"}'),
    );
    expect(JSON.stringify(rows()[0].record)).not.toMatch(/SECRET_RULE|free text/);
  });
});
