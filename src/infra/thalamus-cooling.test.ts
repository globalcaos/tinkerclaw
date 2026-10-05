import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearThalamusCoolingCache,
  DEFAULT_COOLING_MS,
  readThalamusCooling,
  recordSupplyLimit,
} from "./thalamus-cooling.js";

// the architect, 2026-10-02: "Limits cool their supply until the reset time the error gives, or 30 minutes; the next turn
// goes to the best supply still open; the state survives a restart."

// 2026-10-02 10:00:00 UTC is 12:00 in Madrid (CEST, UTC+2).
const NOW = Date.UTC(2026, 9, 2, 10, 0, 0);
const MIN = 60 * 1000;

let file: string;
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), "thal-cool-")), "cooling.json");
  clearThalamusCoolingCache();
});
afterEach(() => {
  delete process.env.OPENCLAW_THALAMUS_COOLING_FILE;
  clearThalamusCoolingCache();
});

const limit = (over: Partial<Parameters<typeof recordSupplyLimit>[0]> = {}) =>
  recordSupplyLimit({
    provider: "openai-codex",
    model: "gpt-5.6",
    reason: "rate_limit",
    nowMs: NOW,
    file,
    ...over,
  });

describe("recordSupplyLimit — the reset time", () => {
  it("reads a relative wait from the provider's own text", () => {
    const hit = limit({
      error: "You have hit your ChatGPT usage limit (plus plan). Try again in ~262 min.",
    });
    expect(hit?.supply).toBe("openai");
    expect(hit?.entry.until).toBe(NOW + 262 * MIN);
    expect(hit?.entry.stated).toBe(true);
  });
  it("reads a wall-clock reset with its time zone (Claude)", () => {
    const hit = limit({
      provider: "claude-code",
      model: "claude-opus-5-5",
      error: "Claude usage limit reached. Your limit will reset at resets 3:10pm (Europe/Madrid)",
    });
    expect(hit?.supply).toBe("anthropic");
    // 15:10 in Madrid is 13:10 UTC, 3 h 10 min after NOW
    expect(hit?.entry.until).toBe(NOW + 190 * MIN);
  });
  it("reads an absolute instant", () => {
    const at = new Date(NOW + 45 * MIN).toISOString();
    const hit = limit({ error: `rate limited, resets ${at}` });
    expect(hit?.entry.until).toBe(NOW + 45 * MIN);
  });
  it("falls back to 30 minutes when the error states no reset", () => {
    const hit = limit({ error: "429 Too Many Requests" });
    expect(hit?.entry.until).toBe(NOW + DEFAULT_COOLING_MS);
    expect(DEFAULT_COOLING_MS).toBe(30 * MIN);
    expect(hit?.entry.stated).toBe(false);
  });
});

describe("recordSupplyLimit — what counts as a limit", () => {
  it("cools on rate_limit and billing", () => {
    expect(limit({ reason: "rate_limit" })).toBeDefined();
    clearThalamusCoolingCache();
    expect(limit({ provider: "xai", model: "grok-4.7", reason: "billing" })?.supply).toBe("xai");
  });
  it("does not cool on overloaded, timeout, auth or no reason: a busy vendor is not a spent supply", () => {
    for (const reason of ["overloaded", "timeout", "auth", "unknown", null, undefined]) {
      expect(limit({ reason })).toBeUndefined();
    }
    expect(readThalamusCooling({ file, nowMs: NOW }).set.size).toBe(0);
  });
  it("does not cool a provider the supply table does not know", () => {
    expect(limit({ provider: "some-local-thing" })).toBeUndefined();
  });
  it("treats claude-code and anthropic as one pool", () => {
    limit({ provider: "claude-code", model: "claude-opus-5-5" });
    expect(readThalamusCooling({ file, nowMs: NOW }).set.has("anthropic")).toBe(true);
    expect(limit({ provider: "anthropic", model: "claude-sonnet-5-5" })?.supply).toBe("anthropic");
  });
});

describe("the store", () => {
  it("never shortens an earlier, longer limit", () => {
    limit({ error: "Try again in ~120 min" });
    const second = limit({ error: "Try again in ~10 min", nowMs: NOW + MIN });
    expect(second?.entry.until).toBe(NOW + 120 * MIN);
  });
  it("survives a restart: a fresh read of the file, with the cache cleared, still sees it", () => {
    limit({ error: "Try again in ~60 min" });
    clearThalamusCoolingCache();
    const c = readThalamusCooling({ file, nowMs: NOW + 10 * MIN });
    expect([...c.set]).toEqual(["openai"]);
    expect(c.until.get("openai")).toBe(NOW + 60 * MIN);
  });
  it("forgets a supply once its time has passed, and drops the expired entry on the next write", () => {
    limit({ error: "Try again in ~5 min" });
    expect(readThalamusCooling({ file, nowMs: NOW + 6 * MIN }).set.size).toBe(0);
    limit({ provider: "xai", model: "grok-4.7", nowMs: NOW + 6 * MIN });
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(Object.keys(onDisk)).toEqual(["xai"]);
  });
  it("treats a corrupt file as nothing cooling, and the next limit rewrites it", () => {
    writeFileSync(file, "{broken");
    expect(readThalamusCooling({ file, nowMs: NOW }).set.size).toBe(0);
    expect(limit()?.supply).toBe("openai");
    expect(readThalamusCooling({ file, nowMs: NOW }).set.has("openai")).toBe(true);
  });
  it("keeps several supplies at once", () => {
    limit();
    limit({ provider: "xai", model: "grok-4.7" });
    expect(new Set(readThalamusCooling({ file, nowMs: NOW }).set)).toEqual(
      new Set(["openai", "xai"]),
    );
  });
});

describe("tests never touch the operator's file", () => {
  it("with no injected path a write is skipped and a read sees an empty store", () => {
    delete process.env.OPENCLAW_THALAMUS_COOLING_FILE;
    expect(
      recordSupplyLimit({ provider: "xai", model: "grok-4.7", reason: "rate_limit", nowMs: NOW }),
    ).toBeUndefined();
    expect(readThalamusCooling({ nowMs: NOW }).set.size).toBe(0);
  });
  it("honours OPENCLAW_THALAMUS_COOLING_FILE", () => {
    process.env.OPENCLAW_THALAMUS_COOLING_FILE = file;
    recordSupplyLimit({ provider: "xai", model: "grok-4.7", reason: "rate_limit", nowMs: NOW });
    expect(readThalamusCooling({ nowMs: NOW + MIN }).set.has("xai")).toBe(true);
  });
});

describe("recordSupplyLimit — a supply that rejects this client (426)", () => {
  // 2026-10-02: a 426 is not a usage limit, but the supply refuses every call until the client is upgraded, so the
  // next plan must skip it exactly as it skips a spent one.
  it("cools the supply for the default time when the error is a 426", () => {
    const hit = limit({
      provider: "xai",
      model: "grok-4.7",
      reason: "auth",
      status: 426,
      error:
        '426 "Your Grok CLI version (0.2.91) is outdated. Please update to version 1.0.13 or later."',
    });
    expect(hit?.supply).toBe("xai");
    expect(hit?.entry.until).toBe(NOW + DEFAULT_COOLING_MS);
    expect(hit?.entry.reason).toBe("client_rejected");
    expect(readThalamusCooling({ file, nowMs: NOW + MIN }).set.has("xai")).toBe(true);
  });
  it("reads the 426 from the error text when no status is passed", () => {
    const hit = limit({
      provider: "xai",
      model: "grok-4.7",
      reason: "auth",
      error: "426 Upgrade Required",
    });
    expect(hit?.supply).toBe("xai");
  });
  it("does not cool on a plain auth failure (a 401 is refreshed, not a spent supply)", () => {
    const hit = limit({
      provider: "xai",
      model: "grok-4.7",
      reason: "auth",
      status: 401,
      error: "401 invalid token",
    });
    expect(hit).toBeUndefined();
  });
});
