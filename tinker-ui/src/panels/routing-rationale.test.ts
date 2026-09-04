import { describe, it, expect } from "vitest";
import {
  BIAS_DEFAULT_IDX,
  BIAS_STOPS,
  biasStop,
  policyLink,
  renderBiasSlider,
  describeRoute,
  effortLine,
  explainBurn,
  fanOutLine,
  frontierLine,
  jobLabel,
  modelLine,
  renderRoutingRationale,
  type RouteDecision,
  type RoutingSignals,
} from "./routing-rationale";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const base: RoutingSignals = {
  modelLabel: "Opus 5",
  modelPinned: true,
  effortLabel: "Auto",
  effortPinned: false,
  nowMs: NOW,
  parallelCap: 6,
  cores: 8,
};

/** Strip tags so a length assertion measures the words the user reads, not the markup. */
const words = (html: string): string => html.replace(/<[^>]+>/g, "");

describe("explainBurn — mirrors effort-allocator deriveQuotaPressure", () => {
  it("returns null without live quota signals", () => {
    expect(explainBurn(base)).toBeNull();
    expect(explainBurn({ ...base, util7d: 0.3 })).toBeNull();
    expect(explainBurn({ ...base, weeklyResetAt: NOW + DAY })).toBeNull();
  });

  it("returns null once the reset is in the past (allocator's neutral branch)", () => {
    expect(explainBurn({ ...base, util7d: 0.3, weeklyResetAt: NOW - 1 })).toBeNull();
  });

  it("early in the week with the cap barely touched ⇒ low burn floor", () => {
    const b = explainBurn({ ...base, util7d: 0.1, weeklyResetAt: NOW + 6 * DAY })!;
    expect(b.weekElapsed).toBeCloseTo(1 / 7, 3);
    expect(b.headroom).toBeCloseTo(0.9, 5);
    expect(b.burnDemand).toBeLessThan(0.15);
    expect(b.floor).toBe("minimal");
  });

  it("late in the week with headroom left ⇒ max burn floor", () => {
    const b = explainBurn({ ...base, util7d: 0.2, weeklyResetAt: NOW + 1 * DAY })!;
    expect(b.weekElapsed).toBeCloseTo(6 / 7, 3);
    expect(b.burnDemand).toBe(1);
    expect(b.floor).toBe("max");
  });

  it("late in the week but already spent ⇒ headroom collapses, floor drops", () => {
    const b = explainBurn({ ...base, util7d: 0.98, weeklyResetAt: NOW + 1 * DAY })!;
    expect(b.headroom).toBeCloseTo(0.02, 5);
    expect(b.burnDemand).toBeLessThan(0.1);
    expect(b.floor).toBe("minimal");
  });

  it("behind-pace alone lifts demand even mid-week", () => {
    const b = explainBurn({ ...base, util7d: 0, weeklyResetAt: NOW + 3.5 * DAY })!;
    expect(b.burnDemand).toBeGreaterThan(0.5);
  });
});

describe("MODEL section — the choice, not the rule", () => {
  it("a fixed model is stated and nothing more (the architect: no unnecessary words)", () => {
    expect(modelLine(base)).toBe("Fixed to <b>Opus 5</b>.");
  });

  it("a free model names its rank in the routable pool", () => {
    const html = modelLine({ ...base, modelPinned: false, modelRank: 1, poolSize: 11 });
    expect(html).toBe("<b>Opus 5</b> — top of the chain (rank 1 of 11).");
  });

  it("omits the rank cleanly when the pool is unknown", () => {
    const html = modelLine({ ...base, modelPinned: false });
    expect(html).toBe("<b>Opus 5</b> — top of the chain.");
    expect(html).not.toContain("undefined");
  });

  it("never restates the standing policy — that lives in the linked md", () => {
    for (const s of [base, { ...base, modelPinned: false, modelRank: 1, poolSize: 11 }]) {
      const html = modelLine(s).toLowerCase();
      for (const policyWord of ["scored best", "kind of work", "measured", "benchmark"]) {
        expect(html).not.toContain(policyWord);
      }
    }
  });

  it("escapes the model label", () => {
    const html = modelLine({ ...base, modelLabel: "<script>" });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("EFFORT section — the level and the two numbers behind it", () => {
  it("a fixed effort is stated and nothing more", () => {
    expect(effortLine({ ...base, effortPinned: true, effortLabel: "medium" })).toBe(
      "Fixed at <b>medium</b>.",
    );
  });

  it("gives no burn-down story for a pinned effort, even with live quota data", () => {
    const html = effortLine({
      ...base,
      effortPinned: true,
      effortLabel: "medium",
      util7d: 0.2,
      weeklyResetAt: NOW + DAY,
    });
    expect(html).not.toContain("week");
    expect(html).not.toContain("quota");
  });

  it("a free effort shows the level plus week position and headroom", () => {
    const html = effortLine({ ...base, util7d: 0.2, weeklyResetAt: NOW + DAY });
    expect(html).toBe("<b>max</b> — 86% into the week, 80% of quota unspent.");
  });

  it("never explains WHY unused quota matters — that is policy", () => {
    const html = effortLine({ ...base, util7d: 0.2, weeklyResetAt: NOW + DAY }).toLowerCase();
    expect(html).not.toContain("expires");
    expect(html).not.toContain("burn");
    expect(html).not.toContain("floor");
  });

  it("degrades to a short sentence when quota data is missing", () => {
    const html = effortLine(base);
    expect(words(html).length).toBeLessThan(45);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });
});

describe("describeRoute — plainest possible words, with the routing key visible", () => {
  it("build-debug reads as do-it / check-it", () => {
    expect(
      describeRoute({
        unit: "u1",
        task: "the socket crash",
        mode: "build-debug",
        model: "Opus 5",
        critic: "GPT-5.6",
      }),
    ).toBe("the socket crash — <b>Opus 5</b> does it, <b>GPT-5.6</b> checks it.");
  });

  it("debate reads as answer-alone then pick", () => {
    const html = describeRoute({
      unit: "u2",
      task: "the CI failure",
      mode: "debate",
      model: "GPT-5.6",
      panel: ["GPT-5.6", "Opus 5", "Gemini 3.1"],
    });
    expect(html).toContain("each answer alone");
    expect(html).toContain("<b>GPT-5.6</b> picks");
  });

  it("solo reads as one model alone", () => {
    expect(describeRoute({ unit: "u3", task: "the README", mode: "solo", model: "Fable 5" })).toBe(
      "the README — <b>Fable 5</b> alone.",
    );
  });

  it("shows the domain it routed on — this is what exposes a mis-routed job", () => {
    const html = describeRoute({
      unit: "u",
      task: "the CI packaging failure",
      domain: "systems",
      mode: "solo",
      model: "GPT-5.6",
    });
    expect(html).toContain('<span class="routing-why-dom">systems</span>');
  });

  it("uses no scores or internal jargon", () => {
    const html = describeRoute({
      unit: "u1",
      task: "the socket crash",
      domain: "debug",
      mode: "build-debug",
      model: "Opus 5",
      critic: "GPT-5.6",
    }).toLowerCase();
    for (const banned of ["score", "prior", "aggregat", "provider", "ledger", "margin"]) {
      expect(html).not.toContain(banned);
    }
  });

  it("falls back to the unit id when no task text was given", () => {
    expect(describeRoute({ unit: "panel-ui", mode: "solo", model: "Opus 5" })).toContain(
      "panel-ui",
    );
  });

  it("escapes task text and domain", () => {
    const html = describeRoute({
      unit: "u",
      task: "<img>",
      domain: "<b>x",
      mode: "solo",
      model: "Opus 5",
    });
    expect(html).toContain("&lt;img&gt;");
    expect(html).not.toContain("<img>");
    expect(html).toContain("&lt;b&gt;x");
  });
});

describe("FAN-OUT section", () => {
  it("states the cap and where it came from", () => {
    expect(fanOutLine(base)).toBe("<b>6 at once</b> — cores−2 of 8.");
  });

  it("degrades gracefully before the cap is known", () => {
    const html = fanOutLine({ ...base, parallelCap: undefined, cores: undefined });
    expect(html).toContain("One agent per job");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
  });

  it("lists every routing call made during the turn", () => {
    const routes: RouteDecision[] = [
      {
        unit: "a",
        task: "the socket crash",
        mode: "build-debug",
        model: "Opus 5",
        critic: "GPT-5.6",
      },
      {
        unit: "b",
        task: "the CI failure",
        mode: "debate",
        model: "GPT-5.6",
        panel: ["GPT-5.6", "Opus 5"],
      },
      { unit: "c", task: "the README", mode: "solo", model: "Fable 5" },
    ];
    const html = fanOutLine({ ...base, routes });
    // ONE LINE, always (the architect 2026-07-29: "Fan-out should only be one line") — the same
    // complaint as the "kilometer long" regression below, one level up: a <ul> of <li>s grew
    // the card with the fan-out. Detail moves to a hover title, never to extra lines.
    expect(html).toContain("<b>3 jobs</b> this turn");
    expect(html).not.toContain("<li>");
    expect(html).not.toContain("<ul");
    expect(html).not.toContain("<div");
    // ...and it is still debuggable: every model remains reachable on hover.
    expect(html).toContain("title=");
    for (const model of ["Opus 5", "GPT-5.6", "Fable 5"]) {
      expect(html).toContain(model);
    }
  });

  it("renders a single route INLINE — the normal-turn case is one sentence", () => {
    const html = fanOutLine({ ...base, routes: [{ unit: "a", mode: "solo", model: "Opus 5" }] });
    expect(html).toContain("Opus 5");
    expect(html).not.toContain("<li>");
    expect(html).not.toContain("<ul");
    // No job-count preamble when there is exactly one job: the sentence IS the report.
    expect(html).not.toContain("jobs</b> this turn");
  });

  it("omits the job list entirely when nothing was routed", () => {
    const html = fanOutLine({ ...base, routes: [] });
    expect(html).not.toContain("<ul");
    expect(html).not.toContain("this turn");
  });

  // REGRESSION 2026-07-27 (the architect: "the orca panel is like a kilometer long"): the Conductor
  // writes each unit's FULL prompt into `task`, so the card was printing thousands of chars
  // per job. A job line is one line — never the prompt.
  it("names a prompt-sized job by its unit id, not the prompt", () => {
    const r: RouteDecision = {
      unit: "panel-render",
      task: "Create a NEW pure-render panel module `tinker-ui/src/panels/context-cache.ts`\nwith no DOM APIs.".repeat(
        40,
      ),
      mode: "solo",
      model: "Opus 5",
    };
    expect(jobLabel(r)).toBe("panel-render");
    expect(describeRoute(r)).not.toContain("pure-render panel module");
  });

  it("keeps a short one-line task exactly as given", () => {
    expect(jobLabel({ unit: "a", task: "the socket crash", mode: "solo", model: "Opus 5" })).toBe(
      "the socket crash",
    );
  });

  it("clips a long prompt when there is no unit id to fall back to", () => {
    const label = jobLabel({ unit: "", task: "x".repeat(500), mode: "solo", model: "Opus 5" });
    expect(label.length).toBeLessThanOrEqual(72);
    expect(label.endsWith("…")).toBe(true);
  });

  it("stays ONE line even for a big fan-out", () => {
    const routes: RouteDecision[] = Array.from({ length: 8 }, (_, i) => ({
      unit: `unit-${i}`,
      task: "PROMPT ".repeat(500),
      mode: "solo",
      model: "Opus 5",
    }));
    const html = fanOutLine({ ...base, routes });
    expect(html).not.toContain("<li>");
    expect(html).not.toContain("<ul");
    expect(html).toContain("<b>8 jobs</b> this turn");
    // The prompt must never reach the card — not the visible line, and not the tooltip
    // either, which is where a careless "put the detail in a title" would leak it.
    expect(html).not.toContain("PROMPT");
    expect(html.length).toBeLessThan(1200);
  });
});

describe("renderRoutingRationale", () => {
  it("emits exactly the three labelled sections in order", () => {
    const html = renderRoutingRationale(base);
    expect((html.match(/routing-why-row/g) || []).length).toBe(3);
    expect(html.indexOf(">MODEL<")).toBeLessThan(html.indexOf(">EFFORT<"));
    expect(html.indexOf(">EFFORT<")).toBeLessThan(html.indexOf(">FAN-OUT<"));
  });

  it("stays terse when both model and effort are fixed", () => {
    const html = renderRoutingRationale({ ...base, effortPinned: true, effortLabel: "high" });
    expect(words(html)).toContain("Fixed to Opus 5.");
    expect(words(html)).toContain("Fixed at high.");
  });
});

describe("frontier line — what THALAMUS would route to at this bias (2026-09-03)", () => {
  const pick = {
    model: "Opus 5",
    effort: "medium",
    smart: 58.6355,
    cost: 0.14876,
    frontierSize: 8,
  };

  it("renders the pick, its effort, index, €/task and the frontier size", () => {
    const html = frontierLine({ ...base, frontierPick: pick });
    expect(html).toBe(
      '<div class="routing-why-frontier">THALAMUS would route → <b>Opus 5</b> @medium' +
        " · idx 58.6 · €0.149/task (frontier of 8 rungs)</div>",
    );
  });

  it("omits the effort for a ladderless model, and renders nothing without a pick", () => {
    expect(frontierLine({ ...base, frontierPick: { ...pick, effort: "" } })).toContain(
      "<b>Opus 5</b> · idx",
    );
    expect(frontierLine(base)).toBe("");
    expect(renderRoutingRationale(base)).not.toContain("would route");
  });

  it("sits under the dial and above the three rows, and is not a fourth row", () => {
    const html = renderRoutingRationale({ ...base, biasIdx: 2, frontierPick: pick });
    expect((html.match(/routing-why-row/g) || []).length).toBe(3);
    expect(html.indexOf("orca-bias-slider")).toBeLessThan(html.indexOf("routing-why-frontier"));
    expect(html.indexOf("routing-why-frontier")).toBeLessThan(html.indexOf("routing-why-row"));
  });

  it("escapes the model label", () => {
    const html = frontierLine({ ...base, frontierPick: { ...pick, model: "<b>x" } });
    expect(html).toContain("&lt;b&gt;x");
  });
});

describe("fast↔smart dial", () => {
  it("runs fast on the left and smart on the right", () => {
    expect(BIAS_STOPS[0].short).toBe("fast");
    expect(BIAS_STOPS[BIAS_STOPS.length - 1].short).toBe("smart");
  });

  it("spends monotonically more as it moves right", () => {
    const rank = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 } as Record<string, number>;
    for (let i = 1; i < BIAS_STOPS.length; i++) {
      const prev = BIAS_STOPS[i - 1];
      const cur = BIAS_STOPS[i];
      expect(rank[cur.effort]).toBeGreaterThanOrEqual(rank[prev.effort]);
      expect(cur.panelSize).toBeGreaterThanOrEqual(prev.panelSize);
    }
  });

  it("the cheap half runs ONE worker; the smart half composes", () => {
    expect(BIAS_STOPS.filter((b) => b.quality === "fugu").every((b) => b.panelSize === 1)).toBe(
      true,
    );
    expect(BIAS_STOPS[BIAS_STOPS.length - 1].quality).toBe("ultra");
  });

  it("defaults to balanced and clamps anything out of range", () => {
    expect(biasStop(undefined)).toBe(BIAS_STOPS[BIAS_DEFAULT_IDX]);
    expect(biasStop(-5)).toBe(BIAS_STOPS[0]);
    expect(biasStop(99)).toBe(BIAS_STOPS[BIAS_STOPS.length - 1]);
    expect(biasStop(2)).toBe(BIAS_STOPS[2]);
  });

  it("renders as a sibling of the EFFORT slider, with every stop written out", () => {
    const html = renderBiasSlider({ ...base, biasIdx: 5 });
    expect(html).toContain("model-think-slider-row"); // same appearance as EFFORT
    // shares the effort slider's class (so it inherits every track/thumb rule) AND carries
    // its own hook (so the effort listener can refuse it)
    expect(html).toContain('class="model-think-slider orca-bias-slider"');
    expect(html).toContain(">BIAS<");
    expect(html).toContain('value="5"');
    expect((html.match(/model-slider-stop/g) || []).length).toBeGreaterThanOrEqual(
      BIAS_STOPS.length,
    );
    for (const b of BIAS_STOPS) expect(html).toContain(`>${b.short}<`);
  });

  it("positions every tick explicitly — absolute stops with no left all stack at zero", () => {
    const html = renderBiasSlider({ ...base, biasIdx: 3 });
    expect((html.match(/style="left:/g) || []).length).toBe(BIAS_STOPS.length);
  });

  it("marks the active stop", () => {
    const html = renderBiasSlider({ ...base, biasIdx: 0 });
    expect(html).toMatch(/class="model-slider-stop active"[^>]*>fast</);
  });

  it("sits above the three rows, directly under the ORCA title", () => {
    const html = renderRoutingRationale({ ...base, biasIdx: 3 });
    expect(html.indexOf("orca-bias-slider")).toBeLessThan(html.indexOf("routing-why-row"));
  });
});

describe("policy link", () => {
  it("opens the real md via the app's fs-link convention", () => {
    const html = policyLink(
      "/home/x/src/tinkerclaw/extensions/tinkerclaw-prefrontal/orca-policy.md",
    );
    expect(html).toContain('class="fs-link routing-why-policy"');
    expect(html).toContain(
      'data-path="/home/x/src/tinkerclaw/extensions/tinkerclaw-prefrontal/orca-policy.md"',
    );
    expect(html).toContain("why these rules?");
  });

  it("is a link, not a button — nothing to toggle", () => {
    const html = renderRoutingRationale({ ...base, policyPath: "/x/orca-policy.md" });
    expect(html).not.toContain("<button");
    expect(html).not.toContain("data-orca-policy");
  });

  it("renders nothing when the gateway has not reported a path", () => {
    expect(policyLink(undefined)).toBe("");
    expect(policyLink("")).toBe("");
  });

  it("escapes the path", () => {
    expect(policyLink('/tmp/"x".md')).toContain("&quot;x&quot;");
  });
});
