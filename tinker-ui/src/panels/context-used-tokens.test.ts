/**
 * Burn review b1113-c-ui-panels F1 — `contextWindow.usedTokens` is the run's SUM over its calls
 * (embedded-agent-subscribe.ts `usageTotals.total`), so a value under the window is still not one
 * prompt's size. Both panels must size the prompt from the row's own itemised
 * `contextSent.totalTokens`, and fall back to `usedTokens` only when the row itemises nothing.
 */
import { describe, expect, it } from "vitest";
import { mountContextTimeline, type AnatomyEvent } from "./context-timeline";
import { mountContextTreemap } from "./context-treemap";

/** A post-turn row of a 3-call turn: the prompt was ~40k, the run's summed usage 120k. */
const row: AnatomyEvent = {
  runId: "r",
  roundNumber: 0,
  model: "claude-opus-5-5",
  snapshot: "post-turn",
  contextSent: { totalTokens: 40_000, systemPromptTokens: 40_000 },
  contextWindow: { maxTokens: 1_000_000, usedTokens: 120_000 },
};

function tooltipFor(ev: AnatomyEvent): string {
  const host = document.createElement("div");
  document.body.append(host);
  const ctrl = mountContextTimeline(
    host,
    () => undefined,
    () => "",
    () => "",
  );
  ctrl.pushEvent(ev, ev.runId);
  const bar = host.querySelector(".ct-bar");
  expect(bar).not.toBeNull();
  bar!.dispatchEvent(new MouseEvent("mouseenter"));
  const text = document.querySelector(".ct-tooltip")?.textContent ?? "";
  bar!.dispatchEvent(new MouseEvent("mouseleave"));
  host.remove();
  return text;
}

function footerFor(ev: AnatomyEvent): string {
  const canvas = document.createElement("div");
  const footer = document.createElement("div");
  mountContextTreemap(canvas, footer, document.createElement("div"), async () => null);
  (canvas as unknown as { __treemapShowAnatomy: (e: AnatomyEvent) => void }).__treemapShowAnatomy(
    ev,
  );
  return footer.textContent ?? "";
}

describe("a turn's summed usage is not one prompt's size", () => {
  it("the context bar's tooltip reads the prompt the row itemises", () => {
    expect(tooltipFor({ ...row })).toContain("40.0k in");
  });

  it("the treemap footer reads the prompt's tokens and fill", () => {
    expect(footerFor({ ...row })).toMatch(/^40\.0k tokens · 4% of 1\.0M/);
  });

  it("CONTROL: a row with no itemised total still falls back to a plausible usedTokens", () => {
    const bare: AnatomyEvent = { ...row, contextSent: {} };
    expect(tooltipFor(bare)).toContain("120.0k in");
    expect(footerFor(bare)).toMatch(/^120\.0k tokens · 12% of 1\.0M/);
  });
});
