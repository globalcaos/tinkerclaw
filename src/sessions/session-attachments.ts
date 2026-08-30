import fs from "node:fs";
import { diagnosticSessionStates } from "../logging/diagnostic-session-state.js";

// "queued" is RETAINED but NO LONGER EMITTED (FORK 2026-08-28 — see listSessionAttachments).
// It stays in the union because `sessions.attachmentStop` still branches on it
// (src/gateway/server-methods/session-attachments.ts). Dropping the member here would not
// delete that branch, it would turn a live `kind === "queued"` comparison into a
// no-overlap typecheck error. Retire the consumer first, then this member.
export type SessionAttachmentKind = "run" | "queued" | "process";

export type SessionAttachment = {
  id: string; // stable + unique within one listing
  kind: SessionAttachmentKind;
  label: string; // short: "turn running", "cli agent"
  detail?: string; // optional 2nd line, e.g. truncated cmdline
  startedAt?: number; // epoch ms when knowable
  ageMs: number;
  pid?: number; // only for kind==="process"
  stoppable: boolean; // false when visible but must not be signalled
};

export type ProcessProbe = { pid: number; cmdline: string; startedAt?: number };

const MAX_ATTACHMENTS = 50;
const DETAIL_MAX_CHARS = 160;
// /proc/<pid>/stat starttime is in kernel clock ticks. The real rate is
// sysconf(_SC_CLK_TCK), which Node does not expose; USER_HZ is 100 on Linux
// x86_64 (every target we ship to), so we hard-code 100 rather than shell out.
const CLOCK_TICKS_PER_SECOND = 100;
const MAX_ANCESTOR_WALK = 64;

function statFieldsAfterComm(pid: number | string): string[] | undefined {
  // /proc/<pid>/stat is "pid (comm) state ppid ...". comm may itself contain
  // spaces or ")", so split after the LAST ")": index 0 is field 3 (state),
  // index 1 is field 4 (ppid), index 19 is field 22 (starttime).
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) {
      return undefined;
    }
    return raw
      .slice(close + 1)
      .trim()
      .split(/\s+/);
  } catch {
    return undefined;
  }
}

function readBootTimeMs(): number | undefined {
  try {
    for (const line of fs.readFileSync("/proc/stat", "utf8").split("\n")) {
      if (line.startsWith("btime ")) {
        const seconds = Number(line.slice("btime ".length).trim());
        return Number.isFinite(seconds) ? seconds * 1000 : undefined;
      }
    }
  } catch {
    // fall through: startedAt simply stays unknown
  }
  return undefined;
}

export function readLinuxProcesses(): ProcessProbe[] {
  if (process.platform !== "linux") {
    return [];
  }
  try {
    const bootTimeMs = readBootTimeMs();
    const probes: ProcessProbe[] = [];
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }
      try {
        const cmdline = fs
          .readFileSync(`/proc/${entry}/cmdline`, "utf8")
          .split("\0")
          .filter(Boolean)
          .join(" ")
          .trim();
        if (!cmdline) {
          // kernel threads expose an empty cmdline; nothing attaches from there
          continue;
        }
        let startedAt: number | undefined;
        if (bootTimeMs !== undefined) {
          const startTicks = Number(statFieldsAfterComm(entry)?.[19]);
          if (Number.isFinite(startTicks)) {
            startedAt = bootTimeMs + (startTicks / CLOCK_TICKS_PER_SECOND) * 1000;
          }
        }
        probes.push({ pid: Number(entry), cmdline, startedAt });
      } catch {
        // pid exited mid-scan or is unreadable: skip silently by design
      }
    }
    return probes;
  } catch {
    return [];
  }
}

function collectAncestorPids(): Set<number> {
  // Signalling our own ancestry (shell, terminal, service manager) would tear
  // down the caller itself, so those pids are filtered out entirely.
  const ancestors = new Set<number>();
  let pid = process.pid;
  for (let depth = 0; depth < MAX_ANCESTOR_WALK; depth += 1) {
    const ppid = Number(statFieldsAfterComm(pid)?.[1]);
    if (!Number.isFinite(ppid) || ppid <= 0 || ancestors.has(ppid)) {
      break;
    }
    ancestors.add(ppid);
    pid = ppid;
  }
  return ancestors;
}

export function listSessionAttachments(params: {
  sessionId?: string;
  sessionKey?: string;
  now?: number;
  readProcesses?: () => ProcessProbe[];
}): SessionAttachment[] {
  const now = params.now ?? Date.now();
  const runs: SessionAttachment[] = [];

  // Deliberately NOT getDiagnosticSessionState(): a lookup there CREATES an
  // entry as a side effect, and discovery must never mutate what it observes.
  for (const [key, state] of diagnosticSessionStates.entries()) {
    const matchesKey =
      params.sessionKey !== undefined &&
      (key === params.sessionKey || state.sessionKey === params.sessionKey);
    const matchesId = params.sessionId !== undefined && state.sessionId === params.sessionId;
    if (!matchesKey && !matchesId) {
      continue;
    }
    const sessionKey = state.sessionKey ?? key;
    if (state.state === "processing") {
      runs.push({
        id: `run:${sessionKey}`,
        kind: "run",
        label: "turn running",
        startedAt: state.lastActivity,
        ageMs: Math.max(0, now - state.lastActivity),
        stoppable: true,
      });
    }
    // FORK 2026-08-28 (the architect: "there are two redundant mechanisms to either track or
    // visualize how a prompt is being queued" / "right after I send a prompt, it automatically
    // shows like queued, when it is the one being processed at the moment").
    //
    // There WAS a `state.queueDepth > 0` row here, emitting kind "queued". It is gone, on
    // purpose. ONE FACT, ONE OWNER: the browser already draws the deferred prompt it is
    // holding, from state only it can be sure of. `queueDepth` is a TRANSPORT fact about a
    // server-side backlog — a different thing that happened to render as the same sentence.
    // Two producers painting into one strip meant a single prompt was described twice, and the
    // user read the second description as a claim about the prompt they had just sent. See the
    // 2026-08-23 note in src/logging/diagnostic.ts, where "turn running" and "1 prompt queued"
    // were shown side by side. The counter fix landed there narrowed the window; it could not
    // make one prompt stop being two rows.
    //
    // Side benefit: this retires the row's "Clear" button, which delegated to a session-wide
    // `chat.abort`. "Clear" is offered precisely because clearing a not-yet-started prompt
    // destroys nothing — but the abort it ran would have killed the IN-FLIGHT turn.
    //
    // The strip now emits only what ONLY it can know: the run row and the process rows.
  }

  const needles = [params.sessionId, params.sessionKey].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const processes: SessionAttachment[] = [];
  if (needles.length > 0) {
    let probes: ProcessProbe[] = [];
    try {
      probes = (params.readProcesses ?? readLinuxProcesses)();
    } catch {
      probes = [];
    }
    const ancestors = probes.length > 0 ? collectAncestorPids() : new Set<number>();
    for (const probe of probes) {
      if (!needles.some((needle) => probe.cmdline.includes(needle))) {
        continue;
      }
      // SAFETY: never emit (let alone mark stoppable) ourselves, init, our own
      // ancestry, or the gateway; signalling any of them takes the system down.
      if (probe.pid === process.pid || probe.pid === 1 || ancestors.has(probe.pid)) {
        continue;
      }
      if (probe.cmdline.includes("gateway --port")) {
        continue;
      }
      processes.push({
        id: `process:${probe.pid}`,
        kind: "process",
        label: probe.cmdline.includes("openclaw") ? "cli agent" : "attached process",
        detail: probe.cmdline.slice(0, DETAIL_MAX_CHARS),
        startedAt: probe.startedAt,
        ageMs: probe.startedAt !== undefined ? Math.max(0, now - probe.startedAt) : 0,
        pid: probe.pid,
        stoppable: true,
      });
    }
    processes.sort((a, b) => (a.startedAt ?? now) - (b.startedAt ?? now));
  }

  return [...runs, ...processes].slice(0, MAX_ATTACHMENTS);
}
