import { esc } from "./amygdala-html.js";
import { assistantTextOfPayloadMessage } from "./error-bubble.js";
import { answerTextOf, outcomeOf, renderOutcomeBubble } from "./outcome-bubble.js";

const FLAGGED = /safeguards flagged|anthropic\.com\/legal\/aup/i;

/** Provider reports only, not ordinary assistant prose mentioning safeguards. */
export function providerSafeguardOutcome(message: unknown) {
  const m = message as Record<string, unknown> | null;
  if (!m || m.role !== "assistant") return null;
  const text = assistantTextOfPayloadMessage(m);
  const outcome = outcomeOf(m);
  // Old failed rows can contain a partial answer followed by the raw provider error.
  // A mid-message match requires a structured error signal; quoting an error in prose is not a block.
  const raw = /(?:^|\n)(API Error:[\s\S]*)$/i.exec(text);
  if (
    raw &&
    FLAGGED.test(raw[1]) &&
    (raw.index === 0 || m.stopReason === "error" || m.isError === true)
  ) {
    return {
      kind: "refusal" as const,
      recoverable: false,
      headline: "Provider safeguard blocked this message",
      detail: raw[1],
      source: "cli" as const,
    };
  }
  if (
    outcome &&
    (outcome.envelope?.category === "safeguard" || FLAGGED.test(outcome.detail ?? ""))
  ) {
    return { ...outcome, kind: "refusal" as const, recoverable: false };
  }
  const start = text.indexOf("__ERR_ENV__:");
  if (start >= 0) {
    try {
      const env = JSON.parse(text.slice(start + "__ERR_ENV__:".length));
      if (env && env.category === "safeguard") {
        return {
          kind: "refusal" as const,
          recoverable: false,
          headline: "Provider safeguard blocked this message",
          detail: typeof env.raw === "string" ? env.raw : text,
          source: "envelope" as const,
          envelope: env,
        };
      }
    } catch {
      // Not a complete envelope; the existing renderer owns it.
    }
  }
  return null;
}

export function renderProviderSafeguard(
  message: unknown,
  fold = "",
  renderAnswer: (text: string) => string = esc,
): string | null {
  const outcome = providerSafeguardOutcome(message);
  if (!outcome) return null;
  const text = assistantTextOfPayloadMessage(message);
  const rawStart =
    outcome.source === "cli" && outcome.detail ? text.lastIndexOf(outcome.detail) : -1;
  const answer = answerTextOf(rawStart >= 0 ? text.slice(0, rawStart) : text, outcome);
  return (
    (answer ? `<div class="msg assistant">${renderAnswer(answer)}</div>` : "") +
    renderOutcomeBubble(outcome, fold)
  );
}
