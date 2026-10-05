/**
 * Import model calls already on disk (agent trajectory files) into the LLM ledger.
 *
 *   node --import tsx scripts/llm-ledger-backfill.ts [--state-dir ~/.openclaw] [--db <file>]
 *        [--driver <id>] [--dry-run]
 *
 * --driver stamps every imported row with that driver (driver_source "backfill:assigned"), for
 * history recorded before seats were attributed. Without it each row resolves normally (cron,
 * channel peer, OPENCLAW_LLM_LEDGER_DEFAULT_DRIVER, else "unknown").
 *
 * Idempotent: call ids are derived from the trajectory event, so a re-run inserts nothing twice.
 * Pairing: `seq` restarts and `runId` repeats inside one trace, so prompts queue FIFO per runId
 * and completions dedupe on (traceId, ts, runId). Keying on seq silently drops most calls.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  insertLedgerRow,
  openLedger,
  resolveDriver,
  type LedgerRow,
} from "../src/forensic/llm-ledger.js";

type TrajEvent = {
  type?: string;
  traceId?: string;
  ts?: string;
  seq?: number;
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string;
  data?: Record<string, any>;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const stateDir = (arg("state-dir") ?? path.join(os.homedir(), ".openclaw")).replace(
  /^~/,
  os.homedir(),
);
const dbFile = arg("db") ?? path.join(stateDir, "forensic", "llm-ledger.sqlite");
const assigned = arg("driver");
const dryRun = process.argv.includes("--dry-run");

const agentsDir = path.join(stateDir, "agents");
const files = fs.existsSync(agentsDir)
  ? fs
      .readdirSync(agentsDir)
      .flatMap((agent) => {
        const dir = path.join(agentsDir, agent, "sessions");
        return fs.existsSync(dir)
          ? fs
              .readdirSync(dir)
              .filter((f) => f.includes(".trajectory.jsonl"))
              .map((f) => ({ agent, file: path.join(dir, f) }))
          : [];
      })
      .sort((a, b) => a.file.localeCompare(b.file))
  : [];

const rows: LedgerRow[] = [];
const seen = new Set<string>();
for (const { agent, file } of files) {
  const started = new Map<string, Record<string, any>>();
  const pending = new Map<string, TrajEvent[]>();
  const base = (ev: TrajEvent, prompt: TrajEvent | undefined) => ({
    source: "backfill:trajectory",
    runId: ev.runId,
    sessionKey: ev.sessionKey,
    sessionId: ev.sessionId,
    agentId: agent,
    trigger: started.get(ev.runId ?? "")?.trigger,
    provider: ev.provider,
    model: ev.modelId,
    api: ev.modelApi,
    startedAt: prompt?.ts ?? ev.ts ?? new Date(0).toISOString(),
  });
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: TrajEvent;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const run = ev.runId ?? "";
    if (ev.type === "session.started") started.set(run, ev.data ?? {});
    else if (ev.type === "prompt.submitted") pending.set(run, [...(pending.get(run) ?? []), ev]);
    else if (ev.type === "model.completed") {
      const id = `traj:${ev.traceId}:${ev.ts}:${run}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const prompt = pending.get(run)?.shift();
      const d = ev.data ?? {};
      const b = base(ev, prompt);
      rows.push({
        ...b,
        callId: id,
        endedAt: ev.ts,
        durationMs: prompt?.ts && ev.ts ? Date.parse(ev.ts) - Date.parse(prompt.ts) : null,
        outcome: d.aborted ? "aborted" : d.timedOut || d.promptErrorSource ? "error" : "ok",
        error: d.promptErrorSource ?? null,
        usage: d.usage ?? null,
        request: {
          systemPrompt: prompt?.data?.systemPrompt ?? null,
          prompt: prompt?.data?.prompt ?? d.finalPromptText ?? null,
          messages: d.messagesSnapshot ?? prompt?.data?.messages ?? [],
        },
        response: { assistantTexts: d.assistantTexts ?? [] },
      });
    }
  }
  for (const [run, queue] of pending) {
    for (const prompt of queue) {
      rows.push({
        ...base(prompt, prompt),
        callId: `traj:${prompt.traceId}:${prompt.ts}:${run}:unanswered`,
        outcome: "error",
        error: "no model.completed recorded",
        request: {
          systemPrompt: prompt.data?.systemPrompt ?? null,
          prompt: prompt.data?.prompt ?? null,
          messages: prompt.data?.messages ?? [],
        },
        response: null,
      });
    }
  }
}

const driverCounts = new Map<string, number>();
const db = dryRun ? null : openLedger(dbFile);
// Calls the live ledger already recorded are also in trajectory files, under different ids.
// Import only what happened before the first live row, so nothing is counted twice.
const liveSince = db
  ? (
      db
        .prepare("SELECT MIN(started_at) AS t FROM calls WHERE source NOT LIKE 'backfill:%'")
        .get() as { t: string | null }
    ).t
  : null;
const importable = liveSince ? rows.filter((r) => r.startedAt < liveSince) : rows;
const before = db ? (db.prepare("SELECT COUNT(*) AS n FROM calls").get() as { n: number }).n : 0;
if (db) db.exec("BEGIN");
for (const row of importable) {
  const driver = assigned ? { id: assigned, source: "backfill:assigned" } : resolveDriver(row, db);
  driverCounts.set(
    `${driver.id} (${driver.source})`,
    (driverCounts.get(`${driver.id} (${driver.source})`) ?? 0) + 1,
  );
  if (db) insertLedgerRow(db, { ...row, driver });
}
if (db) db.exec("COMMIT");
const after = db ? (db.prepare("SELECT COUNT(*) AS n FROM calls").get() as { n: number }).n : 0;
db?.close();

console.log(
  JSON.stringify(
    {
      stateDir,
      db: dryRun ? null : dbFile,
      trajectoryFiles: files.length,
      callsFound: rows.length,
      liveLedgerSince: liveSince,
      skippedAsAlreadyLive: rows.length - importable.length,
      unanswered: rows.filter((r) => r.response === null).length,
      inserted: after - before,
      drivers: Object.fromEntries(driverCounts),
    },
    null,
    2,
  ),
);
