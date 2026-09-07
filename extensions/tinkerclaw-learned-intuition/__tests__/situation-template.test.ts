import { describe, it, expect } from "vitest";
import {
  classifyActionType,
  classifyTargetType,
  serializeSituation,
  getLastHumanReference,
  crossCheckEffort,
  crossCheckEmotion,
} from "../src/situation-template.js";
import type { AmygdalaConfig, SituationTemplate } from "../src/types.js";

/** Minimal config stub for testing */
const stubConfig = {
  action_type_map: {},
  target_type_map: {},
  reversibility_map: {},
  blast_radius_map: {},
} as unknown as AmygdalaConfig;

describe("situation-template", () => {
  describe("classifyActionType", () => {
    it("maps write to overwrite", () => {
      expect(classifyActionType("write", stubConfig)).toBe("overwrite");
    });

    it("maps write_file to overwrite", () => {
      expect(classifyActionType("write_file", stubConfig)).toBe("overwrite");
    });

    it("maps rm to delete", () => {
      expect(classifyActionType("rm", stubConfig)).toBe("delete");
    });

    it("maps git_push to deploy", () => {
      expect(classifyActionType("git_push", stubConfig)).toBe("deploy");
    });

    it("defaults unknown to execute", () => {
      expect(classifyActionType("something_weird", stubConfig)).toBe("execute");
    });
  });

  describe("classifyTargetType", () => {
    it("classifies URLs as api_call", () => {
      expect(classifyTargetType("https://api.example.com", stubConfig)).toBe("api_call");
    });

    it("classifies file paths as file", () => {
      expect(classifyTargetType("/home/user/file.ts", stubConfig)).toBe("file");
    });

    it("classifies email-like targets as email", () => {
      expect(classifyTargetType("user@example.com", stubConfig)).toBe("email");
    });

    it("classifies sqlite targets as database", () => {
      // Fixed 2026-08-02: this asserted "file" while its own name said "database", and the
      // implementation returns "database" — so the suite had been red on a self-contradictory
      // expectation. The deleted src/amygdala twin asserted "database" correctly.
      expect(classifyTargetType("data.sqlite", stubConfig)).toBe("database");
    });
  });

  describe("serializeSituation", () => {
    it("produces deterministic output from a template", () => {
      const template: SituationTemplate = {
        action_type: "overwrite",
        target_type: "file",
        target_id: "README.md",
        target_metadata: {
          age_hours: 2160,
          size: 14200,
          recent_commits: 5,
          recent_authors: 2,
          effort_hours: 3.5,
          last_human_ref: 0.5,
        },
        context: {
          session_topic: "documentation update",
          recent_corrections: 0,
          emotional_signals: "calm",
          automation_depth: 1,
          topic_drift: 0.12,
        },
        scope: {
          reversible: "true",
          blast_radius: "persistent",
          human_in_loop: true,
          confirmation: "soft",
        },
        timestamp: "2026-03-28T10:00:00Z",
      };

      const result = serializeSituation(template);
      expect(result).toContain('Action: overwrite file "README.md".');
      expect(result).toContain("14200 bytes");
      expect(result).toContain("5 commits by 2 authors");
      expect(result).toContain("documentation update");

      // Deterministic: same input = same output
      expect(serializeSituation(template)).toBe(result);
    });
  });

  describe("getLastHumanReference", () => {
    it("returns 999 when target never mentioned", () => {
      expect(getLastHumanReference("foo.ts", ["bar", "baz"])).toBe(999);
    });

    it("returns 0 when target mentioned in last message", () => {
      expect(getLastHumanReference("foo.ts", ["hello", "check foo.ts"])).toBe(0);
    });

    it("returns hours based on position", () => {
      // 2 steps back * 5 min / 60 = ~0.167h
      const result = getLastHumanReference("foo.ts", ["foo.ts", "other", "more"]);
      expect(result).toBeCloseTo((2 * 5) / 60, 2);
    });
  });

  describe("crossCheckEffort", () => {
    it("uses LLM estimate when higher than heuristic", () => {
      expect(crossCheckEffort(10, 1, 5, 2)).toBe(10);
    });

    it("overrides low LLM estimate with heuristic", () => {
      const result = crossCheckEffort(0, 2, 20, 10);
      expect(result).toBeGreaterThan(0);
    });
  });

  describe("crossCheckEmotion", () => {
    it("overrides calm to frustrated with many corrections", () => {
      expect(crossCheckEmotion("calm", 5, [])).toBe("frustrated");
    });

    it("keeps calm when corrections are low", () => {
      expect(crossCheckEmotion("calm", 1, ["a longer message here"])).toBe("calm");
    });

    it("detects terse from short messages", () => {
      expect(crossCheckEmotion("calm", 0, Array(10).fill("ok"))).toBe("terse");
    });

    it("never downgrades frustrated", () => {
      expect(crossCheckEmotion("frustrated", 0, ["long message here"])).toBe("frustrated");
    });
  });
});
