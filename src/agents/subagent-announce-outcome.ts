import type { AgentInternalEventStatus } from "./internal-event-contract.js";

/**
 * FORK 2026-09-07 — the announce path's two facts, told apart.
 *
 * `status: "ok"` is a TRANSPORT fact: the child ended without erroring. Whether it produced
 * anything is a SEPARATE fact, and until now the announce collapsed the two — an `ok` child
 * that returned an empty string was announced as "completed successfully", the literal
 * "(no output)" was substituted for the body, and the parent was told to "convert the result
 * above into your normal assistant voice and send that user-facing update now".
 *
 * Measured: subagent `saica-video-audit` (2026-09-03, SerraVision) ran 3s, spent 0 tokens
 * (in 0 / out 0), returned nothing — and was reported to the owner as a success. The audit it
 * was spawned for never ran, and a full parent turn was billed to say so in vague words.
 *
 * Kept pure and separate from subagent-announce.ts so the rule is unit-testable without
 * standing up an announce flow.
 */
export const EMPTY_RESULT_PLACEHOLDER = "(no output)";

export type AnnounceOutcomeDescription = {
  /** Human phrase for the `status:` line of the internal event. */
  statusLabel: string;
  /** The body to embed, with the placeholder substituted when there is nothing. */
  findings: string;
  /** True ONLY for a transport-ok child that produced nothing at all. */
  producedNoOutput: boolean;
};

export function describeAnnounceOutcome(params: {
  status: AgentInternalEventStatus;
  error?: string;
  rawFindings?: string;
}): AnnounceOutcomeDescription {
  const raw = params.rawFindings ?? "";
  // Whitespace is not output. A child that returns "\n" told us exactly as much as one that
  // returned "".
  const producedNoOutput = params.status === "ok" && raw.trim().length === 0;
  const findings = raw.trim().length > 0 ? raw : EMPTY_RESULT_PLACEHOLDER;

  if (producedNoOutput) {
    return {
      statusLabel: "completed with no output",
      findings,
      producedNoOutput: true,
    };
  }

  // The pre-existing ladder, unchanged. These statuses already tell the truth; an empty body
  // on top of a timeout or an error adds nothing the label does not already say.
  const statusLabel =
    params.status === "ok"
      ? "completed successfully"
      : params.status === "timeout"
        ? "timed out"
        : params.status === "error"
          ? `failed: ${params.error || "unknown error"}`
          : "finished with unknown status";

  return { statusLabel, findings, producedNoOutput: false };
}

/**
 * Replaces the normal "convert the result into your assistant voice" instruction when there is
 * no result to convert. Saying this plainly is both cheaper and honest: the parent reports the
 * empty outcome in one line instead of composing an update out of a placeholder.
 */
export function buildEmptyResultReplyInstruction(announceType: string): string {
  return [
    `A ${announceType} finished but produced no output at all.`,
    "Tell the user plainly, in one short line, that it returned no result — name the task.",
    "Do not invent findings, do not describe work that was not reported, and do not present",
    "this as a completed piece of work. Keep this internal context private (don't mention",
    "system/log/stats/session details or announce type).",
  ].join(" ");
}
