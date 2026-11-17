// FORK 2026-11-14 — a long job that runs an agent (`claude -p` under longjob, a Workflow fan-out) shows in the chat
// as one row under the thinking dots, so the agent's thinking and steps stay hidden. The owner asked to open that row
// and see the work from its first step, in the chat, as if the chat had done it in the open.
//
// A long job's row under the thinking dots (longjob-rows.ts) opens into the JOB TRAIL: the work of the agents
// behind the job, from their first step, drawn with the feed's own markup (thinking bubbles, narration
// bubbles, tool rows that open like any other), and kept live while the job runs. The data comes from
// tinker-prod-ui `/api/longjob/<id>/trail` (scripts/lib/longjob-trail.mjs), which reads the agents' Claude
// Code transcripts; the page sends a byte cursor per agent and gets only what is new.
//
// Placement (chat-units.ts `jobTrails`): while the job runs the trail sits at the end of the chat, above the
// indicator, where its row is. Once the job has ended it stays in the run that was going on when it ended,
// so the wake that reports the job lands after it and the trail never jumps under the reader.
//
// A run started with `claude -p --output-format text` does not keep its thinking text (Claude Code omits it
// in that mode unless the run passes `--thinking-display summarized`): those blocks show as "thought for N s".
//
// Pure HTML builders plus one small controller; no DOM. Every dynamic string goes through `esc` or `md`.

import { providerOfModel } from "./longjob-rows.js";

export type TrailEntry = {
  t: "prompt" | "thinking" | "text" | "tool" | "result" | "req" | "note";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string;
  isError?: boolean;
  ts?: number | null;
  model?: string;
};

export type TrailAgentWire = {
  key: string;
  kind?: string;
  label?: string;
  startedAt?: number | null;
  running?: boolean;
  entries?: TrailEntry[];
  next?: number;
  /** The transcript's size when read: above `next`, more is waiting (a read takes 3 MB at most). */
  size?: number;
  reset?: boolean;
};

/** One answer of `/api/longjob/<id>/trail`. */
export type TrailWire = {
  id?: string;
  label?: string;
  kind?: string;
  session?: string;
  status?: string;
  startedAt?: number | null;
  endedAt?: number | null;
  agents?: TrailAgentWire[];
  log?: string;
};

export type TrailAgent = {
  key: string;
  kind: string;
  label: string;
  startedAt: number | null;
  running: boolean;
  entries: TrailEntry[];
  next: number;
  /** Open when first seen running; a click flips it (see `agentOpen`). */
  openByDefault: boolean;
};

export type JobTrail = {
  id: string;
  label: string;
  session: string;
  /** "loading" until the first answer, then the server's word: running, ok, failed, stopped, ended. */
  status: string;
  startedAt: number | null;
  endedAt: number | null;
  agents: TrailAgent[];
  log: string;
  error: string | null;
};

export type JobTrailDeps = {
  esc: (s: string) => string;
  md: (s: string) => string;
  /** The feed's one-line tool title and its expanded detail (app.ts toolSummary / toolExpandedDetail). */
  toolSummary: (name: string, input: unknown) => string;
  toolDetail: (name: string, input: unknown) => string;
  /** The feed's `expandedTools`: a row whose `data-tid` is in it is open. */
  isExpanded: (tid: string) => boolean;
  modelIcon: (model: string, provider: string) => string;
  modelLabel: (model: string) => string;
  dotColor: (model: string, provider: string) => string;
  /** "20:49" for a timestamp (tests pass a fixed one). */
  clock?: (ms: number) => string;
};

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** A thought shorter than this is not worth a line of its own. */
const THOUGHT_MIN_MS = 5_000;
const PROMPT_PREVIEW = 160;

function defaultClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function newJobTrail(job: {
  id: string;
  label?: string;
  session?: string;
  startedAt?: number | null;
}): JobTrail {
  return {
    id: job.id,
    label: job.label || job.id,
    session: job.session ?? "",
    status: "loading",
    startedAt: finite(job.startedAt) ? job.startedAt : null,
    endedAt: null,
    agents: [],
    log: "",
    error: null,
  };
}

/** True while the trail can still grow: polled again. */
export function trailIsLive(trail: JobTrail): boolean {
  return trail.status === "loading" || trail.status === "running";
}

/**
 * Fold one answer into the trail. Entries are appended after each agent's cursor; an agent the page did not
 * know arrives from its start. Returns whether anything a reader would see changed.
 */
export function mergeTrail(trail: JobTrail, wire: TrailWire): boolean {
  let changed = false;
  const status = typeof wire.status === "string" && wire.status ? wire.status : "ended";
  if (status !== trail.status) {
    trail.status = status;
    changed = true;
  }
  if (typeof wire.label === "string" && wire.label && wire.label !== trail.label) {
    trail.label = wire.label;
    changed = true;
  }
  if (typeof wire.session === "string" && wire.session) {
    trail.session = wire.session;
  }
  if (finite(wire.startedAt)) {
    trail.startedAt = wire.startedAt;
  }
  const endedAt = finite(wire.endedAt) ? wire.endedAt : null;
  if (endedAt !== trail.endedAt) {
    trail.endedAt = endedAt;
    changed = true;
  }
  const log = typeof wire.log === "string" ? wire.log : "";
  if (log !== trail.log) {
    trail.log = log;
    changed = true;
  }
  if (trail.error) {
    trail.error = null;
    changed = true;
  }
  for (const w of Array.isArray(wire.agents) ? wire.agents : []) {
    if (!w || typeof w.key !== "string") {
      continue;
    }
    const entries = Array.isArray(w.entries) ? w.entries : [];
    const running = w.running === true;
    let a = trail.agents.find((x) => x.key === w.key);
    if (!a) {
      a = {
        key: w.key,
        kind: w.kind ?? "",
        label: w.label ?? "",
        startedAt: finite(w.startedAt) ? w.startedAt : null,
        running,
        entries: [],
        next: 0,
        openByDefault: running,
      };
      trail.agents.push(a);
      changed = true;
    }
    if (w.reset) {
      a.entries = [];
      changed = true;
    }
    if (entries.length > 0) {
      a.entries.push(...entries);
      changed = true;
    }
    if (finite(w.next)) {
      a.next = w.next;
    }
    if (a.running !== running) {
      a.running = running;
      changed = true;
    }
    if (w.label && w.label !== a.label) {
      a.label = w.label;
      changed = true;
    }
    if (finite(w.startedAt) && a.startedAt === null) {
      a.startedAt = w.startedAt;
    }
  }
  trail.agents.sort(
    (x, y) =>
      (x.startedAt ?? Number.MAX_SAFE_INTEGER) - (y.startedAt ?? Number.MAX_SAFE_INTEGER) ||
      x.key.localeCompare(y.key),
  );
  return changed;
}

/** The `c` query parameter: each known agent's byte cursor. */
export function trailCursor(trail: JobTrail): string {
  return trail.agents.map((a) => `${a.key}:${a.next}`).join(",");
}

/** The `data-tid` of a trail's agent section, a tool row or a prompt. */
export function trailTid(jobId: string, agentKey: string, part?: string): string {
  return `jt:${jobId}:${agentKey}${part ? `:${part}` : ""}`;
}

/** A section is open by default when its agent was running at first sight; a click flips it. */
export function agentOpen(trail: JobTrail, a: TrailAgent, deps: Pick<JobTrailDeps, "isExpanded">) {
  return a.openByDefault !== deps.isExpanded(trailTid(trail.id, a.key));
}

function lastModel(a: TrailAgent): string {
  for (let i = a.entries.length - 1; i >= 0; i--) {
    const m = a.entries[i].model;
    if (m) {
      return m;
    }
  }
  return "";
}

function toolCount(a: TrailAgent): number {
  return a.entries.filter((e) => e.t === "tool").length;
}

function firstLine(s: string, max: number): string {
  const line = s.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function secondsText(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** What a running agent is doing now, from the end of its entries. */
function liveLine(
  trail: JobTrail,
  a: TrailAgent,
  results: Map<string, TrailEntry>,
  deps: JobTrailDeps,
): string {
  const clock = deps.clock ?? defaultClock;
  let since: number | null = null;
  let what = "thinking";
  for (let i = a.entries.length - 1; i >= 0; i--) {
    const e = a.entries[i];
    if (e.t === "tool" && e.id && !results.has(e.id)) {
      what = `running ${deps.toolSummary(e.name ?? "tool", e.input ?? {})}`;
      since = finite(e.ts) ? e.ts : null;
      break;
    }
    if (e.t === "req" || e.t === "result" || e.t === "prompt") {
      since = finite(e.ts) ? e.ts : null;
      break;
    }
    if (e.t === "text" || e.t === "thinking" || e.t === "tool") {
      since = finite(e.ts) ? e.ts : null;
      break;
    }
  }
  const model = lastModel(a);
  const color = model ? deps.dotColor(model, providerOfModel(model)) : "var(--muted)";
  const when = since !== null ? ` &middot; since ${deps.esc(clock(since))}` : "";
  return `<div class="job-trail-live" style="--thinking-dot-color:${color}"><div class="thinking-dots"><span></span><span></span><span></span></div><span class="job-trail-live-text">${deps.esc(what)}${when}</span></div>`;
}

/** One agent's work, in order: its task, thinking, narration and tool calls (results inside their rows). */
export function renderAgentWork(trail: JobTrail, a: TrailAgent, deps: JobTrailDeps): string {
  const { esc, md } = deps;
  const results = new Map<string, TrailEntry>();
  for (const e of a.entries) {
    if (e.t === "result" && e.id) {
      results.set(e.id, e);
    }
  }
  const thoughts = a.entries.filter((e) => e.t === "thinking");
  let h = "";
  if (thoughts.length > 0 && thoughts.every((e) => !e.text?.trim())) {
    h += `<div class="job-trail-quiet">This run was started without keeping its thinking, so only how long it thought shows.</div>`;
  }
  let prevTs: number | null = null;
  let prompts = 0;
  for (const e of a.entries) {
    if (e.t === "prompt") {
      const tid = trailTid(trail.id, a.key, `p${prompts++}`);
      const text = e.text ?? "";
      const open = deps.isExpanded(tid);
      const long = text.trim().length > PROMPT_PREVIEW || text.trim().includes("\n");
      h += `<div class="job-trail-prompt${long ? " is-long" : ""}"${long ? ` data-tid="${esc(tid)}"` : ""}><span class="thinking-label">Task</span> ${open || !long ? md(text) : `${esc(firstLine(text, PROMPT_PREVIEW))}${long ? ` <span class="job-trail-more">▸</span>` : ""}`}</div>`;
    } else if (e.t === "thinking") {
      const text = e.text ?? "";
      if (text.trim()) {
        h += `<div class="msg assistant msg-thinking job-trail-thought"><span class="thinking-label">Thinking:</span> ${md(text)}</div>`;
      } else if (finite(e.ts) && prevTs !== null && e.ts - prevTs >= THOUGHT_MIN_MS) {
        h += `<div class="job-trail-quiet job-trail-thought-time">💭 thought for ${esc(secondsText(e.ts - prevTs))}</div>`;
      }
    } else if (e.t === "text") {
      h += `<div class="msg assistant job-trail-text">${md(e.text ?? "")}</div>`;
    } else if (e.t === "tool") {
      const name = e.name ?? "tool";
      const input = e.input ?? {};
      const tid = trailTid(trail.id, a.key, e.id ?? `n${prompts}`);
      const paired = e.id ? results.get(e.id) : undefined;
      const icon = paired ? (paired.isError ? "✗" : "✓") : a.running ? "⋯" : "?";
      const cls = paired ? (paired.isError ? "err" : "ok") : "run";
      h += `<div class="tool-row" data-tid="${esc(tid)}"><span class="status ${cls}">${icon}</span><span class="detail">${esc(deps.toolSummary(name, input))}</span></div>`;
      if (deps.isExpanded(tid)) {
        h += `<div class="tool-detail">${deps.toolDetail(name, input)}`;
        if (paired?.content) {
          h += `<div class="tool-result-inline"><div class="explanation">${paired.isError ? "❌ Something went wrong:" : "stdout:"}</div><div class="code-block">${esc(paired.content)}</div></div>`;
        }
        h += `</div>`;
      }
    } else if (e.t === "note") {
      h += `<div class="job-trail-quiet">⟲ ${esc(e.text ?? "")}</div>`;
    }
    if (finite(e.ts)) {
      prevTs = e.ts;
    }
  }
  if (a.running) {
    h += liveLine(trail, a, results, deps);
  }
  return h;
}

const STATUS_WORD: Record<string, string> = {
  loading: "loading…",
  running: "working",
  ok: "finished",
  done: "finished",
  failed: "failed",
  stopped: "stopped",
  ended: "ended",
};

/** The whole trail block: a head naming the job and its agent, then the agents' work. */
export function renderJobTrail(trail: JobTrail, deps: JobTrailDeps): string {
  const { esc } = deps;
  const clock = deps.clock ?? defaultClock;
  const only = trail.agents.length === 1 ? trail.agents[0] : null;
  const model = only ? lastModel(only) : "";
  const tools = trail.agents.reduce((n, a) => n + toolCount(a), 0);
  const meta: string[] = [];
  if (model) {
    meta.push(
      `${deps.modelIcon(model, providerOfModel(model))} ${esc(deps.modelLabel(model) || model)}`,
    );
  } else if (trail.agents.length > 1) {
    meta.push(`${trail.agents.length} agents`);
  }
  if (tools > 0) {
    meta.push(`${tools} tool call${tools === 1 ? "" : "s"}`);
  }
  if (finite(trail.startedAt)) {
    meta.push(`started ${esc(clock(trail.startedAt))}`);
  }
  const word = STATUS_WORD[trail.status] ?? trail.status;
  meta.push(
    trailIsLive(trail) || !finite(trail.endedAt)
      ? esc(word)
      : `${esc(word)} ${esc(clock(trail.endedAt))}`,
  );
  let h = `<div class="job-trail job-trail-${esc(trail.status)}" data-job-trail="${esc(trail.id)}">`;
  h += `<div class="job-trail-head"><span class="job-trail-icon">⚙</span><span class="job-trail-title">${esc(trail.label)}</span><span class="job-trail-meta">${meta.join(" &middot; ")}</span><button type="button" class="job-trail-close" data-job-trail-close="${esc(trail.id)}" title="Hide this job's work">×</button></div>`;
  h += `<div class="job-trail-body">`;
  if (trail.error && trail.agents.length === 0) {
    h += `<div class="job-trail-quiet">Could not read this job's work: ${esc(trail.error)}</div>`;
  } else if (trail.status === "loading") {
    h += `<div class="job-trail-quiet">Loading this job's work…</div>`;
  } else if (trail.agents.length === 0) {
    h += trail.log.trim()
      ? `<div class="job-trail-quiet">No agent's work was found for this job. Its output so far:</div><pre class="job-trail-log">${esc(trail.log.trimEnd())}</pre>`
      : `<div class="job-trail-quiet">No agent's work was found for this job, and it has printed nothing yet.</div>`;
  } else if (only) {
    h += renderAgentWork(trail, only, deps);
  } else {
    for (const a of trail.agents) {
      const open = agentOpen(trail, a, deps);
      const m = lastModel(a);
      const who = [
        m ? `${deps.modelIcon(m, providerOfModel(m))} ${esc(deps.modelLabel(m) || m)}` : "",
        esc(a.label || a.key.slice(0, 8)),
        `${toolCount(a)} tool call${toolCount(a) === 1 ? "" : "s"}`,
        a.running ? "working" : "done",
      ]
        .filter(Boolean)
        .join(" &middot; ");
      h += `<div class="job-trail-agent${a.running ? " is-running" : ""}">`;
      h += `<div class="job-trail-agent-head" data-tid="${esc(trailTid(trail.id, a.key))}"><span class="job-trail-chev">${open ? "▾" : "▸"}</span>${who}</div>`;
      if (open) {
        h += `<div class="job-trail-agent-body">${renderAgentWork(trail, a, deps)}</div>`;
      }
      h += `</div>`;
    }
  }
  h += `</div></div>`;
  return h;
}

// ---------------------------------------------------------------- the controller

export type JobRef = { id: string; label?: string; session?: string; startedAt?: number | null };

export type JobTrailUiDeps = JobTrailDeps & {
  /** GET /api/longjob/<id>/trail?c=<cursor>; rejects on a network or server error, 404 included. */
  fetchTrail: (id: string, cursor: string) => Promise<TrailWire>;
  repaint: () => void;
  /** Where the open trails are kept across a reload (null: nowhere). */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
};

const STORE_KEY = "tinker.jobTrails.open";
const STORE_MAX = 20;
/** A trail whose job no longer exists on the server (its folder was cleaned) is dropped. */
const GONE_RE = /\b404\b|no such job/i;

/** Open trails by job id: toggled from the job's row, polled while live, drawn by chat-units. */
export function createJobTrailUi(deps: JobTrailUiDeps) {
  const trails = new Map<string, JobTrail>();
  const inFlight = new Set<string>();

  function save(): void {
    try {
      deps.storage?.setItem(
        STORE_KEY,
        JSON.stringify(
          [...trails.values()].slice(-STORE_MAX).map((t) => ({
            id: t.id,
            label: t.label,
            session: t.session,
            startedAt: t.startedAt,
          })),
        ),
      );
    } catch {}
  }

  function restore(): void {
    let saved: unknown = null;
    try {
      saved = JSON.parse(deps.storage?.getItem(STORE_KEY) ?? "null");
    } catch {}
    for (const j of Array.isArray(saved) ? saved : []) {
      if (j && typeof j.id === "string" && !trails.has(j.id)) {
        trails.set(j.id, newJobTrail(j as JobRef));
      }
    }
  }

  async function fetchOne(t: JobTrail): Promise<void> {
    if (inFlight.has(t.id)) {
      return;
    }
    inFlight.add(t.id);
    let backlog = false;
    try {
      const before = trailCursor(t);
      const wire = await deps.fetchTrail(t.id, before);
      if (trails.get(t.id) !== t) {
        return;
      }
      if (mergeTrail(t, wire)) {
        deps.repaint();
      }
      // A long transcript arrives in a few quick reads, not one read per poll. Only while the cursor moved: a
      // line still being written leaves `next` below `size` without progress, and that waits for the next poll.
      backlog =
        trailCursor(t) !== before &&
        (wire.agents ?? []).some(
          (a) => finite(a?.size) && finite(a?.next) && (a.size as number) > (a.next as number),
        );
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (trails.get(t.id) !== t) {
        return;
      }
      if (GONE_RE.test(text) && t.agents.length === 0) {
        trails.delete(t.id);
        save();
        deps.repaint();
        return;
      }
      if (t.error !== text) {
        console.error("[job-trail] trail fetch failed", t.id, err);
        t.error = text;
        deps.repaint();
      }
    } finally {
      inFlight.delete(t.id);
    }
    if (backlog) {
      void fetchOne(t);
    }
  }

  restore();

  return {
    isOpen: (id: string) => trails.has(id),
    /** Open the job's trail (from its first step) or close it. Returns whether it is open now. */
    toggle(job: JobRef): boolean {
      if (trails.has(job.id)) {
        trails.delete(job.id);
        save();
        return false;
      }
      const t = newJobTrail(job);
      trails.set(job.id, t);
      save();
      void fetchOne(t);
      return true;
    },
    close(id: string): void {
      if (trails.delete(id)) {
        save();
      }
    },
    /** Fetch what is new for every open trail that can still grow. */
    poll(): void {
      for (const t of trails.values()) {
        if (trailIsLive(t) || t.error) {
          void fetchOne(t);
        }
      }
    },
    /** The open trails of one chat. */
    trailsFor(matches: (session: string) => boolean): JobTrail[] {
      return [...trails.values()].filter((t) => t.session && matches(t.session));
    },
    html: (t: JobTrail) => renderJobTrail(t, deps),
  };
}

export type JobTrailUi = ReturnType<typeof createJobTrailUi>;
