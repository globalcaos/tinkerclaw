import { describe, it, expect } from "vitest";
import { filterTools, createToolRegistry, type ToolDef } from "../deferred-tools.js";

const coreTool: ToolDef = { name: "Read", description: "Read a file", schema: { type: "object" } };
const nonCoreTool: ToolDef = {
  name: "WebSearch",
  description: "Search the web",
  schema: { type: "object", properties: { query: { type: "string" } } },
};

describe("filterTools", () => {
  it("mode=all sends everything eagerly", () => {
    const result = filterTools([coreTool, nonCoreTool], { mode: "all" });
    expect(result.eager).toHaveLength(2);
    expect(result.deferred).toHaveLength(0);
  });

  it("mode=defer defers non-core tools", () => {
    const result = filterTools([coreTool, nonCoreTool], { mode: "defer" });
    expect(result.eager.map((t) => t.name)).toContain("Read");
    expect(result.deferred.map((t) => t.name)).toContain("WebSearch");
  });

  it("deferred tools have no schema", () => {
    const result = filterTools([coreTool, nonCoreTool], { mode: "defer" });
    const ws = result.deferred.find((t) => t.name === "WebSearch");
    expect(ws).toBeDefined();
    expect(ws!.schema).toBeUndefined();
    expect(ws!.description).toBe("Search the web");
  });

  it("mode=auto keeps all when under threshold", () => {
    const result = filterTools([coreTool, nonCoreTool], {
      mode: "auto",
      contextWindow: 1_000_000,
      thresholdPct: 10,
    });
    expect(result.eager).toHaveLength(2);
    expect(result.deferred).toHaveLength(0);
  });

  it("mode=auto defers when over threshold", () => {
    const bigTools = Array.from({ length: 50 }, (_, i) => ({
      name: `Tool${i}`,
      description: `A tool that does thing ${i} with lots of description text to inflate tokens`,
      schema: {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "number" }, c: { type: "boolean" } },
      },
    }));
    const result = filterTools([coreTool, ...bigTools], {
      mode: "auto",
      contextWindow: 1000,
      thresholdPct: 10,
    });
    expect(result.deferred.length).toBeGreaterThan(0);
    expect(result.eager.map((t) => t.name)).toContain("Read");
  });

  it("always keeps core tools eager in defer mode", () => {
    const tools: ToolDef[] = [
      { name: "Read", description: "r", schema: {} },
      { name: "Edit", description: "e", schema: {} },
      { name: "Write", description: "w", schema: {} },
      { name: "Bash", description: "b", schema: {} },
      { name: "Grep", description: "g", schema: {} },
      { name: "Glob", description: "gl", schema: {} },
      { name: "WebSearch", description: "ws", schema: {} },
    ];
    const result = filterTools(tools, { mode: "defer" });
    expect(result.eager).toHaveLength(6);
    expect(result.deferred).toHaveLength(1);
  });

  it("handles empty tools array", () => {
    const result = filterTools([], { mode: "auto" });
    expect(result.eager).toHaveLength(0);
    expect(result.deferred).toHaveLength(0);
  });
});

describe("createToolRegistry", () => {
  it("finds tool by exact name", () => {
    const registry = createToolRegistry([coreTool, nonCoreTool]);
    const results = registry.search("Read");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Read");
    expect(results[0].schema).toBeDefined();
  });

  it("returns full schema for found tool", () => {
    const registry = createToolRegistry([coreTool, nonCoreTool]);
    const results = registry.search("WebSearch");
    expect(results[0].schema).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
    });
  });

  it("finds by partial name match", () => {
    const registry = createToolRegistry([coreTool, nonCoreTool]);
    const results = registry.search("Web");
    expect(results.some((r) => r.name === "WebSearch")).toBe(true);
  });

  it("finds by description match", () => {
    const registry = createToolRegistry([coreTool, nonCoreTool]);
    const results = registry.search("file");
    expect(results.some((r) => r.name === "Read")).toBe(true);
  });

  it("returns empty for no match", () => {
    const registry = createToolRegistry([coreTool]);
    expect(registry.search("NonExistent")).toHaveLength(0);
  });

  it("getAll returns all tools", () => {
    const registry = createToolRegistry([coreTool, nonCoreTool]);
    expect(registry.getAll()).toHaveLength(2);
  });

  it("case-insensitive search", () => {
    const registry = createToolRegistry([coreTool]);
    expect(registry.search("read")).toHaveLength(1);
  });
});
