import { describe, expect, it } from "vitest";
import {
  assistantTextOfPayloadMessage,
  classifyErrorBubble,
  ERROR_BUBBLE_MAX_LEN,
  isErrorBubbleText,
} from "./error-bubble.js";

// The exact string the gateway put on screen on 2026-08-24 (recovered from the UI DOM
// snapshot and the session trajectory), where it rendered as `<div class="msg assistant">`
// — a plain left-aligned answer bubble.
const INCIDENT_529 =
  "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.";

describe("isErrorBubbleText", () => {
  it("catches the 529 that shipped as an ordinary assistant answer", () => {
    expect(isErrorBubbleText(INCIDENT_529)).toBe(true);
  });

  it("tolerates leading whitespace, as the server's own unwrapper does", () => {
    expect(isErrorBubbleText(`\n  ${INCIDENT_529}`)).toBe(true);
  });

  it("catches the markers both render paths shared", () => {
    expect(isErrorBubbleText("⚠️ Agent failed: boom")).toBe(true);
    expect(isErrorBubbleText("⚠ Agent failed: boom")).toBe(true);
    expect(isErrorBubbleText("Previous run is still shutting down")).toBe(true);
    expect(isErrorBubbleText("All models failed after 3 attempts")).toBe(true);
    expect(isErrorBubbleText("the socket connection was closed unexpectedly")).toBe(true);
  });

  it("leaves ordinary answers alone", () => {
    expect(isErrorBubbleText("Here is the summary you asked for.")).toBe(false);
    expect(isErrorBubbleText("")).toBe(false);
    expect(isErrorBubbleText(undefined)).toBe(false);
  });

  it("will not claim a long answer that merely quotes an API error", () => {
    const quoting = `The log shows "API Error: 529 Overloaded" — ${"x".repeat(ERROR_BUBBLE_MAX_LEN)}`;
    expect(quoting.length).toBeGreaterThanOrEqual(ERROR_BUBBLE_MAX_LEN);
    expect(isErrorBubbleText(quoting)).toBe(false);
  });

  it("still claims the unbounded markers past the length guard", () => {
    // "All models failed" is never prose; length must not rescue it.
    expect(isErrorBubbleText(`All models failed. ${"x".repeat(ERROR_BUBBLE_MAX_LEN)}`)).toBe(true);
  });
});

describe("classifyErrorBubble", () => {
  it("routes an overload to the ORANGE, retryable class — the reported bug", () => {
    expect(classifyErrorBubble(INCIDENT_529)).toEqual({
      recoverable: true,
      retryKind: "overloaded",
    });
  });

  it("routes a rate limit and a quota error to their own retry kinds", () => {
    expect(classifyErrorBubble("API Error: 429 rate limit exceeded")?.retryKind).toBe("rate_limit");
    expect(classifyErrorBubble("API Error: 400 quota exceeded for this org")?.retryKind).toBe(
      "quota",
    );
  });

  it("keeps an unclassifiable failure RED", () => {
    expect(classifyErrorBubble("All models failed after 3 attempts")).toEqual({
      recoverable: false,
      retryKind: null,
    });
  });

  it("returns null for an ordinary answer", () => {
    expect(classifyErrorBubble("Here is the summary you asked for.")).toBeNull();
  });

  it("keeps a client-minted _isError bubble RED even when its text says 'Overloaded'", () => {
    // The ladder's terminal bubble. Repainting it orange would promise a 7th retry.
    expect(
      classifyErrorBubble("🛑 Gave up after 6 retries (Overloaded).", { isError: true }),
    ).toEqual({ recoverable: false, retryKind: null });
  });

  it("honours a structured backend reason over the text", () => {
    expect(classifyErrorBubble(INCIDENT_529, { reason: "rate_limit" })?.retryKind).toBe(
      "rate_limit",
    );
  });
});

describe("assistantTextOfPayloadMessage", () => {
  it("reads the block-array shape the gateway actually sends", () => {
    expect(
      assistantTextOfPayloadMessage({
        role: "assistant",
        content: [{ type: "text", text: INCIDENT_529 }],
      }),
    ).toBe(INCIDENT_529);
  });

  it("reads the legacy string shape", () => {
    expect(assistantTextOfPayloadMessage({ role: "assistant", content: INCIDENT_529 })).toBe(
      INCIDENT_529,
    );
  });

  it("ignores tool blocks and non-messages", () => {
    expect(
      assistantTextOfPayloadMessage({
        content: [
          { type: "tool_use", name: "Bash" },
          { type: "text", text: "hi" },
        ],
      }),
    ).toBe("hi");
    expect(assistantTextOfPayloadMessage(undefined)).toBe("");
    expect(assistantTextOfPayloadMessage("nope")).toBe("");
  });
});
