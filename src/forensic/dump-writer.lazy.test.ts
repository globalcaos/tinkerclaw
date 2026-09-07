/**
 * FORK 2026-08-28 — R4 gate: the forensic store must never enumerate
 * `forensic-sessions/`, and `getLatestRun()` must never guess.
 *
 * The regression locked down here: `loadAllSessionsFromDisk()` used to
 * `readdirSync` the whole `~/.openclaw/forensic-sessions/` directory on the
 * first touch after every gateway start and `JSON.parse` every file — 0.97 GB
 * across 3,269 files, of which only MAX_SESSIONS = 20 survived eviction.
 * Measured cold-start blocking on four separate gateway starts: 11,658 /
 * 11,172 / 11,132 / 14,612 ms in a single tick (warm figure the same day:
 * 309 ms).
 *
 * HONESTY: adversarial verification REFUTED this as the cause of the 12:39 tab
 * freeze — it fires once per process and had already fired 3h20m earlier. It is
 * gated here because it independently violates R4, not because it caused that
 * incident.
 *
 * Test target: src/forensic/dump-writer.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type DumpWriter = typeof import("./dump-writer.js");

let stateDir = "";
let previousStateDir: string | undefined;

function sessionDir(): string {
  return path.join(stateDir, "forensic-sessions");
}

function writeSessionFile(sk: string, runId: string, dumpCount = 1): string {
  fs.mkdirSync(sessionDir(), { recursive: true });
  const run = {
    runId,
    startedAt: "2026-08-28T00:00:00.000Z",
    _currentRunStart: 0,
    dumps: Array.from({ length: dumpCount }, (_unused, i) => ({
      meta: {
        timestamp: "2026-08-28T00:00:00.000Z",
        runId,
        sessionKey: sk,
        model: "test-model",
        provider: "test-provider",
        modelApi: "messages",
      },
      marker: `${sk}#${String(i)}`,
    })),
  };
  const filePath = path.join(sessionDir(), `forensic-${sk}.json`);
  fs.writeFileSync(filePath, JSON.stringify(run), "utf-8");
  return filePath;
}

function makeInput(sk: string, runId: string) {
  return {
    runId,
    sessionKey: sk,
    model: "test-model",
    provider: "test-provider",
    modelApi: "messages",
    systemPrompt: "system",
    messages: [],
    tools: [],
    effectivePrompt: "hello",
  };
}

/**
 * Fresh module instance per test: `sessionRuns` / `sessionAccessOrder` are
 * module-level state, and `STATE_DIR` is captured by `config/paths.js` at import
 * time — so the env override only lands if the whole chain is re-evaluated.
 */
async function loadColdModule(): Promise<DumpWriter> {
  vi.resetModules();
  return await import("./dump-writer.js");
}

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "forensic-lazy-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  if (stateDir) {
    fs.rmSync(stateDir, { recursive: true, force: true });
    stateDir = "";
  }
  vi.resetModules();
});

describe("forensic dump-writer — lazy single-key disk access (R4)", () => {
  it("never enumerates forensic-sessions/ on a cold first touch", async () => {
    for (let i = 0; i < 5; i++) {
      writeSessionFile(`decoy-${String(i)}`, `run-decoy-${String(i)}`);
    }
    writeSessionFile("session-a", "run-a");

    const mod = await loadColdModule();

    // Call-through spy: the real implementation still runs, we only record calls.
    // Nothing before the `scanned` assertion may fail on the OLD code — otherwise the
    // control run aborts early and this test never actually gates the directory scan.
    const readdirSpy = vi.spyOn(fs, "readdirSync");
    try {
      expect(mod.getRunForSession("session-a")?.runId).toBe("run-a");
      expect(mod.getRunForSession("never-seen")).toBeNull();
      await mod.captureForensicDump(makeInput("session-b", "run-b"));

      const scanned = readdirSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((target) => target.includes("forensic-sessions"));
      expect(scanned).toEqual([]);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it("getRunForSession still resolves a run that exists only on disk", async () => {
    writeSessionFile("session-a", "run-a", 2);

    const mod = await loadColdModule();

    const run = mod.getRunForSession("session-a");
    expect(run).not.toBeNull();
    expect(run?.runId).toBe("run-a");
    expect(run?.dumps).toHaveLength(2);
    expect(mod.getDumpForSession("session-a")?.marker).toBe("session-a#1");
    expect(mod.getDumpByIndexForSession("session-a", 0)?.marker).toBe("session-a#0");
  });

  it("getLatestRun returns null on a cold empty LRU instead of guessing from mtime", async () => {
    writeSessionFile("session-old", "run-old");
    const newestFile = writeSessionFile("session-new", "run-new");
    // Make `session-new` unambiguously the newest file on disk: an mtime-ordered
    // implementation would return it. The correct answer on a cold LRU is still null,
    // because "latest" means "most recently touched IN THIS PROCESS".
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(newestFile, future, future);

    const mod = await loadColdModule();

    expect(mod.getLatestRun()).toBeNull();
    expect(mod.getLatestDump()).toBeNull();
    expect(mod.getLatestResponses()).toBeNull();
    expect(mod.getDumpByIndex(0)).toBeNull();

    // Once THIS process has touched a session, "latest" is that session — never the
    // newest file on disk.
    expect(mod.getRunForSession("session-old")?.runId).toBe("run-old");
    expect(mod.getLatestRun()?.runId).toBe("run-old");
  });

  it("appends to a disk-only run instead of clobbering it", async () => {
    writeSessionFile("session-a", "run-a", 3);

    const mod = await loadColdModule();
    await mod.captureForensicDump(makeInput("session-a", "run-a"));

    expect(mod.getRunForSession("session-a")?.dumps).toHaveLength(4);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(sessionDir(), "forensic-session-a.json"), "utf-8"),
    ) as { dumps: unknown[] };
    expect(persisted.dumps).toHaveLength(4);
  });
});
