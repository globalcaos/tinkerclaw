import { afterEach, describe, expect, it } from "vitest";
import { clearPreReplyStage, notePreReplyStage, preReplyStageFor } from "./pre-reply-stage.js";

// bug-log `pre-reply-stall-invisible` (2026-10-15): a prompt stuck before its reply operation read `phase=none`.

describe("pre-reply stage", () => {
  afterEach(() => clearPreReplyStage("agent:main:tinker:pi"));

  it("names the step and how long the prompt has been in it", () => {
    notePreReplyStage("agent:main:tinker:pi", "session-init", 1_000);
    expect(preReplyStageFor("agent:main:tinker:pi", 183_400)).toBe("pre:session-init:182s");
  });

  it("follows the prompt to its next step", () => {
    notePreReplyStage("agent:main:tinker:pi", "session-init", 1_000);
    notePreReplyStage("agent:main:tinker:pi", "before-agent-reply-hooks", 5_000);
    expect(preReplyStageFor("agent:main:tinker:pi", 6_000)).toBe("pre:before-agent-reply-hooks:1s");
  });

  it("reads nothing once the reply has ended, and nothing for another session", () => {
    notePreReplyStage("agent:main:tinker:pi", "directives", 1_000);
    expect(preReplyStageFor("agent:main:tinker:jira", 2_000)).toBeUndefined();
    clearPreReplyStage("agent:main:tinker:pi");
    expect(preReplyStageFor("agent:main:tinker:pi", 2_000)).toBeUndefined();
  });

  it("ignores a missing key", () => {
    notePreReplyStage(undefined, "config");
    expect(preReplyStageFor(undefined)).toBeUndefined();
  });
});
