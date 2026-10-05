/**
 * FORK 2026-09-29 (chat-usage-outcome U5 — jarvis-icu
 * docs/superpowers/plans/2026-09-29-chat-usage-chips-and-typed-outcomes.md).
 *
 * Two contracts are pinned here.
 *
 * (a) THE SPLIT. The agent-started backstop used to join EVERY delivered final
 *     payload's text into one string and flag the whole thing `isError` as soon
 *     as ANY payload carried `isError: true`. The producer
 *     (src/agents/embedded-agent-runner/run/payloads.ts) pushes
 *     `{ text: errorText, isError: true }` AFTER the assistant text, so a turn
 *     that answered normally and then had one tool call fail was served as a
 *     single red bubble whose body was the real answer — 16 of them in the
 *     2026-09-29 census. The answer and the error are two messages now, and the
 *     answer carries neither the flag nor an outcome.
 *
 * (b) THE TYPE. Gateway-injected failures ("⚠️ Agent failed before reply: …",
 *     "⚠️ All models are temporarily rate-limited …", the overload / 402 credits
 *     copy, and a "/model" ack followed by the rate-limit line) are plain
 *     assistant text with `stopReason: "stop"`. They carry a typed `outcome`
 *     now, so the UI never takes one for an answer. The field rides INSIDE
 *     `message`, whose schema is open — the chat event schema is untouched.
 *
 * The old behaviour is pinned alongside the new: an error-only turn still yields
 * ONE flagged message, a clean turn is untouched, and the silent-reply token is
 * still broadcast-but-not-persisted.
 */
import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import {
  buildBackstopFinalMessages,
  outcomeForInjectedText,
  splitFinalPayloadsForDisplay,
} from "./chat.js";

const ANSWER = "Here is the summary you asked for.";
const EDIT_FAILED = "⚠️ Edit(src/app.ts) failed: string not found in file";
const RATE_LIMITED = "⚠️ All models are temporarily rate-limited. Ready in about 5 minutes.";
const MODEL_ACK = "Model set to claude-code/claude-fable-5.";
const MODEL_ACK_THEN_RATE_LIMIT = `${MODEL_ACK}\n\n⚠️ Rate-limited — ready in 5m`;

function payload(text: string, isError?: boolean): ReplyPayload {
  return isError ? { text, isError: true } : { text };
}

describe("splitFinalPayloadsForDisplay", () => {
  it("separates a real answer from the failure line that trails it", () => {
    expect(splitFinalPayloadsForDisplay([payload(ANSWER), payload(EDIT_FAILED, true)])).toEqual({
      answerText: ANSWER,
      errorText: EDIT_FAILED,
    });
  });

  it("joins several answer parts, and several error parts, separately", () => {
    expect(
      splitFinalPayloadsForDisplay([
        payload("first"),
        payload("boom", true),
        payload("second"),
        payload("bang", true),
      ]),
    ).toEqual({ answerText: "first\n\nsecond", errorText: "boom\n\nbang" });
  });

  it("returns only an answer for a clean turn", () => {
    expect(splitFinalPayloadsForDisplay([payload(ANSWER)])).toEqual({ answerText: ANSWER });
  });

  it("returns only an error for a failed turn", () => {
    expect(splitFinalPayloadsForDisplay([payload(RATE_LIMITED, true)])).toEqual({
      errorText: RATE_LIMITED,
    });
  });

  it("ignores blank and text-less payloads — a flagged payload with no text used to redden the answer on its own", () => {
    expect(splitFinalPayloadsForDisplay([{ mediaUrl: "x" }, payload("   "), undefined])).toEqual(
      {},
    );
    expect(splitFinalPayloadsForDisplay([payload(ANSWER), { isError: true }])).toEqual({
      answerText: ANSWER,
    });
  });
});

describe("outcomeForInjectedText", () => {
  it("types the gateway rate-limit copy as rate_limit", () => {
    const outcome = outcomeForInjectedText(RATE_LIMITED, { isError: true });
    expect(outcome?.kind).toBe("rate_limit");
    expect(outcome?.recoverable).toBe(true);
  });

  it("types a /model ack followed by the rate-limit line as rate_limit, unflagged", () => {
    // The ack is delivered as a "block" payload with no isError flag; the
    // skip-line rule steps over "Model set to …" and classifies the line after it.
    const outcome = outcomeForInjectedText(MODEL_ACK_THEN_RATE_LIMIT);
    expect(outcome?.kind).toBe("rate_limit");
    expect(outcome?.recoverable).toBe(true);
  });

  it("leaves a bare /model ack untyped — a command ack is an answer", () => {
    expect(outcomeForInjectedText(MODEL_ACK)).toBeUndefined();
  });

  it("types a flagged failure that is not error-shaped rather than serving it untyped", () => {
    const outcome = outcomeForInjectedText("Edit failed: string not found", { isError: true });
    expect(outcome?.kind).toBe("error");
    expect(outcome?.recoverable).toBe(false);
  });

  it("leaves a real answer that merely mentions a rate limit alone (review focus 1)", () => {
    expect(
      outcomeForInjectedText(
        "The provider docs say a 429 rate limit applies per organisation, not per key.",
      ),
    ).toBeUndefined();
  });

  it("returns undefined for empty text, so a media-only reply is never called 'No answer'", () => {
    expect(outcomeForInjectedText("   ")).toBeUndefined();
    expect(outcomeForInjectedText("")).toBeUndefined();
  });
});

/**
 * CONTROL: the pre-U5 backstop, verbatim in behaviour (join every final
 * payload's text, flag the whole message if ANY payload is flagged). Kept here
 * so the fixture below is proven to trigger the defect: against the old
 * algorithm the real answer lands inside a single `isError` message.
 */
function legacyBackstopMessage(
  payloads: ReadonlyArray<ReplyPayload | undefined>,
): Record<string, unknown> | undefined {
  const text =
    payloads
      .map((p) => (typeof p?.text === "string" ? p.text.trim() : ""))
      .filter(Boolean)
      .join("\n\n") || undefined;
  const isError = payloads.some((p) => p?.isError === true);
  return text
    ? {
        role: "assistant",
        content: [{ type: "text", text }],
        text,
        ...(isError ? { isError: true } : {}),
      }
    : undefined;
}

describe("buildBackstopFinalMessages", () => {
  it("CONTROL: the old join painted the real answer as an error on this very fixture", () => {
    const legacy = legacyBackstopMessage([payload(ANSWER), payload(EDIT_FAILED, true)]);
    expect(legacy?.isError).toBe(true);
    expect(legacy?.text).toBe(`${ANSWER}\n\n${EDIT_FAILED}`);
  });

  it("answer + trailing edit-failed error → two messages, and the answer is not an error", () => {
    const out = buildBackstopFinalMessages([payload(ANSWER), payload(EDIT_FAILED, true)], {
      now: 1000,
    });

    // The turn's own final is the ANSWER: no isError, no outcome, so the client
    // keeps treating it as the success it is and cancels the retry ladder.
    expect(out.final).toEqual({
      role: "assistant",
      content: [{ type: "text", text: ANSWER }],
      text: ANSWER,
      timestamp: 1000,
      stopReason: "stop",
      usage: { input: 0, output: 0, totalTokens: 0 },
    });
    expect(out.final?.isError).toBeUndefined();
    expect(out.final?.outcome).toBeUndefined();

    // The error is a SECOND message, flagged and typed.
    expect(out.injectedError?.isError).toBe(true);
    expect(out.injectedError?.text).toBe(EDIT_FAILED);
    expect((out.injectedError?.outcome as { kind?: string } | undefined)?.kind).toBe("error");

    // Only the error is persisted; the answer is already on disk from the runtime.
    expect(out.persistText).toBe(EDIT_FAILED);
  });

  it("pure rate-limit error → ONE message, flagged, with outcome rate_limit", () => {
    const out = buildBackstopFinalMessages([payload(RATE_LIMITED, true)], { now: 1000 });

    expect(out.injectedError).toBeUndefined();
    expect(out.final?.isError).toBe(true);
    expect(out.final?.text).toBe(RATE_LIMITED);
    expect(out.outcome?.kind).toBe("rate_limit");
    expect(out.outcome?.recoverable).toBe(true);
    expect((out.final?.outcome as { kind?: string } | undefined)?.kind).toBe("rate_limit");
    expect(out.persistText).toBe(RATE_LIMITED);
  });

  it("a /model ack followed by the rate-limit copy is typed rate_limit", () => {
    const out = buildBackstopFinalMessages([payload(MODEL_ACK_THEN_RATE_LIMIT, true)]);
    expect(out.outcome?.kind).toBe("rate_limit");
  });

  it("a clean turn is untouched: one final, no flag, no outcome, nothing persisted", () => {
    const out = buildBackstopFinalMessages([payload(ANSWER)], { now: 1000 });
    expect(out.final?.text).toBe(ANSWER);
    expect(out.final?.isError).toBeUndefined();
    expect(out.outcome).toBeUndefined();
    expect(out.persistText).toBeUndefined();
    expect(out.injectedError).toBeUndefined();
  });

  it("no deliverable payloads → no message at all, so the spinner still clears", () => {
    expect(buildBackstopFinalMessages([])).toEqual({});
  });

  it("still broadcasts the silent-reply token, and neither persists nor types it", () => {
    const out = buildBackstopFinalMessages([payload(SILENT_REPLY_TOKEN, true)]);
    expect(out.final?.text).toBe(SILENT_REPLY_TOKEN);
    expect(out.persistText).toBeUndefined();
    expect(out.outcome).toBeUndefined();
    expect(out.final?.outcome).toBeUndefined();
  });
});
