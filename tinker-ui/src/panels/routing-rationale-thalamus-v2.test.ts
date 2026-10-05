// tinker-ui/src/panels/routing-rationale-thalamus-v2.test.ts
//
// THALAMUS v2 panel blocks (design §6, jarvis-icu 2026-09-03-thalamus-v2-design.md).
//
// The FIRST test here is the one that matters most: with none of the new fields supplied the
// card must be BYTE-IDENTICAL to the card that shipped before this change. Every new field is
// optional and the gateway does not send them yet, so "renders exactly as today" is not a
// nicety — it is the condition under which this change can land without being noticed.

import { describe, expect, it } from "vitest";
import type { SupplyState } from "../../../src/shared/thalamus-supply.js";
import {
  ballisticBlock,
  chainBlock,
  effortLine,
  fanOutLine,
  frontierLine,
  modelLine,
  policyLink,
  renderBiasSlider,
  renderRoutingRationale,
  reservedLine,
  shadowArrow,
  suppliesBlock,
  supplyRow,
  untilHuman,
  whyModelBlock,
  type RoutingSignals,
  type ThalamusPlanView,
} from "./routing-rationale";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

const base: RoutingSignals = {
  modelLabel: "Opus 5",
  modelPinned: false,
  effortLabel: "Auto",
  effortPinned: false,
  nowMs: NOW,
  parallelCap: 6,
  cores: 8,
};

/** The card as it rendered BEFORE this change, composed from the primitives this change did
 *  not touch. Byte-comparing against this is stronger than a snapshot: a snapshot records
 *  whatever the code does today, this records what the code did yesterday. */
const legacyCard = (s: RoutingSignals): string => {
  const row = (key: string, text: string): string =>
    `<div class="routing-why-row"><span class="routing-why-key">${key}</span>` +
    `<span class="routing-why-text">${text}</span></div>`;
  return (
    renderBiasSlider(s) +
    '<div class="routing-why">' +
    frontierLine(s) +
    row("MODEL", modelLine(s)) +
    row("EFFORT", effortLine(s)) +
    row("FAN-OUT", fanOutLine(s)) +
    policyLink(s.policyPath) +
    "</div>"
  );
};

/** A real window carries `lengthMs` — `windowBallistic()` returns false without it, so a
 *  fixture that omits it silently tests the wrong branch. */
const WEEK_WINDOW = {
  label: "7-day",
  used: 0.71,
  resetAtMs: NOW + 4 * HOUR,
  lengthMs: 7 * 24 * HOUR,
  elapsed: 0.5,
  pace: 0.21,
};

const supply = (over: Partial<SupplyState> = {}): SupplyState => ({
  id: "anthropic",
  kind: "subscription",
  windows: [{ ...WEEK_WINDOW }],
  spent: false,
  binding: { ...WEEK_WINDOW },
  shadow: 0.21,
  ballistic: false,
  resetAtMs: NOW + 4 * HOUR,
  ...over,
});

const plan = (over: Partial<ThalamusPlanView> = {}): ThalamusPlanView => ({
  primary: "anthropic/claude-opus-5",
  effort: "high",
  mode: "solo",
  panel: [],
  chain: ["xai/grok-4", "openai/gpt-5"],
  ballistic: false,
  vetoes: [],
  domain: "code",
  subject: "none",
  reason: "opus 5 · balanced anchor",
  ...over,
});

describe("no new fields ⇒ the card is exactly what it was", () => {
  it("renders byte-identically to the pre-THALAMUS-v2 card", () => {
    expect(renderRoutingRationale(base)).toBe(legacyCard(base));
    expect(renderRoutingRationale({ ...base, policyPath: "/x/orca-policy.md", biasIdx: 5 })).toBe(
      legacyCard({ ...base, policyPath: "/x/orca-policy.md", biasIdx: 5 }),
    );
  });

  it("emits no THALAMUS markup at all, and still exactly three labelled rows", () => {
    const html = renderRoutingRationale(base);
    expect(html).not.toContain("thalamus-");
    expect((html.match(/routing-why-row/g) || []).length).toBe(3);
  });

  it("an EMPTY supplies array is still no block — never an empty box", () => {
    expect(suppliesBlock({ ...base, supplies: [] })).toBe("");
    expect(renderRoutingRationale({ ...base, supplies: [] })).toBe(legacyCard(base));
  });
});

describe("SUPPLIES — why it did not use Claude", () => {
  it("names the supply, the binding window, the fill and the time to reset", () => {
    const html = supplyRow(supply(), NOW);
    expect(html).toContain("Claude");
    expect(html).toContain("7-day");
    expect(html).toContain("71%");
    expect(html).toContain("4h");
  });

  it("marks a SPENT supply unmistakably", () => {
    const html = supplyRow(supply({ spent: true, shadow: 1 }), NOW);
    expect(html).toContain("is-spent");
    expect(html).toContain("SPENT");
    expect(html).toContain("#e05a3f");
    expect(supplyRow(supply(), NOW)).not.toContain("SPENT");
  });

  it("the price arrow follows the SIGN of the shadow price", () => {
    expect(shadowArrow(0.31)).toBe("↑");
    expect(shadowArrow(-0.31)).toBe("↓");
    expect(shadowArrow(0)).toBe("–");
    expect(shadowArrow(0.01)).toBe("–");
    expect(shadowArrow(undefined)).toBe("–");
    expect(shadowArrow(Number.NaN)).toBe("–");
    expect(supplyRow(supply({ shadow: 0.4 }), NOW)).toContain("↑");
    expect(supplyRow(supply({ shadow: -0.4 }), NOW)).toContain("↓");
  });

  it("keeps the NUMBER as evidence in the row's title, not in the line", () => {
    const html = supplyRow(supply({ shadow: -0.42 }), NOW);
    expect(html).toContain('title="Claude · subscription · shadow -0.42 · behind pace — cheaper"');
    expect(html.replace(/<[^>]+>/g, "")).not.toContain("0.42");
  });

  it("says so rather than guessing when a supply has no reading", () => {
    const html = supplyRow(
      supply({ windows: [], binding: undefined, resetAtMs: undefined, shadow: 0 }),
      NOW,
    );
    expect(html).toContain("no reading");
    expect(html).toContain("–");
    // A 0%-wide bar would read as "plenty left" for a supply nobody measured.
    expect(html).not.toContain("thalamus-bar");
    expect(html).toContain('title="Claude · subscription · shadow +0.00 · on pace"');
  });

  it('an UNKNOWN shadow says unknown rather than "on pace"', () => {
    const html = supplyRow(supply({ shadow: Number.NaN }), NOW);
    expect(html).toContain("shadow unknown");
    expect(html).not.toContain("on pace");
    expect(html).toContain("–");
  });

  it("escapes a hostile supply label", () => {
    const hostile = supply({ id: "<img src=x>" as unknown as SupplyState["id"] });
    expect(supplyRow(hostile, NOW)).toContain("&lt;img src=x&gt;");
    expect(supplyRow(hostile, NOW)).not.toContain("<img src=x>");
  });
});

describe("WHY THIS MODEL", () => {
  it("prints the plan's reason, the domain and the subject", () => {
    const html = whyModelBlock({ ...base, thalamusPlan: plan({ subject: "medical" }) });
    expect(html).toContain("anthropic/claude-opus-5");
    expect(html).toContain("@high");
    expect(html).toContain(">code<");
    expect(html).toContain(">medical<");
    expect(html).toContain("opus 5 · balanced anchor");
  });

  it("never renders a reserved model silently — each of the three reasons is named", () => {
    for (const [reason, needle] of [
      ["dial", "DIAL"],
      ["ballistic", "BALLISTIC"],
      ["feasibility", "FEASIBILITY"],
    ] as const) {
      const html = whyModelBlock({
        ...base,
        thalamusPlan: plan({ primary: "openrouter/fable-5.1", reservedReason: reason }),
      });
      expect(html).toContain("thalamus-reserved");
      expect(html).toContain(needle);
    }
  });

  it("prints something true even for a reason outside the union (RPC data is not typed)", () => {
    expect(reservedLine("weather")).toContain("weather");
    expect(reservedLine("dial")).toContain("DIAL");
  });

  it("says nothing when there is no plan", () => {
    expect(whyModelBlock(base)).toBe("");
  });
});

describe("IF IT FAILS — the chain, and the warning when there is none", () => {
  it("renders the chain in order, as arrows", () => {
    const html = chainBlock({ ...base, thalamusPlan: plan() });
    expect(html).toContain("xai/grok-4 → openai/gpt-5");
    expect(html.indexOf("grok-4")).toBeLessThan(html.indexOf("gpt-5"));
    expect(html).not.toContain("no fallback");
  });

  it("an EMPTY chain is a warning, because it is the bug this change fixed", () => {
    const html = chainBlock({ ...base, thalamusPlan: plan({ chain: [] }) });
    expect(html).toContain("no fallback — a failure stalls the turn");
    expect(html).toContain("#e05a3f");
  });

  it("an ABSENT chain is not an EMPTY chain — silence, not a false alarm", () => {
    const p = plan();
    delete (p as Partial<ThalamusPlanView>).chain;
    expect(chainBlock({ ...base, thalamusPlan: p })).toBe("");
  });

  it("says nothing when there is no plan", () => {
    expect(chainBlock(base)).toBe("");
  });
});

/** Inside the last 15% of the window with a 62-point deficit: `windowBallistic()` is true. */
const BALLISTIC_WINDOW = {
  label: "Weekly",
  used: 0.28,
  resetAtMs: NOW + 2 * HOUR,
  lengthMs: 7 * 24 * HOUR,
  elapsed: 0.9,
  pace: -0.62,
};

describe("BALLISTIC — only when armed", () => {
  const armed = supply({
    id: "xai",
    ballistic: true,
    shadow: -1,
    windows: [{ ...BALLISTIC_WINDOW }],
    binding: { ...BALLISTIC_WINDOW },
    resetAtMs: NOW + 2 * HOUR,
  });

  it("is absent while nothing is armed", () => {
    expect(ballisticBlock(base)).toBe("");
    expect(ballisticBlock({ ...base, supplies: [supply()], thalamusPlan: plan() })).toBe("");
    expect(renderRoutingRationale({ ...base, supplies: [supply()] })).not.toContain("BALLISTIC");
  });

  it("names the supply, the surplus and the time left when it IS armed", () => {
    const html = ballisticBlock({ ...base, supplies: [armed] });
    expect(html).toContain("BALLISTIC");
    expect(html).toContain("Grok");
    expect(html).toContain("62%");
    expect(html).toContain("Weekly");
    expect(html).toContain("2h left");
  });

  it("never quotes a surplus from a window that did not arm it", () => {
    // Flagged ballistic, but no window passes windowBallistic (no lengthMs ⇒ no pace at all).
    const inconsistent = supply({
      id: "xai",
      ballistic: true,
      windows: [{ label: "Weekly", used: 0.28, resetAtMs: NOW + 2 * HOUR }],
      binding: { label: "Weekly", used: 0.28, resetAtMs: NOW + 2 * HOUR },
      resetAtMs: NOW + 2 * HOUR,
    });
    const html = ballisticBlock({ ...base, supplies: [inconsistent] });
    expect(html).toContain("Grok");
    expect(html).not.toContain("expires unspent");
    expect(html).toContain("2h left");
  });

  it("still says so when only the plan reports it (no supply detail to show)", () => {
    const html = ballisticBlock({ ...base, thalamusPlan: plan({ ballistic: true }) });
    expect(html).toContain("BALLISTIC");
    expect(html).toContain("tokens are free");
  });
});

describe("time to reset, in human", () => {
  it("says hours and minutes", () => {
    expect(untilHuman(4 * HOUR + 20 * 60 * 1000)).toBe("4h 20m");
    expect(untilHuman(4 * HOUR)).toBe("4h");
    expect(untilHuman(12 * 60 * 1000)).toBe("12m");
    expect(untilHuman(50 * HOUR)).toBe("2d 2h");
    expect(untilHuman(48 * HOUR)).toBe("2d");
    expect(untilHuman(30 * 1000)).toBe("<1m");
    expect(untilHuman(0)).toBe("now");
    expect(untilHuman(-5)).toBe("now");
    expect(untilHuman(Number.NaN)).toBe("now");
  });
});

describe("placement — the new blocks sit above MODEL and do not become rows", () => {
  it("keeps three routing-why-rows and orders SUPPLIES → WHY → IF IT FAILS → BALLISTIC", () => {
    const html = renderRoutingRationale({
      ...base,
      supplies: [supply({ id: "xai", ballistic: true, shadow: -1 })],
      thalamusPlan: plan({ ballistic: true }),
      frontierPick: { model: "Opus 5", effort: "high", smart: 61.5, cost: 0.2, frontierSize: 8 },
    });
    expect((html.match(/routing-why-row/g) || []).length).toBe(3);
    expect(html.indexOf("routing-why-frontier")).toBeLessThan(html.indexOf(">SUPPLIES<"));
    expect(html.indexOf(">SUPPLIES<")).toBeLessThan(html.indexOf(">WHY THIS<"));
    expect(html.indexOf(">WHY THIS<")).toBeLessThan(html.indexOf(">IF IT FAILS<"));
    expect(html.indexOf(">IF IT FAILS<")).toBeLessThan(html.indexOf(">BALLISTIC<"));
    expect(html.indexOf(">BALLISTIC<")).toBeLessThan(html.indexOf(">MODEL<"));
  });
});
