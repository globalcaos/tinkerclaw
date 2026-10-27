// src/shared/thalamus-frontier.ts
//
// THE FRONTIER THALAMUS ROUTES ALONG — one module, imported by the smart × cost chart
// (the yellow envelope) and by the reply-path Auto router, so the line the architect sees and
// the model that actually answers cannot disagree.
//
// FORK 2026-09-02 (the architect): "the yellow envelope … is a complete disaster. They are
// supposed to be picked as up-left as possible, basically defining the top-left
// outline … make sure the yellow envelope line shows the best intelligence/price
// models and that Thalamus actually automatically switches among them smartly,
// following the BIAS selected in the slider … routes intelligently depending on the
// task at hand, following the Fugu family of harnesses approach."
//
// WHAT WAS WRONG. thalamus-candidates.ts answers "which models CAN thalamus reach"
// (everything routable under a 1.5x cost ceiling), and the chart drew a polyline
// through ALL of them in cost order. That is the ladder's extent, not a frontier, so
// it zig-zagged by construction. And nothing on the gateway read the BIAS dial:
// prefrontal.orcaBias wrote ~/.openclaw/orca-bias.json for the ORCA Conductor only,
// while the reply path's Auto routing was the quota-exhaustion fallback and nothing
// else.
//
// WHAT THIS MODULE DOES, in three pure steps:
//   1. RUNGS. Every reachable (model, thinking effort) is a point on the chart's
//      €/TASK axis — the architect 2026-09-02: "make sure to use the graph in €/task to make
//      the envelope, not the €/token". cost = the route's €/Mtok x
//      tokenRatioFor(model, effort) (tokens-per-task.ts, normalised to Opus 5 @high
//      like the chart's task view; the effort ladder is already IN those tokens, so it
//      is applied once — see taskCostFactor, 2026-09-30); smart = AA's measured
//      index at that effort, else the flagged estimate (aa-effort-estimate.ts), else
//      the headline index. A verbose model is therefore DEARER per task than its
//      token price suggests, which is exactly the point of that axis.
//   2. FRONTIER. The Pareto set of those rungs: no other rung is both cheaper-or-equal
//      AND smarter-or-equal. Sorted by cost, its intelligence is STRICTLY increasing,
//      so the envelope drawn through it is the top-left outline and can never dip.
//   3. PICK. The BIAS dial (0 fast … 6 smart, routing-rationale.ts BIAS_STOPS) maps to
//      how many AA points below the frontier's best the router will trade for price
//      (THALAMUS_BIAS_GAP). The pick is the CHEAPEST frontier rung inside that band.
//      Task routing (the Fugu / J6 §3.6 idea — expertise-matched, per-domain) then
//      looks at every rung in the band, not only the frontier, and switches to the
//      model with the strongest MEASURED strength in the prompt's domain when that
//      advantage is material. Domain strengths are percentiles over Epoch AI's public
//      benchmark tables (domain-strength.generated.ts), never opinions.
//
// PURE and browser-safe: no I/O, no clock, every input is an argument. The gateway
// reads the bias file and the prompt; the chart reads the dial; both call the same
// functions with the same tables.

import { aaEstimateAt, aaFamilyOf, aaScoreAt } from "./aa-effort-index.js";
import { DOMAIN_STRENGTH } from "./domain-strength.generated.js";
import { resolveProviderEffortLadder } from "./provider-effort-ladders.js";
import { tokenRatioFor } from "./tokens-per-task.js";

export type RungBasis = "measured" | "estimated" | "headline";

/** One (model route, thinking effort) point on the smart × cost plane. */
export type FrontierRung = {
  /** `provider/model` route key. */
  key: string;
  /** Vendor effort level, or "" when the route has no graded ladder. */
  effort: string;
  /** AA Intelligence Index (measured, estimated or headline — see `basis`). */
  smart: number;
  /** €/TASK at this effort, on the chart's task axis: route relCost x
   *  tokenRatioFor(model, effort), effort counted once. NOT €/Mtok. */
  cost: number;
  basis: RungBasis;
};

/**
 * The rungs one route contributes. A route with no graded ladder is one rung at its
 * headline index and its published price — the same rule the chart's `scSoleStop`
 * applies, so a model draws and routes as the same points.
 */
export function frontierRungsFor(key: string, index: number, relCost: number): FrontierRung[] {
  const slash = key.indexOf("/");
  const provider = slash > 0 ? key.slice(0, slash) : "";
  const model = slash > 0 ? key.slice(slash + 1) : key;
  if (!Number.isFinite(index) || !Number.isFinite(relCost) || relCost <= 0) return [];
  const ladder = resolveProviderEffortLadder(provider, model);
  if (ladder.kind !== "graded" || ladder.levels.length === 0) {
    return [
      { key, effort: "", smart: index, cost: relCost * tokenRatioFor(key, ""), basis: "headline" },
    ];
  }
  return ladder.levels.map((effort) => {
    const measured = aaScoreAt(key, effort);
    const est = measured === undefined ? aaEstimateAt(key, effort) : undefined;
    return {
      key,
      effort,
      smart: measured ?? est?.v ?? index,
      cost: relCost * tokenRatioFor(key, effort),
      basis: measured !== undefined ? "measured" : est ? "estimated" : "headline",
    };
  });
}

function byCostThenSmart(a: FrontierRung, b: FrontierRung): number {
  return (
    a.cost - b.cost ||
    b.smart - a.smart ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
    (a.effort < b.effort ? -1 : a.effort > b.effort ? 1 : 0)
  );
}

/**
 * The Pareto frontier: cost non-decreasing, intelligence STRICTLY increasing.
 *
 * A rung survives only if it is smarter than every rung that costs the same or less.
 * Equal cost keeps the smarter rung; equal intelligence keeps the cheaper. The
 * result is the top-left outline of the cloud — the only shape an "envelope of the
 * best intelligence/price models" can honestly have.
 */
export function paretoFrontier(rungs: readonly FrontierRung[]): FrontierRung[] {
  const sorted = [...rungs].filter((r) => Number.isFinite(r.cost) && Number.isFinite(r.smart));
  sorted.sort(byCostThenSmart);
  const out: FrontierRung[] = [];
  let best = -Infinity;
  for (const r of sorted) {
    if (r.smart > best) {
      out.push(r);
      best = r.smart;
    }
  }
  return out;
}

/**
 * How many AA points below the frontier's BEST rung each BIAS stop accepts, indexed
 * exactly like routing-rationale.ts BIAS_STOPS (0 fast · 1 quick · 2 lean · 3 balanced
 * · 4 deep · 5 wide · 6 smart). The pick is the CHEAPEST frontier rung inside the
 * band, so turning the dial right narrows the band toward the best model and left
 * widens it toward cheaper ones. 15 points at "fast" is roughly a generation: on the
 * 2026-09-02 board it spans Fable 5.1 max (65.7) down to Kimi K3 / GLM 5.3 (~59).
 */
export const THALAMUS_BIAS_GAP: readonly number[] = [15, 10, 7, 5, 3, 1.5, 0];

/**
 * Where the dial sits when nobody has set it: the MIDDLE stop, "default" (the architect, 2026-10-02, full deploy:
 * "an unset dial is default"). It was SMART from 2026-10-01 to 2026-10-02. One constant for the gateway's
 * router, the tier bands and the page's dial, so an unset dial can never mean two things.
 */
export const THALAMUS_DEFAULT_BIAS_IDX = 3;

export function clampBiasIdx(biasIdx: number | undefined): number {
  const n = Number.isFinite(biasIdx) ? Math.round(biasIdx as number) : THALAMUS_DEFAULT_BIAS_IDX;
  return Math.max(0, Math.min(THALAMUS_BIAS_GAP.length - 1, n));
}

/** The intelligence floor the dial sets: frontier best minus the stop's gap. */
export function biasTarget(frontier: readonly FrontierRung[], biasIdx: number | undefined): number {
  if (frontier.length === 0) return -Infinity;
  const best = frontier[frontier.length - 1].smart;
  return best - THALAMUS_BIAS_GAP[clampBiasIdx(biasIdx)];
}

/** The cheapest frontier rung at or above the dial's floor. */
export function biasPick(
  frontier: readonly FrontierRung[],
  biasIdx: number | undefined,
): FrontierRung | undefined {
  const target = biasTarget(frontier, biasIdx);
  return frontier.find((r) => r.smart >= target);
}

// ─── the ANCHORED dial (2026-09-03) ─────────────────────────────────────────────────────────
//
// WHY THE ANCHOR MOVED. `biasTarget` measures its gap DOWN FROM THE BEST RUNG ON THE BOARD, and
// the best rung is Fable 5.1 at max. Two defects follow from that one choice, and the architect
// named both on 2026-09-03: "the balanced default should be mainly opus 5, avoiding Fable".
//
//   1. BALANCED DID NOT MEAN OPUS. At bias 3 the floor was best − 5 ≈ 60.7, and the pick is the
//      CHEAPEST frontier rung above it — on the live board a non-Anthropic model, not Opus 5.
//   2. THE DIAL WAS MEASURED AGAINST THE MODEL WE WANT TO AVOID. There was no vocabulary in
//      which "avoid Fable" could even be said.
//
// So the dial is anchored on a REFERENCE RUNG — Opus 5 — and the top model is RESERVED: never
// reached by drifting, only by a named reason (the top stop, a ballistic window, or a
// feasibility veto that leaves nothing else). The panel prints which of the three opened it,
// because a reserved model that arrives unexplained is indistinguishable from a bug.

/** The rung the dial is anchored on: bias 3 (balanced) resolves here whenever it is reachable. */
export const THALAMUS_ANCHOR_KEY = "claude-code/claude-opus-5";

/** Never reached by drifting. Opened only by the top stop, ballistic, or feasibility. */
export const THALAMUS_RESERVED_RE = /fable/i;

export function isReservedKey(key: string): boolean {
  return THALAMUS_RESERVED_RE.test(key);
}

/** AA points below the ANCHOR each stop at or below balanced accepts. Index 3 is the anchor. */
export const THALAMUS_BELOW_ANCHOR: readonly number[] = [15, 10, 5, 0];

/** Above balanced, how many times the anchor's €/task the pick may cost. Infinity ⇒ no cap. */
export const THALAMUS_ABOVE_ANCHOR_COST_MULT: readonly number[] = [2, Infinity, Infinity];

export type AnchoredPickOptions = {
  /** Route key the dial is anchored on. Defaults to `THALAMUS_ANCHOR_KEY`. */
  anchorKey?: string;
  /** Admit the reserved set. The caller owns the reason and reports it. */
  allowReserved?: boolean;
};

/**
 * The anchor rung: the SMARTEST frontier rung belonging to the anchor model that the current
 * admissibility allows. When the anchor is not on the frontier at all — dominated, unreachable,
 * or vetoed — the anchor degrades to the best admissible rung, which reproduces the old
 * top-of-board behaviour for exactly the boards where an Opus anchor is meaningless.
 */
export function anchorRung(
  frontier: readonly FrontierRung[],
  opts?: AnchoredPickOptions,
): FrontierRung | undefined {
  const key = opts?.anchorKey ?? THALAMUS_ANCHOR_KEY;
  const own = admissibleRungs(frontier, opts).filter((r) => r.key === key);
  return own.length > 0 ? own[own.length - 1] : undefined;
}

/** The frontier minus the reserved set, unless the caller opened it. Never returns empty when
 *  the frontier is non-empty: a board made ENTIRELY of reserved rungs is a feasibility outcome,
 *  and refusing to route at all would be worse than routing to the only thing left. */
function admissibleRungs(
  frontier: readonly FrontierRung[],
  opts?: AnchoredPickOptions,
): readonly FrontierRung[] {
  if (opts?.allowReserved) return frontier;
  const kept = frontier.filter((r) => !isReservedKey(r.key));
  return kept.length > 0 ? kept : frontier;
}

/**
 * The dial, anchored.
 *
 *   0 fast · 1 quick · 2 lean   → the CHEAPEST admissible rung within 15 / 10 / 5 AA points
 *                                 below the anchor. Trading down, measured from Opus.
 *   3 balanced                  → the anchor itself.
 *   4 deep                      → the SMARTEST admissible rung costing ≤ 2× the anchor.
 *   5 wide                      → the smartest admissible rung, cost unbounded.
 *   6 smart                     → as 5, with the reserved set admitted by the caller.
 */
export function anchoredBiasPick(
  frontier: readonly FrontierRung[],
  biasIdx: number | undefined,
  opts?: AnchoredPickOptions,
): FrontierRung | undefined {
  if (frontier.length === 0) return undefined;
  const idx = clampBiasIdx(biasIdx);
  const pool = admissibleRungs(frontier, opts);
  const anchor = anchorRung(frontier, opts);
  // NO ANCHOR ON THIS BOARD ⇒ THE OLD DIAL. Anchoring on a model that is not present would
  // silently turn "balanced" into "the most expensive rung available", which is the opposite of
  // what the dial means. When Opus is unreachable — vetoed, spent, or simply not configured —
  // the gap-below-best semantics are still the honest reading of the same slider.
  if (!anchor) {
    const target = biasTarget(pool, idx);
    return pool.find((r) => r.smart >= target);
  }
  if (idx <= 3) {
    const floor = anchor.smart - THALAMUS_BELOW_ANCHOR[idx];
    // `pool` inherits the frontier's cost order, so `find` IS the cheapest qualifying rung.
    return pool.find((r) => r.smart >= floor) ?? anchor;
  }
  const mult = THALAMUS_ABOVE_ANCHOR_COST_MULT[idx - 4] ?? Infinity;
  const cap = Number.isFinite(mult) ? anchor.cost * mult : Infinity;
  let best: FrontierRung | undefined;
  for (const r of pool) {
    if (r.cost > cap) continue;
    if (!best || r.smart > best.smart) best = r;
  }
  return best ?? anchor;
}

// ─── task domain (Fugu / J6 §3.6: route by measured expertise, not by one number) ───

/**
 * The task domains THALAMUS routes along — one per CAPABILITY column of the dossier
 * (smart-model-dossier.ts `SC_SKILLS`), minus SPEED and COST, which are properties of
 * the route rather than of the work.
 *
 * WIDENED 2026-09-23 (the architect: "the table that explains which model is best at what
 * should be more granular, more visual, and it finally influences Thalamus"). Eight
 * domains became fifteen. The split is not cosmetic — each new domain is a question
 * whose answer is a DIFFERENT model, which is the only test a routing domain has to
 * pass:
 *
 *   code → code + frontend   SWE-bench and WebDev Arena disagree at the top. On the
 *                            2026-09-22 WebDev board GPT-6 Astra leads at 1793 Elo
 *                            while Fable 5.1 (SWE-bench Verified 95%, the CODE leader)
 *                            is second at 1755. One column could not say that.
 *   reason → maths + science + reason
 *                            FrontierMath, GPQA and ARC-AGI are three different
 *                            abilities that Epoch publishes as three different tables.
 *   world  → factual + world The old WORLD column mixed live retrieval (its stated
 *                            question) with MMLU and TriviaQA (parametric recall),
 *                            which is exactly the two-bases error the dossier header
 *                            forbids. The measurement moved to FACTUAL, which is the
 *                            column it answers; WORLD keeps the transport question and
 *                            is honestly unmeasured.
 *   new    → data, languages, instruct
 *                            Spreadsheets/SQL, working in Catalan and Spanish, and
 *                            obeying an exact output format are three things the
 *                            architect routes by and this module could not name.
 *
 * WIDENED AGAIN 2026-10-02 (the architect: "find more verticals so we can better choose in
 * Thalamus the best model per task"): shell, ml, cad, research, office, security, health.
 * Six of the seven are MEASURED from day one, because Epoch already ships the tables and
 * they were being averaged into a broader domain (Terminal Bench in code, WeirdML in
 * reason, Cybench and GDPval in agentic, CadEval in vision). HEALTH has no Epoch rows yet
 * and keeps the bias pick until it does. Cue words were MOVED, never copied, where two
 * domains wanted them: `terminal|shell|cron` left AGENTIC and `kubernetes` left CODE for
 * SHELL, because a word in two lists turns an ordinary prompt into a tie, i.e. "general".
 *
 * A domain with no Epoch table is NOT an error: `domainStrengthFor` returns undefined
 * and `thalamusRoute` keeps the bias pick, exactly as it already does for any family
 * with no run. Adding a domain can therefore never break routing — at worst it is a
 * no-op until a benchmark exists.
 */
export type TaskDomain =
  // BUILD
  | "code"
  | "frontend"
  | "shell"
  | "data"
  | "ml"
  | "cad"
  // WORK
  | "agentic"
  | "research"
  | "office"
  | "security"
  // THINK
  | "maths"
  | "science"
  | "reason"
  // TALK
  | "write"
  | "languages"
  | "psych"
  | "instruct"
  // SEE & KNOW
  | "context"
  | "vision"
  | "factual"
  | "health"
  | "world"
  | "general";

/** Every domain except "general", in dossier column order — the one list to extend. */
export const TASK_DOMAINS: readonly TaskDomain[] = [
  "code",
  "frontend",
  "shell",
  "data",
  "ml",
  "cad",
  "agentic",
  "research",
  "office",
  "security",
  "maths",
  "science",
  "reason",
  "write",
  "languages",
  "psych",
  "instruct",
  "context",
  "vision",
  "factual",
  "health",
  "world",
];

const DOMAIN_CUES: { domain: TaskDomain; re: RegExp; w: number }[] = [
  {
    domain: "code",
    re: /\b(code|coding|bug|fix|refactor|compile|build|test suite|typescript|python|javascript|rust|golang|regex|function|class|api|endpoint|stack ?trace|exception|npm|pnpm|git|commit|merge|pull request|lint|unit test|vitest|pytest|script|debug|implement|deploy|dockerfile|yaml|json schema)\b/gi,
    w: 1,
  },
  // FRONTEND, 2026-09-23. Kept clear of the CODE list on purpose: a prompt that says
  // "code" must stay CODE, so nothing here is a generic programming word. The signal is
  // the surface — a page, a component, a stylesheet — not the act of programming.
  {
    domain: "frontend",
    re: /\b(css|html|tailwind|react|vue|svelte|jsx|tsx|front-?end|web ?page|web ?site|landing page|\bui\b|\bux\b|layout|stylesheet|responsive|component|button|modal|navbar|sidebar|dark mode|viewport|flexbox|animation|hover state|design system)\b/gi,
    w: 1,
  },
  {
    domain: "agentic",
    re: /\b(browse|scrape|crawl|fill (?:in|out) the form|book|order|schedule|automate|workflow|pipeline|run the|execute|orchestrat\w*|subagent|multi-step|tool calls?|navigate)\b/gi,
    w: 1,
  },
  // ── 2026-10-02 verticals. Each list is the research agent's cue set for its column,
  //    trimmed of any word another domain already owns.
  {
    domain: "shell",
    re: /\b(bash|shell|terminal|command line|ssh|systemd|systemctl|journalctl|docker|container|kubernetes|nginx|apt(?:-get)?|cron(?:tab)?|firewall|dns|sudo|chmod|disk (?:is )?full|mount|reboot|server (?:is )?down|service failed|linux|ubuntu|ip route|tls certificate|tmux|port forward\w*)\b/gi,
    w: 1,
  },
  {
    domain: "ml",
    re: /\b(train (?:a|the) model|training run|fine-?tun\w*|lora|qlora|hyperparameters?|learning rate|batch size|epochs?|loss curve|overfitting|pytorch|tensorflow|data augmentation|model weights|validation accuracy|confusion matrix|neural (?:net|network)s?|convnet|yolo|object detection|segmentation|class imbalance|cuda out of memory|distillation|retrain\w*|embedding model)\b/gi,
    w: 1,
  },
  {
    domain: "cad",
    re: /\b(cad|openscad|cadquery|freecad|build123d|solidworks|fusion 360|stl|step file|dxf|b-rep|3d print\w*|parametric|tolerances?|clearance fit|fillet|chamfer|extrude|revolve|bracket|enclosure|gears?|thread pitch|cross-section|dimensioned drawing|mechanical design)\b/gi,
    w: 1,
  },
  {
    domain: "research",
    re: /\b(deep research|research (?:the|into|on)|find out|literature review|survey the field|state of the art|market research|competitors?|references|bibliography|cross-check|primary sources?|papers on|arxiv|news roundup|background check|dig up|look into)\b/gi,
    w: 1,
  },
  {
    domain: "office",
    re: /\b(report|deck|slide deck|slides|presentation|powerpoint|pptx|docx|memo|proposal|quote|rfp|client|deliverable|executive summary|business case|white paper|briefing note|board paper|one-pager|pitch|consulting|due diligence|statement of work|meeting minutes|financial model|stakeholders?|handover)\b/gi,
    w: 1,
  },
  {
    domain: "security",
    re: /\b(vulnerabilit\w*|cve|exploit\w*|pentest\w*|penetration test|ctf|capture the flag|xss|sql injection|csrf|buffer overflow|privilege escalation|reverse engineer\w*|malware|fuzz\w*|threat model|attack surface|hardening|security audit|zero-day|0day|rce|owasp|nmap|burp|metasploit|phishing|incident response|forensics)\b/gi,
    w: 1,
  },
  // DATA, 2026-09-23. `sql` MOVED HERE from the CODE list: a text-to-SQL ask is data
  // work, and leaving it in CODE meant every query question routed to the SWE-bench
  // leader. `plot the` rather than a bare `chart`, because VISION owns `chart` (reading
  // one) and a shared token would tie the two domains into "general".
  {
    domain: "data",
    re: /\b(spreadsheet|excel|xlsx|csv|\bsql\b|query|database|dataset|pivot|dashboard|kpi|metrics?|plot the|aggregate|group by|row count|tabular|data ?frame|pandas|bigquery|forecast the|trend)\b/gi,
    w: 1,
  },
  {
    domain: "maths",
    re: /\b(prove|proof|theorem|lemma|derive|derivation|equation|integral|derivative|matrix|algebra|geometry|calculus|arithmetic|probability|statistics|aime|math|maths|mathematical|solve for|calculate|compute the|estimate the|sum of|factorial|modulo)\b/gi,
    w: 1,
  },
  {
    domain: "science",
    re: /\b(physics|chemistry|biology|biochem\w*|molecul\w*|quantum|thermodynamic\w*|genetics?|astronomy|astrophysic\w*|gpqa|reaction|enzyme|protein|electron|photon|isotope|hypothesis|scientific|experiment)\b/gi,
    w: 1,
  },
  // REASON keeps what is left once maths and science leave: puzzles, logic, lateral
  // thinking — the ARC-AGI / SimpleBench shape.
  {
    domain: "reason",
    re: /\b(puzzle|riddle|logic|logical|lateral thinking|brain ?teaser|deduc\w*|paradox|chess|sudoku|counterintuitive|trick question|reason through|why does|optimi[sz]e the|algorithm complexity|big-o)\b/gi,
    w: 1,
  },
  {
    domain: "write",
    re: /\b(write|draft|rewrite|edit|proofread|essay|blog|post|article|email|e-mail|letter|copy|headline|tagline|caption|story|poem|newsletter|readme|documentation|docs|tone|wording|paragraph|summari[sz]e)\b/gi,
    w: 1,
  },
  // LANGUAGES, 2026-09-23. `translate` MOVED HERE from WRITE. The architect works in
  // Catalan and Spanish, so the language names are cues in their own right.
  {
    domain: "languages",
    re: /\b(translat\w*|traducci\w*|in (?:spanish|catalan|french|german|italian|portuguese|chinese|japanese|dutch|basque|galician)|castellano|catal[\u00e0a]n?|espa[\u00f1n]ol|multilingual|bilingual|localis\w*|localiz\w*|subtitle|native speaker|idioma|llengua)\b/gi,
    w: 1,
  },
  {
    domain: "psych",
    re: /\b(feel|feelings|emotion\w*|anxious|anxiety|stress\w*|relationship|partner|friend|family|argument|conflict|motivat\w*|therapy|therapist|advice|cope|coping|grief|angry|upset|difficult conversation|how do i tell|should i say|empath\w*|burnout|self-esteem|habits?)\b/gi,
    w: 1,
  },
  // INSTRUCT, 2026-09-23. Deliberately NOT given `yaml`, `schema` or `json`: CODE owns
  // those, and a shared token would tie a perfectly ordinary coding prompt into
  // "general". What is left is the vocabulary of a CONSTRAINT on the output itself.
  {
    domain: "instruct",
    re: /\b(exactly \d+|no more than \d+|at most \d+|word limit|character limit|bullet points?|follow the format|in the format|output only|only output|respond with only|nothing else|do not include|verbatim|strictly|template)\b/gi,
    w: 1,
  },
  {
    domain: "context",
    re: /\b(this (?:document|pdf|transcript|log|file|thread|book|contract)|attached|the whole|entire (?:codebase|repo|document)|across all|long document|\d{2,}k tokens|find every mention|read through)\b/gi,
    w: 1,
  },
  {
    domain: "vision",
    re: /\b(image|photo|picture|screenshot|diagram|chart|figure|drawing|sketch|video|frame|ocr|what do you see|look at this|floor ?plan|blueprint)\b/gi,
    w: 1,
  },
  // FACTUAL, 2026-09-23. These cues were WORLD's. They ask what the model already
  // knows, which is the AA-Omniscience / SimpleQA question, not the live-retrieval one.
  {
    domain: "factual",
    re: /\b(who is|who was|when did|where is|what year|capital of|population|born|died|founded|trivia|fact.?check|is it true that|how many|define|meaning of|citation|cite the|source for|according to|verify that)\b/gi,
    w: 1,
  },
  // HEALTH, 2026-10-02. Kept clear of PSYCH's list on purpose (anxiety, stress, therapy
  // stay there): this is the body, its medicines and the plants that act like them.
  {
    domain: "health",
    re: /\b(symptoms?|diagnos\w*|dosage|dose|mg|drug interactions?|medications?|medicines?|prescription|side effects?|lab results|blood test|blood pressure|antibiotics?|painkillers?|supplements?|herbal|medicinal plants?|tincture|infusion|contraindicat\w*|allerg\w*|rash|fever|pregnan\w*|see a doctor|insomnia|cholesterol)\b/gi,
    w: 1,
  },
  // WORLD now means what its dossier column always claimed: BEYOND THE CUT-OFF.
  {
    domain: "world",
    re: /\b(today|yesterday|this (?:week|month|morning)|right now|currently|latest|breaking|news|headline|current (?:price|events|state)|stock price|weather|just announced|up to date|since your (?:training|cut.?off)|real.?time)\b/gi,
    w: 1,
  },
];

/**
 * A keyword classifier — deliberately simple, deterministic and inspectable. Ties and
 * silence go to "general", where routing is the plain bias pick. This is the rule-based
 * stand-in for FUGU's trained router: the same decision (route by domain) on a signal
 * the architect can read in one glance, replaceable by a learned classifier later
 * without touching the frontier or the strength tables.
 */
export function classifyTaskDomain(text: string): TaskDomain {
  const t = (text ?? "").slice(0, 4000);
  if (!t.trim()) return "general";
  const score = new Map<TaskDomain, number>();
  for (const cue of DOMAIN_CUES) {
    const hits = t.match(cue.re)?.length ?? 0;
    if (hits > 0) score.set(cue.domain, (score.get(cue.domain) ?? 0) + hits * cue.w);
  }
  if (score.size === 0) return "general";
  const ranked = [...score].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const [top, n] = ranked[0];
  if (ranked.length > 1 && ranked[1][1] === n) return "general"; // a tie is no signal
  return top;
}

export type DomainStrength = {
  /** Mean percentile (0..1) across the domain's benchmarks, best run per family. */
  p: number;
  /** How many benchmarks in the domain ran this family. */
  n: number;
  basis: readonly string[];
};

/** Measured strength of a route's model in a domain, or undefined when Epoch has no run. */
export function domainStrengthFor(key: string, domain: TaskDomain): DomainStrength | undefined {
  if (domain === "general") return undefined;
  const fam = aaFamilyOf(key);
  const row = DOMAIN_STRENGTH[fam] ?? DOMAIN_STRENGTH[fam.replace(/-preview$/, "")];
  return row?.[domain];
}

/** A domain switch has to be worth at least this many percentile points — below it,
 *  two models are "about as good" and the cheaper frontier pick keeps the turn. */
export const DOMAIN_SWITCH_MIN_GAIN = 0.1;

/** A domain switch may cost at most this multiple of the bias pick's €/task. The dial
 *  is a statement about money as much as about intelligence: at "fast" a specialist
 *  five times dearer than the pick is not what the architect asked for, however good
 *  it is at the domain. */
export const DOMAIN_SWITCH_MAX_COST_MULT = 5;

/**
 * A SUGGESTION IS A PRIOR, NOT A PIN (the architect, 2026-10-02: "his picks are suggestions"). The suggested rung runs
 * unless it cannot (the plan removes it: a limit, a cooling supply, a context too small, the allowlist) or
 * another rung still beats it for THIS TASK after a bonus of this fraction of the suggestion's own score. "For this
 * task" means the measured domain strength `p` of the task's domain, the only task-specific evidence the router
 * has. A general task, or a suggestion with no measured row for the domain, has nothing to move it, so it keeps
 * the turn: comparing on the AA index instead would let every smarter rung in the band beat a suggestion set at
 * a low effort, and the stop would never run what he picked. A relative bonus survives a vendor rescaling its
 * measure; a fixed number of points would not. 10 % is the architect's default to tune.
 */
export const SUGGESTION_PRIOR = 0.1;

export type RouteSuggestion = { key: string; effort?: string };

export type SuggestionVerdict = {
  state: "kept" | "moved";
  /** The suggestion's own rung (the effort asked for, or the nearest the model has). */
  key: string;
  effort: string;
  /** The effort the suggestion asked for, when the model has no rung at it. */
  effortAsked?: string;
  /** Moved: the rung that won, and how far it leads the suggestion on the domain strength, in percent. */
  to?: { key: string; effort: string };
  gainPct?: number;
};

/** The suggestion's rung: the effort asked for, else the model's rung nearest the dial's own pick. */
function suggestionRung(
  rungs: readonly FrontierRung[],
  s: RouteSuggestion,
  nearest: FrontierRung,
): FrontierRung | undefined {
  const own = rungs.filter((r) => r.key === s.key);
  if (own.length === 0) return undefined;
  if (s.effort) {
    const exact = own.find((r) => r.effort === s.effort);
    if (exact) return exact;
  }
  return own.reduce((a, b) =>
    Math.abs(b.smart - nearest.smart) < Math.abs(a.smart - nearest.smart) ? b : a,
  );
}

export type ThalamusRoute = {
  /** The rung thalamus routes to. */
  rung: FrontierRung;
  /** The plain bias pick on the frontier — equals `rung` unless the domain moved it. */
  biasRung: FrontierRung;
  frontier: FrontierRung[];
  biasIdx: number;
  /** The intelligence floor the dial set. */
  target: number;
  /**
   * The floor a RECOVERY rung must clear, which is deliberately LOOSER than `target`.
   *
   * A fallback exists precisely because the preferred rung could not run, so requiring it to be
   * as smart as the pick makes recovery impossible exactly when it is needed: on the 2026-09-04
   * board the balanced floor IS Opus 5, and the only rung above it was Fable — on the same
   * supply, which survives nothing. The floor here is the most permissive stop's ("fast", 15 AA
   * points below the anchor), so a degraded answer is allowed but an arbitrarily degraded one is
   * not.
   */
  chainFloor: number;
  domain: TaskDomain;
  /** Strength of `rung`'s model in `domain`, when measured. */
  strength?: DomainStrength;
  /** Present when a suggestion was given and its rung is on the board: kept, or moved off and why. */
  suggestion?: SuggestionVerdict;
  /** One line a human can read: why THIS model at THIS effort. */
  reason: string;
};

export type ThalamusRouteParams = {
  rungs: readonly FrontierRung[];
  biasIdx?: number;
  domain?: TaskDomain;
  /** Override for tests; defaults to the generated Epoch table. */
  strengthFor?: (key: string, domain: TaskDomain) => DomainStrength | undefined;
  /** Route key the dial is anchored on. Defaults to `THALAMUS_ANCHOR_KEY` (Opus 5). */
  anchorKey?: string;
  /** Admit the reserved set for a NAMED reason the caller owns — a ballistic window, or a
   *  feasibility veto that left nothing else. The top dial stop opens it on its own. */
  allowReserved?: boolean;
  /** The architect's suggestion for this dial stop (model, and effort). Applies on Auto turns only; the caller
   *  passes it only when its rung survived the vetoes. */
  suggestion?: RouteSuggestion;
};

function fmtRung(r: FrontierRung): string {
  return r.effort ? `${r.key}@${r.effort}` : r.key;
}

/**
 * The full decision: frontier → bias pick → domain switch.
 *
 * The domain step looks at the BAND — every rung whose intelligence clears the dial's
 * floor and whose cost is within DOMAIN_SWITCH_MAX_COST_MULT of the bias pick (and
 * never above the frontier's best rung, which dominates anything dearer) — and takes
 * the cheapest rung of the model with the highest measured strength, but only when
 * that strength beats the bias pick's by DOMAIN_SWITCH_MIN_GAIN. No measurement, no
 * switch: an unmeasured model is not assumed better, and the bias pick keeps the turn.
 */
export function thalamusRoute(params: ThalamusRouteParams): ThalamusRoute | undefined {
  const biasIdx = clampBiasIdx(params.biasIdx);
  const domain = params.domain ?? "general";
  const strengthFor = params.strengthFor ?? domainStrengthFor;
  const frontier = paretoFrontier(params.rungs);
  const anchorOpts: AnchoredPickOptions = {
    anchorKey: params.anchorKey,
    // The top stop is one of the three named reasons the reserved set opens; the other two
    // (a ballistic window, a feasibility veto that leaves nothing else) are decided upstream
    // and arrive as an explicit flag, so this module never has to guess why.
    allowReserved: params.allowReserved || biasIdx >= THALAMUS_BIAS_GAP.length - 1,
  };
  const biasRung = anchoredBiasPick(frontier, biasIdx, anchorOpts);
  if (!biasRung) return undefined;
  const anchor = anchorRung(frontier, anchorOpts);
  // The band's floor. At or below balanced it is the anchor minus the stop's gap; above
  // balanced the anchor IS the floor — a dial turned past balanced never routes below Opus.
  const target =
    anchor === undefined
      ? biasTarget(frontier, biasIdx)
      : biasIdx <= 3
        ? anchor.smart - THALAMUS_BELOW_ANCHOR[biasIdx]
        : anchor.smart;
  const anchorLabel = anchor ? fmtRung(anchor) : "the board's best (no anchor rung present)";
  const chainFloor = Math.min(
    target,
    (anchor?.smart ?? frontier[frontier.length - 1].smart) - THALAMUS_BELOW_ANCHOR[0],
  );
  // THE SMART STOP MEANS THE BEST MODEL FOR THIS DECISION (the architect, 2026-10-01). Below it the dial
  // is also a statement about money, so a specialist must fit the cost cap and lead by
  // DOMAIN_SWITCH_MIN_GAIN. At the top stop neither applies: the measured leader of the task's
  // domain takes the turn whatever it costs, by any measured lead, at its strongest effort. The
  // floor stays: a specialist below the anchor is still not "the best model".
  const topStop = biasIdx >= THALAMUS_BIAS_GAP.length - 1;
  const bestCost = topStop
    ? Infinity
    : Math.min(frontier[frontier.length - 1].cost, biasRung.cost * DOMAIN_SWITCH_MAX_COST_MULT);
  const base: ThalamusRoute = {
    rung: biasRung,
    biasRung,
    frontier,
    biasIdx,
    target,
    chainFloor,
    domain,
    reason:
      `bias ${biasIdx} anchored on ${anchorLabel}` +
      (biasIdx <= 3
        ? ` (≤${THALAMUS_BELOW_ANCHOR[biasIdx]} AA points below it)`
        : ` (smartest within ${THALAMUS_ABOVE_ANCHOR_COST_MULT[biasIdx - 4] === Infinity ? "any" : `${THALAMUS_ABOVE_ANCHOR_COST_MULT[biasIdx - 4]}×`} its cost)`) +
      ` → ${fmtRung(biasRung)} (idx ${biasRung.smart.toFixed(1)}, €${biasRung.cost.toPrecision(3)}/task)` +
      (anchorOpts.allowReserved && isReservedKey(biasRung.key) ? " · reserved model opened" : ""),
  };
  const band = params.rungs.filter(
    (r) =>
      r.smart >= target &&
      r.cost <= bestCost &&
      (anchorOpts.allowReserved || !isReservedKey(r.key)),
  );
  const sRung = params.suggestion
    ? suggestionRung(params.rungs, params.suggestion, biasRung)
    : undefined;
  if (params.suggestion && sRung) {
    return routeFromSuggestion({
      base,
      sRung,
      asked: params.suggestion,
      band,
      domain,
      strengthFor,
    });
  }
  if (domain === "general") return base;
  const pickStrength = strengthFor(biasRung.key, domain);
  base.strength = pickStrength;
  let bestRung: FrontierRung | undefined;
  let bestStrength: DomainStrength | undefined;
  for (const r of band) {
    const s = strengthFor(r.key, domain);
    if (!s) continue;
    if (
      !bestStrength ||
      s.p > bestStrength.p ||
      (s.p === bestStrength.p &&
        (topStop ? r.smart > bestRung!.smart : byCostThenSmart(r, bestRung!) < 0))
    ) {
      bestStrength = s;
      bestRung = r;
    }
  }
  if (!bestRung || !bestStrength) {
    base.reason += ` · domain ${domain}: no measured strengths in band, bias pick keeps the turn`;
    return base;
  }
  const gain = bestStrength.p - (pickStrength?.p ?? 0);
  if (bestRung.key === biasRung.key || (topStop ? gain <= 0 : gain < DOMAIN_SWITCH_MIN_GAIN)) {
    base.reason += ` · domain ${domain}: ${bestRung.key} leads at p${(bestStrength.p * 100).toFixed(0)} but gain ${(gain * 100).toFixed(0)}pt < ${DOMAIN_SWITCH_MIN_GAIN * 100}, bias pick keeps the turn`;
    return base;
  }
  return {
    ...base,
    rung: bestRung,
    strength: bestStrength,
    reason:
      `bias ${biasIdx} floor idx ${target.toFixed(1)} · domain ${domain}: ${fmtRung(bestRung)} measured p${(bestStrength.p * 100).toFixed(0)} over ${bestStrength.n} benchmarks` +
      ` vs bias pick ${fmtRung(biasRung)} p${pickStrength ? (pickStrength.p * 100).toFixed(0) : "?"} → switched (+${(gain * 100).toFixed(0)}pt)`,
  };
}

/**
 * The route when the architect suggested a rung: start from it, give it the prior, and move off only for a
 * rival that still wins for this task. The rivals are the dial's own band (its floor, its cost cap, the reserved
 * set only when a named reason opened it), so a stop set to "budget" is never moved to a model far above its price.
 * Compared on the measured domain strength; see SUGGESTION_PRIOR for why nothing else moves it.
 */
function routeFromSuggestion(i: {
  base: ThalamusRoute;
  sRung: FrontierRung;
  asked: RouteSuggestion;
  band: readonly FrontierRung[];
  domain: TaskDomain;
  strengthFor: (key: string, domain: TaskDomain) => DomainStrength | undefined;
}): ThalamusRoute {
  const { base, sRung, band, domain } = i;
  const sStrength = domain === "general" ? undefined : i.strengthFor(sRung.key, domain);
  const asked =
    i.asked.effort && i.asked.effort !== sRung.effort ? { effortAsked: i.asked.effort } : {};
  const kept = (why: string): ThalamusRoute => ({
    ...base,
    rung: sRung,
    strength: sStrength,
    suggestion: { state: "kept", key: sRung.key, effort: sRung.effort, ...asked },
    reason: `${base.reason} · suggestion ${fmtRung(sRung)} kept (${why})`,
  });
  if (!sStrength) {
    return kept(
      domain === "general"
        ? "nothing task-specific to move it"
        : `no measured ${domain} strength to move it`,
    );
  }
  let winner: FrontierRung | undefined;
  let winnerStrength: DomainStrength | undefined;
  // The suggestion's own model is not a rival at another effort: the effort is part of what was suggested.
  for (const r of band) {
    if (r.key === sRung.key) continue;
    const st = i.strengthFor(r.key, domain);
    if (!st) continue;
    if (
      !winnerStrength ||
      st.p > winnerStrength.p ||
      (st.p === winnerStrength.p && byCostThenSmart(r, winner!) < 0)
    ) {
      winner = r;
      winnerStrength = st;
    }
  }
  if (!winner || !winnerStrength || winnerStrength.p <= sStrength.p * (1 + SUGGESTION_PRIOR)) {
    return kept(
      `${SUGGESTION_PRIOR * 100}% prior on ${domain} strength p${(sStrength.p * 100).toFixed(0)}`,
    );
  }
  const gainPct = Math.round((winnerStrength.p / sStrength.p - 1) * 100);
  return {
    ...base,
    rung: winner,
    strength: winnerStrength,
    suggestion: {
      state: "moved",
      key: sRung.key,
      effort: sRung.effort,
      to: { key: winner.key, effort: winner.effort },
      gainPct,
      ...asked,
    },
    reason: `${base.reason} · suggestion ${fmtRung(sRung)} moved to ${fmtRung(winner)}: +${gainPct}% on ${domain} strength after the ${SUGGESTION_PRIOR * 100}% prior`,
  };
}

/** The per-domain routes for a whole board — what the chart footer and the dossier show. */
export function thalamusRoutesByDomain(
  rungs: readonly FrontierRung[],
  biasIdx: number | undefined,
  strengthFor?: ThalamusRouteParams["strengthFor"],
): Partial<Record<TaskDomain, ThalamusRoute>> {
  const out: Partial<Record<TaskDomain, ThalamusRoute>> = {};
  // "general" first, then TASK_DOMAINS in dossier column order — one list, so a new
  // domain cannot be added to the type and silently missed by the strip.
  const domains: TaskDomain[] = ["general", ...TASK_DOMAINS];
  for (const d of domains) {
    const r = thalamusRoute({ rungs, biasIdx, domain: d, strengthFor });
    if (r) out[d] = r;
  }
  return out;
}
