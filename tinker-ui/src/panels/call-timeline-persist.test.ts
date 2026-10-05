/**
 * context-window-panel.md §5.3 — the call timeline's last run, kept across a reload (FORK
 * 2026-10-02, the owner: "it should always show the last run instead").
 */
import { describe, expect, it } from "vitest";
import { CallTimelineStore, type RunSnapshot } from "./call-timeline";
import {
  LAST_RUN_KEY,
  LAST_RUN_MAX_SESSIONS,
  loadLastRun,
  saveLastRun,
} from "./call-timeline-persist";

/** app.ts sessionKeyMatches, verbatim: the short and canonical spellings are one session. */
const matches = (a: string, b: string): boolean =>
  a === b || a.endsWith(":" + b) || b.endsWith(":" + a);

class MemoryStorage implements Storage {
  private readonly m = new Map<string, string>();
  quota = Number.POSITIVE_INFINITY;
  get length(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  key(i: number): string | null {
    return Array.from(this.m.keys())[i] ?? null;
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  setItem(k: string, v: string): void {
    if (v.length > this.quota) {
      throw new DOMException("full", "QuotaExceededError");
    }
    this.m.set(k, v);
  }
}

function snapshotOf(runId: string): RunSnapshot {
  const st = new CallTimelineStore();
  st.turnStart(runId, 1_000, "m");
  st.outputCumulative(runId, "responseText", 350, 3_000);
  st.turnEnd(runId, 4_000);
  const snap = st.lastRunSnapshot();
  if (!snap) {
    throw new Error("no snapshot");
  }
  return snap;
}

describe("call-timeline-persist — the last run per session", () => {
  it("round-trips a snapshot that restores into a fresh store", () => {
    const storage = new MemoryStorage();
    expect(saveLastRun("agent:main:tinker:a", snapshotOf("r1"), matches, 10, storage)).toBe(true);
    const back = loadLastRun("agent:main:tinker:a", matches, storage);
    const fresh = new CallTimelineStore();
    expect(fresh.restoreRun(back)).toBe(true);
    expect(fresh.promptView()).toMatchObject({ runId: "r1", calls: 1 });
  });

  it("finds a session under its other spelling, and keeps ONE entry for it", () => {
    const storage = new MemoryStorage();
    saveLastRun("agent:main:tinker:a", snapshotOf("r1"), matches, 10, storage);
    expect(loadLastRun("tinker:a", matches, storage)).toMatchObject({ runId: "r1" });
    saveLastRun("tinker:a", snapshotOf("r2"), matches, 20, storage);
    const raw = JSON.parse(storage.getItem(LAST_RUN_KEY) ?? "{}") as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(["tinker:a"]);
    expect(loadLastRun("agent:main:tinker:a", matches, storage)).toMatchObject({ runId: "r2" });
    // CONTROL: a different session does not match.
    expect(loadLastRun("tinker:b", matches, storage)).toBeNull();
  });

  it("keeps at most LAST_RUN_MAX_SESSIONS sessions, dropping the least recently saved", () => {
    const storage = new MemoryStorage();
    const snap = snapshotOf("r");
    for (let i = 0; i <= LAST_RUN_MAX_SESSIONS; i++) {
      saveLastRun(`tinker:s${i}`, snap, matches, i, storage);
    }
    const raw = JSON.parse(storage.getItem(LAST_RUN_KEY) ?? "{}") as Record<string, unknown>;
    expect(Object.keys(raw)).toHaveLength(LAST_RUN_MAX_SESSIONS);
    expect(loadLastRun("tinker:s0", matches, storage)).toBeNull();
    expect(loadLastRun(`tinker:s${LAST_RUN_MAX_SESSIONS}`, matches, storage)).not.toBeNull();
  });

  it("reads a corrupt or foreign value as nothing, and overwrites it on the next save", () => {
    const storage = new MemoryStorage();
    storage.setItem(LAST_RUN_KEY, "{not json");
    expect(loadLastRun("tinker:a", matches, storage)).toBeNull();
    storage.setItem(LAST_RUN_KEY, JSON.stringify({ "tinker:a": { savedAt: "x", snap: 1 } }));
    expect(loadLastRun("tinker:a", matches, storage)).toBeNull();
    expect(saveLastRun("tinker:a", snapshotOf("r1"), matches, 5, storage)).toBe(true);
    expect(loadLastRun("tinker:a", matches, storage)).toMatchObject({ runId: "r1" });
  });

  it("sheds the older half on a full store and retries once; reports a write that cannot land", () => {
    const storage = new MemoryStorage();
    const snap = snapshotOf("r");
    for (let i = 0; i < 4; i++) {
      saveLastRun(`tinker:s${i}`, snap, matches, i, storage);
    }
    const one = JSON.stringify({ x: { savedAt: 0, snap } }).length;
    storage.quota = one * 3.5; // room for three entries, not five
    expect(saveLastRun("tinker:new", snap, matches, 99, storage)).toBe(true);
    expect(loadLastRun("tinker:new", matches, storage)).not.toBeNull();
    expect(loadLastRun("tinker:s0", matches, storage)).toBeNull();
    storage.quota = 10;
    expect(saveLastRun("tinker:other", snap, matches, 100, storage)).toBe(false);
  });
});
