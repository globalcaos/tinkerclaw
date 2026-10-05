import { describe, expect, it } from "vitest";
import type { DomainStrength, TaskDomain } from "./thalamus-frontier.js";
import { retryPick, type RetryPickParams } from "./thalamus-retry-pick.js";
import type { SupplyId } from "./thalamus-supply.js";
import { supplyStateFrom } from "./thalamus-supply.js";
import { FABLE, GROK, HAIKU, NOW, OPUS, R, rung, supplies } from "./thalamus-v4.test-support.js";

// the architect, 2026-10-02: "Rewind and retry with ‹model›: the model chosen by Thalamus from another family."

const GPT = "openai-codex/gpt-5.6";
const BOARD = [
  R.opus,
  R.sonnet,
  R.haiku,
  R.grok,
  rung(GPT, "xhigh", 66, 3),
  rung(GPT, "low", 50, 0.5),
  R.fable,
];

const base = (over: Partial<RetryPickParams> = {}): RetryPickParams => ({
  rungs: BOARD,
  supplies: supplies(),
  refusingKey: OPUS,
  domain: "general",
  strengthFor: () => undefined,
  nowMs: NOW,
  ...over,
});

const strengths =
  (m: Record<string, number>) =>
  (key: string, _d: TaskDomain): DomainStrength | undefined =>
    m[key] === undefined ? undefined : { p: m[key], n: 3, basis: [] };

describe("retryPick", () => {
  it("never picks the vendor that refused, and takes the smartest outside it for a general task, at its strongest effort", () => {
    const p = retryPick(base())!;
    expect(p.family).not.toBe("anthropic");
    expect(p.model).toBe(GPT);
    expect(p.effort).toBe("xhigh");
  });

  it("ranks a model with a measured row for the domain above one without, then by that strength", () => {
    const p = retryPick(
      base({ domain: "code", strengthFor: strengths({ [GROK]: 0.9, [GPT]: 0.6 }) }),
    )!;
    expect(p.model).toBe(GROK);
    expect(p.strength).toBe(0.9);
    expect(p.reason).toContain("measured code strength");
    // only one of the two has a row: the measured one wins even though the other is smarter overall
    const only = retryPick(base({ domain: "code", strengthFor: strengths({ [GROK]: 0.2 }) }))!;
    expect(only.model).toBe(GROK);
  });

  it("skips a cooling supply, an unfunded one and a spent one", () => {
    expect(retryPick(base({ cooling: new Set<SupplyId>(["openai"]) }))!.model).toBe(GROK);
    expect(retryPick(base({ unfunded: new Set<SupplyId>(["openai"]) }))!.model).toBe(GROK);
    const spent = supplies();
    spent.set("openai", supplyStateFrom("openai", [{ label: "5-hour", usedPercent: 100 }], NOW));
    expect(retryPick(base({ supplies: spent }))!.model).toBe(GROK);
  });

  it("skips a model whose window the job does not fit", () => {
    const p = retryPick(
      base({
        estimatedTokens: 300_000,
        contextWindowFor: (k) => (k === GPT ? 200_000 : 1_000_000),
      }),
    )!;
    expect(p.model).toBe(GROK);
  });

  it("with a private source takes only approved providers, which leaves nothing when the refuser is the only one", () => {
    expect(retryPick(base({ allowedProviders: ["claude-code"] }))).toBeUndefined();
    expect(retryPick(base({ allowedProviders: ["claude-code", "openai-codex"] }))!.model).toBe(GPT);
  });

  it("never drifts into the reserved set, even when another vendor refused", () => {
    const p = retryPick(base({ refusingKey: GROK }))!;
    expect(p.model).not.toBe(FABLE);
    expect(retryPick(base({ rungs: [R.opus, R.fable, R.grok], refusingKey: GROK }))!.model).toBe(
      OPUS,
    );
  });

  it("is undefined when nothing outside the refusing vendor can take the turn", () => {
    expect(retryPick(base({ rungs: [R.opus, R.sonnet, R.haiku, R.fable] }))).toBeUndefined();
    expect(retryPick(base({ rungs: [] }))).toBeUndefined();
  });
});
