import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type InterruptedRunAction = "detected" | "resumed" | "resume-failed";

export type InterruptedRunRecord = {
  ts: number;
  sessionKey: string;
  action: InterruptedRunAction;
  detector: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  toolName?: string;
  toolStartedAt?: number;
  provider?: string;
  model?: string;
};

/**
 * Durable, append-only JSONL ledger of runs that were interrupted mid-flight
 * (e.g. the gateway restarted and SIGTERM'd an agent while a tool call was in
 * flight). One JSON object per line; records are only ever appended.
 */
export function resolveInterruptedRunLedgerPath(env?: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "data", "interrupted-runs.jsonl");
}

export async function appendInterruptedRun(
  record: InterruptedRunRecord,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  // This is diagnostics that runs during gateway boot recovery: it must NEVER
  // throw, because a ledger write failure must not be able to break recovery.
  // Any error (bad path, unwritable dir, full disk, ...) is swallowed.
  try {
    const filePath = resolveInterruptedRunLedgerPath(env);
    // Build the serialized object by spreading only defined keys so undefined
    // optional fields are omitted from the line entirely.
    const line: InterruptedRunRecord = {
      ts: record.ts,
      sessionKey: record.sessionKey,
      action: record.action,
      detector: record.detector,
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
      ...(record.runId !== undefined ? { runId: record.runId } : {}),
      ...(record.toolCallId !== undefined ? { toolCallId: record.toolCallId } : {}),
      ...(record.toolName !== undefined ? { toolName: record.toolName } : {}),
      ...(record.toolStartedAt !== undefined ? { toolStartedAt: record.toolStartedAt } : {}),
      ...(record.provider !== undefined ? { provider: record.provider } : {}),
      ...(record.model !== undefined ? { model: record.model } : {}),
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    // Swallowed on purpose — see the comment above.
  }
}
