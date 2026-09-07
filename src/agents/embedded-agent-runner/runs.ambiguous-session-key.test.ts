import { beforeEach, describe, expect, it } from "vitest";
import {
  clearActiveEmbeddedRun,
  resolveActiveEmbeddedRunSessionId,
  resolveActiveEmbeddedRunSessionIdUnique,
  setActiveEmbeddedRun,
} from "./runs.js";

// Two Claude Code tabs both live under the agent session key "agent:main:main".
// Their embedded runs carry distinct sessionIds.
const SHARED_KEY = "agent:main:main";
const TAB_A = "agent:main:main:4b8db6fe";
const TAB_B = "agent:main:main:a42d2f60";

// clearActiveEmbeddedRun() only removes a run when the handle is identical, so
// each session needs one stable handle for setup and teardown to pair up.
const handles = new Map<string, never>();
const handle = (id: string) => {
  const existing = handles.get(id);
  if (existing) {
    return existing;
  }
  const created = {} as never;
  handles.set(id, created);
  return created;
};

describe("resolveActiveEmbeddedRunSessionIdUnique", () => {
  beforeEach(() => {
    for (const id of [TAB_A, TAB_B, SHARED_KEY]) {
      clearActiveEmbeddedRun(id, handle(id));
    }
  });

  it("returns the run when only one live run matches the key", () => {
    setActiveEmbeddedRun(TAB_A, handle(TAB_A));
    const resolved = resolveActiveEmbeddedRunSessionIdUnique(SHARED_KEY);
    expect(resolved.sessionId).toBe(TAB_A);
    expect(resolved.ambiguous).toBe(false);
  });

  it("refuses to guess when two live runs share the session key", () => {
    setActiveEmbeddedRun(TAB_A, handle(TAB_A));
    setActiveEmbeddedRun(TAB_B, handle(TAB_B));

    // The legacy resolver picks a tab by Map insertion order — this is the leak.
    expect(resolveActiveEmbeddedRunSessionId(SHARED_KEY)).toBe(TAB_A);

    // The ambiguity-aware resolver fails closed instead.
    const resolved = resolveActiveEmbeddedRunSessionIdUnique(SHARED_KEY);
    expect(resolved.ambiguous).toBe(true);
    expect(resolved.sessionId).toBeUndefined();
    expect(resolved.candidateCount).toBe(2);
  });

  it("prefers an exact match even when other runs are live", () => {
    setActiveEmbeddedRun(SHARED_KEY, handle(SHARED_KEY));
    setActiveEmbeddedRun(TAB_B, handle(TAB_B));
    const resolved = resolveActiveEmbeddedRunSessionIdUnique(SHARED_KEY);
    expect(resolved.sessionId).toBe(SHARED_KEY);
    expect(resolved.ambiguous).toBe(false);
  });

  it("reports no candidates when nothing is live", () => {
    const resolved = resolveActiveEmbeddedRunSessionIdUnique(SHARED_KEY);
    expect(resolved.ambiguous).toBe(false);
    expect(resolved.sessionId).toBeUndefined();
    expect(resolved.candidateCount).toBe(0);
  });
});
