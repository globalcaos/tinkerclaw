/**
 * FORK: tinkerclaw-cron-panel — read-only cron registry + report readers.
 *
 * Data sources (never written to):
 *   - ~/.openclaw/cron/jobs.json        — the cron registry (id, name,
 *     schedule, enabled). Every job here automatically appears in the panel;
 *     there is no registration step.
 *   - ~/.openclaw/cron/jobs-state.json  — runtime state per job (lastRunAtMs,
 *     lastRunStatus, nextRunAtMs, consecutiveErrors).
 *   - ~/.openclaw/cron/reports/<YYYY-MM-DD>/<job-id>.md — per-run reports per
 *     ~/.openclaw/workspace/CRON_REPORT_CONTRACT.md: tiny YAML header (job,
 *     ran, status, headline) + delta-only bullets.
 *
 * A job with no report file EVER is `silent: true` — surfacing contract
 * violations (a cron that runs but never reports) is the point of the panel.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveUserPath } from "openclaw/plugin-sdk/text-runtime";

export type CronPanelPluginConfig = {
  cronDir?: string;
};

export type CronPanelResolvedConfig = {
  cronDir: string;
  jobsPath: string;
  statePath: string;
  reportsDir: string;
};

export function resolveCronPanelConfig(cfg: CronPanelPluginConfig): CronPanelResolvedConfig {
  const cronDir = cfg.cronDir ? resolveUserPath(cfg.cronDir) : resolveUserPath("~/.openclaw/cron");
  return {
    cronDir,
    jobsPath: path.join(cronDir, "jobs.json"),
    statePath: path.join(cronDir, "jobs-state.json"),
    reportsDir: path.join(cronDir, "reports"),
  };
}

export type CronJobEntry = {
  id: string;
  name: string;
  description?: string;
  /** Path to the markdown that defines the job — hover/open-card destination. */
  briefPath?: string;
  enabled: boolean;
  schedule: { kind?: string; expr?: string; tz?: string };
};

const CONTRACT_PATH = /CRON[_-]REPORT[_-]CONTRACT/i;
const PAYLOAD_PATH = /(?:~|\/home\/[\w.-]+)(?:\/[\w.@%+,-]+)+\.(?:md|txt)/g;

/** The file that *defines* the job, not the report contract it must also write. */
export function extractBriefPath(payloadText: string): string | undefined {
  const found = payloadText.match(PAYLOAD_PATH) ?? [];
  const usable = found.filter((p) => !CONTRACT_PATH.test(p));
  return (
    usable.find((p) => /\/cron-payloads\//.test(p)) ??
    usable.find((p) => /\/skills\//.test(p)) ??
    usable[0]
  );
}

function existingBriefPath(candidates: Array<string | undefined>): string | undefined {
  for (const p of candidates) {
    if (!p) continue;
    try {
      if (fs.existsSync(resolveUserPath(p))) return p;
    } catch {
      /* resolveUserPath throws on junk; skip */
    }
  }
  return undefined;
}

export type CronJobState = {
  lastRunAtMs?: number;
  lastRunStatus?: string;
  nextRunAtMs?: number;
  consecutiveErrors?: number;
  lastError?: string;
};

export type CronReport = {
  date: string; // YYYY-MM-DD folder the report was found in
  ran?: string;
  status?: string;
  headline?: string;
  deltas: string[];
};

export function readJobs(cfg: CronPanelResolvedConfig): CronJobEntry[] {
  if (!fs.existsSync(cfg.jobsPath)) return [];
  const raw = JSON.parse(fs.readFileSync(cfg.jobsPath, "utf8")) as unknown;
  const arr = Array.isArray(raw) ? raw : ((raw as { jobs?: unknown[] })?.jobs ?? []);
  const jobs: CronJobEntry[] = [];
  for (const j of arr as Array<Record<string, unknown>>) {
    if (!j || typeof j.id !== "string") continue;
    const payload =
      j.payload && typeof j.payload === "object"
        ? (j.payload as { text?: unknown; message?: unknown })
        : undefined;
    const payloadText =
      typeof payload?.text === "string"
        ? payload.text
        : typeof payload?.message === "string"
          ? payload.message
          : "";
    jobs.push({
      id: j.id,
      name: typeof j.name === "string" ? j.name : j.id,
      description: typeof j.description === "string" ? j.description : undefined,
      briefPath: existingBriefPath([
        extractBriefPath(payloadText),
        `~/.openclaw/cron-payloads/${j.id}.md`,
      ]),
      enabled: j.enabled !== false,
      schedule:
        typeof j.schedule === "object" && j.schedule
          ? (j.schedule as CronJobEntry["schedule"])
          : {},
    });
  }
  return jobs;
}

export function readStates(cfg: CronPanelResolvedConfig): Record<string, CronJobState> {
  if (!fs.existsSync(cfg.statePath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(cfg.statePath, "utf8")) as {
      jobs?: Record<string, { state?: CronJobState }>;
    };
    const out: Record<string, CronJobState> = {};
    for (const [id, entry] of Object.entries(raw.jobs ?? {})) {
      if (entry?.state) out[id] = entry.state;
    }
    return out;
  } catch {
    return {};
  }
}

/** Parse one report file: YAML header between `---` fences + `- ` bullets. */
export function parseReport(md: string, date: string): CronReport {
  const report: CronReport = { date, deltas: [] };
  const lines = md.split("\n");
  let i = 0;
  if (lines[0]?.trim() === "---") {
    i = 1;
    for (; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.trim() === "---") {
        i++;
        break;
      }
      const m = /^(\w+):\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, key, value] = m;
      if (key === "ran") report.ran = value.trim();
      else if (key === "status") report.status = value.trim();
      else if (key === "headline") report.headline = value.trim();
    }
  }
  for (; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed.startsWith("- ")) {
      report.deltas.push(trimmed.slice(2).trim());
      continue;
    }
    // Indented continuation belongs to the previous bullet (title + body).
    // A flush-left line is a new block and is ignored — same as before.
    if (/^\s+\S/.test(raw) && report.deltas.length > 0) {
      const last = report.deltas.length - 1;
      report.deltas[last] = `${report.deltas[last]}\n${trimmed}`;
    }
  }
  return report;
}

/** Date folders in reports/, newest first. Tolerates a missing dir. */
function listReportDates(cfg: CronPanelResolvedConfig): string[] {
  if (!fs.existsSync(cfg.reportsDir)) return [];
  return fs
    .readdirSync(cfg.reportsDir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse();
}

/** All reports for one job, newest first, capped to `days` date folders. */
export function readReportsForJob(
  cfg: CronPanelResolvedConfig,
  jobId: string,
  days = 14,
): CronReport[] {
  const out: CronReport[] = [];
  for (const date of listReportDates(cfg).slice(0, days)) {
    const p = path.join(cfg.reportsDir, date, `${jobId}.md`);
    if (!fs.existsSync(p)) continue;
    try {
      out.push(parseReport(fs.readFileSync(p, "utf8"), date));
    } catch {
      /* unreadable report — skip, the job still shows via registry */
    }
  }
  return out;
}

/** Tiny humanizer for the common cron shapes; falls back to the raw expr. */
export function humanizeCronExpr(expr: string | undefined, tz?: string): string {
  if (!expr) return "—";
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const pad = (s: string) => s.padStart(2, "0");
  const tzSuffix = tz && tz !== "Europe/Madrid" ? ` (${tz})` : "";
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*") {
    const time = `${pad(hour)}:${pad(min)}`;
    if (dow === "*") return `${time} daily${tzSuffix}`;
    if (/^\d+$/.test(dow)) return `${time} ${DOW[Number(dow) % 7]}${tzSuffix}`;
    return `${time} on ${dow}${tzSuffix}`;
  }
  const stepMatch = /^\*\/(\d+)$/.exec(min);
  if (stepMatch && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `every ${stepMatch[1]} min`;
  }
  return expr;
}

export type CronPanelJobRow = {
  id: string;
  name: string;
  description?: string;
  briefPath?: string;
  enabled: boolean;
  schedule: { expr?: string; tz?: string };
  scheduleHuman: string;
  state: CronJobState;
  /** Latest report (any status), or null if the job never reported. */
  report: CronReport | null;
  /** True when no report file exists for this job on ANY date — the panel's
   * staleness/silence detector. */
  silent: boolean;
  /** Days since the newest report that carried ≥1 delta bullet; null when the
   * job has never produced a delta. */
  daysSinceLastDelta: number | null;
};

export function listJobsJoined(cfg: CronPanelResolvedConfig): CronPanelJobRow[] {
  const states = readStates(cfg);
  const todayMs = Date.now();
  return readJobs(cfg).map((job) => {
    const reports = readReportsForJob(cfg, job.id, 60);
    const latest = reports[0] ?? null;
    const lastWithDelta = reports.find((r) => r.deltas.length > 0);
    let daysSinceLastDelta: number | null = null;
    if (lastWithDelta) {
      const then = Date.parse(`${lastWithDelta.date}T00:00:00`);
      if (Number.isFinite(then)) {
        daysSinceLastDelta = Math.max(0, Math.floor((todayMs - then) / 86_400_000));
      }
    }
    return {
      id: job.id,
      name: job.name,
      description: job.description,
      briefPath: job.briefPath,
      enabled: job.enabled,
      schedule: { expr: job.schedule.expr, tz: job.schedule.tz },
      scheduleHuman: humanizeCronExpr(job.schedule.expr, job.schedule.tz),
      state: states[job.id] ?? {},
      report: latest,
      silent: reports.length === 0,
      daysSinceLastDelta,
    };
  });
}
