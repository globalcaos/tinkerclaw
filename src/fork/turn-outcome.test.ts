import { describe, expect, it } from "vitest";
import { buildErrorEnvelope } from "./error-envelope.js";
import {
  classifyAssistantOutcome,
  classifyErrorText,
  ERROR_ENVELOPE_MARKER,
  isTurnOutcome,
  outcomeFromEnvelope,
  splitErrorEnvelope,
  type TurnOutcome,
} from "./turn-outcome.js";

/**
 * FORK 2026-09-29 — typed turn outcomes (plan:
 * 2026-09-29-chat-usage-chips-and-typed-outcomes.md). The classifyErrorText
 * rows are tested with REAL provider strings captured in the 2026-09-29
 * census, not synthetic tokens — same discipline as error-envelope.test.ts.
 */

// FORK 2026-10-05 — recoverable means "a retry within the ladder's 15 minutes can succeed". A limit
// whose window resets in hours or days is not, whatever its kind (src/shared/usage-window.ts).
describe("a usage window no retry can outlast is not recoverable", () => {
  const weeklyRaw = "You've hit your weekly limit · resets Oct 8, 6pm (Europe/Madrid)";

  it("the envelope the gateway builds now, and one an older gateway stamped non-fatal", () => {
    const fresh = outcomeFromEnvelope(buildErrorEnvelope({ raw: weeklyRaw }));
    expect(fresh.kind).toBe("rate_limit");
    expect(fresh.recoverable).toBe(false);
    expect(fresh.retryAfter).toBeUndefined();
    const older = outcomeFromEnvelope({
      ...buildErrorEnvelope({ raw: weeklyRaw }),
      fatal: false,
    });
    expect(older.recoverable).toBe(false);
  });

  it("a 5-hour usage limit read from text; a burst limit stays recoverable", () => {
    const fiveHour = classifyErrorText("5-hour usage limit reached · resets 3pm");
    expect(fiveHour.kind).toBe("quota");
    expect(fiveHour.recoverable).toBe(false);
    const burst = classifyErrorText("429 Too Many Requests");
    expect(burst.kind).toBe("rate_limit");
    expect(burst.recoverable).toBe(true);
    expect(
      outcomeFromEnvelope(buildErrorEnvelope({ raw: "429 Too Many Requests" })).recoverable,
    ).toBe(true);
  });
});

describe("classifyErrorText — the plan's mapping table, real strings", () => {
  it("usage limit → quota, recoverable, retryAfter from the reset parser", () => {
    const out = classifyErrorText(
      "You have hit your ChatGPT usage limit (plus plan). Try again in ~264 min.",
    );
    expect(out.kind).toBe("quota");
    expect(out.recoverable).toBe(true);
    expect(out.retryAfter).toBe(264 * 60);
    expect(out.detail).toContain("usage limit");
  });

  it("network row: terminated / fetch failed / Connection error.", () => {
    for (const raw of ["terminated", "fetch failed", "Connection error."]) {
      const out = classifyErrorText(raw);
      expect(out.kind).toBe("network");
      expect(out.recoverable).toBe(true);
    }
  });

  it("overload: at capacity / high demand", () => {
    const out = classifyErrorText("The model is currently at capacity due to high demand");
    expect(out.kind).toBe("overload");
    expect(out.recoverable).toBe(true);
  });

  it("529 copy whose NEGATION contains 'usage limit' stays overload, not quota", () => {
    const out = classifyErrorText(
      "Server is temporarily limiting requests (not your usage limit) · Rate limited",
    );
    expect(out.kind).toBe("overload");
  });

  it("auth: 403 + requires-you-to-complete", () => {
    const out = classifyErrorText(
      "403 This model requires you to complete the following before use: 18+",
    );
    expect(out.kind).toBe("auth");
    expect(out.recoverable).toBe(false);
  });

  it("context overflow: maximum prompt length", () => {
    const out = classifyErrorText(
      '400 "This model\'s maximum prompt length is 500000 tokens, but the request contains 512000 tokens"',
    );
    expect(out.kind).toBe("context_overflow");
    expect(out.recoverable).toBe(false);
  });

  it("refusal: safeguards flagged", () => {
    const out = classifyErrorText(
      "API Error: the response was blocked because Claude Code's safeguards flagged this request",
    );
    expect(out.kind).toBe("refusal");
    expect(out.recoverable).toBe(false);
  });

  it("refusal row does NOT swallow connection refused (network)", () => {
    expect(classifyErrorText("connect ECONNREFUSED 127.0.0.1:443").kind).toBe("network");
    expect(classifyErrorText("connection refused by remote host").kind).toBe("network");
  });

  it("timeout: LLM idle timeout", () => {
    const out = classifyErrorText("LLM idle timeout (120s): no response from model");
    expect(out.kind).toBe("timeout");
    expect(out.recoverable).toBe(true);
  });

  it("aborted: This operation was aborted", () => {
    const out = classifyErrorText("This operation was aborted");
    expect(out.kind).toBe("aborted");
    expect(out.recoverable).toBe(false);
  });

  it("rate limit: 429 with a relative reset", () => {
    const out = classifyErrorText("429 too many requests. Try again in 30 seconds.");
    expect(out.kind).toBe("rate_limit");
    expect(out.recoverable).toBe(true);
    expect(out.retryAfter).toBe(30);
  });

  it("billing: credit balance", () => {
    const out = classifyErrorText("Your credit balance is too low to access the Anthropic API");
    expect(out.kind).toBe("billing");
    expect(out.recoverable).toBe(false);
  });

  it("anything else → error, not recoverable; source override honoured", () => {
    const out = classifyErrorText("some inscrutable failure", { source: "cli" });
    expect(out.kind).toBe("error");
    expect(out.recoverable).toBe(false);
    expect(out.source).toBe("cli");
  });

  it("never throws and caps detail at 2000 chars", () => {
    expect(classifyErrorText(null as unknown as string).kind).toBe("error");
    expect(classifyErrorText("").detail).toBeUndefined();
    const long = classifyErrorText(`fetch failed ${"x".repeat(3000)}`);
    expect(long.detail?.length).toBeLessThanOrEqual(2000);
  });
});

describe("splitErrorEnvelope", () => {
  const env = buildErrorEnvelope({ code: "rate_limited", raw: "429 rate limit" });
  const json = JSON.stringify(env);

  it("no marker → whole text as before, envelope null", () => {
    const r = splitErrorEnvelope("just an answer");
    expect(r.before).toBe("just an answer");
    expect(r.envelope).toBeNull();
    expect(r.after).toBe("");
  });

  it("envelope alone", () => {
    const r = splitErrorEnvelope(`${ERROR_ENVELOPE_MARKER}${json}`);
    expect(r.before).toBe("");
    expect(r.envelope?.category).toBe("rate_limit");
    expect(r.after).toBe("");
  });

  it("keeps the partial answer that streamed before the envelope", () => {
    const r = splitErrorEnvelope(
      `Here is the start of a real answer.\n\n${ERROR_ENVELOPE_MARKER}${json}`,
    );
    expect(r.before).toBe("Here is the start of a real answer.");
    expect(r.envelope).not.toBeNull();
  });

  it("[system] preamble lands in before; trailing text lands in after", () => {
    const r = splitErrorEnvelope(`[system]\n\n${ERROR_ENVELOPE_MARKER}${json}\ntail`);
    expect(r.before).toBe("[system]");
    expect(r.envelope).not.toBeNull();
    expect(r.after).toBe("tail");
  });

  it("unparseable payload → envelope null, never a throw", () => {
    const r = splitErrorEnvelope(`${ERROR_ENVELOPE_MARKER}{not json`);
    expect(r.envelope).toBeNull();
  });
});

describe("outcomeFromEnvelope", () => {
  it("rate_limited envelope → recoverable rate_limit carrying the envelope", () => {
    const env = buildErrorEnvelope({ code: "rate_limited", raw: "429. Try again in 30 seconds." });
    const out = outcomeFromEnvelope(env);
    expect(out.kind).toBe("rate_limit");
    expect(out.recoverable).toBe(true);
    expect(out.source).toBe("envelope");
    expect(out.envelope).toBe(env);
    expect(out.headline).toBe(env.headline);
    expect(out.retryAfter).toBe(30);
  });

  it("fatal auth envelope → auth, not recoverable", () => {
    const env = buildErrorEnvelope({ code: "auth_401_invalid_credentials", raw: "401" });
    const out = outcomeFromEnvelope(env);
    expect(out.kind).toBe("auth");
    expect(out.recoverable).toBe(false);
  });

  it("interrupted (user stop) envelope → aborted, never recoverable", () => {
    const env = buildErrorEnvelope({
      raw: "claude subprocess exited (code=null signal=SIGTERM reason=[AbortError: Reply operation aborted by user]) stderr=",
    });
    expect(env.category).toBe("interrupted");
    const out = outcomeFromEnvelope(env);
    expect(out.kind).toBe("aborted");
    expect(out.recoverable).toBe(false);
  });
});

describe("classifyAssistantOutcome — rules 1-9", () => {
  const validOutcome: TurnOutcome = {
    kind: "rate_limit",
    recoverable: true,
    headline: "Rate limited",
    source: "injected",
  };

  it("rule 1: a message that already has a valid outcome returns it unchanged", () => {
    const msg = { role: "assistant", content: "whatever", outcome: validOutcome };
    expect(classifyAssistantOutcome(msg)).toBe(validOutcome);
  });

  it("rule 2 + rule 9: non-assistant and garbage → null", () => {
    expect(classifyAssistantOutcome({ role: "user", content: "hi" })).toBeNull();
    expect(classifyAssistantOutcome(null)).toBeNull();
    expect(classifyAssistantOutcome(42)).toBeNull();
    expect(classifyAssistantOutcome({})).toBeNull();
  });

  it("rule 3: stopReason error prefers errorMessage over the placeholder text", () => {
    const out = classifyAssistantOutcome({
      role: "assistant",
      content: "[assistant turn failed before producing content]",
      stopReason: "error",
      errorMessage: "You have hit your ChatGPT usage limit (plus plan). Try again in ~264 min.",
    });
    expect(out?.kind).toBe("quota");
    expect(out?.source).toBe("stop-reason");
    expect(out?.detail).toContain("usage limit");
    expect(out?.detail).not.toContain("[assistant turn failed");
  });

  it("rule 4: aborted stop", () => {
    const out = classifyAssistantOutcome({
      role: "assistant",
      content: "partial text",
      stopReason: "aborted",
    });
    expect(out?.kind).toBe("aborted");
    expect(out?.recoverable).toBe(false);
    expect(out?.headline).toBe("Stopped");
    expect(out?.source).toBe("stop-reason");
  });

  it("rule 5: envelope alone → envelope-sourced outcome", () => {
    const env = buildErrorEnvelope({ code: "rate_limited", raw: "429 rate limit" });
    const out = classifyAssistantOutcome({
      role: "assistant",
      content: `${ERROR_ENVELOPE_MARKER}${JSON.stringify(env)}`,
    });
    expect(out?.kind).toBe("rate_limit");
    expect(out?.source).toBe("envelope");
    expect(out?.envelope?.category).toBe("rate_limit");
  });

  it("rule 5: envelope after a partial answer classifies, and the split keeps the answer", () => {
    const env = buildErrorEnvelope({ code: "overloaded", raw: "529 overloaded" });
    const text = `The answer began streaming here.\n\n${ERROR_ENVELOPE_MARKER}${JSON.stringify(env)}`;
    const out = classifyAssistantOutcome({ role: "assistant", content: text });
    expect(out?.kind).toBe("overload");
    expect(splitErrorEnvelope(text).before).toBe("The answer began streaming here.");
  });

  it("rule 6: flagged, error-shaped first line → injected outcome", () => {
    const out = classifyAssistantOutcome({
      role: "assistant",
      content: "⚠️ All models are temporarily rate-limited — next attempt shortly.",
      isError: true,
    });
    expect(out?.kind).toBe("rate_limit");
    expect(out?.source).toBe("injected");
  });

  it("rule 6: an answer with a trailing flagged error line is NOT an outcome", () => {
    const out = classifyAssistantOutcome({
      role: "assistant",
      content: [
        { type: "text", text: "Here is the fix I applied to the config." },
        { type: "text", text: "⚠️ 📝 Edit /tmp/x failed: old_string not found", isError: true },
      ],
      stopReason: "stop",
    });
    expect(out).toBeNull();
  });

  it("rule 7: gateway wording after a Model set to preamble, no flags", () => {
    const out = classifyAssistantOutcome({
      role: "assistant",
      content: "Model set to claude-opus-4-8\n\n⚠️ Rate-limited — ready in 5m",
      stopReason: "stop",
    });
    expect(out?.kind).toBe("rate_limit");
    expect(out?.source).toBe("injected");
  });

  it("rule 7 guards: tool blocks or long text keep a real answer an answer", () => {
    const withTools = classifyAssistantOutcome({
      role: "assistant",
      content: [
        { type: "text", text: "⚠️ Rate-limited APIs need budgeting; here is the plan." },
        { type: "toolCall", name: "exec", arguments: { command: "ls" } },
      ],
      stopReason: "toolUse",
    });
    expect(withTools).toBeNull();
    const longText = classifyAssistantOutcome({
      role: "assistant",
      content: `⚠️ Rate-limited — a full explanation of rate limit design follows.\n${"a".repeat(1300)}`,
      stopReason: "stop",
    });
    expect(longText).toBeNull();
  });

  it("rule 8: empty stop and thinking-only → empty; missing stopReason too", () => {
    for (const msg of [
      { role: "assistant", content: [], stopReason: "stop" },
      { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }], stopReason: "stop" },
      { role: "assistant" },
    ]) {
      const out = classifyAssistantOutcome(msg);
      expect(out?.kind).toBe("empty");
      expect(out?.recoverable).toBe(false);
      expect(out?.source).toBe("empty");
    }
  });

  it("rule 9: a toolUse message with no text is not an outcome", () => {
    const out = classifyAssistantOutcome({
      role: "assistant",
      content: [{ type: "toolCall", name: "read", arguments: {} }],
      stopReason: "toolUse",
    });
    expect(out).toBeNull();
    const projected = classifyAssistantOutcome({
      role: "assistant",
      content: [{ type: "tool_use", name: "read", input: {} }],
      stopReason: "toolUse",
    });
    expect(projected).toBeNull();
  });
});

describe("isTurnOutcome", () => {
  it("accepts a well-formed outcome and rejects malformed ones", () => {
    expect(isTurnOutcome({ kind: "quota", recoverable: true, headline: "x", source: "cli" })).toBe(
      true,
    );
    expect(isTurnOutcome(null)).toBe(false);
    expect(isTurnOutcome({ kind: "quota", headline: "x", source: "cli" })).toBe(false);
    expect(isTurnOutcome({ kind: "bogus", recoverable: true, headline: "x", source: "cli" })).toBe(
      false,
    );
    expect(isTurnOutcome({ kind: "quota", recoverable: true, headline: "", source: "cli" })).toBe(
      false,
    );
    expect(isTurnOutcome({ kind: "quota", recoverable: true, headline: "x", source: "nope" })).toBe(
      false,
    );
  });
});
