/**
 * The one-sentence status of the amygdala (design doc §7.2 `amygdala2.status`). `buildStatus` is pure; `readSpool`
 * is the only I/O here: the hooks append one JSON line per call to `<dataDir>/hook-spool.jsonl`, and the gateway reads
 * the tail for per-seam liveness and for `floor-missing` (the hook found no usable policy.json).
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { Seam } from "./types.js";

export const JUDGE_SILENT_MS = 5 * 60_000;
const SPOOL_TAIL_BYTES = 128 * 1024;

export interface StatusInputs {
  now: number;
  mode: "shadow" | "enforce";
  floorActive: boolean;
  /** Last seen ts per seam (hook spool merged with decide calls). */
  seams: Partial<Record<Seam, number>>;
  rules: { n: number; version: number };
  judge: { lastMs: number | null; errors: number; silentSince?: number };
  spendEurToday: number;
  counts: { checks: number; held: number; asked: number };
  waitingForYou: number;
  /** A hook reported `floor-missing` since the policy was last written. */
  floorMissing: boolean;
  notesDropped?: number;
  /** Set when the runtime failed to start (or never did): the status says so instead of "watching". */
  startError?: string;
  /** The latest hook call the gateway answered with something other than 200 (hook spool `refused`). */
  hooksRefused?: { ts: number; status: number } | null;
}

export interface StatusEvent {
  ts: number;
  state: "working" | "shadow" | "degraded";
  line: string;
  mode: "shadow" | "enforce";
  floorActive: boolean;
  seams: Record<"prompt" | "pre" | "post" | "stop", { lastTs: number | null }>;
  rules: { n: number; version: number };
  judge: { lastMs: number | null; errors: number; silentSince?: number };
  spendEurToday: number;
  checksToday: number;
  heldToday: number;
  askedToday: number;
  waitingForYou: number;
  notesDropped: number;
}

export function buildStatus(i: StatusInputs): StatusEvent {
  const seenTimes = Object.values(i.seams).filter((n): n is number => typeof n === "number");
  const lastCheck = seenTimes.length ? Math.max(...seenTimes) : 0;
  const checksArriving = lastCheck > 0 && i.now - lastCheck <= JUDGE_SILENT_MS;
  const silentFor = i.judge.silentSince !== undefined ? i.now - i.judge.silentSince : 0;
  const judgeSilent = silentFor > JUDGE_SILENT_MS && checksArriving;
  const floorOff = i.mode === "enforce" && !i.floorActive;
  const down = i.startError !== undefined;
  const refusedRecently =
    i.hooksRefused != null && i.now - i.hooksRefused.ts <= JUDGE_SILENT_MS ? i.hooksRefused : null;
  // A check that arrived after the refusal means only some calls are turned away (an oversized step's 413), not all
  // of them (a 401 on every call). Only "all" is red (2026-10-02: one 413 painted "the chats reach nothing").
  const refused = refusedRecently && !(lastCheck > refusedRecently.ts) ? refusedRecently : null;
  const partlyRefused = refusedRecently && !refused ? refusedRecently : null;
  const degraded = down || refused !== null || judgeSilent || i.floorMissing || floorOff;

  const tail =
    `${i.counts.checks} checks · ${i.counts.held} held · ${i.counts.asked} asked · ` +
    `€${i.spendEurToday.toFixed(3)} today` +
    (i.waitingForYou > 0 ? ` · ${i.waitingForYou} waiting for you` : "") +
    (partlyRefused ? ` · some hook calls refused (HTTP ${partlyRefused.status})` : "");

  let line: string;
  if (down) {
    line =
      i.startError === "not started"
        ? "Not running: not started"
        : `Not running: failed to start (${(i.startError ?? "").slice(0, 120)})`;
  } else if (refused) {
    line = `Hooks refused by the gateway (HTTP ${refused.status}) · the chats reach nothing`;
  } else if (i.floorMissing) line = "Hard rules floor missing";
  else if (floorOff) line = "Hard rules floor off";
  else if (judgeSilent) {
    line = `Judge silent ${Math.floor(silentFor / 60_000)} min · hard rules still on`;
  } else if (i.mode === "shadow") {
    line = `Shadow: watching, not enforcing · ${i.floorActive ? "hard rules on · " : ""}${tail}`;
  } else {
    line = `Working · ${tail}`;
  }

  const lastTs = (s: Seam): number | null => i.seams[s] ?? null;
  return {
    ts: i.now,
    state: degraded ? "degraded" : i.mode === "shadow" ? "shadow" : "working",
    line,
    mode: i.mode,
    floorActive: i.floorActive,
    seams: {
      prompt: { lastTs: lastTs("prompt") },
      pre: { lastTs: lastTs("pre-tool") },
      post: { lastTs: lastTs("post-tool") },
      stop: { lastTs: lastTs("stop") },
    },
    rules: i.rules,
    judge: i.judge,
    spendEurToday: i.spendEurToday,
    checksToday: i.counts.checks,
    heldToday: i.counts.held,
    askedToday: i.counts.asked,
    waitingForYou: i.waitingForYou,
    notesDropped: i.notesDropped ?? 0,
  };
}

export interface SpoolSummary {
  seams: Partial<Record<Seam, number>>;
  /** Latest ts of a `floor-missing` line, or null. */
  floorMissingTs: number | null;
  /** Latest hook call the gateway refused (`refused` rows), with its HTTP status; such rows are not liveness. */
  refused: { ts: number; status: number } | null;
}

function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function toSeam(v: unknown): Seam | null {
  switch (v) {
    case "prompt":
    case "pre-tool":
    case "post-tool":
    case "stop":
      return v;
    case "pre":
      return "pre-tool";
    case "post":
      return "post-tool";
    default:
      return null;
  }
}

function isFloorMissing(row: Record<string, unknown>): boolean {
  return Object.entries(row).some(([k, v]) =>
    k === "floor-missing" || k === "floorMissing" ? Boolean(v) : v === "floor-missing",
  );
}

/** Read the last `maxLines` lines of the hook spool. A missing or unreadable spool is an empty summary. */
export function readSpool(dataDir: string, maxLines = 200): SpoolSummary {
  const out: SpoolSummary = { seams: {}, floorMissingTs: null, refused: null };
  let text: string;
  let mtime: number;
  try {
    const fd = openSync(join(dataDir, "hook-spool.jsonl"), "r");
    try {
      const st = fstatSync(fd);
      const len = Math.min(st.size, SPOOL_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      if (len > 0) readSync(fd, buf, 0, len, st.size - len);
      text = buf.toString("utf8");
      // The tail may start mid-line: drop the partial first line.
      if (st.size > len) text = text.slice(text.indexOf("\n") + 1);
      mtime = st.mtimeMs;
    } finally {
      closeSync(fd);
    }
  } catch {
    return out;
  }
  for (const line of text.split("\n").filter(Boolean).slice(-maxLines)) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const ts = toMs(r.ts) ?? mtime;
    const seam = toSeam(r.seam);
    if (r.action === "refused") {
      if (!out.refused || ts >= out.refused.ts) {
        out.refused = { ts, status: typeof r.status === "number" ? r.status : 0 };
      }
      continue;
    }
    if (seam) out.seams[seam] = Math.max(out.seams[seam] ?? 0, ts);
    if (isFloorMissing(r)) out.floorMissingTs = Math.max(out.floorMissingTs ?? 0, ts);
  }
  return out;
}
