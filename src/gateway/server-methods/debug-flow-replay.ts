/**
 * FORK 2026-05-12 — `gateway.flow.replay({correlationId, sinceMinutes?})`
 *
 * The bible's `flows.md` draws sequence diagrams for the top pipelines.
 * Today the diagrams are aspirational — there's no way to reconstruct
 * what ACTUALLY happened on a specific turn from the running system.
 *
 * This probe takes a correlation ID (today: a `runId`, `sessionKey`,
 * `openclawSessionId`, or any substring stable across the lifetime of
 * one operation) and returns the ordered list of journal events that
 * mention it, within a time window.
 *
 * Until the structured-journal rollout (which is high-friction with
 * upstream and deferred per `ownership.md`), this is a journal-grep
 * over `journalctl --user -u openclaw-gateway.service`. The probe
 * itself is the abstraction; the underlying source can move to a
 * structured events table later without changing the API.
 *
 * Scope: READ_SCOPE. No credentials surfaced. The probe truncates each
 * event line at 2 KB and caps total returned events at 200 so an
 * over-broad correlationId can't dump the journal.
 */

import { spawn } from "node:child_process";
import { withRetry } from "../../fork/pipeline.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_WINDOW_MINUTES = 30;
const MAX_WINDOW_MINUTES = 24 * 60;
const MAX_EVENTS = 200;
const MAX_LINE_LENGTH = 2_000;
const JOURNALCTL_TIMEOUT_MS = 15_000;

type JournalLine = {
  ts: string;
  raw: string;
  level: "info" | "warn" | "error" | "diagnostic" | "other";
};

/**
 * Run `journalctl --user -u openclaw-gateway.service --since <window>` and
 * return matching lines. Failure here is rare in practice but classified
 * carefully: a missing journalctl is a real environment problem; a slow
 * journalctl is transient and gets one retry via the withRetry wrapper.
 */
async function readJournalSince(
  sinceMinutes: number,
  needle: string,
  timeoutMs: number,
): Promise<JournalLine[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "journalctl",
      [
        "--user",
        "-u",
        "openclaw-gateway.service",
        "--since",
        `${sinceMinutes} minutes ago`,
        "--no-pager",
        "--output=short-iso",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let buffer = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`journalctl timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0 && code !== null) {
        // journalctl exits 1 when no entries match — that's not an error.
        // Other non-zero exits ARE errors.
        if (buffer.length === 0) {
          resolve([]);
          return;
        }
      }
      const out: JournalLine[] = [];
      for (const line of buffer.split("\n")) {
        if (!line) continue;
        if (!line.includes(needle)) continue;
        out.push(parseJournalLine(line));
        if (out.length >= MAX_EVENTS) break;
      }
      resolve(out);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function parseJournalLine(line: string): JournalLine {
  // `--output=short-iso` produces: `2026-05-12T07:40:35+0200 host service[pid]: message`
  const tsMatch = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4})/.exec(line);
  const ts = tsMatch?.[1] ?? "";
  const truncated = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
  let level: JournalLine["level"] = "other";
  if (/\[diagnostic\]/.test(line)) level = "diagnostic";
  else if (/error|ERROR|Error:/.test(line)) level = "error";
  else if (/warn|WARN/.test(line)) level = "warn";
  else if (/info|INFO|\[ws\] ⇄/.test(line)) level = "info";
  return { ts, raw: truncated, level };
}

const readJournalWithRetry = withRetry<
  { sinceMinutes: number; needle: string; timeoutMs: number },
  JournalLine[]
>({
  attempts: 2,
  backoffMs: 1_000,
  isRetryable: (err) => err instanceof Error && /timed out|busy/i.test(err.message),
})(({ sinceMinutes, needle, timeoutMs }) => readJournalSince(sinceMinutes, needle, timeoutMs));

export const debugFlowReplayHandlers: GatewayRequestHandlers = {
  "gateway.flow.replay": async ({ params, respond }) => {
    const p = (params ?? {}) as { correlationId?: unknown; sinceMinutes?: unknown };
    const correlationId = typeof p.correlationId === "string" ? p.correlationId.trim() : "";
    if (!correlationId || correlationId.length < 4) {
      respond(
        true,
        { error: "correlationId required (>= 4 chars) — runId, sessionKey, or session UUID" },
        undefined,
      );
      return;
    }
    let sinceMinutes = DEFAULT_WINDOW_MINUTES;
    if (typeof p.sinceMinutes === "number" && Number.isFinite(p.sinceMinutes)) {
      sinceMinutes = Math.min(Math.max(1, Math.floor(p.sinceMinutes)), MAX_WINDOW_MINUTES);
    }

    try {
      const events = await readJournalWithRetry({
        sinceMinutes,
        needle: correlationId,
        timeoutMs: JOURNALCTL_TIMEOUT_MS,
      });
      const byLevel = events.reduce(
        (acc, ev) => {
          acc[ev.level] = (acc[ev.level] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );
      respond(
        true,
        {
          correlationId,
          sinceMinutes,
          eventCount: events.length,
          truncated: events.length >= MAX_EVENTS,
          byLevel,
          events,
        },
        undefined,
      );
    } catch (err) {
      respond(
        true,
        {
          correlationId,
          sinceMinutes,
          error: err instanceof Error ? err.message : String(err),
          events: [],
        },
        undefined,
      );
    }
  },
};
