import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAxis, listAxes, validateParentDepth } from "./axes.js";
import { setupInMemoryConfig } from "./test-helpers.js";

describe("axes.parent_id", () => {
  let cfg: ReturnType<typeof setupInMemoryConfig>;

  beforeEach(() => {
    cfg = setupInMemoryConfig();
  });
  afterEach(() => {
    cfg.cleanup();
  });

  it("addAxis with parent_id sets the parent", () => {
    addAxis(cfg, { id: "ventures", label: "Ventures" });
    addAxis(cfg, { id: "ventures-a", label: "Project A", parent_id: "ventures" });
    const rows = listAxes(cfg);
    const child = rows.find((r) => r.id === "ventures-a");
    expect(child?.parent_id).toBe("ventures");
  });

  it("rejects nesting beyond 2 levels", () => {
    addAxis(cfg, { id: "ventures", label: "Ventures" });
    addAxis(cfg, { id: "ventures-a", label: "Project A", parent_id: "ventures" });
    expect(() =>
      addAxis(cfg, { id: "ventures-a-sub", label: "Sub", parent_id: "ventures-a" }),
    ).toThrow(/nesting beyond two levels/);
  });

  it("validateParentDepth returns true for top-level axes", () => {
    addAxis(cfg, { id: "ventures", label: "Ventures" });
    expect(validateParentDepth(cfg, "ventures")).toBe(true);
  });

  it("validateParentDepth returns false for a sub-group (already a child)", () => {
    addAxis(cfg, { id: "ventures", label: "Ventures" });
    addAxis(cfg, { id: "ventures-a", label: "Project A", parent_id: "ventures" });
    expect(validateParentDepth(cfg, "ventures-a")).toBe(false);
  });
});
