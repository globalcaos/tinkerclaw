import { rmSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendInterruptedRun,
  type InterruptedRunRecord,
  resolveInterruptedRunLedgerPath,
} from "./interrupted-run-ledger.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-interrupted-runs-"));
  cleanupDirs.push(root);
  return root;
}

const baseRecord: InterruptedRunRecord = {
  ts: 1722400000000,
  sessionKey: "agent:main:main",
  action: "detected",
  detector: "boot-pending-toolcall-scan",
};

describe("resolveInterruptedRunLedgerPath", () => {
  it("resolves under <stateDir>/data/interrupted-runs.jsonl", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: stateDir };
    expect(resolveInterruptedRunLedgerPath(env)).toBe(
      path.join(stateDir, "data", "interrupted-runs.jsonl"),
    );
  });
});

describe("appendInterruptedRun", () => {
  it("appends one parseable JSONL line per call, in order", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: stateDir };
    await appendInterruptedRun({ ...baseRecord, runId: "run-1" }, env);
    await appendInterruptedRun(
      { ...baseRecord, ts: baseRecord.ts + 1, action: "resumed", runId: "run-2" },
      env,
    );
    const raw = await readFile(resolveInterruptedRunLedgerPath(env), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const lines = raw.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    const parsed = lines.map((line) => JSON.parse(line) as InterruptedRunRecord);
    expect(parsed[0]?.runId).toBe("run-1");
    expect(parsed[0]?.action).toBe("detected");
    expect(parsed[1]?.runId).toBe("run-2");
    expect(parsed[1]?.action).toBe("resumed");
  });

  it("omits undefined optional fields from the written line", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: stateDir };
    await appendInterruptedRun(
      { ...baseRecord, toolName: "exec", runId: undefined, provider: undefined },
      env,
    );
    const raw = await readFile(resolveInterruptedRunLedgerPath(env), "utf8");
    const line = raw.split("\n").filter((l) => l.length > 0)[0] ?? "";
    expect(line).not.toContain('"runId"');
    expect(line).not.toContain('"provider"');
    expect(line).not.toContain('"sessionId"');
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect([...Object.keys(parsed)].sort()).toEqual(
      ["action", "detector", "sessionKey", "toolName", "ts"].sort(),
    );
    expect(parsed.toolName).toBe("exec");
  });

  it("creates missing parent directories (mkdir -p behaviour)", async () => {
    const root = await makeTempRoot();
    // Neither <root>/deep/state nor its data/ subdir exist yet.
    const stateDir = path.join(root, "deep", "state");
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: stateDir };
    await appendInterruptedRun(baseRecord, env);
    const raw = await readFile(path.join(stateDir, "data", "interrupted-runs.jsonl"), "utf8");
    expect(JSON.parse(raw.trim())).toMatchObject({ sessionKey: baseRecord.sessionKey });
  });

  it("never throws when the ledger target is unwritable", async () => {
    const root = await makeTempRoot();
    // A FILE occupies the state-dir slot, so mkdir(.../data) fails with ENOTDIR.
    const blocker = path.join(root, "state");
    await writeFile(blocker, "not a directory", "utf8");
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: blocker };
    await expect(
      appendInterruptedRun({ ...baseRecord, action: "resume-failed" }, env),
    ).resolves.toBeUndefined();
  });
});
