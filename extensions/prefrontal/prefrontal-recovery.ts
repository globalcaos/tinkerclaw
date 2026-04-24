// extensions/prefrontal/prefrontal-recovery.ts
// FORK: Prefrontal crash recovery — write/read recovery state for guardian relaunch.

import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";
import type { PrefrontalRecoveryState, PrefrontalTreeResponse } from "./prefrontal-types.js";

const RECOVERY_PATH = "/tmp/prefrontal/recovery.json";

export function writeRecoveryState(
  prefrontalSessionKey: string,
  tree: PrefrontalTreeResponse,
  originalPrompt: string,
): void {
  const dir = dirname(RECOVERY_PATH);
  if (!existsSync(dir)) {mkdirSync(dir, { recursive: true });}

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

  const tmpPath = `${RECOVERY_PATH}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  renameSync(tmpPath, RECOVERY_PATH);
}

export function readRecoveryState(): PrefrontalRecoveryState | null {
  if (!existsSync(RECOVERY_PATH)) {return null;}
  try {
    const raw = readFileSync(RECOVERY_PATH, "utf-8");
    return JSON.parse(raw) as PrefrontalRecoveryState;
  } catch {
    return null;
  }
}

export function clearRecoveryState(): void {
  if (existsSync(RECOVERY_PATH)) {
    unlinkSync(RECOVERY_PATH);
  }
}
