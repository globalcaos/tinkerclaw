/**
 * ENGRAM — Wire-phase tests for runSleepConsolidation's opt-in dependency
 * bundles (Upgrades 6 + 8). Verifies that skill extraction (U6) and Mem0
 * write-reconciliation + MEMORY.md suggest-only serialization (U8) are wired
 * into the consolidation pass, while remaining byte-identical when no dep is
 * injected (backward compat).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createArtifactStore, type ArtifactStore } from "./artifact-store.js";
import { createInitialConsolidationState } from "./episode-detection.js";
import { createEventStore, type EventStore } from "./event-store.js";
import type { MemoryEvent } from "./event-types.js";
import { createReconciliationLedger } from "./reconciliation-ledger.js";
import { reconcileWindowHeuristic, type MemoryReconciler } from "./reconciliation.js";
import type { SkillBody, SkillExtractor } from "./skill-extraction.js";
import { createSkillLibrary } from "./skill-library.js";
import { runSleepConsolidation } from "./sleep-consolidation.js";

let tmpDir: string;
let store: EventStore;
let artifactStore: ArtifactStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engram-sc-wiring-"));
  store = createEventStore({ baseDir: tmpDir, sessionKey: "test" });
  artifactStore = createArtifactStore({ baseDir: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function appendEvent(overrides: {
  kind?: MemoryEvent["kind"];
  content?: string;
  turnId?: number;
}): MemoryEvent {
  return store.append({
    kind: overrides.kind ?? "user_message",
    content: overrides.content ?? "test message",
    tokens: 10,
    turnId: overrides.turnId ?? 0,
    sessionKey: "test",
    metadata: {},
  });
}

const stubBody: SkillBody = {
  name: "merge-conflict-resolution",
  description: "Resolve a git merge conflict and re-verify with tests",
  prerequisites: ["a checked-out branch with conflicts"],
  steps: ["identify conflicting files", "pick a resolution side", "re-run the test suite"],
  testCases: [{ input: { file: "foo.ts" }, expect: "no conflict markers remain" }],
};

// ---------------------------------------------------------------------------
// U6 — skill extraction wiring
// ---------------------------------------------------------------------------
describe("U6 skill extraction wiring", () => {
  it("no skillExtraction dep → no skillsExtracted field (backward compat)", async () => {
    const state = createInitialConsolidationState();
    appendEvent({ content: "hello", turnId: 0 });
    appendEvent({ kind: "agent_message", content: "hi", turnId: 1 });

    const result = await runSleepConsolidation(store, artifactStore, state);
    expect(result.skillsExtracted).toBeUndefined();
  });

  it("worthy episode → extractSkill called, skill put into library, skillsExtracted incremented", async () => {
    const state = createInitialConsolidationState();
    appendEvent({ kind: "user_message", content: "fix the merge conflict", turnId: 0 });
    appendEvent({ kind: "tool_call", content: "git checkout --ours foo.ts", turnId: 1 });
    appendEvent({ kind: "agent_message", content: "resolved; tests green", turnId: 2 });

    const library = createSkillLibrary({ baseDir: tmpDir });
    const putSpy = vi.spyOn(library, "put");
    const extractor: SkillExtractor = () => stubBody;

    const result = await runSleepConsolidation(store, artifactStore, state, {
      skillExtraction: {
        library,
        extractor,
        // Override the strict worthiness gate so the wiring is exercisable
        // (detectEpisodes always emits keyDecisions:[], so the real gate would
        // never fire on a freshly-detected episode).
        isWorthy: () => true,
      },
    });

    expect(result.skillsExtracted).toBe(1);
    expect(putSpy).toHaveBeenCalledTimes(1);
    const refs = library.list();
    expect(refs.some((r) => r.name === "merge-conflict-resolution")).toBe(true);
  });

  it("default strict gate (no override) → not worthy (empty keyDecisions) → nothing extracted", async () => {
    const state = createInitialConsolidationState();
    appendEvent({ kind: "user_message", content: "fix something", turnId: 0 });
    appendEvent({ kind: "tool_call", content: "do thing", turnId: 1 });
    appendEvent({ kind: "agent_message", content: "done", turnId: 2 });

    const library = createSkillLibrary({ baseDir: tmpDir });
    const extractor = vi.fn<SkillExtractor>(() => stubBody);

    const result = await runSleepConsolidation(store, artifactStore, state, {
      skillExtraction: { library, extractor },
    });

    // Real isSkillWorthy fails (keyDecisions is [] from detectEpisodes), so the
    // extractor is never called and nothing enters the library.
    expect(result.skillsExtracted).toBe(0);
    expect(extractor).not.toHaveBeenCalled();
    expect(library.list()).toHaveLength(0);
  });

  it("extractor declining (null body) → no skill stored", async () => {
    const state = createInitialConsolidationState();
    appendEvent({ kind: "user_message", content: "x", turnId: 0 });
    appendEvent({ kind: "tool_call", content: "y", turnId: 1 });
    appendEvent({ kind: "agent_message", content: "z", turnId: 2 });

    const library = createSkillLibrary({ baseDir: tmpDir });
    const extractor: SkillExtractor = () => null;

    const result = await runSleepConsolidation(store, artifactStore, state, {
      skillExtraction: { library, extractor, isWorthy: () => true },
    });

    expect(result.skillsExtracted).toBe(0);
    expect(library.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// U8 — reconciliation + MEMORY.md writer wiring in consolidation
// ---------------------------------------------------------------------------
describe("U8 reconciliation wiring in consolidation", () => {
  it("no reconciliation dep → no reconciliationDecisions / memoryMd fields (backward compat)", async () => {
    const state = createInitialConsolidationState();
    appendEvent({ content: "a", turnId: 0 });

    const result = await runSleepConsolidation(store, artifactStore, state);
    expect(result.reconciliationDecisions).toBeUndefined();
    expect(result.memoryMd).toBeUndefined();
  });

  it("heuristic reconciler records DELETE for exact-duplicate content in the ledger", async () => {
    const state = createInitialConsolidationState();
    // Two identical agent_message events → second is a logical DELETE of the first.
    appendEvent({ kind: "user_message", content: "remember X", turnId: 0 });
    const dup1 = appendEvent({
      kind: "agent_message",
      content: "fact: the sky is blue",
      turnId: 1,
    });
    appendEvent({ kind: "agent_message", content: "fact: the sky is blue", turnId: 2 });

    const reconciler: MemoryReconciler = {
      async decide() {
        return { action: "ADD" };
      },
      decideSync() {
        return { action: "ADD" };
      },
      async reconcileWindow(events) {
        return reconcileWindowHeuristic(events);
      },
    };
    const ledger = createReconciliationLedger();

    const result = await runSleepConsolidation(store, artifactStore, state, {
      reconciliation: { reconciler, ledger },
    });

    expect(result.reconciliationDecisions).toEqual({ updated: 0, deleted: 1 });
    expect(ledger.isTombstoned(dup1.id)).toBe(true);
  });

  it("UPDATE decisions are recorded as supersede in the ledger", async () => {
    const state = createInitialConsolidationState();
    const target = appendEvent({ kind: "agent_message", content: "old fact", turnId: 0 });
    appendEvent({ kind: "agent_message", content: "newer fact", turnId: 1 });

    const reconciler: MemoryReconciler = {
      async decide() {
        return { action: "ADD" };
      },
      decideSync() {
        return { action: "ADD" };
      },
      async reconcileWindow(events) {
        return events.map((e, i) =>
          i === events.length - 1
            ? ({
                action: "UPDATE",
                targetEventId: target.id,
                reason: "supersedes old fact",
              } as const)
            : ({ action: "ADD" } as const),
        );
      },
    };
    const ledger = createReconciliationLedger();

    const result = await runSleepConsolidation(store, artifactStore, state, {
      reconciliation: { reconciler, ledger },
    });

    expect(result.reconciliationDecisions).toEqual({ updated: 1, deleted: 0 });
    expect(ledger.isSuperseded(target.id)).toBe(true);
  });

  it("MEMORY.md suggest-only serialization is produced (bounded, never written to disk)", async () => {
    const state = createInitialConsolidationState();
    appendEvent({ kind: "user_message", content: "topic one", turnId: 0 });
    appendEvent({ kind: "agent_message", content: "reply one", turnId: 1 });

    const reconciler: MemoryReconciler = {
      async decide() {
        return { action: "ADD" };
      },
      decideSync() {
        return { action: "ADD" };
      },
      async reconcileWindow(events) {
        return events.map(() => ({ action: "ADD" }));
      },
    };
    const ledger = createReconciliationLedger();

    const result = await runSleepConsolidation(store, artifactStore, state, {
      reconciliation: { reconciler, ledger, memoryMdMaxLines: 50 },
    });

    expect(result.memoryMd).toBeDefined();
    expect(result.memoryMd!.content).toContain("# Memory Index");
    expect(result.memoryMd!.lineCount).toBeLessThanOrEqual(50);
  });
});
