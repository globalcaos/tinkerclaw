import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearOrcaBiasCache } from "./orca-bias-store.js";
import { isHandPicked, readThalamusBoard } from "./thalamus-board.js";
import { clearThalamusCoolingCache, recordSupplyLimit } from "./thalamus-cooling.js";
import { clearThalamusTierDefaultsCache } from "./thalamus-tier-defaults.js";

let tmp = "";
let prevBias: string | undefined;
let prevDefaults: string | undefined;
let prevCooling: string | undefined;

// Never the operator's files: the board reads the dial, the suggestions and the cooling store, and each has its own
// test seam (2026-10-02; the same rule as model-selection.thalamus.test.ts).
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thalamus-board-"));
  prevBias = process.env.OPENCLAW_ORCA_BIAS_FILE;
  prevDefaults = process.env.OPENCLAW_THALAMUS_DEFAULTS_FILE;
  prevCooling = process.env.OPENCLAW_THALAMUS_COOLING_FILE;
  process.env.OPENCLAW_ORCA_BIAS_FILE = path.join(tmp, "orca-bias.json");
  process.env.OPENCLAW_THALAMUS_DEFAULTS_FILE = path.join(tmp, "thalamus-tier-defaults.json");
  process.env.OPENCLAW_THALAMUS_COOLING_FILE = path.join(tmp, "thalamus-cooling.json");
  clearOrcaBiasCache();
  clearThalamusTierDefaultsCache();
  clearThalamusCoolingCache();
});
afterAll(() => {
  const restore = (name: string, prev: string | undefined) => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  };
  restore("OPENCLAW_ORCA_BIAS_FILE", prevBias);
  restore("OPENCLAW_THALAMUS_DEFAULTS_FILE", prevDefaults);
  restore("OPENCLAW_THALAMUS_COOLING_FILE", prevCooling);
  clearOrcaBiasCache();
  clearThalamusTierDefaultsCache();
  clearThalamusCoolingCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const cfg = (over: Record<string, unknown> = {}): OpenClawConfig =>
  ({
    agents: {
      defaults: {
        models: {
          "claude-code/claude-opus-5": { intelligenceIndex: 70 },
          "claude-code/claude-haiku-4-5": { intelligenceIndex: 52 },
          "openrouter/not-indexed": {},
          bad: { intelligenceIndex: 60 },
        },
      },
    },
    models: {
      providers: {
        "claude-code": {
          models: [
            { id: "claude-opus-5", contextWindow: 1_000_000 },
            { id: "claude-haiku-4-5", contextWindow: 200_000 },
          ],
        },
      },
    },
    ...over,
  }) as unknown as OpenClawConfig;

describe("the board", () => {
  it("builds rungs from the models that publish an intelligence index, and skips the rest", () => {
    const b = readThalamusBoard(cfg())!;
    const keys = new Set(b.rungs.map((r) => r.key));
    expect(keys.has("claude-code/claude-opus-5")).toBe(true);
    expect(keys.has("claude-code/claude-haiku-4-5")).toBe(true);
    expect(keys.has("openrouter/not-indexed")).toBe(false);
    expect(keys.has("bad")).toBe(false);
  });

  it("reads context windows from the model config", () => {
    const b = readThalamusBoard(cfg())!;
    expect(b.contextWindowFor("claude-code/claude-opus-5")).toBe(1_000_000);
    expect(b.contextWindowFor("claude-code/claude-haiku-4-5")).toBe(200_000);
    expect(b.contextWindowFor("xai/none")).toBeUndefined();
  });

  it("has nothing to route over when no model has an index", () => {
    expect(
      readThalamusBoard(cfg({ agents: { defaults: { models: { "a/b": {} } } } })),
    ).toBeUndefined();
    expect(readThalamusBoard({} as OpenClawConfig)).toBeUndefined();
  });

  it("uses the middle stop, default, when nobody has set the dial (2026-10-02; it was smart for a day), and the stored dial when they have", () => {
    fs.rmSync(process.env.OPENCLAW_ORCA_BIAS_FILE!, { force: true });
    clearOrcaBiasCache();
    expect(readThalamusBoard(cfg())!.dialIdx).toBe(3);
    fs.writeFileSync(process.env.OPENCLAW_ORCA_BIAS_FILE!, JSON.stringify({ biasIdx: 5, ts: 1 }));
    clearOrcaBiasCache();
    expect(readThalamusBoard(cfg())!.dialIdx).toBe(5);
  });

  it("carries the suggestion of the dial's stop, with its key normalised, and none when the stop has none", () => {
    const file = process.env.OPENCLAW_THALAMUS_DEFAULTS_FILE!;
    fs.writeFileSync(
      file,
      JSON.stringify({ default: { model: "claude-code/claude-opus-5", effort: "low" } }),
    );
    clearThalamusTierDefaultsCache();
    fs.writeFileSync(process.env.OPENCLAW_ORCA_BIAS_FILE!, JSON.stringify({ biasIdx: 3, ts: 1 }));
    clearOrcaBiasCache();
    expect(readThalamusBoard(cfg())!.suggestion).toEqual({
      key: "claude-code/claude-opus-5",
      effort: "low",
    });
    // the smart stop has no suggestion in that file
    fs.writeFileSync(process.env.OPENCLAW_ORCA_BIAS_FILE!, JSON.stringify({ biasIdx: 6, ts: 2 }));
    clearOrcaBiasCache();
    expect(readThalamusBoard(cfg())!.suggestion).toBeUndefined();
    fs.rmSync(file, { force: true });
    clearThalamusTierDefaultsCache();
  });

  it("carries the supplies cooling after a limit, and when they reopen; none when nothing cools", () => {
    expect(readThalamusBoard(cfg())!.cooling).toBeUndefined();
    const hit = recordSupplyLimit({
      provider: "claude-code",
      model: "claude-opus-5",
      reason: "rate_limit",
      error: "usage limit. Try again in ~90 min",
    });
    const b = readThalamusBoard(cfg())!;
    expect([...(b.cooling ?? [])]).toEqual(["anthropic"]);
    expect(b.coolingUntil?.get("anthropic")).toBe(hit?.entry.until);
    fs.rmSync(process.env.OPENCLAW_THALAMUS_COOLING_FILE!, { force: true });
    clearThalamusCoolingCache();
  });

  it("stamps the time it was built", () => {
    expect(readThalamusBoard(cfg(), 1234)!.builtAtMs).toBe(1234);
  });

  it("does not write anything", () => {
    const before = fs.readdirSync(tmp).toSorted();
    readThalamusBoard(cfg());
    expect(fs.readdirSync(tmp).toSorted()).toEqual(before);
  });
});

describe("hand-picked models", () => {
  const storeFor = (entries: Record<string, unknown>) => {
    const file = path.join(tmp, `sessions-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(entries));
    return { session: { store: file } } as unknown as OpenClawConfig;
  };

  it("counts a model the user pinned", () => {
    const c = storeFor({
      "agent:main:tinker:a": {
        sessionId: "1",
        updatedAt: 1,
        modelOverride: "claude-opus-5",
        modelOverrideSource: "user",
      },
    });
    expect(isHandPicked(c, "main", "agent:main:tinker:a")).toBe(true);
  });

  it("counts a legacy pin with no source, as v2 does", () => {
    const c = storeFor({
      "agent:main:tinker:a": { sessionId: "1", updatedAt: 1, modelOverride: "claude-opus-5" },
    });
    expect(isHandPicked(c, "main", "agent:main:tinker:a")).toBe(true);
  });

  it("does not count a model the runner chose itself, or no override at all", () => {
    const c = storeFor({
      "agent:main:tinker:a": {
        sessionId: "1",
        updatedAt: 1,
        modelOverride: "claude-opus-5",
        modelOverrideSource: "auto",
      },
      "agent:main:tinker:b": { sessionId: "2", updatedAt: 1 },
    });
    expect(isHandPicked(c, "main", "agent:main:tinker:a")).toBe(false);
    expect(isHandPicked(c, "main", "agent:main:tinker:b")).toBe(false);
    expect(isHandPicked(c, "main", "agent:main:tinker:missing")).toBe(false);
  });

  it("is false with no session key, and false for a store that is missing or cannot be parsed (nothing readable is pinned)", () => {
    expect(isHandPicked(storeFor({}), "main", undefined)).toBe(false);
    expect(
      isHandPicked(
        { session: { store: path.join(tmp, "absent.json") } } as unknown as OpenClawConfig,
        "main",
        "k",
      ),
    ).toBe(false);
    const bad = path.join(tmp, "broken.json");
    fs.writeFileSync(bad, "{not json");
    expect(
      isHandPicked({ session: { store: bad } } as unknown as OpenClawConfig, "main", "k"),
    ).toBe(false);
  });
});
