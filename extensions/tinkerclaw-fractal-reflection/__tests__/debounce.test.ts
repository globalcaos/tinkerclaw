import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  checkDebounce,
  resetDebounce,
  isAutomatedSession,
  injectFractalReflection,
} from "../src/fractal-inject.js";

describe("Fractal Reflection debounce", () => {
  beforeEach(() => {
    resetDebounce();
  });

  it("allows first injection", () => {
    expect(checkDebounce("agent:main:main", 30_000)).toBe(true);
  });

  it("blocks injection within debounce window", () => {
    expect(checkDebounce("agent:main:main", 30_000)).toBe(true);
    expect(checkDebounce("agent:main:main", 30_000)).toBe(false);
  });

  it("allows injection after debounce window expires", () => {
    const realNow = Date.now;
    let fakeTime = 1000000;
    Date.now = () => fakeTime;

    try {
      expect(checkDebounce("agent:main:main", 30_000)).toBe(true);
      // Still within window
      fakeTime += 29_999;
      expect(checkDebounce("agent:main:main", 30_000)).toBe(false);
      // Just past window
      fakeTime += 2;
      expect(checkDebounce("agent:main:main", 30_000)).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it("tracks debounce independently per session", () => {
    expect(checkDebounce("session-a", 30_000)).toBe(true);
    expect(checkDebounce("session-b", 30_000)).toBe(true);
    // session-a is debounced, session-b is debounced
    expect(checkDebounce("session-a", 30_000)).toBe(false);
    expect(checkDebounce("session-b", 30_000)).toBe(false);
  });
});

describe("Fractal Reflection automated session filtering", () => {
  it("skips subagent sessions", () => {
    expect(isAutomatedSession("agent:main:subagent:task-1")).toBe(true);
  });

  it("skips isolated sessions", () => {
    expect(isAutomatedSession("agent:main:isolated:cron-task")).toBe(true);
  });

  it("skips cron sessions", () => {
    expect(isAutomatedSession("agent:main:cron:daily")).toBe(true);
  });

  it("skips heartbeat sessions", () => {
    expect(isAutomatedSession("agent:main:heartbeat")).toBe(true);
  });

  it("allows normal interactive sessions", () => {
    expect(isAutomatedSession("agent:main:main")).toBe(false);
    expect(isAutomatedSession("agent:main:dm:user123")).toBe(false);
  });
});

describe("Fractal Reflection injection skips", () => {
  beforeEach(() => {
    resetDebounce();
  });

  it("skips when disabled (empty sessionKey)", async () => {
    const log = { info: vi.fn() };
    const result = await injectFractalReflection({
      sessionKey: "",
      extensionDir: __dirname,
      debounceMs: 30_000,
      log,
    });
    expect(result).toBe(false);
  });

  it("skips automated sessions", async () => {
    const log = { info: vi.fn() };
    const result = await injectFractalReflection({
      sessionKey: "agent:main:heartbeat",
      extensionDir: __dirname,
      debounceMs: 30_000,
      log,
    });
    expect(result).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("automated session"),
    );
  });

  it("skips NO_REPLY responses", async () => {
    const log = { info: vi.fn() };
    const result = await injectFractalReflection({
      sessionKey: "agent:main:main",
      extensionDir: __dirname,
      debounceMs: 30_000,
      messages: [{ role: "assistant", content: "NO_REPLY" }],
      log,
    });
    expect(result).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("silent reply"),
    );
  });

  it("skips HEARTBEAT_OK responses", async () => {
    const log = { info: vi.fn() };
    const result = await injectFractalReflection({
      sessionKey: "agent:main:main",
      extensionDir: __dirname,
      debounceMs: 30_000,
      messages: [{ role: "assistant", content: "HEARTBEAT_OK" }],
      log,
    });
    expect(result).toBe(false);
  });
});
