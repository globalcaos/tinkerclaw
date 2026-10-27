import { describe, expect, test } from "vitest";
import { buildErrorEnvelope } from "../fork/error-envelope.js";
import { ERROR_ENVELOPE_MARKER, type TurnOutcome } from "../fork/turn-outcome.js";
import {
  projectChatDisplayMessage,
  projectChatDisplayMessages,
  projectRecentChatDisplayMessages,
} from "./chat-display-projection.js";

/**
 * FORK 2026-09-29 — typed turn outcomes on the display projection (plan:
 * jarvis-icu docs/superpowers/plans/2026-09-29-chat-usage-chips-and-typed-outcomes.md, U2).
 * projectChatDisplayMessage(s) is the one projection for chat.history rows AND the chat.ts live
 * finals, so every assistant row it serves carries `outcome` whenever turn-outcome classifies it.
 * The usage-limit string is the real one from the 2026-09-07 / 2026-09-29 censuses.
 */

type Row = Record<string, unknown> & {
  content?: unknown;
  text?: unknown;
  outcome?: TurnOutcome;
};

const USAGE_LIMIT_RAW = "You have hit your ChatGPT usage limit (plus plan). Try again in ~264 min.";
const PLACEHOLDER = "[assistant turn failed before producing content]";
const envelopeText = () =>
  `${ERROR_ENVELOPE_MARKER}${JSON.stringify(
    buildErrorEnvelope({ code: "rate_limited", raw: "429 rate limit" }),
  )}`;

function textOf(row: Row | undefined): string {
  const content = row?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

function projectOne(message: Record<string, unknown>): Row {
  const out = projectChatDisplayMessage(message) as Row | undefined;
  expect(out).toBeDefined();
  return out as Row;
}

describe("chat-display-projection attaches typed outcomes", () => {
  test("stopReason error + usage-limit errorMessage → recoverable quota with retryAfter; placeholder row kept", () => {
    const row = projectOne({
      role: "assistant",
      content: [{ type: "text", text: PLACEHOLDER }],
      stopReason: "error",
      errorMessage: USAGE_LIMIT_RAW,
    });
    expect(row.outcome?.kind).toBe("quota");
    expect(row.outcome?.recoverable).toBe(true);
    expect(row.outcome?.retryAfter).toBe(264 * 60);
    expect(row.outcome?.source).toBe("stop-reason");
    // The detail comes from errorMessage, never from the generic placeholder.
    expect(row.outcome?.detail).toContain("usage limit");
    expect(row.outcome?.detail).not.toContain("failed before producing content");
    // The row itself is kept exactly as persisted.
    expect(textOf(row)).toBe(PLACEHOLDER);
  });

  test("envelope-only text → outcome from the envelope, text left for the legacy renderer", () => {
    const env = envelopeText();
    for (const text of [env, `[system]\n\nModel set to openai/gpt-5.\n\n${env}`]) {
      const row = projectOne({ role: "assistant", content: [{ type: "text", text }] });
      expect(row.outcome?.kind).toBe("rate_limit");
      expect(row.outcome?.recoverable).toBe(true);
      expect(row.outcome?.source).toBe("envelope");
      expect(row.outcome?.envelope?.category).toBe("rate_limit");
      expect(textOf(row)).toBe(text);
    }
  });

  test("partial answer + envelope → the text becomes the answer, the envelope lives in outcome", () => {
    const answer = "Here is the first half of a real answer.";
    const env = envelopeText();
    const joined = `${answer}\n\n${env}`;
    const row = projectOne({
      role: "assistant",
      content: [{ type: "text", text: joined }],
      text: joined,
      stopReason: "stop",
    });
    expect(textOf(row)).toBe(answer);
    expect(row.text).toBe(answer);
    expect(JSON.stringify(row.content)).not.toContain(ERROR_ENVELOPE_MARKER);
    expect(row.outcome?.kind).toBe("rate_limit");
    expect(row.outcome?.source).toBe("envelope");
    expect(row.outcome?.envelope?.category).toBe("rate_limit");
  });

  test("an envelope in its own block after an answer block: that block goes, the message stays", () => {
    const answer = "Answer streamed in its own block.";
    const out = projectChatDisplayMessages([
      { role: "user", content: [{ type: "text", text: "question" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: answer },
          { type: "text", text: envelopeText() },
        ],
      },
    ]) as Row[];
    expect(out).toHaveLength(2);
    const row = out[1];
    expect(textOf(row)).toBe(answer);
    expect((row.content as unknown[]).length).toBe(2);
    expect(row.outcome?.envelope?.category).toBe("rate_limit");
  });

  test("an outcome that did not come from the envelope never gets it grafted; the text stays as persisted", () => {
    const text = `Partial answer before the provider failed.\n\n${envelopeText()}`;
    const row = projectOne({
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "error",
      errorMessage: USAGE_LIMIT_RAW,
    });
    expect(row.outcome?.kind).toBe("quota");
    expect(row.outcome?.source).toBe("stop-reason");
    expect(row.outcome?.envelope).toBeUndefined();
    expect(textOf(row)).toBe(text);
  });

  test("an envelope after gateway lines only (directive acks, error-shaped lines) stays in the text", () => {
    const env = envelopeText();
    for (const text of [
      `Thinking level set to high. Model set to openai-codex/gpt-5.6-sol.\n\n${env}`,
      `⚠️ All models are temporarily rate-limited\n\n${env}`,
    ]) {
      const row = projectOne({ role: "assistant", content: [{ type: "text", text }] });
      expect(row.outcome?.source).toBe("envelope");
      expect(textOf(row)).toBe(text);
    }
  });

  test("two envelopes in one text: nothing is cut, so neither leaves the wire", () => {
    const text = `An answer.\n\n${envelopeText()}\n\n${envelopeText()}`;
    const row = projectOne({ role: "assistant", content: [{ type: "text", text }] });
    expect(row.outcome?.source).toBe("envelope");
    expect(textOf(row)).toBe(text);
  });

  test("an envelope trailing an answer longer than the display cap is still read, never the prose", () => {
    // Prose that the error-text table would type as rate_limit / timeout if it were regexed.
    const answer = `The 429 path timed out twice. ${"x".repeat(120_000)}`;
    const env = `${ERROR_ENVELOPE_MARKER}${JSON.stringify(
      buildErrorEnvelope({ code: "auth_expired", raw: "401 token expired" }),
    )}`;
    const row = projectOne({
      role: "assistant",
      content: [{ type: "text", text: `${answer}\n\n${env}` }],
    });
    expect(row.outcome?.source).toBe("envelope");
    expect(row.outcome?.kind).toBe("auth");
    expect(textOf(row)).not.toContain(ERROR_ENVELOPE_MARKER);
    expect(textOf(row).startsWith("The 429 path timed out twice.")).toBe(true);
  });

  test("a normal answer carries no outcome — even one that mentions a rate limit or opens with ⚠️", () => {
    for (const text of [
      "The answer is 42.",
      "⚠️ Careful: that API has a rate limit of 60 rpm, so batch your calls.",
    ]) {
      const row = projectOne({
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
      });
      expect("outcome" in row).toBe(false);
      expect(textOf(row)).toBe(text);
    }
  });

  test("an existing valid outcome is kept untouched", () => {
    const existing: TurnOutcome = {
      kind: "overload",
      recoverable: true,
      headline: "Provider overloaded",
      source: "cli",
    };
    const row = projectOne({
      role: "assistant",
      content: [{ type: "text", text: "whatever the writer stored" }],
      stopReason: "error",
      errorMessage: USAGE_LIMIT_RAW,
      outcome: existing,
    });
    expect(row.outcome).toBe(existing);
    expect(textOf(row)).toBe("whatever the writer stored");
  });

  test("a malformed outcome on a normal answer is removed, never served", () => {
    const row = projectOne({
      role: "assistant",
      content: [{ type: "text", text: "fine" }],
      outcome: { kind: "not-a-kind" },
    });
    expect("outcome" in row).toBe(false);
  });

  test("empty stop → outcome empty (thinking-only included)", () => {
    for (const content of [[], [{ type: "thinking", thinking: "only thought" }]]) {
      const row = projectOne({ role: "assistant", content, stopReason: "stop" });
      expect(row.outcome?.kind).toBe("empty");
      expect(row.outcome?.recoverable).toBe(false);
      expect(row.outcome?.source).toBe("empty");
    }
  });

  test("a row whose answer rides on top-level text is never read as an empty stop", () => {
    // (`content: null` is not listed: the projection's heartbeat/visibility filter already hides
    // such a row, before and after this change.)
    for (const content of [undefined, []]) {
      const row = projectOne({ role: "assistant", content, text: "answer carried on text only" });
      expect("outcome" in row).toBe(false);
    }
  });

  test("an empty stop followed by another assistant row gets no outcome; the last one keeps it", () => {
    const out = projectChatDisplayMessages(
      [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [], stopReason: "stop" },
        {
          role: "assistant",
          content: [{ type: "text", text: envelopeText() }],
          stopReason: "stop",
        },
        { role: "user", content: [{ type: "text", text: "again" }] },
        { role: "assistant", content: [], stopReason: "stop" },
      ],
      { stripEnvelope: false },
    ) as Row[];
    expect(out).toHaveLength(5);
    expect("outcome" in out[1]).toBe(false);
    expect(out[2].outcome?.kind).toBe("rate_limit");
    expect(out[4].outcome?.kind).toBe("empty");
  });

  test("no empty outcome on a media reply or on an imported claude-cli step row", () => {
    const image = projectOne({
      role: "assistant",
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      stopReason: "stop",
    });
    expect("outcome" in image).toBe(false);
    // normalizeClaudeCliContent renames tool_use → lowercase `toolcall`; Claude Code writes one
    // entry per block, so a text-less imported row is a step, not a turn's answer.
    const importedToolCall = projectOne({
      role: "assistant",
      content: [{ type: "toolcall", id: "t1", name: "Bash", arguments: { command: "ls" } }],
      __openclaw: { importedFrom: "claude-cli" },
    });
    expect("outcome" in importedToolCall).toBe(false);
    const importedThinking = projectOne({
      role: "assistant",
      content: [{ type: "thinking", thinking: "step" }],
      __openclaw: { importedFrom: "claude-cli" },
    });
    expect("outcome" in importedThinking).toBe(false);
  });

  test("user and toolResult rows are untouched; nothing dropped, nothing reordered", () => {
    const input: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "⚠️ Rate-limited — why?" }] },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "exec",
        isError: true,
        content: [{ type: "text", text: "Error: 429 rate limit" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: PLACEHOLDER }],
        stopReason: "error",
        errorMessage: "fetch failed",
      },
      { role: "assistant", content: [{ type: "text", text: "a real answer" }], stopReason: "stop" },
    ];
    const out = projectChatDisplayMessages(input, { stripEnvelope: false }) as Row[];
    expect(out.map((m) => m.role)).toEqual(["user", "toolResult", "assistant", "assistant"]);
    expect("outcome" in out[0]).toBe(false);
    expect("outcome" in out[1]).toBe(false);
    expect(out[0].content).toEqual(input[0].content);
    expect(out[1].content).toEqual(input[1].content);
    expect(out[2].outcome?.kind).toBe("network");
    expect("outcome" in out[3]).toBe(false);
  });

  test("does not mutate a deep-frozen input (transcript cache safety)", () => {
    function deepFreeze<T>(value: T): T {
      if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.getOwnPropertyNames(value)) {
          deepFreeze((value as Record<string, unknown>)[key]);
        }
      }
      return value;
    }
    const joined = `Answer before the failure.\n\n${envelopeText()}`;
    const messages = deepFreeze<Array<Record<string, unknown>>>([
      { role: "assistant", content: [{ type: "text", text: joined }], text: joined },
      { role: "assistant", content: [], stopReason: "stop" },
      { role: "assistant", content: [{ type: "text", text: "ok" }], outcome: { kind: "bogus" } },
    ]);
    let out: Row[] = [];
    expect(() => {
      out = projectRecentChatDisplayMessages(messages, { maxMessages: 10 }) as Row[];
    }).not.toThrow();
    expect(out).toHaveLength(3);
    expect(messages[0].text).toBe(joined);
    expect(textOf(out[0])).toBe("Answer before the failure.");
  });
});
