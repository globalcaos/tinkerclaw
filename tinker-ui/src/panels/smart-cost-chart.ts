// tinker-ui/src/panels/smart-cost-chart.ts
// FORK 2026-08-06 (the architect): SMARTNESS × COST constellation chart — Artificial
// Analysis style (log cost × linear quality), one CONSTELLATION per model: a
// circle per thinking-effort level, connected. Circle area ∝ context window;
// colour = the model's EEG trace colour (resolveEegPaint), so the chart agrees
// with the seismograph, the glows and the MODELS panel.
//
// FORK 2026-08-06 #2 (the architect): PER-TASK mode. Research into average tokens per
// task (OckBench, arXiv:2511.05722 — the only public benchmark that measures
// output tokens PER TASK across models AND effort levels — plus family anchors:
// Anthropic's "Opus 5 = 26% fewer tokens than Opus 4.8 at max", DeepSeek-V4-Pro
// ≈3.6× Kimi K3, the Overthinking Tax on small models) feeds a second position
// per dot: cost-per-task = cost-per-Mtok × tokens-per-task, normalized so the
// REFERENCE — Claude Opus 5 at its top REAL effort, `high` — does not move.
// (It read "MAX effort" until 2026-08-25, a setting Anthropic does not expose
// for that model class.) Dots are outline
// circles carrying the model's logo; a toggle animates them (CSS transform,
// slow, staggered, reversible) to the per-task position, with faint ghost
// outlines marking where each one lands.
//
// PURE module — no DOM access, state in (ScModel[]) → SVG string out, same
// contract as eeg-trace.ts. app.ts owns the overlay + the toggle wiring.
//
// HONESTY (bible §5.8h invariant 3): X = effective €/Mtok (the EEG number);
// Y = AA index; effort COST mults = EEG_EFFORT_MULT (documented).
//
// FORK 2026-08-27 (the architect: "you flattened the graphs"). AA DOES publish per-effort
// Intelligence Index rows — Opus 5 low 52.46 / medium 58.64 / high 61.48 /
// xhigh 62.52 / max 63.05, live scrape 2026-08-27. The 2026-08-25 flattening was
// the right answer to an invented 0.9…1.12 curve, and the wrong answer once a
// real table existed. A stop is plotted when the vendor documents that effort; its
// Y is AA's number when AA published one (solid), an ESTIMATE from other public
// per-effort benchmark runs fitted to AA's scale when not (dotted, ±1σ, since
// 2026-09-02 — see aa-effort-estimate.ts), and the headline index on a dashed rail
// when neither exists. The rule the architect wrote on 2026-08-27 — "If you did not find
// the intelligence index of a particular model-effort level do not approximate" —
// forbade an INVENTED number; on 2026-09-02 he asked for the derived kind ("find
// other benchmarks … even if you have to approximate"), on condition it is never
// mistakable for a measurement.
//
// TOKENS-PER-TASK: Opus 5 and Kimi K3 are benchmark-anchored (OckBench,
// arXiv:2511.05722); everything else is a labelled estimate from family
// anchors. The footer says so in the UI; the table below says so per row.

import { resolveProviderEffortLadder } from "../../../src/shared/provider-effort-ladders.js";
import type { EffortLadderKind } from "../../../src/shared/provider-effort-ladders.js";
import { REL_COST_TABLE, relCostKey } from "../../../src/shared/rel-cost-table.js";
import {
  COST_CEILING_MULTIPLIER,
  thalamusCandidates,
} from "../../../src/shared/thalamus-candidates.js";
import {
  biasPick,
  biasTarget,
  clampBiasIdx,
  frontierRungsFor,
  paretoFrontier,
  thalamusRoutesByDomain,
  type FrontierRung,
} from "../../../src/shared/thalamus-frontier.js";
import { aaEstimateAt, aaScoreAt } from "./aa-effort-index.js";
import { EEG_EFFORT_MULT } from "./eeg-trace.js";
import { getRoutedLogoSvg } from "./provider-logos.js";
import { BIAS_STOPS } from "./routing-rationale.js";

export interface ScModel {
  /** Full model ref ("openrouter/qwen/qwen3.8-max"). */
  id: string;
  /** Short display name ("Qwen 3.8 Max"). */
  name: string;
  provider: string;
  /** AA Intelligence Index at standard effort (panel sort key). */
  index: number;
  /** Effective €/Mtok output at medium effort (eegRelCost). */
  relCost: number;
  /** Context window in tokens. */
  ctx: number;
  /** Trace colour — rainbow already resolved to a solid by the caller. */
  color: string;
  /** Legend/highlight grouping key. The chart only ECHOES this into data-vendor
   *  so app.ts can dim by provider; app.ts resolves it with the SAME rule the
   *  dot colour uses (vendorOfModel(provider+" "+id) ?? provider), because
   *  `provider` alone puts Kimi, GLM, Qwen and DeepSeek — four different colours
   *  on the chart — under one grey "openrouter" bucket. Defaults to provider. */
  vendorKey?: string;
  /** Render a text label at the max-effort point. Defaults to ON — every
   *  plotted model gets its name (the architect 2026-08-06 #11: "there are a lot of
   *  model names missing"). Set false to leave one tooltip-only. */
  labeled?: boolean;
}

// ─── Multi-vendor TWINS (the architect 2026-08-24) ───
// REVERSES the 2026-08-06 #10 fold. That rule dropped every Copilot re-sell and
// left a pink "(copilot)" note on the vendor's dot, on the theory that the two
// were "the same brain at the same index" and so the same POINT. Half of that is
// true and the half that is false is the expensive half: same brain, same index —
// but NOT the same price. Copilot bills its own published rate, so folding it
// into the vendor's dot silently showed the CHEAPER of two routes and answered
// "what does this model cost?" with a number the architect cannot actually pay on that
// route. Measured over the live catalog: 16 of 19 twin groups differ, by up to
// 94x (claude-sonnet-4.6 — 0.0893 on our Anthropic plan, 8.36 through Copilot).
//
// So every route now keeps its OWN dot at its OWN price, and the routes to one
// brain are tied together by a dashed connector. What was one dot with a
// footnote is now a measured horizontal gap you can read as money.
//
// WHY THE GAP IS NOT A MARKUP (eeg-trace.ts:267-274, verified 2026-08-15):
// GitHub charges its models' own vendor list prices — 13 of 14 price triples
// identical. Copilot rows sit far right because OUR baseline is a far deeper
// discount (Anthropic Max 20x returns ~30x its fee in list value, Copilot Pro+
// ~1.79x). The chart footer says this out loud; the connector must never be
// read as "GitHub overcharges".
export const SC_COPILOT_PROVIDERS = new Set(["github-copilot", "copilot", "copilot-proxy"]);
/** Pink, per the architect — the one non-identity colour on the chart. Now marks the
 *  Copilot ROUTE TAG on Copilot's own label, not a note on the vendor's. */
export const SC_COPILOT_PINK = "#ff7ac6";

// ─── THALAMUS ENVELOPE (the architect 2026-08-30; REDRAWN 2026-09-02/03) ───
// "take a distinct color and mark an envelope on the models thalamus is going to
//  use (envelope means bigger circle plus lines connecting them), this will
//  indicate me, upon a new best frontier model appearing, whether or not thalamus
//  is taking it into consideration or not."
//
// FORK 2026-09-02 (the architect): "the yellow envelope … is a complete disaster. They are
// supposed to be picked as up-left as possible, basically defining the top-left
// outline" — and "make sure to use the graph in €/task to make the envelope, not
// the €/token". Until then the path ran through the ANCHOR stop of EVERY model in
// `thalamusCandidates(...).considered`, x ascending. That is the ladder's EXTENT —
// everything under the cost ceiling — and it zig-zagged by construction, because a
// membership set is not a frontier.
//
// WHAT IS DRAWN NOW, in the order src/shared/thalamus-frontier.ts computes it —
// the SAME module the reply-path router calls, so the line and the routing cannot
// disagree:
//   RUNGS    — every (model, effort) of every CONSIDERED model, priced in €/TASK
//              (`frontierRungsFor`: relCost x EFFORT_COST_MULT x tokenRatioFor — the
//              identical number the task axis plots as `p.cost * scTokenRatio`).
//   FRONTIER — `paretoFrontier`: cost non-decreasing, intelligence STRICTLY
//              increasing. The top-left outline. Nothing else.
//   RING     — a larger ring on every FRONTIER RUNG (one model may carry several).
//   PATH     — an OPEN polyline through the frontier rungs in frontier order.
//              Deliberately NOT a hull: an enclosed region would imply that a point
//              inside it is reachable, and membership here is a SET, not an area.
//   PICK     — a heavier ring on `biasPick(frontier, biasIdx)`: the cheapest
//              frontier rung within THALAMUS_BIAS_GAP[bias] AA points of the best,
//              so the BIAS dial (0 fast … 6 smart) walks the outline.
//
// THE SET IS IMPORTED, NEVER LISTED. `thalamusCandidates` says which models can be
// REACHED (quota predicate + ceiling); `thalamus-frontier` says which rungs are
// worth reaching. A literal array here with a comment claiming it matches the
// router is the PRECISE failure this feature exists to detect: the comment keeps
// reading true forever while the ladder moves underneath it.
//
// WHAT THE PATH'S SHAPE CAN AND CANNOT TELL YOU. The envelope is DEFINED on the
// €/task axis, so on the TASK copy a dip (a vertex dearer AND dumber than its left
// neighbour) is IMPOSSIBLE by construction — the frontier is strictly increasing in
// intelligence as task cost rises. The COST copy joins the SAME rungs at their €/Mtok
// positions and MAY zig-zag: a verbose model sits left per token and right per task,
// so the €/Mtok view only shows where the chosen rungs happen to sit per token. Read
// a backtrack there as "cheaper per token, dearer per task", never as a router smell.

/** The THALAMUS ENVELOPE mark — the one colour on this chart that belongs to a
 *  DECISION rather than to a vendor, which is exactly why it may not be any
 *  vendor's hue.
 *
 *  DERIVED, NOT CHOSEN. The repo's own OKLab farthest-point sampler
 *  (tinker-ui/scripts/pick-trace-colors.mjs — same math, same seed 20260804, same
 *  200,000 samples, same L 0.55–0.85 / chroma 0.10–0.24 register gates), run
 *  against the union of everything already on this paper: all 11
 *  EEG_PROVIDER_COLORS (eeg-trace.ts:82-101), the #f0e6d8 relationship cream,
 *  SC_COPILOT_PINK, and the three sc-bg backdrop stops (#221b13 / #191410 /
 *  #120e0b) — 16 occupied points. Winner h=84, L=0.823, chroma 0.168,
 *  SEPARATION 0.181, nearest neighbours the cream (0.181) and glm (0.189), both
 *  clear of the sampler's own 0.15 collision flag. Recorded here the way
 *  eeg-trace.ts:85-96 records h=337 / separation 0.255, so the next editor re-runs
 *  the sampler instead of re-arguing the hue.
 *
 *  TO REPRODUCE: the committed script carries the EEG paper's OWN occupied set
 *  (8 points, #2a2318 background) and four hue-windowed slots, so running it
 *  UNCHANGED does not return this hex — swap its TAKEN map for the 16 points above
 *  and drop the hue window (this mark answers to no brand, so it is not windowed).
 *  The PRNG is seeded, so the answer is reproducible rather than a lottery: same
 *  seed, same occupied set, same hex, every run.
 *
 *  0.181 is BELOW the 0.255 the Copilot pink got, and that is not a regression:
 *  that run faced 8 occupied points, this one faces 16. It is the most separable
 *  point the space still offers — and 14 of the 16 incumbents sit CLOSER to their
 *  own nearest neighbour than this does (11 of the 13 that are not backdrop stops:
 *  anthropic/mistral 0.056, deepseek/meta 0.066, cream/xai 0.142). Only glm (0.189)
 *  and github-copilot (0.209) are better separated than the new mark.
 *
 *  A SIBLING UNIT IMPORTS THIS NAME. Do not rename it. */
export const SC_THALAMUS = "#F7BA08";

/** Resting stroke-opacity of the envelope polyline. ONE constant, because the
 *  €/task copy's value also lives in a CSS rule this same file emits (the <style>
 *  block in renderSmartCostChart) — two literals would let the line change
 *  brightness on a toggle that is meant to change nothing but position. */
export const SC_ENV_PATH_OPACITY = 0.5;

/** Air between a model's own ring and the envelope ring outside it. Kept UNDER the
 *  label's `scRadius(ctx) + 5` gap (see labelCands) so the envelope mark can never
 *  land beneath a model name. An OFFSET, never a scaling: scRadius's invariant —
 *  "never scale this at a call site", because size means context window and nothing
 *  else — is about `.sc-ring`. This is a different element whose size means only
 *  "a ring sits outside the dot", and it is the same offset for every model. */
export const SC_ENV_RING_GAP = 4;

/** The predicate's own parameter object, read off its signature, so this browser
 *  file never has to import a gateway type (`UsageSnapshot` lives in src/infra). */
type ScThalamusParams = Parameters<typeof thalamusCandidates>[0];
/** Likewise for the payload — no second import, and it cannot drift from the fn. */
type ScThalamusResult = ReturnType<typeof thalamusCandidates>;

/**
 * `relCostFor` for the thalamus predicate, WITH THE FALLBACK REMOVED.
 *
 * rel-cost-table's exported `relCostFor` CANNOT MISS — it returns DEFAULT_REL_COST
 * (2.58) for anything no row claims (rel-cost-table.ts:384-390), and
 * `ThalamusCandidatesParams.relCostFor` bans passing that through by name. Measured
 * against the live ceiling of 0.3348, an invented 2.58 would COST-VETO a brand-new
 * frontier model straight out of the envelope for a price nobody published —
 * precisely the blindness this envelope exists to remove. A miss must stay a miss
 * so `costVerified` reports the hole instead of hiding it.
 *
 * It RE-WALKS the table rather than comparing the answer against DEFAULT_REL_COST,
 * because a row priced at exactly 2.58 would then be discarded as a miss. No row is
 * 2.58 today; that is not a property worth depending on. ORDER IS LOAD-BEARING —
 * first match wins, exactly as the table's own lookup does (rel-cost-table.ts:17-32).
 * No row carries /g, so `.test` here is stateless.
 */
export function scThalamusRelCost(key: string): number | undefined {
  const k = relCostKey(key);
  for (const row of REL_COST_TABLE) {
    if (row.modelMatch.test(k)) return row.relCost;
  }
  return undefined;
}

/** The chart's emit precision, at module scope so the path dedupe below rounds on
 *  exactly the coordinates that reach the markup. Identical to the renderer's local
 *  `fx`; deduping on unrounded values would keep two vertices that print the same. */
const scFx2 = (n: number): number => Number(n.toFixed(2));

/**
 * The polyline's vertices, or [] when there is no honest line to draw.
 *
 * Takes points ALREADY IN TRAVERSAL ORDER and drops CONSECUTIVE rounded duplicates,
 * then requires at least two. That covers three of the four degenerate cases at
 * once: 0 members and 1 member both yield [] (a one-point polyline draws nothing
 * but claims a ladder), and two members that round to the same pixel collapse to
 * one, so no zero-length segment can assert a difference the data does not contain
 * — the same rule `twinSpread: false` already enforces for the twin connectors.
 *
 * CONSECUTIVE, not global: a repeat that is NOT adjacent is a genuine revisit of a
 * position, and deleting it would re-route the path around a vertex it really
 * passes through. (The emitter also leaves stroke-linecap at its `butt` default, so
 * a zero-length segment that ever did slip past this draws nothing rather than a
 * dot.)
 */
export function scEnvPathPoints(pts: readonly { x: number; y: number }[]): string[] {
  const out: string[] = [];
  for (const p of pts) {
    const key = `${scFx2(p.x)},${scFx2(p.y)}`;
    if (out.length > 0 && out[out.length - 1] === key) continue;
    out.push(key);
  }
  return out.length < 2 ? [] : out;
}

/** One copy of the envelope path, or "" when there are fewer than two vertices. */
function scEnvPolylineSvg(cls: string, pts: readonly string[], strokeOpacity: number): string {
  if (pts.length === 0) return "";
  return (
    `<polyline class="${cls}" points="${pts.join(" ")}" fill="none" stroke="${SC_THALAMUS}"` +
    ` stroke-opacity="${strokeOpacity}" stroke-width="1.4" stroke-linejoin="round"` +
    ` vector-effect="non-scaling-stroke"/>`
  );
}

/** The frontier the renderer computed, handed to the footer so every figure there is
 *  read off the same objects the rings and the path were drawn from. */
export interface ScThalamusFrontier {
  /** Every rung of every considered model, in €/task (frontierRungsFor). */
  rungs: readonly FrontierRung[];
  /** paretoFrontier(rungs) — cost ascending, intelligence strictly increasing. */
  frontier: readonly FrontierRung[];
  /** Already clamped (clampBiasIdx). */
  biasIdx: number;
}

/** `key@effort`, or the bare key for a ladderless rung — the address the rings,
 *  the tests and the footer all use, so one string names one circle. */
export function scRungTag(r: { key: string; effort: string }): string {
  return r.effort ? `${r.key}@${r.effort}` : r.key;
}

/** The same address with the vendor prefix dropped, for the domain-route clause
 *  only — eight of those on one footer row would not fit at full length. */
function scShortRungTag(r: { key: string; effort: string }): string {
  const model = r.key.split("/").pop() ?? r.key;
  return r.effort ? `${model}@${r.effort}` : model;
}

/**
 * The one line that stops SILENCE from reading as a render failure.
 *
 * An empty envelope is a legitimate answer and is indistinguishable on screen from
 * a broken layer; a NON-empty one still has to say what was drawn, what the dial
 * chose and whether the veto could actually be applied. So every figure is read off
 * the payload and the frontier — never a literal. (The 2026-08-30 brief predicted
 * "considers 0 of 39"; the measured answer was 14, because cost comes from
 * REL_COST_TABLE, not config. A hardcoded count would have been the second stale
 * list this feature exists to detect.)
 *
 * REWRITTEN 2026-09-03 for the frontier: the ceiling clause is gone — the frontier
 * already encodes it (a vetoed model has no rungs) — and in its place the line says
 * how many rungs survived, where the BIAS dial put the floor, which rung it picked
 * and, per task domain, where `thalamusRoute` would switch away from that pick
 * (the Fugu step — only domains that actually differ are listed).
 *
 * `caveats` names the checks that did NOT run, and shrinks to nothing on its own
 * when a later unit wires a snapshot and an allowed-key set — an honesty note that
 * cannot go stale, rather than prose that can.
 */
export function scThalamusFooterLine(
  env: ScThalamusResult,
  fr: ScThalamusFrontier,
  caveats: readonly string[],
): string {
  const reasons = new Map<string, number>();
  for (const e of env.excluded) reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + 1);
  const biasIdx = clampBiasIdx(fr.biasIdx);
  const pick = biasPick(fr.frontier, biasIdx);
  let choice: string;
  if (pick === undefined) {
    choice = " → picks NOTHING";
  } else {
    const routes = thalamusRoutesByDomain(fr.rungs, biasIdx);
    const switched: string[] = [];
    for (const [domain, route] of Object.entries(routes)) {
      if (domain === "general" || !route) continue;
      if (scRungTag(route.rung) === scRungTag(route.biasRung)) continue;
      switched.push(`${domain}→${scShortRungTag(route.rung)}`);
    }
    choice =
      ` floor idx ${biasTarget(fr.frontier, biasIdx).toFixed(1)}` +
      ` → pick ${scRungTag(pick)} idx ${pick.smart.toFixed(1)}` +
      ` €${Number(pick.cost.toPrecision(3))}/task` +
      ` · ${switched.length ? `domain routes: ${switched.join(", ")}` : "no domain switches at this bias"}`;
  }
  return (
    `THALAMUS frontier ${fr.frontier.length} rungs (€/task) of ${fr.rungs.length}` +
    ` across ${env.considered.length}/${env.catalogSize} models` +
    ` · bias ${biasIdx} (${BIAS_STOPS[biasIdx].label})${choice}` +
    ` · cost ${env.costVerified ? "verified" : "UNVERIFIED"}` +
    ` · out ${reasons.size === 0 ? "0" : [...reasons].map(([r, n]) => `${n} ${r}`).join(", ")}` +
    (caveats.length === 0 ? "" : ` · upper bound: ${caveats.join(", ")}`)
  );
}

/** Characters per footer row. 836 plot units (W − ML) at font-size 7 monospace
 *  (~4.2 units per glyph) is ~199; 190 leaves the last glyph inside the frame. */
export const SC_FOOTER_ROW_CHARS = 190;
/** Row pitch in plot units for the 7px footer font. */
const SC_FOOTER_ROW_H = 9;

/**
 * Wrap the footer on its own " · " separators, greedily, so a clause is never cut
 * mid-word and joining the rows back with " · " reproduces the exact line. Rows are
 * stacked UPWARD from the bottom edge (see the emitter): the axis caption sits at
 * H − 24, so two rows (H − 7, H − 16) are free space and a third would touch it —
 * that is the bound the short domain tags exist to stay under.
 */
export function scWrapFooter(line: string, maxChars = SC_FOOTER_ROW_CHARS): string[] {
  const rows: string[] = [];
  let cur = "";
  for (const part of line.split(" · ")) {
    if (cur !== "" && cur.length + 3 + part.length > maxChars) {
      rows.push(cur);
      cur = part;
    } else {
      cur = cur === "" ? part : `${cur} · ${part}`;
    }
  }
  if (cur !== "") rows.push(cur);
  return rows;
}

/** The hover explanation behind the footer line — the part that does not fit on
 *  one row of an 900-unit viewBox, and the part a reader needs exactly once. */
export const SC_THALAMUS_FOOTER_TITLE =
  "The envelope is the Pareto frontier, on the €/task axis, of the effort rungs of the models" +
  " src/shared/thalamus-candidates.ts can reach, computed by src/shared/thalamus-frontier.ts —" +
  " the same module the reply-path router calls, never a list in this file. A rung is on the" +
  " frontier when no other rung is both cheaper-or-equal per task AND smarter-or-equal; the" +
  " BIAS dial picks the cheapest frontier rung within its gap of the best. A model with NO ring" +
  " is either unreachable (no AA index, dearer than" +
  ` ${COST_CEILING_MULTIPLIER}x the anchor's effective cost, or its provider's token window is` +
  " spent) or reachable but dominated on every rung. 'cost UNVERIFIED' means at least one" +
  " reachable model carried no published price, so the veto could prove it neither cheap nor" +
  " expensive.";

/** Vendor-neutral identity for a model ref: the last path segment, with the
 *  punctuation that differs between routes removed — "claude-code/claude-opus-4-7"
 *  and "github-copilot/claude-opus-4.7" are the same model. */
export function scModelKey(id: string): string {
  return (id.split("/").pop() ?? id).toLowerCase().replace(/[.\-_\s]/g, "");
}

export function scIsCopilot(m: { id: string; provider: string }): boolean {
  return SC_COPILOT_PROVIDERS.has(m.provider) || SC_COPILOT_PROVIDERS.has(m.id.split("/")[0]);
}

/** Short route tag for a twin's label — which vendor sells THIS dot. Only ever
 *  printed for models that actually have a twin; a single-route model is just
 *  its name. */
export function scRouteTag(m: { id: string; provider: string }): string {
  if (scIsCopilot(m)) return "copilot";
  const p = m.provider || m.id.split("/")[0] || "";
  // "openrouter/z-ai/glm-5.2" — the middle segment is the real seller.
  const seg = m.id.split("/");
  if (p === "openrouter" && seg.length >= 3) return `openrouter·${seg[1]}`;
  return p;
}

/** Twin metadata attached to a model that shares its brain with another route. */
export interface ScTwinInfo {
  /** scModelKey shared by every route to this brain. Absent when single-route. */
  twinKey?: string;
  /** How many routes reach it (>= 2 when set). */
  twinN?: number;
  /** TRUE when the routes actually differ in price. FALSE means every route
   *  costs the same, so the dots land on top of each other and NO connector is
   *  drawn — a 0px dash would imply a price difference that does not exist. */
  twinSpread?: boolean;
}

/**
 * Group every plotted model by vendor-neutral identity. PURE: nothing is
 * dropped, nothing is re-priced — each route keeps its own relCost and its own
 * dot. The group is metadata the renderer uses for the dashed connectors and
 * that app.ts uses to light up twins on hover.
 *
 * The zero-spread case is deliberate and load-bearing. gpt-5.6-sol is reachable
 * via openai, openai-codex and codex at the IDENTICAL 0.2679, so its three dots
 * coincide exactly; drawing a "connector" there would be a 0px dash asserting a
 * difference that is not in the data. Those groups are marked twinSpread:false
 * and the renderer draws no line — the label's route tags still say all three
 * routes exist.
 */
export function scAssignTwins<T extends ScModel>(models: T[]): (T & ScTwinInfo)[] {
  const byKey = new Map<string, T[]>();
  for (const m of models) {
    const k = scModelKey(m.id);
    const g = byKey.get(k);
    if (g) g.push(m);
    else byKey.set(k, [m]);
  }
  return models.map((m) => {
    const group = byKey.get(scModelKey(m.id))!;
    if (group.length < 2) return m;
    return {
      ...m,
      twinKey: scModelKey(m.id),
      twinN: group.length,
      twinSpread: new Set(group.map((x) => x.relCost)).size > 1,
    };
  });
}

/**
 * Copilot is not in models.providers, so catalog Copilot rows used to take
 * scDefaultCtx (Claude = 200k) while the native twin sat at its configured
 * window (Opus 5 / Sonnet 4.6 = 1M). Bubble area ∝ context, so Copilot looked
 * like a smaller brain. GitHub does not publish a smaller Claude window — it
 * lists the same models, with long-context *price tiers* on GPT/Gemini/Grok,
 * not a truncated cap. Inherit the largest native-twin ctx onto Copilot.
 * Price is untouched.
 */
export function scSyncTwinContext<T extends ScModel>(models: T[]): T[] {
  const byKey = new Map<string, T[]>();
  for (const m of models) {
    const k = scModelKey(m.id);
    const g = byKey.get(k);
    if (g) g.push(m);
    else byKey.set(k, [m]);
  }
  const nativeMax = new Map<string, number>();
  for (const [k, group] of byKey) {
    const natives = group.filter((m) => !scIsCopilot(m));
    if (!natives.length) continue;
    nativeMax.set(k, Math.max(...natives.map((m) => m.ctx)));
  }
  return models.map((m) => {
    if (!scIsCopilot(m)) return m;
    const mx = nativeMax.get(scModelKey(m.id));
    if (mx === undefined || mx === m.ctx) return m;
    return { ...m, ctx: mx };
  });
}

// ─── Effort stops (the architect 2026-08-27) ───
// Two independent facts, never mixed:
//   · WHICH stops a model has comes from the vendor page via
//     resolveProviderEffortLadder (updated 2026-08-27 from Anthropic / OpenAI /
//     xAI / Z.AI / Moonshot docs — the in-tree plugins lag those pages).
//   · HOW SMART each stop is comes from AA_EFFORT_INDEX, a scrape of named
//     per-effort rows on artificialanalysis.ai (2026-08-27). A vendor stop with
//     no AA number is dropped, not filled. A model with no named AA rows at all
//     stays a single dot at its headline index — that number is measured, the
//     per-effort ones are not.
export type { EffortLadderKind };

export interface ScEstimateTag {
  sd: number;
  method: string;
  basis: string[];
}

export interface ScEffortStop {
  lvl: string;
  label: string;
  costMult: number;
  /** AA Intelligence Index at THIS effort, or the model's headline index when
   *  AA published no per-effort row for the family. Never an estimate. */
  smart: number;
  /** True when `smart` is AA's named per-effort measurement, not the headline. */
  measured: boolean;
  /** Present when `smart` is an ESTIMATE from other public benchmarks
   *  (aa-effort-estimate.ts, the architect 2026-09-02) — never on a measured rung, never on
   *  the rail. Carries the 1σ and the basis so the tooltip can say so. */
  estimate?: ScEstimateTag;
  /** The stop carrying the model's published (unmultiplied) price — drawn at
   *  full STROKE strength (never at a different size: see SC_NONANCHOR_STROKE),
   *  and the attach point for twin connectors. */
  anchor: boolean;
}

export interface ScEffortLadder {
  kind: EffortLadderKind;
  note: string;
  stops: ScEffortStop[];
}

const SC_EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "xHigh",
  max: "Max",
};

/** The single stop drawn when we have a headline index and no honest per-effort
 *  spread — unknown ladder, binary switch, or a graded ladder AA has not scored. */
function scSoleStop(label: string, smart: number): ScEffortStop {
  return { lvl: "", label, costMult: 1, smart, measured: false, anchor: true };
}

function scAnchorStops(stops: ScEffortStop[]): void {
  if (!stops.length) return;
  let best = 0;
  for (let i = 1; i < stops.length; i++) {
    if (Math.abs(stops[i].costMult - 1) < Math.abs(stops[best].costMult - 1)) best = i;
  }
  for (const s of stops) s.anchor = false;
  stops[best].anchor = true;
}

/**
 * The effort stops to plot for one model.
 *
 * Intersection, not union: the vendor ladder says which stops EXIST; AA says
 * which of those we may place on Y. A vendor stop with no AA number is dropped.
 * A model whose ladder is binary/none/unknown, or whose family AA has not split
 * by effort, stays a single headline-index dot — that number is measured, the
 * missing per-effort ones are not, and we do not invent them.
 */
export function scEffortsFor(m: { id: string; provider: string; index: number }): ScEffortLadder {
  const ladder = resolveProviderEffortLadder(m.provider, m.id);
  if (ladder.kind !== "graded" || ladder.levels.length === 0) {
    const label =
      ladder.kind === "binary"
        ? "Thinking on/off"
        : ladder.kind === "none"
          ? "No effort control"
          : "Effort ladder unknown";
    return { kind: ladder.kind, note: ladder.note, stops: [scSoleStop(label, m.index)] };
  }
  // FORK 2026-08-30 (the architect: "Fable appears only as one bubble, break it down into
  // different thinking efforts"). Until now an effort AA had not scored was DROPPED,
  // so a model's constellation showed only the rungs AA happened to publish. Fable 5
  // has exactly one AA row (max) against a five-rung Anthropic ladder, so it drew as
  // a single dot — and the census says Fable is not special: 60 of 99 plotted models
  // have a vendor ladder wider than AA's coverage, 26 of them with no per-effort row
  // at all.
  //
  // Dropping them threw away something we DO know. The cost of every rung is real:
  // it is the model's published price times the documented EEG burn multiplier. Only
  // the SCORE is missing. So every rung is now plotted, and the two kinds of rung are
  // told apart rather than blended:
  //   · MEASURED  — AA published a score for this effort. Solid ring, real y.
  //   · COST RAIL — AA did not. The x is real; the y is the model's headline index,
  //                 which is a POSITION TO HANG THE RUNG ON, not a claim that the
  //                 model is equally smart at that effort (it is not: Opus 5 falls
  //                 10.6 points from max to low). Drawn dashed, on a dashed rail,
  //                 and the tooltip says so in words.
  //
  // This is deliberately NOT the 2026-08-25 defect coming back. That was an INVENTED
  // per-effort curve — a fabricated number on the y axis. This adds no number: the
  // unscored rungs carry the one index AA did publish, flagged `measured:false`, and
  // the styling makes the difference visible before the tooltip is even opened.
  //
  // THIRD KIND OF RUNG (the architect 2026-09-02 evening: "you must certainly be able to find
  // other benchmarks … even if you have to approximate"). Between MEASURED and COST
  // RAIL now sits ESTIMATED: the y comes from other public per-effort benchmark runs
  // fitted to AA's scale (aa-effort-estimate.ts), it carries a 1σ, it is drawn
  // DOTTED (finer than the rail's dashes) and the tooltip says ESTIMATE. The order of
  // preference is fixed and one-way: measurement → estimate → rail. An estimate never
  // replaces a measurement, and a rung with neither still hangs on the rail.
  const stops: ScEffortStop[] = ladder.levels.map((lvl) => {
    const smart = aaScoreAt(m.id, lvl);
    const est = smart === undefined ? aaEstimateAt(m.id, lvl) : undefined;
    return {
      lvl,
      label: SC_EFFORT_LABELS[lvl] ?? lvl,
      costMult: EEG_EFFORT_MULT[lvl] ?? 1,
      smart: smart ?? est?.v ?? m.index,
      measured: smart !== undefined,
      estimate: est ? { sd: est.sd, method: est.method, basis: est.basis } : undefined,
      anchor: false,
    };
  });
  scAnchorStops(stops);
  const unscored = stops.filter((x) => !x.measured);
  const estimated = unscored.filter((x) => x.estimate).map((x) => x.lvl);
  const railed = unscored.filter((x) => !x.estimate).map((x) => x.lvl);
  const scored = stops.length - unscored.length;
  const note =
    unscored.length === 0
      ? ladder.note
      : `${ladder.note} · AA scored ${scored} of ${stops.length} efforts` +
        (estimated.length
          ? ` — ${estimated.join(", ")} ESTIMATED from other public benchmarks (±1σ in the tooltip)`
          : "") +
        (railed.length
          ? ` — ${railed.join(", ")} drawn on the cost rail at the headline index, never as a measurement`
          : "");
  return { kind: ladder.kind, note, stops };
}

// ─── Tokens per average task ───
// MOVED 2026-09-03 to src/shared/tokens-per-task.ts so the THALAMUS router prices
// rungs in €/task from the same table this chart draws. Re-exported under the names
// the rest of this file and its tests use.
export {
  TOKENS_PER_TASK_RULES as SC_TOKEN_RULES,
  TASK_REFERENCE as SC_REFERENCE,
  baseTokensFor as scBaseTokens,
  tokensPerTaskFor as scTokensPerTask,
  tokenRatioFor as scTokenRatio,
} from "../../../src/shared/tokens-per-task.js";
import {
  TASK_REFERENCE,
  tokensPerTaskFor as scTokensPerTask,
  tokenRatioFor as scTokenRatio,
} from "../../../src/shared/tokens-per-task.js";
const SC_REFERENCE = TASK_REFERENCE;

// Context windows for models that are NOT in openclaw.json (the chart shows the
// whole reachable catalog, not only configured models). Family defaults from
// public model specs; CONFIGURED models always win with their config value.
export const SC_CTX_RULES: { match: RegExp; ctx: number }[] = [
  // FORK 2026-08-30 — the 2026-08-30 arrivals, context windows read off the live
  // OpenRouter catalog. These sit ABOVE the family rules because first match wins:
  // a route that actually serves 1M would otherwise take the generic /claude/i 200k,
  // and circle AREA is proportional to context window, so a wrong ctx draws a
  // visibly wrong dot.
  // FORK 2026-09-02 — a `claude-opus-5-fast` 1M row used to head this block and was
  // the original reason the ordering rule above was written down. The architect
  // banned OpenRouter routes that duplicate a vendor we hold a direct subscription
  // with, so `openrouter/anthropic/claude-opus-5-fast` left the catalog and its
  // override became dead data. The rule outlived the row: Fable 5.1 below is now the
  // one that depends on it.
  // Fable 5.1 serves a 1M window (live OpenRouter catalog 2026-09-02). Without this
  // the generic /claude/i rule below gives it 200k, and since circle AREA is
  // proportional to context window the chart's highest-scoring model would draw
  // 2.24x too small — wrong on the one channel a reader cannot check by hovering.
  { match: /claude-fable-5[.-]1/i, ctx: 1_000_000 },
  { match: /longcat-2\.0/i, ctx: 1_048_756 },
  { match: /nemotron-3\.5-lightning|ling-3\.0-flash/i, ctx: 262_144 },
  { match: /gemini/i, ctx: 1_000_000 }, // Gemini 2.x+ ship 1M windows
  { match: /gpt-5/i, ctx: 272_000 }, // GPT-5 generation incl. 5.6 tiers + codex variants
  { match: /\bo3\b/i, ctx: 200_000 },
  { match: /gpt-4/i, ctx: 128_000 }, // GPT-4 generation
  { match: /claude/i, ctx: 200_000 }, // Claude default when not configured
  { match: /grok/i, ctx: 256_000 },
];
const SC_CTX_DEFAULT = 200_000;

export function scDefaultCtx(modelId: string): number {
  for (const row of SC_CTX_RULES) {
    if (row.match.test(modelId)) return row.ctx;
  }
  return SC_CTX_DEFAULT;
}

/** Horizontal SHIFT in decades for per-task mode: log10 of the dot's
 *  tokens-per-task relative to the reference. The reference is 0 by
 *  construction; positive = burns more tokens per task than Opus@max. */
export function scTaskShiftDecades(modelId: string, effortLvl: string): number {
  const ref = scTokensPerTask("claude-code/claude-opus-5", SC_REFERENCE.effort);
  return Math.log10(scTokensPerTask(modelId, effortLvl) / ref);
}

// ─── OFFICIAL API LIST PRICE (the architect 2026-08-27) ───
// WHY THIS EXISTS. The x axis plots `relCost` — the EFFECTIVE price on the plan we
// actually hold. For every metered route (OpenRouter, Google, the Chinese labs) that
// IS the published price, so one number answers both questions. For the four
// Anthropic families, the OpenAI prepaid rows, Grok and the Copilot re-sells it is
// NOT: those carry a subscription divisor (Anthropic Max 20x amortises Opus 5's $25
// sticker down to ~€0.073 — a factor of ~340 as re-derived 2026-09-02 from the
// live quota reading and measured burn; see EEG_COST_TABLE for the whole derivation.
// That factor is an OUTPUT of the arithmetic and must never be used as a shortcut).
//
// That single fact is the whole reconciliation the architect asked for. Comparing an
// amortised Anthropic dot against a metered Kimi dot makes Claude look ~67x cheaper
// than Kimi when at LIST PRICE Kimi ($15) is 1.67x CHEAPER than Opus 5 ($25). The
// cost table already warns about this in prose ("never compare them to a metered row
// without saying which is which") — but the chart drew them in one column anyway,
// and the drawing is what gets believed. Now both are on screen at once.
//
// PROVENANCE: every figure here is the vendor's own published OUTPUT price per Mtok,
// taken from the SAME sources EEG_COST_TABLE cites (the sticker values recorded in
// its per-row comments; Anthropic's $5/$25 for Opus 5 re-verified against
// artificialanalysis.ai/models/claude-opus-5 on 2026-08-27). Nothing here is
// measured by us and nothing here is estimated — it is list price or it is absent.
//
// UNITS, SAID OUT LOUD: the axis is labelled €/Mtok, the Anthropic rows are genuinely
// € (derived from a €200/mo fee) and every metered row is the vendor's $ figure
// carried across unchanged. That $/€ smear is PRE-EXISTING in EEG_COST_TABLE; this
// table deliberately does not fix it, because a triangle on a different unit basis
// than the circle it is bridged to would be a new lie on top of an old one. Both
// marks sit on the same nominal scale; the ~8% FX gap is smaller than the weekly
// drift already seen in the OpenRouter rows.
//
// ABSENT ON PURPOSE: a model with no row here gets NO triangle. That is the honest
// outcome for two different cases — (a) a metered model, whose circle already IS its
// list price, and (b) a model whose list price we have not verified (gpt-5.4-nano).
// Inventing a sticker to complete the picture is the exact failure this chart spent
// 2026-08-25 removing from its Y axis.
export const SC_API_PRICE: { match: RegExp; out: number }[] = [
  // Anthropic — anthropic.com/pricing. Opus 5 re-verified on AA 2026-08-27 ($5/$25).
  { match: /fable/i, out: 50 },
  // FORK 2026-09-02: a `claude-opus-5-fast` row sat here at $50 out, deliberately
  // ABOVE the generic /opus/i $25 — a metered Anthropic route handed the amortised
  // subscription sticker draws its triangle to the LEFT of its own circle, rendering
  // a 2x SURCHARGE as a 50% discount. The architect banned OpenRouter routes that
  // duplicate a vendor we hold a direct subscription with, so
  // `openrouter/anthropic/claude-opus-5-fast` left the catalog and the row with it.
  // The hazard did not leave with it: any future Anthropic route sold METERED above
  // $25 needs its own entry ABOVE /opus/i, or it inherits the wrong basis silently.
  { match: /opus/i, out: 25 },
  { match: /sonnet-5(?![.\d])/i, out: 10 }, // Sonnet 5 $2/$10
  { match: /sonnet/i, out: 15 }, // Sonnet 4.5/4.6 $3/$15
  { match: /haiku/i, out: 5 },
  // OpenAI — developers.openai.com/api/docs/pricing. Specific before generic.
  // All three gpt-5.6 rows carry OpenAI's SHORT-context standard rate. Sol read $30
  // until 2026-08-30 — the LONG-context rate — while Terra and Luna read short, so
  // one family sat on two bases (developers.openai.com/api/docs/pricing, re-read
  // 2026-08-30). Long context doubles: $30 / $18 / $1.80. A promo currently bills
  // Sol at $10 on OpenRouter and Copilot; this axis ranks by STANDARD list, so the
  // promo is reported to the architect rather than baked into a literal that outlives it.
  { match: /5\.6-sol/i, out: 20 },
  { match: /5\.6-terra/i, out: 12 },
  { match: /5\.6-luna/i, out: 1.2 },
  { match: /gpt-5\.5/i, out: 30 },
  { match: /gpt-5\.4-mini/i, out: 4.5 },
  { match: /gpt-5\.4(?!-mini|-nano)/i, out: 15 },
  { match: /gpt-5\.3-codex/i, out: 14 },
  { match: /gpt-5\.2/i, out: 14 },
  { match: /gpt-5\.1/i, out: 10 },
  { match: /gpt-5-mini/i, out: 2 },
  { match: /gpt-5(?![.\d])/i, out: 10 },
  { match: /gpt-4\.1/i, out: 8 },
  { match: /gpt-4o/i, out: 10 },
  // xAI — $6 out below 200k ctx (doubles above; a scalar cannot say so, same
  // caveat the EEG_COST_TABLE grok row carries).
  { match: /grok/i, out: 6 },
  // Google — ai.google.dev/gemini-api/docs/pricing. 3.7/3.6 flash rate is
  // promotional through 2026-12-31.
  { match: /gemini.*pro/i, out: 12 },
  { match: /gemini-3\.[67].*flash/i, out: 3.75 },
  { match: /gemini.*flash/i, out: 9 },
];

/** The vendor's published output $/Mtok, or undefined when we have not verified one. */
export function scApiPrice(modelId: string): number | undefined {
  for (const row of SC_API_PRICE) {
    if (row.match.test(modelId)) return row.out;
  }
  return undefined;
}

/** Below this relative gap the two prices are the SAME number and the model gets no
 *  triangle — a coincident mark plus a 0px dashed bridge would assert a discount
 *  that does not exist, the same defect `twinSpread:false` exists to prevent. */
const SC_API_GAP_EPS = 0.01;

/**
 * The API-price twin of `scPointsFor`: the same effort ladder, the same measured
 * index, positioned at the model's LIST price instead of its effective one.
 *
 * Returns [] when there is nothing to say — no verified list price, or a list price
 * the plan does not discount (every metered route). An empty array means "this dot
 * is already at sticker", which is why the footer states it rather than the chart
 * drawing a second mark on top of the first.
 */
export function scApiPointsFor(m: ScModel): {
  lvl: string;
  label: string;
  cost: number;
  smart: number;
  measured: boolean;
  estimate?: ScEstimateTag;
  anchor: boolean;
}[] {
  const list = scApiPrice(m.id);
  if (list === undefined) return [];
  if (Math.abs(list - m.relCost) / Math.max(list, m.relCost) < SC_API_GAP_EPS) return [];
  return scEffortsFor(m).stops.map((e) => ({
    lvl: e.lvl,
    label: e.label,
    cost: list * e.costMult,
    smart: e.smart,
    measured: e.measured,
    estimate: e.estimate,
    anchor: e.anchor,
  }));
}

/** How many times dearer the list price is than what this plan actually pays.
 *  Undefined when the model has no triangle (see scApiPointsFor). */
export function scApiMultiple(m: ScModel): number | undefined {
  const list = scApiPrice(m.id);
  if (list === undefined || m.relCost <= 0) return undefined;
  if (Math.abs(list - m.relCost) / Math.max(list, m.relCost) < SC_API_GAP_EPS) return undefined;
  return list / m.relCost;
}

// ─── geometry ───
const W = 900;
const H = 600;
const ML = 64; // left margin
const MR = 36;
const MT = 30;
const MB = 66;
const PW = W - ML - MR;
const PH = H - MT - MB;

const R_MAX = 12; // largest context window → this radius; all others ∝ √ctx
// Task mode shifts dots by up to ~0.5 decades; the domain grows so nothing
// lands outside the plot.
const TASK_PAD = 0.55;

export type ScXScale = "log" | "linear";

export interface ScScales {
  xScale: ScXScale;
  x0: number; // log10 domain (already grown for task-mode shifts)
  x1: number;
  c0: number; // raw-cost domain for LINEAR mode
  c1: number;
  y0: number; // index domain
  y1: number;
  sqrtCtxMax: number;
}

// FORK 2026-08-06 #4 (the architect: linear ↔ log toggle). The domain now spans the
// TASK-shifted costs too (cost × token-ratio), so dots land inside the plot in
// BOTH toggle states of BOTH axes — no edge clipping in any of the four views.
export function scComputeScales(models: ScModel[], xScale: ScXScale = "log"): ScScales {
  let minCost = Infinity;
  let maxCost = -Infinity;
  let maxTaskCost = -Infinity;
  let minIdx = Infinity;
  let maxIdx = -Infinity;
  let maxCtx = -Infinity;
  const refTokens = scTokensPerTask("claude-code/claude-opus-5", SC_REFERENCE.effort);
  for (const m of models) {
    for (const e of scEffortsFor(m).stops) {
      const cost = m.relCost * e.costMult;
      minCost = Math.min(minCost, cost);
      maxCost = Math.max(maxCost, cost);
      maxTaskCost = Math.max(maxTaskCost, cost * (scTokensPerTask(m.id, e.lvl) / refTokens));
    }
    // FORK 2026-08-27 (the architect): the API-price triangles are real marks and must be
    // inside the plot on BOTH axes. Opus 5's list price is ~340x its plan price, so
    // omitting them here would push every triangle past the right edge, where
    // scCostX clamps — a pile of marks on the boundary reading as one price.
    // maxCost feeds the LINEAR c1 too, so the linear axis grows to the dearest
    // number actually drawn, which is what "span to the maximum priced model" means
    // once list prices are on the chart.
    for (const p of scApiPointsFor(m)) {
      maxCost = Math.max(maxCost, p.cost);
      minCost = Math.min(minCost, p.cost);
      maxTaskCost = Math.max(maxTaskCost, p.cost * (scTokensPerTask(m.id, p.lvl) / refTokens));
    }
    // The y domain is the MEASURED index range, padded by a flat 2 points. It
    // used to be padded by ×0.9 and ×1.12 — the same invented smartness curve
    // the dots were drawn with, so the axis inherited the fiction.
    for (const e of scEffortsFor(m).stops) {
      minIdx = Math.min(minIdx, e.smart);
      maxIdx = Math.max(maxIdx, e.smart);
    }
    maxCtx = Math.max(maxCtx, m.ctx);
  }
  if (!models.length) {
    return { xScale, x0: -1, x1: 2, c0: 0, c1: 10, y0: 0, y1: 70, sqrtCtxMax: 1 };
  }
  return {
    xScale,
    x0: Math.log10(minCost) - 0.09 - TASK_PAD,
    x1: Math.log10(maxTaskCost) + 0.09 + TASK_PAD,
    c0: 0,
    // FORK 2026-08-06 #8 (the architect: "when I turn into linear scale, the right of the
    // graph should not be empty, the cost scale should span from 0 to the maximum
    // priced model, and no more"). This was maxTaskCost — the €/TASK maximum, which
    // is cost x a verbosity ratio and can sit far right of any real price, leaving
    // the whole right half of a LINEAR axis blank. The linear axis now ends just
    // past the dearest model's actual €/Mtok. Task-mode dots clamp at the edge
    // (scCostX already clamps), which is the honest trade: the axis says €/Mtok and
    // now shows exactly that range.
    c1: maxCost * 1.02,
    y0: minIdx - 2.5,
    y1: maxIdx + 2,
    sqrtCtxMax: Math.sqrt(maxCtx),
  };
}

// ─── pan / zoom view box ───
// FORK 2026-08-06 #8 (the architect: pan by drag, zoom by wheel, "don't let the graph zoom
// out more when all the models are already visible"). The CLAMP lives here, not in
// app.ts, because it is the only part that can be silently wrong — the event
// plumbing fails loudly, an off-by-one in the bounds just quietly lets the chart
// drift off-screen. Pure in, pure out, unit-tested.
export interface ScView {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Full drawing extent — the zoom-OUT floor: never show more than this. */
export const SC_VIEW_FULL: ScView = { x: 0, y: 0, w: W, h: H };
/** Deepest zoom-in. */
export const SC_VIEW_MIN_W = W / 10;

/**
 * Constrain a candidate view: width within [SC_VIEW_MIN_W, W], height locked to
 * the drawing's aspect (no skew), and the origin pinned so the view never leaves
 * the drawing — which is what makes "everything visible" the hard outer limit.
 */
export function scClampView(v: ScView): ScView {
  const w = Math.min(W, Math.max(SC_VIEW_MIN_W, v.w));
  const h = w * (H / W);
  return {
    w,
    h,
    x: Math.min(W - w, Math.max(0, v.x)),
    y: Math.min(H - h, Math.max(0, v.y)),
  };
}

/** Scale-aware cost → x. Log is the historic axis; linear starts at €0. */
export function scCostX(cost: number, s: ScScales): number {
  if (s.xScale === "linear") {
    const t = (cost - s.c0) / (s.c1 - s.c0);
    return ML + Math.max(0, Math.min(1, t)) * PW;
  }
  const t = (Math.log10(cost) - s.x0) / (s.x1 - s.x0);
  return ML + t * PW;
}

/** Inverse of scCostX — used while sliding a prepaid circle along the plan→API span. */
export function scCostFromX(x: number, s: ScScales): number {
  const t = Math.max(0, Math.min(1, (x - ML) / PW));
  if (s.xScale === "linear") return s.c0 + t * (s.c1 - s.c0);
  return Math.pow(10, s.x0 + t * (s.x1 - s.x0));
}

function scCtxLegendSvg(s: ScScales): string {
  const fx = (n: number) => Number(n.toFixed(2));
  const x0 = ML + 16;
  const y0 = MT + PH - 14;
  let x = x0 + 38;
  let marks = "";
  for (const ctx of SC_CTX_LEGEND) {
    const r = fx(scRadius(ctx, s));
    marks +=
      `<g transform="translate(${fx(x)}, ${fx(y0 - r)})">` +
      `<circle r="${r}" fill="none" stroke="#f0e6d8" stroke-opacity="0.55" stroke-width="1" vector-effect="non-scaling-stroke"/>` +
      `<text y="${fx(r + 9)}" text-anchor="middle" font-size="7.5" fill="#f0e6d8" fill-opacity="0.55"` +
      ` font-family="'SF Mono',ui-monospace,monospace">${esc(scFmtCtx(ctx))}</text></g>`;
    x += r * 2 + 22;
  }
  return (
    `<g class="sc-ctxleg" pointer-events="none">` +
    `<text x="${x0}" y="${fx(y0 - 22)}" font-size="7.5" letter-spacing="1.4" fill="#f0e6d8" fill-opacity="0.5"` +
    ` font-family="'SF Mono',ui-monospace,monospace">SIZE ∝ CONTEXT</text>` +
    `${marks}</g>`
  );
}

export function scX(cost: number, s: ScScales): number {
  const t = (Math.log10(cost) - s.x0) / (s.x1 - s.x0);
  return ML + t * PW;
}
export function scY(index: number, s: ScScales): number {
  const t = (index - s.y0) / (s.y1 - s.y0);
  return MT + (1 - t) * PH;
}
/** Radius: strictly ∝ √ctx through the origin, so AREA ∝ context window —
 *  the architect's "size proportional to context window" taken literally, no offset.
 *
 *  INVARIANT — never scale this at a call site. Until 2026-08-30 both emission
 *  sites multiplied it by `(anchor ? 1 : 0.82)`, so a model with ONE context
 *  window drew at TWO radii (the architect: "opus 5 seems to have different sizes in the
 *  same model, impossible, must be a bug"). Size then meant context window AND
 *  anchor-ness at once — and the on-plot SIZE ∝ CONTEXT legend, which calls this
 *  UNSCALED (scCtxLegendSvg), was therefore a lie for every non-anchor mark.
 *  Anything a mark needs to say beyond its context window goes on the stroke,
 *  never on the size, and never on colour — colour is model identity on this
 *  chart. See SC_NONANCHOR_STROKE below. */
export function scRadius(ctxTokens: number, s: ScScales): number {
  if (s.sqrtCtxMax <= 0) return R_MAX / 2;
  return Math.max(2, R_MAX * (Math.sqrt(ctxTokens) / s.sqrtCtxMax));
}

/** Fraction of its mark's resting stroke-opacity that a NON-anchor effort stop
 *  keeps. The anchor — the stop the published price is quoted at, where the twin
 *  connectors and the dashed API bridge attach — draws at full strength and the
 *  stops derived from it recede. This is the ENTIRE anchor channel now: every
 *  stop of a model is the same size, because size is spoken for (area ∝ context
 *  window, scRadius above).
 *
 *  Why stroke-OPACITY, and not stroke-width or fill-opacity: base.css owns both
 *  of those on these two classes as the hover/focus "light up gently" channel,
 *  and it writes FLAT values — `.sc-focus .sc-hl .sc-ring` → stroke-width 2.1 /
 *  fill-opacity 0.2, `.sc-focus .sc-hl .sc-tri` → 1.9 / 0.22, plus the two :hover
 *  rules. An anchor encoded there would vanish the instant you focused the model,
 *  which is precisely when "which of these five is the published price?" is the
 *  question being asked. `opacity` is taken too, by the dim/glow state machine on
 *  .sc-dotpos. No CSS rule writes stroke-opacity on .sc-ring or .sc-tri, so it is
 *  the one free channel.
 *
 *  Why 0.6 and not a half: the API layer already rests at opacity 0.55, so a
 *  non-anchor triangle lands at 0.5 × 0.6 × 0.55 ≈ 0.165 of ink — just above the
 *  0.16 of the dashed bridge that connects it. At 0.5 it would sit UNDER its own
 *  connector, inverting the layer order this chart is built on. If the derived
 *  stops ever read too faint, this is the single knob: it moves the circles and
 *  the triangles together by construction. */
export const SC_NONANCHOR_STROKE = 0.6;

/** The accounting utilisation the prepaid circle is drawn at (the architect 2026-08-13).
 *  Max 20x / SuperGrok / ChatGPT Business are not token-metered; 75% is the
 *  quota-ceiling convention the €/Mtok number was derived from. */
export const SC_PLAN_UTIL = 0.75;

/** Sample windows for the on-plot size legend. Area ∝ ctx, so these three
 *  sizes are the visual dictionary for every circle on the chart. */
export const SC_CTX_LEGEND = [128_000, 256_000, 1_000_000] as const;

/** Prepaid seats whose circle is an amortised plan price and whose triangle is
 *  list. Copilot is excluded: its factor is 0.5571 credits, not 75% quota. */
export function scIsUtilDrag(m: { id: string; provider: string }): boolean {
  if (scIsCopilot(m)) return false;
  if (scApiPrice(m.id) === undefined) return false;
  const p = (m.provider || m.id.split("/")[0] || "").toLowerCase();
  if (p === "claude-code" || p === "anthropic") return true;
  if (p === "xai") return true;
  if (p === "openai" || p === "openai-codex" || p === "codex") return true;
  return false;
}

/** €/Mtok at utilisation U (0–1] given the 75%-quota home cost. */
export function scCostAtUtil(homeCost: number, util: number): number {
  const u = Math.max(0.01, Math.min(1, util));
  return (homeCost * SC_PLAN_UTIL) / u;
}

/** Utilisation (0–1) implied by a cost on the home→list span. */
export function scUtilAtCost(homeCost: number, cost: number): number {
  if (homeCost <= 0 || cost <= 0) return SC_PLAN_UTIL;
  return Math.max(0.01, Math.min(1, (homeCost * SC_PLAN_UTIL) / cost));
}

/** Pixel shift for a dot's task-mode position (decades → px on the log axis). */
export function scTaskShiftPx(shiftDecades: number, s: ScScales): number {
  return (shiftDecades / (s.x1 - s.x0)) * PW;
}

/** Tokens-per-task relative to the Opus 5 @ max reference (>1 = more verbose). */

const fmt = (n: number): string => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2));
export function scFmtCtx(tokens: number): string {
  return tokens >= 1_000_000
    ? `${Number((tokens / 1_000_000).toFixed(1))}M`
    : `${Math.round(tokens / 1000)}k`;
}
export function scFmtTokens(tokens: number): string {
  return tokens >= 1000
    ? `${Number((tokens / 1000).toFixed(1))}k tok`
    : `${Math.round(tokens)} tok`;
}

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const X_TICKS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];

/** Nice round tick values for the LINEAR axis: ~6 steps of 1/2/5 × 10^n. */
export function scLinearTicks(c1: number): number[] {
  const raw = Math.max(c1, 1) / 6;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let v = 0; v <= c1 + step * 0.5; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

/**
 * One model's points: vendor-documented effort stops that AA actually scored.
 * `smart` is AA's number at THAT effort, or the headline index on a sole stop
 * when AA published no per-effort split. Never an interpolation.
 */
export function scPointsFor(m: ScModel): {
  lvl: string;
  label: string;
  cost: number;
  smart: number;
  measured: boolean;
  estimate?: ScEstimateTag;
  anchor: boolean;
}[] {
  return scEffortsFor(m).stops.map((e) => ({
    lvl: e.lvl,
    label: e.label,
    cost: m.relCost * e.costMult,
    smart: e.smart,
    measured: e.measured,
    estimate: e.estimate,
    anchor: e.anchor,
  }));
}

/** The "idx …" clause of a rung's tooltip. Three honest states, one function, so the
 *  circle and its API triangle can never disagree about what a number is. */
export function scIdxTag(
  p: { smart: number; measured: boolean; label: string; estimate?: ScEstimateTag },
  measuredSuffix = "",
): string {
  if (p.measured) return `idx ${p.smart.toFixed(1)} at ${p.label}${measuredSuffix}`;
  if (p.estimate) {
    return (
      `idx ≈${p.smart.toFixed(1)} ±${p.estimate.sd.toFixed(1)} at ${p.label}` +
      ` (ESTIMATE, ${p.estimate.method}: ${p.estimate.basis.join("; ")} — not an AA measurement)`
    );
  }
  return `idx ${p.smart.toFixed(1)} (headline — AA published no per-effort split)`;
}

/**
 * Freeze a mark: strip its SMIL animation elements.
 *
 * FORK 2026-08-06 #10 (the architect: "why is gemini flash pulsating? It should not").
 * The GOOGLE provider mark carries an `<animate>` that cycles its ring stroke
 * through the four Google colours on a 4s loop — so every Gemini dot (no vendor
 * mark of its own, so it falls back to the provider logo) shimmered. Two reasons
 * that is wrong HERE and nowhere else: this is a static reference chart, where a
 * moving dot reads as "live/active" and means nothing; and the mark is inlined
 * once per effort level per model, so the catalog view was running ~100 SMIL
 * timelines behind a chart we just spent a commit making cheaper to zoom.
 * The panels that show ONE logo keep their animation — this only freezes the
 * copies the chart makes.
 */
function scStill(mark: string): string {
  return mark.replace(/<\/?(animate|animateTransform|animateMotion|set)\b[^>]*>/g, "");
}

/**
 * Make a provider mark safe to nest INSIDE an <svg>.
 *
 * FORK 2026-08-06 #7 — THE ACTUAL CAUSE of "logos under the graph at the left,
 * circle outlines not visible" (the architect, three reports). The comment this replaces
 * claimed "Both are complete <svg> elements". They are not: the GitHub Copilot
 * mark is an <img>, and `<img>` sits on the HTML parser's FOREIGN-CONTENT
 * BREAKOUT LIST. When the app does `body.innerHTML = "<svg>…<img>…</svg>"` the
 * fragment parser TERMINATES the <svg> at that img — verified in the parsed DOM:
 *
 *   …</g></g></svg><img src="/tinker/copilot-logo.svg"><circle r="8.3">…
 *
 * Everything after the logo becomes HTML, so those <circle>/<g> are unknown
 * elements that render nothing (no outlines) and the <img> logos flow as normal
 * HTML below the chart, left-aligned. Exactly the reported symptom.
 *
 * Why three fixes missed it: parsing the SAME markup from a FILE does not break
 * out (132 of 132 rings survive), and every verification — mine included — was a
 * file render. Only `innerHTML`, the path the app actually uses, reproduces it.
 *
 * So: any mark that is not already an <svg> root is wrapped in one, with an <img>
 * rewritten to SVG's own <image>. Wrapping (rather than returning the <image>
 * bare) keeps the caller's `^<svg ` positioning replace working unchanged.
 */
function scSvgSafeMark(mark: string): string {
  if (/^<svg[\s>]/.test(mark)) {
    return scStill(mark);
  }
  const src = /\bsrc="([^"]+)"/.exec(mark)?.[1] ?? "";
  if (!src) {
    // Unknown, non-svg mark with nothing to point at — draw nothing rather than
    // risk another breakout tag silently truncating the chart.
    return `<svg viewBox="0 0 14 14"></svg>`;
  }
  return `<svg viewBox="0 0 14 14"><image href="${esc(src)}" x="0" y="0" width="14" height="14"/></svg>`;
}

/** The dot's logo: the vendor mark when the model id carries one, else the
 *  provider logo — normalised so it can never break the enclosing <svg>. */
function scLogoFor(m: ScModel): string {
  // FORK 2026-08-30 (the architect: "openrouter bubbles have the wrong icon"). This read
  // `getModelLogoSvg(m.id) ?? getProviderLogoSvg(m.provider)`, and the fallback
  // returned Anthropic's sparkle for any provider it did not know — `openrouter`
  // among them. 15 of 99 plotted models were branded as Claude, including NVIDIA,
  // Meta, Tencent, MiniMax and Xiaomi. getRoutedLogoSvg also reads the vendor out
  // of the id's middle segment, which is what recovers the Google, OpenAI and
  // Anthropic models we reach THROUGH OpenRouter.
  return scSvgSafeMark(getRoutedLogoSvg(m.id, m.provider));
}

export function renderSmartCostChart(
  models: (ScModel & ScTwinInfo)[],
  opts?: {
    xScale?: ScXScale;
    /** CLOCK DISCIPLINE. Read ONLY by the thalamus provider-exhaustion check, and
     *  inert while `thalamusSnapshot` is undefined — `providerQuotaExhaustion`
     *  returns null before it reads the clock when the snapshot is absent
     *  (quota-aware-auto-model.ts), which is the only reason a 0 default is safe
     *  today. This module is PURE and has never had a clock of its own, so it must
     *  not call Date.now() to fill this in: a hidden clock would let the chart and
     *  the gateway disagree about the same window, and would make the render
     *  non-deterministic for nothing. WHEN A SNAPSHOT IS WIRED, DELETE THE 0
     *  DEFAULT and make the two travel together. */
    nowMs?: number;
    /** Quota snapshot for the envelope. Omitted => no provider can read as spent,
     *  so the envelope is an UPPER BOUND and the footer says so out loud. */
    thalamusSnapshot?: ScThalamusParams["snapshot"];
    /** The router's own `allowedModelKeys`. Omitted => this chart cannot reproduce
     *  the router's not-routable rule and may claim a model the gateway holds no
     *  auth profile for. Also an UPPER BOUND, also named in the footer. Fabricating
     *  one here (`new Set(models.map(m => m.id))`) would be worse than passing none,
     *  because it would look like a filter ran. */
    thalamusAllowedModelKeys?: ScThalamusParams["allowedModelKeys"];
    /** The session's BIAS dial (routing-rationale.ts BIAS_STOPS index, 0 fast … 6
     *  smart). Picks WHICH frontier rung carries the heavy ring. Omitted =>
     *  clampBiasIdx(undefined) = 3, balanced — the dial's own default. */
    biasIdx?: number;
  },
): string {
  const xScale: ScXScale = opts?.xScale ?? "log";
  const s = scComputeScales(models, xScale);
  const fx = (n: number) => Number(n.toFixed(2));

  // The thalamus envelope, computed ONCE, from the router's own module — see the
  // SC_THALAMUS block above for what the three marks mean and why the set is never
  // a literal. The catalog is keyed by ROUTE (m.id), not by brain: github-copilot/
  // claude-opus-5 and claude-code/claude-opus-5 are two keys the router can route
  // to, at two prices, so a twin pair can legitimately land on opposite sides of
  // the ceiling and `catalogSize` counts routes.
  const thalCatalog: Record<string, { intelligenceIndex?: number }> = {};
  for (const m of models) thalCatalog[m.id] = { intelligenceIndex: m.index };
  const thal = thalamusCandidates({
    catalog: thalCatalog,
    snapshot: opts?.thalamusSnapshot,
    nowMs: opts?.nowMs ?? 0,
    relCostFor: scThalamusRelCost,
    ...(opts?.thalamusAllowedModelKeys ? { allowedModelKeys: opts.thalamusAllowedModelKeys } : {}),
  });
  const thalConsidered = new Set(thal.considered.map((c) => c.key));
  // THE FRONTIER (the architect 2026-09-02: "picked as up-left as possible, basically defining
  // the top-left outline"). Every rung of every considered model, priced in €/TASK by
  // the shared module — `m.relCost` and `m.index` are the SAME inputs scPointsFor
  // draws from, so a rung's cost equals `p.cost * scTokenRatio(m.id, p.lvl)` and its
  // ring lands on the dot it names (the envelope test asserts that equivalence).
  // Nothing about the frontier is derived here: paretoFrontier and biasPick are the
  // router's own functions, called with the chart's data.
  const thalRungs: FrontierRung[] = [];
  for (const m of models) {
    if (!thalConsidered.has(m.id)) continue;
    thalRungs.push(...frontierRungsFor(m.id, m.index, m.relCost));
  }
  const thalFrontier = paretoFrontier(thalRungs);
  const thalFrontierSet = new Set(thalFrontier.map(scRungTag));
  const thalBiasIdx = clampBiasIdx(opts?.biasIdx);
  const thalPickRung = biasPick(thalFrontier, thalBiasIdx);
  const thalPickTag = thalPickRung ? scRungTag(thalPickRung) : undefined;
  // Pixel position of every FRONTIER rung, keyed by scRungTag. Filled inside the
  // dots loop, where each rung's coordinates are resolved; joined into the PATH
  // after, in FRONTIER order (task cost ascending), never re-sorted.
  const envAt = new Map<string, { x: number; y: number; dx: number }>();

  let defs =
    `<defs>` +
    // deep-space backdrop with a faint warm vignette (the Tinker paper, darkened)
    `<radialGradient id="sc-bg" cx="50%" cy="42%" r="75%">` +
    `<stop offset="0%" stop-color="#221b13"/><stop offset="60%" stop-color="#191410"/>` +
    `<stop offset="100%" stop-color="#120e0b"/></radialGradient>` +
    // soft neon bloom for the circles
    `<filter id="sc-glow" x="-80%" y="-80%" width="260%" height="260%">` +
    `<feGaussianBlur stdDeviation="2.2" result="b"/>` +
    `<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>` +
    `</filter>` +
    // axis fade
    `<linearGradient id="sc-axis" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0%" stop-color="#f0e6d8" stop-opacity="0.0"/>` +
    `<stop offset="12%" stop-color="#f0e6d8" stop-opacity="0.5"/>` +
    `<stop offset="100%" stop-color="#f0e6d8" stop-opacity="0.5"/></linearGradient>` +
    `</defs>` +
    // THE ENVELOPE CROSSFADE, emitted here rather than added to base.css because
    // that file is outside this unit's writes. This is NOT optional polish: the
    // €/Mtok↔€/task crossfade is driven by PER-CLASS rules (base.css:10117-10127 for
    // .sc-line-*, :10081-10098 for .sc-bridge-*), and a CSS rule beats an SVG
    // presentation attribute — which is precisely how the task copy's inline
    // stroke-opacity="0" gets lifted in task mode. With no rule for .sc-env-*,
    // sc-env-task stays invisible forever while sc-env-cost stays lit, and the
    // envelope detaches from its dots the instant the toggle flips: invisible in the
    // DEFAULT view, so the break would ship unseen. An inline `style=` ATTRIBUTE
    // cannot express it (the toggle is a class on the <svg> root), but a <style>
    // ELEMENT can, so the rules ride inside the drawing.
    // Scoped under .sc-svg so nothing leaks past this chart, and written with
    // descendant combinators only — a ">" inside an SVG <style> would be parsed as
    // markup by the HTML fragment parser this chart is injected through (see
    // scSvgSafeMark). <style> is NOT on that parser's foreign-content breakout list,
    // so unlike an <img> it cannot truncate the chart; the "can never break its own
    // <svg>" test covers exactly that list. FOLD THESE THREE RULES INTO
    // base.css:10117-10127, beside the .sc-line-cost/.sc-line-task pair they mirror,
    // in whatever wave owns that file next — it is a pure move, no behaviour change.
    `<style>` +
    `.sc-svg .sc-env-cost,.sc-svg .sc-env-task{transition:stroke-opacity 1.3s ease}` +
    `.sc-svg.sc-taskmode .sc-env-cost{stroke-opacity:0}` +
    `.sc-svg.sc-taskmode .sc-env-task{stroke-opacity:${SC_ENV_PATH_OPACITY}}` +
    `</style>`;

  const bg =
    `<rect x="0" y="0" width="${W}" height="${H}" rx="10" fill="url(#sc-bg)"/>` +
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="none" stroke="#f0e6d8" stroke-opacity="0.10"/>`;

  // grid — vertical cost lines (log decades OR linear nice-steps) + horizontal
  // index lines, both whisper-quiet
  let grid = "";
  const xTicks: number[] =
    xScale === "log"
      ? X_TICKS.filter((t) => Math.log10(t) >= s.x0 && Math.log10(t) <= s.x1)
      : scLinearTicks(s.c1);
  for (const t of xTicks) {
    const x = fx(scCostX(t, s));
    grid += `<line x1="${x}" y1="${MT}" x2="${x}" y2="${MT + PH}" stroke="#f0e6d8" stroke-opacity="0.06"/>`;
    grid +=
      `<text x="${x}" y="${MT + PH + 16}" text-anchor="middle" font-size="8.5" fill="#f0e6d8" fill-opacity="0.5"` +
      ` font-family="'SF Mono',ui-monospace,monospace">€${fmt(t)}</text>`;
  }
  const yStart = Math.ceil(s.y0 / 5) * 5;
  for (let v = yStart; v <= s.y1; v += 5) {
    const y = fx(scY(v, s));
    grid += `<line x1="${ML}" y1="${y}" x2="${ML + PW}" y2="${y}" stroke="#f0e6d8" stroke-opacity="0.055"/>`;
    grid +=
      `<text x="${ML - 8}" y="${y + 2.5}" text-anchor="end" font-size="8.5" fill="#f0e6d8" fill-opacity="0.5"` +
      ` font-family="'SF Mono',ui-monospace,monospace">${v}</text>`;
  }

  // axes + HUD corner brackets + BOTH axis captions (CSS cross-fades them)
  const axes =
    `<line x1="${ML}" y1="${MT + PH}" x2="${ML + PW}" y2="${MT + PH}" stroke="url(#sc-axis)" stroke-width="1"/>` +
    `<line x1="${ML}" y1="${MT}" x2="${ML}" y2="${MT + PH}" stroke="#f0e6d8" stroke-opacity="0.4"/>` +
    `<text class="sc-xcap-cost" x="${ML + PW / 2}" y="${MT + PH + 30}" text-anchor="middle" font-size="9.5" letter-spacing="2.5" fill="#f0e6d8" fill-opacity="0.62"` +
    ` font-family="'SF Mono',ui-monospace,monospace">EFFECTIVE COST · €/Mtok OUTPUT · ${xScale}</text>` +
    `<text class="sc-xcap-task" x="${ML + PW / 2}" y="${MT + PH + 30}" text-anchor="middle" font-size="9.5" letter-spacing="2.5" fill="#f0e6d8" fill-opacity="0"` +
    ` font-family="'SF Mono',ui-monospace,monospace">EFFECTIVE COST PER AVERAGE TASK · €/task · ${xScale}</text>` +
    `<text x="16" y="${MT + PH / 2}" text-anchor="middle" font-size="9.5" letter-spacing="2.5" fill="#f0e6d8" fill-opacity="0.62"` +
    ` font-family="'SF Mono',ui-monospace,monospace" transform="rotate(-90 16 ${MT + PH / 2})">AA INTELLIGENCE INDEX</text>` +
    // The caption sits at MT + PH + 30 = 564: under the tick labels (MT + PH + 16) and
    // above the THALAMUS footer, which since 2026-09-03 wraps to up to three rows
    // stacked upward from H - 7 (rows at 575/584/593). At its old y = H - 24 = 576 the
    // caption printed straight through the footer's first row — seen on the live
    // 2026-09-03 screenshot, not predicted.
    // corner brackets — the futuristic frame
    [
      `M ${ML + 10} ${MT} h -10 v 10`,
      `M ${ML + PW - 10} ${MT} h 10 v 10`,
      `M ${ML} ${MT + PH - 10} v 10 h 10`,
      `M ${ML + PW} ${MT + PH - 10} v 10 h -10`,
    ]
      .map(
        (d) =>
          `<path d="${d}" fill="none" stroke="#f0e6d8" stroke-opacity="0.3" stroke-width="1"/>`,
      )
      .join("") +
    scCtxLegendSvg(s);

  // constellations: BOTH polylines per model (cost view + task view), CSS
  // cross-fades them in lockstep with the dot movement. Ghost target rings
  // mark where each dot lands — faint, dashed, "targeting reticle" style.
  let linesCost = "";
  let linesTask = "";
  // dashed COST rail through vendor efforts AA never scored (the architect 2026-08-30)
  let rails = "";
  let ghosts = "";
  let dots = "";
  // FORK 2026-08-27 (the architect): the API-price layer. `apiMarks` holds the triangles and
  // their two constellation polylines; `bridges` holds the dashed circle↔triangle
  // connectors. Kept in their own strings so the layer can sit UNDER the dots — the
  // circles are what this plan actually pays and must never be occluded by the
  // hypothetical price.
  let apiMarks = "";
  let bridges = "";
  // One entry per ROUTE of a price-spread twin group; joined into dashed
  // connectors after the loop, once every member's position is known.
  const twinAnchors: { key: string; x: number; y: number; dx: number; color: string }[] = [];
  // FORK 2026-08-06 #3: stagger is ADAPTIVE — capped so the whole wave stays
  // ~1.1s whether there are 12 models or 64. A fixed 55ms × model made the
  // full-catalog wave run 3.5s, so late models looked stuck on toggle.
  const stagger = Math.min(0.055, 1.1 / Math.max(1, models.length));
  models.forEach((m, mi) => {
    const pts = scPointsFor(m);
    // FORK 2026-08-06 #4: positions come from the SCALE-AWARE scCostX, and the
    // task-mode delta is the difference between two absolute positions — so the
    // same markup glides correctly on BOTH the log and the linear axis.
    const coords = pts.map((p) => {
      const xCost = scCostX(p.cost, s);
      const xTask = scCostX(p.cost * scTokenRatio(m.id, p.lvl), s);
      return { x: fx(xCost), y: fx(scY(p.smart, s)), dx: fx(xTask - xCost), p };
    });
    const delay = `${(mi * stagger).toFixed(2)}s`;
    // Highlight hooks. data-vendor drives the provider legend's dim/glow;
    // data-twin drives "hover one route, light every route to the same brain".
    const vAttr = ` data-vendor="${esc(m.vendorKey ?? m.provider)}"`;
    const tAttr = m.twinKey ? ` data-twin="${esc(m.twinKey)}"` : "";
    // data-model is per ROUTE, not per brain: it is what ties THIS model's circles
    // to THIS model's triangles so hovering either lights both (the architect 2026-08-27).
    // Deliberately NOT data-twin — that one means "other sellers of the same brain",
    // a different question, and folding the two would light half the chart.
    const mAttr = ` data-model="${esc(m.id)}"`;
    // The anchor is the published-price stop — found per model, not assumed to
    // be index 2, because ladders now vary in length (Grok has ONE stop, so
    // coords[2] would be undefined and the connector would crash).
    const anchorC = coords.find((c) => c.p.anchor) ?? coords[0];
    // The ENVELOPE no longer attaches here (2026-09-03). It used to take the anchor
    // stop of every considered model; it now marks FRONTIER RUNGS, resolved per
    // coordinate in the dots loop below — the router picks a (model, effort), so a
    // ring per rung is the only count that matches what the mark claims.
    if (m.twinKey && m.twinSpread) {
      twinAnchors.push({
        key: m.twinKey,
        x: anchorC.x,
        y: anchorC.y,
        dx: anchorC.dx,
        color: m.color,
      });
    }
    // TWO lines, because the constellation now carries two kinds of rung
    // (the architect 2026-08-30). The SOLID polyline joins only the rungs AA actually
    // scored — it is the measured intelligence curve and must not be diluted by
    // points that carry no measurement. The DASHED RAIL runs through every rung
    // the vendor exposes and is a COST ladder: it says "these settings exist and
    // cost this much", nothing about how smart they are. A model with full AA
    // coverage (only Opus 5 today) draws no rail at all, so nothing changes for it.
    const measuredC = coords.filter((c) => c.p.measured);
    // ESTIMATED rungs (the architect 2026-09-02) get a third line, DOTTED, through every rung
    // that carries a number we stand behind at ±1σ — measured or estimated. It is the
    // best available shape of the curve and is visibly not the solid measured line.
    // The dashed rail below is kept only while some rung has neither.
    const knownC = coords.filter((c) => c.p.measured || c.p.estimate);
    if (measuredC.length > 1) {
      linesCost +=
        `<polyline class="sc-line-cost"${vAttr}${tAttr}${mAttr} style="transition-delay:${delay}" points="${measuredC.map((c) => `${c.x},${c.y}`).join(" ")}"` +
        ` fill="none" stroke="${m.color}" stroke-opacity="0.34" stroke-width="1.1"/>`;
      linesTask +=
        `<polyline class="sc-line-task"${vAttr}${tAttr}${mAttr} style="transition-delay:${delay}" points="${measuredC.map((c) => `${fx(c.x + c.dx)},${c.y}`).join(" ")}"` +
        ` fill="none" stroke="${m.color}" stroke-opacity="0" stroke-width="1.1"/>`;
    }
    if (knownC.length > 1 && knownC.length > measuredC.length) {
      linesCost +=
        `<polyline class="sc-line-est-cost"${vAttr}${tAttr}${mAttr} style="transition-delay:${delay}" points="${knownC.map((c) => `${c.x},${c.y}`).join(" ")}"` +
        ` fill="none" stroke="${m.color}" stroke-opacity="0.3" stroke-width="1"` +
        ` stroke-dasharray="1.6 2.4" vector-effect="non-scaling-stroke"/>`;
      linesTask +=
        `<polyline class="sc-line-est-task"${vAttr}${tAttr}${mAttr} style="transition-delay:${delay}" points="${knownC.map((c) => `${fx(c.x + c.dx)},${c.y}`).join(" ")}"` +
        ` fill="none" stroke="${m.color}" stroke-opacity="0" stroke-width="1"` +
        ` stroke-dasharray="1.6 2.4" vector-effect="non-scaling-stroke"/>`;
    }
    if (coords.length > 1 && knownC.length < coords.length) {
      rails +=
        `<polyline class="sc-rail-cost"${vAttr}${tAttr}${mAttr} style="transition-delay:${delay}" points="${coords.map((c) => `${c.x},${c.y}`).join(" ")}"` +
        ` fill="none" stroke="${m.color}" stroke-opacity="0.2" stroke-width="0.9"` +
        ` stroke-dasharray="3 2.6" vector-effect="non-scaling-stroke"/>` +
        `<polyline class="sc-rail-task"${vAttr}${tAttr}${mAttr} style="transition-delay:${delay}" points="${coords.map((c) => `${fx(c.x + c.dx)},${c.y}`).join(" ")}"` +
        ` fill="none" stroke="${m.color}" stroke-opacity="0" stroke-width="0.9"` +
        ` stroke-dasharray="3 2.6" vector-effect="non-scaling-stroke"/>`;
    }

    // ─── API-PRICE CONSTELLATION (the architect 2026-08-27) ───
    // "draw a bunch of triangles connected by lines to describe the same model but
    // at API cost (its official price), slightly shaded, triangles defining the
    // different thinking efforts connected by dashed lines to their corresponding
    // circles of the same model in 20x subscription."
    //
    // Each triangle sits at the SAME y as the circle of the SAME effort — buying the
    // same brain through another door does not change how smart that effort is. The
    // dashed bridge is therefore horizontal by data. Across efforts the constellation
    // now climbs, because AA scored them separately.
    //
    // Only models whose plan price differs from list get a row (scApiPointsFor
    // returns [] otherwise), so the ~100 metered dots stay single marks and the
    // chart does not double in density to say nothing.
    const apiPts = scApiPointsFor(m);
    if (apiPts.length) {
      const aCoords = apiPts.map((p) => {
        const xCost = scCostX(p.cost, s);
        const xTask = scCostX(p.cost * scTokenRatio(m.id, p.lvl), s);
        return { x: fx(xCost), y: fx(scY(p.smart, s)), dx: fx(xTask - xCost), p };
      });
      apiMarks +=
        `<polyline class="sc-line-api-cost"${vAttr}${tAttr}${mAttr} style="transition-delay:${delay}"` +
        ` points="${aCoords.map((c) => `${c.x},${c.y}`).join(" ")}"` +
        ` fill="none" stroke="${m.color}" stroke-opacity="0.22" stroke-width="1"/>` +
        `<polyline class="sc-line-api-task"${vAttr}${tAttr}${mAttr} style="transition-delay:${delay}"` +
        ` points="${aCoords.map((c) => `${fx(c.x + c.dx)},${c.y}`).join(" ")}"` +
        ` fill="none" stroke="${m.color}" stroke-opacity="0" stroke-width="1"/>`;
      const mult = scApiMultiple(m);
      for (let i = 0; i < aCoords.length; i++) {
        const c = aCoords[i];
        // ONE MODEL, ONE MARK SIZE. This was `* (c.p.anchor ? 1 : 0.82)`, which made
        // the radius encode context window AND anchor-ness at once — see scRadius.
        const r = fx(scRadius(m.ctx, s));
        // Anchor-ness rides the stroke instead: 0.5 at the published-price stop, 0.3
        // at the stops derived from it. One channel, one meaning (SC_NONANCHOR_STROKE).
        const triSo = fx(0.5 * (c.p.anchor ? 1 : SC_NONANCHOR_STROKE));
        // Equilateral, point-up, centred on the price. Area tracks the circle's so a
        // triangle and its circle read as the same model at the same context window.
        const tri = `${fx(0)},${fx(-r)} ${fx(r * 0.87)},${fx(r * 0.5)} ${fx(-r * 0.87)},${fx(r * 0.5)}`;
        const apiTip =
          `${m.name} · ${c.p.label} — API list €${fmt(c.p.cost)}/Mtok` +
          (mult
            ? ` · ${mult >= 10 ? mult.toFixed(0) : mult.toFixed(1)}x what this plan pays`
            : "") +
          ` · ${scIdxTag(c.p)}` +
          ` · official published price, not our effective cost`;
        apiMarks +=
          `<g class="sc-apipos" transform="translate(${c.x}, ${c.y})"${vAttr}${tAttr}${mAttr}>` +
          `<g class="sc-apig" style="--sc-dx:${c.dx}px;transition-delay:${delay}">` +
          `<polygon class="sc-tri" points="${tri}" fill="${m.color}" fill-opacity="0.1"` +
          ` stroke="${m.color}" stroke-opacity="${triSo}" stroke-width="1.1"` +
          ` vector-effect="non-scaling-stroke"/>` +
          `<circle r="${fx(r + 4)}" fill="transparent"><title>${esc(apiTip)}</title></circle>` +
          `</g></g>`;
        // One dashed bridge per effort stop, joining a triangle to the circle it
        // belongs to. Both ends share a y, so the bridge comes out horizontal from
        // the data rather than by being forced flat — the same property the twin
        // connectors rely on. Cream, like the twin connector: the line is a
        // RELATIONSHIP (two prices for one token), not either price's identity.
        const cc = coords[i] ?? anchorC;
        bridges +=
          `<line class="sc-bridge-cost"${vAttr}${tAttr}${mAttr} x1="${cc.x}" y1="${cc.y}"` +
          ` x2="${c.x}" y2="${c.y}" stroke="#f0e6d8" stroke-opacity="0.16" stroke-width="0.8"` +
          ` stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>` +
          `<line class="sc-bridge-task"${vAttr}${tAttr}${mAttr} x1="${fx(cc.x + cc.dx)}" y1="${cc.y}"` +
          ` x2="${fx(c.x + c.dx)}" y2="${c.y}" stroke="#f0e6d8" stroke-opacity="0" stroke-width="0.8"` +
          ` stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>`;
      }
    }
    for (let i = 0; i < coords.length; i++) {
      const c = coords[i];
      // Is THIS rung on the thalamus frontier, and is it the dial's pick? Addressed
      // by (model, effort) — the same key frontierRungsFor produced, so the ring can
      // only land on the circle whose numbers the frontier was computed from.
      const rungTag = scRungTag({ key: m.id, effort: c.p.lvl });
      const onFrontier = thalFrontierSet.has(rungTag);
      const isPick = onFrontier && rungTag === thalPickTag;
      if (onFrontier) envAt.set(rungTag, { x: c.x, y: c.y, dx: c.dx });
      // ONE MODEL, ONE CIRCLE SIZE (the architect 2026-08-30: "opus 5 seems to have different
      // sizes in the same model, impossible, must be a bug"). He was right: this used
      // to multiply the radius by 0.82 on every non-anchor stop, so Opus 5 — one
      // model, one context window, five effort rungs — rendered at two radii. Radius
      // now means only what scRadius says it means: area ∝ context window.
      const r = fx(scRadius(m.ctx, s));
      // The published-price stop is told apart by ring WEIGHT, not by being bigger:
      // 0.95 at the anchor, 0.57 at the derived stops (SC_NONANCHOR_STROKE).
      let ringSo = fx(0.95 * (c.p.anchor ? 1 : SC_NONANCHOR_STROKE));
      // A rung AA never scored is drawn DASHED and fainter. This is the whole
      // safeguard: its y is the model's headline index, so it must never be
      // mistakable for a measured point at a glance.
      // An ESTIMATED rung is DOTTED (finer than the rail's dashes) and a touch fainter
      // than measured; a rail rung keeps its dashes and drops further.
      const railDash = c.p.measured
        ? ""
        : c.p.estimate
          ? ` stroke-dasharray="1.2 1.7"`
          : ` stroke-dasharray="2.6 2.2"`;
      if (!c.p.measured) ringSo = fx(Number(ringSo) * (c.p.estimate ? 0.8 : 0.6));
      // ghost at the landing spot — visible only in task mode (CSS)
      ghosts +=
        `<g class="sc-ghostpos"${vAttr}${tAttr}${mAttr} transform="translate(${fx(c.x + c.dx)}, ${c.y})">` +
        `<circle class="sc-ghost" style="transition-delay:${delay}" r="${r}"` +
        ` fill="none" stroke="${m.color}" stroke-opacity="0.3" stroke-width="0.8"` +
        ` stroke-dasharray="2.4 2.2" vector-effect="non-scaling-stroke"/></g>`;
      // the dot: an OUTLINE circle carrying the model logo (the architect 2026-08-06 #2),
      // positioned by CSS custom properties so the task-mode toggle can glide it.
      const tokens = scTokensPerTask(m.id, c.p.lvl);
      const tip =
        `${m.name} · ${c.p.label} — €${fmt(c.p.cost)}/Mtok` +
        ` · ~${scFmtTokens(tokens)}/task · ${scFmtCtx(m.ctx)} ctx` +
        ` · ${scIdxTag(c.p, " (AA)")}` +
        // Two dots with the same name are two SELLERS of one brain — say which
        // this is, and whether the other routes cost the same.
        (m.twinN
          ? ` · via ${scRouteTag(m)} · ${m.twinN} routes${m.twinSpread ? "" : ", same price"}`
          : "") +
        // The plan-vs-list gap, stated on the circle itself. Without it the only way
        // to read the discount is to eyeball the dashed bridge, and a ~340x gap on a
        // log axis is easy to under-read by an order of magnitude.
        (() => {
          const list = scApiPrice(m.id);
          if (list === undefined) return "";
          const mult = scApiMultiple(m);
          if (mult === undefined) return " · this IS the API list price";
          const listAtEffort = list * (EEG_EFFORT_MULT[c.p.lvl] ?? 1);
          return ` · API list €${fmt(listAtEffort)}/Mtok = ${mult >= 10 ? mult.toFixed(0) : mult.toFixed(1)}x this plan`;
        })() +
        (scIsUtilDrag(m)
          ? ` · drawn at ${Math.round(SC_PLAN_UTIL * 100)}% of the quota ceiling (the average we use to turn a flat fee into €/Mtok) · drag toward the triangle to see other utilisation`
          : "");

      const logoSize = fx(Math.max(5, r * 1.25));
      // Logo is placed at the GROUP ORIGIN (the group is translated to its
      // chart position via CSS), so ring + logo + hit-area glide as one body.
      const logo = scLogoFor(m).replace(
        /^<svg /,
        `<svg x="${fx(-logoSize / 2)}" y="${fx(-logoSize / 2)}" width="${logoSize}" height="${logoSize}" `,
      );
      // FORK 2026-08-06 #6 (the architect: "logos are not in the right place, I see a
      // few out of the graph top-left. Also I don't see the circle outlines"):
      // the base position now lives in an SVG TRANSFORM ATTRIBUTE on an outer
      // <g class="sc-dotpos"> — always applied, always in user space, scales
      // with the viewBox. The old CSS transform(var(--sc-x),var(--sc-y)) for
      // the BASE position silently collapsed dots to the SVG origin in the architect's
      // browser (logos top-left, rings invisible). CSS now carries ONLY the
      // task-mode glide delta. Ring stroke widened so the outline reads clearly.
      const utilDrag = scIsUtilDrag(m);
      const listHere = scApiPrice(m.id);
      const listAtEffort =
        listHere === undefined ? undefined : listHere * (EEG_EFFORT_MULT[c.p.lvl] ?? 1);
      const dragAttr =
        utilDrag && listAtEffort !== undefined
          ? ` data-util-drag="1" data-home-x="${c.x}" data-home-y="${c.y}" data-home-cost="${c.p.cost}" data-list-cost="${listAtEffort}" data-list-x="${fx(scCostX(listAtEffort, s))}"`
          : "";
      // data-effort names the rung (2026-09-03) so a test or the app can address ONE
      // circle as (model, effort) — the frontier's own key — without parsing the tip.
      const eAttr = ` data-effort="${esc(c.p.lvl)}"`;
      dots +=
        `<g class="sc-dotpos" transform="translate(${c.x}, ${c.y})"${vAttr}${tAttr}${mAttr}${eAttr}${dragAttr}>` +
        `<g class="sc-dotg" style="--sc-x:${c.x}px;--sc-y:${c.y}px;--sc-dx:${c.dx}px;transition-delay:${delay}">` +
        // THALAMUS RING — "bigger circle" (the architect). Emitted FIRST so it paints UNDER
        // the model's own ring and logo, this file's twice-stated rule that a
        // relationship mark goes under the thing it relates.
        //
        // It lives INSIDE .sc-dotg deliberately: that group carries BOTH the €/task
        // glide (--sc-dx) and the --sc-k inverse-zoom counter-scale. Outside it the
        // ring would grow on zoom while its own dot did not, and would detach from
        // the dot the instant the toggle flipped.
        //
        // `c === anchorC`, NOT `c.p.anchor`: a ladder whose stops carry no anchor
        // flag falls back to coords[0], and testing the flag would emit no ring at
        // all for it — the same identity check envPts is gated on above, so the ring
        // count and the vertex count cannot disagree.
        //
        // THE PICK IS HEAVIER, NOT BIGGER. Weight and opacity only: size on this
        // chart is spoken for (area ∝ context window — scRadius), and a second
        // radius for the pick would re-introduce the exact two-radii bug scRadius
        // documents. Colour is spoken for too (model identity), which is why the
        // envelope needed a hue no vendor owns.
        //
        // NO data-* attribute, DELIBERATELY: applyFocus (app.ts:17866) only ever
        // toggles .sc-hl on [data-vendor],[data-twin],[data-model], and every dim
        // rule in base.css names its classes one by one, so nothing dims the
        // envelope BY NAME — "can thalamus reach this model" is not a question a
        // vendor latch changes. THE RING IS THE ONE PARTIAL CASE, stated rather than
        // hidden: its ancestor <g class="sc-dotpos"> IS dimmed to opacity 0.13 under
        // a latch (base.css:9957-9964), and CSS group opacity is a compositing floor
        // a descendant cannot climb back out of, so a ring fades with the dot it
        // belongs to. Mechanic 2 (inside .sc-dotg) and "stays lit" cannot both hold
        // for the ring; mechanic 2 wins because its failure — a ring that grows on
        // zoom and detaches on the toggle — is a concrete visible defect, and
        // because a ring arguably belongs to its dot. The PATH is a top-level layer
        // and is fully independent: it stays lit under any latch.
        //
        // `onFrontier`, NOT the anchor (2026-09-03): the ring marks a FRONTIER RUNG,
        // so one model may carry several rings (Opus 5 carries five when every rung
        // is up-left of everything cheaper) and a considered-but-dominated model
        // carries none. The pick is the rung biasPick chose for the session's dial.
        (onFrontier
          ? `<circle class="sc-env-ring${isPick ? " sc-env-pick" : ""}"` +
            ` r="${fx(r + SC_ENV_RING_GAP)}" fill="none" stroke="${SC_THALAMUS}"` +
            ` stroke-opacity="${isPick ? "0.95" : "0.6"}"` +
            ` stroke-width="${isPick ? "2.2" : "1.2"}" vector-effect="non-scaling-stroke"/>`
          : "") +
        `<circle class="sc-ring" r="${r}" fill="${m.color}" fill-opacity="${c.p.measured ? 0.07 : c.p.estimate ? 0.045 : 0.02}" stroke="${m.color}"${railDash}` +
        ` stroke-opacity="${ringSo}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>` +
        `<g class="sc-logo" pointer-events="none">${logo}</g>` +
        `<circle r="${fx(r + 4)}" fill="transparent"><title>${esc(tip)}</title></circle>` +
        // PER RUNG, deliberately. `.sc-util-pct` is opacity:0 until its own dot
        // carries .sc-util-sliding, so exactly ONE is ever visible — the one being
        // dragged. Gating this to the anchor (tried and reverted 2026-08-30) would
        // leave a non-anchor rung with no readout while you drag it.
        (utilDrag
          ? `<text class="sc-util-pct" y="${fx(-(r + 10))}" text-anchor="middle" dominant-baseline="alphabetic"` +
            ` font-family="'SF Mono',ui-monospace,monospace" fill="#f0e6d8" fill-opacity="0.95"` +
            ` pointer-events="none">${Math.round(SC_PLAN_UTIL * 100)}%</text>`
          : "") +
        `</g></g>`;
    }
  });

  // ─── twin connectors ───
  // One dashed segment per ADJACENT pair of routes to the same brain, drawn
  // between their medium-effort anchors. Twins share an AA index, so the two
  // anchors share a y and the segment comes out horizontal on its own — the
  // "obviously horizontal" the architect asked for is a property of the data, not a
  // constraint imposed on the drawing. Should a route ever carry a different
  // index, the segment tilts and says so rather than lying flat.
  //
  // Cream, not either vendor's colour: the line is the RELATIONSHIP between two
  // sellers, and painting it one seller's identity would claim it belongs to
  // that seller. Same cost/task crossfade as the constellation polylines.
  //
  // Groups whose routes cost the SAME never reach here (twinSpread === false),
  // so this layer cannot emit a zero-length dash implying a price gap that the
  // data does not contain.
  let twins = "";
  const byTwin = new Map<string, typeof twinAnchors>();
  for (const a of twinAnchors) {
    const g = byTwin.get(a.key);
    if (g) g.push(a);
    else byTwin.set(a.key, [a]);
  }
  for (const group of byTwin.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((p, q) => p.x - q.x);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const key = esc(a.key);
      twins +=
        `<line class="sc-twin-cost" data-twin="${key}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"` +
        ` stroke="#f0e6d8" stroke-opacity="0.26" stroke-width="0.9" stroke-dasharray="3.5 3"` +
        ` vector-effect="non-scaling-stroke"/>` +
        `<line class="sc-twin-task" data-twin="${key}" x1="${fx(a.x + a.dx)}" y1="${a.y}"` +
        ` x2="${fx(b.x + b.dx)}" y2="${b.y}"` +
        ` stroke="#f0e6d8" stroke-opacity="0" stroke-width="0.9" stroke-dasharray="3.5 3"` +
        ` vector-effect="non-scaling-stroke"/>`;
    }
  }

  // ─── thalamus envelope PATH + footer ───
  // ONE traversal order — the FRONTIER's own (task cost ascending, intelligence
  // strictly increasing) — reused by BOTH copies. Nothing is re-sorted here: the
  // order is paretoFrontier's, computed on €/task, which is the axis the architect defined
  // the envelope on (2026-09-02).
  //
  // THE TASK COPY IS THE HONEST ONE. Its vertices are the frontier at their per-task
  // positions, so x is non-decreasing and y is STRICTLY decreasing (smarter = higher
  // on the plot) by construction — a dip there is impossible and a test pins it.
  // The COST copy joins the SAME rungs at their €/Mtok positions and MAY zig-zag: a
  // verbose model is cheap per token and dear per task, so per-token it sits left of
  // a frontier neighbour it is right of per task. That is not a defect to smooth — it
  // is exactly the fact the task toggle exists to show.
  //
  // EQUAL X IS COMMON AND IS NOT A DEFECT: same price, different intelligence is a
  // vertical segment, and collapsing it would hide a real fact.
  //
  // DOUBLE EMIT, like every other positional layer here (sc-line-*, sc-bridge-*,
  // sc-twin-*): the cost copy at x, the task copy at x + dx, CSS cross-fading the
  // pair (the <style> block in `defs`). One copy alone detaches from its dots the
  // moment the toggle flips — invisible in the DEFAULT view, so it would ship
  // unseen. scEnvPathPoints handles the four degenerate cases: 0 rungs and 1 rung
  // emit NO path (the footer still speaks), 2 rungs are one segment, and coincident
  // points are deduped before joining. A frontier rung with no resolved pixel (a
  // ladder the chart did not draw) is skipped rather than invented.
  const envOrdered: { x: number; y: number; dx: number }[] = [];
  for (const r of thalFrontier) {
    const at = envAt.get(scRungTag(r));
    if (at) envOrdered.push(at);
  }
  const envCost = scEnvPolylineSvg("sc-env-cost", scEnvPathPoints(envOrdered), SC_ENV_PATH_OPACITY);
  const envTask = scEnvPolylineSvg(
    "sc-env-task",
    scEnvPathPoints(envOrdered.map((p) => ({ x: p.x + p.dx, y: p.y }))),
    0,
  );

  // THE FOOTER IS MANDATORY, NOT DECORATION. An empty envelope and a broken layer
  // look identical on screen, and the whole point of the mark is that a brand-new
  // frontier model with NO ring reads as "thalamus cannot reach it" rather than as
  // "the chart failed". Every figure comes off the payload — see
  // scThalamusFooterLine for why a literal count would itself be the stale list
  // this feature exists to detect. The caveat suffix names the checks that did NOT
  // run and disappears on its own once a later unit wires them.
  //
  // No data-* here either, same reason as the path: the footer must survive a latch.
  // The LAST row is drawn at y = H - 7 = 593 — below the axis caption at MT + PH + 30 = 564
  // and far below the plot floor at MT + PH = 534, so it lands in genuinely free
  // space; earlier rows stack upward by SC_FOOTER_ROW_H (scWrapFooter says why the
  // line wraps on its own separators). The text is itself in SC_THALAMUS, which IS
  // the legend (the same trick scCtxLegendSvg uses) and buys back the width a drawn
  // swatch would have cost the longest line. Every row carries the full line in its
  // <title> behind the standing explanation, so a clipped row loses nothing on hover.
  const envCaveats = [
    opts?.thalamusSnapshot === undefined ? "no quota snapshot" : "",
    opts?.thalamusAllowedModelKeys === undefined ? "no auth filter" : "",
  ].filter((c) => c !== "");
  const envLine = scThalamusFooterLine(
    thal,
    { rungs: thalRungs, frontier: thalFrontier, biasIdx: thalBiasIdx },
    envCaveats,
  );
  const envRows = scWrapFooter(envLine);
  let envFooter = "";
  for (let i = 0; i < envRows.length; i++) {
    const y = H - 7 - (envRows.length - 1 - i) * SC_FOOTER_ROW_H;
    envFooter +=
      `<text class="sc-env-foot" x="${ML}" y="${y}" text-anchor="start" font-size="7"` +
      ` fill="${SC_THALAMUS}" fill-opacity="0.85"` +
      ` font-family="'SF Mono',ui-monospace,monospace">` +
      `${esc(envRows[i])}` +
      `<title>${esc(`${SC_THALAMUS_FOOTER_TITLE}\n\n${envLine}`)}</title></text>`;
  }

  // labels at the MAX-effort point, de-collided greedily by y; labels glide
  // with their constellation (same --sc-dx as the dots). ONLY labelled models
  // get text — the rest live in their tooltips.
  //
  // FORK 2026-08-06 #11 (the architect: "the model names need to be exactly at the same
  // height than its highest effort bubble"). The greedy y de-collision that used
  // to nudge crowded names apart is GONE: a name a few px off its own dot is a
  // name pointing at the wrong model, which is worse than two names overlapping —
  // and overlap resolves itself the moment you zoom, because the dots spread while
  // the names keep their size. dominant-baseline="central" puts the text's middle
  // on the dot's centre, so "same height" is exact, not approximated by a baseline
  // nudge.
  //
  // FORK 2026-08-06 #10 (the architect: "the model names should be to the right of its
  // most effort bubble, and should approach the circle as I zoom in, otherwise
  // it renders out of view"). Two changes, one cause. The label used to carry
  // its final position in its x/y ATTRIBUTES — chart units — so its distance
  // from the dot was fixed in CHART space and therefore grew on screen with
  // every zoom step, until the name sat off-screen while its dot was centred.
  // Now the label is anchored ON the dot (a translate on an outer <g>) and the
  // gap + the de-collision offset ride --sc-k, the same inverse-zoom the markers
  // counter-scale by: constant on-screen distance, so the name closes in on its
  // circle as you zoom. The right/left flip is gone — always right of the
  // max-effort bubble, as asked.
  // SAME-PRICED routes share one label (the architect 2026-08-24, caught in the render).
  // A price-spread twin puts its two names at two different x, so they read fine
  // and each needs its own. A ZERO-spread group is the opposite: openai,
  // openai-codex and codex all sell gpt-5.6-sol at 0.2679, so the three dots sit
  // on EXACTLY the same coordinates and three labels print on top of each other.
  // Crowding elsewhere resolves when you zoom — this one never can, because the
  // points are identical at every scale. So the group prints ONCE, listing every
  // route: "gpt-5.6-sol (openai · openai-codex · codex)". Nothing is hidden; the
  // one label says strictly more than the three unreadable ones did.
  const sameCostRoutes = new Map<string, string[]>();
  for (const m of models) {
    if (!m.twinKey || m.twinSpread !== false) continue;
    const acc = sameCostRoutes.get(m.twinKey);
    if (acc) acc.push(scRouteTag(m));
    else sameCostRoutes.set(m.twinKey, [scRouteTag(m)]);
  }
  const labelledSameCost = new Set<string>();
  const labelCands = models
    .filter((m) => {
      if (m.labeled === false) return false;
      if (!m.twinKey || m.twinSpread !== false) return true;
      // first member of a same-priced group carries the label for all of them
      if (labelledSameCost.has(m.twinKey)) return false;
      labelledSameCost.add(m.twinKey);
      return true;
    })
    .map((m, mi) => {
      // The label hangs off the model's DEAREST stop — which is its own last
      // one, not a fixed "max" that most models never had.
      const pts = scPointsFor(m);
      const p = pts[pts.length - 1];
      const xCost = scCostX(p.cost, s);
      const xTask = scCostX(p.cost * scTokenRatio(m.id, p.lvl), s);
      return {
        name: m.name,
        id: m.id,
        // A twin prints WHICH route this dot is. Without it the chart shows
        // "gpt-5.5" twice, 62x apart, with no way to tell which one you can buy
        // at which price — the whole point of un-folding them.
        route: m.twinN ? (sameCostRoutes.get(m.twinKey ?? "")?.join(" · ") ?? scRouteTag(m)) : "",
        isCopilot: scIsCopilot(m),
        vendor: m.vendorKey ?? m.provider,
        twin: m.twinKey ?? "",
        color: m.color,
        x: xCost,
        y: scY(p.smart, s),
        // Horizontal air between the mark and the first glyph (base.css translates
        // .sc-label by --sc-gap). It has to clear the ring the name hangs off — the
        // model's DEAREST stop, picked just above — and every stop now draws at the
        // model's full context radius, so that ring is exactly scRadius(ctx) wide and
        // +5 is the air itself. Was `* 0.82 + 5`, sized for a shrunken non-anchor ring
        // that no longer exists: against a full-size one it leaves 5 − 0.18·r of air,
        // i.e. ~2.8px at R_MAX, and the name crowds the circle it is naming.
        gap: scRadius(m.ctx, s) + 5,
        dx: xTask - xCost,
        delay: `${(mi * stagger).toFixed(2)}s`,
      };
    });
  let labels = "";
  for (const l of labelCands) {
    labels +=
      // transform stays IMMEDIATELY after the class — the label-position tests
      // (and the anchor regexes they use) read the two as adjacent.
      `<g class="sc-labelpos" transform="translate(${fx(l.x)}, ${fx(l.y)})"` +
      ` data-vendor="${esc(l.vendor)}"${l.twin ? ` data-twin="${esc(l.twin)}"` : ""}` +
      ` data-model="${esc(l.id)}">` +
      `<text class="sc-label" style="--sc-dx:${fx(l.dx)}px;--sc-gap:${fx(l.gap)}px;` +
      `transition-delay:${l.delay}"` +
      ` x="0" y="0" text-anchor="start" dominant-baseline="central"` +
      ` font-family="'SF Mono',ui-monospace,monospace" fill="${l.color}" fill-opacity="0.85">${esc(l.name)}` +
      // Copilot keeps the pink it has always had; other routes tag in cream so
      // the tag never competes with the model's own identity colour.
      (l.route
        ? `<tspan class="sc-route-note" fill="${l.isCopilot ? SC_COPILOT_PINK : "#f0e6d8"}"` +
          ` fill-opacity="${l.isCopilot ? "0.95" : "0.55"}"> (${esc(l.route)})</tspan>`
        : "") +
      `</text></g>`;
  }

  return (
    // FORK 2026-08-06 #5: no fixed width/height attributes — the chart fills its
    // container via CSS (.sc-svg { width:100%;height:100% }) and the viewBox +
    // preserveAspectRatio scale the 900x600 drawing to fit, centered, ratio kept.
    // Fixed attributes fought the CSS and let dots overflow the window.
    `<svg class="sc-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">` +
    // The twin layer sits UNDER the constellations and dots: it is the
    // relationship between two sellers, so it must never draw over the things
    // it relates. (It was assembled but never emitted until 2026-08-24 — the
    // connectors existed in the string and rendered nowhere.)
    // The API layer sits UNDER the twin connectors and the dots: it is the price we
    // are NOT paying, so it must never draw over the price we are. The bridges go
    // below the triangles for the same reason a twin connector goes below its dots.
    `${defs}${bg}${grid}${axes}<g class="sc-bridgelayer">${bridges}</g>` +
    `<g class="sc-apilayer">${apiMarks}</g>` +
    `<g class="sc-twinlayer">${twins}</g>` +
    // The envelope PATH sits between the twin connectors and the constellations,
    // by this file's own rule stated twice above: a relationship layer goes UNDER
    // the things it relates. It describes which models thalamus reaches; it must
    // never draw over the models themselves. Task copy before cost copy, matching
    // the ${linesTask}${linesCost} order right after it.
    `<g class="sc-envlayer">${envTask}${envCost}</g>` +
    // The dashed COST rail sits directly under the measured curve it qualifies: it
    // is the weaker claim of the two and must never draw over the line that carries
    // real measurements. Below the envelope for the same reason the envelope is
    // below the dots — each layer sits under the thing it describes.
    `<g class="sc-raillayer">${rails}</g>` +
    `${linesTask}${linesCost}${ghosts}` +
    // FORK 2026-08-06 #9 (the architect: "make the load and the zoom faster"): the neon
    // bloom was `filter="url(#sc-glow)"` on EVERY ring — 132 separate Gaussian
    // blur passes, re-run on each viewBox change, which is what made zooming
    // crawl. One filter on the dot LAYER renders the same bloom in a single pass.
    `<g class="sc-dotlayer" filter="url(#sc-glow)">${dots}</g>${labels}${envFooter}</svg>`
  );
}
