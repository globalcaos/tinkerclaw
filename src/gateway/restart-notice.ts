/**
 * FORK 2026-09-29 (TINKER_UI_DESIGN_BIBLE/lifecycles.md L4b) — the restart notice: a DISPLAY-ONLY
 * row in each chat a restart paused, so the architect sees what happened.
 *
 * It is a transcript `custom` entry, never a message: the model does not see it, and it cannot
 * become the transcript tail that `Agent.continue()` refuses (the old notice was a `chat.inject`
 * assistant row, which would have blocked every promptless resume). `chat.history` serves it as a
 * role:"system" row with `__openclaw.kind: "restart-notice"`, like a compaction banner, and restart
 * recovery's tail check already skips system rows.
 */
import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { resolveStateDir } from "../config/paths.js";

export const RESTART_NOTICE_CUSTOM_TYPE = "openclaw.restart-notice";

export type RestartNoticeHow = "continued" | "reattached" | "prompted";

export type RestartNoticeData = {
  /** When the old gateway stopped (ms). */
  stoppedAt?: number;
  /** When this chat was picked up again (ms). */
  backAt: number;
  /** Why the gateway restarted, when the stop said so (the restart skill's --reason). */
  reason?: string;
  how: RestartNoticeHow;
};

export function isRestartNoticeData(v: unknown): v is RestartNoticeData {
  if (!v || typeof v !== "object") {
    return false;
  }
  const d = v as Record<string, unknown>;
  return (
    typeof d.backAt === "number" &&
    (d.how === "continued" || d.how === "reattached" || d.how === "prompted")
  );
}

const HOW_TEXT: Record<RestartNoticeHow, string> = {
  continued: "continued where it stopped",
  reattached: "reattached to the running turn",
  prompted: "resumed with a restart message",
};

function hhmmss(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
}

export function describeRestartNotice(d: RestartNoticeData): string {
  const window = d.stoppedAt
    ? `paused ${hhmmss(d.stoppedAt)} → back ${hhmmss(d.backAt)}`
    : `back ${hhmmss(d.backAt)}`;
  return `Gateway restarted · ${window}${d.reason ? ` · ${d.reason}` : ""} · ${HOW_TEXT[d.how]}`;
}

/** The row chat.history serves (and the live broadcast carries). */
export function buildRestartNoticeRow(
  data: RestartNoticeData,
  meta: { id?: string; seq?: number; timestamp?: number },
): Record<string, unknown> {
  return {
    role: "system",
    content: [{ type: "text", text: describeRestartNotice(data) }],
    timestamp: meta.timestamp ?? data.backAt,
    __openclaw: {
      kind: "restart-notice",
      ...(meta.id ? { id: meta.id } : {}),
      ...(typeof meta.seq === "number" ? { seq: meta.seq } : {}),
      ...data,
    },
  };
}

export function appendRestartNoticeToTranscript(params: {
  transcriptPath: string;
  data: RestartNoticeData;
}): { ok: true; id: string } | { ok: false; error: string } {
  try {
    // SessionManager.open TRUNCATES a file with no session header: a notice must never cost a chat.
    // An EMPTY file is the exception, and a common one: a chat interrupted in its first turn has
    // nothing on disk yet (SessionManager writes only once an assistant message exists; live test
    // 2026-09-30). There is nothing to lose, and the open starts it with a header.
    const content = fs.readFileSync(params.transcriptPath, "utf8");
    if (content.length > 0) {
      let header: { type?: unknown } | null = null;
      try {
        header = JSON.parse(content.split("\n", 1)[0] ?? "") as { type?: unknown } | null;
      } catch {
        header = null;
      }
      if (header?.type !== "session") {
        return { ok: false, error: "transcript has no session header" };
      }
    }
    const manager = SessionManager.open(params.transcriptPath);
    const id = manager.appendCustomEntry(RESTART_NOTICE_CUSTOM_TYPE, params.data);
    // SessionManager defers every write until the transcript holds an assistant message, and a
    // chat cut in its first turn holds none: the notice would wait for an answer that may never
    // come. Its one line goes to disk now; the next writer loads it like any other entry.
    if (!fs.readFileSync(params.transcriptPath, "utf8").includes(`"id":"${id}"`)) {
      const entry = manager.getEntries().find((e) => e.id === id);
      if (entry) {
        fs.appendFileSync(params.transcriptPath, `${JSON.stringify(entry)}\n`);
      }
    }
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── the restart's context, written by the stop and read by boot recovery ─────────────────────────

type RestartContext = { stoppedAt: number; reason?: string };

function restartContextPath(): string {
  return path.join(resolveStateDir(process.env), "gateway-restart-context.json");
}

let notedReason: string | undefined;
/** `undefined` = not read yet this boot; `null` = read, there was none. */
let bootContext: RestartContext | null | undefined;

/** The restart skill's `--reason`, handed over by `gateway.drain`; the stop writes it down. */
export function noteRestartReason(reason: string | undefined): void {
  notedReason = reason?.trim() || undefined;
}

export function notedRestartReason(): string | undefined {
  return notedReason;
}

export function writeRestartContext(ctx: RestartContext): void {
  // An in-process restart keeps this module: the next boot must read the file this stop writes.
  bootContext = undefined;
  notedReason = undefined;
  try {
    fs.writeFileSync(restartContextPath(), JSON.stringify(ctx));
  } catch {
    // the notice then says only when the chat came back
  }
}

/** Read once per boot; a context older than a day is from some other stop. */
export function readRestartContext(now: number = Date.now()): RestartContext | undefined {
  try {
    const ctx = JSON.parse(fs.readFileSync(restartContextPath(), "utf8")) as RestartContext;
    if (typeof ctx.stoppedAt === "number" && now - ctx.stoppedAt < 24 * 3600_000) {
      return ctx;
    }
  } catch {
    // no context: an unclean stop
  }
  return undefined;
}

/**
 * The last stop's context for this boot: read once and removed, so every chat recovered in this
 * boot gets the same one and a later crash (which writes none) never reuses it.
 */
export function takeRestartContext(now: number = Date.now()): RestartContext | undefined {
  if (bootContext === undefined) {
    bootContext = readRestartContext(now) ?? null;
    try {
      fs.rmSync(restartContextPath(), { force: true });
    } catch {
      // read-only state dir: the 24 h bound still retires it
    }
  }
  return bootContext ?? undefined;
}

export const __testing = {
  reset(): void {
    bootContext = undefined;
    notedReason = undefined;
  },
};
