import { describe, expect, it } from "vitest";
import {
  renderRoutingRationale,
  suppliesBlock,
  thalamusBlocks,
  type RoutingSignals,
} from "./routing-rationale";
import {
  ago,
  clock,
  headModel,
  eur,
  renderThalamusV4,
  seconds,
  shortModel,
  switchWords,
  SWITCH_WORDS,
  type ThalamusV4Panel,
  type ThalamusV4View,
  type V4Decision,
  type V4Plan,
  type V4Use,
} from "./thalamus-v4-card";

// Phase G: the Thalamus v4 block. Quiet by default, plain words, and absent when there is nothing to say.

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const opts = { nowMs: NOW };
const text = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const decision = (over: Partial<V4Decision> = {}): V4Decision => ({
  id: "d1",
  ts: NOW - 2 * MIN,
  mode: "shadow",
  incumbent: "claude-code/claude-opus-5",
  chosen: "claude-code/claude-sonnet-5-5",
  chosenEffort: "medium",
  pick: "claude-code/claude-sonnet-5-5",
  switchKind: "switch",
  switchReason: "cache-cold",
  nStar: null,
  wouldChange: true,
  degraded: false,
  private: false,
  price: 0.0312,
  incumbentPrice: 0.0994,
  options: [
    {
      key: "claude-code/claude-opus-5",
      effort: "high",
      feed: "thread",
      price: 0.0994,
      quality: 70,
    },
    {
      key: "claude-code/claude-sonnet-5-5",
      effort: "medium",
      feed: "thread",
      price: 0.0312,
      quality: 64,
    },
    { key: "xai/grok-4.7", effort: "high", feed: "brief", price: 0.0213, quality: 62 },
  ],
  vetoes: [],
  domain: "code",
  topic: "none",
  stepKind: "tool",
  ...over,
});

const use = (over: Partial<V4Use> = {}): V4Use => ({
  taskId: "t1",
  ts: NOW - 5 * MIN,
  source: "tinker",
  private: false,
  shuffled: false,
  listShown: true,
  listReason: "shown",
  listSource: "jev",
  noneFits: 0.1,
  shown: [
    { cardId: "skill:translation-checker", rank: 1, prob: 0.62, fit: { value: "made-for" } },
    { cardId: "recipe:photo-sorter", rank: 2, prob: 0.2, fit: { value: "by-structure" } },
  ],
  used: [{ cardId: "recipe:photo-sorter", onList: true, rank: 2, via: "skill-tool" }],
  outcome: "done",
  mode: "shadow",
  taskKind: "code",
  ...over,
});

const plan = (over: Partial<V4Plan> = {}): V4Plan => ({
  planId: "p1",
  ts: NOW - 10 * MIN,
  mode: "shadow",
  units: [
    {
      unitId: "plan",
      copy: 0,
      model: "claude-code/claude-opus-5",
      startSec: 0,
      endSec: 15,
      slackSec: 0,
      onCritical: true,
      hedged: false,
      status: "placed",
      deps: [],
    },
    {
      unitId: "r1",
      copy: 0,
      model: "xai/grok-4.7",
      startSec: 15,
      endSec: 34,
      slackSec: 0,
      onCritical: true,
      hedged: true,
      status: "placed",
      deps: ["plan"],
    },
    {
      unitId: "r2",
      copy: 0,
      model: "xai/grok-4.7",
      startSec: 15,
      endSec: 33,
      slackSec: 4,
      onCritical: false,
      hedged: false,
      status: "placed",
      deps: ["plan"],
    },
    {
      unitId: "r1",
      copy: 1,
      model: "claude-code/claude-haiku-4-5",
      startSec: 44,
      endSec: 63,
      slackSec: 0,
      onCritical: true,
      hedged: true,
      status: "won",
      deps: [],
    },
  ],
  ...over,
});

const panel = (over: Partial<ThalamusV4Panel> = {}): ThalamusV4Panel => ({
  mode: "shadow",
  ts: NOW,
  today: { calls: 14, wouldChange: 3 },
  lastDecisionAt: NOW - 2 * MIN,
  learning: { enabled: false, apply: false },
  decisions: [decision()],
  uses: [use()],
  cardNames: {
    "skill:translation-checker": { name: "translation-checker", kind: "skill" },
    "recipe:photo-sorter": { name: "photo-sorter", kind: "recipe" },
  },
  plans: [plan()],
  ...over,
});

const ok = (over: Partial<ThalamusV4Panel> = {}): ThalamusV4View => ({
  state: "ok",
  panel: panel(over),
});

describe("off means absent", () => {
  it("draws nothing without a view, and the routing card is then the card it was", () => {
    expect(renderThalamusV4(undefined, opts)).toBe("");
    const base: RoutingSignals = {
      modelLabel: "Opus 5",
      modelPinned: false,
      effortLabel: "Auto",
      effortPinned: false,
      nowMs: NOW,
    };
    expect(renderRoutingRationale({ ...base, thalamusV4: undefined })).toBe(
      renderRoutingRationale(base),
    );
    expect(thalamusBlocks({ ...base, thalamusV4: undefined })).toBe(thalamusBlocks(base));
  });

  it("with a view, adds the block above the v2 blocks and changes nothing below it", () => {
    const base: RoutingSignals = {
      modelLabel: "Opus 5",
      modelPinned: false,
      effortLabel: "Auto",
      effortPinned: false,
      nowMs: NOW,
    };
    const view = ok();
    const withBlock = thalamusBlocks({ ...base, thalamusV4: view });
    const block = renderThalamusV4(view, opts);
    expect(block).not.toBe("");
    expect(withBlock).toBe(block + thalamusBlocks(base));
    expect(suppliesBlock(base)).toBe("");
  });
});

describe("the closed line: always true, one line", () => {
  it("names the mode, the calls today and how many would have changed", () => {
    expect(text(renderThalamusV4(ok(), opts))).toContain(
      "Thalamus: shadow · 14 calls today · would have changed 3",
    );
  });

  it("says plainly when nothing has happened yet today, and uses the singular for one call", () => {
    expect(text(renderThalamusV4(ok({ today: { calls: 0, wouldChange: 0 } }), opts))).toContain(
      "Thalamus: shadow · no calls yet today",
    );
    expect(text(renderThalamusV4(ok({ today: { calls: 1, wouldChange: 0 } }), opts))).toContain(
      "1 call today · would have changed 0",
    );
  });

  it("calls enforce mode enforcing", () => {
    expect(text(renderThalamusV4(ok({ mode: "enforce" }), opts))).toContain("Thalamus: enforcing");
  });

  it("is quiet when the gateway answers with an error: one line, and the reason inside", () => {
    const html = renderThalamusV4({ state: "error", message: "timed out" }, opts);
    expect(text(html)).toContain("Thalamus: not answering right now");
    expect(text(html)).toContain("It could not be read just now: timed out. It will try again.");
    expect(html).not.toContain("Recent calls");
  });
});

describe("closed by default, and it stays as the reader left it", () => {
  it("nothing is open unless asked", () => {
    const html = renderThalamusV4(ok(), opts);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html.match(/<details/g)!.length).toBeGreaterThan(3);
  });

  it("opens exactly the expanders in the open set, so a repaint does not close them", () => {
    const html = renderThalamusV4(ok(), { nowMs: NOW, open: new Set(["t4:block", "t4:d:d1"]) });
    const open = [...html.matchAll(/<details[^>]*data-t4="([^"]+)"[^>]* open/g)].map((m) => m[1]);
    expect(open.toSorted()).toEqual(["t4:block", "t4:d:d1"]);
  });

  it("each row is one line: a summary with no line breaks in it", () => {
    const html = renderThalamusV4(ok(), opts);
    for (const m of html.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g))
      expect(m[1]).not.toMatch(/<br|<div/);
  });
});

describe("recent calls", () => {
  it("a row says what would happen and why in a few words; the whole sentence is in its tooltip and its detail", () => {
    const html = renderThalamusV4(ok(), opts);
    const t = text(html);
    expect(t).toContain("would move opus-5 → sonnet-5-5 · cache cold");
    // In the attribute the apostrophe is an entity; a browser shows it as the character.
    const tip = (html.match(/<summary[^>]*title="([^"]*would move[^"]*)"/)?.[1] ?? "").replace(
      /&#39;/g,
      "'",
    );
    expect(tip).toMatch(
      /^\d\d:\d\d would move opus-5 → sonnet-5-5 · cache cold — the old model's cache had gone cold anyway$/,
    );
    expect(t).toContain("Rule: the old model's cache had gone cold anyway.");
    const row = (over: Partial<V4Decision>) =>
      text(renderThalamusV4(ok({ decisions: [decision(over)] }), opts));
    const keep = row({ switchKind: "keep", switchReason: "kept-below-n-star" });
    expect(keep).toContain("stays on opus-5 · short run");
    expect(keep).toContain("Rule: a short run is not worth the move.");
    const fresh = row({ switchKind: "fresh", switchReason: "fresh-point" });
    expect(fresh).toContain("would start on sonnet-5-5 · new step");
    expect(fresh).toContain("Rule: a new step, so nothing warm to lose.");
  });

  it("an unknown reason is shown as it is in the row too", () => {
    expect(
      text(
        renderThalamusV4(ok({ decisions: [decision({ switchReason: "something-new" })] }), opts),
      ),
    ).toContain("· something new");
  });

  it("the model in a row is the short name, without the provider or the maker's prefix", () => {
    expect(headModel("claude-code/claude-sonnet-5-5")).toBe("sonnet-5-5");
    expect(headModel("xai/grok-4.7")).toBe("grok-4.7");
    expect(headModel("plain")).toBe("plain");
  });

  it("the detail lists the options cheapest first with the chosen one marked, and the current model named", () => {
    const html = renderThalamusV4(ok(), opts);
    const t = text(html);
    expect(t).toContain("grok-4.7 high");
    expect(t).toMatch(/✓ claude-sonnet-5-5 medium chosen/);
    expect(t).toContain("claude-opus-5 high now");
    // The rows, in the order drawn: cheapest first.
    const rows = [
      ...html.matchAll(
        /grid-template-columns:10px minmax\(0,1fr\) 40px 38px 58px[^>]*>([\s\S]*?)<\/div>/g,
      ),
    ].map((m) => text(m[1]));
    expect(rows.map((r) => r.match(/(grok-4\.7|claude-sonnet-5-5|claude-opus-5)/)?.[1])).toEqual([
      "grok-4.7",
      "claude-sonnet-5-5",
      "claude-opus-5",
    ]);
    expect(t).toContain("€0.0312");
    expect(t).toContain("q 64");
  });

  it("the detail gives the reads, the rule with its break-even point, the vetoes and the reserved model in words", () => {
    const d = decision({
      nStar: 4.75,
      switchReason: "run-exceeds-n-star",
      degraded: true,
      private: true,
      reservedReason: "feasibility",
      vetoes: [
        { key: "claude-code/claude-opus-5", veto: "privacy" },
        { key: "xai/grok-4.7", veto: "supply-cooling" },
      ],
      topic: "medical",
    });
    const t = text(renderThalamusV4(ok({ decisions: [d] }), opts));
    expect(t).toContain("kind of work: code · topic: medical · this step: tool");
    expect(t).toContain("The reader was unsure, so it played safe.");
    expect(t).toContain("From a private source: read locally, nothing sent out.");
    expect(t).toContain("The move pays after about 4.8 steps.");
    expect(t).toContain("Ruled out: claude-opus-5 (private source), grok-4.7 (rate-limited)");
    expect(t).toContain("A reserved model was opened: feasibility.");
  });

  it("cuts a long option list to six and says how many more there are", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      key: `p/m${i}`,
      price: 0.01 * (i + 1),
      quality: 60,
    }));
    expect(
      text(renderThalamusV4(ok({ decisions: [decision({ options: many })] }), opts)),
    ).toContain("and 3 more");
  });

  it("an unknown reason is shown as it is, never hidden", () => {
    expect(switchWords("something-new")).toBe("something new");
    expect(Object.keys(SWITCH_WORDS)).toEqual(
      expect.arrayContaining([
        "no-change",
        "hand-picked",
        "fresh-point",
        "run-exceeds-n-star",
        "single-step-pays",
        "stuck",
        "cache-cold",
        "incumbent-vetoed",
        "kept-below-n-star",
      ]),
    );
  });

  it("the group label counts the calls and says when the last one was", () => {
    expect(text(renderThalamusV4(ok(), opts))).toContain("Recent calls · 1 call · last 2 min ago");
  });
});

describe("short lists", () => {
  it("in shadow says plainly that the list was recorded and not shown", () => {
    const t = text(renderThalamusV4(ok(), opts));
    expect(t).toContain("Short lists · 1 task · recorded, not shown to the agent");
    expect(t).toContain("The list was recorded, not shown to the agent.");
  });

  it("in enforce says the list was shown", () => {
    const t = text(
      renderThalamusV4(ok({ mode: "enforce", uses: [use({ mode: "enforce" })] }), opts),
    );
    expect(t).toContain("Short lists · 1 task · shown to the agent");
    expect(t).toContain("The list was shown to the agent.");
  });

  it("a row gives the suggestions and what the agent used, with its place on the list", () => {
    const t = text(renderThalamusV4(ok(), opts));
    expect(t).toContain("code · 2 suggestions · used photo-sorter (second)");
  });

  it("the detail gives each entry's rank, name, kind, fit in words and probability, and the chance none fit", () => {
    const t = text(renderThalamusV4(ok(), opts));
    expect(t).toContain("#1 translation-checker (skill) · made for it 62%");
    expect(t).toContain("#2 ✓ photo-sorter (recipe) · fits by structure 20%");
    expect(t).toContain("None of these fits: 10%.");
    expect(t).toContain("Used: photo-sorter, it was second on the list.");
    expect(t).toContain("It finished.");
  });

  it("covers a part of it, an off-list pick, nothing used, nothing fitting, a retry and a correction", () => {
    const partial = use({
      shown: [
        { cardId: "skill:translation-checker", rank: 1, prob: 0.4, fit: { value: "covers-part" } },
      ],
      used: [],
    });
    expect(text(renderThalamusV4(ok({ uses: [partial] }), opts))).toContain("covers part of it");
    expect(text(renderThalamusV4(ok({ uses: [partial] }), opts))).toContain(
      "The agent used none of them.",
    );
    const off = use({ used: [{ cardId: "skill:other", onList: false, via: "skill-tool" }] });
    expect(text(renderThalamusV4(ok({ uses: [off] }), opts))).toContain(
      "used other (not on the list)",
    );
    const none = use({ shown: [], used: [], listReason: "none-leads", listShown: false });
    expect(text(renderThalamusV4(ok({ uses: [none] }), opts))).toContain(
      "nothing fit · used nothing",
    );
    expect(text(renderThalamusV4(ok({ uses: [use({ outcome: "retried" })] }), opts))).toContain(
      "It had to retry.",
    );
    expect(text(renderThalamusV4(ok({ uses: [use({ outcome: "corrected" })] }), opts))).toContain(
      "You corrected it.",
    );
  });

  it("in shadow the shuffle is what would have happened, in enforce it is what happened", () => {
    const shadow = text(
      renderThalamusV4(ok({ uses: [use({ shuffled: true, private: true })] }), opts),
    );
    expect(shadow).toContain("The list was recorded, not shown to the agent.");
    expect(shadow).toContain(
      "It would have been shown in a shuffled order, to measure how much the agent follows position.",
    );
    expect(shadow).not.toContain("It was shown in a shuffled order");
    expect(shadow).toContain("From a private source: ranked locally, nothing sent out.");

    const enforced = text(
      renderThalamusV4(ok({ uses: [use({ shuffled: true, mode: "enforce" })] }), opts),
    );
    expect(enforced).toContain("The list was shown to the agent.");
    expect(enforced).toContain(
      "It was shown in a shuffled order, to measure how much the agent follows position.",
    );
    expect(enforced).not.toContain("would have been shown");
  });

  it("names an enhancement it has no card for by the tail of its id, never blank", () => {
    const t = text(
      renderThalamusV4(
        ok({
          cardNames: {},
          uses: [use({ shown: [], used: [{ cardId: "skill:ghost", onList: false, via: "x" }] })],
        }),
        opts,
      ),
    );
    expect(t).toContain("used ghost");
  });
});

describe("the latest plan", () => {
  it("counts the steps, the time and the hedges, and says a shadow plan only would send them", () => {
    const t = text(renderThalamusV4(ok(), opts));
    expect(t).toContain("Latest plan · 3 steps · about 63 s · 1 hedge (would send)");
    expect(t).toContain("Plan · 10 min ago");
  });

  it("marks the critical path, draws a dashed bar for a copy, and explains both", () => {
    const html = renderThalamusV4(ok(), opts);
    expect((html.match(/◆/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain("↳ copy of r1");
    expect(html).toContain("border:1px dashed");
    expect(text(html)).toContain(
      "◆ is on the critical path. A dashed bar is a second copy of a slow step on another provider.",
    );
  });

  it("puts every bar inside its track, however the times fall", () => {
    const html = renderThalamusV4(ok(), opts);
    for (const m of html.matchAll(/left:([\d.]+)%;width:([\d.]+)%/g)) {
      expect(Number(m[1])).toBeGreaterThanOrEqual(0);
      expect(Number(m[1])).toBeLessThanOrEqual(100);
      expect(Number(m[2])).toBeGreaterThan(0);
    }
  });

  it("an enforce plan says its hedges were sent, and a long plan is cut with a count", () => {
    const longUnits = Array.from({ length: 30 }, (_, i) => ({
      unitId: `u${i}`,
      copy: 0,
      model: "p/m",
      startSec: i,
      endSec: i + 1,
      onCritical: false,
      hedged: false,
      status: "placed",
      deps: [],
    }));
    const t = text(
      renderThalamusV4(ok({ mode: "enforce", plans: [plan({ mode: "enforce" })] }), opts),
    );
    expect(t).toContain("1 hedge (sent)");
    expect(text(renderThalamusV4(ok({ plans: [plan({ units: longUnits })] }), opts))).toContain(
      "and 6 more",
    );
  });

  it("draws nothing for a plan with no units, or no plan", () => {
    expect(text(renderThalamusV4(ok({ plans: [] }), opts))).not.toContain("Latest plan");
    expect(text(renderThalamusV4(ok({ plans: [plan({ units: [] })] }), opts))).not.toContain(
      "Latest plan",
    );
  });
});

describe("empty, and safe", () => {
  it("an empty but running plugin says nothing has been recorded yet, and that shadow only watches", () => {
    const t = text(
      renderThalamusV4(
        ok({ decisions: [], uses: [], plans: [], today: { calls: 0, wouldChange: 0 } }),
        opts,
      ),
    );
    expect(t).toContain("Nothing recorded yet. It fills in as the agent works.");
    expect(t).toContain("Shadow mode: it only watches and writes down what it would do.");
  });

  it("escapes everything it draws: a model, a card or a message with markup cannot inject any", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const html = renderThalamusV4(
      ok({
        decisions: [
          decision({
            chosen: `p/${evil}`,
            incumbent: `p/${evil}`,
            domain: evil,
            vetoes: [{ key: `p/${evil}`, veto: evil }],
            options: [{ key: `p/${evil}`, price: 1 }],
          }),
        ],
        uses: [
          use({
            shown: [{ cardId: `skill:${evil}`, rank: 1, prob: 0.5 }],
            used: [],
            taskKind: evil,
          }),
        ],
        cardNames: { [`skill:${evil}`]: { name: evil, kind: evil } },
        plans: [
          plan({
            units: [
              {
                unitId: evil,
                copy: 0,
                model: `p/${evil}`,
                startSec: 0,
                endSec: 1,
                onCritical: true,
                hedged: false,
                status: evil,
                deps: [],
              },
            ],
          }),
        ],
      }),
      opts,
    );
    expect(html).not.toContain("<img");
    expect(renderThalamusV4({ state: "error", message: evil }, opts)).not.toContain("<img");
  });

  it("shows no session key, task text or prompt, because none is in what it is given", () => {
    const html = renderThalamusV4(ok(), opts);
    expect(html).not.toMatch(/agent:main|prompt|question/i);
  });
});

describe("small helpers", () => {
  it("shortens a route key, with the effort when there is one", () => {
    expect(shortModel("claude-code/claude-opus-5")).toBe("claude-opus-5");
    expect(shortModel("claude-opus-5", "high")).toBe("claude-opus-5 (high)");
  });
  it("formats time and money", () => {
    expect(ago(30_000)).toBe("just now");
    expect(ago(2 * MIN)).toBe("2 min ago");
    expect(ago(3 * 3_600_000)).toBe("3 h ago");
    expect(ago(72 * 3_600_000)).toBe("3 days ago");
    expect(seconds(63)).toBe("63 s");
    expect(seconds(150)).toBe("2.5 min");
    expect(seconds(undefined)).toBe("—");
    expect(eur(0.0312)).toBe("€0.0312");
    expect(eur(0.00312)).toBe("€0.0031");
    expect(eur(2.5)).toBe("€2.50");
    expect(clock(NOW)).toMatch(/^\d\d:\d\d$/);
  });
});
