// FORK 2026-11-14 — the owner asked to see the work hidden behind a long job's row, from its first step, in the
// chat, as if the chat had done it in the open. A long job that runs an agent hides it: the chat shows one row
// under the thinking dots ("⚙ Chapter 1 … · 194 steps"). This module finds the Claude Code transcripts behind a
// job and reads them in compact pieces, so the page can draw the agent's work with the feed's own markup
// (tinker-ui job-trail.ts). Served by tinker-prod-ui `/api/longjob/<id>/trail`.
//
// Where a job's agents are found:
//   - a `claude` process inside the job's systemd unit (`longjob-<id>.service`): Claude Code keeps
//     `~/.claude/sessions/<pid>.json` ({sessionId, cwd}) while a process runs, and its transcript is
//     `~/.claude/projects/<cwd, every non-alphanumeric as "-">/<sessionId>.jsonl`;
//   - the agents of a Workflow journal (the worker's `--journal`): `agent-<agentId>.jsonl` beside it;
//   - what the longjob worker recorded in state.json (`agentSessions`, `journal`), so the units of a
//     serial batch that already ended stay listed after this server restarts.
// Read-only: nothing here writes a file or signals a process.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Bytes read from one transcript per request. A longer backlog arrives over the next polls. */
export const TRAIL_READ_MAX = 3 * 1024 * 1024;
const TEXT_MAX = 24_000;
const STR_MAX = 4_000;
const RESULT_MAX = 6_000;
const PROMPT_MAX = 4_000;
/** Jobs whose agents this server keeps in memory (a serial batch's finished units, a dead worker's). */
const JOBS_REMEMBERED = 40;
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z-]{7,80}$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Claude Code's project folder name for a working directory. */
export function projectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

function cut(s, max) {
  const t = typeof s === "string" ? s : "";
  return t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more characters)` : t;
}

/** A tool input with every long string shortened: a Write of a whole chapter does not travel whole. */
export function capInput(v, depth = 0) {
  if (typeof v === "string") {
    return cut(v, STR_MAX);
  }
  if (Array.isArray(v)) {
    return depth > 4 ? "[…]" : v.slice(0, 50).map((x) => capInput(x, depth + 1));
  }
  if (v && typeof v === "object") {
    if (depth > 4) {
      return "{…}";
    }
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 40)) {
      out[k] = capInput(x, depth + 1);
    }
    return out;
  }
  return v;
}

function resultText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === "string"
          ? b
          : b?.type === "text"
            ? (b.text ?? "")
            : b?.type === "image"
              ? "[image]"
              : "",
      )
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

/**
 * One transcript line as the page's entries; none for bookkeeping lines (request blobs, attachments,
 * queue operations). `req` marks the moment a request to the model went out, which is how the page
 * tells "thinking now" from "waiting on a tool".
 */
export function compactLine(o) {
  const ts = typeof o?.timestamp === "string" ? Date.parse(o.timestamp) || null : null;
  if (o?.type === "assistant") {
    const raw = o.message?.model;
    const model = typeof raw === "string" && raw && !raw.startsWith("<") ? raw : undefined;
    const out = [];
    for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
      if (b?.type === "thinking") {
        out.push({ t: "thinking", text: cut(b.thinking, TEXT_MAX), ts, model });
      } else if (b?.type === "redacted_thinking") {
        out.push({ t: "thinking", text: "", ts, model });
      } else if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
        out.push({ t: "text", text: cut(b.text, TEXT_MAX), ts, model });
      } else if (b?.type === "tool_use" && typeof b.id === "string") {
        out.push({
          t: "tool",
          id: b.id,
          name: String(b.name ?? "tool"),
          input: capInput(b.input ?? {}),
          ts,
          model,
        });
      }
    }
    return out;
  }
  if (o?.type === "user") {
    if (o.isMeta || o.isCompactSummary) {
      return [];
    }
    const c = o.message?.content;
    if (typeof c === "string") {
      return c.trim() ? [{ t: "prompt", text: cut(c, PROMPT_MAX), ts }] : [];
    }
    const out = [];
    for (const b of Array.isArray(c) ? c : []) {
      if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
        out.push({
          t: "result",
          id: b.tool_use_id,
          content: cut(resultText(b.content), RESULT_MAX),
          isError: b.is_error === true,
          ts,
        });
      } else if (
        b?.type === "text" &&
        typeof b.text === "string" &&
        b.text.trim() &&
        !b.text.trimStart().startsWith("<system-reminder>")
      ) {
        out.push({ t: "prompt", text: cut(b.text, PROMPT_MAX), ts });
      }
    }
    return out;
  }
  if (o?.type === "api-request") {
    return [{ t: "req", ts }];
  }
  if (o?.type === "system" && o.subtype === "compact_boundary") {
    return [{ t: "note", text: "Context compacted", ts }];
  }
  return [];
}

/** The byte after the next newline at or past `pos`, or -1 when the file ends first. */
function nextLineStart(fd, pos, size) {
  const step = 1 << 20;
  const buf = Buffer.alloc(step);
  for (let at = pos; at < size; at += step) {
    const n = fs.readSync(fd, buf, 0, Math.min(step, size - at), at);
    const i = buf.subarray(0, n).indexOf(10);
    if (i >= 0) {
      return at + i + 1;
    }
  }
  return -1;
}

/**
 * The complete lines of `file` from byte `from`, as entries. `next` is where the next read starts; a
 * line still being written is left for the next read. `reset` says the file is shorter than `from`
 * (a different file now has that name): the caller drops what it holds and starts again.
 */
export function readTranscript(file, from = 0, max = TRAIL_READ_MAX) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    let start = Number.isFinite(from) && from >= 0 ? Math.floor(from) : 0;
    let reset = false;
    if (start > size) {
      start = 0;
      reset = true;
    }
    if (start === size) {
      return { entries: [], next: size, size, reset };
    }
    fd = fs.openSync(file, "r");
    const len = Math.min(max, size - start);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    const end = buf.subarray(0, n).lastIndexOf(10);
    if (end < 0) {
      // One line longer than the window (a request blob): skip it whole and read on after it.
      const after = start + n < size ? nextLineStart(fd, start + n, size) : -1;
      return { entries: [], next: after < 0 ? start : after, size, reset };
    }
    const entries = [];
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      if (!line.trim()) {
        continue;
      }
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      entries.push(...compactLine(o));
    }
    return { entries, next: start + end + 1, size, reset };
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.error("[longjob-trail] transcript read failed", file, err);
    }
    return { entries: [], next: Number.isFinite(from) ? from : 0, size: 0, reset: false };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The agents a Workflow journal started, in order, each with its transcript path. */
export function journalAgents(journal) {
  let text = "";
  try {
    text = fs.readFileSync(journal, "utf8");
  } catch {
    return [];
  }
  const dir = path.dirname(journal);
  const byId = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof ev?.agentId !== "string" || !AGENT_ID.test(ev.agentId)) {
      continue;
    }
    const a = byId.get(ev.agentId) ?? {
      key: ev.agentId,
      kind: "workflow",
      label: "",
      done: false,
      order: byId.size,
      transcript: path.join(dir, `agent-${ev.agentId}.jsonl`),
    };
    if (ev.type === "started" && typeof ev.label === "string") {
      a.label = ev.label.slice(0, 120);
    }
    if (ev.type === "result") {
      a.done = true;
    }
    byId.set(ev.agentId, a);
  }
  return [...byId.values()];
}

function systemdControlGroup(unit) {
  return new Promise((resolve) => {
    execFile(
      "systemctl",
      ["--user", "show", "-p", "ControlGroup", "--value", unit],
      { timeout: 5000 },
      (err, stdout) => resolve(err ? "" : String(stdout).trim()),
    );
  });
}

/**
 * The reader. `home`, `cgroupRoot`, `procRoot` and `controlGroup` are seams for tests; the server
 * uses the defaults.
 */
export function createTrailReader(opts = {}) {
  const home = opts.home ?? os.homedir();
  const claudeHome = path.join(home, ".claude");
  const cgroupRoot = opts.cgroupRoot ?? "/sys/fs/cgroup";
  const procRoot = opts.procRoot ?? "/proc";
  const controlGroup = opts.controlGroup ?? systemdControlGroup;
  /** jobId → Map<agent key, agent>: what was seen, so an agent that ended stays on the trail. */
  const remembered = new Map();
  const cgCache = new Map();

  async function unitPids(unit) {
    const hit = cgCache.get(unit);
    let cg = hit && Date.now() - hit.at < 30_000 ? hit.cg : null;
    if (cg === null) {
      cg = await controlGroup(unit);
      if (cg) {
        cgCache.set(unit, { cg, at: Date.now() });
      }
    }
    if (!cg || !cg.startsWith("/") || cg.includes("..")) {
      return [];
    }
    const pids = [];
    const walk = (dir, depth) => {
      try {
        for (const p of fs.readFileSync(path.join(dir, "cgroup.procs"), "utf8").split("\n")) {
          if (/^\d+$/.test(p.trim())) {
            pids.push(Number(p.trim()));
          }
        }
      } catch {
        return;
      }
      if (depth >= 3) {
        return;
      }
      let names = [];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {}
      for (const d of names) {
        if (d.isDirectory()) {
          walk(path.join(dir, d.name), depth + 1);
        }
      }
    };
    walk(path.join(cgroupRoot, cg), 0);
    return pids;
  }

  function transcriptFor(sessionId, cwd) {
    if (!SESSION_ID.test(String(sessionId))) {
      return null;
    }
    const projects = path.join(claudeHome, "projects");
    if (typeof cwd === "string" && cwd) {
      const direct = path.join(projects, projectSlug(cwd), `${sessionId}.jsonl`);
      if (fs.existsSync(direct)) {
        return direct;
      }
    }
    let dirs = [];
    try {
      dirs = fs.readdirSync(projects);
    } catch {}
    for (const d of dirs) {
      const f = path.join(projects, d, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) {
        return f;
      }
    }
    return null;
  }

  function workerJournal(pid) {
    let argv = [];
    try {
      argv = fs.readFileSync(path.join(procRoot, String(pid), "cmdline"), "utf8").split("\0");
    } catch {
      return null;
    }
    if (!argv.includes("run-worker")) {
      return null;
    }
    const i = argv.indexOf("--journal");
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  }

  function remember(jobId, agents) {
    remembered.delete(jobId);
    remembered.set(jobId, agents);
    while (remembered.size > JOBS_REMEMBERED) {
      remembered.delete(remembered.keys().next().value);
    }
  }

  /** The job's agents, oldest first, each with `running` (alive in the job right now). */
  async function agentsOf(job, running) {
    const mem = remembered.get(job.id) ?? new Map();
    const add = (a) => {
      const old = mem.get(a.key);
      mem.set(a.key, { ...old, ...a, label: a.label || old?.label || "" });
    };
    for (const s of Array.isArray(job.agentSessions) ? job.agentSessions : []) {
      const t = transcriptFor(s?.sessionId, s?.cwd);
      if (t) {
        add({
          key: s.sessionId,
          kind: "claude",
          label: typeof s.name === "string" ? s.name : "",
          transcript: t,
          startedAt: Number(s.startedAt) || null,
        });
      }
    }
    const live = new Set();
    let journal = typeof job.journal === "string" && job.journal ? job.journal : null;
    if (running) {
      for (const pid of await unitPids(`longjob-${job.id}.service`)) {
        const s = readJson(path.join(claudeHome, "sessions", `${pid}.json`));
        if (s && typeof s.sessionId === "string") {
          const t = transcriptFor(s.sessionId, s.cwd);
          if (t) {
            add({
              key: s.sessionId,
              kind: "claude",
              label: typeof s.name === "string" ? s.name : "",
              transcript: t,
              startedAt: Number(s.startedAt) || null,
            });
            live.add(s.sessionId);
          }
          continue;
        }
        journal ??= workerJournal(pid);
      }
    }
    if (journal) {
      for (const a of journalAgents(journal)) {
        let born = mem.get(a.key)?.startedAt ?? null;
        if (born === null) {
          try {
            born = fs.statSync(a.transcript).birthtimeMs || null;
          } catch {}
        }
        add({ ...a, startedAt: born });
        if (running && !a.done) {
          live.add(a.key);
        }
      }
    }
    for (const a of mem.values()) {
      a.running = live.has(a.key);
    }
    remember(job.id, mem);
    return [...mem.values()].toSorted(
      (a, b) =>
        (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER) ||
        (a.order ?? 0) - (b.order ?? 0),
    );
  }

  /**
   * Every agent of `job` with the entries after its cursor (`cursors`: Map<key, byte>; an agent the
   * page does not know yet is read from its start, which is the point: the work since it started).
   */
  async function trail(job, cursors, running) {
    const agents = await agentsOf(job, running);
    return agents.map((a) => {
      const r = readTranscript(a.transcript, cursors.get(a.key) ?? 0);
      return {
        key: a.key,
        kind: a.kind,
        label: a.label,
        startedAt: a.startedAt ?? null,
        running: a.running,
        entries: r.entries,
        next: r.next,
        size: r.size,
        reset: r.reset,
      };
    });
  }

  return { agentsOf, trail, unitPids };
}

const LOG_TAIL = 6000;

/** The last few KB of a job's own output, newest drawing of each progress line, without colour. */
export async function logTail(file) {
  try {
    const fh = await fs.promises.open(file, "r");
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, LOG_TAIL);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      return buf
        .toString("utf8")
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
        .split("\n")
        .map((l) => l.split("\r").filter(Boolean).pop() ?? "")
        .join("\n");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}

/**
 * The answer of `/api/longjob/<id>/trail`: `{status, body}`. `root` holds the `lj-<id>` folders the
 * longjob worker writes (state.json while it runs, done.json once it ended, job.log). A job with no
 * agent (a download, a build) answers with the tail of its own output instead.
 */
export async function jobTrailBody(reader, root, id, cursorParam) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(id))) {
    return { status: 400, body: { error: "bad job id" } };
  }
  const dir = path.join(root, `lj-${id}`);
  let job;
  let mtimeMs = 0;
  try {
    const file = path.join(dir, "state.json");
    mtimeMs = (await fs.promises.stat(file)).mtimeMs;
    job = JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch {
    return { status: 404, body: { error: "no such job" } };
  }
  const done = readJson(path.join(dir, "done.json"));
  // A worker writes its state every few seconds; one that stopped writing is not running, whatever it last said.
  const fresh = Date.now() - mtimeMs < Math.max(60_000, 12 * (Number(job.intervalMs) || 5000));
  const running = !done && job.status === "running" && fresh;
  let agents;
  try {
    agents = await reader.trail({ ...job, id }, parseCursors(cursorParam), running);
  } catch (err) {
    console.error("[longjob-trail] trail failed", id, err);
    return { status: 500, body: { error: "trail read failed" } };
  }
  return {
    status: 200,
    body: {
      id,
      label: job.label ?? id,
      kind: job.kind ?? "process",
      session: job.session ?? "",
      status: done ? done.status || "done" : running ? "running" : "ended",
      startedAt: job.startedAt ?? null,
      endedAt: done?.finishedAt ?? (running ? null : Math.round(mtimeMs) || null),
      agents,
      log: agents.length === 0 ? await logTail(path.join(dir, "job.log")) : "",
    },
  };
}

/** `key:byte,key:byte` → Map (the page's cursors; anything malformed is ignored). */
export function parseCursors(param) {
  const out = new Map();
  for (const part of String(param ?? "").split(",")) {
    const m = /^([A-Za-z0-9_-]{1,80}):(\d{1,15})$/.exec(part.trim());
    if (m) {
      out.set(m[1], Number(m[2]));
    }
  }
  return out;
}
