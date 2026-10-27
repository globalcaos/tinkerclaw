import { describe, expect, it } from "vitest";
import { createRunStates } from "../src/run-state.js";

describe("run state", () => {
  it("joins a tool result to its arguments and marks the tools that change something", () => {
    const s = createRunStates();
    s.toolStart("r", "c1", "edit", { path: "/a", text: "x" });
    const e = s.toolResult("r", "c1", "edit", "ok", false);
    expect(e).toMatchObject({ name: "edit", commits: true, isError: false });
    expect(e.args).toContain("/a");
    s.toolStart("r", "c2", "read", { path: "/a" });
    expect(s.toolResult("r", "c2", "read", "body", false).commits).toBe(false);
  });
  it("a result with no start still records, with no arguments", () => {
    const s = createRunStates();
    expect(s.toolResult("r", "zz", "exec", "out", true)).toMatchObject({
      name: "exec",
      args: "",
      isError: true,
    });
  });
  it("keeps short excerpts and a bounded log", () => {
    const s = createRunStates({ maxWork: 3, excerpt: 10 });
    for (let n = 0; n < 6; n++) s.toolResult("r", `c${n}`, "exec", "x".repeat(100) + n, false);
    const w = s.get("r")!.work;
    expect(w).toHaveLength(3);
    expect(w.every((e) => e.result.length <= 11)).toBe(true);
  });
  it("keeps the newest runs only", () => {
    const s = createRunStates({ maxRuns: 2 });
    s.ensure("a");
    s.ensure("b");
    s.ensure("c");
    expect(s.size()).toBe(2);
    expect(s.get("a")).toBeUndefined();
  });
  it("remembers the writer and counts other models, and forgets on request", () => {
    const s = createRunStates();
    s.setWriter("r", "claude-code/claude-opus-5");
    s.noteOther("r");
    s.noteOther("r");
    expect(s.get("r")).toMatchObject({ writer: "claude-code/claude-opus-5", others: 2 });
    s.forget("r");
    expect(s.get("r")).toBeUndefined();
  });
  it("an unserialisable argument does not throw", () => {
    const s = createRunStates();
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => s.toolStart("r", "c", "exec", cyc)).not.toThrow();
  });
});
