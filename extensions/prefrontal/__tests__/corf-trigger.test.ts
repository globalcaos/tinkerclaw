import { describe, it, expect } from "vitest";
import { shouldTriggerCorf, getCorfDebatePrompt, DEFAULT_CORF_CONFIG } from "../corf-trigger.js";

describe("shouldTriggerCorf", () => {
  it("triggers for architecture decisions", () => {
    expect(shouldTriggerCorf("architect the new payment system", DEFAULT_CORF_CONFIG)).toBe(true);
  });

  it("triggers for destructive operations", () => {
    expect(shouldTriggerCorf("delete all user records permanently", DEFAULT_CORF_CONFIG)).toBe(
      true,
    );
    expect(shouldTriggerCorf("drop table users", DEFAULT_CORF_CONFIG)).toBe(true);
  });

  it("triggers for security tasks", () => {
    expect(shouldTriggerCorf("security review of the auth endpoints", DEFAULT_CORF_CONFIG)).toBe(
      true,
    );
    expect(shouldTriggerCorf("rotate the credential keys", DEFAULT_CORF_CONFIG)).toBe(true);
  });

  it("triggers for migration tasks", () => {
    expect(shouldTriggerCorf("migrate the database to postgres", DEFAULT_CORF_CONFIG)).toBe(true);
  });

  it("triggers for production deployments", () => {
    expect(shouldTriggerCorf("deploy to prod the new API version", DEFAULT_CORF_CONFIG)).toBe(true);
  });

  it("triggers for explicit user requests", () => {
    expect(shouldTriggerCorf("debate this approach before we proceed", DEFAULT_CORF_CONFIG)).toBe(
      true,
    );
    expect(shouldTriggerCorf("get a second opinion on this design", DEFAULT_CORF_CONFIG)).toBe(
      true,
    );
    expect(shouldTriggerCorf("run a round table on the architecture", DEFAULT_CORF_CONFIG)).toBe(
      true,
    );
  });

  it("does NOT trigger for regular coding", () => {
    expect(shouldTriggerCorf("add a button to the login page", DEFAULT_CORF_CONFIG)).toBe(false);
    expect(shouldTriggerCorf("fix the CSS alignment issue", DEFAULT_CORF_CONFIG)).toBe(false);
  });

  it("does NOT trigger when disabled", () => {
    expect(shouldTriggerCorf("architect everything", { enabled: false })).toBe(false);
  });

  it("does NOT trigger for short messages", () => {
    expect(shouldTriggerCorf("delete", DEFAULT_CORF_CONFIG)).toBe(false);
  });

  it("does NOT trigger for empty input", () => {
    expect(shouldTriggerCorf("", DEFAULT_CORF_CONFIG)).toBe(false);
  });
});

describe("getCorfDebatePrompt", () => {
  it("includes the task description", () => {
    const prompt = getCorfDebatePrompt("migrate to postgres");
    expect(prompt).toContain("migrate to postgres");
  });

  it("includes debate instructions", () => {
    const prompt = getCorfDebatePrompt("test");
    expect(prompt).toContain("Propose your approach");
    expect(prompt).toContain("failure modes");
    expect(prompt).toContain("alternative approaches");
  });
});
