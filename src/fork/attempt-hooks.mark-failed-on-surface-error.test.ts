import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSessionStore, type SessionEntry } from "../config/sessions.js";
import { markFailedOnSurfaceError } from "./attempt-hooks.js";

/**
 * FORK 2026-07-30 (the architect: "Grok is firing without stop. I stop its thinking
 * indicator and it starts again").
 *
 * A `stage:"assistant"` surface_error (live: xai/grok-4.5, runId 755f5fd8) left
 * `sessions.json` at `status:"running"` with no `endedAt`. tinker-ui's
 * `run-state.ts` resolves "server-running" from exactly that shape on every
 * `sessions.list` poll, so the thinking indicator re-lit the instant the user
 * stopped it — until the next gateway boot swept it. The reply runner now calls
 * this hook at its terminal "failed before reply" funnel with the store it
 * already owns. These tests pin the on-disk contract the UI reads.
 *
 * See TINKER_UI_DESIGN_BIBLE/failures.md M10.
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mark-failed-surface-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeStore(store: Record<string, SessionEntry>): Promise<string> {
  const storePath = path.join(tmpDir, "sessions.json");
  await fs.writeFile(storePath, JSON.stringify(store, null, 2));
  return storePath;
}

const RUNNING_ENTRY: SessionEntry = {
  sessionId: "44a711d7-acb0-4b4a-8b8c-26776b31dcfc",
  updatedAt: 1_785_438_999_670,
  startedAt: 1_785_438_998_191,
  status: "running",
};

describe("markFailedOnSurfaceError", () => {
  it("transitions a running session to a TERMINAL status the Tinker UI stops on", async () => {
    const storePath = await writeStore({ "agent:main:tinker:ms39dshj": { ...RUNNING_ENTRY } });

    await markFailedOnSurfaceError({
      sessionKey: "agent:main:tinker:ms39dshj",
      reason: "LLM request timed out.",
      storePath,
    });

    const entry = loadSessionStore(storePath)["agent:main:tinker:ms39dshj"];
    // tinker-ui/src/run-state.ts: TERMINAL = new Set(["done","failed","killed","timeout"]).
    // Anything outside that set re-lights the indicator on the next poll.
    expect(entry?.status).toBe("failed");
    expect(entry?.abortedLastRun).toBe(true);
    // run-state.ts also needs an end stamp to veto a stale "running" snapshot.
    expect(typeof entry?.endedAt).toBe("number");
    expect(entry?.endedAt).toBeGreaterThan(0);
  });

  it("records a provider failure WITHOUT the user-abort flag when asked", async () => {
    // body.ts turns abortedLastRun into a prompt prefix on the NEXT turn:
    // "The previous agent run was aborted by the user. Resume carefully or ask
    // for clarification." A Grok timeout is not a user abort — the reply runner
    // passes false so the following turn is not derailed by a false premise.
    const storePath = await writeStore({ "agent:main:tinker:ms39dshj": { ...RUNNING_ENTRY } });

    await markFailedOnSurfaceError({
      sessionKey: "agent:main:tinker:ms39dshj",
      reason: "LLM request timed out.",
      storePath,
      abortedLastRun: false,
    });

    const entry = loadSessionStore(storePath)["agent:main:tinker:ms39dshj"];
    // Still terminal — the UI stops — but not mislabelled as a user abort.
    expect(entry?.status).toBe("failed");
    expect(entry?.abortedLastRun).toBe(false);
    expect(typeof entry?.endedAt).toBe("number");
  });

  it("marks only the named session and leaves other sessions in the store untouched", async () => {
    const storePath = await writeStore({
      "agent:main:tinker:ms39dshj": { ...RUNNING_ENTRY },
      "agent:main:dashboard:other": { ...RUNNING_ENTRY, sessionId: "other-session" },
    });

    await markFailedOnSurfaceError({
      sessionKey: "agent:main:tinker:ms39dshj",
      reason: "LLM request timed out.",
      storePath,
    });

    const store = loadSessionStore(storePath);
    expect(store["agent:main:tinker:ms39dshj"]?.status).toBe("failed");
    expect(store["agent:main:dashboard:other"]?.status).toBe("running");
  });

  it("no-ops on a session that already reached a terminal status", async () => {
    const storePath = await writeStore({
      "agent:main:tinker:ms39dshj": {
        ...RUNNING_ENTRY,
        status: "done",
        endedAt: 1_785_000_000_000,
      },
    });

    await markFailedOnSurfaceError({
      sessionKey: "agent:main:tinker:ms39dshj",
      reason: "LLM request timed out.",
      storePath,
    });

    const entry = loadSessionStore(storePath)["agent:main:tinker:ms39dshj"];
    expect(entry?.status).toBe("done");
    expect(entry?.endedAt).toBe(1_785_000_000_000);
  });

  it("is best-effort: an unwritable store never throws back at the caller", async () => {
    // The caller is mid-throw on the original run failure. A session-store I/O
    // error must never mask it.
    await expect(
      markFailedOnSurfaceError({
        sessionKey: "agent:main:tinker:ms39dshj",
        reason: "LLM request timed out.",
        storePath: path.join(tmpDir, "no", "such", "dir", "sessions.json"),
      }),
    ).resolves.toBeUndefined();
  });

  it("does nothing without a sessionKey", async () => {
    const storePath = await writeStore({ "agent:main:tinker:ms39dshj": { ...RUNNING_ENTRY } });

    await markFailedOnSurfaceError({
      sessionKey: undefined,
      reason: "LLM request timed out.",
      storePath,
    });

    expect(loadSessionStore(storePath)["agent:main:tinker:ms39dshj"]?.status).toBe("running");
  });
});
