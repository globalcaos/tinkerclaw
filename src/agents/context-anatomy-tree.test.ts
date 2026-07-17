import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
  closeAnatomyDb,
  insertAnatomyEvent,
  querySessionEvents,
  querySessionTree,
  setAnatomyDbPathForTests,
} from "./context-anatomy-db.js";
import type { ContextAnatomyEvent } from "./context-anatomy.js";

// FORK 2026-07-16 (EEG fan-out visibility, bug-log [eeg-subagent-single-session-gap]):
// isolated DB so these assertions are deterministic (the http.test.ts suite writes to
// the REAL DB and is flaky for exactly this reason).

const dir = mkdtempSync(join(tmpdir(), "anatomy-tree-"));
let testSeq = 0;

let clock = 1_000_000;
function insert(sessionKey: string): void {
  const ev = {
    turn: 1,
    roundNumber: 0,
    compactionCycle: 0,
    timestamp: new Date(clock).toISOString(),
    timestampMs: clock++,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    sessionKey,
    topics: [],
    contextSent: {},
    contextWindow: {},
    memoriesInjected: { autoRecall: [], searched: [] },
  } as unknown as ContextAnatomyEvent;
  insertAnatomyEvent(ev);
}

beforeEach(() => {
  // Fresh tmp DB file per test → total isolation, so exact-count assertions can't be
  // perturbed by another test's inserts (vitest gives no order guarantee).
  setAnatomyDbPathForTests(join(dir, `anatomy-${testSeq++}.db`));
});

afterAll(() => {
  closeAnatomyDb();
  setAnatomyDbPathForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("querySessionTree — subagent family expansion", () => {
  test("tree(main) includes flat subagents under the agent root; plain query excludes them", () => {
    const main = "agent:main:main";
    insert(main);
    insert(main);
    insert("agent:main:subagent:aaaa");
    insert("agent:main:subagent:bbbb");
    // A fractal LANE key contains ':subagent:' but is NOT a real fan-out child — the
    // LIKE anchors 'subagent' immediately after the root, so this must be EXCLUDED.
    insert("agent:main:fractal-reflection:announce:v1:agent:main:subagent:cccc:dddd");

    const plain = querySessionEvents(main, 500);
    expect(plain.length).toBe(2); // only the two main rows

    const tree = querySessionTree(main, 500);
    const keys = tree.map((e) => e.sessionKey);
    expect(keys.filter((k) => k === main).length).toBe(2);
    expect(keys).toContain("agent:main:subagent:aaaa");
    expect(keys).toContain("agent:main:subagent:bbbb");
    // fractal lane key excluded
    expect(keys.some((k) => k?.includes("fractal-reflection"))).toBe(false);
    expect(tree.length).toBe(4);
  });

  test("a tinker tab shares the agent root → also sees the flat subagents", () => {
    const tab = "agent:main:tinker:mq123";
    insert(tab);
    insert("agent:main:subagent:eeee");
    const tree = querySessionTree(tab, 500);
    const keys = tree.map((e) => e.sessionKey);
    expect(keys).toContain(tab);
    expect(keys).toContain("agent:main:subagent:eeee");
  });

  test("a non-agent key falls back to single-session (no expansion)", () => {
    insert("temp:title-suggest");
    insert("agent:main:subagent:ffff");
    const tree = querySessionTree("temp:title-suggest", 500);
    expect(tree.every((e) => e.sessionKey === "temp:title-suggest")).toBe(true);
    expect(tree.length).toBe(1);
  });

  test("a subagent key itself does not expand (no self-family)", () => {
    const sub = "agent:main:subagent:gggg";
    insert(sub);
    insert("agent:main:subagent:hhhh");
    const tree = querySessionTree(sub, 500);
    // Falls back to single-session: only its own row, not the sibling.
    expect(tree.every((e) => e.sessionKey === sub)).toBe(true);
    expect(tree.length).toBe(1);
  });
});
