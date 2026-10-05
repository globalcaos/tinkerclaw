// extensions/prefrontal/prefrontal-recovery.ts
// FORK: Prefrontal crash recovery — write/read recovery state for guardian relaunch.
//
// The file lives under the operator's own OpenClaw state directory, not a shared
// /tmp path, so another local user cannot plant a recovery file that the gateway
// would load on startup. It is written owner-only (dir 0700, file 0600).

import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import type { PrefrontalRecoveryState, PrefrontalTreeResponse } from "./prefrontal-types.js";

export function recoveryPath(): string {
  return join(
    process.env.OPENCLAW_HOME ?? join(os.homedir(), ".openclaw"),
    "workspace",
    "state",
    "prefrontal",
    "recovery.json",
  );
}

export function writeRecoveryState(
  prefrontalSessionKey: string,
  tree: PrefrontalTreeResponse,
  originalPrompt: string,
): void {
  const file = recoveryPath();
  const dir = dirname(file);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const state: PrefrontalRecoveryState = {
    timestamp: new Date().toISOString(),
    prefrontalSessionKey,
    activeSubagents: (tree.root?.children ?? [])
      .filter((c) => c.status !== "completed" && c.status !== "failed")
      .map((c) => ({
        runId: c.runId,
        childSessionKey: "",
        task: c.label,
        model: c.model,
        status: c.status === "stalled" ? "stalled" : "running",
      })),
    pendingTasks: [],
    originalPrompt,
  };

  const tmpPath = `${file}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmpPath, file);
}

export function readRecoveryState(): PrefrontalRecoveryState | null {
  const file = recoveryPath();
  if (!existsSync(file)) {
    return null;
  }
  try {
    const raw = readFileSync(file, "utf-8");
    return JSON.parse(raw) as PrefrontalRecoveryState;
  } catch {
    return null;
  }
}

export function clearRecoveryState(): void {
  const file = recoveryPath();
  if (existsSync(file)) {
    unlinkSync(file);
  }
}
