import { describe, expect, it } from "vitest";
import { DEFAULT_CONTINUOUS_COMPACT_CONFIG, resolveContinuousCompactConfig } from "./config.js";

describe("resolveContinuousCompactConfig", () => {
  it("returns disabled when no config", () => {
    expect(resolveContinuousCompactConfig(undefined).enabled).toBe(false);
  });

  it("returns disabled when not enabled", () => {
    expect(resolveContinuousCompactConfig({} as never).enabled).toBe(false);
  });

  it("returns enabled with defaults", () => {
    const cfg = { agents: { defaults: { continuousCompact: { enabled: true } } } };
    const result = resolveContinuousCompactConfig(cfg as never);
    expect(result.enabled).toBe(true);
    expect(result.indexer.windowSize).toBe(DEFAULT_CONTINUOUS_COMPACT_CONFIG.indexer.windowSize);
    expect(result.retrieval.maxRetrievedChunks).toBe(
      DEFAULT_CONTINUOUS_COMPACT_CONFIG.retrieval.maxRetrievedChunks,
    );
  });

  it("merges user overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          continuousCompact: {
            enabled: true,
            windowSize: 30,
            maxRetrievedTurns: 12,
            minScore: 0.5,
          },
        },
      },
    };
    const result = resolveContinuousCompactConfig(cfg as never);
    expect(result.indexer.windowSize).toBe(30);
    expect(result.retrieval.maxRetrievedChunks).toBe(12);
    expect(result.retrieval.minScore).toBe(0.5);
  });

  it("defaults fallbackToBatchCompaction to true", () => {
    const cfg = { agents: { defaults: { continuousCompact: { enabled: true } } } };
    expect(resolveContinuousCompactConfig(cfg as never).fallbackToBatchCompaction).toBe(true);
  });
});
