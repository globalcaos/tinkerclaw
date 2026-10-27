import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerSpawnParams } from "./worker.js";

// FORK 2026-10-22 (Rewind): after `amygdala2.rewind` moves a tab to a truncated copy of its claude-cli session, the
// bridge must (a) resume that copy and (b) not keep serving the old conversation from a warm worker.
const MAP_ENV = "OPENCLAW_TINKER_BRIDGE_SESSION_MAP";
const GiB = 2 ** 30;
const OLD = "11111111-1111-1111-1111-111111111111";
const FORK = "22222222-2222-2222-2222-222222222222";
const OC = "oc-session-1";

class FakeWorker {
  readonly sessionKey: string;
  sessionId: string | null = null;
  killed = false;
  busy = false;
  constructor(readonly params: WorkerSpawnParams) {
    this.sessionKey = params.sessionKey;
  }
  isAlive() {
    return !this.killed;
  }
  isBusy() {
    return this.busy;
  }
  kill() {
    this.killed = true;
  }
  on() {}
}

let dir: string;
let mapFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-rewind-"));
  mapFile = join(dir, "session-map.json");
  process.env[MAP_ENV] = mapFile; // sandbox BEFORE the module reads anything: never the live map
  vi.resetModules();
});
afterEach(() => {
  delete process.env[MAP_ENV];
  rmSync(dir, { recursive: true, force: true });
});

async function load(map: Record<string, unknown>) {
  writeFileSync(mapFile, JSON.stringify(map));
  const sessionMap = await import("./session-map.js");
  const { SessionWorkerPool } = await import("./worker-pool.js");
  const { createRewindSeam } = await import("./rewind-seam.js");
  const created: FakeWorker[] = [];
  const pool = new SessionWorkerPool({
    sweepIntervalMs: 0,
    freeMemBytes: () => 64 * GiB,
    createWorker: (params) => {
      const w = new FakeWorker(params);
      created.push(w);
      return w as unknown as ReturnType<InstanceType<typeof SessionWorkerPool>["getOrCreate"]>;
    },
  });
  return { sessionMap, pool, created, seam: createRewindSeam(() => pool) };
}
const params = (key: string) =>
  ({ sessionKey: key, cwd: "/tmp", openclawSessionId: OC }) as WorkerSpawnParams;
const onDisk = () =>
  JSON.parse(readFileSync(mapFile, "utf8")) as Record<string, { sessionId: string }>;

describe("Rewind seam", () => {
  it("moves every binding of the old session, in the cache and on disk, and leaves the others", async () => {
    const { sessionMap, seam } = await load({
      a: { sessionId: OLD, updatedAt: 1, openclawSessionId: OC },
      b: { sessionId: OLD, updatedAt: 2, openclawSessionId: OC },
      other: { sessionId: "33333333-3333-3333-3333-333333333333", updatedAt: 3 },
    });
    expect(seam.rebind(OLD, FORK)).toEqual({ ok: true });
    expect(onDisk().a.sessionId).toBe(FORK);
    expect(onDisk().b.sessionId).toBe(FORK);
    expect(onDisk().other.sessionId).toBe("33333333-3333-3333-3333-333333333333");
    // The lookup the pool uses for a respawn reads the cache this process holds, not the file.
    expect(sessionMap.getLatestResumeSessionIdByOpenclawSessionId(OC)).toBe(FORK);
    expect(sessionMap.getResumeSessionId("a")).toBe(FORK);
  });

  it("retires the warm worker, so the next turn resumes the fork instead of the old conversation", async () => {
    const { pool, created, seam } = await load({
      a: { sessionId: OLD, updatedAt: 1, openclawSessionId: OC },
    });
    const warm = pool.getOrCreate(params("a")) as unknown as FakeWorker;
    warm.sessionId = OLD;
    expect(pool.getOrCreate(params("a"))).toBe(warm); // the pool serves the warm one: its context is the old one

    expect(seam.rebind(OLD, FORK).ok).toBe(true);

    expect(warm.killed).toBe(true);
    expect(pool.get("a")).toBeUndefined();
    const next = pool.getOrCreate(params("a")) as unknown as FakeWorker;
    expect(next).not.toBe(warm);
    expect(created).toHaveLength(2);
    expect(next.params.resumeSessionId).toBe(FORK);
  });

  it("refuses while a reply is running: nothing moves, nothing is killed", async () => {
    const { pool, seam } = await load({
      a: { sessionId: OLD, updatedAt: 1, openclawSessionId: OC },
    });
    const w = pool.getOrCreate(params("a")) as unknown as FakeWorker;
    w.sessionId = OLD;
    w.busy = true;
    expect(seam.busy(OLD)).toBe(true);
    expect(seam.rebind(OLD, FORK)).toEqual({
      ok: false,
      reason: "a reply is still running in this tab",
    });
    expect(w.killed).toBe(false);
    expect(onDisk().a.sessionId).toBe(OLD);
  });

  it("says so when the bridge holds nothing for that session", async () => {
    const { seam } = await load({ a: { sessionId: OLD, updatedAt: 1 } });
    expect(seam.rebind("44444444-4444-4444-4444-444444444444", FORK).ok).toBe(false);
    expect(onDisk().a.sessionId).toBe(OLD);
  });

  it("publishes under the key the amygdala reads", async () => {
    const { BRIDGE_REWIND_SLOT } = await import("./rewind-seam.js");
    const amygdala = readFileSync(
      join(__dirname, "../../tinkerclaw-amygdala/src/bridge-session-map.ts"),
      "utf8",
    );
    expect(amygdala).toContain(`BRIDGE_REWIND_SLOT = "${BRIDGE_REWIND_SLOT}"`);
  });
});
