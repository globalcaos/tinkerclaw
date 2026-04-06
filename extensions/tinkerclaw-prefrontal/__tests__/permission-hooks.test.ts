import { describe, it, expect } from "vitest";
import { createDenialTracker } from "../denial-tracking.js";
import { createPermissionHooks } from "../permission-hooks.js";

describe("PermissionHooks", () => {
  it("approves when no hooks match", async () => {
    const hooks = createPermissionHooks([
      { tool: "Bash", script: 'echo \'{"decision":"deny"}\'', timeout: 5000 },
    ]);
    const result = await hooks.check("Edit", {});
    expect(result.decision).toBe("approve");
  });

  it("runs matching hook", async () => {
    const hooks = createPermissionHooks([
      { tool: "Bash", script: 'echo \'{"decision":"approve"}\'', timeout: 5000 },
    ]);
    const result = await hooks.check("Bash", {});
    expect(result.decision).toBe("approve");
  });

  it("returns deny from hook", async () => {
    const hooks = createPermissionHooks([
      {
        tool: "Bash",
        script: 'echo \'{"decision":"deny","feedback":"too dangerous"}\'',
        timeout: 5000,
      },
    ]);
    const result = await hooks.check("Bash", {});
    expect(result.decision).toBe("deny");
    expect(result.feedback).toBe("too dangerous");
  });

  it("wildcard matches all tools", async () => {
    const hooks = createPermissionHooks([
      { tool: "*", script: 'echo \'{"decision":"approve"}\'', timeout: 5000 },
    ]);
    const result = await hooks.check("Edit", {});
    expect(result.decision).toBe("approve");
  });

  it("approves on timeout (fail-open)", async () => {
    const hooks = createPermissionHooks([{ tool: "Bash", script: "sleep 10", timeout: 100 }]);
    const result = await hooks.check("Bash", {});
    expect(result.decision).toBe("approve");
  });
});

describe("DenialTracker", () => {
  it("tracks consecutive denials", () => {
    const t = createDenialTracker({ limit: 3 });
    t.recordDenial("Bash");
    t.recordDenial("Bash");
    expect(t.shouldEscalate("Bash")).toBe(false);
    t.recordDenial("Bash");
    expect(t.shouldEscalate("Bash")).toBe(true);
  });

  it("resets on approval", () => {
    const t = createDenialTracker({ limit: 3 });
    t.recordDenial("Bash");
    t.recordDenial("Bash");
    t.recordApproval("Bash");
    expect(t.shouldEscalate("Bash")).toBe(false);
    expect(t.getCount("Bash")).toBe(0);
  });

  it("tracks tools independently", () => {
    const t = createDenialTracker({ limit: 2 });
    t.recordDenial("Bash");
    t.recordDenial("Edit");
    expect(t.shouldEscalate("Bash")).toBe(false);
    expect(t.shouldEscalate("Edit")).toBe(false);
  });

  it("produces escalation message", () => {
    const t = createDenialTracker({ limit: 1 });
    t.recordDenial("Bash");
    const msg = t.getEscalationMessage("Bash");
    expect(msg).toContain("denied");
    expect(msg).toContain("ask the user");
  });

  it("getCount returns 0 for unknown tool", () => {
    const t = createDenialTracker({ limit: 3 });
    expect(t.getCount("Unknown")).toBe(0);
  });
});
