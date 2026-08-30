import { describe, it, expect } from "vitest";
import {
  cacheSegments,
  contextScaleTokens,
  CONTEXT_SCALE_TOKENS,
  fmtTokens,
  renderCachePanelHtml,
  unitemisedTokens,
  type CachePanelState,
} from "./context-cache";
import { SEGMENT_COLORS, SEGMENT_LABELS } from "./context-timeline";

/** Frozen clock. The panel must never read one, so this only ever travels as state. */
const NOW = 1_700_000_000_000;

/**
 * One real-shaped call: a 1M window, a 200k billed prompt, and an anatomy block whose
 * ESTIMATES sum to 100k — i.e. the gateway can only account for HALF of what was billed,
 * which is the normal shape on the CLI pipe. The other 100k must surface as "Unitemised",
 * never by inflating the seven measured components.
 */
const base: CachePanelState = {
  model: "claude-opus-5",
  provider: "anthropic",
  maxWindow: 1_000_000,
  promptTokens: 200_000,
  input: 2_000,
  cacheRead: 190_000,
  cacheWrite: 8_000,
  output: 900,
  contextSent: {
    systemPromptTokens: 10_000,
    injectedFilesTotalTokens: 5_000,
    skillsTokens: 5_000,
    toolSchemasTokens: 20_000,
    conversationHistoryTokens: 40_000,
    toolResultsTokens: 18_000,
    userMessageTokens: 2_000,
  },
  lastEventMs: NOW,
  windowSource: "anatomy",
};

const sample = (over: Partial<CachePanelState> = {}): CachePanelState => ({ ...base, ...over });

describe("fmtTokens — same unit ladder as fmtChars in context-treemap", () => {
  it("switches unit exactly at the 1k and 1M boundaries", () => {
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1_000)).toBe("1.0k");
    expect(fmtTokens(999_999)).toBe("1000.0k");
    expect(fmtTokens(1_000_000)).toBe("1.0M");
  });

  it("keeps one decimal and never leaks NaN", () => {
    expect(fmtTokens(482_300)).toBe("482.3k");
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(Number.NaN)).toBe("0");
  });
});

describe("cacheSegments — measured components reported AT TRUE SCALE", () => {
  it("reads the seven input fields in anatomy order", () => {
    expect(cacheSegments(base.contextSent, 0).map((s) => s.key)).toEqual([
      "systemPrompt",
      "injectedFiles",
      "skills",
      "toolSchemas",
      "conversation",
      "toolResults",
      "userMessage",
    ]);
  });

  it("NEVER inflates a measured component to meet the billed total", () => {
    const segs = cacheSegments(base.contextSent, 200_000);
    // Byte-for-byte the anatomy's own numbers — not x2 versions of them.
    expect(segs.map((s) => s.tokens)).toEqual([
      10_000, 5_000, 5_000, 20_000, 40_000, 18_000, 2_000,
    ]);
    expect(segs.reduce((a, s) => a + s.tokens, 0)).toBe(100_000);
    // pct is of the BILLED total, so conversation is 40k/200k = 20%, not 40%.
    expect(segs.find((s) => s.key === "conversation")?.pct).toBeCloseTo(20, 6);
  });

  it("reports the shortfall between measured components and billed prompt", () => {
    const segs = cacheSegments(base.contextSent, 200_000);
    expect(unitemisedTokens(segs, 200_000)).toBe(100_000);
  });

  it("has no shortfall when the anatomy accounts for the whole prompt", () => {
    const segs = cacheSegments(base.contextSent, 100_000);
    expect(unitemisedTokens(segs, 100_000)).toBe(0);
    // and never goes negative when the estimate overshoots the billed number
    expect(unitemisedTokens(segs, 80_000)).toBe(0);
  });

  it("shows the raw estimate — pct of the segment sum — when nothing was billed yet", () => {
    const segs = cacheSegments(base.contextSent, 0);
    expect(segs.find((s) => s.key === "systemPrompt")?.tokens).toBe(10_000);
    expect(segs.find((s) => s.key === "systemPrompt")?.pct).toBeCloseTo(10, 6);
    expect(unitemisedTokens(segs, 0)).toBe(0);
  });

  it("drops zero, negative and non-numeric segments", () => {
    const segs = cacheSegments(
      {
        systemPromptTokens: 100,
        skillsTokens: 0,
        toolSchemasTokens: -50,
        conversationHistoryTokens: "lots",
        userMessageTokens: 100,
      },
      0,
    );
    expect(segs.map((s) => s.key)).toEqual(["systemPrompt", "userMessage"]);
    expect(segs.map((s) => s.pct)).toEqual([50, 50]);
  });

  it("takes colour and label from the shared timeline palette, never a local hex", () => {
    const [seg] = cacheSegments({ skillsTokens: 10 }, 0);
    expect(seg.color).toBe(SEGMENT_COLORS.skills);
    expect(seg.label).toBe(SEGMENT_LABELS.skills);
  });

  it("returns nothing without an anatomy block", () => {
    expect(cacheSegments(undefined, 200_000)).toEqual([]);
  });
});

describe("renderCachePanelHtml — empty state", () => {
  it("is idle before the first call (this is what app.ts renders on boot)", () => {
    expect(renderCachePanelHtml({})).toBe(
      '<div style="color:var(--muted);font-size:12px;padding:8px">' +
        "Idle — waiting for the first model call.</div>",
    );
  });

  it("leaves idle as soon as an anatomy block arrives, before any billing lands", () => {
    const html = renderCachePanelHtml({ contextSent: { systemPromptTokens: 10 } });
    expect(html).not.toContain("Idle");
    expect(html).toContain('class="cache-bar cache-bar--window"');
    expect(html).toContain('class="cache-stats cache-stats--call"');
  });
});

describe("window bar", () => {
  it("sizes segments against the model window and fills the rest with free headroom", () => {
    const html = renderCachePanelHtml(base);
    // conversation is 40k of a 1M window = 4% — its MEASURED size, not a stretched one.
    expect(html).toContain(`width:4%;background:${SEGMENT_COLORS.conversation}`);
    expect(html).toContain('class="cache-seg cache-seg--free" style="width:80%"');
  });

  it("draws the un-attributed remainder between the segments and the free headroom", () => {
    const html = renderCachePanelHtml(base);
    // 200k billed - 100k measured = 100k unitemised = 10% of a 1M window.
    expect(html).toContain('class="cache-seg cache-seg--unitemised" style="width:10%"');
    // measured (10%) + unitemised (10%) + free (80%) = 100% of the window
    expect(html).toContain("Unitemised — 100.0k (50.0%)");
  });

  it("omits the remainder when the anatomy explains the whole prompt", () => {
    const html = renderCachePanelHtml(sample({ promptTokens: 100_000 }));
    expect(html).not.toContain("cache-seg--unitemised");
    expect(html).not.toContain("Unitemised");
  });

  it("titles each segment with label, tokens and share of the prompt", () => {
    expect(renderCachePanelHtml(base)).toContain('title="Conv — 40.0k (20.0%)"');
  });

  it("emits clean percentages, never float noise", () => {
    expect(renderCachePanelHtml(base)).not.toMatch(/width:\d+\.\d{3,}/);
  });

  it("still draws the fill when there is no anatomy block to break down", () => {
    // FORK 2026-08-28 — the denominator is the 1M ruler now, NOT the 4k window: 1k of 1M is
    // 0.1%, so the headroom is 99.9%. The 4k window itself is stated in the meta line and drawn
    // as the outline, but it no longer decides how wide a token is.
    const html = renderCachePanelHtml({ promptTokens: 1_000, maxWindow: 4_000 });
    expect(html).toContain('class="cache-seg cache-seg--free" style="width:99.9%"');
    expect(html).toContain("1.0k / 4.0k · 25%");
  });

  it("falls back to the anatomy sum for the fill line when billing has not landed", () => {
    const html = renderCachePanelHtml({ contextSent: { systemPromptTokens: 10 }, maxWindow: 100 });
    // 10 tokens on a 1M ruler rounds to 0% at 2dp; the free span is the whole bar.
    expect(html).toContain(`background:${SEGMENT_COLORS.systemPrompt}`);
    expect(html).toContain('class="cache-seg cache-seg--free" style="width:100%"');
  });

  it("with an unknown window still uses the 1M ruler and draws no outline", () => {
    // FORK 2026-08-28 — previously this scaled to the call itself and drew no headroom, which
    // made an unknown window look identical to a full one. The ruler is now unconditional, so
    // 200k reads as 200k; what disappears is the OUTLINE, because that is the one thing we
    // genuinely do not know.
    const html = renderCachePanelHtml(sample({ maxWindow: 0, windowSource: "unknown" }));
    expect(html).toContain('class="cache-seg cache-seg--free" style="width:80%"');
    expect(html).not.toContain("cache-window-frame");
    expect(html).not.toContain("cache-window-excess");
    expect(html).toContain("(window unknown)");
  });
});

// FORK 2026-08-28 (the architect): the fixed 1M ruler, the provider-coloured window outline, the red
// excess warning, and the two manual action buttons.
describe("fixed 1M ruler", () => {
  it("is the denominator regardless of which model answered", () => {
    expect(CONTEXT_SCALE_TOKENS).toBe(1_000_000);
    // A 200k-window model with a 100k prompt: the segments are drawn against 1M, so the same
    // token count draws the same width whichever model produced it.
    const html = renderCachePanelHtml({
      provider: "anthropic",
      maxWindow: 200_000,
      promptTokens: 100_000,
      contextSent: { conversationHistoryTokens: 100_000 },
    });
    expect(html).toContain(`width:10%;background:${SEGMENT_COLORS.conversation}`);
    expect(html).toContain('class="cache-seg cache-seg--free" style="width:90%"');
  });

  it("grows past 1M rather than letting anything overflow the box", () => {
    expect(contextScaleTokens(0, 0)).toBe(1_000_000);
    expect(contextScaleTokens(200_000, 50_000)).toBe(1_000_000);
    expect(contextScaleTokens(2_000_000, 50_000)).toBe(2_000_000);
    expect(contextScaleTokens(200_000, 1_500_000)).toBe(1_500_000);
    // Junk cannot shrink the ruler below its floor.
    expect(contextScaleTokens(Number.NaN, -5)).toBe(1_000_000);
  });

  it("states the ruler in the meta line so the geometry is read, not inferred", () => {
    expect(renderCachePanelHtml(base)).toContain("200.0k / 1.0M · 20% · of 1.0M");
  });
});

describe("model window outline", () => {
  it("draws an empty rectangle at the model's share of the ruler, in the provider colour", () => {
    const html = renderCachePanelHtml(sample({ maxWindow: 200_000 }));
    // anthropic's identity STROKE, from the shared EEG palette (EEG_PROVIDER_COLORS.anthropic).
    expect(html).toContain(
      '<span class="cache-window-frame" style="width:20%;border-color:#E8702A"',
    );
    // It is an OUTLINE: the render module sets no background on it.
    expect(html).not.toContain('cache-window-frame" style="width:20%;background');
  });

  // FORK 2026-08-29 (the architect: "when I switch from opus to grok ... it should have gone white and
  // shrunk to half, right?"). Both halves of that sentence, pinned.
  it("paints xai the EEG light grey, never the invisible brand black", () => {
    const html = renderCachePanelHtml(
      sample({ provider: "xai", model: "grok-4.6", maxWindow: 500_000 }),
    );
    expect(html).toContain("border-color:#B7BBC2");
    // #111 is the CHIP-FILL colour. As a 1px stroke on the dark rail it is invisible, which is
    // exactly what made the switch look like a no-op.
    expect(html).not.toContain("border-color:#111");
  });

  it("halves the outline going from a 1M model to grok's 500k, with the context unchanged", () => {
    const opus = renderCachePanelHtml(sample({ maxWindow: 1_000_000 }));
    const grok = renderCachePanelHtml(
      sample({ provider: "xai", model: "grok-4.6", maxWindow: 500_000 }),
    );
    expect(opus).toContain('class="cache-window-frame" style="width:100%');
    expect(grok).toContain('class="cache-window-frame" style="width:50%');
    // The bar itself is the fixed ruler, so the CONTEXT does not move — only the window does.
    expect(opus).toContain('class="cache-seg cache-seg--free" style="width:80%"');
    expect(grok).toContain('class="cache-seg cache-seg--free" style="width:80%"');
  });

  it("resolves an OpenRouter vendor by model id, not by its useless provider string", () => {
    // Every OpenRouter model reports provider "openrouter"; the vendor lives in the model id.
    const html = renderCachePanelHtml(
      sample({ provider: "openrouter", model: "kimi-k2", maxWindow: 200_000 }),
    );
    expect(html).toContain("border-color:#07B2FE");
  });

  it("flattens the google rainbow, which is an SVG url() a CSS border cannot use", () => {
    const html = renderCachePanelHtml(
      sample({ provider: "google", model: "gemini-3-pro", maxWindow: 500_000 }),
    );
    expect(html).toContain("border-color:#4285F4");
    expect(html).not.toContain("url(#eeg-google)");
  });

  it("names the model and both numbers in its tooltip", () => {
    const html = renderCachePanelHtml(sample({ maxWindow: 200_000 }));
    expect(html).toContain('title="claude-opus-5 window — 200.0k of the 1.0M scale"');
  });

  it("falls back to the unknown-provider grey rather than emitting an empty colour", () => {
    const html = renderCachePanelHtml(sample({ provider: "not-a-provider", model: "nope" }));
    expect(html).toContain("border-color:#8A8F98");
  });

  it("is absent when the window is unknown", () => {
    expect(renderCachePanelHtml(sample({ maxWindow: 0 }))).not.toContain("cache-window-frame");
  });

  it("sits after the flex spans so it paints over them", () => {
    const html = renderCachePanelHtml(sample({ maxWindow: 200_000 }));
    expect(html.indexOf("cache-seg--free")).toBeLessThan(html.indexOf("cache-window-frame"));
  });
});

describe("excess warning", () => {
  it("covers exactly the tokens beyond the model window", () => {
    // The overrun is measured off `used`, and `used` is the MEASURED anatomy sum (100k here)
    // whenever promptTokens fails the turn-aggregate plausibility guard. So the trigger is an
    // anatomy that outgrew the window: 100k measured against an 80k window = 20k over. On the
    // 1M ruler that starts at 8% and runs for 2%.
    const html = renderCachePanelHtml(sample({ maxWindow: 80_000 }));
    expect(html).toContain('<span class="cache-window-excess" style="left:8%;width:2%"');
    expect(html).toContain("20.0k over the 80.0k window");
  });

  it("is absent when the context fits", () => {
    expect(renderCachePanelHtml(sample({ maxWindow: 200_000 }))).not.toContain(
      "cache-window-excess",
    );
    expect(renderCachePanelHtml(base)).not.toContain("cache-window-excess");
  });

  it("is absent when the window is unknown — there is nothing to be over", () => {
    expect(renderCachePanelHtml(sample({ maxWindow: 0 }))).not.toContain("cache-window-excess");
  });

  it("does not fire on a TURN AGGREGATE, which is not a context size", () => {
    // The 2026-07-28 guard: 6,448,106 billed against a 1M window is the CLI's summed turn
    // usage, not a context. `used` falls through to the anatomy sum (100k), which fits — so the
    // panel must not paint a red 5.4M overrun.
    const html = renderCachePanelHtml(sample({ promptTokens: 6_448_106 }));
    expect(html).not.toContain("cache-window-excess");
    expect(html).toContain("· measured");
  });
});

describe("window meta", () => {
  it("states used / max / fill plus the model and provider", () => {
    expect(renderCachePanelHtml(base)).toContain(
      "200.0k / 1.0M · 20% · of 1.0M · claude-opus-5 · anthropic",
    );
  });

  it("says nothing about a window it does not know", () => {
    const html = renderCachePanelHtml(sample({ maxWindow: undefined, windowSource: "unknown" }));
    expect(html).toContain("200.0k sent");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });
});

describe("legend", () => {
  it("gives one swatch per live segment, plus one for the un-attributed remainder", () => {
    const html = renderCachePanelHtml(base);
    // 7 measured + Unitemised. The split legend is gone: THIS CALL is a stat panel now.
    expect((html.match(/cache-legend-item/g) ?? []).length).toBe(8);
    expect(html).toContain(
      `<i class="cache-dot" style="background:${SEGMENT_COLORS.skills}"></i>Skills 5.0k`,
    );
    expect(html).toContain("Unitemised 100.0k");
  });

  it("drops the Unitemised swatch when there is no remainder", () => {
    const html = renderCachePanelHtml(sample({ promptTokens: 100_000 }));
    expect((html.match(/cache-legend-item/g) ?? []).length).toBe(7); // 7 measured, no remainder
  });
});

// FORK 2026-07-28 — the turn-aggregate poisoning of the WINDOW bar.
//
// On the cc-bridge lane (`claude-code`, the live primary) the embedded cache-telemetry
// producer receives the CLI's terminal `result` usage, summed across every internal API call
// of the turn. These are the REAL figures measured live on 2026-07-28: 6,448,106 billed
// against a 1,000,000-token window whose true context was 52,116. The panel rendered "645%".
describe("turn-aggregate promptTokens must not drive the window bar", () => {
  const poisoned = (): CachePanelState =>
    sample({
      promptTokens: 6_448_106,
      maxWindow: 1_000_000,
      cacheRead: 6_300_000,
      cacheWrite: 100_000,
    });

  it("does not render an impossible fill percentage", () => {
    const html = renderCachePanelHtml(poisoned());
    expect(html).not.toContain("645%");
    // No fill above 100% in any form.
    for (const m of html.matchAll(/(\d+)%/g)) {
      expect(Number(m[1])).toBeLessThanOrEqual(100);
    }
  });

  it("falls back to the anatomy composition and marks it as measured", () => {
    const html = renderCachePanelHtml(poisoned());
    expect(html).toContain("measured");
    // 6.4M must not appear as the window figure.
    expect(html).not.toContain("6.4M / 1.0M");
  });

  it("keeps the cache split bar and legend intact — ratios survive aggregation", () => {
    const html = renderCachePanelHtml(poisoned());
    // cacheRead/cacheWrite come from the SAME aggregate as promptTokens, so cached/written/new
    // remain internally consistent. The panel must NOT go blank on the main lane.
    expect(html).toContain("cached");
    expect(html).toContain("written");
    expect(html).toContain("new");
    expect(html).not.toContain("no cache data yet");
  });

  it("leaves a plausible per-call sample completely unchanged", () => {
    // Regression guard on the guard: normal samples must not be degraded.
    const before = renderCachePanelHtml(sample({ promptTokens: 200_000 }));
    expect(before).not.toContain("measured");
    expect(before).toContain("20%");
  });
});

describe("escaping", () => {
  it("escapes the model name", () => {
    const html = renderCachePanelHtml(sample({ model: "<script>x</script>" }));
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("escapes the provider before it reaches an attribute-adjacent position", () => {
    const html = renderCachePanelHtml(sample({ provider: 'x" onmouseover="y' }));
    expect(html).toContain("&quot;");
    expect(html).not.toContain('onmouseover="');
  });
});

// FORK 2026-08-29 (the architect): THIS CALL and THIS SESSION are panels of numbers, not bars —
// "it does not make sense to represent in a graph an unbounded value".
describe("THIS CALL / THIS SESSION stat panels", () => {
  it("draws no bar for the unbounded values", () => {
    const html = renderCachePanelHtml(base);
    expect(html).not.toContain("cache-bar--split");
    // exactly ONE bar survives: the window, which has a real denominator
    expect((html.match(/class="cache-bar/g) ?? []).length).toBe(1);
  });

  it("orders the sections WINDOW, THIS CALL, THIS SESSION", () => {
    const html = renderCachePanelHtml(base);
    expect(html.indexOf("WINDOW")).toBeLessThan(html.indexOf("THIS CALL"));
    expect(html.indexOf("THIS CALL")).toBeLessThan(html.indexOf("THIS SESSION"));
    expect(html.indexOf("cache-stats--call")).toBeLessThan(html.indexOf("cache-stats--session"));
  });

  it("reports the call's parts, including the unitemised size", () => {
    const html = renderCachePanelHtml(base);
    expect(html).toContain('data-stat="cached"');
    expect(html).toContain('data-stat="written"');
    expect(html).toContain('data-stat="new"');
    // base: 200k billed, anatomy sums to 100k -> 100k unitemised
    expect(html).toMatch(/data-stat="unitemised"[\s\S]*?100\.0k/);
  });

  it("shows a dash, never a fabricated zero, for a stat with no data", () => {
    const html = renderCachePanelHtml(base); // no lastEvictedTokens, no sessionStats
    expect(html).toMatch(/data-stat="evicted"[\s\S]*?—/);
    expect(html).toMatch(/data-stat="turns"[\s\S]*?—/);
  });

  it("renders session counters as plain counts, not on the token ladder", () => {
    const html = renderCachePanelHtml(
      sample({ sessionStats: { turns: 1200, compactions: 3, evictedTokens: 250_000 } }),
    );
    // 1200 turns is "1200", not "1.2k"
    expect(html).toMatch(/data-stat="turns"[\s\S]*?>1200</);
    expect(html).toMatch(/data-stat="compactions"[\s\S]*?>3</);
    // tokens DO use the ladder
    expect(html).toMatch(/data-stat="evicted-total"[\s\S]*?250\.0k/);
  });

  it("estimates the saving as evicted x turns, and says nothing without both", () => {
    const withBoth = renderCachePanelHtml(
      sample({ sessionStats: { turns: 4, compactions: 1, evictedTokens: 100_000 } }),
    );
    expect(withBoth).toMatch(/data-stat="saved"[\s\S]*?400\.0k/);
    const noTurns = renderCachePanelHtml(
      sample({ sessionStats: { compactions: 1, evictedTokens: 100_000 } }),
    );
    expect(noTurns).toMatch(/data-stat="saved"[\s\S]*?—/);
  });

  it("glows only the keys it is told to, and only those", () => {
    const html = renderCachePanelHtml(sample({ glow: ["cached", "turns"] }));
    expect(html).toMatch(/data-stat="cached"/);
    expect((html.match(/cache-stat--glow/g) ?? []).length).toBe(2);
    // the glowing cells are the named ones
    for (const key of ["cached", "turns"]) {
      const cell = html.match(new RegExp(`<div class="cache-stat[^"]*"\\s+data-stat="${key}"`));
      expect(cell?.[0]).toContain("cache-stat--glow");
    }
  });

  it("glows nothing when no keys are handed in", () => {
    expect(renderCachePanelHtml(base)).not.toContain("cache-stat--glow");
  });

  it("no longer renders the action buttons — they moved to the panel title", () => {
    expect(renderCachePanelHtml(base)).not.toContain("data-cache-act");
  });
});
