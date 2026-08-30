// FORK 2026-08-18 — feature (the architect): "If a process is attached to a tab and it prevents me to send
// more prompts, instead of setting up timers and watchdogs I would prefer if it was shown as a
// progress indicator with a stop button, so I can kill it or understand it better. The more
// background activity we bring to the ui, with controls, the better it is going to be flowing."
//
// This module holds the PURE rules behind the ATTACHED ACTIVITY strip that renders directly above
// the composer: how an age is written, what order the rows sit in, what the button says, and — the
// one that must never be got wrong — whether a stop attempt SUCCEEDED or was REFUSED. app.ts owns
// the poll, the markup and the DOM; it imports every decision from here.
//
// DOM-free and global-free on purpose, the same extraction precedent as outbox.ts / queued-sends.ts
// / msg-order.ts: app.ts is a 23k-line browser entry that cannot be unit-tested, so a rule left
// inlined there is a rule with no test.

/** What kind of thing is holding the tab. */
export type AttachmentKind = "run" | "queued" | "process";

/** One row of `sessions.attachments`. Mirrors the gateway DTO exactly — do not add derived fields
 *  here; derive them in the functions below so there is one place to test. */
export type Attachment = {
  id: string;
  kind: AttachmentKind;
  label: string;
  detail?: string;
  /** Gateway wall clock. Present for display/debug only — NEVER used to compute a live age; see
   *  liveAgeMs() for why. */
  startedAt?: number;
  /** Age in ms AS MEASURED BY THE GATEWAY at the moment of the reply. */
  ageMs: number;
  pid?: number;
  stoppable: boolean;
};

export type AttachmentStopAction = "aborted" | "terminated" | "killed" | "gone" | "refused";

export type AttachmentStopResult = {
  stopped: boolean;
  action: AttachmentStopAction;
  detail?: string;
};

/**
 * The age to PAINT right now for a row fetched `fetchedAtClientMs` ago.
 *
 * LOAD-BEARING: this anchors on the GATEWAY's `ageMs` at fetch time plus CLIENT-side elapsed. It
 * must never be computed as `now - startedAt`. `startedAt` is the gateway's wall clock; the
 * browser's can sit minutes away from it (a laptop resuming from sleep, a container with a drifting
 * clock), and a skewed subtraction prints a permanently wrong — or negative — age on a row whose
 * entire purpose is to tell the user how long something has been stuck.
 *
 * A clock that jumps BACKWARDS (NTP correction) yields a negative elapsed; we hold the last known
 * age rather than shrinking it, because an age that counts down reads as a bug.
 */
export function liveAgeMs(
  ageMsAtFetch: number,
  fetchedAtClientMs: number,
  nowClientMs: number,
): number {
  const base = Number.isFinite(ageMsAtFetch) ? Math.max(0, ageMsAtFetch) : 0;
  const elapsed = nowClientMs - fetchedAtClientMs;
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return base;
  }
  return base + elapsed;
}

/**
 * Human age for one row. Three bands, matching the mock the architect approved:
 *   >= 1h  -> "13h55m"   minutes zero-padded so a ticking readout keeps a constant width
 *   >= 1m  -> "12m 37s"  seconds zero-padded for the same reason
 *   <  1m  -> "45s"
 * Anything non-finite or non-positive is "0s", never "" and never "NaNs": a blank age on a row that
 * exists reads as "unknown", and the row exists precisely because something is running.
 */
export function formatAttachmentAge(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0s";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${h}h${String(m).padStart(2, "0")}m`;
  }
  if (m > 0) {
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }
  return `${s}s`;
}

/** Filled dot for something actually consuming the tab; hollow for something merely waiting. */
export function attachmentDotFilled(a: Attachment): boolean {
  return a.kind === "run" || a.kind === "process";
}

/** "Stop" ends work in progress; "Clear" discards work that has not started. Different verbs
 *  because they are different acts — clearing a queued prompt destroys nothing that ran. */
export function attachmentButtonLabel(a: Attachment): "Stop" | "Clear" {
  return a.kind === "queued" ? "Clear" : "Stop";
}

/** Tooltip for the button. When `stoppable` is false the tooltip is the ONLY explanation the user
 *  gets for a dead control, so it must say why rather than merely being absent. */
export function stopButtonTitle(a: Attachment): string {
  if (!a.stoppable) {
    return a.detail
      ? `Cannot be stopped from here — ${a.detail}`
      : "Cannot be stopped from here: the gateway holds no handle for this activity";
  }
  return a.kind === "queued" ? `Discard this queued prompt: ${a.label}` : `Stop ${a.label}`;
}

// Kind ordering: what is running now, then what is running beside it, then what has not started.
// Typed as Record<string, number> rather than Record<AttachmentKind, number> on purpose — the value
// arrives over the wire, so an unknown kind is reachable and must sort somewhere deterministic
// instead of producing NaN comparisons that make the sort order implementation-defined.
const ATTACHMENT_KIND_RANK: Record<string, number> = { run: 0, process: 1, queued: 2 };
const ATTACHMENT_KIND_RANK_UNKNOWN = 3;

/**
 * Row order: by kind (run, process, queued), then OLDEST FIRST inside a kind, then by id.
 *
 * Oldest first is the point of the strip — the thing that has been holding the tab for 13h is the
 * thing the user is looking for, and it must not sink below a run that started a second ago.
 * The id tiebreak keeps the order stable across polls so a row cannot swap places under a pointer
 * that is already on its Stop button.
 *
 * Returns a NEW array; the caller's state is never reordered in place.
 */
export function sortAttachments(rows: readonly Attachment[]): Attachment[] {
  return rows.slice().sort((a, b) => {
    const ka = ATTACHMENT_KIND_RANK[a.kind] ?? ATTACHMENT_KIND_RANK_UNKNOWN;
    const kb = ATTACHMENT_KIND_RANK[b.kind] ?? ATTACHMENT_KIND_RANK_UNKNOWN;
    if (ka !== kb) {
      return ka - kb;
    }
    if (a.ageMs !== b.ageMs) {
      return b.ageMs - a.ageMs;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export type StopOutcome = {
  /** True when the activity is gone (or was already gone). */
  ok: boolean;
  /** Which colour lane the message reads in. */
  tone: "ok" | "warn";
  /** What to show the user. Never empty. */
  text: string;
};

/**
 * Classify a `sessions.attachmentStop` reply.
 *
 * THE RULE THAT MATTERS: a refusal is never silent. `refused` always surfaces, always in the warn
 * lane, and always carries the gateway's `detail` when there is one — that reply is the case where
 * the user pressed Stop and nothing happened, which is exactly the experience this feature exists
 * to remove.
 *
 * `stopped: false` alongside a stop verb is also a warning, not a success. The verb describes what
 * was ATTEMPTED; the flag describes what HAPPENED, and when the two disagree we believe the flag —
 * reading "terminated" off a process that is still alive is worse than reading nothing.
 *
 * An unrecognised action warns rather than passing: a gateway that grows a new outcome we do not
 * understand must not have it silently rendered as success.
 */
export function classifyStopOutcome(res: AttachmentStopResult | null | undefined): StopOutcome {
  const detail = res && typeof res.detail === "string" ? res.detail.trim() : "";
  const action = res && typeof res.action === "string" ? res.action : "";
  if (!res || action === "") {
    return { ok: false, tone: "warn", text: detail || "no answer from the gateway" };
  }
  if (action === "refused") {
    return {
      ok: false,
      tone: "warn",
      text: detail ? `refused — ${detail}` : "refused (no reason given)",
    };
  }
  if (action === "gone") {
    return { ok: true, tone: "ok", text: detail || "already gone" };
  }
  if (action === "aborted" || action === "terminated" || action === "killed") {
    if (res.stopped === false) {
      return {
        ok: false,
        tone: "warn",
        text: detail
          ? `${action} reported, but not stopped — ${detail}`
          : `${action} reported, but not stopped`,
      };
    }
    return { ok: true, tone: "ok", text: detail || action };
  }
  return {
    ok: false,
    tone: "warn",
    text: detail ? `unknown outcome "${action}" — ${detail}` : `unknown outcome "${action}"`,
  };
}
