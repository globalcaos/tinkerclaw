/**
 * FORK 2026-05-11 — cron probes for the J15 RSC discipline.
 *
 *   cron.lastRun({jobId}) — returns the last receipt for a cron job from
 *                           `~/.openclaw/cron/runs/<jobId>.jsonl`, parsed
 *                           as JSON. Plus the size + mtime of the file
 *                           and the most-recent N lines.
 *
 *   cron.listJobs()       — returns the registry from
 *                           `~/.openclaw/cron/jobs.json` plus the freshness
 *                           of each job's last receipt.
 *
 * Scope: READ_SCOPE. Files are user-owned, no credentials inside receipts.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GatewayRequestHandlers } from "./types.js";

function isSafeJobId(jobId: string): boolean {
  // ASCII alnum + dash/underscore only, max 80 chars
  return jobId.length > 0 && jobId.length <= 80 && /^[A-Za-z0-9_-]+$/.test(jobId);
}

async function tailJsonl(
  filePath: string,
  n: number,
): Promise<{ totalLines: number; last: Record<string, unknown>[] }> {
  let text = "";
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return { totalLines: 0, last: [] };
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const tail = lines.slice(-n);
  const last: Record<string, unknown>[] = [];
  for (const line of tail) {
    try {
      last.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // skip
    }
  }
  return { totalLines: lines.length, last };
}

export const cronProbesHandlers: GatewayRequestHandlers = {
  "cron.lastRun": async ({ params, respond }) => {
    const p = (params ?? {}) as { jobId?: unknown; n?: unknown };
    const jobId = typeof p.jobId === "string" ? p.jobId.trim() : "";
    const n = typeof p.n === "number" && p.n > 0 ? Math.min(Math.floor(p.n), 20) : 1;
    if (!isSafeJobId(jobId)) {
      respond(true, { error: "invalid jobId" }, undefined);
      return;
    }
    const home = os.homedir();
    const receiptPath = path.resolve(home, ".openclaw/cron/runs", `${jobId}.jsonl`);
    let stat: { size: number; mtimeIso: string } | null = null;
    try {
      const s = await fs.stat(receiptPath);
      stat = { size: s.size, mtimeIso: s.mtime.toISOString() };
    } catch {
      // missing — return null stat + empty receipts
    }
    const { totalLines, last } = await tailJsonl(receiptPath, n);
    respond(
      true,
      {
        jobId,
        receiptPath,
        stat,
        totalReceipts: totalLines,
        recent: last,
      },
      undefined,
    );
  },

  "cron.listJobs": async ({ respond }) => {
    const home = os.homedir();
    const jobsPath = path.resolve(home, ".openclaw/cron/jobs.json");
    let raw = "";
    try {
      raw = await fs.readFile(jobsPath, "utf8");
    } catch (err: unknown) {
      respond(true, { error: `read failed: ${String(err)}`, jobsPath }, undefined);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err: unknown) {
      respond(true, { error: `parse failed: ${String(err)}`, jobsPath }, undefined);
      return;
    }
    // Add freshness info for each job
    const data = parsed as { jobs?: Array<Record<string, unknown>> };
    const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
    const enrichedJobs: Array<Record<string, unknown>> = [];
    for (const job of jobs) {
      const jobId = typeof job.id === "string" ? job.id : "";
      let lastReceiptMtimeIso: string | null = null;
      let lastReceiptAgeSec: number | null = null;
      if (jobId && isSafeJobId(jobId)) {
        const receiptPath = path.resolve(home, ".openclaw/cron/runs", `${jobId}.jsonl`);
        try {
          const s = await fs.stat(receiptPath);
          lastReceiptMtimeIso = s.mtime.toISOString();
          lastReceiptAgeSec = Math.floor((Date.now() - s.mtimeMs) / 1000);
        } catch {
          // no receipt yet
        }
      }
      enrichedJobs.push({ ...job, lastReceiptMtimeIso, lastReceiptAgeSec });
    }
    respond(
      true,
      {
        jobsPath,
        jobCount: enrichedJobs.length,
        jobs: enrichedJobs,
      },
      undefined,
    );
  },
};
