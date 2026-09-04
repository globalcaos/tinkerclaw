// tinker-ui/src/panels/smart-cost-chart-thalamus-envelope.test.ts
//
// THE ENVELOPE MUST NOT BE A SECOND HARDCODED LIST WEARING A COMPUTED COSTUME.
// That is the single property this file exists to hold. Every membership
// assertion below compares the RENDERED SVG against a live call to the SHARED
// functions — `thalamusCandidates` for reach, `frontierRungsFor` + `paretoFrontier`
// for the outline, `biasPick` for the dial — never against a literal array of ids.
// A test that spelled the expected rungs out would pass forever while the router
// moved underneath it, which is the exact failure the envelope was built to reveal.
//
// REDRAWN 2026-09-02/03 (the architect: "picked as up-left as possible, basically defining
// the top-left outline … use the graph in €/task"). The ring now marks a FRONTIER
// RUNG, not a considered model; the path is the frontier in task-cost order.
//
// Each safety claim carries its CONTROL: first a fixture where the old/naive
// answer really differs, then the assertion. An assertion with no control passes
// equally against a broken fixture.
import { describe, expect, test } from "vitest";
import { thalamusCandidates } from "../../../src/shared/thalamus-candidates.js";
import {
  biasPick,
  clampBiasIdx,
  frontierRungsFor,
  paretoFrontier,
  THALAMUS_BIAS_GAP,
  thalamusRoutesByDomain,
  type FrontierRung,
} from "../../../src/shared/thalamus-frontier.js";
import { BIAS_STOPS } from "./routing-rationale.js";
import {
  renderSmartCostChart,
  scEnvPathPoints,
  scPointsFor,
  scRungTag,
  scThalamusRelCost,
  scTokenRatio,
  scWrapFooter,
  SC_THALAMUS,
  type ScModel,
  type ScTwinInfo,
} from "./smart-cost-chart.js";

type Fixture = ScModel & ScTwinInfo;

/** Prices are the REAL REL_COST_TABLE answers for these ids (probed 2026-08-30,
 *  re-probed 2026-09-03), so the chart's x axis and the predicate's cost axis agree
 *  the way they do in the app, where both come off the same table. */
const OPUS5: Fixture = {
  id: "claude-code/claude-opus-5",
  name: "Opus 5",
  provider: "claude-code",
  index: 63,
  relCost: 0.2232,
  ctx: 200_000,
  color: "#E8702A",
};
const SONNET5: Fixture = {
  id: "claude-code/claude-sonnet-5",
  name: "Sonnet 5",
  provider: "claude-code",
  index: 55,
  relCost: 0.0893,
  ctx: 200_000,
  color: "#E8702A",
};
const HAIKU45: Fixture = {
  id: "claude-code/claude-haiku-4-5",
  name: "Haiku 4.5",
  provider: "claude-code",
  index: 40,
  relCost: 0.0446,
  ctx: 200_000,
  color: "#E8702A",
};
/** 13.93 — 41x the 0.3348 ceiling. The cost veto's clearest case. */
const COPILOT_OPUS: Fixture = {
  id: "github-copilot/claude-opus-4.7",
  name: "Opus 4.7",
  provider: "github-copilot",
  index: 58,
  relCost: 13.93,
  ctx: 200_000,
  color: "#BF09A3",
};
/** 4.0 — also over the ceiling, from a different vendor. */
const GLM53: Fixture = {
  id: "openrouter/z-ai/glm-5.3",
  name: "GLM 5.3",
  provider: "openrouter",
  index: 50,
  relCost: 4,
  ctx: 128_000,
  color: "#80EE24",
};
/** REACHABLE (same table price as Opus 5, under the ceiling) but DOMINATED on
 *  every rung: dearer per task AND dumber than an Opus 5 rung at each effort. The
 *  old envelope ringed it; the frontier must not. */
const OPUS48: Fixture = {
  id: "claude-code/claude-opus-4-8",
  name: "Opus 4.8",
  provider: "claude-code",
  index: 57,
  relCost: 0.2232,
  ctx: 200_000,
  color: "#E8702A",
};
/** Two SELLERS of one brain at one price — same ladder, same AA rows, same price,
 *  so every rung of one coincides EXACTLY with a rung of the other. The frontier
 *  keeps one of each pair (strictly increasing intelligence), which is what makes
 *  the path dedupe below a real case rather than a hypothetical. */
const SOL_OPENAI: Fixture = {
  id: "openai/gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  provider: "openai",
  index: 60,
  relCost: 0.1786,
  ctx: 400_000,
  color: "#10A37F",
};
const SOL_CODEX: Fixture = {
  ...SOL_OPENAI,
  id: "openai-codex/gpt-5.6-sol",
  provider: "openai-codex",
};
/** Two ladderless models nobody priced — one headline rung each, so a frontier of
 *  exactly two rungs exists without hand-picking efforts. */
const SOLE_A: Fixture = {
  id: "acme/alpha",
  name: "Alpha",
  provider: "acme",
  index: 50,
  relCost: 0.1,
  ctx: 200_000,
  color: "#888",
};
const SOLE_B: Fixture = { ...SOLE_A, id: "acme/beta", name: "Beta", index: 60, relCost: 0.2 };

const CATALOG: Fixture[] = [OPUS5, SONNET5, HAIKU45, COPILOT_OPUS, GLM53];

/** THE REFERENCE ANSWER for REACH — the function itself, called with exactly the
 *  arguments the renderer builds. Never a literal. */
function reference(
  models: Fixture[],
  allowed?: ReadonlySet<string>,
): ReturnType<typeof thalamusCandidates> {
  const catalog: Record<string, { intelligenceIndex?: number }> = {};
  for (const m of models) catalog[m.id] = { intelligenceIndex: m.index };
  return thalamusCandidates({
    catalog,
    snapshot: undefined,
    nowMs: 0,
    relCostFor: scThalamusRelCost,
    ...(allowed ? { allowedModelKeys: allowed } : {}),
  });
}

/** THE REFERENCE ANSWER for the OUTLINE — every rung of every considered model,
 *  priced by the shared module from the same `index`/`relCost` the chart plots. */
function rungsOf(models: Fixture[], allowed?: ReadonlySet<string>): FrontierRung[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  return reference(models, allowed).considered.flatMap((c) => {
    const m = byId.get(c.key)!;
    return frontierRungsFor(m.id, m.index, m.relCost);
  });
}
const frontierOf = (models: Fixture[], allowed?: ReadonlySet<string>) =>
  paretoFrontier(rungsOf(models, allowed));
const tags = (rs: readonly FrontierRung[]) => rs.map(scRungTag).sort();

/**
 * Parse with the HTML FRAGMENT parser, which is the one the app actually uses
 * (app.ts drops this string into innerHTML — see scSvgSafeMark). The strict
 * image/svg+xml parser rejects the chart outright over the duplicate `width` the
 * vendor logos have always carried, so it would test a document the browser
 * never builds.
 */
function parse(svg: string): Element {
  const root = new DOMParser().parseFromString(svg, "text/html").querySelector("svg");
  // A truncated chart leaves an empty root rather than throwing, and every
  // set-equality assertion below would then pass on two empty sets.
  expect(root).not.toBeNull();
  expect((root as Element).children.length).toBeGreaterThan(3);
  return root as Element;
}

/** Class selector via [class~=], because an SVG element's className is not a
 *  string and some class-selector paths are unreliable on foreign content. */
const cls = (name: string) => `[class~="${name}"]`;

/** The (model, effort) rungs that actually carry an envelope ring in the RENDERED
 *  markup, read back out of the DOM — not out of the string that produced it. */
function envelopedRungs(svg: string): string[] {
  return [...parse(svg).querySelectorAll(cls("sc-env-ring"))]
    .map((el) => {
      const pos = el.closest("[data-model]");
      return scRungTag({
        key: pos?.getAttribute("data-model") ?? "",
        effort: pos?.getAttribute("data-effort") ?? "",
      });
    })
    .sort();
}

/** Model ids with at least one ring — the reach question, model-granular. */
function envelopedIds(svg: string): string[] {
  return [...new Set(envelopedRungs(svg).map((t) => t.split("@")[0]))].sort();
}

function pickRung(svg: string): string | undefined {
  const picks = [...parse(svg).querySelectorAll(cls("sc-env-pick"))];
  expect(picks.length).toBeLessThanOrEqual(1);
  const pos = picks[0]?.closest("[data-model]");
  return pos
    ? scRungTag({
        key: pos.getAttribute("data-model") ?? "",
        effort: pos.getAttribute("data-effort") ?? "",
      })
    : undefined;
}

function pathPoints(svg: string, name: string): string[][] {
  return [...parse(svg).querySelectorAll(cls(name))].map((el) =>
    (el.getAttribute("points") ?? "").split(" ").filter((p) => p !== ""),
  );
}

/** The footer's own text ONLY, rows re-joined on the separator scWrapFooter split
 *  on — `textContent` would swallow the <title> tooltip hanging off the same element
 *  and make every not-toContain below vacuous. */
function footer(svg: string): string {
  return [...parse(svg).querySelectorAll(cls("sc-env-foot"))]
    .map((el) => el.firstChild?.nodeValue ?? "")
    .join(" · ");
}

function attrNames(el: Element): string[] {
  const out: string[] = [];
  for (let i = 0; i < el.attributes.length; i++) out.push(el.attributes[i].name);
  return out;
}

describe("thalamus envelope — membership is the FRONTIER's answer, never a list", () => {
  test("the enveloped (model, effort) rungs EQUAL paretoFrontier(frontierRungsFor(considered))", () => {
    const rungs = rungsOf(CATALOG);
    const frontier = paretoFrontier(rungs);
    // CONTROL that the fixture actually discriminates: a frontier equal to every
    // rung, or to every considered model's anchor, would make this vacuous.
    expect(frontier.length).toBeGreaterThan(1);
    expect(frontier.length).toBeLessThan(rungs.length);
    expect(reference(CATALOG).considered.length).toBeLessThan(CATALOG.length);
    expect(envelopedRungs(renderSmartCostChart(CATALOG))).toEqual(tags(frontier));
  });

  test("the frontier's rungs are the chart's own points: same €/task, same index", () => {
    // frontierRungsFor(id, index, relCost) must price a rung exactly as the dots
    // loop does (`p.cost * scTokenRatio(id, lvl)`), or a ring lands beside its dot.
    const byId = new Map(CATALOG.map((m) => [m.id, m]));
    for (const c of reference(CATALOG).considered) {
      const m = byId.get(c.key)!;
      const rungs = frontierRungsFor(m.id, m.index, m.relCost);
      const pts = scPointsFor(m);
      expect(rungs.length).toBe(pts.length);
      for (const p of pts) {
        const r = rungs.find((x) => x.effort === p.lvl);
        expect(r, `${m.id}@${p.lvl}`).toBeDefined();
        expect(r!.cost).toBeCloseTo(p.cost * scTokenRatio(m.id, p.lvl), 9);
        expect(r!.smart).toBe(p.smart);
      }
    }
  });

  test("a model priced over the ceiling loses every ring — in BOTH the function and the render", () => {
    // CONTROL: under its real price the model IS considered and does ring…
    const cheap = { ...GLM53, id: "claude-code/claude-sonnet-4-6", relCost: 0.0893 };
    const withCheap = [HAIKU45, cheap];
    expect(reference(withCheap).considered.map((c) => c.key)).toContain(cheap.id);
    expect(frontierOf(withCheap).some((r) => r.key === cheap.id)).toBe(true);
    expect(envelopedIds(renderSmartCostChart(withCheap))).toContain(cheap.id);
    // …and swapping in the id the table prices at 4.0 removes it from both.
    const withDear = [OPUS5, GLM53];
    expect(reference(withDear).considered.map((c) => c.key)).not.toContain(GLM53.id);
    expect(envelopedIds(renderSmartCostChart(withDear))).not.toContain(GLM53.id);
  });

  test("a BRAND-NEW frontier model appears in the envelope with no code change", () => {
    // The whole point of the feature: the architect must be able to see whether thalamus
    // reaches a model that did not exist when this file was written. No literal
    // list could ever contain this id.
    const brandNew: Fixture = {
      ...OPUS5,
      id: "claude-code/claude-opus-6",
      name: "Opus 6",
      index: 71,
    };
    const models = [...CATALOG, brandNew];
    const frontier = frontierOf(models);
    expect(frontier.some((r) => r.key === brandNew.id)).toBe(true);
    const rung = envelopedRungs(renderSmartCostChart(models));
    expect(rung).toEqual(tags(frontier));
    expect(envelopedIds(renderSmartCostChart(models))).toContain(brandNew.id);
  });

  test("a CONSIDERED but DOMINATED model (dearer per task AND dumber) gets NO ring", () => {
    const models = [OPUS5, OPUS48];
    // CONTROL: thalamus can REACH it — the old envelope would have ringed it.
    expect(reference(models).considered.map((c) => c.key)).toContain(OPUS48.id);
    // The function's verdict: every one of its rungs is dominated by some Opus 5 rung.
    const rungs = rungsOf(models);
    for (const r of rungs.filter((x) => x.key === OPUS48.id)) {
      expect(
        rungs.some((o) => o.key === OPUS5.id && o.cost <= r.cost && o.smart >= r.smart),
        scRungTag(r),
      ).toBe(true);
    }
    expect(frontierOf(models).some((r) => r.key === OPUS48.id)).toBe(false);
    // And the render agrees: rings on Opus 5 only.
    const svg = renderSmartCostChart(models);
    expect(envelopedIds(svg)).toEqual([OPUS5.id]);
    expect(envelopedRungs(svg)).toEqual(tags(frontierOf(models)));
  });

  test("ONE ring per FRONTIER RUNG — a model may carry several, or none", () => {
    // Opus 5 alone: five rungs, each smarter AND dearer than the last, so all five
    // are on the frontier and all five ring. CONTROL: more rings than models.
    const frontier = frontierOf([OPUS5]);
    expect(frontier.length).toBeGreaterThan(1);
    const svg = renderSmartCostChart([OPUS5]);
    expect(parse(svg).querySelectorAll(cls("sc-env-ring")).length).toBe(frontier.length);
    expect(envelopedRungs(svg)).toEqual(tags(frontier));
  });
});

describe("thalamus envelope — the BIAS dial walks the frontier", () => {
  test("the PICK ring sits on biasPick(frontier, biasIdx) at every stop, and only there", () => {
    const frontier = frontierOf(CATALOG);
    for (let b = 0; b < THALAMUS_BIAS_GAP.length; b++) {
      const svg = renderSmartCostChart(CATALOG, { biasIdx: b });
      expect(pickRung(svg), `bias ${b}`).toBe(scRungTag(biasPick(frontier, b)!));
    }
  });

  test("the pick MOVES between fast (0) and smart (6) — the ring is not pinned to a model", () => {
    const frontier = frontierOf(CATALOG);
    // CONTROL: the fixture has ≥ 2 frontier rungs, so the two stops CAN differ.
    expect(frontier.length).toBeGreaterThanOrEqual(2);
    const fast = pickRung(renderSmartCostChart(CATALOG, { biasIdx: 0 }));
    const smart = pickRung(renderSmartCostChart(CATALOG, { biasIdx: 6 }));
    expect(fast).not.toBe(smart);
    expect(smart).toBe(scRungTag(frontier[frontier.length - 1]));
  });

  test("no biasIdx ⇒ the dial's default, exactly as clampBiasIdx(undefined) says", () => {
    const frontier = frontierOf(CATALOG);
    expect(pickRung(renderSmartCostChart(CATALOG))).toBe(
      scRungTag(biasPick(frontier, clampBiasIdx(undefined))!),
    );
    expect(pickRung(renderSmartCostChart(CATALOG, { biasIdx: 99 }))).toBe(
      pickRung(renderSmartCostChart(CATALOG, { biasIdx: 6 })),
    );
  });

  test("the PICK carries the heavier ring, and only the pick — heavier, NOT bigger", () => {
    const svg = renderSmartCostChart(CATALOG);
    const picks = [...parse(svg).querySelectorAll(cls("sc-env-pick"))];
    expect(picks.length).toBe(1);
    // radius on this chart means context window only.
    const pickR = Number(picks[0].getAttribute("r"));
    const plain = [
      ...parse(svg).querySelectorAll(`${cls("sc-env-ring")}:not(${cls("sc-env-pick")})`),
    ].filter((el) => el.closest("[data-model]")?.getAttribute("data-model") === OPUS5.id)[0];
    expect(plain).toBeDefined();
    expect(Number(plain.getAttribute("r"))).toBeCloseTo(pickR, 5);
    expect(Number(picks[0].getAttribute("stroke-width"))).toBeGreaterThan(
      Number(plain.getAttribute("stroke-width")),
    );
  });
});

describe("thalamus envelope — the TASK copy is the top-left outline", () => {
  test("on the €/task copy y is STRICTLY decreasing as x increases — a dip is impossible", () => {
    const frontier = frontierOf(CATALOG);
    const [task] = pathPoints(renderSmartCostChart(CATALOG), "sc-env-task");
    // CONTROL: enough vertices for monotonicity to mean something.
    expect(task.length).toBeGreaterThanOrEqual(3);
    expect(task.length).toBeLessThanOrEqual(frontier.length);
    const pts = task.map((p) => p.split(",").map(Number));
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i][0], `x at ${i}`).toBeGreaterThanOrEqual(pts[i - 1][0]);
      expect(pts[i][1], `y at ${i}`).toBeLessThan(pts[i - 1][1]);
    }
  });

  test("the path visits the frontier rungs in FRONTIER order — never re-sorted by €/Mtok", () => {
    const frontier = frontierOf(CATALOG);
    const doc = parse(renderSmartCostChart(CATALOG));
    // y of each frontier rung's dot, read off the DOM, in frontier order
    const ys = frontier.map((r) => {
      const pos = doc.querySelector(
        `${cls("sc-dotpos")}[data-model="${r.key}"][data-effort="${r.effort}"]`,
      );
      expect(pos, scRungTag(r)).not.toBeNull();
      return Number(/translate\([^,]+, ([^)]+)\)/.exec(pos!.getAttribute("transform") ?? "")?.[1]);
    });
    const [cost] = pathPoints(renderSmartCostChart(CATALOG), "sc-env-cost");
    expect(cost.map((p) => Number(p.split(",")[1]))).toEqual(ys);
  });
});

describe("thalamus envelope — the four degenerate cases", () => {
  test("0 rungs: no ring, NO path, and the footer still speaks", () => {
    // An empty allowlist makes every model not-routable — the honest zero.
    const svg = renderSmartCostChart(CATALOG, { thalamusAllowedModelKeys: new Set<string>() });
    expect(reference(CATALOG, new Set<string>()).considered).toEqual([]);
    expect(envelopedRungs(svg)).toEqual([]);
    expect(pathPoints(svg, "sc-env-cost")).toEqual([]);
    expect(pathPoints(svg, "sc-env-task")).toEqual([]);
    // Silence must never look like a render failure.
    expect(footer(svg)).toContain("THALAMUS frontier 0 rungs (€/task) of 0 across 0/5 models");
    expect(footer(svg)).toContain("picks NOTHING");
    expect(footer(svg)).toContain("not-routable");
  });

  test("1 rung: ring only, never a one-point polyline", () => {
    // Haiku alone: four cost rungs on the headline index, so only the cheapest is
    // on the frontier. CONTROL: the chart draws more circles than the frontier has.
    const only = new Set([HAIKU45.id]);
    const frontier = frontierOf(CATALOG, only);
    expect(frontier.length).toBe(1);
    const svg = renderSmartCostChart(CATALOG, { thalamusAllowedModelKeys: only });
    expect(parse(svg).querySelectorAll(cls("sc-ring")).length).toBeGreaterThan(1);
    expect(envelopedRungs(svg)).toEqual(tags(frontier));
    expect(pathPoints(svg, "sc-env-cost")).toEqual([]);
    expect(pathPoints(svg, "sc-env-task")).toEqual([]);
  });

  test("2 rungs: exactly one segment, ascending in x", () => {
    const models = [SOLE_A, SOLE_B];
    expect(frontierOf(models).length).toBe(2);
    const svg = renderSmartCostChart(models);
    expect(envelopedRungs(svg).length).toBe(2);
    const [cost] = pathPoints(svg, "sc-env-cost");
    expect(cost.length).toBe(2);
    const xs = cost.map((p) => Number(p.split(",")[0]));
    expect(xs[0]).toBeLessThanOrEqual(xs[1]);
  });

  test("coincident rungs are collapsed by the frontier — no zero-length segment", () => {
    const models = [OPUS5, SOL_OPENAI, SOL_CODEX];
    const both = new Set([SOL_OPENAI.id, SOL_CODEX.id]);
    const rungs = rungsOf(models, both);
    // CONTROL: the two routes really do produce identical (cost, smart) rungs.
    expect(new Set(rungs.map((r) => `${r.cost}|${r.smart}`)).size).toBeLessThan(rungs.length);
    const frontier = frontierOf(models, both);
    expect(new Set(frontier.map((r) => r.key)).size).toBe(1);
    const svg = renderSmartCostChart(models, { thalamusAllowedModelKeys: both });
    expect(envelopedRungs(svg)).toEqual(tags(frontier));
    for (const name of ["sc-env-cost", "sc-env-task"]) {
      const [pts] = pathPoints(svg, name);
      expect(new Set(pts).size).toBe(pts.length);
    }
  });

  test("scEnvPathPoints drops CONSECUTIVE duplicates only", () => {
    expect(scEnvPathPoints([])).toEqual([]);
    expect(scEnvPathPoints([{ x: 1, y: 2 }])).toEqual([]);
    expect(
      scEnvPathPoints([
        { x: 1, y: 2 },
        { x: 1, y: 2 },
      ]),
    ).toEqual([]);
    expect(
      scEnvPathPoints([
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ]),
    ).toEqual(["1,2", "3,4"]);
    // rounding happens BEFORE the comparison — two points that print the same
    // must not become a zero-length segment.
    expect(
      scEnvPathPoints([
        { x: 1.001, y: 2 },
        { x: 1.002, y: 2 },
      ]),
    ).toEqual([]);
    // a NON-adjacent repeat is a genuine revisit and is kept.
    expect(
      scEnvPathPoints([
        { x: 1, y: 2 },
        { x: 3, y: 4 },
        { x: 1, y: 2 },
      ]),
    ).toEqual(["1,2", "3,4", "1,2"]);
  });
});

describe("thalamus envelope — the mechanics that fail silently", () => {
  test("DOUBLE EMIT: a cost copy and a task copy, task offset by the glide dx", () => {
    const svg = renderSmartCostChart(CATALOG);
    const cost = pathPoints(svg, "sc-env-cost");
    const task = pathPoints(svg, "sc-env-task");
    expect(cost.length).toBe(1);
    expect(task.length).toBe(1);
    expect(task[0].length).toBe(cost[0].length);
    // CONTROL: the two copies must not be identical, or the task copy is not
    // actually following the dots to their per-task positions.
    expect(task[0].join(" ")).not.toBe(cost[0].join(" "));
    // ys are untouched by the glide
    expect(task[0].map((p) => p.split(",")[1])).toEqual(cost[0].map((p) => p.split(",")[1]));
  });

  test("the crossfade rules are emitted, so the task copy is not invisible forever", () => {
    const svg = renderSmartCostChart(CATALOG);
    const css = parse(svg).querySelector("style")?.textContent ?? "";
    expect(css).toContain(".sc-svg.sc-taskmode .sc-env-cost{stroke-opacity:0}");
    expect(css).toContain(".sc-svg.sc-taskmode .sc-env-task{stroke-opacity:0.5}");
    // the resting inline value the rule has to override
    const task = parse(svg).querySelector(cls("sc-env-task"));
    expect(task?.getAttribute("stroke-opacity")).toBe("0");
    const cost = parse(svg).querySelector(cls("sc-env-cost"));
    expect(cost?.getAttribute("stroke-opacity")).toBe("0.5");
  });

  test("every .sc-dotpos carries data-effort, so a rung is addressable as (model, effort)", () => {
    const doc = parse(renderSmartCostChart(CATALOG));
    const dots = [...doc.querySelectorAll(cls("sc-dotpos"))];
    expect(dots.length).toBeGreaterThan(0);
    for (const d of dots) expect(d.hasAttribute("data-effort")).toBe(true);
    expect(
      doc.querySelector(`${cls("sc-dotpos")}[data-model="${OPUS5.id}"][data-effort="max"]`),
    ).not.toBeNull();
  });

  test("the ring lives INSIDE .sc-dotg, so it counter-scales with its dot", () => {
    const ring = parse(renderSmartCostChart(CATALOG)).querySelector(cls("sc-env-ring"));
    expect(ring?.parentElement?.getAttribute("class")).toBe("sc-dotg");
  });

  test("the ring paints UNDER the model's own ring, on every frontier rung", () => {
    const rings = [...parse(renderSmartCostChart([OPUS5])).querySelectorAll(cls("sc-env-ring"))];
    expect(rings.length).toBe(frontierOf([OPUS5]).length);
    for (const ring of rings) {
      const kids = [...(ring.parentElement?.children ?? [])].map(
        (el) => el.getAttribute("class") ?? "",
      );
      expect(kids[0].startsWith("sc-env-ring")).toBe(true);
      expect(kids.indexOf("sc-ring")).toBeGreaterThan(0);
    }
  });

  test("LAYER ORDER: the envelope path is under the constellations and the dots", () => {
    const svg = renderSmartCostChart(CATALOG);
    expect(svg.indexOf('class="sc-twinlayer"')).toBeLessThan(svg.indexOf('class="sc-envlayer"'));
    expect(svg.indexOf('class="sc-envlayer"')).toBeLessThan(svg.indexOf('class="sc-dotlayer"'));
  });

  test("DIMMING: no data-* on the envelope path or footer, so a vendor latch leaves them lit", () => {
    const doc = parse(renderSmartCostChart(CATALOG));
    for (const name of ["sc-env-cost", "sc-env-task", "sc-env-foot"]) {
      const els = [...doc.querySelectorAll(cls(name))];
      expect(els.length).toBeGreaterThan(0);
      for (const el of els) expect(attrNames(el).filter((a) => a.startsWith("data-"))).toEqual([]);
    }
  });

  test("every envelope mark is painted in SC_THALAMUS, no vendor's hue", () => {
    const doc = parse(renderSmartCostChart(CATALOG));
    const marks = doc.querySelectorAll(
      `${cls("sc-env-ring")},${cls("sc-env-cost")},${cls("sc-env-task")}`,
    );
    expect(marks.length).toBeGreaterThan(0);
    for (const el of marks) expect(el.getAttribute("stroke")).toBe(SC_THALAMUS);
    expect(doc.querySelector(cls("sc-env-foot"))?.getAttribute("fill")).toBe(SC_THALAMUS);
  });
});

describe("thalamus envelope — the footer reports the payload, never a literal", () => {
  test("rung counts, model counts, bias, pick and costVerified all come off the result", () => {
    const env = reference(CATALOG);
    const rungs = rungsOf(CATALOG);
    const frontier = paretoFrontier(rungs);
    const b = 3;
    const pick = biasPick(frontier, b)!;
    const line = footer(renderSmartCostChart(CATALOG, { biasIdx: b }));
    expect(line).toContain(
      `THALAMUS frontier ${frontier.length} rungs (€/task) of ${rungs.length} across ${env.considered.length}/${env.catalogSize} models`,
    );
    expect(line).toContain(`bias ${b} (${BIAS_STOPS[b].label})`);
    expect(line).toContain(
      `pick ${scRungTag(pick)} idx ${pick.smart.toFixed(1)} €${Number(pick.cost.toPrecision(3))}/task`,
    );
    expect(line).toContain(env.costVerified ? "cost verified" : "cost UNVERIFIED");
    expect(line).toContain(`${env.excluded.length} cost-veto`);
    // CONTROL: the numbers move with the data rather than being printed constants.
    const smaller = footer(renderSmartCostChart([OPUS5, GLM53]));
    expect(smaller).toContain("across 1/2 models");
    expect(smaller).not.toContain(`across ${env.considered.length}/${env.catalogSize} models`);
  });

  test("the bias label and the pick follow the dial", () => {
    const frontier = frontierOf(CATALOG);
    const fast = footer(renderSmartCostChart(CATALOG, { biasIdx: 0 }));
    expect(fast).toContain(`bias 0 (${BIAS_STOPS[0].label})`);
    expect(fast).toContain(`pick ${scRungTag(biasPick(frontier, 0)!)}`);
    const smart = footer(renderSmartCostChart(CATALOG, { biasIdx: 6 }));
    expect(smart).toContain(`bias 6 (${BIAS_STOPS[6].label})`);
    expect(smart).toContain(`pick ${scRungTag(biasPick(frontier, 6)!)}`);
  });

  test("domain routes list exactly the domains thalamusRoute would switch, else say so", () => {
    const rungs = rungsOf(CATALOG);
    for (const b of [0, 3, 6]) {
      const line = footer(renderSmartCostChart(CATALOG, { biasIdx: b }));
      const switched = Object.entries(thalamusRoutesByDomain(rungs, b)).filter(
        ([d, r]) => d !== "general" && r && scRungTag(r.rung) !== scRungTag(r.biasRung),
      );
      if (switched.length === 0) {
        expect(line, `bias ${b}`).toContain("no domain switches at this bias");
        expect(line).not.toContain("domain routes:");
      } else {
        expect(line, `bias ${b}`).toContain("domain routes:");
        expect(line).not.toContain("no domain switches");
        for (const [d, r] of switched) {
          const model = r!.rung.key.split("/").pop();
          expect(line).toContain(`${d}→${model}${r!.rung.effort ? `@${r!.rung.effort}` : ""}`);
        }
      }
    }
  });

  test("the caveats name the checks that did NOT run, and disappear when they do", () => {
    expect(footer(renderSmartCostChart(CATALOG))).toContain(
      "upper bound: no quota snapshot, no auth filter",
    );
    const filtered = footer(
      renderSmartCostChart(CATALOG, { thalamusAllowedModelKeys: new Set([OPUS5.id]) }),
    );
    expect(filtered).toContain("upper bound: no quota snapshot");
    expect(filtered).not.toContain("no auth filter");
  });

  test("scWrapFooter splits only on separators and round-trips", () => {
    const line = ["a", "bb", "ccc", "dddd"].join(" · ");
    expect(scWrapFooter(line, 8)).toEqual(["a · bb", "ccc", "dddd"]);
    expect(scWrapFooter(line, 8).join(" · ")).toBe(line);
    expect(scWrapFooter(line, 1000)).toEqual([line]);
    expect(scWrapFooter("")).toEqual([]);
  });

  test("an UNPRICED model is reported UNVERIFIED, never quietly cost-vetoed", () => {
    // The trap `scThalamusRelCost` exists to avoid: rel-cost-table's own
    // `relCostFor` would invent 2.58 here and veto this model out of the envelope
    // for a price nobody published.
    const unpriced: Fixture = {
      ...OPUS5,
      id: "acme/brand-new-thing-9",
      name: "Brand New",
      provider: "acme",
      index: 66,
    };
    expect(scThalamusRelCost(unpriced.id)).toBeUndefined();
    const models = [OPUS5, unpriced];
    expect(reference(models).considered.map((c) => c.key)).toContain(unpriced.id);
    // Its rung is priced from the chart's own relCost, and — smarter than every Opus
    // 5 rung at a task cost under Opus 5 @high — it is ON the frontier.
    const frontier = frontierOf(models);
    expect(frontier.some((r) => r.key === unpriced.id)).toBe(true);
    const svg = renderSmartCostChart(models);
    expect(envelopedRungs(svg)).toEqual(tags(frontier));
    expect(footer(svg)).toContain("cost UNVERIFIED");
  });
});
