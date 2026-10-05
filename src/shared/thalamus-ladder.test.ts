import { describe, expect, it } from "vitest";
import { FAILURE_CLASSES, LADDER_QUALITY_SLACK, ladderFor } from "./thalamus-ladder.js";
import { MAX_CHAIN } from "./thalamus-plan.js";
import { routeCall } from "./thalamus-route-call.js";
import type { PricedOption } from "./thalamus-v4-types.js";
import { callParams, GROK, HAIKU, OPUS, R, rung, SONNET } from "./thalamus-v4.test-support.js";

const RUNGS = [R.opus, R.sonnet, R.haiku, R.grok];

/** Real priced options, from a real decision, with Opus the incumbent. */
function board(over: Parameters<typeof callParams>[0] = {}) {
  const d = routeCall(callParams({ rungs: RUNGS, ...over }))!;
  const options = d.options.filter((o) => o.feed === "thread");
  const chosen = options.find((o) => o.rung.key === OPUS)!;
  return { d, options, chosen };
}

const keys = (l: { key: string }[]) => l.map((e) => e.key);

describe("the ladder by reason", () => {
  it("has a list for every failure class", () => {
    const { options, chosen } = board();
    const l = ladderFor({ options, chosen, handPicked: false });
    expect(Object.keys(l.byReason).toSorted()).toEqual([...FAILURE_CLASSES].toSorted());
    expect(l.handPicked).toBe(false);
  });

  it("gives a hand-picked model no ladder at all", () => {
    const { options, chosen } = board();
    const l = ladderFor({ options, chosen, handPicked: true });
    expect(l.handPicked).toBe(true);
    for (const c of FAILURE_CLASSES) expect(l.byReason[c], c).toEqual([]);
  });

  it("sends a rate limit to another provider only", () => {
    const { options, chosen } = board();
    expect(keys(ladderFor({ options, chosen, handPicked: false }).byReason.rate_limit)).toEqual([
      GROK,
    ]);
  });

  it("tries the same provider first when a server is overloaded, then another", () => {
    const { options, chosen } = board({ rungs: [R.opus, R.sonnet, R.grok] });
    const l = ladderFor({ options, chosen, handPicked: false, minQuality: 0 });
    expect(keys(l.byReason.overloaded)).toEqual([SONNET, GROK]);
  });

  it("sends a too-long thread to a strictly larger window, never to an unknown one", () => {
    const { options, chosen } = board({ rungs: [R.opus, R.sonnet, R.haiku, R.grok] });
    const windows: Record<string, number> = {
      [OPUS]: 200_000,
      [SONNET]: 1_000_000,
      [HAIKU]: 200_000,
      [GROK]: 500_000,
    };
    const l = ladderFor({
      options,
      chosen,
      handPicked: false,
      contextWindowFor: (k) => windows[k],
      threadTokens: 100_000,
      minQuality: 0,
    });
    expect(keys(l.byReason.capacity).toSorted()).toEqual([GROK, SONNET].toSorted());
    // A window nobody published cannot be called larger.
    const partial = ladderFor({
      options,
      chosen,
      handPicked: false,
      contextWindowFor: (k) => (k === OPUS ? 200_000 : k === GROK ? 500_000 : undefined),
      threadTokens: 100_000,
      minQuality: 0,
    });
    expect(keys(partial.byReason.capacity)).toEqual([GROK]);
  });

  it("offers no larger window when the pick's own window is unknown", () => {
    const { options, chosen } = board();
    expect(
      ladderFor({ options, chosen, handPicked: false, contextWindowFor: () => undefined }).byReason
        .capacity,
    ).toEqual([]);
  });

  it("does not offer a window the thread would not fit with room to spare", () => {
    const { options, chosen } = board({ rungs: [R.opus, R.grok] });
    const l = ladderFor({
      options,
      chosen,
      handPicked: false,
      contextWindowFor: (k) => (k === OPUS ? 100_000 : 300_000),
      threadTokens: 290_000,
    });
    expect(l.byReason.capacity).toEqual([]);
  });

  it("sends a refusal to another provider, strongest first", () => {
    const stronger = rung("xai/grok-5", "high", 75, 3);
    const { options, chosen } = board({ rungs: [R.opus, R.sonnet, R.grok, stronger] });
    const l = ladderFor({ options, chosen, handPicked: false, minQuality: 0 });
    expect(keys(l.byReason.engagement)).toEqual(["xai/grok-5", GROK]);
    expect(keys(l.byReason.engagement)).not.toContain(SONNET);
  });

  it("sends a timeout to a strictly faster rung", () => {
    const timeFor = (key: string) => ({
      ttftColdSec: 2.5,
      ttftWarmSec: 1,
      tokensPerSec: key === GROK ? 400 : key === SONNET ? 90 : 60,
      thinkSec: { mechanical: 0, routine: 3, deep: 20 },
    });
    const { options, chosen } = board({ timeFor, rungs: [R.opus, R.sonnet, R.grok] });
    const l = ladderFor({ options, chosen, handPicked: false, minQuality: 0 });
    expect(keys(l.byReason.timeout)).toEqual([GROK, SONNET]);
    for (const e of l.byReason.timeout) {
      const o = options.find((x) => x.rung.key === e.key)!;
      expect(o.parts.timeSec).toBeLessThan(chosen.parts.timeSec);
    }
  });

  it("never lists the pick itself, and keeps to the pick's way of being fed", () => {
    const { options, chosen } = board();
    const l = ladderFor({ options, chosen, handPicked: false, minQuality: 0 });
    for (const c of FAILURE_CLASSES) expect(keys(l.byReason[c])).not.toContain(OPUS);
  });

  it("leaves out an option below the quality floor", () => {
    const { options, chosen } = board();
    const strict = ladderFor({ options, chosen, handPicked: false, minQuality: 65 });
    expect(strict.byReason.rate_limit).toEqual([]);
    const l = ladderFor({ options, chosen, handPicked: false });
    expect(chosen.quality - LADDER_QUALITY_SLACK).toBeLessThan(R.grok.smart);
    expect(keys(l.byReason.rate_limit)).toEqual([GROK]);
  });

  it("offers only options that passed the vetoes: what routeCall dropped is not on any ladder", () => {
    const { options, chosen } = board({ cooling: new Set(["xai"]) });
    const l = ladderFor({ options, chosen, handPicked: false, minQuality: 0 });
    for (const c of FAILURE_CLASSES) expect(keys(l.byReason[c]), c).not.toContain(GROK);
  });

  it("caps a list at MAX_CHAIN and lists each route and effort once", () => {
    const many = Array.from({ length: 10 }, (_, i) => rung(`xai/grok-${i}`, "high", 60, 2));
    const { options, chosen } = board({ rungs: [R.opus, ...many, ...many] });
    const l = ladderFor({ options, chosen, handPicked: false, minQuality: 0 });
    expect(l.byReason.rate_limit).toHaveLength(MAX_CHAIN);
    expect(new Set(l.byReason.rate_limit.map((e) => e.key)).size).toBe(MAX_CHAIN);
  });

  it("orders ties the same way whatever order the options arrive in", () => {
    const { options, chosen } = board({ rungs: [R.opus, R.sonnet, R.grok] });
    const a = ladderFor({ options, chosen, handPicked: false, minQuality: 0 });
    const shuffled = [...options].toReversed() as PricedOption[];
    const b = ladderFor({ options: shuffled, chosen, handPicked: false, minQuality: 0 });
    expect(b).toEqual(a);
  });
});
