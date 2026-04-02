import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Tests for mid-context persona re-injection.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createCortexRuntime, SYNC_SCORE_DRIFT_THRESHOLD } from "../src/cortex-runtime.js";
import { applyMidContextReinject, evaluateTurnSyncScore } from "../src/mid-context-reinject.js";

describe("Mid-Context Reinject", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reinject-"));
    vi.stubEnv("HOME", dir);
    mkdirSync(join(dir, ".openclaw"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("no-ops when cortexRuntime is null", () => {
    const result = applyMidContextReinject(null, "existing prompt");
    expect(result.reinjected).toBe(false);
    expect(result.systemPrompt).toBe("existing prompt");
    expect(result.ewmaScore).toBe(1.0);
  });

  it("no-ops when cortexRuntime is undefined", () => {
    const result = applyMidContextReinject(undefined, "existing prompt");
    expect(result.reinjected).toBe(false);
  });

  it("does not reinject when EWMA is healthy (>= threshold)", () => {
    const rt = createCortexRuntime();
    // EWMA starts at 1.0
    const result = applyMidContextReinject(rt, "system instructions here");
    expect(result.reinjected).toBe(false);
    expect(result.systemPrompt).toBe("system instructions here");
    expect(result.ewmaScore).toBe(1.0);
  });

  it("prepends persona block when EWMA drops below threshold", () => {
    const rt = createCortexRuntime({ syncScoreInterval: 1 });
    // Force EWMA below threshold by accessing internal state via the object
    // We'll use a mock approach: create a runtime mock
    const mockRuntime = {
      get ewmaSyncScore() {
        return 0.4;
      },
      getPersonaBlock() {
        return "# Persona: Test\n## Identity\nTest persona.";
      },
      persona: rt.persona,
      evaluateSyncScore: rt.evaluateSyncScore,
      detectDrift: rt.detectDrift,
    };

    const result = applyMidContextReinject(mockRuntime, "original prompt");
    expect(result.reinjected).toBe(true);
    expect(result.systemPrompt).toContain("# Persona: Test");
    expect(result.systemPrompt).toContain("original prompt");
    expect(result.ewmaScore).toBe(0.4);
  });

  it("does not reinject if persona block is empty", () => {
    const mockRuntime = {
      get ewmaSyncScore() {
        return 0.3;
      },
      getPersonaBlock() {
        return "";
      },
      persona: createCortexRuntime().persona,
      evaluateSyncScore: createCortexRuntime().evaluateSyncScore,
      detectDrift: createCortexRuntime().detectDrift,
    };

    const result = applyMidContextReinject(mockRuntime, "original");
    expect(result.reinjected).toBe(false);
  });

  it("threshold constant is 0.6", () => {
    expect(SYNC_SCORE_DRIFT_THRESHOLD).toBe(0.6);
  });
});

describe("evaluateTurnSyncScore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eval-"));
    vi.stubEnv("HOME", dir);
    mkdirSync(join(dir, ".openclaw"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("no-ops when cortexRuntime is null", () => {
    // Should not throw
    evaluateTurnSyncScore(null, ["test"], 1);
  });

  it("no-ops when assistantTexts is empty", () => {
    const rt = createCortexRuntime();
    evaluateTurnSyncScore(rt, [], 1);
  });

  it("calls logFn when reinjection is needed", () => {
    const logs: string[] = [];
    const mockRuntime = {
      get ewmaSyncScore() {
        return 0.3;
      },
      getPersonaBlock() {
        return "persona";
      },
      persona: createCortexRuntime().persona,
      evaluateSyncScore(_msgs: string[], _turn?: number) {
        return {
          rawScore: 0.3,
          ewmaScore: 0.3,
          needsReinjection: true,
          turnNumber: 1,
          timestamp: new Date().toISOString(),
          consistency: { C: 0.3, Munit: 1, Memb: 0, action: "severe_rebase" as const },
        };
      },
      detectDrift: createCortexRuntime().detectDrift,
    };

    evaluateTurnSyncScore(mockRuntime, ["test response"], 1, (msg) => logs.push(msg));
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("SyncScore drift detected");
  });
});
