/**
 * FORK 2026-09-08 -- the per-turn model directive must also reach a message the user began with an
 * inline `/think`. the architect's failing turns were literally "/think xhigh keep going": the old builder
 * treated any leading slash as "a user command, leave it alone", so neither a picker pin nor the
 * picker's Auto reset ever reached those turns.
 */
import { describe, expect, it } from "vitest";
import { buildChatSendCommandBody } from "./chat-command-body.js";

describe("buildChatSendCommandBody -- /think-leading messages", () => {
  it("prepends the model directive in front of a user-typed /think", () => {
    expect(
      buildChatSendCommandBody({ message: "/think xhigh keep going", model: "auto" }),
    ).toBe("/model auto /think xhigh keep going");
  });

  it("does NOT add a second /think when the user already typed one", () => {
    expect(
      buildChatSendCommandBody({
        message: "/think xhigh keep going",
        model: "claude-code/claude-opus-5",
        thinking: "high",
      }),
    ).toBe("/model claude-code/claude-opus-5 /think xhigh keep going");
  });

  it("leaves every other user command untouched", () => {
    expect(buildChatSendCommandBody({ message: "/model status", model: "auto" })).toBe(
      "/model status",
    );
    expect(buildChatSendCommandBody({ message: "/clear", model: "auto", thinking: "high" })).toBe(
      "/clear",
    );
    expect(buildChatSendCommandBody({ message: "/thinking-caps on", model: "auto" })).toBe(
      "/thinking-caps on",
    );
  });

  it("passes the picker's Auto reset through like any other model id", () => {
    expect(buildChatSendCommandBody({ message: "hello", model: "auto" })).toBe("/model auto hello");
  });
});
