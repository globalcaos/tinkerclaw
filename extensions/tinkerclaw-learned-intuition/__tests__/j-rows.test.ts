/**
 * The J-series `j.*` rows this extension produces — TINKER_UI_DESIGN_BIBLE/logging.md §4.12
 * (§9 step 9): J9 `j.aegis.decision` (rule-based-gate.ts) and J11 `j.amygdala.ask`
 * (runtime-hook.ts, both channels).
 *
 * CONTROL: before this change neither producer exists, so every expectation that a row was
 * written fails on zero emitEvent calls.
 *
 * `emitEvent` is mocked at the plugin-sdk subpath: no writer, no worker, no database. The
 * assertions are about the CALL — name, label and the declared meaning of n1/fields — which is
 * the part this extension owns; the L4 filter and schema are core's to test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoveltyIndex } from "../src/novelty.js";
import { evaluateAegisEnforced, evaluateRuleBased } from "../src/rule-based-gate.js";
import { AmygdalaHook } from "../src/runtime-hook.js";
import type { ActionRequest, SessionContext } from "../src/situation-template.js";

type EmittedRow = { name: string; record: Record<string, unknown> };

const emitted = vi.hoisted(() => ({ rows: [] as EmittedRow[] }));

vi.mock("openclaw/plugin-sdk/fork-telemetry", () => ({
  emitEvent: (name: string, record: Record<string, unknown> = {}) => {
    emitted.rows.push({ name, record });
  },
}));

// The novelty path builds a situation template (git, fs, transcripts) before it embeds; none of
// that is under test here, so the template is a constant and the embedder below decides the vector.
vi.mock("../src/situation-template.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/situation-template.js")>()),
  buildSituation: async () => ({}),
  serializeSituation: () => "situation",
}));

const rowsNamed = (name: string): EmittedRow[] => emitted.rows.filter((r) => r.name === name);

beforeEach(() => {
  emitted.rows.length = 0;
});

const vec = (...xs: number[]): Float32Array => Float32Array.from(xs);

describe("J9 j.aegis.decision — one row per rule-set evaluation", () => {
  it("a destructive command: label = the rule id, decision = block", () => {
    const r = evaluateAegisEnforced("Bash", "rm -rf /");
    expect(r.decision).toBe("hard_block");
    const rows = rowsNamed("j.aegis.decision");
    expect(rows).toHaveLength(1);
    expect(rows[0].record).toEqual({ label: r.rule, fields: { decision: "block" } });
  });

  it("an allowed call: label is the closed value `none`, never null", () => {
    evaluateAegisEnforced("Bash", "git status");
    const rows = rowsNamed("j.aegis.decision");
    expect(rows).toHaveLength(1);
    expect(rows[0].record).toEqual({ label: "none", fields: { decision: "allow" } });
  });

  it("the enforce tier shows: an observe-only credential rule allows in the enforced gate", () => {
    evaluateAegisEnforced("Read", "/home/u/.env");
    evaluateRuleBased("Read", "/home/u/.env");
    const rows = rowsNamed("j.aegis.decision");
    expect(rows.map((r) => r.record.label)).toEqual(["none", "CREDENTIAL_ACCESS"]);
    expect(rows.map((r) => (r.record.fields as { decision: string }).decision)).toEqual([
      "allow",
      "block",
    ]);
  });

  it("never claims `overridden` — the gate cannot know it, so the field stays an honest gap", () => {
    evaluateAegisEnforced("Bash", "rm -rf /");
    expect(rowsNamed("j.aegis.decision")[0].record.fields).not.toHaveProperty("overridden");
  });
});

/**
 * A hook with its I/O-bound collaborators replaced. The constructor would open the training log,
 * the embedder and the git cache; none of them is what these rows are about.
 */
function hookWith(parts: {
  embed: (text: string) => Promise<Float32Array>;
  novelty?: NoveltyIndex | null;
}): AmygdalaHook {
  const hook = Object.create(AmygdalaHook.prototype) as AmygdalaHook;
  Object.assign(hook as unknown as Record<string, unknown>, {
    initialized: true,
    aegis: null,
    legacyEnsemble: false,
    _useRuleBasedFallback: false,
    noveltyAdds: 0,
    novelty: parts.novelty ?? null,
    embedder: { embed: parts.embed },
    gitCache: {},
    trainingLog: { append: async () => 1, setCalibration: () => {} },
    config: {
      enabled: true,
      trust: { alpha_prudence: 0, alpha_personality: 0, phase: 1 },
    },
  });
  return hook;
}

const ACTION = { type: "Bash", target: "make deploy" } as ActionRequest;
const CONTEXT = {} as SessionContext;

function calibratedIndex(): NoveltyIndex {
  const index = new NoveltyIndex({ minRef: 1, k: 1 });
  index.load([vec(1, 0)]);
  index.setThreshold(0.5);
  return index;
}

describe("J11 j.amygdala.ask — novelty channel", () => {
  it("an unfamiliar situation that the gate turns into an ask writes one row with its score", async () => {
    const hook = hookWith({ embed: async () => vec(0, 1), novelty: calibratedIndex() });
    const result = await hook.evaluate(ACTION, CONTEXT);

    expect(result.disposition).toBe("ask");
    const rows = rowsNamed("j.amygdala.ask");
    expect(rows).toHaveLength(1);
    expect(rows[0].record).toEqual({ label: "novelty", n1: result.novelty });
    // delivered / answered are the delivery path's facts, never asserted from here.
    expect(rows[0].record).not.toHaveProperty("fields");
  });

  it("a familiar situation is not an ask and writes nothing", async () => {
    const hook = hookWith({ embed: async () => vec(1, 0), novelty: calibratedIndex() });
    const result = await hook.evaluate(ACTION, CONTEXT);

    expect(result.disposition).toBe("proceed");
    expect(rowsNamed("j.amygdala.ask")).toHaveLength(0);
  });

  it("scoring alone is not an ask: NoveltyIndex.score() writes nothing", () => {
    // The legacy ONNX path calls score() for parity while the ONNX gate decides; a row at
    // score() would record asks that never happened. The row belongs where the ask is decided.
    calibratedIndex().score(vec(0, 1));
    expect(rowsNamed("j.amygdala.ask")).toHaveLength(0);
  });
});

describe("J11 j.amygdala.ask — incongruity channel", () => {
  const PROMPT = "build a chess game so I can water my plants";

  it("an incongruous request writes one row whose n1 is the clause cosine", async () => {
    const hook = hookWith({
      embed: async (text) => (text.startsWith("build") ? vec(1, 0) : vec(0, 1)),
    });
    const verdict = await hook.checkIncongruity(PROMPT);

    expect(verdict).not.toBeNull();
    const rows = rowsNamed("j.amygdala.ask");
    expect(rows).toHaveLength(1);
    expect(rows[0].record).toEqual({ label: "incongruity", n1: verdict?.similarity });
    // The clauses are free text and never reach the row (L4).
    expect(JSON.stringify(rows[0].record)).not.toContain("chess");
  });

  it("a coherent request writes nothing", async () => {
    const hook = hookWith({ embed: async () => vec(1, 0) });
    expect(await hook.checkIncongruity(PROMPT)).toBeNull();
    expect(rowsNamed("j.amygdala.ask")).toHaveLength(0);
  });
});
