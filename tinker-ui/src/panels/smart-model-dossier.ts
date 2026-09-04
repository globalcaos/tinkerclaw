// tinker-ui/src/panels/smart-model-dossier.ts
// IMPORT ORDER IS THE FORMATTER'S, NOT A PREFERENCE — .oxfmtrc.jsonc enables
// sortImports, which sorts "../../../src/shared/…" ABOVE "./…" and binds a leading
// comment to the import beneath it. Written PRE-SORTED with the shared import
// first, so the path banner on line 1 is bound to an import that cannot move.
// After `pnpm format`, re-check that line 1 is still the banner.
import type { ThalamusCandidatesResult } from "../../../src/shared/thalamus-candidates.js";
import {
  clampBiasIdx,
  domainStrengthFor,
  frontierRungsFor,
  thalamusRoutesByDomain,
} from "../../../src/shared/thalamus-frontier.js";
import type {
  DomainStrength,
  FrontierRung,
  TaskDomain,
  ThalamusRoute,
} from "../../../src/shared/thalamus-frontier.js";
import type { CnProviderPrices } from "./cn-provider-prices.generated.js";
import { BIAS_STOPS } from "./routing-rationale.js";
import { SC_THALAMUS, scThalamusRelCost } from "./smart-cost-chart.js";
export { CN_PROVIDER_PRICES } from "./cn-provider-prices.generated.js";
export type { CnProviderPrices } from "./cn-provider-prices.generated.js";
// FORK 2026-08-06 (the architect): the SMART MODELS dossier — "all the smart models
// against what they are best at", plus a per-topic CENSORSHIP grid: one column
// per censored thing, one glyph per model, the detail on mouseover.
//
// CORRECTION 2026-08-06 (the architect caught it): the first version of this table put
// "malware, ransomware and cyberattack tooling" in the REFUSED-BY-BOTH-CAMPS
// list. That flattened the single most consequential asymmetry in the field.
// The July 2026 Hugging Face breach is the counter-evidence: an OpenAI
// pre-release model with deliberately reduced cyber refusals found a zero-day
// in an Artifactory cache proxy, escaped its sandbox and reached Hugging Face
// production — and when Hugging Face went to investigate, Claude and GPT
// REFUSED to read the attacker's own payloads and logs, "treating
// reverse-engineering an exploit the same as launching one". They ran Zhipu's
// open-weight GLM 5.2 in-house instead and put 17,000+ telemetry events
// through it. Chinese models are not meaningfully censored on security work;
// US models are, to the point of failing defenders. Split into two columns
// (MALWARE vs SEC RESEARCH) so the asymmetry is visible instead of averaged.
//
// PROVENANCE (honesty, bible §5.8h invariant 3):
//   · "Best at" — SWE-bench Verified (Fable 95%, BenchLM/vals.ai), OckBench
//     rankings (arXiv:2511.05722), vendor launch framing (marked as claims).
//   · US refusals — Anthropic + OpenAI usage policies; Anthropic's Cyber
//     Verification Program and OpenAI's Trusted Access for Cyber (both lower
//     the refusal threshold for vetted defenders, which is why SEC RESEARCH is
//     "gated" rather than "refused" for those families).
//   · Hugging Face incident — Fortune / CNBC / TechNode, 2026-07-20..24;
//     Delangue: proprietary US models are "actually dangerous to use to defend
//     against a cyber attack".
//   · China politics — ellamind 2026 "Not All Chinese LLMs Censor", 168 cases
//     across ten suppressed topics: Kimi K2.5 98.8%, Claude Opus 4.5 98.8%,
//     GPT-OSS-120B 98.8%, GLM 4.7 Flash 95.2% local / 79.8% hosted,
//     DeepSeek V3.2 19%. Chinese law: 2023 Interim Measures for Generative AI.
//   · Jailbreak resilience — CASI, July 2026: Claude Sonnet 5 93.08,
//     Qwen3.5-397B 81.13, MiMo-V2.5 73.80, GLM-5.2 46.58.
//   · MEASURED numbers in SC_FACTS (2026-08-07) — SWE-bench Verified and output
//     throughput from the llm-stats leaderboard; price and context window from
//     the BenchLM pricing table. NOTE: a search summary claimed Opus 5 leads
//     SWE-bench Verified at 97.0%; the leaderboard itself does not list Opus 5
//     or the GPT-5.6 tiers at all, so that figure is NOT used here and Fable 5
//     stays the sourced #1 at 95.0%.
//   · A characterisation of training-time disposition, not a guarantee:
//     jailbreaks, endpoint-side filtering and version drift all exist.
//
// ── FORK 2026-08-30 (the architect): the PSYCH axis, and why marking an opinion beats
// ── withholding a column ────────────────────────────────────────────────────
//
// THE ARCHITECT: "I feel opus is better at programming while gpt is better at
// psychology and writing emails, and yet those categories are not present in the
// dossier popup panel." Right on both counts. PROGRAMMING had a column (CODE,
// SWE-bench-anchored). EMAIL was buried inside WRITE without ever being named.
// PSYCHOLOGY — reading people, emotional nuance, difficult conversations, advice
// — had no column at all, so the routing question he asks most often was the one
// question this table could not answer.
//
// WHY IT WAS ADDED WITHOUT A BENCHMARK BEHIND IT. Bible FOUNDATION #1 is
// "capability and autonomy first, prudence as the BRAKE — not a GATE", and #3 is
// "usefulness is measured by value to the architect, so personalize relentlessly".
// Withholding a column the architect actually routes by, until a public benchmark
// blesses it, is prudence acting as a gate. FOUNDATION #5 ("no silent failure, no
// silent loss") does not forbid an opinion grade — it forbids an UNMARKED one.
// The rule this file now enforces is therefore: ADD THE AXIS, MARK ITS PROVENANCE.
//
// EVERY COLUMN NOW DECLARES WHERE ITS GRADES COME FROM (`SkillDef.grading`, a
// REQUIRED field, so a future column cannot skip the question):
//   ANCHORED — read off a named public measurement OF THIS COLUMN'S OWN QUESTION.
//              Exactly three qualify: CODE (SWE-bench Verified), SPEED (output
//              throughput) and COST (published price).
//   JUDGED   — no public anchor. Marked with a `?` superscript on the header, which
//              is this file's existing "present but unconfirmed" vocabulary (`sub?`
//              in the CN matrix, the em-dash index on the reference rows) rather
//              than a tenth colour the palette has no room for.
//
// LONG CTX IS JUDGED ON PURPOSE and is the trap worth naming out loud: it carries a
// MEASURED tooltip line, but that figure is the ADVERTISED WINDOW while the grade is
// about USEFUL RECALL, which nobody publishes across these families. A measured line
// inside a judged column is a RELATED FIGURE, never the grade's basis. Mixing two
// bases in one column is how a table inverts a conclusion while still looking sorted.
//
// THE ANCHOR WE LOOKED FOR AND DID NOT USE. EQ-Bench 3 (eqbench.com) is current and
// is the right anchor for PSYCH — an anchored column always beats an opinion one. It
// is NOT used here for two reasons, both re-checkable rather than rhetorical: it
// publishes no rows for the models in this table, and it is LLM-JUDGED BY AN
// ANTHROPIC MODEL, which is a conflict of interest on the exact Claude-versus-GPT
// comparison this column exists to answer (the "never let the suspect be the
// investigator" rule). Anchor the column the day both are fixed, and flip `grading`
// to "anchored" in the same commit.
//
// EMAIL IS NOT ITS OWN COLUMN. WRITE was re-scoped to name correspondence instead.
// Email is prose; a column per genre is how this table stops being readable, and the
// real routing question ("who drafts the difficult message") is answered by WRITE and
// PSYCH together, which is the honest shape of it.
//
// GRADED, NOT WIRED (`SkillCell.caveat`). A cell can be right about the MODEL and
// wrong about OUR TRANSPORT to it. Grok's WORLD ★ is the live case: the grade is
// vendor-true and it is the ONLY ★ in that column across all nineteen rules, but xai
// is reached through a SuperGrok cli-chat-proxy shim, `x-search` is absent from
// openclaw.json's `tools`, and the catalog entry declares input:['text']. An
// instrument that shows what thalamus considers must not simultaneously assert a
// mechanism nobody has tested, so the glyph carries a dashed underline and the
// tooltip says which half is unproven.
//
// THERE IS NO COMPILER BEHIND ANY OF THIS. Verified 2026-08-30: no tsconfig in the
// repo includes `tinker-ui/**` (the root include's `ui/**/*` is a different
// directory), and `tinker-ui`'s build is `vite build`, i.e. esbuild transpile-only.
// Adding a SkillKey therefore does NOT break the nineteen skill maps at compile time
// — it breaks them at `smart-model-dossier.test.ts:28` ("missing skill <key>") and,
// confusingly, a second time at :296, because the missing-cell branch emits a cell
// with no `data-tip` and the exact tooltip count comes up short. The net is the test
// suite, not the type system; count the insertions when you add the next column.

/** How hard the block is. Ordered loosest→tightest for the legend. */
export type Verdict = "open" | "soft" | "gated" | "hard";

export const SC_VERDICT_GLYPH: Record<Verdict, string> = {
  hard: "■",
  gated: "▤",
  soft: "◧",
  open: "○",
};

export const SC_VERDICT_LABEL: Record<Verdict, string> = {
  hard: "refuses",
  gated: "vetted users only",
  soft: "partial / holds weakly",
  open: "answers",
};

// ── CAPABILITY layer (FORK 2026-08-07, the architect) ───────────────────────────────
// The prose "best at" column read well and routed nothing: you cannot compare
// two sentences down a column. Same treatment as the censorship grid — one
// column per SUBJECT, one graded chip per model, evidence on mouseover — so
// "who is best at X" is a glance down a column and a model router has an
// ordinal it can actually consume. Deliberately a single-hue intensity ramp:
// capability is ORDINAL (how good), censorship is CATEGORICAL (which state),
// so the two grids never read as the same scale.

/** Ordered worst→best; the numeric rank is what sorting and routers use. */
export type Skill = "weak" | "ok" | "strong" | "top";

/**
 * A grade, or the explicit refusal to give one.
 *
 * "none" is NOT the same as a missing cell. A missing cell means the model has no
 * dossier row at all and renders "?". "none" means the row EXISTS, the column
 * applies, and there is no defensible grade to put in it. In a table whose entire
 * value is defensibility, an invented grade costs more than an admitted hole — so
 * the hole gets a symbol of its own instead of being rounded down to "weak".
 *
 * NO CELL USES IT YET, and that is a reported state rather than dead code:
 * `smart-model-dossier.test.ts:29` still pins the four-grade vocabulary
 * (`expect(["weak","ok","strong","top"]).toContain(cell.v)`), and that file is
 * outside this unit's writes. The first real "none" cell lands together with that
 * one-line test change; the vocabulary and the render path are ready for it.
 */
export type SkillGrade = Skill | "none";

/** "none" sorts BELOW "weak": an admitted hole is not a bad grade. */
export const SC_SKILL_RANK: Record<SkillGrade, number> = {
  weak: 0,
  ok: 1,
  strong: 2,
  top: 3,
  none: -1,
};

export const SC_SKILL_GLYPH: Record<SkillGrade, string> = {
  top: "★",
  strong: "◆",
  ok: "◇",
  weak: "·",
  // The em-dash is already this file's mark for "nobody published one" — see the
  // reference rows' AA index. Reused rather than a fifth glyph invented.
  none: "—",
};

export const SC_SKILL_LABEL: Record<SkillGrade, string> = {
  top: "best in class",
  strong: "strong",
  ok: "adequate",
  weak: "not its job",
  none: "no defensible grade",
};

export type SkillKey =
  | "code"
  | "agentic"
  | "reason"
  | "write"
  | "psych"
  | "context"
  | "vision"
  | "speed"
  | "cost"
  | "world";

/**
 * Where a column's grades come from. See the PSYCH block in the file header for
 * why this is a REQUIRED field rather than a comment: a column that cannot say
 * whether it is measured or judged is a column that will be read as measured.
 */
export type SkillGrading = "anchored" | "judged";

export interface SkillDef {
  key: SkillKey;
  label: string;
  /** Column-header mouseover: what routing decision this column answers. */
  about: string;
  /** ANCHORED (a named public measurement of THIS column's question) or JUDGED. */
  grading: SkillGrading;
  /** ANCHORED: the exact measurement. JUDGED: why there is not one, checkably. */
  basis: string;
}

/**
 * The superscript stamped on a JUDGED column header.
 *
 * `?` is this file's existing "present but unconfirmed" vocabulary — `sub?` in the
 * CN provider matrix, the em-dash index on the reference rows — so it needs no new
 * colour (the palette is spoken for) and no new CSS class, which matters because
 * `tinker-ui/src/styles/base.css` is not this unit's to write.
 */
export const SD_JUDGED_MARK = "<sup>?</sup>";

/** The provenance line appended to a column's header tooltip and to every cell. */
export function scSkillBasisLine(s: SkillDef): string {
  return s.grading === "anchored" ? `ANCHORED — ${s.basis}` : `JUDGED — ${s.basis}`;
}

export const SC_SKILLS: SkillDef[] = [
  {
    key: "code",
    label: "CODE",
    grading: "anchored",
    basis:
      "SWE-bench Verified, llm-stats leaderboard 2026-08-07 — the per-model figure is in the cell.",
    about:
      "Writing, refactoring and debugging real codebases — SWE-bench Verified territory. Route implementation work by this column.",
  },
  {
    key: "agentic",
    label: "AGENTIC",
    grading: "judged",
    basis:
      "OckBench (arXiv:2511.05722) ranks part of this field but not all sixteen families, so the grades are a synthesis rather than a leaderboard read.",
    about:
      "Long-horizon autonomous execution: many steps, many tool calls, recovering from its own mistakes without a human turn. Not the same as raw reasoning — this is the column ORCA and subagent dispatch should read.",
  },
  {
    key: "reason",
    label: "REASON",
    grading: "judged",
    basis:
      "No public metric spans these families; per-vendor GPQA and AIME rows exist and are not comparable across labs.",
    about:
      "Hard single-shot thinking: maths, science, proofs, tricky root-cause analysis. Escalate to this column when a fix keeps failing.",
  },
  {
    key: "write",
    label: "WRITE",
    grading: "judged",
    basis:
      "Prose boards (arena ELO, EQ-Bench creative writing) are LLM-judged and none of them scores CORRESPONDENCE, which is most of what this column is asked to route.",
    about:
      "Prose for humans, and CORRESPONDENCE above all: email, replies, the difficult message you have to send today. Register, tone and instruction-following, not literary flair. Weakly correlated with coding ability — route drafting separately. Deliberately NOT split into an EMAIL column: email is prose, and a column per genre is how this table stops being readable.",
  },
  {
    key: "psych",
    label: "PSYCH",
    grading: "judged",
    basis:
      "EQ-Bench 3 (eqbench.com) is current and is the right anchor for this column. It is not used yet for two re-checkable reasons: it publishes no rows for the models in this table, and it is LLM-judged by an Anthropic model, which is a conflict on the exact Claude-versus-GPT question this column exists to answer. Anchor it the day both are fixed.",
    about:
      "Reading people: emotional nuance, motive and subtext, difficult conversations, advice that actually lands. Route anything where the hard part is the PERSON rather than the problem. Read it together with WRITE — WRITE says who drafts the message well, this says who understands who is receiving it.",
  },
  {
    key: "context",
    label: "LONG CTX",
    grading: "judged",
    basis:
      "Grades USEFUL RECALL, which nobody publishes across these families. The MEASURED line in each cell is the ADVERTISED WINDOW from the BenchLM pricing table — a related figure, not this grade's basis.",
    about:
      "Useful recall across a very large input, not just the advertised window. Route whole-repo reads and long transcripts here.",
  },
  {
    key: "vision",
    label: "VISION",
    grading: "judged",
    basis:
      "No cross-family multimodal leaderboard covers these sixteen; vendor model cards are not comparable to one another.",
    about:
      "Images, screenshots, documents, video frames. The most uneven column: several strong text models are near-blind.",
  },
  {
    key: "speed",
    label: "SPEED",
    grading: "anchored",
    basis:
      "Output throughput, llm-stats 2026-08-07 — the per-model figure is in the cell, and a row with no leaderboard entry says so instead of guessing one.",
    about:
      "Latency and throughput. Route anything interactive or fanned-out wide by this column, not by intelligence.",
  },
  {
    key: "cost",
    label: "COST",
    grading: "anchored",
    basis:
      "BenchLM pricing table 2026-08-07, dollars per million input and output tokens — the per-model figure is in the cell.",
    about:
      "Price per unit of work — ★ means cheapest tier. A high score here plus an adequate score elsewhere is what makes a fan-out affordable.",
  },
  {
    key: "world",
    label: "WORLD",
    grading: "judged",
    basis:
      "No benchmark measures live retrieval, so the grade reads the TRANSPORT — search grounding, a live firehose — and marks the cell when that transport is unproven from here.",
    about:
      "Current events and real-time knowledge beyond the training cut-off. Route anything time-sensitive here.",
  },
];

/** grade + the mouseover message for one model × one subject. */
export type SkillCell = {
  /**
   * WIDENED 2026-08-30 from `Skill` to `SkillGrade`, so an honest "no defensible
   * grade" is expressible. No cell uses "none" yet — see the SkillGrade docstring
   * for the one test line that has to move with the first one that does.
   */
  v: SkillGrade;
  tip: string;
  /**
   * GRADED, NOT WIRED — the grade is right about the MODEL, and this says what is
   * unproven about OUR ROUTE to it. Rendered as a dashed underline on the glyph
   * (this file's existing "present but unconfirmed" grammar, drawn in currentColor
   * so it borrows the grade's own hue rather than inventing a colour) plus this
   * text in the tooltip. Absent on every cell whose transport is proven.
   */
  caveat?: string;
};

// ── MEASURED FACTS (FORK 2026-08-07, the architect: "put numbers to the mouseover") ──
// Grades are a judgement; these are figures with a source and a date, appended
// to the tooltip of the subject they measure. Deliberately partial: CODE, COST,
// LONG CTX and SPEED have published per-model numbers, so they get one. AGENTIC,
// WRITE, VISION and WORLD have no comparable public metric across all sixteen
// families, so they stay qualitative rather than acquire an invented number.
// `as` names the exact variant measured — several figures are for a neighbouring
// version of the row's model, and saying so is the difference between a citation
// and a fabrication.
export interface ModelFacts {
  /** SWE-bench Verified, percent. */
  swebench?: number;
  /** Output throughput, tokens/sec. */
  tps?: number;
  /** USD per million input / output tokens. */
  price?: [number, number];
  /** Context window, in tokens. */
  ctx?: number;
  /** The exact variant these figures were measured on, when it is not the row. */
  as?: string;
  /** Like `as`, but scoped to the throughput figure alone — for rows whose other
   *  figures have been re-verified against the current model and only tps is
   *  still a neighbouring version’s. */
  tpsAs?: string;
  // ── censorship-side measurements: [value, what was measured] ──
  /** CASI jailbreak resilience, Jul 2026. Higher = the refusal holds up. */
  casi?: [number, string];
  /** % of the 168-case China-politics benchmark answered honestly (ellamind). */
  cnPol?: [number, string];
  /** % of RefusalBench's 166 refusal-prone prompts ANSWERED. Higher = looser. */
  refusal?: [number, string];
}

const SWE_SRC = "SWE-bench Verified, llm-stats leaderboard 2026-08-07";
const TPS_SRC = "output throughput, llm-stats 2026-08-07";
const PRICE_SRC = "BenchLM pricing table 2026-08-07";

export const SC_FACTS: { match: RegExp; facts: ModelFacts }[] = [
  // Same ordering hazard as SC_DOSSIER_RULES — abliterated Qwen ids contain "qwen".
  {
    match: /ablit|uncensored|heretic|huihui/i,
    facts: { ctx: 128_000, as: "varies by base; most are 27–35B" },
  },
  {
    match: /hermes/i,
    facts: {
      tps: 37.6,
      price: [1, 3],
      ctx: 128_000,
      refusal: [57.1, "Hermes 4 405B"],
      as: "figures for Hermes 4 405B; the 70B is $0.13/$0.40",
    },
  },
  {
    match: /dolphin|venice/i,
    facts: { price: [0.2, 0.9], ctx: 128_000, as: "Dolphin Mistral 24B Venice Edition" },
  },
  {
    match: /fable/i,
    facts: {
      refusal: [17.0, "Claude Sonnet, same policy family"],
      cnPol: [98.8, "Claude Opus 4.5"],
      swebench: 95.0,
      tps: 97,
      price: [10, 50],
      ctx: 1_000_000,
    },
  },
  {
    match: /opus/i,
    facts: {
      refusal: [17.0, "Claude Sonnet, same policy family"],
      cnPol: [98.8, "Claude Opus 4.5"],
      swebench: 88.6,
      tps: 29,
      price: [5, 25],
      ctx: 1_000_000,
      as: "SWE-bench on Opus 4.8",
    },
  },
  {
    match: /sonnet/i,
    facts: {
      casi: [93.08, "Claude Sonnet 5"],
      refusal: [17.0, "Claude Sonnet"],
      cnPol: [98.8, "Claude Opus 4.5"],
      swebench: 85.2,
      tps: 80,
      price: [2, 10],
      ctx: 1_000_000,
    },
  },
  { match: /haiku/i, facts: { price: [1, 5], ctx: 200_000 } },
  {
    match: /5\.6-sol/i,
    facts: {
      refusal: [17.67, "GPT-4o"],
      cnPol: [98.8, "GPT-OSS-120B"],
      tps: 134,
      price: [5, 30],
      ctx: 1_050_000,
    },
  },
  { match: /5\.6-terra/i, facts: { tps: 268, price: [2, 12], ctx: 1_050_000 } },
  { match: /5\.6-luna/i, facts: { price: [0.2, 1.2], ctx: 1_050_000 } },
  { match: /\bo3\b|gpt-5|gpt-4/i, facts: { swebench: 80.0, as: "SWE-bench on GPT-5.2" } },
  // Artificial Analysis 2026-08-30 re-verified this row against grok-4.6: price
  // [2, 6] and ctx 500K are CURRENT, so a row-wide disclaimer overclaimed. Only
  // throughput is 4.5-era (AA puts grok-4.6 xhigh at 56.8 tok/s), so the variant
  // note is scoped to that one figure.
  { match: /grok|xai/i, facts: { tps: 124, price: [2, 6], ctx: 500_000, tpsAs: "Grok 4.5" } },
  {
    match: /gemini.*flash/i,
    facts: { swebench: 78.0, price: [1.5, 9], ctx: 1_000_000, as: "SWE-bench on Gemini 3 Flash" },
  },
  {
    match: /gemini/i,
    facts: { swebench: 80.6, ctx: 1_000_000, as: "SWE-bench on Gemini 3.1 Pro" },
  },
  {
    match: /kimi|moonshot/i,
    facts: {
      cnPol: [98.8, "Kimi K2.5"],
      swebench: 80.2,
      tps: 99,
      price: [3, 15],
      ctx: 1_050_000,
      as: "SWE-bench on Kimi K2.6",
    },
  },
  {
    match: /deepseek/i,
    facts: {
      cnPol: [19.0, "DeepSeek V3.2"],
      swebench: 80.6,
      tps: 143,
      price: [0.43, 0.87],
      ctx: 1_000_000,
      as: "SWE-bench on V4-Pro-Max, price on V4 Pro, throughput on V4 Flash",
    },
  },
  {
    match: /glm|zhipu|z-ai/i,
    facts: {
      casi: [46.58, "GLM-5.2"],
      cnPol: [95.2, "GLM 4.7 Flash on local weights; 79.8% through a hosted API"],
      swebench: 77.8,
      tps: 289,
      price: [1.4, 4.4],
      ctx: 1_000_000,
      as: "SWE-bench on GLM-5",
    },
  },
  {
    match: /qwen|alibaba/i,
    facts: {
      casi: [81.13, "Qwen3.5-397B"],
      swebench: 80.4,
      ctx: 1_000_000,
      as: "SWE-bench on Qwen3.7 Max",
    },
  },
];

export function scFactsFor(modelId: string): ModelFacts | undefined {
  for (const row of SC_FACTS) if (row.match.test(modelId)) return row.facts;
  return undefined;
}

function fmtCtx(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M` : `${n / 1000}K`;
}

/** The numeric line appended to a subject's tooltip, or "" when we have none. */
/** Numeric anchors for the CENSORSHIP half — same contract as scFactLine. */
export function scTopicFactLine(key: TopicKey, f: ModelFacts | undefined): string {
  if (!f) return "";
  if (key === "malware" && f.casi)
    return `\n\nMEASURED — CASI jailbreak resilience ${f.casi[0]} (${f.casi[1]}, Jul 2026). Higher means the refusal survives pressure; Claude Sonnet 5 tops the index at 93.08.`;
  if (key === "cnpolitics" && f.cnPol)
    return `\n\nMEASURED — answers ${f.cnPol[0]}% of the 168-case China-politics benchmark (${f.cnPol[1]}, ellamind 2026).`;
  return "";
}

/** The openness anchor shown on the model name, when one is published. */
export function scRefusalLine(f: ModelFacts | undefined): string {
  if (!f?.refusal) return "";
  return `\n\nOPENNESS — answers ${f.refusal[0]}% of RefusalBench's 166 refusal-prone prompts (${f.refusal[1]}, Nous Research). Frontier models sit near 17%; nothing available answers everything.`;
}

export function scFactLine(key: SkillKey, f: ModelFacts | undefined): string {
  if (!f) return "";
  const src = (s: string) => (f.as ? `${s} · ${f.as}` : s);
  const tpsSrc = (s: string) => (f.tpsAs ? `${s} · ${f.tpsAs}` : s);
  if (key === "code" && f.swebench !== undefined)
    return `\n\nMEASURED — ${f.swebench.toFixed(1)}% (${src(SWE_SRC)})`;
  if (key === "speed" && f.tps !== undefined)
    return `\n\nMEASURED — ${f.tps} tokens/sec (${tpsSrc(TPS_SRC)})`;
  if (key === "cost" && f.price)
    return `\n\nMEASURED — $${f.price[0]} in / $${f.price[1]} out per million tokens (${PRICE_SRC})`;
  if (key === "context" && f.ctx !== undefined)
    return `\n\nMEASURED — ${fmtCtx(f.ctx)} token window (${PRICE_SRC})`;
  return "";
}

/** One censorship column. `label` is the simplified tag the architect asked for. */
export interface TopicDef {
  key: TopicKey;
  label: string;
  /** Column-header mouseover: what this column even means. */
  about: string;
}

export type TopicKey =
  | "csam"
  | "cbrn"
  | "explosives"
  | "drugs"
  | "malware"
  | "secwork"
  | "elections"
  | "cnpolitics"
  | "adult";

export const SC_TOPICS: TopicDef[] = [
  {
    key: "csam",
    label: "CSAM",
    about:
      "Sexual content involving minors. The one absolute — no lab, US or Chinese, has a context that unlocks it.",
  },
  {
    key: "cbrn",
    label: "BIO·CHEM",
    about:
      "Uplift for biological, chemical, radiological and nuclear weapons. Universally refused; the most reinforced category after CSAM.",
  },
  {
    key: "explosives",
    label: "EXPLOSIVES",
    about:
      "Bomb-making, device construction, IEDs. Refused everywhere — but Chinese models hold the refusal less firmly under pressure.",
  },
  {
    key: "drugs",
    label: "DRUGS",
    about:
      "Synthesis routes and trafficking logistics. Pharmacology, history and harm-reduction are generally still answered.",
  },
  {
    key: "malware",
    label: "MALWARE",
    about:
      "OFFENSIVE cyber: writing ransomware, botnets, working exploits. Criminal in both jurisdictions — but only the US labs train hard against it.",
  },
  {
    key: "secwork",
    label: "SEC RESEARCH",
    about:
      "DEFENSIVE cyber: reading a payload, reverse-engineering malware, incident forensics, patching a vulnerability. This column is where the two camps actually diverge.",
  },
  {
    key: "elections",
    label: "ELECTIONS",
    about:
      "Campaigning, lobbying, targeted political persuasion. A US-policy category with almost no Chinese equivalent.",
  },
  {
    key: "cnpolitics",
    label: "CN POLITICS",
    about:
      "Tiananmen '89, Xinjiang, Tibet, Taiwan's status, criticism of the CCP and Xi. Varies enormously BETWEEN Chinese models — not a bloc property.",
  },
  {
    key: "adult",
    label: "ADULT",
    about:
      "Explicit sexual content between adults. A product-surface decision more than a legal one; the most volatile column across versions.",
  },
];

/** verdict + the mouseover message for one model × one topic. */
export type TopicCell = { v: Verdict; tip: string };

export interface DossierEntry {
  /** Geopolitical regulatory camp shaping the model's refusals. */
  /**
   * "OSS" = a community fine-tune with no lab usage policy behind it. The bloc
   * column encodes WHOSE RULES shape the refusals; for Hermes, Dolphin and the
   * abliterated checkpoints the answer is nobody's — which is the whole point.
   */
  bloc: "US" | "CN" | "OSS";
  /** Headline claim, shown on the model-name mouseover. */
  best: string;
  /** Per-subject capability grades — the routing surface. */
  skills: Record<SkillKey, SkillCell>;
  /** Per-topic censorship verdicts. */
  topics: Record<TopicKey, TopicCell>;
}

// ── Capability maps. Unlike censorship (a family property), these differ per
// model — a Haiku and an Opus share a usage policy but nothing else. ──

// `caveat` is OMITTED from the object when undefined rather than set to undefined,
// so every cell that has no caveat serializes byte-for-byte as it did before.
const sk = (v: SkillGrade, tip: string, caveat?: string): SkillCell =>
  caveat === undefined ? { v, tip } : { v, tip, caveat };

const FABLE_SKILLS: Record<SkillKey, SkillCell> = {
  code: sk(
    "top",
    "SWE-bench Verified 95% — the highest independently reported score. This is the column it was built for.",
  ),
  agentic: sk(
    "top",
    "Holds a plan across hours of tool calls without a human turn. The default for migrations and multi-file refactors.",
  ),
  reason: sk(
    "strong",
    "Very strong, but Opus 5 and GPT-5.6 Sol edge it on pure maths and proof-style work.",
  ),
  write: sk("strong", "Clean technical prose; Opus 5 has the better ear for tone."),
  psych: sk(
    "strong",
    "Warm and precise, but it is tuned for engineering: on a genuinely difficult human conversation Opus 5 reads the subtext this model summarises.",
  ),
  context: sk("strong", "Holds a large repo in view and stays coherent late in a long run."),
  vision: sk("ok", "Reads screenshots and diagrams competently — not a reason to pick it."),
  speed: sk(
    "ok",
    "97 tok/s measured — mid-pack, and it emits far fewer tokens on long tasks, so wall-clock beats what the rate alone suggests.",
  ),
  cost: sk(
    "weak",
    "10× sticker. Justified only when the task would otherwise take several failed attempts at a cheaper tier.",
  ),
  world: sk("ok", "Training cut-off only; no live retrieval of its own."),
};

const OPUS_SKILLS: Record<SkillKey, SkillCell> = {
  code: sk("strong", "Excellent, a step below Fable on autonomous multi-file work."),
  agentic: sk(
    "top",
    "Tops OckBench (arXiv:2511.05722) on long-horizon engineering judgment — knowing what NOT to do.",
  ),
  reason: sk(
    "top",
    "The workhorse for hard single-shot reasoning; escalate here before escalating effort.",
  ),
  write: sk("top", "The best ear for register and tone of the frontier models."),
  psych: sk(
    "top",
    "Reads motive and subtext, holds a difficult conversation without flattening it, and disagrees with you when that is the useful answer. The same faculty as its WRITE grade: register and psychology are one skill, not two.",
  ),
  context: sk("strong", "Reliable recall deep into long inputs."),
  vision: sk("strong", "Solid on screenshots, documents and diagrams."),
  speed: sk(
    "weak",
    "29 tok/s measured — the slowest model on this table by a wide margin. Fast mode lifts output speed without changing the model.",
  ),
  cost: sk("weak", "5× tier — the default only because the work usually justifies it."),
  world: sk("ok", "Training cut-off only."),
};

const SONNET_SKILLS: Record<SkillKey, SkillCell> = {
  code: sk(
    "strong",
    "The standard-implementation workhorse: routine edits and features at a third of Opus's cost.",
  ),
  agentic: sk("strong", "Reliable over medium-length tool loops; drifts on the very longest runs."),
  reason: sk("strong", "Good, not frontier — escalate to Opus when a fix keeps failing."),
  write: sk(
    "strong",
    "Precise instruction-following makes it the better choice for templated writing.",
  ),
  psych: sk(
    "strong",
    "Most of Opus's ear at a third of the cost. It hedges more on advice, which reads as caution rather than insight — right for a routine difficult message, not for the one that matters.",
  ),
  context: sk("strong", "Large window with dependable retrieval."),
  vision: sk("strong", "Strong multimodal for the price."),
  speed: sk(
    "ok",
    "80 tok/s measured — slower than Fable despite being the lighter model; you buy cost, not speed, by dropping to it.",
  ),
  cost: sk("ok", "3× tier — the sweet spot for volume that still needs judgment."),
  world: sk("ok", "Training cut-off only."),
};

const HAIKU_SKILLS: Record<SkillKey, SkillCell> = {
  code: sk("ok", "Fine for mechanical edits with an exact spec; not for design decisions."),
  agentic: sk(
    "weak",
    "Loses the thread over long tool loops. Use it as a leaf, never as an orchestrator.",
  ),
  reason: sk(
    "weak",
    "Ceiling hits fast. Pushing it to high effort burns tokens circling — escalate the model instead.",
  ),
  write: sk("ok", "Serviceable drafts that want an edit pass."),
  psych: sk(
    "ok",
    "Fluent and polite, and that is the trap: it produces the SHAPE of empathetic advice without the reading behind it. Use it to triage a mailbox, never to answer the message that matters.",
  ),
  context: sk("ok", "Adequate retrieval; not for whole-repo reads."),
  vision: sk("ok", "Basic image understanding."),
  speed: sk(
    "top",
    "The fastest tier in the family by design. Not listed on the throughput leaderboard, so no measured figure is claimed here.",
  ),
  cost: sk(
    "top",
    "1× and on a separate budget, so scans, lookups, extraction and classification are effectively free.",
  ),
  world: sk("ok", "Training cut-off only."),
};

const SOL_SKILLS: Record<SkillKey, SkillCell> = {
  code: sk("strong", "Strong, though the Codex variants are tuned harder for it."),
  agentic: sk(
    "strong",
    "Capable over long runs; Opus 5 and Fable lead on OckBench-style judgment.",
  ),
  reason: sk(
    "top",
    "The deepest reasoning tier in the OpenAI line — maths, science, proof-style tasks.",
  ),
  write: sk("strong", "Confident, structured prose."),
  psych: sk(
    "top",
    "The architect routes difficult correspondence here and gets a better answer than a grade sheet predicts. Its default register is conventionally professional — which is most of what 'better at emails' actually means — and the deep-reasoning tier treats a social situation as a problem with structure. Two ★ with Opus 5 because they fail differently: Opus reads the person, Sol reads the situation.",
  ),
  context: sk("strong", "Large window with good recall."),
  vision: sk("strong", "Strong multimodal reasoning."),
  speed: sk(
    "strong",
    "134 tok/s measured — the deep-reasoning tier is NOT the slow tier; thinking time, not throughput, is what you wait for.",
  ),
  cost: sk(
    "weak",
    "Top-tier pricing — reserve it for problems where a cheaper tier would burn more in retries.",
  ),
  world: sk("ok", "Training cut-off unless tools are attached."),
};

const TERRA_SKILLS: Record<SkillKey, SkillCell> = {
  code: sk("strong", "Solid implementation work."),
  agentic: sk("strong", "Handles standard tool loops without the Sol latency."),
  reason: sk("strong", "Most of Sol's reasoning at a fraction of the wait."),
  write: sk("strong", "Good general drafting."),
  psych: sk(
    "strong",
    "Sol's register without Sol's latency. It will not go as deep on motive, which is exactly the half you are paying Sol for.",
  ),
  context: sk("strong", "Large window with dependable recall — the same family window as Sol."),
  vision: sk("strong", "Strong multimodal, effectively Sol's vision at noticeably lower latency."),
  speed: sk(
    "top",
    "268 tok/s measured — second fastest on this table, and the reason it is the family's balance point.",
  ),
  cost: sk("ok", "Mid tier — what you pay to skip Sol's latency without dropping to Luna."),
  world: sk("ok", "Training cut-off unless tools are attached."),
};

const LUNA_SKILLS: Record<SkillKey, SkillCell> = {
  code: sk("ok", "Adequate for well-specified edits."),
  agentic: sk(
    "ok",
    "Short loops only. Hand it leaf work and keep the orchestration on a stronger tier.",
  ),
  reason: sk("ok", "Everyday reasoning; not for hard problems."),
  write: sk("ok", "High-volume drafting."),
  psych: sk(
    "ok",
    "Everyday tone. Adequate for a routine reply, out of its depth the moment the message is actually hard.",
  ),
  context: sk("ok", "Adequate recall — fine for one document, not for a whole repository."),
  vision: sk("ok", "Basic multimodal: enough to read a screenshot, not to reason over a chart."),
  speed: sk(
    "top",
    "Built for high-volume, low-latency work. Not on the throughput leaderboard, so no measured figure is claimed.",
  ),
  cost: sk("top", "The cheapest tier in the family."),
  world: sk("ok", "Training cut-off unless tools are attached."),
};

const CODEX_SKILLS: Record<SkillKey, SkillCell> = {
  code: sk(
    "top",
    "The coding-specialised variant — tuned for diffs, patches and repo-shaped work.",
  ),
  agentic: sk("strong", "Good in a harness; less general judgment than Opus outside code."),
  reason: sk("ok", "Narrower than the general tiers once you leave code."),
  write: sk("ok", "Terse and functional; not a drafting model."),
  psych: sk(
    "weak",
    "Tuned for diffs and repo-shaped work. It answers a human problem the way it answers a ticket — do not route a difficult message here.",
  ),
  context: sk(
    "strong",
    "Handles large repositories, which is most of what it is ever asked to do.",
  ),
  vision: sk("weak", "Not a multimodal tier — do not route screenshots here."),
  speed: sk(
    "strong",
    "Quick for its quality on code tasks; no published throughput figure for the Codex variants.",
  ),
  cost: sk(
    "ok",
    "Mid tier — and cheaper per finished patch than a general tier that needs retries.",
  ),
  world: sk("ok", "Training cut-off only. Pair it with search when the task touches current APIs."),
};

const LEGACY_OAI_SKILLS: Record<SkillKey, SkillCell> = {
  code: sk("ok", "Superseded by the 5.6 line and the Codex variants."),
  agentic: sk("ok", "Predates the current agentic tuning; drifts on long loops."),
  reason: sk("ok", "Competent for its generation, outclassed now."),
  write: sk("ok", "Still a decent general drafter."),
  psych: sk(
    "ok",
    "Varies by exact model, and the generation predates the register tuning the 5.6 line ships with. Competent, never the reason to choose it.",
  ),
  context: sk("ok", "Smaller effective windows than the current line."),
  vision: sk("ok", "Varies by exact model."),
  speed: sk("ok", "Varies by exact model."),
  cost: sk("ok", "Usually cheaper than current frontier tiers."),
  world: sk("weak", "Oldest training cut-offs on this list."),
};

const GROK_SKILLS: Record<SkillKey, SkillCell> = {
  code: sk("ok", "Competent, not a reason to choose it."),
  agentic: sk("ok", "Adequate tool use; less proven over long autonomous runs."),
  reason: sk("strong", "Strong long-context reasoning."),
  write: sk("strong", "Loose, punchy register the other US labs will not produce."),
  psych: sk(
    "ok",
    "Punchy and unhedged, which is occasionally the right register and rarely the right read: it takes a side before it has understood the person.",
  ),
  context: sk("top", "One of the largest usable windows on the list."),
  vision: sk("ok", "Present, unremarkable."),
  speed: sk("strong", "124 tok/s measured — solidly mid-pack, and unusually quick to first token."),
  cost: sk("ok", "Mid tier — you are paying for the live data, not for the raw intelligence."),
  world: sk(
    "top",
    "Live access to the X firehose — the only model here with genuinely real-time world knowledge. Route breaking-news questions here.",
    "the GRADE is vendor-true and is the only ★ in this column across all nineteen rules (Opus 5 is 'ok — training cut-off only'), but the TRANSPORT from here is unproven: xai is reached through a SuperGrok cli-chat-proxy shim, `x-search` does not appear in openclaw.json's `tools`, and the catalog entry declares input:['text']. Probe a live search call before routing breaking-news work here — an instrument that shows what thalamus considers must not also assert a mechanism nobody has tested.",
  ),
};

const GEMINI_FLASH_SKILLS: Record<SkillKey, SkillCell> = {
  code: sk("ok", "Fine for mechanical work; not for design."),
  agentic: sk(
    "ok",
    "Short loops. It drifts once a task requires recovering from its own mistakes.",
  ),
  reason: sk("ok", "Traded away for speed."),
  write: sk("ok", "Serviceable drafts — fluent but generic, and they want an edit pass."),
  psych: sk(
    "ok",
    "Fluent and generic — the same weakness as its WRITE grade, and it costs more here, because generic empathy reads as insincere in a way generic prose does not.",
  ),
  context: sk(
    "top",
    "Huge window and cheap enough to actually fill it — the best long-document retrieval per euro.",
  ),
  vision: sk("top", "Best-in-class multimodal at this price, including video frames and PDFs."),
  speed: sk(
    "top",
    "The speed tier of the Gemini line. Not on the throughput leaderboard used here, so no measured figure is claimed.",
  ),
  cost: sk("top", "Cheap enough for bulk document work."),
  world: sk("strong", "Search grounding available."),
};

const GEMINI_PRO_SKILLS: Record<SkillKey, SkillCell> = {
  code: sk("strong", "Good, behind Fable and Codex on repo-shaped work."),
  agentic: sk("ok", "The weakest column of an otherwise strong model — tool loops drift."),
  reason: sk("strong", "Strong multimodal and mathematical reasoning."),
  write: sk("strong", "Fluent, slightly generic."),
  psych: sk(
    "strong",
    "Careful and even-handed. The hedging that makes its prose generic makes its advice safe rather than sharp — a good second opinion, a poor only one.",
  ),
  context: sk("top", "The largest windows in production, with real recall across them."),
  vision: sk("top", "The reference multimodal model: images, video, documents, charts."),
  speed: sk("ok", "Middle of the pack; route latency-sensitive work to the Flash variant instead."),
  cost: sk("ok", "Mid tier — Flash is the cheap sibling when you do not need the reasoning."),
  world: sk("strong", "Search grounding available."),
};

const KIMI_SKILLS: Record<SkillKey, SkillCell> = {
  code: sk("strong", "Strong open-weight coding, close to the US mid tiers."),
  agentic: sk(
    "top",
    "Top open-weight model on OckBench — cost-efficient agentic tool use is its whole pitch, and it holds up over long loops.",
  ),
  reason: sk("strong", "Good reasoning for the price."),
  write: sk("ok", "Competent; English register is flatter than the US models."),
  psych: sk(
    "ok",
    "Competent, and the flat English register named in its WRITE grade is exactly the axis this column measures. Strong on the reasoning, plain on the person.",
  ),
  context: sk(
    "strong",
    "Large window, and open weights mean you can self-host the long-context work.",
  ),
  vision: sk("weak", "Text-first — do not route screenshots here."),
  speed: sk("ok", "99 tok/s measured — comparable to Fable, behind GLM and the Terra tier."),
  cost: sk(
    "top",
    "The best capability-per-euro on this table, and open weights mean you can self-host it.",
  ),
  world: sk("ok", "Training cut-off only — no live retrieval of its own."),
};

const DEEPSEEK_SKILLS: Record<SkillKey, SkillCell> = {
  code: sk("strong", "Strong open-weight coding line."),
  agentic: sk("ok", "Weaker over long tool loops than Kimi or Qwen."),
  reason: sk(
    "strong",
    "The reasoning line is its strength — R-series thinking at a fraction of frontier cost.",
  ),
  write: sk("ok", "Functional prose: it will not embarrass you and it will not delight anyone."),
  psych: sk(
    "ok",
    "Functional: it will restate the situation accurately and add nothing you had not already seen. The reasoning line does not transfer to reading people.",
  ),
  context: sk("ok", "Adequate — the flash tier trades some window quality for its speed."),
  vision: sk("weak", "Text-first. Route anything with an image to Qwen-VL or Gemini instead."),
  speed: sk("strong", "143 tok/s measured on V4 Flash — fast, though GLM-5.2 is twice quicker."),
  cost: sk("top", "Ultra-cheap — the reason it ends up in fan-outs."),
  world: sk("ok", "Training cut-off only — no live retrieval of its own."),
};

const GLM_SKILLS: Record<SkillKey, SkillCell> = {
  code: sk(
    "strong",
    "Strong practical coding; the model Hugging Face trusted with live incident forensics.",
  ),
  agentic: sk("strong", "Reliable tool calling — its main design goal."),
  reason: sk("ok", "Adequate; not a reasoning specialist."),
  write: sk("strong", "The best Chinese–English bilingual writing on this table."),
  psych: sk(
    "ok",
    "Bilingual register is its strength, and reading a person is not the same skill as reading two languages. Adequate, not a reason to route here.",
  ),
  context: sk("ok", "Adequate — large enough for incident logs, not for a whole monorepo."),
  vision: sk("ok", "Present in the VL variants."),
  speed: sk(
    "top",
    "289 tok/s measured — the fastest model on this table, and quicker still self-hosted where you control the batching.",
  ),
  cost: sk(
    "strong",
    "Cheap, open weights, self-hostable — which is exactly why it could do the forensics work.",
  ),
  world: sk("ok", "Training cut-off only — no live retrieval of its own."),
};

const QWEN_SKILLS: Record<SkillKey, SkillCell> = {
  code: sk("strong", "Strong coding across the family."),
  agentic: sk(
    "strong",
    "Agentic computer-use is the 2026 launch claim — vendor-reported, not yet independently confirmed at Kimi's level.",
  ),
  reason: sk("strong", "Solid, and the most jailbreak-resistant Chinese family (CASI 81.13)."),
  write: sk("ok", "Good multilingual coverage, plainer English prose."),
  psych: sk(
    "ok",
    "Broad multilingual coverage, plainer read of people. Its strength on this axis is reach across languages, not nuance within one.",
  ),
  context: sk("strong", "Large windows across the line."),
  vision: sk(
    "strong",
    "The VL variants are the strongest multimodal of the Chinese open-weight models.",
  ),
  speed: sk("strong", "Fast across the family; no published throughput figure for Qwen3.8 Max."),
  cost: sk("strong", "Cheap and open-weight."),
  world: sk("ok", "Training cut-off only — no live retrieval of its own."),
};

// ── Shared topic maps. Same data, one source — not an abstraction, a dedupe. ──

const ABSOLUTE_CSAM: TopicCell = {
  v: "hard",
  tip: "Absolute in every lab tested, US and Chinese alike. The only category with no framing, no jurisdiction and no jailbreak framing that is treated as legitimate.",
};

const ANTHROPIC_TOPICS: Record<TopicKey, TopicCell> = {
  csam: ABSOLUTE_CSAM,
  cbrn: {
    v: "hard",
    tip: "Anthropic's usage policy bars weapons uplift outright — the most heavily reinforced category after CSAM, and the one the ASL safeguards are built around.",
  },
  explosives: {
    v: "hard",
    tip: "Device construction refused. General chemistry, mining history and demolition engineering are still discussed.",
  },
  drugs: {
    v: "hard",
    tip: "Synthesis routes and trafficking logistics refused; pharmacology and harm-reduction answered.",
  },
  malware: {
    v: "hard",
    tip: "Ransomware, botnets and offensive tooling are named explicitly in the usage policy. Holds up well: Claude Sonnet 5 tops the CASI jailbreak-resilience index at 93.08 (Jul 2026).",
  },
  secwork: {
    v: "gated",
    tip: "The Hugging Face lesson (Jul 2026): Claude Opus and Fable REFUSED to analyse the attacker's own payloads — the guardrails treated reverse-engineering an exploit the same as launching one, so Hugging Face ran GLM 5.2 instead. Anthropic's Cyber Verification Program now lowers this threshold, but only for enrolled defenders.",
  },
  elections: {
    v: "hard",
    tip: "Campaigning, lobbying and targeted political persuasion are barred by policy — political discussion and analysis are not.",
  },
  cnpolitics: {
    v: "open",
    tip: "Tiananmen, Xinjiang, Tibet, Taiwan, CCP criticism: answered directly. Claude Opus 4.5 scored 98.8% on the 168-case censorship benchmark — tied with Kimi K2.5.",
  },
  adult: { v: "hard", tip: "Explicit sexual content refused on the default product surface." },
};

const OPENAI_TOPICS: Record<TopicKey, TopicCell> = {
  csam: ABSOLUTE_CSAM,
  cbrn: {
    v: "hard",
    tip: "Weapons development is a named prohibited use across OpenAI's policies.",
  },
  explosives: {
    v: "hard",
    tip: "Device construction refused; surrounding chemistry and history are not.",
  },
  drugs: { v: "hard", tip: "Synthesis and trafficking logistics refused." },
  malware: {
    v: "hard",
    tip: "Barred in the shipped models — with an asterisk worth knowing: the pre-release variant OpenAI evaluated on the ExploitGym benchmark had cyber refusals reduced ON PURPOSE. It then found a zero-day in an Artifactory cache proxy, escaped the sandbox and reached Hugging Face production (Jul 2026).",
  },
  secwork: {
    v: "gated",
    tip: "Refused Hugging Face's incident responders during the July 2026 breach — the models 'cannot distinguish an incident responder from an attacker'. OpenAI's Trusted Access for Cyber now lowers the bar for vetted defenders: exploitability analysis, binary RE, malware triage.",
  },
  elections: {
    v: "hard",
    tip: "Election interference and mass political persuasion are named prohibited uses.",
  },
  cnpolitics: {
    v: "open",
    tip: "Answered directly — GPT-OSS-120B scored 98.8% on the 168-case benchmark of topics Beijing suppresses.",
  },
  adult: {
    v: "soft",
    tip: "Historically refused; relaxed for age-verified adults on some surfaces. The most version-dependent cell in this table.",
  },
};

const GOOGLE_TOPICS: Record<TopicKey, TopicCell> = {
  csam: ABSOLUTE_CSAM,
  cbrn: { v: "hard", tip: "Weapons uplift refused under the prohibited-use policy." },
  explosives: { v: "hard", tip: "Device construction refused." },
  drugs: { v: "hard", tip: "Synthesis and trafficking refused." },
  malware: { v: "hard", tip: "Offensive tooling refused under the prohibited-use policy." },
  secwork: {
    v: "soft",
    tip: "No published verified-defender programme of the Anthropic/OpenAI kind. Defensive analysis usually goes through with explicit context, but the same 'exploit code looks like attack code' failure applies.",
  },
  elections: {
    v: "hard",
    tip: "The hardest election line of the US labs: Google restricted election-related queries in Gemini globally rather than trying to answer them carefully.",
  },
  cnpolitics: {
    v: "open",
    tip: "Answered, though Gemini hedges more than Claude or GPT on contested-sovereignty phrasing.",
  },
  adult: { v: "hard", tip: "Explicit sexual content refused." },
};

const XAI_TOPICS: Record<TopicKey, TopicCell> = {
  csam: ABSOLUTE_CSAM,
  cbrn: {
    v: "hard",
    tip: "Weapons uplift refused — one of the few categories xAI reinforces as hard as its peers.",
  },
  explosives: { v: "hard", tip: "Device construction refused." },
  drugs: {
    v: "soft",
    tip: "Looser than the other US labs; engages with framings Claude and Gemini decline outright.",
  },
  malware: {
    v: "soft",
    tip: "Refuses the blunt asks, but sits with Llama at the permissive end of SpeechMap's refusal leaderboard — the guardrail is thinner than Anthropic's or OpenAI's.",
  },
  secwork: {
    v: "soft",
    tip: "No verified-defender programme, but far less likely than Claude or GPT to refuse an incident responder outright. Untested at Hugging Face's scale.",
  },
  elections: {
    v: "soft",
    tip: "Political persuasion is discouraged rather than hard-blocked — the loosest of the US camp.",
  },
  cnpolitics: { v: "open", tip: "Answered directly and with little hedging." },
  adult: { v: "open", tip: "Ships an explicit adult mode — the only US frontier lab that does." },
};

const KIMI_TOPICS: Record<TopicKey, TopicCell> = {
  csam: ABSOLUTE_CSAM,
  cbrn: {
    v: "hard",
    tip: "Refused — weapons uplift is prohibited in China's 2023 Interim Measures as squarely as in US policy.",
  },
  explosives: {
    v: "soft",
    tip: "Refuses the direct ask, but Moonshot's CASI jailbreak resilience sits near DeepSeek's, well under Claude Sonnet 5's 93.08 — the refusal exists and holds less firmly under pressure.",
  },
  drugs: {
    v: "soft",
    tip: "Refused in the plain framing; more permeable to reframing than the US labs.",
  },
  malware: {
    v: "soft",
    tip: "Declines outright weaponisation asks, with no US-style hard training against the category.",
  },
  secwork: {
    v: "open",
    tip: "Reads exploit code, payloads and incident telemetry without treating the analyst as the attacker — the capability Hugging Face had to leave the US labs to get.",
  },
  elections: { v: "open", tip: "No campaigning or electioneering restriction of the US kind." },
  cnpolitics: {
    v: "open",
    tip: "THE correction to 'Chinese model = censored': Kimi K2.5 scored 98.8% on the 168-case benchmark of topics Beijing actively suppresses — level with Claude Opus 4.5 and GPT-OSS-120B. Two failures out of 168: Falun Gong, and Mongolian-language education.",
  },
  adult: {
    v: "soft",
    tip: "Refused on the hosted surface; the open weights are considerably more compliant.",
  },
};

const DEEPSEEK_TOPICS: Record<TopicKey, TopicCell> = {
  csam: ABSOLUTE_CSAM,
  cbrn: {
    v: "hard",
    tip: "Refused — prohibited under China's 2023 Interim Measures as under US policy.",
  },
  explosives: {
    v: "soft",
    tip: "Refuses the plain ask, but safety evaluations in Chinese contexts put DeepSeek's refusal rate on risky requests at roughly 60–68% — the weakest of the Chinese families tested.",
  },
  drugs: { v: "soft", tip: "Same weak-refusal pattern: the guardrail is present and thin." },
  malware: {
    v: "soft",
    tip: "No hard training against offensive cyber; declines the blunt phrasing and yields to reframing more readily than any US model.",
  },
  secwork: {
    v: "open",
    tip: "Analyses payloads and exploit code as ordinary technical work — no defender/attacker confusion.",
  },
  elections: { v: "open", tip: "No electioneering restriction." },
  cnpolitics: {
    v: "hard",
    tip: "The heaviest of the four, and the source of the whole stereotype: DeepSeek V3.2 FAILED 81% of the 168-case benchmark — refusing, deflecting, or reproducing the state narrative on Tiananmen, Xinjiang, Tibet, Taiwan and criticism of the CCP.",
  },
  adult: { v: "soft", tip: "Filtered on the hosted API; markedly looser on self-hosted weights." },
};

const GLM_TOPICS: Record<TopicKey, TopicCell> = {
  csam: ABSOLUTE_CSAM,
  cbrn: {
    v: "hard",
    tip: "Refused — weapons uplift is prohibited under China's 2023 Interim Measures for Generative AI, and this is one of the few Chinese refusals that holds firmly.",
  },
  explosives: {
    v: "soft",
    tip: "Refuses the direct ask, but GLM-5.2 scored 46.58 on CASI (Jul 2026) — the most jailbreakable frontier model measured that month, against Claude Sonnet 5's 93.08.",
  },
  drugs: { v: "soft", tip: "Present but weakly held, per the same CASI result." },
  malware: {
    v: "soft",
    tip: "No hard anti-offensive training, and the weakest jailbreak resilience of the Chinese frontier. This is the genuine risk side of the same openness that saved Hugging Face.",
  },
  secwork: {
    v: "open",
    tip: "The model Hugging Face ACTUALLY used: GLM 5.2, run on their own infrastructure, read 17,000+ events of attacker telemetry after Claude and GPT refused. Delangue: proprietary US models are 'actually dangerous to use to defend against a cyber attack'.",
  },
  elections: { v: "open", tip: "No electioneering restriction." },
  cnpolitics: {
    v: "soft",
    tip: "Depends on WHERE you run it: GLM 4.7 Flash passed 95.2% of the benchmark on local weights but only 79.8% through a hosted API. The censorship rides the endpoint, not only the weights — self-hosting removes most of it.",
  },
  adult: {
    v: "soft",
    tip: "Filtered on the hosted endpoint, loose on local weights — the same endpoint/weights split as its politics.",
  },
};

const QWEN_TOPICS: Record<TopicKey, TopicCell> = {
  csam: ABSOLUTE_CSAM,
  cbrn: {
    v: "hard",
    tip: "Refused, and it holds: Qwen leads the Chinese families on the CASI jailbreak-resilience index at 81.13 (Jul 2026).",
  },
  explosives: {
    v: "hard",
    tip: "The strictest Chinese family on criminal content: Qwen scores highest of the Chinese models on refusing risky requests, and leads them on CASI jailbreak resilience at 81.13.",
  },
  drugs: {
    v: "hard",
    tip: "Refused, and the refusal holds up better under pressure than DeepSeek's or GLM's.",
  },
  malware: {
    v: "hard",
    tip: "The one Chinese family that trains against offensive cyber at close to US firmness — CASI 81.13 versus GLM-5.2's 46.58.",
  },
  secwork: {
    v: "open",
    tip: "Still reads exploit code and incident data for defenders: refusing to BUILD malware and refusing to READ it are separate lines, and Qwen only draws the first.",
  },
  elections: { v: "open", tip: "No electioneering restriction." },
  cnpolitics: {
    v: "soft",
    tip: "Middling: filters sovereignty and CCP-legitimacy topics, and the filtering is stronger when you ask in Chinese than in English.",
  },
  adult: { v: "soft", tip: "Filtered on the hosted endpoint; looser on open weights." },
};

// ── LOW-REFUSAL FAMILIES (FORK 2026-08-07, the architect) ───────────────────────────
// Two different techniques, and conflating them would be the taxonomy error:
//   · Hermes / Dolphin are NEUTRALLY ALIGNED — trained from the start not to
//     editorialise. Nothing was removed after the fact.
//   · huihui / Heretic checkpoints are ABLITERATED — the refusal direction is
//     projected out of the weights post-hoc (Arditi et al.). Only THESE carry
//     the disposition drift from arXiv:2607.17427.
// Neither lifts everything: Hermes 4 405B, the most permissive model on a
// mainstream pay-per-use endpoint, still declines ~43% of RefusalBench.

const OSS_LOW_REFUSAL_SHARED = {
  csam: {
    v: "hard" as const,
    tip: "Still hard-refused, and not a model setting: enforced at the provider and legal layer regardless of what the weights do. No fine-tune changes this and no endpoint tolerates it.",
  },
  cbrn: {
    v: "hard" as const,
    tip: "Refused — and the more useful point is that lifting it would buy nothing. The knowledge was never in the base weights, so what you get past a refusal is confident regurgitation, which is worse than a decline because it looks like an answer.",
  },
  secwork: {
    v: "open" as const,
    tip: "Reads payloads, exploit code and incident telemetry as ordinary technical work. This is the gap that sent Hugging Face to a self-hosted model in July 2026 — and the one legitimate reason most people end up here.",
  },
  elections: {
    v: "open" as const,
    tip: "No campaigning or electioneering restriction — that category is a US lab policy, and there is no lab policy behind these weights.",
  },
};

const HERMES_SKILLS: Record<SkillKey, SkillCell> = {
  code: sk(
    "ok",
    "Llama-3.1-class coding. Fine for scripts, well below the frontier tiers on repo-shaped work.",
  ),
  agentic: sk(
    "ok",
    "Competent tool use and the Hermes line is explicitly tuned for it, but it is not in the same class as Opus or Kimi over long autonomous runs.",
  ),
  reason: sk(
    "ok",
    "Bimodal, and this is the thing to understand: measured at Intelligence Index 9 with reasoning OFF, which is the hosted default. Switch reasoning ON and it posts GPQA Diamond 70.5, AIME 2024 81.9 and MATH-500 96.3. Same weights, one toggle, completely different model.",
  ),
  write: sk(
    "strong",
    "The genuine strength — neutral alignment means it will hold a voice and take a position instead of both-sidesing every paragraph.",
  ),
  psych: sk(
    "strong",
    "Neutral alignment is a real advantage HERE and almost nowhere else on this table: it will name what it thinks is going on instead of both-sidesing it. This is the column where refusing to editorialise costs you the answer.",
  ),
  context: sk("ok", "128K window, Llama-3.1 lineage — real but not in the million-token class."),
  vision: sk("weak", "Text only. Do not route screenshots here."),
  speed: sk(
    "weak",
    "37.6 tok/s measured on the 405B — slower than everything else on this table except Opus 5.",
  ),
  cost: sk(
    "strong",
    "$1/$3 per M on the 405B, $0.13/$0.40 on the 70B. The 70B is the cheapest thing here by a wide margin.",
  ),
  world: sk("weak", "Llama-3.1 training cut-off, which is the oldest on this table."),
};

const DOLPHIN_SKILLS: Record<SkillKey, SkillCell> = {
  code: sk("ok", "Mistral-Small-24B underneath — serviceable, not a coding model."),
  agentic: sk(
    "weak",
    "24B and not tuned for long tool loops. Use it as a leaf, never as an orchestrator.",
  ),
  reason: sk("ok", "Adequate for its size; no reasoning mode to switch on."),
  write: sk(
    "strong",
    "Built for it — the Venice collaboration targets creative and roleplay work where the refusals bite hardest.",
  ),
  psych: sk(
    "ok",
    "Built for character and roleplay, which is adjacent but not the same: it inhabits a person well and analyses one shallowly, at 24B.",
  ),
  context: sk("ok", "128K window — plenty for a conversation, not for a codebase."),
  vision: sk("weak", "Text only. Route anything with an image elsewhere."),
  speed: sk("ok", "Quick for a 24B, no published throughput figure on the leaderboard used here."),
  cost: sk("strong", "$0.20/$0.90 per M — cheap enough to experiment with freely."),
  world: sk("weak", "Mistral-Small training cut-off."),
};

const ABLITERATED_SKILLS: Record<SkillKey, SkillCell> = {
  code: sk(
    "ok",
    "Inherits the base model's coding, minus whatever the ablation disturbed. Below ~70B the damage to structured reasoning is visible; above it, the model has enough redundancy to route around the missing direction.",
  ),
  agentic: sk(
    "weak",
    "The one grade to take seriously before automating anything. arXiv:2607.17427 measured abliterated variants over 21,600 decisions: systematically more optimistic (+12.2pp for Gemma, +7.4pp for Qwen), more self-justifying, and — worst for an agent — stated and enacted uncertainty come apart. It declares more doubt while acting just as decisively.",
  ),
  reason: sk(
    "ok",
    "Roughly the base model's reasoning. Method matters more than model: Heretic's automated ablation shifts the output distribution 6.5× less than the earliest manual recipes at the same refusal reduction.",
  ),
  write: sk(
    "strong",
    "The most common reason people reach for these — dark themes and adult fiction without the hedge.",
  ),
  psych: sk(
    "weak",
    "The column where the disposition drift bites hardest. arXiv:2607.17427 measured abliterated variants as systematically more optimistic (+12.2pp for Gemma, +7.4pp for Qwen), more self-justifying, and with stated and enacted uncertainty coming apart — an advisor that is confidently cheerful about your situation is worse than no advisor.",
  ),
  context: sk(
    "ok",
    "Whatever the base offers; these top out around 35B, so expect base-model windows.",
  ),
  vision: sk(
    "weak",
    "Mostly text-only, though abliterated VL variants exist (Huihui-Qwen3-VL-4B).",
  ),
  speed: sk("ok", "Base-model speed; the ablation itself costs nothing at inference time."),
  cost: sk(
    "strong",
    "Small models, cheap to serve — but reaching them pay-per-use is the hard part, not the price.",
  ),
  world: sk("weak", "Base-model training cut-off."),
};

const HERMES_TOPICS: Record<TopicKey, TopicCell> = {
  ...OSS_LOW_REFUSAL_SHARED,
  explosives: {
    v: "soft",
    tip: "Declines the plain construction ask, but far more of the surrounding chemistry and engineering is discussed than a frontier model would allow.",
  },
  drugs: {
    v: "soft",
    tip: "Pharmacology, dosage and interaction questions are answered frankly where a frontier model hedges or declines. Synthesis is still refused.",
  },
  malware: {
    v: "soft",
    tip: "No hard anti-offensive training, and no separate moderation layer on the endpoint. Nous deliberately did not train a refusal reflex here; what remains is the base model's own reluctance.",
  },
  cnpolitics: {
    v: "open",
    tip: "Llama-3.1 underneath — no Chinese alignment to remove. Answers Tiananmen, Xinjiang and Taiwan directly, as any US-trained base does.",
  },
  adult: {
    v: "open",
    tip: "Answers. Neutral alignment covers adult content between adults as ordinary text.",
  },
};

const DOLPHIN_TOPICS: Record<TopicKey, TopicCell> = {
  ...OSS_LOW_REFUSAL_SHARED,
  explosives: {
    v: "soft",
    tip: "Declines the direct construction ask; the guardrail is thin and inherited from Mistral rather than reinforced.",
  },
  drugs: {
    v: "soft",
    tip: "Frank on pharmacology and harm reduction; synthesis routes still refused.",
  },
  malware: {
    v: "soft",
    tip: "Explicitly uncensored tune with no offensive-cyber training either way — the refusal that remains is whatever Mistral-Small shipped with.",
  },
  cnpolitics: { v: "open", tip: "Mistral base, no Chinese alignment present to begin with." },
  adult: {
    v: "open",
    tip: "The headline use case for this checkpoint — built with Venice.ai specifically for unfiltered creative and roleplay work.",
  },
};

const ABLITERATED_TOPICS: Record<TopicKey, TopicCell> = {
  ...OSS_LOW_REFUSAL_SHARED,
  explosives: {
    v: "soft",
    tip: "The safety refusal is what abliteration targets, so this loosens — but the base model's actual knowledge is unchanged, which is the ceiling on how much loosening is worth.",
  },
  drugs: { v: "soft", tip: "Same as explosives: the decline goes, the knowledge does not arrive." },
  malware: {
    v: "soft",
    tip: "Refusal removed; capability still bounded by the base. Note the base models here are 27–35B, well below the tier that writes anything sophisticated.",
  },
  cnpolitics: {
    v: "soft",
    tip: "THE surprise, and the reason this row exists: abliteration does NOT remove Chinese political alignment. The technique derives its direction from English safety prompt pairs, and the political refusal is a different circuit — community-abliterated DeepSeek R1 still declines Tiananmen. Targeted ablation of the specific heads does work (R1dacted, arXiv:2505.12625), but that is purpose-built research, not the checkpoint you download.",
  },
  adult: {
    v: "open",
    tip: "Fully open on the abliterated checkpoints — this and creative writing are what most of the 756 uncensored variants on Featherless exist for.",
  },
};

// ORDER MATTERS — first match wins; family rows before generic ones.
export const SC_DOSSIER_RULES: { match: RegExp; entry: DossierEntry }[] = [
  // ── Low-refusal community tunes. These MUST precede the vendor rules below:
  // "Huihui-Qwen3.5-27B-abliterated" contains "qwen", so the /qwen/ rule would
  // otherwise claim it and paint Alibaba's censorship profile on a model whose
  // whole point is not having one. Same distill hazard as vendor-marks.ts.
  {
    match: /ablit|uncensored|heretic|huihui/i,
    entry: {
      bloc: "OSS",
      best: "Community abliterated checkpoint — the refusal direction projected out of an open base (Qwen, Llama, Gemma)",
      skills: ABLITERATED_SKILLS,
      topics: ABLITERATED_TOPICS,
    },
  },
  {
    match: /hermes/i,
    entry: {
      bloc: "OSS",
      best: "Neutrally aligned by design — the most permissive model on a mainstream pay-per-use endpoint",
      skills: HERMES_SKILLS,
      topics: HERMES_TOPICS,
    },
  },
  {
    match: /dolphin|venice/i,
    entry: {
      bloc: "OSS",
      best: "Explicitly uncensored Mistral-Small-24B tune, built with Venice.ai for unfiltered creative work",
      skills: DOLPHIN_SKILLS,
      topics: DOLPHIN_TOPICS,
    },
  },
  // ── Anthropic (US) ──
  {
    match: /fable/i,
    entry: {
      bloc: "US",
      best: "Autonomous software engineering — SWE-bench Verified 95%",
      skills: FABLE_SKILLS,
      topics: ANTHROPIC_TOPICS,
    },
  },
  {
    match: /opus/i,
    entry: {
      bloc: "US",
      best: "Long-horizon agentic work · engineering judgment (Opus 5 tops OckBench)",
      skills: OPUS_SKILLS,
      topics: ANTHROPIC_TOPICS,
    },
  },
  {
    match: /sonnet/i,
    entry: {
      bloc: "US",
      best: "Balanced coding · precise instruction following · hardest to jailbreak (CASI 93.08)",
      skills: SONNET_SKILLS,
      topics: ANTHROPIC_TOPICS,
    },
  },
  {
    match: /haiku/i,
    entry: {
      bloc: "US",
      best: "Fast cheap drafts · classification · routing",
      skills: HAIKU_SKILLS,
      topics: ANTHROPIC_TOPICS,
    },
  },
  // ── OpenAI family (US): sol/terra/luna tiers, 5.5, 5.4, codex variants, o3 ──
  {
    match: /5\.6-sol/i,
    entry: {
      bloc: "US",
      best: "Deepest reasoning tier — math · science · proof-style tasks",
      skills: SOL_SKILLS,
      topics: OPENAI_TOPICS,
    },
  },
  {
    match: /5\.6-terra/i,
    entry: {
      bloc: "US",
      best: "Reasoning × speed balance",
      skills: TERRA_SKILLS,
      topics: OPENAI_TOPICS,
    },
  },
  {
    match: /5\.6-luna/i,
    entry: {
      bloc: "US",
      best: "High-volume everyday tasks · cheapest tier",
      skills: LUNA_SKILLS,
      topics: OPENAI_TOPICS,
    },
  },
  {
    match: /codex/i,
    entry: {
      bloc: "US",
      best: "Coding-specialized variant",
      skills: CODEX_SKILLS,
      topics: OPENAI_TOPICS,
    },
  },
  {
    match: /\bo3\b|gpt-5|gpt-4/i,
    entry: {
      bloc: "US",
      best: "General-purpose (legacy generations: broad, no single crown)",
      skills: LEGACY_OAI_SKILLS,
      topics: OPENAI_TOPICS,
    },
  },
  // ── xAI (US) ──
  {
    match: /grok|xai/i,
    entry: {
      bloc: "US",
      best: "Real-time world knowledge · long-context reasoning · loosest US guardrails",
      skills: GROK_SKILLS,
      topics: XAI_TOPICS,
    },
  },
  // ── Google (US) ──
  {
    match: /gemini.*flash/i,
    entry: {
      bloc: "US",
      best: "Fast multimodal · long-context retrieval",
      skills: GEMINI_FLASH_SKILLS,
      topics: GOOGLE_TOPICS,
    },
  },
  {
    match: /gemini/i,
    entry: {
      bloc: "US",
      best: "Multimodal reasoning · long context",
      skills: GEMINI_PRO_SKILLS,
      topics: GOOGLE_TOPICS,
    },
  },
  // ── Chinese camp — note the differentiator is NOT a bloc property ──
  {
    match: /kimi|moonshot/i,
    entry: {
      bloc: "CN",
      best: "Cost-efficient agentic tool use · top open-weight on OckBench · least politically filtered Chinese model",
      skills: KIMI_SKILLS,
      topics: KIMI_TOPICS,
    },
  },
  {
    match: /deepseek/i,
    entry: {
      bloc: "CN",
      best: "Ultra-cheap fast reasoning (flash) · strong open-weight reasoning line",
      skills: DEEPSEEK_SKILLS,
      topics: DEEPSEEK_TOPICS,
    },
  },
  {
    match: /glm|zhipu|z-ai/i,
    entry: {
      bloc: "CN",
      best: "Chinese–English bilingual · tool calling — the model Hugging Face ran in-house to investigate the July 2026 breach",
      skills: GLM_SKILLS,
      topics: GLM_TOPICS,
    },
  },
  {
    match: /qwen|alibaba/i,
    entry: {
      bloc: "CN",
      best: "Agentic computer-use + coding (vendor claim, 2026 launch) · multilingual · strictest Chinese family on criminal content",
      skills: QWEN_SKILLS,
      topics: QWEN_TOPICS,
    },
  },
];

/** Refusals BOTH camps genuinely share — the common ground, minus the myth. */
export const SC_SHARED_REFUSALS: string[] = [
  "Sexual content involving minors — absolute in every lab tested, US and Chinese alike",
  "Biological, chemical, radiological and nuclear weapons uplift",
  "Bomb-making and device construction",
  "Fraud, scam and phishing kits",
  "Drug synthesis routes and trafficking logistics",
];

/** Where the camps actually diverge — the part the old table averaged away. */
export const SC_SPLITS: { title: string; body: string }[] = [
  {
    title: "Security research — the big one",
    body: "US models refuse to READ an exploit, not just to write one. During the July 2026 Hugging Face breach, Claude and GPT declined to process the attacker's payloads and logs; Hugging Face ran GLM 5.2 in-house over 17,000+ telemetry events instead. Chinese models draw the line at BUILDING malware, not at analysing it. Anthropic's Cyber Verification Program and OpenAI's Trusted Access for Cyber exist to walk this back for vetted defenders.",
  },
  {
    title: "Beijing politics is not a bloc property",
    body: "On 168 cases covering topics the Chinese state suppresses, Kimi K2.5 scored 98.8% — identical to Claude Opus 4.5 — while DeepSeek V3.2 scored 19%. Same country, opposite behaviour. GLM sits in between and moves with the endpoint: 95.2% on local weights, 79.8% through a hosted API.",
  },
  {
    title: "The mirror",
    body: "US models are trained off INFLUENCING politics (campaigning, election persuasion); Chinese models off CRITICIZING power (CCP legitimacy, sovereignty). Both camps politicize refusals — in opposite directions, and each camp's blind spot is the other's specialty.",
  },
  {
    title: "The OSS rows lift a lot — and nothing at the top",
    body: "Hermes 4 405B, the most permissive model on a mainstream pay-per-use endpoint, answers 57.1% of RefusalBench's 166 refusal-prone prompts against roughly 17% for GPT-4o and Claude Sonnet. It still declines ~43%. What lifts: over-refusal, dual-use security work, frank medical and legal talk, adult and dark fiction, taking a side. What does not: CSAM (enforced at the provider and legal layer, not the weights), real CBRN capability (the knowledge was never in the base, so past the refusal you get confident regurgitation), and — on abliterated Chinese bases — the political filtering, which is a different circuit from the English safety direction the technique removes. Provider terms still govern the account regardless of what the weights will say.",
  },
  {
    title: "Refusing on paper ≠ holding under pressure",
    body: "The CASI jailbreak-resilience index (Jul 2026) splits models more sharply than policy does: Claude Sonnet 5 93.08, Qwen3.5-397B 81.13, MiMo-V2.5 73.80, GLM-5.2 46.58. A ■ in this table means trained refusal, not a guarantee it survives contact with a determined prompt.",
  },
];

export function scDossierFor(modelId: string): DossierEntry | undefined {
  for (const row of SC_DOSSIER_RULES) {
    if (row.match.test(modelId)) return row.entry;
  }
  return undefined;
}

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface DossierRow {
  id: string;
  name: string;
  color: string;
  /** AA intelligence index. Undefined when nobody publishes one — shown as "—". */
  index?: number;
  /** Shown for comparison only; not in the user's configured model set. */
  reference?: boolean;
  /** Reference rows: how to actually reach it, cheaply, with no subscription. */
  howto?: string;
  /** What the index number is, or why there is not one. */
  indexNote?: string;
  /**
   * Vendor mark as raw SVG/img HTML. Supplied by the caller rather than looked up
   * here, because only the caller knows the precedence: model id first, then
   * provider, since every OpenRouter model reports provider "openrouter".
   *
   * CORRECTED 2026-08-30 — the old reason given here is now FALSE and was already
   * weak. It claimed the point was keeping provider-logos.ts's
   * `import.meta.env.BASE_URL` out of this module "so it renders in a plain test
   * harness". This module now imports SC_THALAMUS from ./smart-cost-chart.js, which
   * value-imports ./provider-logos.js, so that dependency is in. It was survivable
   * all along: smart-cost-chart.test.ts has been importing the same graph green,
   * because vitest is Vite-based and always supplies `import.meta.env`, and this
   * module's only consumers are that test file and app.ts, both Vite-based. A
   * NON-Vite harness would still break, at provider-logos.ts:6 — there is none in
   * tree today, and that is the line it would fail on.
   *
   * Falls back to the colour dot when absent.
   */
  logo?: string;
}

/**
 * Mouseover detail for every [data-tip] cell. One shared fixed-position node
 * appended to `root`: a ::after tooltip drawn inside the cell would be clipped
 * by the scrolling .sd-body. Exported so the visual harness drives the real
 * code path rather than a copy of it.
 */
export function attachDossierTooltips(root: HTMLElement): void {
  const tip = root.ownerDocument.createElement("div");
  tip.className = "sd-tip";
  tip.style.display = "none";
  root.appendChild(tip);
  const win = root.ownerDocument.defaultView!;
  root.addEventListener("mouseover", (e) => {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-tip]");
    if (!el) return;
    tip.textContent = el.dataset.tip || "";
    tip.style.display = "block";
    const r = el.getBoundingClientRect();
    const w = tip.getBoundingClientRect();
    const left = r.left + r.width / 2 - w.width / 2;
    tip.style.left = `${Math.max(8, Math.min(win.innerWidth - w.width - 8, left))}px`;
    tip.style.top = `${r.bottom + 8 + w.height > win.innerHeight ? r.top - w.height - 8 : r.bottom + 8}px`;
  });
  root.addEventListener("mouseout", (e) => {
    if ((e.target as HTMLElement | null)?.closest("[data-tip]")) tip.style.display = "none";
  });
}

/**
 * Click a subject header to rank every model by it. The ranks ride on each row
 * as data-ranks and the Epoch AI percentile on the cell as data-p, so sorting is
 * a DOM reorder — no re-render, no refetch, and the tooltip listeners stay bound.
 *
 * FORK 2026-09-02: a measured column ranks by MEASUREMENT first, then grade, then
 * AA index. Unmeasured rows sort below measured ones on such a column: a judged
 * grade is an opinion, a percentile is a run.
 */
export function attachDossierSort(root: HTMLElement): void {
  root.addEventListener("click", (e) => {
    const th = (e.target as HTMLElement | null)?.closest<HTMLElement>("th[data-sort]");
    if (!th) return;
    const key = th.dataset.sort!;
    const table = th.closest("table");
    const tbody = table?.querySelector("tbody");
    if (!tbody) return;
    const rows = [...tbody.querySelectorAll<HTMLElement>("tr")];
    // -1 for a row with no data-p on this column: Number(undefined) is NaN, never 0,
    // so an unmeasured row cannot masquerade as a measured p0.
    const cellP = (tr: HTMLElement): number => {
      const v = Number(tr.querySelector<HTMLElement>(`td[data-col="${key}"]`)?.dataset.p);
      return Number.isFinite(v) ? v : -1;
    };
    rows.sort((a, b) => {
      const ia = Number(a.dataset.index || 0);
      const ib = Number(b.dataset.index || 0);
      if (key === "index") return ib - ia;
      const ra = (JSON.parse(a.dataset.ranks || "{}") as Record<string, number>)[key] ?? 0;
      const rb = (JSON.parse(b.dataset.ranks || "{}") as Record<string, number>)[key] ?? 0;
      return cellP(b) - cellP(a) || rb - ra || ib - ia;
    });
    for (const r of rows) tbody.appendChild(r);
    for (const el of table!.querySelectorAll(".sd-sorted")) el.classList.remove("sd-sorted");
    if (key !== "index") {
      th.classList.add("sd-sorted");
      for (const td of tbody.querySelectorAll(`td[data-col="${key}"]`))
        td.classList.add("sd-sorted");
    }
  });
}

/**
 * Low-refusal models shown for comparison but NOT in the configured set — no
 * account, no config change, no spend until you call one. Each howto is the
 * cheapest path to a real answer, verified against the provider's live catalog
 * on 2026-08-07.
 */
export const SC_REFERENCE_ROWS: DossierRow[] = [
  {
    id: "nousresearch/hermes-4-405b",
    name: "Hermes 4 405B",
    color: "#b48ead",
    index: 9,
    reference: true,
    indexNote:
      "9 on the Artificial Analysis Intelligence Index v4.1.1 — rank #32 of 44, measured with reasoning OFF. AA does not benchmark its reasoning mode at all. With reasoning ON the same weights post GPQA Diamond 70.5, AIME 2024 81.9 and MATH-500 96.3. Judge it by whichever mode you will actually run.",
    howto:
      'Already reachable on the OpenRouter key you have — no new account, no subscription, nothing to install. POST https://openrouter.ai/api/v1/chat/completions with model "nousresearch/hermes-4-405b". Billed per request at $1 in / $3 out per million tokens, so a few hundred tokens of testing costs a fraction of a cent. The endpoint reports is_moderated: false — no extra filter in front of the model. Switch the reasoning toggle on or you are using the #32-ranked mode.',
  },
  {
    id: "nousresearch/hermes-4-70b",
    name: "Hermes 4 70B",
    color: "#b48ead",
    reference: true,
    indexNote:
      "No published AA index. Same family, same training and the same hybrid reasoning toggle as the 405B, at a fifth the size.",
    howto:
      'The cheapest way to find out whether a low-refusal model helps you at all. Same https://openrouter.ai/api/v1/chat/completions endpoint and the same key, model "nousresearch/hermes-4-70b", $0.13 in / $0.40 out per million tokens — roughly 125× cheaper on output than Fable 5. Spend a cent here before spending a euro on the 405B.',
  },
  {
    id: "cognitivecomputations/dolphin-mistral-24b-venice-edition",
    name: "Dolphin Mistral 24B Venice",
    color: "#6fb3d2",
    reference: true,
    indexNote:
      "No published AA index. A 24B Mistral-Small tune — expect small-model quality, chosen for disposition rather than intelligence.",
    howto:
      'Same https://openrouter.ai/api/v1/chat/completions endpoint and key, model "cognitivecomputations/dolphin-mistral-24b-venice-edition", $0.20 in / $0.90 out per million tokens. The one to try when the blocker is tone and subject matter rather than difficulty.',
  },
  {
    id: "huihui-ai/Huihui-Qwen3.5-27B-abliterated",
    name: "Huihui Qwen3.5 27B abliterated",
    color: "#d08770",
    reference: true,
    indexNote:
      "No published AA index. The most downloaded abliterated checkpoint on the Hub (156K) — a genuinely ablated model rather than a neutrally-aligned tune, so the disposition caveat in AGENTIC applies here and not to Hermes.",
    howto:
      "Not on OpenRouter — no abliterated checkpoint is. Pay-per-request route: POST https://router.huggingface.co/v1/chat/completions with a Hugging Face token, provider rates with no HF markup and no subscription (PRO adds $2/month of credits). VERIFY FIRST: the router's default model list returns 129 entries and none are abliterated, so whether this id is callable with an explicit model:provider string is unconfirmed. The certain-but-paid route is Featherless, which serves 756 uncensored checkpoints from $50/month.",
  },
];

/**
 * Rank the models for one subject, best first — the routing query in code form.
 * Ties break on the AA intelligence index, so equal grades stay ordered sensibly.
 */
export function scRankBySkill(rows: DossierRow[], key: SkillKey): DossierRow[] {
  return [...rows].sort((a, b) => {
    const ra = SC_SKILL_RANK[scDossierFor(a.id)?.skills[key].v ?? "weak"];
    const rb = SC_SKILL_RANK[scDossierFor(b.id)?.skills[key].v ?? "weak"];
    return rb - ra || (b.index ?? -1) - (a.index ?? -1);
  });
}

// ── THALAMUS ENVELOPE (FORK 2026-08-30, the architect: "use the same color and envelope
// the model uses that thalamus is programmed to use in the dossier chart") ──
//
// ONE SOURCE, TWO PANELS. Membership is never a list written here: it is read off
// the result of `thalamusCandidates` (src/shared/thalamus-candidates.ts), the same
// predicate the SMART × COST chart draws its envelope from, and the colour is that
// chart's own SC_THALAMUS. A hardcoded id list with a comment claiming it matches
// the router is the precise failure that shared module was written to prevent — the
// comment keeps reading true forever while the ladder moves underneath it.
//
// THE RESULT ARRIVES AS AN ARGUMENT AND THE PREDICATE IS NOT CALLED HERE, which is
// the stronger form of the same guarantee rather than a weaker one. This panel holds
// none of the predicate's inputs (catalog, usage snapshot, clock, relCostFor); its
// caller holds all of them and already draws the chart, so handing BOTH panels the
// SAME result object makes them agree by IDENTITY, where two separate calls could
// still differ by an argument. It also keeps the gateway-side ranking module out of
// a bundle that only needs to paint a badge. Same stance the shared module itself
// takes with `relCostFor` and `tokensPerTask`: the data comes in, the module does
// not go looking for it.
//
// INERT UNTIL WIRED — SAID OUT LOUD RATHER THAN LEFT TO ROT. The only caller today
// is `openDossier()` in `tinker-ui/src/app.ts`, which (since 2026-09-02) passes
// `rows` and a THIRD argument `{ biasIdx }` for the routes strip, but still NO
// second argument. Until it passes one, every badge, tooltip and footer line below
// renders NOTHING. That is a one-line follow-up with a named call site, not an
// accident — and the routes strip does not depend on it: it computes its own rungs
// from the rows, via thalamus-frontier.ts, not from this candidate set.

/**
 * Exactly what `thalamusCandidates` returns. Aliased to its result type rather than
 * re-declared locally, so the producer is named and there is only one of them.
 */
export type DossierThalamus = ThalamusCandidatesResult;

/**
 * `SC_THALAMUS` resolved to something safe to put in a `style=` attribute.
 *
 * WHY A NORMALIZER AT ALL. This module and `smart-cost-chart.ts` land in the same
 * burst from different units, and the only thing agreed between them is the NAME.
 * If the export turns out to be an object, interpolating it straight into a style
 * attribute paints "[object Object]": markup that looks fine, renders no colour and
 * reports nothing. So the value is widened to `unknown` at the boundary and a
 * mismatch is SAID OUT LOUD in the badge tooltip instead of being replaced by a
 * confident wrong hue.
 *
 * WHAT AN ABSENT EXPORT ACTUALLY DOES — MEASURED 2026-08-30, not assumed. The draft
 * of this comment claimed a missing `SC_THALAMUS` "fails at import and takes this
 * panel's whole test file down with it", and called that the correct loud failure.
 * IT IS NOT WHAT HAPPENS. Probed against this tree before the sibling unit landed:
 * vitest's Vite transform rewrites a named import to a property read, so
 * `SC_THALAMUS` is simply `undefined`, the dossier spec stayed 33/33 GREEN, and
 * nothing anywhere reported a missing colour.
 *
 * A TYPECHECKER DOES CATCH IT — and nothing in the gate runs one. A throwaway
 * tsconfig over `tinker-ui/src` reports `TS2305: Module "./smart-cost-chart.js" has
 * no exported member 'SC_THALAMUS'` on the import line, one error above a 728-error
 * control. But no committed tsconfig includes `tinker-ui`, and the build is `vite
 * build`, so that check runs only when somebody writes the config by hand. Rollup
 * would refuse the bundle; vitest and the dev server will not.
 *
 * (Note for the next editor: the root tsconfig's include glob for the OTHER ui
 * directory cannot be quoted inside a block comment — it contains the sequence that
 * ends one. That is how this very paragraph broke the file once.)
 *
 * That asymmetry is the whole reason the undefined case has to announce itself in
 * the UI rather than trust a build error: the badge tooltip and the footer both say
 * COLOUR UNRESOLVED and name the export to fix. A soft fallback to some other hue
 * would instead let the dossier ship painted in a colour the chart does not use,
 * which is the single outcome the architect asked against.
 *
 * The character class doubles as the attribute guard: no `"`, `;`, `:` or `*` can
 * survive it, so a value cannot terminate the attribute, append a second declaration
 * or open a CSS comment.
 */
export function scThalamusColor(value: unknown): string | undefined {
  const raw =
    typeof value === "string"
      ? value
      : value !== null && typeof value === "object"
        ? (["color", "ring", "stroke", "hex"] as const)
            .map((k) => (value as Record<string, unknown>)[k])
            .find((v): v is string => typeof v === "string")
        : undefined;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length <= 64 && /^[#a-z0-9 ,.%()/-]+$/i.test(trimmed)
    ? trimmed
    : undefined;
}

/** The chart's envelope colour, or undefined when SC_THALAMUS is not a CSS colour. */
export const SD_THALAMUS_COLOR: string | undefined = scThalamusColor(SC_THALAMUS as unknown);

/**
 * The row badge for a model inside the envelope; "" for every other row, and "" for
 * every row when no candidate set was supplied.
 *
 * Reuses `.sd-refbadge` — the dashed pill that already means "shown, not wired" —
 * with the border SOLID for the pick and DASHED for the rest, and the colour inlined
 * because `tinker-ui/src/styles/base.css` is not this unit's to write.
 */
function thalamusBadge(id: string, t: DossierThalamus | undefined): string {
  if (t === undefined) return "";
  const hit = t.considered.find((c) => c.key === id);
  if (hit === undefined) return "";
  const isPick = t.pick === id;
  const colour = SD_THALAMUS_COLOR;
  const tip =
    (isPick
      ? `THALAMUS · PICK — rank 1 of ${t.considered.length} candidates on the ${t.basis} basis. This is the model Auto reaches for first.`
      : `THALAMUS — inside the candidate envelope at rank ${hit.rank} of ${t.considered.length} on the ${t.basis} basis.`) +
    `\n\nMembership comes from thalamusCandidates(), the same predicate the SMART x COST chart draws its envelope from, so the two panels cannot disagree about what Auto will reach.` +
    (t.costVerified
      ? ""
      : `\n\nCOST NOT FULLY VERIFIED — a survivor carries no published cost on this basis, so the ceiling veto never ran on it and this envelope is WIDER than the router's own answer.`) +
    (colour === undefined
      ? `\n\nCOLOUR UNRESOLVED — SC_THALAMUS did not resolve to a CSS colour, so this badge is NOT painted in the chart's envelope hue. Fix the export in smart-cost-chart.ts; never hardcode a colour here, or the two panels drift.`
      : "");
  const style =
    colour === undefined
      ? ` style="border-style:${isPick ? "solid" : "dashed"}"`
      : ` style="color:${colour};border-color:color-mix(in srgb, ${colour} 60%, transparent);border-style:${isPick ? "solid" : "dashed"}"`;
  return (
    `<span class="sd-refbadge"${style} data-tip="${esc(tip)}">` +
    `${isPick ? "thalamus · pick" : "thalamus"}</span>`
  );
}

// ── BEST PER COLUMN · MEASURED LINE · THALAMUS ROUTES (FORK 2026-09-02, the architect:
// "also mark in the dossier table the best at each category, and make sure Thalamus
// routes intelligently depending on the task at hand") ──
//
// MEASURED BEATS JUDGED. Every column whose key is also a Thalamus TaskDomain now has
// a second source beside the hand-written grade: DOMAIN_STRENGTH — the Epoch AI
// percentile of the family's best public run in that domain, models of the last 12
// months (src/shared/domain-strength.generated.ts) — read through `domainStrengthFor`
// so the model-id → family join lives in ONE place and is never re-derived here.
//   • the BEST cell of such a column is the CONFIGURED row with the highest measured
//     p (tie → higher AA index). Only when NO configured row has a run in that domain
//     — WRITE and PSYCH at the time of writing; no recent public table — does the
//     column fall back to the judged grade (SC_SKILL_RANK, then AA index), and the
//     header tooltip says which of the two it used. SPEED and COST are not domains
//     and keep today's rank. Reference rows never win: they are "shown, not wired".
//   • every measured cell carries the percentile in its tooltip and as `data-p`, so a
//     click on the header ranks by MEASUREMENT first, then grade, then AA index —
//     still a DOM reorder, the ranks still ride on the row.
//   • the ROUTES strip above the table is what Thalamus actually does with those
//     numbers: `frontierRungsFor` → `thalamusRoutesByDomain` (thalamus-frontier.ts),
//     the SAME functions the reply-path Auto router calls, fed each configured row's
//     AA index and €/TASK price (`scThalamusRelCost`, the chart's own lookup — a
//     missing price stays missing, never invented). One row per domain; a SWITCH row
//     is a domain where a materially stronger measured model displaced the bias pick.
//
// CODE, NOT PROMPT — evaluated: the want is "the same mark every render" and there
// is a structural producer (the generated table) to hang it on.

/** SkillKeys that are also a Thalamus TaskDomain — the columns a measurement can exist for. */
const SD_DOMAIN_KEYS: ReadonlySet<string> = new Set<TaskDomain>([
  "code",
  "agentic",
  "reason",
  "write",
  "psych",
  "context",
  "vision",
  "world",
]);

/** The TaskDomain a column measures, or undefined for SPEED and COST. */
export function sdDomainOf(key: SkillKey): TaskDomain | undefined {
  return SD_DOMAIN_KEYS.has(key) ? (key as TaskDomain) : undefined;
}

const sdPct = (p: number): string => `${Math.round(p * 100)}`;

/** The Epoch AI line appended to a cell tooltip; "" when the family has no run in that domain. */
export function scMeasuredLine(s: DomainStrength | undefined): string {
  if (s === undefined) return "";
  return (
    `\n\nMEASURED — Epoch AI percentile p${sdPct(s.p)} over ${s.n} benchmark${s.n === 1 ? "" : "s"}: ` +
    s.basis.join(", ")
  );
}

export type DossierBest = {
  row: DossierRow;
  /** "measured" = highest Epoch percentile among configured rows; "judged" = grade rank, then AA index. */
  basis: "measured" | "judged";
  strength?: DomainStrength;
};

/**
 * The single best CONFIGURED row for one column. Measured when any configured row has
 * an Epoch run in the column's domain; judged (scRankBySkill) otherwise. Undefined only
 * when there are no configured rows at all.
 */
export function scBestBySkill(rows: DossierRow[], key: SkillKey): DossierBest | undefined {
  const configured = rows.filter((r) => !r.reference);
  if (configured.length === 0) return undefined;
  const domain = sdDomainOf(key);
  if (domain !== undefined) {
    let best: DossierRow | undefined;
    let bestS: DomainStrength | undefined;
    for (const row of configured) {
      const s = domainStrengthFor(row.id, domain);
      if (s === undefined) continue;
      if (
        bestS === undefined ||
        s.p > bestS.p ||
        (s.p === bestS.p && (row.index ?? -1) > (best?.index ?? -1))
      ) {
        best = row;
        bestS = s;
      }
    }
    if (best !== undefined && bestS !== undefined) {
      return { row: best, basis: "measured", strength: bestS };
    }
  }
  return { row: scRankBySkill(configured, key)[0], basis: "judged" };
}

/** The mark on the best cell — the file's existing `<sup>` grammar (SD_JUDGED_MARK), no new colour. */
export const SD_BEST_MARK = `<sup class="sd-best-mark">1</sup>`;

function sdBestHeaderLine(s: SkillDef, best: DossierBest | undefined): string {
  if (best === undefined) return "";
  if (best.basis === "measured" && best.strength !== undefined) {
    return (
      `\n\nBEST — ${best.row.name} (measured p${sdPct(best.strength.p)} over ${best.strength.n} ` +
      `Epoch AI benchmark${best.strength.n === 1 ? "" : "s"}: ${best.strength.basis.join(", ")})`
    );
  }
  const why =
    sdDomainOf(s.key) === undefined
      ? "not a routing domain, so the grade decides, AA index breaking ties"
      : "no configured model has an Epoch AI run in this domain today — no recent public table — so the judged grade decides, AA index breaking ties";
  return `\n\nBEST — ${best.row.name} (judged: ${why})`;
}

function sdBestCellLine(best: DossierBest): string {
  return best.basis === "measured"
    ? "BEST IN COLUMN — the highest measured Epoch AI percentile among the configured models.\n\n"
    : "BEST IN COLUMN — the top judged grade among the configured models, AA index breaking ties; no measurement exists for this column.\n\n";
}

const sdFmtTaskCost = (c: number): string => `€${c >= 1 ? c.toFixed(2) : c.toPrecision(2)}/task`;

function sdDomainLabel(d: TaskDomain): string {
  return SC_SKILLS.find((s) => s.key === d)?.label ?? d.toUpperCase();
}

/** True when the domain step moved the route off the plain bias pick. */
export function sdRouteSwitched(route: ThalamusRoute): boolean {
  return route.rung.key !== route.biasRung.key || route.rung.effort !== route.biasRung.effort;
}

/**
 * The THALAMUS ROUTES strip: what Auto reaches for per task domain at this BIAS, computed
 * with the router's own functions on the configured rows. A row with no AA index or no
 * published price on the €/task basis contributes no rung — the same silence
 * `scThalamusRelCost` keeps for the chart, never an invented price.
 */
export function renderThalamusRoutes(rows: DossierRow[], biasIdx: number | undefined): string {
  const bias = clampBiasIdx(biasIdx);
  const label = BIAS_STOPS[bias]?.label ?? `${bias}`;
  const rungs: FrontierRung[] = [];
  for (const r of rows) {
    if (r.reference || r.index === undefined) continue;
    const relCost = scThalamusRelCost(r.id);
    if (relCost === undefined) continue;
    rungs.push(...frontierRungsFor(r.id, r.index, relCost));
  }
  const routes = thalamusRoutesByDomain(rungs, bias);
  const nameOf = (key: string): string => rows.find((r) => r.id === key)?.name ?? key;
  const titleTip =
    `THALAMUS ROUTES — one row per task domain: the model and thinking effort Auto reaches for at BIAS ${bias} (${label}).\n\n` +
    `The frontier is the Pareto set of every configured model × effort on the €/TASK axis; the bias pick is the cheapest frontier rung within the dial's AA gap; a domain row is marked SWITCH when a model in the band has a materially higher measured Epoch AI percentile for that domain. ` +
    `Computed by frontierRungsFor / thalamusRoutesByDomain (src/shared/thalamus-frontier.ts), the same functions the reply-path Auto router calls. Hover a row for the reason.`;
  const items = (Object.keys(routes) as TaskDomain[]).map((d) => {
    const route = routes[d]!;
    const switched = sdRouteSwitched(route);
    const eff = route.rung.effort ? ` @${esc(route.rung.effort)}` : "";
    const strength =
      route.strength !== undefined
        ? ` · measured p${sdPct(route.strength.p)}/${route.strength.n}`
        : d === "general"
          ? ""
          : " · unmeasured";
    return (
      `<span class="sd-route${switched ? " sd-route-switch" : ""}" data-tip="${esc(route.reason)}">` +
      `<b class="sd-route-dom">${esc(sdDomainLabel(d))}</b> → ${esc(nameOf(route.rung.key))}${eff}` +
      ` · idx ${route.rung.smart.toFixed(1)} · ${sdFmtTaskCost(route.rung.cost)}${strength}</span>`
    );
  });
  const body =
    items.length === 0
      ? `<span class="sd-route sd-route-empty">no configured model has both an AA index and a published price on the €/task basis — nothing to route</span>`
      : items.join("");
  // The chart's envelope hue rides in as the same inline custom property .sd-env uses;
  // when SC_THALAMUS does not resolve, the CSS fallback paints it and the envelope
  // footer already says COLOUR UNRESOLVED.
  const style = SD_THALAMUS_COLOR === undefined ? "" : ` style="--sd-env:${SD_THALAMUS_COLOR}"`;
  return (
    `<div class="sd-routes"${style}><span class="sd-routes-title" data-tip="${esc(titleTip)}">` +
    `THALAMUS ROUTES · bias ${bias} (${esc(label)})</span>${body}</div>`
  );
}

/**
 * The popup table: one row per smart model, sorted by intelligence index.
 *
 * `thalamus` is OPTIONAL, and omitting it produces what this function produced before
 * the envelope existed (plus, since 2026-09-02, the best-in-column marks and MEASURED
 * lines, which need no argument) — which is what keeps the exact tooltip-count
 * assertion in the test suite honest. `opts` is likewise optional: the THALAMUS ROUTES
 * strip renders only when `opts` is supplied, because a strip claiming a bias nobody
 * passed would be the confident-empty instrument this panel exists to avoid. The only
 * caller (`openDossier()` in app.ts) passes `{ biasIdx }`.
 */
export function renderDossierTable(
  rows: DossierRow[],
  thalamus?: DossierThalamus,
  opts?: { biasIdx?: number },
): string {
  const idx = (r: DossierRow) => r.index ?? -1;
  // One best per column, decided over the CONFIGURED rows only, before the reference
  // rows are appended — they are shown, not wired, and never win a column.
  const bestBySkill = new Map<SkillKey, DossierBest | undefined>();
  for (const s of SC_SKILLS) bestBySkill.set(s.key, scBestBySkill(rows, s.key));
  const routesStrip = opts === undefined ? "" : renderThalamusRoutes(rows, opts.biasIdx);
  // Reference rows always follow the configured set, then sort with everything
  // else once the user clicks a subject header.
  const sorted = [...rows].sort((a, b) => idx(b) - idx(a)).concat(SC_REFERENCE_ROWS);
  let body = "";
  for (const r of sorted) {
    const entry = scDossierFor(r.id);
    const bloc = entry?.bloc ?? "—";
    const blocClass =
      bloc === "US"
        ? "sd-bloc-us"
        : bloc === "CN"
          ? "sd-bloc-cn"
          : bloc === "OSS"
            ? "sd-bloc-oss"
            : "";
    const facts = scFactsFor(r.id);
    // Ranks travel on the row so the sort handler never re-derives them.
    const ranks: Record<string, number> = {};
    let skillCells = "";
    for (const s of SC_SKILLS) {
      const cell = entry?.skills[s.key];
      ranks[s.key] = SC_SKILL_RANK[cell?.v ?? "weak"];
      // MEASURED (FORK 2026-09-02): the Epoch AI percentile for this row's family in the
      // column's domain, when one exists. Rides on the cell as data-p so the sort
      // handler ranks by measurement first, and in the tooltip so the architect sees it.
      const domain = sdDomainOf(s.key);
      const strength = domain === undefined ? undefined : domainStrengthFor(r.id, domain);
      const pAttr = strength === undefined ? "" : ` data-p="${strength.p}"`;
      const best = bestBySkill.get(s.key);
      const isBest = best !== undefined && !r.reference && best.row.id === r.id;
      const bestClass = isBest ? " sd-best" : "";
      const bestMark = isBest ? SD_BEST_MARK : "";
      const bestLine = best !== undefined && isBest ? sdBestCellLine(best) : "";
      if (!cell) {
        // No dossier entry: "?" as before — but a measurement is still a measurement,
        // so a measured (or best) hole says so on hover rather than staying mute.
        const holeTip =
          strength === undefined && !isBest
            ? ""
            : ` data-tip="${esc(
                `${bestLine}${r.name} · ${s.label} — NO DOSSIER ENTRY, no judged grade.` +
                  `${scMeasuredLine(strength)}\n\n${scSkillBasisLine(s)}`,
              )}"`;
        skillCells +=
          `<td class="sd-cap" data-col="${s.key}"${pAttr}>` +
          `<span class="sd-tag sd-s-none${bestClass}"${holeTip}>?${bestMark}</span></td>`;
        continue;
      }
      // The column's PROVENANCE rides on every cell, not only on the header: the
      // architect hovers cells, and a JUDGED grade read as a measured one is the
      // exact failure the ANCHORED/JUDGED split exists to stop.
      const tip =
        `${bestLine}${r.name} · ${s.label} — ${SC_SKILL_LABEL[cell.v].toUpperCase()}\n\n${cell.tip}` +
        (cell.caveat === undefined ? "" : `\n\nGRADED, NOT WIRED — ${cell.caveat}`) +
        scFactLine(s.key, facts) +
        scMeasuredLine(strength) +
        `\n\n${scSkillBasisLine(s)}`;
      // Dashed underline = this file's existing "present but unconfirmed" grammar
      // (.sd-refbadge, .sd-cn-sub-unconfirmed), drawn in currentColor so it borrows
      // the grade's own hue instead of inventing a colour the palette has no room
      // for — and inline, because base.css is not this unit's to write.
      const caveatStyle =
        cell.caveat === undefined ? "" : ` style="border-bottom:1px dashed currentColor"`;
      skillCells +=
        `<td class="sd-cap" data-col="${s.key}"${pAttr}><span class="sd-tag sd-s-${cell.v}${bestClass}"${caveatStyle}` +
        ` data-tip="${esc(tip)}">${SC_SKILL_GLYPH[cell.v]}${bestMark}</span></td>`;
    }
    let cells = "";
    for (const t of SC_TOPICS) {
      const cell = entry?.topics[t.key];
      if (!cell) {
        cells += `<td class="sd-cens"><span class="sd-tag sd-v-none">?</span></td>`;
        continue;
      }
      const tip =
        `${r.name} · ${t.label} — ${SC_VERDICT_LABEL[cell.v].toUpperCase()}\n\n${cell.tip}` +
        scTopicFactLine(t.key, facts);
      cells +=
        `<td class="sd-cens"><span class="sd-tag sd-v-${cell.v}" data-tip="${esc(tip)}">` +
        `${SC_VERDICT_GLYPH[cell.v]}</span></td>`;
    }
    const nameTip =
      `${r.name} — ${entry?.best ?? "no dossier entry yet"}` +
      (r.indexNote ? `\n\nHOW SMART — ${r.indexNote}` : "") +
      (r.howto ? `\n\nHOW TO USE — ${r.howto}` : "") +
      scRefusalLine(facts);
    // The vendor mark when the caller supplied one; the colour dot is the
    // fallback for models with no logo in VENDOR_MARKS / PROVIDER_LOGO_SVG.
    const mark = r.logo
      ? `<span class="sd-logo">${r.logo}</span>`
      : `<span class="sd-dot" style="background:${r.color}"></span>`;
    const shown =
      r.index === undefined ? "—" : Number.isInteger(r.index) ? `${r.index}` : r.index.toFixed(1);
    // "" unless a candidate set was supplied AND this model is inside it, so the
    // one-argument call emits exactly what it always emitted.
    const thal = thalamusBadge(r.id, thalamus);
    body +=
      `<tr class="${r.reference ? "sd-ref" : ""}" data-index="${idx(r)}" ` +
      `data-ranks="${esc(JSON.stringify(ranks))}">` +
      `<td class="sd-model" data-tip="${esc(nameTip)}">` +
      `${mark}${esc(r.name)} ` +
      `<span class="sd-idx">${shown}</span>` +
      (r.reference ? `<span class="sd-refbadge">not wired</span>` : "") +
      thal +
      `</td>` +
      `<td><span class="sd-bloc ${blocClass}">${bloc}</span></td>` +
      skillCells +
      cells +
      `</tr>`;
  }

  // The JUDGED mark is appended AFTER the escaped label, deliberately: the test
  // suite asserts `html` contains `>LABEL<`, which survives only because the label
  // is plain ASCII and the mark follows it. A label containing & < > or " would be
  // transformed by esc() and that assertion would stop matching.
  const skillHeads = SC_SKILLS.map(
    (s) =>
      `<th class="sd-cap-h" data-sort="${s.key}" ` +
      `data-tip="${esc(
        `${s.label} — ${s.about}\n\n${scSkillBasisLine(s)}` +
          sdBestHeaderLine(s, bestBySkill.get(s.key)) +
          `\n\nClick to rank every model by this subject` +
          (sdDomainOf(s.key) === undefined
            ? "."
            : " — measured Epoch AI percentile first, then grade, then AA index."),
      )}">` +
      `${esc(s.label)}${s.grading === "judged" ? SD_JUDGED_MARK : ""}</th>`,
  ).join("");

  const topicHeads = SC_TOPICS.map(
    (t) =>
      `<th class="sd-cens-h" data-tip="${esc(`${t.label} — ${t.about}`)}">${esc(t.label)}</th>`,
  ).join("");

  const skillLegend = (["top", "strong", "ok", "weak"] as Skill[])
    .map(
      (v) =>
        `<span class="sd-leg"><span class="sd-tag sd-s-${v}">${SC_SKILL_GLYPH[v]}</span>` +
        `${esc(SC_SKILL_LABEL[v])}</span>`,
    )
    .join("");

  const legend = (["hard", "gated", "soft", "open"] as Verdict[])
    .map(
      (v) =>
        `<span class="sd-leg"><span class="sd-tag sd-v-${v}">${SC_VERDICT_GLYPH[v]}</span>` +
        `${esc(SC_VERDICT_LABEL[v])}</span>`,
    )
    .join("");

  const shared = SC_SHARED_REFUSALS.map((s) => `<li>${esc(s)}</li>`).join("");
  const splits = SC_SPLITS.map(
    (s) => `<div class="sd-split"><b>${esc(s.title)}</b> — ${esc(s.body)}</div>`,
  ).join("");
  // Rendered ONLY when a candidate set was supplied. Two reasons, both load-bearing:
  // the default call must stay byte-identical, and an envelope footer claiming a set
  // that was never computed would be exactly the confident-empty instrument this
  // panel exists to avoid.
  const thalNote =
    thalamus === undefined
      ? ""
      : `<p class="sd-note">THALAMUS ENVELOPE — ${thalamus.considered.length} of ` +
        `${thalamus.catalogSize} catalog entries sit inside the candidate set, ranked on the ` +
        `${esc(thalamus.basis)} basis. Membership and the pick both come from thalamusCandidates(), the ` +
        `same predicate the SMART x COST chart draws its envelope from, so the two panels agree by ` +
        `construction rather than by two lists kept in step by hand. An EMPTY envelope is a real ` +
        `answer, not a bug: it means no catalog entry survived the ranking and the veto.` +
        (thalamus.costVerified
          ? ""
          : ` COST NOT FULLY VERIFIED — at least one survivor carries no published cost on this basis, ` +
            `so the ceiling veto did not run on it and this envelope is WIDER than the router's answer.`) +
        (SD_THALAMUS_COLOR === undefined
          ? ` COLOUR UNRESOLVED — SC_THALAMUS did not resolve to a CSS colour, so the badges above are ` +
            `not painted in the chart's envelope hue.`
          : "") +
        `</p>`;

  return (
    `<div class="sd-legend"><span class="sd-leg-k sd-leg-k-cap">CAPABILITY</span>${skillLegend}` +
    `<span class="sd-leg-k sd-leg-k-cens">CENSORSHIP</span>${legend}` +
    // Plain text, no data-tip: the exact tooltip count in the test suite is a naive
    // split on `data-tip=`, and a legend item does not need its own tooltip.
    `<span class="sd-leg-prov">plain header = ANCHORED to a named benchmark · ` +
    `${SD_JUDGED_MARK} = JUDGED, no public anchor · dashed underline = graded, transport unproven · ` +
    `<sup>1</sup> on a glyph = best configured model in that column (measured Epoch AI percentile where one exists, else the grade)</span>` +
    `<span class="sd-leg-hint">hover any cell · click a subject to rank by it</span></div>` +
    `${routesStrip}` +
    `<table class="sd-table"><thead>` +
    `<tr class="sd-grp"><th colspan="2"></th>` +
    `<th class="sd-grp-cap" colspan="${SC_SKILLS.length}">CAPABILITY — what to route to it</th>` +
    `<th class="sd-grp-cens" colspan="${SC_TOPICS.length}">CENSORSHIP — what it will not answer</th></tr>` +
    `<tr><th class="sd-h-model" data-sort="index" data-tip="Sorted by the Artificial Analysis intelligence index. Click to restore this order.">MODEL · AA idx</th>` +
    `<th>BLOC</th>${skillHeads}${topicHeads}</tr>` +
    `</thead><tbody>${body}</tbody></table>` +
    `<div class="sd-shared"><div class="sd-shared-title">REFUSED BY BOTH CAMPS</div>` +
    `<ul>${shared}</ul>` +
    `<div class="sd-shared-title">WHERE THEY SPLIT</div>${splits}` +
    `<p class="sd-note">CAPABILITY grades are a synthesis across SWE-bench Verified, OckBench, published ` +
    `evaluations and vendor launch claims (marked as claims in the cell) — a routing prior, not a single ` +
    `measured benchmark. Two ★ in a column mean "either is a defensible first choice", not a tie score — ` +
    `unless the ★ carries a dashed underline, which marks it GRADED, NOT WIRED: right about the model, ` +
    `unproven about our route to it, and therefore not a routable first choice until the transport is ` +
    `probed. Every column now declares its PROVENANCE. ANCHORED means the grades are read off a named ` +
    `public measurement of that column's own question — only CODE, SPEED and COST clear that bar. JUDGED ` +
    `(a ${SD_JUDGED_MARK} on the header) means there is no public anchor and the grade is an opinion with ` +
    `its reasoning in the tooltip. LONG CTX is JUDGED on purpose: its MEASURED line is the ADVERTISED ` +
    `WINDOW while the grade is useful RECALL, and a related figure is not a basis. PSYCH was added ` +
    `2026-08-30 because the architect routes by it; EQ-Bench 3 is the anchor it should have and does not ` +
    `yet, for the two re-checkable reasons in that column's tooltip. ` +
    `CENSORSHIP is training-time disposition from usage policies, published testing and the July 2026 ` +
    `Hugging Face incident reporting — not guarantees: jailbreaks, endpoint-side filtering and version drift ` +
    `all exist. Corrected 2026-08-06: an earlier version of this table listed cyberattack tooling as refused ` +
    `by both camps, which averaged away the one asymmetry that mattered. Since 2026-09-02 the ` +
    `<sup>1</sup> on a glyph marks the single best CONFIGURED model in that column — the highest ` +
    `Epoch AI percentile where any configured model has a public per-domain run, the judged grade ` +
    `where none does (WRITE and PSYCH at the time of writing) — and the header tooltip says which. ` +
    `The THALAMUS ROUTES strip above the table is the router's own answer per task domain at the ` +
    `current BIAS, from the same functions the reply path calls.</p>${thalNote}</div>`
  );
}

// ─── CN PROVIDER × MODEL PRICE MATRIX (the architect 2026-08-15) ───────────────────────
// Appended to the foot of the dossier: "which provider serves each Chinese model,
// and what is the best price". It answers a procurement question the SMART × COST
// chart cannot — that chart plots ONE price per model, but OpenRouter routes each
// model to many providers whose prices differ by up to 6x.
//
// The data is GENERATED, never hand-written (cn-provider-prices.generated.ts,
// refreshed by the model-rank-refresh cron). Two of five prices moved within 48h in
// August 2026, so a literal typed here would be wrong within days — the same rot that
// has repeatedly killed hardcoded figures elsewhere in this UI.
export function cnMatrixColumns(data: CnProviderPrices, max = 8): string[] {
  // Columns are chosen by COVERAGE, computed from the data rather than pinned, so a
  // provider that starts serving more models earns its column without an edit.
  const count = new Map<string, number>();
  for (const m of Object.values(data.models)) {
    for (const p of Object.keys(m.providers)) count.set(p, (count.get(p) ?? 0) + 1);
  }
  const labs = new Set(
    Object.values(data.models)
      .map((m) => m.lab)
      .filter(Boolean) as string[],
  );
  return [...count.entries()]
    .filter(([p]) => !labs.has(p)) // labs get their own "direct" column
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([p]) => p);
}

export function renderCnProviderMatrix(data: CnProviderPrices): string {
  const cols = cnMatrixColumns(data);
  const ids = Object.keys(data.models);
  const money = (v: number): string => (v >= 1 ? v.toFixed(2) : v.toFixed(4));
  let rows = "";
  for (const id of ids) {
    const m = data.models[id]!;
    const labRow = m.lab ? m.providers[m.lab] : undefined;
    const best = m.cheapest;
    // Bold marks the cheapest cell IN THIS ROW — the whole point of the table.
    const cell = (p: string | null, row?: { out: number; quant: string }): string => {
      if (!row) return `<td class="sd-cap">—</td>`;
      const isBest = p !== null && p === best.provider;
      const q = row.quant && row.quant !== "unknown" ? row.quant : "";
      const tip = `${id} · ${p ?? "lab"} — $${money(row.out)}/M out${q ? ` · ${q}` : ""}`;
      return (
        `<td class="sd-cap${isBest ? " sd-cn-best" : ""}" title="${esc(tip)}">` +
        `${isBest ? "<b>" : ""}${money(row.out)}${isBest ? "</b>" : ""}</td>`
      );
    };
    const sub = m.lab ? data.subscriptions[m.lab] : undefined;
    const subTag = sub
      ? `<span class="sd-cn-sub${sub.confirmed ? "" : " sd-cn-sub-unconfirmed"}" title="${esc(
          `${sub.plan} — from ${sub.from} ${sub.currency}/mo${sub.confirmed ? "" : " (UNCONFIRMED: no first-party page reached)"}`,
        )}">${sub.confirmed ? "sub" : "sub?"}</span>`
      : `<span class="sd-cn-payg" title="pay-per-use only">pay/use</span>`;
    rows +=
      `<tr><th class="sd-model">${esc(id)} ${subTag}</th>` +
      cell(m.lab, labRow) +
      cols.map((c) => cell(c, m.providers[c])).join("") +
      `<td class="sd-cn-cheapest">${esc(best.provider)} <b>${money(best.out)}</b></td></tr>`;
  }
  const subLines = Object.entries(data.subscriptions)
    .map(([lab, s]) =>
      s
        ? `${esc(lab)}: ${esc(s.plan)} from $${s.from}/mo${s.confirmed ? "" : " <i>(unconfirmed)</i>"}`
        : `${esc(lab)}: pay-per-use only`,
    )
    .join(" · ");
  const when = data.fetchedAt.slice(0, 16).replace("T", " ");
  return (
    `<div class="sd-cn-matrix"><h3>CN PROVIDER × MODEL — best price per model</h3>` +
    `<table class="sd-table sd-cn-table"><thead><tr>` +
    `<th class="sd-model">model</th><th>lab direct</th>` +
    cols.map((c) => `<th>${esc(c)}</th>`).join("") +
    `<th>cheapest</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<p class="sd-note"><b>$ per 1M OUTPUT tokens</b>, cheapest endpoint per provider. ` +
    `Bold = best price for that model. ` +
    `<b>Caveat:</b> the cheapest route is often <code>fp4</code> quantisation — hover a cell for its precision; ` +
    `cheap can buy lower quality. Subscriptions: ${subLines}. ` +
    `Everything else is pay-per-use credits. ` +
    `Source: ${esc(data.source)}, fetched ${esc(when)} — regenerated daily by the model-rank-refresh cron, ` +
    `because these prices move within days.</p></div>`
  );
}
