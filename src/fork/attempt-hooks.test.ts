/**
 * WIRE-SEAM 2 — tests for the four new attempt-hooks consumers (U2/U8/U9/U10).
 *
 * Test target: src/fork/attempt-hooks.ts
 *
 * Only the pure / directly-callable units are exercised here (the full
 * onTurnComplete pipeline needs a live SessionManager + runtimes, out of scope
 * for a unit test):
 *   - extractLastUserText  (shared text helper used by U2 + U9)
 *   - onCuriosityScan      (U2 — LCM uncertainty heuristic → curiosity gap)
 *   - stashReasoningTrace / consumeReasoningTrace (U10 — per-run trace stash)
 *
 * Curiosity-gap I/O is isolated to a temp dir via the `baseDir` override.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SerializedTree } from "../agents/reasoning-tree.js";
import {
  consumeReasoningTrace,
  extractLastUserText,
  onCuriosityScan,
  stashReasoningTrace,
} from "./attempt-hooks.js";
import { readGaps } from "./curiosity-store.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "attempt-hooks-"));
}

describe("extractLastUserText (U2/U9 shared helper)", () => {
  it("returns string content of the LAST user message", () => {
    const snap = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "an answer" },
      { role: "user", content: "second question" },
    ];
    expect(extractLastUserText(snap)).toBe("second question");
  });

  it("joins text blocks of an array-content user message", () => {
    const snap = [
      {
        role: "user",
        content: [
          { type: "text", text: "line one" },
          { type: "image" },
          { type: "text", text: "line two" },
        ],
      },
    ];
    expect(extractLastUserText(snap)).toBe("line one\nline two");
  });

  it("returns '' when there is no user message or no text", () => {
    expect(extractLastUserText([{ role: "assistant", content: "x" }])).toBe("");
    expect(extractLastUserText([])).toBe("");
    expect(extractLastUserText([{ role: "user" }])).toBe("");
  });
});

describe("onCuriosityScan (U2 — heuristic LCM path)", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appends ONE lcm-entropy gap when the reply hedges", () => {
    const id = onCuriosityScan(
      ["I'm not sure how the cross-session link store handles JSONL sharding."],
      {
        sessionKey: "agent:main:main",
        runId: "run-1",
        lastUserMessage: "How does the link store shard its JSONL?",
        baseDir: dir,
      },
    );
    expect(id).toMatch(/^gap_/);
    const gaps = readGaps({ sinceDays: 1, baseDir: dir });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.source).toBe("lcm-entropy");
    expect(gaps[0]!.sessionKey).toBe("agent:main:main");
    expect(gaps[0]!.runId).toBe("run-1");
    // Topic should come from the user's question, not the hedge phrase.
    expect(gaps[0]!.topic.toLowerCase()).toContain("link");
  });

  it("returns null and writes nothing when the reply is confident", () => {
    const id = onCuriosityScan(["The store shards by day under a per-session dir."], {
      sessionKey: "agent:main:main",
      runId: "run-2",
      lastUserMessage: "How does the link store shard?",
      baseDir: dir,
    });
    expect(id).toBeNull();
    expect(readGaps({ sinceDays: 1, baseDir: dir })).toHaveLength(0);
  });

  it("ignores a hedge that only appears inside quoted/echoed content", () => {
    // The hedge is inside a double-quoted echo of the user — masked, not the model's voice.
    const id = onCuriosityScan(['You asked "I am not sure" — here is the precise answer.'], {
      baseDir: dir,
    });
    expect(id).toBeNull();
    expect(readGaps({ sinceDays: 1, baseDir: dir })).toHaveLength(0);
  });

  it("never throws on empty input", () => {
    expect(onCuriosityScan([], { baseDir: dir })).toBeNull();
  });
});

describe("reasoning-trace stash (U10 — pre-prompt → onTurnComplete handoff)", () => {
  const trace: SerializedTree = {
    rootId: "r",
    nodes: [
      {
        id: "r",
        content: "root",
        score: null,
        depth: 0,
        parentId: null,
        childIds: [],
        status: "open",
      },
    ],
    edges: [],
    winningPath: ["r"],
  };

  it("round-trips a stashed trace by runId, then clears it", () => {
    stashReasoningTrace("run-A", trace);
    const got = consumeReasoningTrace("run-A");
    expect(got).toBe(trace);
    // Second consume is empty — the stash is single-use.
    expect(consumeReasoningTrace("run-A")).toBeUndefined();
  });

  it("returns undefined for an unknown runId", () => {
    expect(consumeReasoningTrace("never-stashed")).toBeUndefined();
  });

  it("is a no-op for a null trace or empty runId", () => {
    stashReasoningTrace("run-B", null);
    expect(consumeReasoningTrace("run-B")).toBeUndefined();
    stashReasoningTrace("", trace);
    expect(consumeReasoningTrace("")).toBeUndefined();
  });
});
