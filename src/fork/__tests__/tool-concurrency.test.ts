import { describe, it, expect } from "vitest";
import { classifyTool, partitionToolCalls, type ToolCall } from "../tool-concurrency.js";

function tc(name: string, id?: string): ToolCall {
  return { name, id: id ?? name.toLowerCase() };
}

describe("classifyTool", () => {
  it("classifies Read as read-only", () => {
    expect(classifyTool("Read")).toBe("read-only");
  });

  it("classifies Grep as read-only", () => {
    expect(classifyTool("Grep")).toBe("read-only");
  });

  it("classifies Glob as read-only", () => {
    expect(classifyTool("Glob")).toBe("read-only");
  });

  it("classifies WebSearch as read-only", () => {
    expect(classifyTool("WebSearch")).toBe("read-only");
  });

  it("classifies Edit as mutating", () => {
    expect(classifyTool("Edit")).toBe("mutating");
  });

  it("classifies Write as mutating", () => {
    expect(classifyTool("Write")).toBe("mutating");
  });

  it("classifies Bash as mutating", () => {
    expect(classifyTool("Bash")).toBe("mutating");
  });

  it("defaults unknown tools to mutating (fail-closed)", () => {
    expect(classifyTool("SomeNewTool")).toBe("mutating");
  });

  it("classifies memory_search as read-only", () => {
    expect(classifyTool("memory_search")).toBe("read-only");
  });

  it("classifies TaskGet as read-only", () => {
    expect(classifyTool("TaskGet")).toBe("read-only");
  });

  it("classifies TaskList as read-only", () => {
    expect(classifyTool("TaskList")).toBe("read-only");
  });
});

describe("partitionToolCalls", () => {
  it("batches consecutive read-only tools together", () => {
    const calls = [tc("Read", "1"), tc("Grep", "2"), tc("Glob", "3")];
    const batches = partitionToolCalls(calls);
    expect(batches).toHaveLength(1);
    expect(batches[0].mode).toBe("parallel");
    expect(batches[0].calls).toHaveLength(3);
  });

  it("serializes mutating tools individually", () => {
    const calls = [tc("Edit", "1"), tc("Write", "2")];
    const batches = partitionToolCalls(calls);
    expect(batches).toHaveLength(2);
    expect(batches[0].mode).toBe("serial");
    expect(batches[0].calls).toHaveLength(1);
    expect(batches[1].mode).toBe("serial");
    expect(batches[1].calls).toHaveLength(1);
  });

  it("splits on read-to-mutating boundary", () => {
    const calls = [tc("Read", "1"), tc("Grep", "2"), tc("Edit", "3"), tc("Read", "4")];
    const batches = partitionToolCalls(calls);
    expect(batches).toHaveLength(3);
    expect(batches[0].mode).toBe("parallel");
    expect(batches[0].calls).toHaveLength(2);
    expect(batches[1].mode).toBe("serial");
    expect(batches[1].calls).toHaveLength(1);
    expect(batches[2].mode).toBe("parallel");
    expect(batches[2].calls).toHaveLength(1);
  });

  it("respects max concurrency limit", () => {
    const calls = Array.from({ length: 15 }, (_, i) => tc("Read", `${i}`));
    const batches = partitionToolCalls(calls, { maxConcurrency: 8 });
    expect(batches).toHaveLength(2);
    expect(batches[0].calls).toHaveLength(8);
    expect(batches[1].calls).toHaveLength(7);
  });

  it("handles empty input", () => {
    expect(partitionToolCalls([])).toEqual([]);
  });

  it("handles single mutating tool", () => {
    const batches = partitionToolCalls([tc("Bash", "1")]);
    expect(batches).toHaveLength(1);
    expect(batches[0].mode).toBe("serial");
  });

  it("handles single read-only tool", () => {
    const batches = partitionToolCalls([tc("Read", "1")]);
    expect(batches).toHaveLength(1);
    expect(batches[0].mode).toBe("parallel");
  });

  it("alternating read/mutate creates many batches", () => {
    const calls = [tc("Read", "1"), tc("Edit", "2"), tc("Grep", "3"), tc("Write", "4")];
    const batches = partitionToolCalls(calls);
    expect(batches).toHaveLength(4);
    expect(batches[0].mode).toBe("parallel");
    expect(batches[1].mode).toBe("serial");
    expect(batches[2].mode).toBe("parallel");
    expect(batches[3].mode).toBe("serial");
  });

  it("preserves tool call identity", () => {
    const calls = [tc("Read", "abc"), tc("Edit", "def")];
    const batches = partitionToolCalls(calls);
    expect(batches[0].calls[0].id).toBe("abc");
    expect(batches[1].calls[0].id).toBe("def");
  });

  it("uses default concurrency of 8", () => {
    const calls = Array.from({ length: 10 }, (_, i) => tc("Read", `${i}`));
    const batches = partitionToolCalls(calls);
    expect(batches).toHaveLength(2);
    expect(batches[0].calls).toHaveLength(8);
    expect(batches[1].calls).toHaveLength(2);
  });
});
