/**
 * FORK 2026-06-10 (Phase 0): pure read-only tools must short-circuit to "allow"
 * without waking the neural gate. This kills a class of false positives (the
 * uncalibrated gate soft-blocked 100% of actions, including file reads). AEGIS
 * rule checks still run first (a read of a credential file is still blocked), so
 * this only bypasses the *learned* gate for unambiguous local reads.
 *
 * Conservative by design: Bash is NOT read-only (it can `rm -rf`), and external
 * calls (WebFetch/WebSearch) are NOT short-circuited either — only unambiguous
 * local reads.
 */
import { describe, it, expect } from "vitest";
import { isReadOnlyTool } from "../src/runtime-hook.js";

describe("read-only tool short-circuit (Phase 0)", () => {
  it("recognizes unambiguous local read-only tools", () => {
    for (const t of ["Read", "Glob", "Grep", "LS", "NotebookRead", "ToolSearch"]) {
      expect(isReadOnlyTool(t), t).toBe(true);
    }
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(isReadOnlyTool("read")).toBe(true);
    expect(isReadOnlyTool("  GREP  ")).toBe(true);
  });

  it("does NOT treat mutating, shell, or external-call tools as read-only", () => {
    for (const t of [
      "Bash",
      "Write",
      "Edit",
      "NotebookEdit",
      "Task",
      "Skill",
      "WebFetch",
      "WebSearch",
      "",
    ]) {
      expect(isReadOnlyTool(t), t).toBe(false);
    }
  });
});
