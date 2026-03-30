import { describe, it, expect } from "vitest";
import {
  sensitivityGate,
  detectSensitiveCategories,
  computeSensitivityScore,
  shouldAttemptHumor,
  type HumorCalibration,
  type AudienceModel,
} from "../src/sensitivity-gate.js";

const DEFAULT_CALIBRATION: HumorCalibration = {
  humorFrequency: 0.15,
  preferredPatterns: [1, 4, 7],
  sensitivityThreshold: 0.5,
  audienceModel: {},
};

describe("detectSensitiveCategories", () => {
  it("detects death-related content", () => {
    const cats = detectSensitiveCategories("The patient died yesterday");
    expect(cats).toContain("death");
  });

  it("detects multiple categories", () => {
    const cats = detectSensitiveCategories("The suicide and domestic violence report");
    expect(cats).toContain("suicide");
    expect(cats).toContain("domestic_violence");
  });

  it("returns empty for neutral content", () => {
    const cats = detectSensitiveCategories("The weather is nice today");
    expect(cats).toHaveLength(0);
  });

  it("returns empty for programming topics", () => {
    const cats = detectSensitiveCategories("We need to refactor the database schema");
    expect(cats).toHaveLength(0);
  });
});

describe("computeSensitivityScore", () => {
  it("returns 0 for neutral text", () => {
    expect(computeSensitivityScore("Hello world")).toBe(0);
  });

  it("returns positive score for sensitive text", () => {
    const score = computeSensitivityScore("The funeral was today");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("returns 1.0 when audience has matching recent trauma", () => {
    const audience: AudienceModel = {
      userId: "test",
      recentTrauma: ["death"],
      humorReceptivity: 0.5,
      reactions: { positive: 0, negative: 0, neutral: 0 },
    };
    const score = computeSensitivityScore("The funeral was today", audience);
    expect(score).toBe(1.0);
  });
});

describe("sensitivityGate", () => {
  it("allows neutral topics", () => {
    const result = sensitivityGate("programming", "typescript", "code", DEFAULT_CALIBRATION);
    expect(result.allowed).toBe(true);
    expect(result.sensitivityScore).toBe(0);
  });

  it("blocks sensitive topics above threshold", () => {
    const strictCalibration: HumorCalibration = {
      ...DEFAULT_CALIBRATION,
      sensitivityThreshold: 0.2,
    };
    const result = sensitivityGate("death", "funeral", "grief", strictCalibration);
    expect(result.allowed).toBe(false);
    expect(result.sensitivityScore).toBeGreaterThan(0);
  });

  it("blocks topics matching audience recent trauma", () => {
    const audience: AudienceModel = {
      userId: "user1",
      recentTrauma: ["death"],
      humorReceptivity: 0.8,
      reactions: { positive: 5, negative: 0, neutral: 2 },
    };
    const result = sensitivityGate("death", "comedy", "bridge", DEFAULT_CALIBRATION, audience);
    expect(result.allowed).toBe(false);
  });

  it("passes neutral topics even with audience model", () => {
    const audience: AudienceModel = {
      userId: "user1",
      recentTrauma: ["death"],
      humorReceptivity: 0.8,
      reactions: { positive: 5, negative: 0, neutral: 2 },
    };
    const result = sensitivityGate("programming", "typescript", "code", DEFAULT_CALIBRATION, audience);
    expect(result.allowed).toBe(true);
  });
});

describe("shouldAttemptHumor", () => {
  it("returns consistent results for the same turn number", () => {
    const r1 = shouldAttemptHumor(DEFAULT_CALIBRATION, 42);
    const r2 = shouldAttemptHumor(DEFAULT_CALIBRATION, 42);
    expect(r1).toBe(r2);
  });

  it("returns false when frequency is 0", () => {
    const cal = { ...DEFAULT_CALIBRATION, humorFrequency: 0 };
    // Test multiple turns -- all should be false
    for (let t = 0; t < 100; t++) {
      expect(shouldAttemptHumor(cal, t)).toBe(false);
    }
  });

  it("returns true for some turns when frequency is 1", () => {
    const cal = { ...DEFAULT_CALIBRATION, humorFrequency: 1.0 };
    let anyTrue = false;
    for (let t = 0; t < 100; t++) {
      if (shouldAttemptHumor(cal, t)) {
        anyTrue = true;
        break;
      }
    }
    expect(anyTrue).toBe(true);
  });
});
