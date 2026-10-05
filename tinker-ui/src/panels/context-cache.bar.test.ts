/**
 * context-window-panel.md §6.4 gates `moral-code-first` and `bar-never-overflows`, plus B1's
 * palette distinctness check.
 *
 * Separate from context-cache.test.ts on purpose: that file pins the panel's NUMBERS and its markup
 * by example, and it is excellent at it. This file pins two INVARIANTS that no set of examples can
 * establish — a property no random input may violate, and a perceptual distance. A principle with
 * only examples behind it is a principle that decays the first time someone adds a segment.
 */
import { describe, it, expect } from "vitest";
import {
  allocateBarSpans,
  moralCodeState,
  renderCachePanelHtml,
  BAR_BUDGET_DEVICE_PX,
  MORAL_CODE_MIN_DEVICE_PX,
  type CachePanelState,
} from "./context-cache";
import { RESPONSE_COLOR, SEGMENT_COLORS, SEGMENT_LABELS } from "./context-timeline";

// ─── B1: perceptual distance ────────────────────────────────────────────────────────────────
//
// OKLab ΔE (Euclidean distance in OKLab) rather than CIEDE2000: a quarter of the code for the same
// verdict on this palette, and a reader can re-derive the numbers below from the hexes. Both
// metrics were computed when the value was chosen and they agreed on the ranking.

const oklab = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const lin = [0, 2, 4].map((i) => {
    const c = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = lin;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};
const deltaE = (a: string, b: string): number => {
  const [l1, a1, b1] = oklab(a);
  const [l2, a2, b2] = oklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

/** The NEW key must clear this against everything it can be confused with. Its nearest rival
 *  measures 0.133 (RESPONSE_COLOR), so this is not a threshold tuned to let the answer through. */
const MORAL_CODE_MIN_DELTA_E = 0.12;
/** Ratchet for the keys the BAR draws, set just UNDER the measured floor (toolSchemas vs
 *  conversation, 0.1042). A ratchet parked above what was measured is slack that silently absorbs
 *  the next regression. */
const BAR_MIN_DELTA_E = 0.1;
/** Ratchet for the whole table, which also holds the response keys. Measured floor 0.0527 (skills
 *  vs responseToolCalls) — those two never share a lane, which is why the bar's ratchet is tighter
 *  than the table's rather than the other way round. */
const PALETTE_MIN_DELTA_E = 0.05;

/** The rail's two papers. tinker-ui has exactly ONE theme (`:root`, color-scheme: dark; there is no
 *  data-theme or prefers-color-scheme rule in base.css), so "both themes" is this check: the bar's
 *  own background and the rail behind it. A second theme adds rows here, it does not change the
 *  rule. --bg #1a1510, --surface #2a2318, --red #cd5c5c (base.css :root). */
const PAPER_BG = "#1a1510";
const PAPER_SURFACE = "#2a2318";
const ABSENT_RED = "#cd5c5c";

/** The keys the WINDOW bar can draw. The response keys live in the timeline's other lane. */
const BAR_KEYS = [
  "moralCode",
  "systemPrompt",
  "injectedFiles",
  "skills",
  "toolSchemas",
  "conversation",
  "toolResults",
  "userMessage",
];

describe("B1 — the moral-code colour is distinct, and the palette leads with it", () => {
  it("leads SEGMENT_COLORS, because the palette's key order IS the bar's draw order (P3)", () => {
    expect(Object.keys(SEGMENT_COLORS)[0]).toBe("moralCode");
    expect(SEGMENT_LABELS.moralCode).toBe("Moral code");
  });

  it("names the unitemised remainder without giving it a colour (P4, §5.8)", () => {
    expect(SEGMENT_LABELS.unitemised).toBe("Unitemised");
    expect(SEGMENT_COLORS.unitemised).toBeUndefined();
  });

  it("clears every rival it could be confused with, including the absent-slot red", () => {
    const moral = SEGMENT_COLORS.moralCode;
    const rivals: Record<string, string> = {
      ...Object.fromEntries(Object.entries(SEGMENT_COLORS).filter(([k]) => k !== "moralCode")),
      RESPONSE_COLOR,
      // The pack and the SHAPE OF ITS ABSENCE are the two marks on this bar that must never be
      // mistaken for one another, and the absence is outlined in --red.
      absentRed: ABSENT_RED,
    };
    for (const [key, hex] of Object.entries(rivals)) {
      expect
        .soft(deltaE(moral, hex), `moralCode vs ${key}`)
        .toBeGreaterThan(MORAL_CODE_MIN_DELTA_E);
    }
  });

  it("stays legible on both papers the bar is drawn on", () => {
    for (const key of BAR_KEYS) {
      for (const paper of [PAPER_SURFACE, PAPER_BG]) {
        expect.soft(deltaE(SEGMENT_COLORS[key], paper), `${key} vs paper`).toBeGreaterThan(0.38);
      }
    }
  });

  it("ratchet — no pair the BAR draws collides, and no pair in the table collides", () => {
    for (let i = 0; i < BAR_KEYS.length; i++) {
      for (let j = i + 1; j < BAR_KEYS.length; j++) {
        expect
          .soft(
            deltaE(SEGMENT_COLORS[BAR_KEYS[i]], SEGMENT_COLORS[BAR_KEYS[j]]),
            `${BAR_KEYS[i]} vs ${BAR_KEYS[j]}`,
          )
          .toBeGreaterThan(BAR_MIN_DELTA_E);
      }
    }
    const all = Object.entries(SEGMENT_COLORS);
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        expect
          .soft(deltaE(all[i][1], all[j][1]), `${all[i][0]} vs ${all[j][0]}`)
          .toBeGreaterThan(PALETTE_MIN_DELTA_E);
      }
    }
  });
});

// ─── B2: the allocator ──────────────────────────────────────────────────────────────────────

/** Deterministic PRNG (mulberry32). A property test that cannot be replayed is a flake generator,
 *  and fast-check is not a dependency of this package. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const MIN_PX = { moralCode: MORAL_CODE_MIN_DEVICE_PX };
const floorPct = (MORAL_CODE_MIN_DEVICE_PX / BAR_BUDGET_DEVICE_PX) * 100;

/** The sum the DOM actually receives: every width is emitted at 2dp, so summing the hundredths as
 *  INTEGERS is exact where summing the floats is not. 10_000 hundredths = 100%. */
const hundredths = (got: { spans: { pct: number }[]; freePct: number }): number =>
  got.spans.reduce((a, sp) => a + Math.round(sp.pct * 100), 0) + Math.round(got.freePct * 100);

describe("B2 — the bar cannot overflow, by construction (P2)", () => {
  it("never lets the drawn spans sum past the bar, over 5000 random compositions", () => {
    const rand = rng(20260924);
    for (let n = 0; n < 5000; n++) {
      // Deliberately hostile WITHIN the contract: zeros, one-token slivers, and totals far past a
      // 1M window. The ruler is built the way renderCachePanelHtml builds it — max(1M, the model
      // window, the DRAWN total) — because that precondition is what makes P2 hold, and a property
      // test run outside its own precondition proves nothing about the code that ships.
      const spans = [
        "moralCode",
        "systemPrompt",
        "injectedFiles",
        "skills",
        "toolSchemas",
        "conversation",
        "toolResults",
        "userMessage",
        "unitemised",
      ].map((key) => ({ key, tokens: rand() < 0.25 ? 0 : Math.floor(rand() ** 4 * 3_000_000) }));
      const total = spans.reduce((a, sp) => a + sp.tokens, 0);
      const window = [0, 200_000, 2_000_000][Math.floor(rand() * 3)];
      const got = allocateBarSpans(spans, Math.max(1_000_000, window, total), { minPx: MIN_PX });

      expect(hundredths(got)).toBeLessThanOrEqual(10_000);
      expect(got.freePct).toBeGreaterThanOrEqual(0);
      for (const sp of got.spans) {
        expect(sp.pct).toBeGreaterThanOrEqual(0);
      }
      // P3 — and the moral code is first and never below its floor, in the same sweep.
      expect(got.spans[0].key).toBe("moralCode");
      expect(got.spans[0].pct).toBeGreaterThanOrEqual(floorPct - 1e-9);
    }
  });

  it("floors a starved moral code and makes the FREE span pay for it", () => {
    const got = allocateBarSpans(
      [
        { key: "moralCode", tokens: 1_000 },
        { key: "conversation", tokens: 400_000 },
      ],
      1_000_000,
      { minPx: MIN_PX },
    );
    expect(got.spans[0].floored).toBe(true);
    expect(got.spans[0].pct).toBeGreaterThanOrEqual(floorPct - 1e-9);
    // conversation keeps its EXACT share — the headroom absorbed the floor.
    expect(got.spans[1].pct).toBe(40);
    expect(got.spans[1].floored).toBe(false);
    expect(hundredths(got)).toBe(10_000);
  });

  it("with no headroom the LARGEST segment pays, and the moral code still does not", () => {
    const got = allocateBarSpans(
      [
        { key: "moralCode", tokens: 1 },
        { key: "conversation", tokens: 900_000 },
        { key: "skills", tokens: 100_000 },
      ],
      1_000_000,
      { minPx: MIN_PX },
    );
    expect(got.spans[0].pct).toBeGreaterThanOrEqual(floorPct - 1e-9);
    expect(got.spans[1].pct).toBeLessThan(90); // conversation, the largest, gave the width up
    expect(got.spans[2].pct).toBe(10); // skills untouched
    expect(got.freePct).toBe(0);
    expect(hundredths(got)).toBe(10_000);
  });

  it("a LARGE moral code is never the one that pays — the exclusion is by key, not by 'is it floored'", () => {
    // The regression this pins: taking "never the moral code" to mean "never a FLOORED span" looks
    // equivalent and is not. A big pack is not floored, so it becomes the largest eligible victim.
    // Under the renderer's own ruler (max(1M, window, DRAWN total)) the only deficit is the floor
    // itself, so the two variants agree there; they part the moment the ruler is shorter than what
    // is drawn. Measured 2026-09-24 with this file's generator but the ruler held at
    // max(1M, window): the floored-proxy variant cut the moral code below its own floor in 607 of
    // 5000 cases, the by-key variant in 0. So this case breaks the ruler contract ON PURPOSE (1.1M
    // drawn on a 1M ruler): the moral code is the largest span and keeps its EXACT share, and the
    // conversation pays the whole deficit. The proxy variant yields 50 / 50 here, not 60 / 40.
    const got = allocateBarSpans(
      [
        { key: "moralCode", tokens: 600_000 },
        { key: "conversation", tokens: 500_000 },
      ],
      1_000_000,
      { minPx: MIN_PX },
    );
    expect(got.spans[0].floored).toBe(false);
    expect(got.spans[0].pct).toBe(60);
    expect(got.spans[1].pct).toBe(40);
    expect(hundredths(got)).toBe(10_000);
  });

  it("clamps rather than overflows when the moral code alone outgrows the bar", () => {
    // Only reachable if a caller breaks the ruler contract. It must still not paint past 100%.
    const got = allocateBarSpans([{ key: "moralCode", tokens: 2_000_000 }], 1_000_000, {
      minPx: MIN_PX,
    });
    expect(got.spans[0].pct).toBe(100);
    expect(got.freePct).toBe(0);
    expect(hundredths(got)).toBe(10_000);
  });
});

// ─── B2: the three states, and the printed number ───────────────────────────────────────────

const withMoral = (v: number | undefined): CachePanelState => ({
  model: "claude-opus-5",
  provider: "anthropic",
  maxWindow: 1_000_000,
  promptTokens: 100_000,
  contextSent: {
    conversationHistoryTokens: 100_000,
    ...(v === undefined ? {} : { moralCodeTokens: v }),
  },
});

describe("B2 — absent is a state you can see; unknown is not absent (P3, P10)", () => {
  it("classifies the three states", () => {
    expect(moralCodeState(undefined)).toBe("unknown");
    expect(moralCodeState({})).toBe("unknown");
    expect(moralCodeState({ moralCodeTokens: 0 })).toBe("absent");
    expect(moralCodeState({ moralCodeTokens: 12_000 })).toBe("present");
  });

  it("an explicit zero draws the red-outlined empty slot and names it in the legend", () => {
    const html = renderCachePanelHtml(withMoral(0));
    expect(html).toContain("cache-seg--moral-absent");
    expect(html).toContain("moral code: absent");
    // A SLOT, never a zero-width span — that is the whole point of the floor.
    expect(html).not.toContain('class="cache-seg cache-seg--moral-absent" style="width:0%"');
  });

  it("a present pack draws FIRST, in the palette colour, with no red anywhere", () => {
    const html = renderCachePanelHtml(withMoral(12_000));
    expect(html.indexOf(SEGMENT_COLORS.moralCode)).toBeGreaterThan(-1);
    expect(html.indexOf(SEGMENT_COLORS.moralCode)).toBeLessThan(
      html.indexOf(SEGMENT_COLORS.conversation),
    );
    expect(html).not.toContain("moral-absent");
  });

  it("no producer yet means no slot and a DASH, never a fabricated absence", () => {
    const html = renderCachePanelHtml(withMoral(undefined));
    expect(html).not.toContain("moral-absent");
    expect(html).not.toContain("moral code: absent");
    expect(html).toMatch(/data-stat="moral"[\s\S]*?—/);
  });
});

describe("B2 — the printed number is the sum of the spans drawn (P2, P5)", () => {
  it("draws the whole prompt as unitemised when there is no composition at all", () => {
    // The old bar printed "50.0k sent" over an empty box: a number with no span under it.
    const html = renderCachePanelHtml({ promptTokens: 50_000, maxWindow: 200_000 });
    expect(html).toContain("cache-seg--unitemised");
    expect(html).toContain("50.0k / 200.0k");
    expect(html).toContain('class="cache-seg cache-seg--free" style="width:95%"');
  });

  it("rules off the DRAWN total, so an anatomy that outruns the billed figure cannot be clipped", () => {
    // F5's overshoot: the post-turn estimate holds the final reply the last call never received,
    // so the spans sum past the billed prompt. The bar must print what it draws.
    const html = renderCachePanelHtml({
      maxWindow: 1_000_000,
      promptTokens: 300_000,
      contextSent: { conversationHistoryTokens: 900_000 },
    });
    expect(html).toContain("900.0k / 1.0M");
    expect(html).toContain('class="cache-seg cache-seg--free" style="width:10%"');
  });

  it("never heads a turn aggregate THIS CALL (P5)", () => {
    const html = renderCachePanelHtml({
      maxWindow: 1_000_000,
      promptTokens: 6_448_106,
      contextSent: { conversationHistoryTokens: 52_116 },
    });
    expect(html).toContain("THIS TURN (aggregate)");
    expect(html).not.toContain("THIS CALL");
    expect(html).toContain("summed over the turn");
  });

  it("badges the composition's snapshot when the host states it, and stays silent otherwise", () => {
    expect(renderCachePanelHtml({ ...withMoral(0), compositionSnapshot: "post-turn" })).toContain(
      "· post-turn",
    );
    expect(renderCachePanelHtml({ ...withMoral(0), compositionSnapshot: "pre-call" })).toContain(
      "· pre-call",
    );
    const quiet = renderCachePanelHtml(withMoral(0));
    expect(quiet).not.toContain("post-turn");
    expect(quiet).not.toContain("pre-call");
  });
});
