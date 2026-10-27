import { describe, expect, it } from "vitest";
import {
  DEFAULT_FRACTAL_GUARD_MODE,
  fractalGuardEnv,
  isBackgroundFractalSession,
  resolveFractalGuardMode,
} from "./fractal-guard.js";

// FORK 2026-10-25: only a background Fractal's worker carries the guard's variables; every other worker's environment
// stays exactly what it was.

describe("fractal guard switch", () => {
  it("knows a background Fractal session by its key", () => {
    expect(isBackgroundFractalSession("agent:main:fractal:5720db30-5620")).toBe(true);
    expect(isBackgroundFractalSession("agent:goku:fractal:run-1")).toBe(true);
    expect(isBackgroundFractalSession("agent:main:main")).toBe(false);
    expect(isBackgroundFractalSession("agent:main:tinker:mvnupe2h")).toBe(false);
    expect(isBackgroundFractalSession("agent:main:fractal-reflection:triage:x")).toBe(false);
    expect(isBackgroundFractalSession("agent:main:fractal:")).toBe(false);
    expect(isBackgroundFractalSession("agent:main:fractal:a:b")).toBe(false);
    expect(isBackgroundFractalSession(undefined)).toBe(false);
  });

  it("enforces by default and reads any other value as the default", () => {
    expect(DEFAULT_FRACTAL_GUARD_MODE).toBe("enforce");
    expect(resolveFractalGuardMode(undefined)).toBe("enforce");
    expect(resolveFractalGuardMode("bogus")).toBe("enforce");
    expect(resolveFractalGuardMode(" Watch ")).toBe("watch");
    expect(resolveFractalGuardMode("off")).toBe("off");
  });

  it("gives the mode and the start time to a Fractal worker only, and nothing when off", () => {
    expect(fractalGuardEnv("agent:main:fractal:p1", undefined, 1234)).toEqual({
      TC_FRACTAL_GUARD: "enforce",
      TC_FRACTAL_GUARD_SINCE: "1234",
    });
    expect(fractalGuardEnv("agent:main:fractal:p1", "watch", 5)).toEqual({
      TC_FRACTAL_GUARD: "watch",
      TC_FRACTAL_GUARD_SINCE: "5",
    });
    expect(fractalGuardEnv("agent:main:fractal:p1", "off", 5)).toEqual({});
    expect(fractalGuardEnv("agent:main:main", "enforce", 5)).toEqual({});
  });
});
