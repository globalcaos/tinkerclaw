import { describe, it, expect, beforeEach } from "vitest";
import {
  loadAntiGoldplatingPrompt,
  shouldInjectAntiGoldplating,
  _resetCache,
  type AntiGoldplatingConfig,
} from "../anti-goldplating.js";

describe("AntiGoldplating", () => {
  beforeEach(() => {
    _resetCache();
  });

  describe("loadAntiGoldplatingPrompt", () => {
    it("loads prompt from markdown file", () => {
      const prompt = loadAntiGoldplatingPrompt();
      expect(prompt).toContain("Anti-Gold-Plating");
      expect(prompt).toContain("premature abstraction");
    });

    it("contains verification rule", () => {
      const prompt = loadAntiGoldplatingPrompt();
      expect(prompt).toContain("run the verification command");
    });

    it("contains exploration rule", () => {
      const prompt = loadAntiGoldplatingPrompt();
      expect(prompt).toContain("Read the file before modifying");
    });

    it("contains anti-overengineering rules", () => {
      const prompt = loadAntiGoldplatingPrompt();
      expect(prompt).toContain("Don't add features");
      expect(prompt).toContain("Don't add error handling");
      expect(prompt).toContain("Don't create helpers");
    });

    it("caches the result", () => {
      const first = loadAntiGoldplatingPrompt();
      const second = loadAntiGoldplatingPrompt();
      expect(first).toBe(second); // same reference
    });

    it("returns fallback when file not found", () => {
      const prompt = loadAntiGoldplatingPrompt("/nonexistent/path");
      expect(prompt).toContain("Anti-Gold-Plating");
      expect(prompt).toContain("premature abstraction");
    });
  });

  describe("shouldInjectAntiGoldplating", () => {
    const enabled: AntiGoldplatingConfig = { enabled: true };
    const disabled: AntiGoldplatingConfig = { enabled: false };

    it("returns true when enabled", () => {
      expect(shouldInjectAntiGoldplating(enabled)).toBe(true);
    });

    it("returns false when disabled", () => {
      expect(shouldInjectAntiGoldplating(disabled)).toBe(false);
    });

    it("returns false for heartbeat trigger", () => {
      expect(shouldInjectAntiGoldplating(enabled, "heartbeat")).toBe(false);
    });

    it("returns false for cron trigger", () => {
      expect(shouldInjectAntiGoldplating(enabled, "cron")).toBe(false);
    });

    it("returns true for user trigger", () => {
      expect(shouldInjectAntiGoldplating(enabled, "user")).toBe(true);
    });
  });
});
