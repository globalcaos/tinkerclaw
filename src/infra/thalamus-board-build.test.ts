import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { modelKey, normalizeModelRef } from "../agents/model-selection.js";
import { relCostLookup } from "../shared/rel-cost-table.js";
import { thalamusCandidates } from "../shared/thalamus-candidates.js";
import { frontierRungsFor } from "../shared/thalamus-frontier.js";
import { supplyStates } from "../shared/thalamus-supply.js";
import {
  buildThalamusBoardParts,
  buildThalamusCatalog,
  thalamusSuggestionFor,
} from "./thalamus-board-build.js";
import { clearThalamusTierDefaultsCache } from "./thalamus-tier-defaults.js";
import type { UsageSnapshot } from "./usage-snapshot-store.js";

// PIN: v2's board, before it moved here.
//
// `referenceV2Board` below is the block that used to sit inline in `auto-reply/reply/model-selection.ts`, copied
// verbatim (only the free variables became parameters). The builder must give exactly its answer on the same input,
// so that moving the block changed nothing about what v2 plans over, and so v4's per-call router (which calls the
// same builder) sees the same board as the chart and v2.

const NOW = 1_757_000_000_000;

const CONFIGURED: Record<string, { intelligenceIndex?: number }> = {
  "claude-code/claude-opus-5": { intelligenceIndex: 70 },
  "claude-code/claude-sonnet-4-6": { intelligenceIndex: 62 },
  "claude-code/claude-haiku-4-5": { intelligenceIndex: 52 },
  "xai/grok-4.6": { intelligenceIndex: 66 },
  "openrouter/not-indexed": {},
  "no-slash": { intelligenceIndex: 60 },
  "trailing/": { intelligenceIndex: 60 },
  "nan/model": { intelligenceIndex: Number.NaN },
};

const WINDOW_ROWS = [
  { provider: "claude-code", id: "claude-opus-5", contextWindow: 1_000_000 },
  { provider: "claude-code", id: "claude-haiku-4-5", contextWindow: 200_000 },
  { provider: "xai", id: "grok-4.6", contextWindow: 256_000 },
  { provider: "xai", id: "zero", contextWindow: 0 },
  { provider: "xai", id: "unset" },
];

const SPENT_XAI: UsageSnapshot = {
  lastSuccessfulFetch: NOW - 60_000,
  windows: { xai: [{ label: "5-hour", usedPercent: 100 }] },
  providers: {},
};

/** v2's block, verbatim. */
function referenceV2Board(input: {
  configuredModels: Record<string, { intelligenceIndex?: number }>;
  snapshot: UsageSnapshot | undefined;
  allowedModelKeys: ReadonlySet<string>;
  allowedModelCatalog: typeof WINDOW_ROWS;
}) {
  const thalamusCatalog: Record<string, { intelligenceIndex: number }> = {};
  for (const [rawKey, entry] of Object.entries(input.configuredModels)) {
    const index = entry?.intelligenceIndex;
    if (typeof index !== "number" || !Number.isFinite(index)) {
      continue;
    }
    const slash = rawKey.indexOf("/");
    if (slash <= 0 || slash === rawKey.length - 1) {
      continue;
    }
    const ref = normalizeModelRef(rawKey.slice(0, slash), rawKey.slice(slash + 1));
    thalamusCatalog[modelKey(ref.provider, ref.model)] = { intelligenceIndex: index };
  }
  const reachable = thalamusCandidates({
    catalog: thalamusCatalog,
    snapshot: input.snapshot,
    nowMs: NOW,
    relCostFor: (key) => relCostLookup(key),
    allowedModelKeys: input.allowedModelKeys.size > 0 ? input.allowedModelKeys : undefined,
  });
  const rungs = reachable.considered.flatMap((candidate) =>
    candidate.relCost === undefined
      ? []
      : frontierRungsFor(candidate.key, candidate.intelligenceIndex, candidate.relCost),
  );
  const supplies = supplyStates(input.snapshot?.windows, NOW);
  const ctxByKey = new Map<string, number>();
  for (const entry of input.allowedModelCatalog) {
    if (typeof entry.contextWindow === "number" && entry.contextWindow > 0) {
      ctxByKey.set(modelKey(entry.provider, entry.id), entry.contextWindow);
    }
  }
  return {
    thalamusCatalog,
    reachable,
    rungs,
    supplies,
    contextWindowFor: (k: string) => ctxByKey.get(k),
  };
}

function viaBuilder(snapshot: UsageSnapshot | undefined, allowed: ReadonlySet<string>) {
  const catalog = buildThalamusCatalog(CONFIGURED);
  return {
    catalog,
    ...buildThalamusBoardParts({
      catalog,
      thalamusCandidates,
      snapshot,
      nowMs: NOW,
      allowedModelKeys: allowed,
      windowRows: WINDOW_ROWS,
    }),
  };
}

const CASES: Array<[string, UsageSnapshot | undefined, ReadonlySet<string>]> = [
  ["no usage snapshot, no allowlist", undefined, new Set()],
  ["a spent provider", SPENT_XAI, new Set()],
  [
    "an agent allowlist",
    undefined,
    new Set(["claude-code/claude-opus-5", "claude-code/claude-haiku-4-5"]),
  ],
  [
    "a spent provider and an allowlist",
    SPENT_XAI,
    new Set(["xai/grok-4.6", "claude-code/claude-opus-5"]),
  ],
];

describe("the board builder gives the answer v2's inline block gave", () => {
  for (const [name, snapshot, allowed] of CASES) {
    it(name, () => {
      const ref = referenceV2Board({
        configuredModels: CONFIGURED,
        snapshot,
        allowedModelKeys: allowed,
        allowedModelCatalog: WINDOW_ROWS,
      });
      const got = viaBuilder(snapshot, allowed);
      expect(got.catalog).toEqual(ref.thalamusCatalog);
      expect(got.reachable).toEqual(ref.reachable);
      expect(got.rungs).toEqual(ref.rungs);
      expect([...got.supplies.entries()]).toEqual([...ref.supplies.entries()]);
      for (const key of [
        "claude-code/claude-opus-5",
        "claude-code/claude-haiku-4-5",
        "xai/grok-4.6",
        "xai/zero",
        "xai/unset",
        "nope/x",
      ]) {
        expect(got.contextWindowFor(key)).toEqual(ref.contextWindowFor(key));
      }
    });
  }

  it("is not a vacuous comparison: the fixture reaches rungs, and a spent provider changes them", () => {
    const open = viaBuilder(undefined, new Set());
    const spent = viaBuilder(SPENT_XAI, new Set());
    expect(open.rungs.length).toBeGreaterThan(0);
    expect(open.rungs.some((r) => r.key.startsWith("xai/"))).toBe(true);
    expect(spent.rungs.some((r) => r.key.startsWith("xai/"))).toBe(false);
  });

  it("an empty allowlist means no restriction, as in v2", () => {
    const none = viaBuilder(undefined, new Set());
    const one = viaBuilder(undefined, new Set(["claude-code/claude-opus-5"]));
    expect(new Set(none.rungs.map((r) => r.key)).size).toBeGreaterThan(
      new Set(one.rungs.map((r) => r.key)).size,
    );
  });

  it("keeps a suggested Sol on the board without bypassing its allowlist", () => {
    const key = "openai-codex/gpt-6.1-sol";
    const catalog = {
      "xai/grok-4.7": { intelligenceIndex: 60 },
      [key]: { intelligenceIndex: 51.8333 },
    };
    const input = { catalog, thalamusCandidates, snapshot: undefined, nowMs: NOW, windowRows: [] };
    expect(buildThalamusBoardParts(input).rungs.some((r) => r.key === key)).toBe(false);
    expect(
      buildThalamusBoardParts({ ...input, suggestedModelKey: key }).rungs.some(
        (r) => r.key === key,
      ),
    ).toBe(true);
    expect(
      buildThalamusBoardParts({
        ...input,
        suggestedModelKey: key,
        allowedModelKeys: new Set(["xai/grok-4.7"]),
      }).rungs.some((r) => r.key === key),
    ).toBe(false);
  });

  it("skips entries with no usable index or a malformed key", () => {
    expect(Object.keys(buildThalamusCatalog(CONFIGURED)).sort()).toEqual([
      "claude-code/claude-haiku-4-5",
      "claude-code/claude-opus-5",
      "claude-code/claude-sonnet-4-6",
      "xai/grok-4.6",
    ]);
    expect(buildThalamusCatalog(undefined)).toEqual({});
  });
});

describe("thalamusSuggestionFor — the one reader both routers call", () => {
  const dir = mkdtempSync(join(tmpdir(), "thal-sug-"));
  const file = join(dir, "t.json");
  beforeEach(() => clearThalamusTierDefaultsCache());

  it("answers for the dial's stop, with the key spelled the way the catalog's keys are", () => {
    writeFileSync(
      file,
      JSON.stringify({
        smart: { model: "claude-code/claude-opus-5-5", effort: "max" },
        default: { model: "xai/grok-4.7" },
      }),
    );
    const ref = normalizeModelRef("claude-code", "claude-opus-5-5");
    expect(thalamusSuggestionFor(6, { file })).toEqual({
      key: modelKey(ref.provider, ref.model),
      effort: "max",
    });
    expect(thalamusSuggestionFor(3, { file })?.effort).toBeUndefined();
    expect(thalamusSuggestionFor(undefined, { file })?.key).toBe("xai/grok-4.7");
  });

  it("is undefined for a stop with no suggestion", () => {
    writeFileSync(file, JSON.stringify({ smart: { model: "a/b" } }));
    expect(thalamusSuggestionFor(0, { file })).toBeUndefined();
  });
});
