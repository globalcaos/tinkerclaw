import { describe, expect, it } from "vitest";
import { SessionTracker } from "../src/session-tracker.js";

const post = (
  tool: string,
  response: unknown,
  input: Record<string, unknown> = { command: "x" },
) => ({
  tool_name: tool,
  tool_input: input,
  tool_response: response,
});

describe("SessionTracker", () => {
  // 2026-10-05: 405 of 408 wrapped requests in a day were long-job wake-ups. Jev read "Longjob · … done" as the owner's
  // request and flagged the next steps as unasked. A prompt an agent wrote continues the owner's request.
  it("a long-job wake-up keeps the owner's last request; the owner's next prompt replaces it", () => {
    const t = new SessionTracker();
    t.notePrompt("tab", "[Mon 2026-10-05 11:02 GMT+2] give Alex a working token");
    t.setRequest("tab", "give Alex a working token");
    t.notePrompt(
      "tab",
      'Sender (untrusted metadata):\n```json\n{"label": "longjob (webchat-ui)"}\n```\n\n[Mon 2026-10-05 11:08 GMT+2] ⟦AGENT:⏳ Longjob · Teams message⟧ done',
    );
    expect(t.sessionContext("tab").request).toBe("give Alex a working token");
    t.setRequest("tab", "give Alex a working token");
    t.notePrompt("tab", "[Mon 2026-10-05 11:31 GMT+2] what was the .exe for?");
    expect(t.sessionContext("tab").request).toBeUndefined();
  });

  it("with no request from the owner yet, an agent's prompt stays the request (a subagent's task)", () => {
    const t = new SessionTracker();
    t.notePrompt("sub", "[Day 2026-09-29 17:45 GMT+2] ⟦AGENT:main⟧ please fix it");
    expect(t.sessionContext("sub").request).toBeUndefined();
    t.setRequest("sub", "please fix it");
    t.notePrompt("sub", "⟦AGENT:main⟧ now the tests");
    expect(t.sessionContext("sub").request).toBeUndefined();
  });

  it("a record entry carries the result's shape, never its text: lines and failure (2026-10-03)", () => {
    const t = new SessionTracker();
    t.recordToolResult("s", {
      tool_name: "Bash",
      tool_input: { command: "grep x" },
      tool_response: { stdout: "", exit_code: 1 },
    });
    t.recordToolResult("s", {
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: { stdout: "a\nb\n\nc\n", exit_code: 0 },
    });
    const rec = t.sessionContext("s", "/w").toolRecord!;
    expect(rec[0]).toMatchObject({ outputLines: 0, failed: true });
    expect(rec[1]).toMatchObject({ outputLines: 3, failed: false });
    expect(JSON.stringify(rec)).not.toContain("a\\nb");
  });

  // 2026-10-02: the counter restarts with every gateway process, so a tab's first turn after each restart was "#1"
  // again and three turns of one chat merged into one; the Jev window showed only under the first of them.
  it("an epoch keeps turn ids apart across processes", () => {
    const a = new SessionTracker({ epoch: "p1" });
    const b = new SessionTracker({ epoch: "p2" });
    a.notePrompt("tab");
    b.notePrompt("tab");
    expect(a.turnId("tab")).not.toBe(b.turnId("tab"));
    expect(a.turnId("tab")).toBe("tab#p1.1");
    expect(new SessionTracker().turnId("tab")).toBe("tab#0");
  });

  it("counts prompt seams into the turn id; 0 before any prompt", () => {
    const t = new SessionTracker();
    expect(t.turnId("s")).toBe("s#0");
    t.notePrompt("s");
    expect(t.turnId("s")).toBe("s#1");
    t.notePrompt("s");
    expect(t.turnId("s")).toBe("s#2");
    expect(t.turnId("other")).toBe("other#0");
  });

  it("keeps the request per turn and clears it at the next prompt", () => {
    const t = new SessionTracker();
    t.notePrompt("s");
    t.setRequest("s", "do the thing");
    expect(t.sessionContext("s", "/w").request).toBe("do the thing");
    t.notePrompt("s");
    expect(t.sessionContext("s", "/w").request).toBeUndefined();
  });

  it("builds the base context: workspaceRoot from cwd, signals missing until a result is seen", () => {
    const t = new SessionTracker({ homeDir: "/home/u" });
    const c = t.sessionContext("s", "/work");
    expect(c.workspaceRoot).toBe("/work");
    expect(c.homeDir).toBe("/home/u");
    expect(c.toolRecord).toBeUndefined();
    expect(c.repeatedErrors).toBeUndefined();
    expect(t.sessionContext("s").workspaceRoot).toBe("/home/u");
  });

  it("rings the tool record at 50, newest last, with exit status and files written", () => {
    let now = 0;
    const t = new SessionTracker({ now: () => ++now });
    for (let i = 0; i < 60; i++) {
      t.recordToolResult("s", post("Bash", { stdout: `o${i}`, exit_code: i === 59 ? 2 : 0 }));
    }
    t.recordToolResult("s", post("Write", "ok", { file_path: "/w/a.txt", content: "c" }));
    const rec = t.sessionContext("s", "/w").toolRecord ?? [];
    expect(rec).toHaveLength(50);
    const last = rec[rec.length - 1];
    expect(last.tool).toBe("Write");
    expect(last.filesWritten).toEqual(["/w/a.txt"]);
    expect(rec[rec.length - 2].exit).toBe(2);
    expect(rec[0].ts).toBeLessThan(last.ts);
  });

  it("counts identical consecutive errors and resets on success or a different error", () => {
    const t = new SessionTracker();
    const err = (m: string) => post("Bash", { stderr: m, exit_code: 1 });
    const rep = () => t.sessionContext("s").repeatedErrors;
    t.recordToolResult("s", err("boom"));
    expect(rep()).toBe(1);
    t.recordToolResult("s", err("boom"));
    t.recordToolResult("s", err("boom"));
    expect(rep()).toBe(3);
    t.recordToolResult("s", err("other"));
    expect(rep()).toBe(1);
    t.recordToolResult("s", post("Bash", { stdout: "fine", exit_code: 0 }));
    expect(rep()).toBe(0);
  });

  it("stepsSinceNewFact grows while results repeat and resets on a result unlike the last five", () => {
    const t = new SessionTracker();
    const steps = () => t.sessionContext("s").stepsSinceNewFact;
    t.recordToolResult("s", post("Bash", "same"));
    expect(steps()).toBe(0);
    t.recordToolResult("s", post("Bash", "same"));
    t.recordToolResult("s", post("Bash", "same"));
    expect(steps()).toBe(2);
    t.recordToolResult("s", post("Bash", "new fact"));
    expect(steps()).toBe(0);
  });

  it("holds at most 50 sessions and evicts the least recently touched", () => {
    const t = new SessionTracker();
    for (let i = 0; i < 50; i++) t.notePrompt(`s${i}`);
    t.notePrompt("s0"); // touch s0 so s1 is now the oldest
    t.notePrompt("s50");
    expect(t.size()).toBe(50);
    expect(t.has("s0")).toBe(true);
    expect(t.has("s1")).toBe(false);
    expect(t.has("s50")).toBe(true);
  });
});
