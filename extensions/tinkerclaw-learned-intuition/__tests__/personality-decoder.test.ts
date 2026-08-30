import { describe, it, expect } from "vitest";
import { decodePersonalityNudge } from "../src/personality-decoder.js";
import {
  generateTargetVector,
  getDimensionIndexMap,
  DEFAULT_TARGET_DIMENSIONS,
} from "../src/personality-seed.js";

describe("personality-decoder", () => {
  const target = generateTargetVector(DEFAULT_TARGET_DIMENSIONS);

  it("returns no adjustments when embedding matches target", () => {
    const combined = new Float32Array(target);
    const nudge = decodePersonalityNudge(combined, target, 0.5);
    expect(nudge.adjustments).toHaveLength(0);
    expect(nudge.strength).toBe(0.5);
  });

  it("detects humor drift when all zeros", () => {
    const combined = new Float32Array(64); // all zeros
    const nudge = decodePersonalityNudge(combined, target, 0.5);
    // Should detect multiple drifts since everything is far from target
    expect(nudge.adjustments.length).toBeGreaterThan(0);
    // Should include humor-related nudge
    const hasHumor = nudge.adjustments.some((a) => a.toLowerCase().includes("humor"));
    expect(hasHumor).toBe(true);
  });

  it("detects voice consistency drop", () => {
    // Set all indices to target except voice_consistency indices → set those to 0
    const combined = new Float32Array(target);
    const map = getDimensionIndexMap(DEFAULT_TARGET_DIMENSIONS);
    const vcIndices = map.get("voice_consistency")!;
    for (const idx of vcIndices) {
      combined[idx] = 0;
    }
    const nudge = decodePersonalityNudge(combined, target, 0.5);
    const hasVoice = nudge.adjustments.some(
      (a) => a.toLowerCase().includes("voice") || a.toLowerCase().includes("persona"),
    );
    expect(hasVoice).toBe(true);
  });

  it("detects patience_under_correction drop", () => {
    const combined = new Float32Array(target);
    const map = getDimensionIndexMap(DEFAULT_TARGET_DIMENSIONS);
    const pucIndices = map.get("patience_under_correction")!;
    for (const idx of pucIndices) {
      combined[idx] = 0;
    }
    const nudge = decodePersonalityNudge(combined, target, 0.5);
    const hasPatience = nudge.adjustments.some(
      (a) => a.toLowerCase().includes("correction") || a.toLowerCase().includes("character"),
    );
    expect(hasPatience).toBe(true);
  });

  it("delta vector has correct length", () => {
    const combined = new Float32Array(64);
    const nudge = decodePersonalityNudge(combined, target, 0.3);
    expect(nudge.delta).toHaveLength(64);
    expect(nudge.strength).toBe(0.3);
  });

  it("strength reflects alpha_personality", () => {
    const combined = new Float32Array(64);
    const nudge = decodePersonalityNudge(combined, target, 0.85);
    expect(nudge.strength).toBe(0.85);
  });
});
