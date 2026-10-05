import { describe, expect, it } from "vitest";
import { aaFamilyOf } from "./aa-effort-index.js";
import { feasibility } from "./thalamus-feasibility.js";
import { supplyStateFrom } from "./thalamus-supply.js";
import { GROK, HAIKU, NOW, OPUS, R, supplies } from "./thalamus-v4.test-support.js";
import {
  applyVetoes,
  hasTopicRestriction,
  isPrivateSource,
  providerOfKey,
  vetoFor,
  type VetoParams,
} from "./thalamus-vetoes.js";

const params = (over: Partial<VetoParams> = {}): VetoParams => ({
  supplies: supplies(),
  nowMs: NOW,
  private: false,
  approvedProviders: ["claude-code"],
  topic: "none",
  cautious: false,
  ...over,
});

const refusals = (key: string, cls: "medical" | "security" | "legal" | "sensitive", n: number) =>
  Array.from({ length: n }, (_, i) => ({ family: aaFamilyOf(key), cls, atMs: NOW - i * 1000 }));

describe("privacy by source", () => {
  it("matches source patterns with a trailing star", () => {
    expect(isPrivateSource("channel:whatsapp", ["channel:*"])).toBe(true);
    expect(isPrivateSource("channel:mail", ["channel:*"])).toBe(true);
    expect(isPrivateSource("tinker", ["channel:*"])).toBe(false);
    expect(isPrivateSource("tinker", ["tinker"])).toBe(true);
  });

  it("treats a call with no known source as not private", () => {
    expect(isPrivateSource(undefined, ["channel:*"])).toBe(false);
  });

  it("does not let a dot or plus in a pattern act as a wildcard", () => {
    expect(isPrivateSource("channelXwhatsapp", ["channel.whatsapp"])).toBe(false);
    expect(isPrivateSource("channel.whatsapp", ["channel.whatsapp"])).toBe(true);
  });

  it("names the provider of a route key", () => {
    expect(providerOfKey(OPUS)).toBe("claude-code");
    expect(providerOfKey(GROK)).toBe("xai");
  });

  it("blocks unapproved providers for private content, and passes approved ones", () => {
    const p = params({ private: true });
    expect(vetoFor(GROK, p)).toMatchObject({ veto: "privacy" });
    expect(vetoFor(OPUS, p)).toBeUndefined();
  });

  it("is decided before every other check", () => {
    // xAI is spent AND unapproved: the reason given is privacy, because it is settled first.
    const spent = supplyStateFrom(
      "xai",
      [{ label: "weekly", usedPercent: 100, resetAtMs: NOW + 1e6 }],
      NOW,
    );
    const p = params({ private: true, supplies: supplies({ xai: spent }) });
    expect(vetoFor(GROK, p)?.veto).toBe("privacy");
    // Not private: the same rung is refused for being spent.
    expect(vetoFor(GROK, params({ supplies: supplies({ xai: spent }) }))?.veto).toBe(
      "supply-spent",
    );
  });

  it("vetoes everything for a private task when no provider is approved", () => {
    const out = applyVetoes([R.opus, R.grok], params({ private: true, approvedProviders: [] }));
    expect(out.passed).toEqual([]);
    expect(out.vetoes.map((v) => v.veto)).toEqual(["privacy", "privacy"]);
  });
});

describe("policy table and cautious mode", () => {
  it("denies a vendor a class of topic the operator named", () => {
    const p = params({ topic: "security", policy: { xai: { security: "deny" } } });
    expect(vetoFor(GROK, p)).toMatchObject({ veto: "policy" });
    expect(vetoFor(OPUS, p)).toBeUndefined();
  });

  it("does not apply a denial to another topic", () => {
    expect(
      vetoFor(GROK, params({ topic: "legal", policy: { xai: { security: "deny" } } })),
    ).toBeUndefined();
  });

  it("in cautious mode leaves out every vendor with a topic restriction, whatever the topic", () => {
    const policy = { xai: { medical: "deny" as const } };
    const cautious = params({ topic: "none", cautious: true, policy });
    expect(vetoFor(GROK, cautious)).toMatchObject({ veto: "policy" });
    expect(vetoFor(OPUS, cautious)).toBeUndefined();
    // Sure of the topic: the same vendor is fine for a topic it is not denied.
    expect(vetoFor(GROK, params({ topic: "none", cautious: false, policy }))).toBeUndefined();
  });

  it("counts learned refusals as a restriction", () => {
    const r = refusals(GROK, "security", 2);
    expect(hasTopicRestriction(GROK, undefined, r, NOW)).toBe(true);
    expect(hasTopicRestriction(GROK, undefined, refusals(GROK, "security", 1), NOW)).toBe(false);
    expect(vetoFor(GROK, params({ cautious: true, refusals: r }))).toMatchObject({
      veto: "policy",
    });
  });

  it("forgets refusals older than thirty days", () => {
    const old = refusals(GROK, "legal", 3).map((x) => ({
      ...x,
      atMs: NOW - 31 * 24 * 3600 * 1000,
    }));
    expect(hasTopicRestriction(GROK, undefined, old, NOW)).toBe(false);
  });
});

describe("v2's checks still apply", () => {
  it("vetoes a spent window, a cooling supply, an unfunded supply, too little capacity and learned engagement", () => {
    const spent = supplyStateFrom(
      "xai",
      [{ label: "weekly", usedPercent: 100, resetAtMs: NOW + 1e6 }],
      NOW,
    );
    expect(vetoFor(GROK, params({ supplies: supplies({ xai: spent }) }))?.veto).toBe(
      "supply-spent",
    );
    expect(vetoFor(GROK, params({ cooling: new Set(["xai"]) }))?.veto).toBe("supply-cooling");
    expect(vetoFor(GROK, params({ unfunded: new Set(["xai"]) }))?.veto).toBe("supply-unfunded");
    expect(
      vetoFor(HAIKU, params({ contextWindowFor: () => 100_000, estimatedTokens: 90_000 }))?.veto,
    ).toBe("capacity");
    expect(
      vetoFor(OPUS, params({ topic: "medical", refusals: refusals(OPUS, "medical", 2) }))?.veto,
    ).toBe("engagement");
  });

  it("gives exactly v2's answer when nothing v4 adds is switched on", () => {
    const ctx = {
      supplies: supplies(),
      cooling: new Set(["xai" as const]),
      estimatedTokens: 50_000,
      contextWindowFor: (k: string) => (k === HAIKU ? 40_000 : 1_000_000),
      nowMs: NOW,
    };
    for (const key of [OPUS, HAIKU, GROK]) {
      const v2 = feasibility(key, { ...ctx, subject: "none" });
      const v4 = vetoFor(key, params({ ...ctx }));
      expect(v4?.veto, key).toBe(v2.veto);
    }
  });

  it("reports each vetoed route once, however many efforts it has", () => {
    const out = applyVetoes(
      [R.grok, { ...R.grok, effort: "low" }, { ...R.grok, effort: "max" }, R.opus],
      params({ cooling: new Set(["xai"]) }),
    );
    expect(out.vetoes).toHaveLength(1);
    expect(out.passed.map((r) => r.key)).toEqual([OPUS]);
  });
});

describe("the paper's supply case (P§3)", () => {
  it("does not make a provider cheap when a short window has room but a longer window of the same account is nearly spent", () => {
    // 5-hour bucket 20% used with 90% of its time gone: a burn candidate on its own.
    // Weekly bucket 95% used with 40% of its time gone: nearly spent, far ahead of pace.
    const state = supplyStateFrom(
      "anthropic",
      [
        { label: "5-hour", usedPercent: 20, resetAtMs: NOW + 0.1 * 5 * 3600 * 1000 },
        { label: "7-day", usedPercent: 95, resetAtMs: NOW + 0.6 * 7 * 24 * 3600 * 1000 },
      ],
      NOW,
    );
    expect(state.ballistic).toBe(false);
    expect(state.shadow).toBeGreaterThan(0);
    expect(state.binding?.label).toBe("7-day");
  });

  it("does make it cheap when every window can afford the burn", () => {
    const state = supplyStateFrom(
      "anthropic",
      [
        { label: "5-hour", usedPercent: 20, resetAtMs: NOW + 0.1 * 5 * 3600 * 1000 },
        { label: "7-day", usedPercent: 10, resetAtMs: NOW + 0.05 * 7 * 24 * 3600 * 1000 },
      ],
      NOW,
    );
    expect(state.ballistic).toBe(true);
    expect(state.shadow).toBe(-1);
  });
});
