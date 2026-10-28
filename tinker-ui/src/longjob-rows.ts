// FORK 2026-10-25 (the architect: a running long job shows in the chat in the SAME place and SAME style as the
// thinking indicator, not as a card pasted into a reply). The rows reuse the `.thinking-run` markup
// (three dots, icon + name, elapsed) with no background of their own: the chat's brown shows through.
//
// Data: each job is the longjob worker's state.json (`~/.claude/skills/longjob/scripts/longjob.mjs`),
// listed for this chat by tinker-prod-ui `/api/longjob/list?session=…`. Three kinds:
//   agents     — one row per model of the agents still running, "<label> · k/n done";
//   process    — ⚙ + label, "2.6 / 4.2 GB · 18 MB/s · ETA 1m30s", and a 3px line for the percentage
//                when the total is known (no line, no invented percentage, when it is not);
//   background — (2026-10-25, the architect 02:43) a Claude Code background task of this chat's worker (Bash in
//                the background, Workflow, Task, Monitor), from the gateway's `ccBridge.backgroundTasks`:
//                ⚙ + its description and the elapsed time, nothing else (the CLI reports no progress).
// A stalled job (no reading change, or no state write at all) turns its row amber.

export type LongjobAgent = {
  label?: string;
  model?: string;
  effort?: string;
  status?: string;
};

export type LongjobJob = {
  id: string;
  label?: string;
  kind?: string;
  session?: string;
  status?: string;
  startedAt?: number;
  updatedAt?: number;
  intervalMs?: number;
  current?: number | null;
  total?: number | null;
  pct?: number | null;
  unit?: string;
  rate?: number | null;
  etaSeconds?: number | null;
  stalledSince?: number | null;
  agents?: LongjobAgent[];
};

export type LongjobRowDeps = {
  esc: (s: string) => string;
  modelIcon: (model: string, provider: string) => string;
  /** The thinking row's name for a model id (detailedModelLabel, then modelName). */
  modelLabel: (model: string) => string;
  /** The model's EEG glow colour, as the thinking row's dots use. */
  dotColor: (model: string, provider: string) => string;
  /** The wall-clock bounce phase (thinkingDotsPhase), so a repaint does not restart the dots. */
  phaseMs: number;
};

/** The kind the bridge gives a chat's live Claude Code background task (ccBridge.backgroundTasks). */
export const BACKGROUND_JOB_KIND = "background";

/** Dots of a job that is not a model: the gold the old longjob card used. */
export const LONGJOB_PROCESS_COLOR = "#c9a86a";

/** 45 → "45s", 90 → "1m30s", 720 → "12m", 4380 → "1h13m". */
export function longjobDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) {
    return "?";
  }
  const s = Math.floor(sec);
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 600) {
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m`;
  }
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

function isByteUnit(unit: string | undefined): boolean {
  return /^(b|bytes?)$/i.test((unit ?? "").trim());
}

function byteScale(n: number): number {
  let i = 0;
  while (n >= 1024 && i < BYTE_UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  return i;
}

function scaled(n: number, i: number): string {
  const v = n / 1024 ** i;
  return v < 10 && i > 0 ? v.toFixed(1) : String(Math.round(v));
}

function count(x: number): string {
  return x >= 1e6
    ? `${(x / 1e6).toFixed(2)}M`
    : x >= 1e4
      ? `${(x / 1e3).toFixed(1)}k`
      : String(Math.round(x));
}

function finite(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** "2.6 / 4.2 GB · 18 MB/s · ETA 1m30s" for bytes, "120 / 400 files · 3 files/s" for anything else. */
export function processProgressText(job: LongjobJob): string {
  const parts: string[] = [];
  const unit = (job.unit ?? "").trim();
  const bytes = isByteUnit(unit);
  if (finite(job.current)) {
    if (bytes) {
      const i = byteScale(finite(job.total) ? job.total : job.current);
      parts.push(
        finite(job.total)
          ? `${scaled(job.current, i)} / ${scaled(job.total, i)} ${BYTE_UNITS[i]}`
          : `${scaled(job.current, i)} ${BYTE_UNITS[i]}`,
      );
    } else {
      parts.push(
        `${count(job.current)}${finite(job.total) ? ` / ${count(job.total)}` : ""}${unit ? ` ${unit}` : ""}`,
      );
    }
  } else if (finite(job.pct)) {
    parts.push(`${Math.floor(job.pct)}%`);
  }
  if (finite(job.rate) && job.rate > 0) {
    if (bytes) {
      const i = byteScale(job.rate);
      parts.push(`${scaled(job.rate, i)} ${BYTE_UNITS[i]}/s`);
    } else {
      parts.push(`${count(job.rate)}${unit ? ` ${unit}` : ""}/s`);
    }
  }
  if (finite(job.etaSeconds) && job.etaSeconds > 0) {
    parts.push(`ETA ${longjobDuration(job.etaSeconds)}`);
  }
  return parts.join(" · ");
}

/** The percentage the line may draw: only from a reading that has a total. */
export function processPct(job: LongjobJob): number | null {
  if (finite(job.current)) {
    return finite(job.total) && job.total > 0
      ? Math.max(0, Math.min(100, (job.current / job.total) * 100))
      : null;
  }
  return finite(job.pct) ? Math.max(0, Math.min(100, job.pct)) : null;
}

/** "no progress for 12m" (the reading froze) or "no update for 4m" (the worker stopped writing). */
export function longjobStallText(job: LongjobJob, now: number): string {
  if (finite(job.stalledSince)) {
    return `no progress for ${longjobDuration((now - job.stalledSince) / 1000)}`;
  }
  if (finite(job.updatedAt)) {
    const age = now - job.updatedAt;
    const limit = Math.max(30_000, 6 * (finite(job.intervalMs) ? job.intervalMs : 5000));
    if (age > limit) {
      return `no update for ${longjobDuration(age / 1000)}`;
    }
  }
  return "";
}

/** A model id from a Claude Code transcript is bare (`claude-opus-5-5`); a gateway id names it. */
export function providerOfModel(model: string): string {
  if (model.includes("/")) {
    return model.split("/")[0];
  }
  return /^claude-/i.test(model) ? "anthropic" : "";
}

type RowSpec = {
  job: LongjobJob;
  color: string;
  head: string;
  detail: string;
  stall: string;
  pct: number | null;
  model: string;
};

function rowHtml(spec: RowSpec, now: number, deps: LongjobRowDeps): string {
  const { job } = spec;
  const started = finite(job.startedAt) ? job.startedAt : now;
  const tail = [spec.detail, spec.stall]
    .filter(Boolean)
    .map((t) => ` &middot; ${deps.esc(t)}`)
    .join("");
  const line =
    spec.pct === null
      ? ""
      : `<div class="job-run-line"><div class="job-run-fill" style="width:${spec.pct.toFixed(1)}%"></div></div>`;
  return `<div class="thinking-run job-run${spec.stall ? " job-run-stalled" : ""}" data-job-id="${deps.esc(job.id)}" data-job-kind="${deps.esc(job.kind === "agents" || job.kind === BACKGROUND_JOB_KIND ? job.kind : "process")}"${spec.model ? ` data-job-model="${deps.esc(spec.model)}"` : ""} data-started-at="${started}" style="--thinking-dot-color:${spec.color}">
  <div class="thinking-dots" style="--thinking-phase:${deps.phaseMs}ms"><span></span><span></span><span></span></div>
  <span class="thinking-model">${spec.head}${tail}</span>
  <span class="thinking-elapsed">${longjobDuration((now - started) / 1000)}</span>
  ${line}
</div>`;
}

function agentRows(job: LongjobJob, now: number, deps: LongjobRowDeps): string[] {
  const label = job.label || job.id;
  const stall = longjobStallText(job, now);
  const agents = Array.isArray(job.agents) ? job.agents : [];
  // One row per model, in the order each model first appears in the journal.
  const groups = new Map<string, LongjobAgent[]>();
  for (const a of agents) {
    const key = a.model ?? "";
    const list = groups.get(key);
    if (list) {
      list.push(a);
    } else {
      groups.set(key, [a]);
    }
  }
  const rows: string[] = [];
  for (const [model, list] of groups) {
    if (!list.some((a) => a.status === "running")) {
      continue; // that model's share is finished; a bouncing row would claim work that is not happening
    }
    const provider = model ? providerOfModel(model) : "";
    const efforts = new Set(list.map((a) => a.effort ?? ""));
    const effort = efforts.size === 1 ? [...efforts][0] : "";
    const name = (model ? deps.modelLabel(model) : "") || "agent";
    const done = list.filter((a) => a.status === "done" || a.status === "failed").length;
    rows.push(
      rowHtml(
        {
          job,
          model,
          color: model ? deps.dotColor(model, provider) : LONGJOB_PROCESS_COLOR,
          head: `${model ? deps.modelIcon(model, provider) : "⏳"} ${deps.esc(name)}${effort ? ` ${deps.esc(effort)}` : ""}`,
          detail: `${label} · ${done}/${list.length} done`,
          stall,
          pct: null,
        },
        now,
        deps,
      ),
    );
  }
  if (rows.length === 0) {
    // Between stages, or before the first agent starts: the job is still on, with no model to name.
    const done = agents.filter((a) => a.status === "done" || a.status === "failed").length;
    const planned = Math.max(agents.length, finite(job.total) ? job.total : 0);
    rows.push(
      rowHtml(
        {
          job,
          model: "",
          color: LONGJOB_PROCESS_COLOR,
          head: `⏳ ${deps.esc(label)}`,
          detail: planned > 0 ? `${done}/${planned} done` : "",
          stall,
          pct: null,
        },
        now,
        deps,
      ),
    );
  }
  return rows;
}

function processRow(job: LongjobJob, now: number, deps: LongjobRowDeps): string {
  return rowHtml(
    {
      job,
      model: "",
      color: LONGJOB_PROCESS_COLOR,
      head: `⚙ ${deps.esc(job.label || job.id)}`,
      detail: processProgressText(job),
      stall: longjobStallText(job, now),
      pct: processPct(job),
    },
    now,
    deps,
  );
}

/** A background task: ⚙, its description and the elapsed time. No progress, no line, never amber. */
function backgroundRow(job: LongjobJob, now: number, deps: LongjobRowDeps): string {
  return rowHtml(
    {
      job,
      model: "",
      color: LONGJOB_PROCESS_COLOR,
      head: `⚙ ${deps.esc(job.label || job.id)}`,
      detail: "",
      stall: "",
      pct: null,
    },
    now,
    deps,
  );
}

/** One layer of the indicator: the thinking row, or the rows of one job, and when it started. */
export type IndicatorLayer = { startedAt: number; html: string };

/** Each running job as one layer (an agents job's per-model rows stay together), in list order. */
export function longjobLayers(
  jobs: LongjobJob[],
  now: number,
  deps: LongjobRowDeps,
): IndicatorLayer[] {
  const layers: IndicatorLayer[] = [];
  for (const job of jobs) {
    if (!job || typeof job.id !== "string" || job.status !== "running") {
      continue;
    }
    const rows =
      job.kind === "agents"
        ? agentRows(job, now, deps)
        : job.kind === BACKGROUND_JOB_KIND
          ? [backgroundRow(job, now, deps)]
          : [processRow(job, now, deps)];
    layers.push({ startedAt: finite(job.startedAt) ? job.startedAt : now, html: rows.join("\n") });
  }
  return layers;
}

/** Every row of this chat's running jobs, oldest job first; "" when none runs. */
export function renderLongjobRows(jobs: LongjobJob[], now: number, deps: LongjobRowDeps): string {
  return longjobLayers(jobs, now, deps)
    .map((l) => l.html)
    .join("\n");
}

/** Past 4 layers, the indent stays at 4. */
export const INDICATOR_MAX_DEPTH = 4;

/**
 * FORK 2026-10-25 (the architect, 00:48) — the indicator is a stack ordered by age: the OLDEST layer at the
 * bottom, each newer one above it and one step deeper, so a prompt asked while a job runs thinks
 * above that job, and a job that turn starts sits between them. Each step is a `.thinking-layer`
 * wrapper (a small left offset and a thin guide line, no background) holding the deeper layers and
 * then its own rows, so a guide runs from its layer up through everything newer. From the fifth
 * layer on the depth stays at INDICATOR_MAX_DEPTH: those layers share the last wrapper, newest first.
 * The oldest layer sits bare in the indicator, so one layer alone renders exactly as before.
 */
export function stackIndicatorLayers(layers: IndicatorLayer[]): string {
  const byAge = layers
    .map((layer, i) => ({ layer, i }))
    .toSorted((a, b) => a.layer.startedAt - b.layer.startedAt || a.i - b.i)
    .map((x) => x.layer);
  const levels: string[][] = [];
  byAge.forEach((layer, k) => {
    const depth = Math.min(k, INDICATOR_MAX_DEPTH);
    (levels[depth] ??= []).unshift(layer.html); // newest first, as the stack reads top-down
  });
  let html = "";
  for (let depth = levels.length - 1; depth >= 0; depth--) {
    const own = levels[depth].join("\n");
    html =
      depth === 0
        ? html + own
        : `<div class="thinking-layer" data-depth="${depth}">${html}${own}</div>`;
  }
  return html;
}

/**
 * The quiet transcript line a finished job leaves: the wake's status sentence ("✅ build — finished
 * in 4m12s"), without the log tail, the done.json path or the instructions written for the model,
 * which stay folded under it. "" when the wake carries no status sentence (a fallback reminder).
 */
export function longjobWakeHeadline(body: string): string {
  const m = /([✅❌⏹⚠]️?\s.*?)(?=\s·\slast output:|\s—\sread\s|\s\(reading\s|\.\s|\n|$)/u.exec(body);
  return m ? m[1].trim() : "";
}
