/**
 * J3 `j.fractal.run` — TINKER_UI_DESIGN_BIBLE/logging.md §4.12 (§9 step 9): ONE row per runTriage
 * call, labelled success | docked | failed, with the whole call's duration.
 *
 * CONTROL: before this change runTriage writes nothing, so every expectation that a row exists
 * fails on zero emitEvent calls.
 *
 * The harness mirrors fractal-run.test.ts (a temp extension dir holding triage-prompt.md, a fake
 * subagent surface); `emitEvent` is mocked at the plugin-sdk subpath, so the assertions are about
 * the producer's CALL — exactly one per run, on every exit — and nothing downstream of it.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTriagePromptCache, runTriage } from "./fractal-run.js";
import type { FractalConfig } from "./types.js";

type EmittedRow = { name: string; record: Record<string, unknown> };

const emitted = vi.hoisted(() => ({ rows: [] as EmittedRow[] }));

vi.mock("openclaw/plugin-sdk/fork-telemetry", () => ({
  emitEvent: (name: string, record: Record<string, unknown> = {}) => {
    emitted.rows.push({ name, record });
  },
}));

const rows = (): EmittedRow[] => emitted.rows.filter((r) => r.name === "j.fractal.run");

let extDir: string;
let emptyExtDir: string;

beforeAll(async () => {
  extDir = await fs.mkdtemp(path.join(os.tmpdir(), "fractal-j3-ext-"));
  await fs.writeFile(path.join(extDir, "triage-prompt.md"), "# TRIAGE\nOne fenced json block.");
  emptyExtDir = await fs.mkdtemp(path.join(os.tmpdir(), "fractal-j3-empty-"));
});

afterAll(async () => {
  await fs.rm(extDir, { recursive: true, force: true });
  await fs.rm(emptyExtDir, { recursive: true, force: true });
});

beforeEach(() => {
  emitted.rows.length = 0;
  clearTriagePromptCache();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeSubagent(replyText: string, status = "ok") {
  return {
    run: vi.fn(async () => ({ runId: "triage-run-1" })),
    waitForRun: vi.fn(async () => ({ status })),
    getSessionMessages: vi.fn(async () => ({
      messages: replyText ? [{ role: "assistant", content: replyText }] : [],
    })),
  };
}

function makeDeps(subagent: ReturnType<typeof makeSubagent>, rootDir = extDir) {
  return {
    api: { rootDir, runtime: { subagent } },
    cfg: {} as FractalConfig,
    ledger: { recurrenceCount: vi.fn(() => 0) },
    log: { info: vi.fn(), warn: vi.fn() },
  };
}

function makeInput(parentRunId: string) {
  return {
    parentRunId,
    sessionKey: "agent:main:main",
    messages: [
      { role: "user", content: "a question" },
      { role: "assistant", content: "an answer" },
    ],
    onPending: vi.fn(),
  };
}

const CLEAN = '```json\n{"verdict":"clean","headline":"ok","findings":[]}\n```';

describe("J3 j.fractal.run", () => {
  it("a parsed verdict is success — one row, with the parent run and the whole call's duration", async () => {
    const row = await runTriage(makeDeps(makeSubagent(CLEAN)), makeInput("parent-ok"));
    expect(row.status).toBe("clean");
    expect(rows()).toHaveLength(1);
    expect(rows()[0].record).toMatchObject({
      label: "success",
      runId: "parent-ok",
      sessionKey: "agent:main:main",
    });
    expect(typeof rows()[0].record.durMs).toBe("number");
  });

  it("a reply the grammar rejects DOCKED: it arrived and produced nothing usable", async () => {
    const row = await runTriage(
      makeDeps(makeSubagent("no json block here at all")),
      makeInput("parent-bad-json"),
    );
    expect(row.status).toBe("error");
    expect(rows().map((r) => r.record.label)).toEqual(["docked"]);
  });

  it("a run whose transcript never yields reply text also DOCKED", async () => {
    vi.useFakeTimers();
    const pending = runTriage(makeDeps(makeSubagent("")), makeInput("parent-empty"));
    await vi.runAllTimersAsync();
    const row = await pending;
    expect(row.status).toBe("error");
    expect(rows().map((r) => r.record.label)).toEqual(["docked"]);
  });

  it("a run that ended non-ok FAILED: it never got there", async () => {
    await runTriage(makeDeps(makeSubagent(CLEAN, "error")), makeInput("parent-run-error"));
    expect(rows().map((r) => r.record.label)).toEqual(["failed"]);
  });

  it("a failure before any spawn still writes its row (missing triage prompt)", async () => {
    const subagent = makeSubagent(CLEAN);
    await runTriage(makeDeps(subagent, emptyExtDir), makeInput("parent-no-prompt"));
    expect(subagent.run).not.toHaveBeenCalled();
    expect(rows().map((r) => r.record.label)).toEqual(["failed"]);
  });
});
