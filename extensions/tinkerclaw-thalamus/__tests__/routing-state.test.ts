import { describe, expect, it } from "vitest";
import { buildRoutingState } from "../src/reads/redact.js";

// What a standalone read sends to Jev (phase H2, fix 2b): the request text always; the tool name and its arguments only
// when an asked question declares them, redacted with the amygdala's own redaction; never a tool's output or a reply.

const q = (fields: string[]) => ({ fields });
const HOME = "/home/someone";

describe("buildRoutingState", () => {
  it("sends the request alone when no question reads a tool", () => {
    const s = {
      id: "s",
      request: { value: "sort the photos" },
      tool: { value: "Bash" },
      args: { value: { command: "ls" } },
    };
    expect(buildRoutingState(s, [q(["request"])], HOME)).toEqual({ request: "sort the photos" });
  });

  it("adds the tool name and the arguments when a question declares them", () => {
    const s = {
      id: "s",
      request: { value: "run the tests" },
      tool: { value: "Bash" },
      args: { value: { command: "npm test" } },
    };
    expect(buildRoutingState(s, [q(["request", "tool", "args", "toolRecord"])], HOME)).toEqual({
      request: "run the tests",
      tool: "Bash",
      args: { command: "npm test" },
    });
  });

  it("redacts the arguments the way the amygdala does: secrets, addresses, the home folder, file bodies, long text", () => {
    const s = {
      id: "s",
      request: { value: "x" },
      tool: { value: "Write" },
      args: {
        value: {
          file_path: `${HOME}/notes/plan.md`,
          content: "line one\nline two\nline three",
          note: "mail jane.doe@example.com with Bearer abcdefghijklmnop1234",
          essay: "word ".repeat(200),
        },
      },
    };
    const state = buildRoutingState(s, [q(["tool", "args"])], HOME) as {
      args: Record<string, unknown>;
    };
    expect(state.args.file_path).toBe("~/notes/plan.md");
    expect(state.args.content).toEqual({ redacted: "content", bytes: 28, lines: 3 });
    expect(String(state.args.note)).not.toContain("jane.doe@example.com");
    expect(String(state.args.note)).not.toContain("abcdefghijklmnop1234");
    expect(state.args.essay).toEqual({ redacted: "text", len: 1000 });
  });

  it("never sends a tool's output or a reply, even when the situation object carries them", () => {
    const s = {
      id: "s",
      request: { value: "x" },
      toolRecord: { value: "SECRET OUTPUT" },
      reply: { value: "SECRET REPLY" },
      repeatedErrors: { value: 3 },
    };
    const state = buildRoutingState(
      s,
      [q(["request", "toolRecord", "reply", "repeatedErrors"])],
      HOME,
    );
    expect(Object.keys(state)).toEqual(["request"]);
    expect(JSON.stringify(state)).not.toContain("SECRET");
  });

  it("leaves a missing tool or argument out instead of sending an empty field", () => {
    expect(
      buildRoutingState({ request: { value: "x" } }, [q(["request", "tool", "args"])], HOME),
    ).toEqual({ request: "x" });
  });
});
