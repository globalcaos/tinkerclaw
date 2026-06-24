import { describe, expect, it } from "vitest";
import { buildChatSendCommandBody } from "./chat-command-body.js";

describe("buildChatSendCommandBody", () => {
  it("returns the message unchanged when no per-turn directives are set", () => {
    expect(buildChatSendCommandBody({ message: "hello world" })).toBe("hello world");
  });

  it("injects /think for a per-turn thinking level (preserves existing behavior)", () => {
    expect(buildChatSendCommandBody({ message: "hello", thinking: "high" })).toBe(
      "/think high hello",
    );
  });

  it("injects /model for a per-turn model pin", () => {
    expect(
      buildChatSendCommandBody({ message: "hello", model: "claude-code/claude-opus-4-8" }),
    ).toBe("/model claude-code/claude-opus-4-8 hello");
  });

  it("injects both /model and /think when both are set", () => {
    expect(
      buildChatSendCommandBody({
        message: "hello",
        thinking: "high",
        model: "claude-code/claude-opus-4-8",
      }),
    ).toBe("/model claude-code/claude-opus-4-8 /think high hello");
  });

  it("does not inject when the user message is itself a slash command", () => {
    expect(
      buildChatSendCommandBody({ message: "/model gpt-5", thinking: "high", model: "x/y" }),
    ).toBe("/model gpt-5");
  });

  it("does not inject for an empty/whitespace message", () => {
    expect(buildChatSendCommandBody({ message: "   ", thinking: "high", model: "x/y" })).toBe(
      "   ",
    );
  });
});
