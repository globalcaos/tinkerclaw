// tinker-ui/src/panels/smart-model-dossier.ts
// IMPORT ORDER IS THE FORMATTER'S, NOT A PREFERENCE — .oxfmtrc.jsonc enables
// sortImports, which sorts "../../../src/shared/…" ABOVE "./…" and binds a leading
// comment to the import beneath it. Written PRE-SORTED with the shared import
// first, so the path banner on line 1 is bound to an import that cannot move.
// After `pnpm format`, re-check that line 1 is still the banner.
import { DOMAIN_STRENGTH } from "../../../src/shared/domain-strength.generated.js";
import type { ThalamusCandidatesResult } from "../../../src/shared/thalamus-candidates.js";
import {
  clampBiasIdx,
  domainStrengthFor,
  frontierRungsFor,
  TASK_DOMAINS,
  thalamusRoutesByDomain,
} from "../../../src/shared/thalamus-frontier.js";
import type {
  DomainStrength,
  FrontierRung,
  TaskDomain,
  ThalamusRoute,
} from "../../../src/shared/thalamus-frontier.js";
import type { CnModelPrices, CnProviderPrices } from "./cn-provider-prices.generated.js";
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

// ── FORK 2026-09-23 (the architect): GRANULARITY, INFLUENCE, LEGIBILITY ───────────────
//
// THE ARCHITECT: "the table that explains which model is best at what should be more
// granular, more visual, and it finally influences Thalamus."
//
// Three asks, and the middle one is the load-bearing one. Before today a capability
// column was an OPINION IN A GRID: eight of the eleven happened to share a name with a
// Thalamus TaskDomain, three did not, and nothing enforced the correspondence. A column
// nobody can route by is decoration, however well sourced.
//
// THE RULE THIS FILE NOW ENFORCES: every capability column IS a TaskDomain. SkillKey
// minus SPEED and COST equals TASK_DOMAINS in src/shared/thalamus-frontier.ts, exactly;
// SD_DOMAIN_KEYS is now built FROM that array rather than repeating it, so the two lists
// cannot drift apart, and smart-model-dossier.test.ts pins the route strip to it. Adding
// a column from here on means adding a domain, its DOMAIN_CUES regex, a test that a real
// prompt classifies to it, and a BENCH_DOMAIN mapping — or deciding, in writing, that
// there is no benchmark for it.
//
// ELEVEN COLUMNS BECAME SEVENTEEN (fifteen capability + SPEED and COST). Each split had
// to earn it by pointing at two different answers, not by sounding tidier:
//
//   CODE → CODE + FRONTEND.   WebDev Arena 2026-09-22: GPT-6 Astra 1793 Elo, Fable 5.1
//                             1755, Opus 5 1691. SWE-bench Verified: Fable 5.1 95%, the
//                             column leader. The two boards disagree at the top, so one
//                             column was averaging away the answer.
//   REASON → MATHS + SCIENCE + REASON.   Epoch AI publishes these as three separate
//                             families of table (FrontierMath / GPQA / ARC-AGI) and they
//                             do not rank the same models in the same order.
//   WORLD → FACTUAL + WORLD.  This one was a CORRECTION, not an addition. WORLD's own
//                             basis line has always said it grades live retrieval — and
//                             it was carrying SimpleQA, MMLU and TriviaQA, which measure
//                             parametric recall. That is precisely the two-bases error
//                             this header forbids two blocks up. The tables moved to
//                             FACTUAL, where they answer the question being asked, and
//                             WORLD is now honestly unmeasured.
//   NEW: DATA, LANGUAGES, INSTRUCT.   Spreadsheets and SQL; working in Catalan and
//                             Spanish; obeying an exact output format. Three things the
//                             architect routes by daily that this table could not name.
//
// WHAT "INFLUENCES THALAMUS" ACTUALLY MEANS, mechanically: classifyTaskDomain() can now
// return any of the fifteen, thalamusRoutesByDomain() reports all of them, thalamus-plan's
// BUILDISH set (cross-vendor critic) gained FRONTEND and DATA, and build_domain_strength.py
// maps Epoch's tables onto the new domains — which also fixed eight tables that were
// silently unmapped because the map spelled their names differently from Epoch's metadata
// ("ALE-Bench", "EnigmaEval", "SpatialViz-Bench", "BTF-3", "GDP.pdf", "ForecastBench"...).
// Unmapped benchmarks went from 34 to 10, and the remaining ten are saturated pre-2024 NLP
// tables listed in that script as a deliberate exclusion.
//
// SEVEN COLUMNS HAVE NO MEASUREMENT AT ALL and that is stated rather than papered over:
// FRONTEND (Epoch lists WebDev Arena with no rows — the column is anchored on the LMArena
// board instead), DATA, WRITE, LANGUAGES, PSYCH, INSTRUCT, WORLD. In those domains
// domainStrengthFor() returns undefined and thalamusRoute() keeps the bias pick, which is
// EXACTLY what it already did for any family with no run. A new domain can therefore never
// break routing; at worst it is a no-op until a benchmark exists. There is a test for that.
//
// MORE VISUAL, and why each mark exists rather than being decoration: the grade wash moved
// from the glyph to the CELL, so a column reads as a gradient instead of a column of
// symbols; a MEASURED Epoch percentile draws a small bar, because a column of bars has a
// SHAPE while a column of numbers has to be read; best-in-column became a filled gold pill
// rather than a superscript digit the eye slides over at seventeen columns; the columns sit
// under BUILD / THINK / TALK / SEE & KNOW / PRACTICAL banners; and every column header
// carries a plain-English "good at" line, because the page this panel is exported to is
// read by people who have never heard of SWE-bench. NO BAR MEANS NOT MEASURED, never zero.
//
// Static DOM + CSS throughout — tooltips on `title`/`data-tip`, sorting on `data-sort`,
// the percentile width as an inline style — because export-ai-analysis.mjs scrapes the
// rendered panel into WordPress and anything runtime-only arrives there as a blank.

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

/**
 * One capability column. Every key except "speed" and "cost" is ALSO a Thalamus
 * `TaskDomain` (see SD_DOMAIN_KEYS below and the header's GRANULARITY block) — that
 * is the rule that stops this table from being decoration: a column the router
 * cannot name is a column nobody routes by.
 */
export type SkillKey =
  // BUILD — make a thing
  | "code"
  | "frontend"
  | "shell"
  | "data"
  | "ml"
  | "cad"
  // WORK — do a job end to end (2026-10-02: agentic moved here, three verticals joined it)
  | "agentic"
  | "research"
  | "office"
  | "security"
  // THINK — work a problem
  | "maths"
  | "science"
  | "reason"
  // TALK — produce language for a person
  | "write"
  | "languages"
  | "psych"
  | "instruct"
  // SEE & KNOW — take in the world
  | "context"
  | "vision"
  | "factual"
  | "health"
  | "world"
  // PRACTICAL — properties of the route, not of the work
  | "speed"
  | "cost";

/** The banner a run of columns sits under. Ordered exactly as SC_SKILLS is ordered. */
export type SkillGroup = "BUILD" | "WORK" | "THINK" | "TALK" | "SEE & KNOW" | "PRACTICAL";

/** What each group means, in one line a non-expert reads without stopping. */
export const SC_SKILL_GROUP_ABOUT: Record<SkillGroup, string> = {
  BUILD: "makes something that has to work",
  WORK: "does a whole job, start to finish",
  THINK: "works a problem out",
  TALK: "produces language for a person",
  "SEE & KNOW": "takes the world in",
  PRACTICAL: "what it costs you to use it",
};

/**
 * Where a column's grades come from. See the PSYCH block in the file header for
 * why this is a REQUIRED field rather than a comment: a column that cannot say
 * whether it is measured or judged is a column that will be read as measured.
 */
export type SkillGrading = "anchored" | "judged";

export interface SkillDef {
  key: SkillKey;
  label: string;
  /** The banner this column sits under in the header. */
  group: SkillGroup;
  /**
   * GOOD AT, in the fewest plain words that still mean something — printed UNDER the
   * column label, so the table is legible to someone who has never heard of SWE-bench.
   * Deliberately tiny (the column is ~52px): the full sentence is `about`, on hover.
   */
  goodAt: string;
  /** Column-header mouseover: what routing decision this column answers. */
  about: string;
  /** ANCHORED (a named public measurement of THIS column's question) or JUDGED. */
  grading: SkillGrading;
  /** ANCHORED: the exact measurement. JUDGED: why there is not one, checkably. */
  basis: string;
}

/** The header banners, derived from SC_SKILLS order so the two can never disagree. */
export function scSkillGroups(): { group: SkillGroup; span: number }[] {
  const out: { group: SkillGroup; span: number }[] = [];
  for (const s of SC_SKILLS) {
    const last = out[out.length - 1];
    if (last && last.group === s.group) last.span += 1;
    else out.push({ group: s.group, span: 1 });
  }
  return out;
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

// The order a column appears in. SC_SKILLS below is written in the order each column was
// added; this is the order the table shows them, and the order TASK_DOMAINS must match.
const SC_SKILL_ORDER: SkillKey[] = [
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
  "speed",
  "cost",
];

const SC_SKILLS_AS_ADDED: SkillDef[] = [
  // ── BUILD ────────────────────────────────────────────────────────────────
  {
    key: "code",
    label: "CODE",
    group: "BUILD",
    goodAt: "fixing code",
    grading: "anchored",
    basis:
      "SWE-bench Verified, llm-stats leaderboard 2026-08-07 — the per-model figure is in the cell.",
    about:
      "Writing, refactoring and debugging a real codebase — SWE-bench Verified territory. Route implementation work by this column. NARROWED 2026-09-23: building a web interface moved to FRONTEND, because the two boards disagree at the top.",
  },
  {
    key: "frontend",
    label: "FRONTEND",
    group: "BUILD",
    goodAt: "web pages, UI",
    grading: "anchored",
    basis:
      "WebDev Arena (arena.ai/leaderboard/code/webdev), blind human preference over 735,398 votes, snapshot 2026-09-22 — the per-model Elo is in the cell. Epoch AI lists this table in its metadata but ships no rows for it, so there is no percentile in this column and THALAMUS falls back to the plain bias pick here, exactly as it does for any family with no run.",
    about:
      "Building an interface somebody has to look at: layout, CSS, components, a page that holds together. A DIFFERENT question from CODE, and the evidence says so — on the 2026-09-22 WebDev board GPT-6 Astra leads at 1793 Elo while Fable 5.1, which tops SWE-bench Verified at 95%, is second at 1755. One column could not tell you that.",
  },
  {
    key: "agentic",
    label: "AGENTIC",
    group: "WORK",
    goodAt: "long multi-step jobs",
    grading: "judged",
    basis:
      "OckBench (arXiv:2511.05722) ranks part of this field but not all of these families, so the grade is a synthesis rather than a leaderboard read. The MEASURED line is Epoch AI's percentile over its agentic tables (OSWorld, GDPval, Remote Labor Index, The Agent Company, METR Time Horizons, Cybench and others), which 52 families have run.",
    about:
      "Long-horizon autonomous execution: many steps, many tool calls, recovering from its own mistakes without a human turn. Not the same as raw reasoning — this is the column ORCA and subagent dispatch should read.",
  },
  {
    key: "data",
    label: "DATA",
    group: "BUILD",
    goodAt: "spreadsheets, SQL",
    grading: "judged",
    basis:
      "No cross-family anchor exists, and the near misses are worth naming so this can be re-checked rather than believed: BIRD-SQL (dev) is the nearest public board and lists nine models led by a superseded Gemini 2.0-class entry, so it cannot order this table; DABench (257 tasks over 52 CSV files) and TableBench publish no frontier leaderboard. Epoch AI has no table in this domain either, so the column is unmeasured and THALAMUS falls back to the plain bias pick.",
    about:
      "Spreadsheets, CSVs, SQL and the analysis on top of them: reading a table correctly, aggregating it, and NOT inventing a number that was never in it. Added 2026-09-23 because it is most of what a working day looks like and CODE was quietly absorbing it.",
  },
  // ── THINK ────────────────────────────────────────────────────────────────
  {
    key: "maths",
    label: "MATHS",
    group: "THINK",
    goodAt: "proofs, calculation",
    grading: "judged",
    basis:
      "Epoch AI's maths tables (FrontierMath tiers 1–4 and Erdos, MATH level 5, OTIS Mock AIME, ProofBench, GSM8K) give the MEASURED percentile in each cell, over 101 families. The GRADE stays a synthesis because no single one of those tables ranks every family in this dossier.",
    about:
      "Proofs, competition problems, symbolic work, and getting the arithmetic right. Split out of REASON on 2026-09-23: the model that tops FrontierMath is not the model that tops ARC-AGI, and one column could not say both.",
  },
  {
    key: "science",
    label: "SCIENCE",
    group: "THINK",
    goodAt: "physics, chem, bio",
    grading: "judged",
    basis:
      "Epoch AI's science tables (GPQA diamond, HLE, CritPt, ScienceQA) give the MEASURED percentile, over 78 families. The grade is a synthesis across them.",
    about:
      "Graduate-level physics, chemistry and biology — GPQA territory. Route a research question here rather than to MATHS: they are different tables and, on the measured percentiles, different leaders.",
  },
  {
    key: "reason",
    label: "REASON",
    group: "THINK",
    goodAt: "puzzles, logic",
    grading: "judged",
    basis:
      "Epoch AI's puzzle and logic tables (ARC-AGI, ARC-AGI-2, SimpleBench, WeirdML, Chess Puzzles, Mystery Game Puzzles, EnigmaEval, BBH, and conceptualreasoning.ai's DTBench and LMCA) give the MEASURED percentile over 105 families; none of them ranks every family, so the grade is a synthesis.",
    about:
      "Lateral thinking, logic puzzles, trick questions — problems where the trap is in the framing rather than in the arithmetic. RE-SCOPED 2026-09-23: maths and science left for their own columns, which is what this column always should have meant.",
  },
  // ── TALK ─────────────────────────────────────────────────────────────────
  {
    key: "write",
    label: "WRITE",
    group: "TALK",
    goodAt: "emails, prose",
    grading: "judged",
    basis:
      "Prose boards (arena ELO, EQ-Bench creative writing) are LLM-judged and none of them scores CORRESPONDENCE, which is most of what this column is asked to route. Epoch AI carries one writing table (Lech Mazur Writing) and it does not clear this generator's four-family floor, so there is no percentile here either.",
    about:
      "Prose for humans, and CORRESPONDENCE above all: email, replies, the difficult message you have to send today. Register, tone and instruction-following, not literary flair. Weakly correlated with coding ability — route drafting separately. Deliberately NOT split into an EMAIL column: email is prose, and a column per genre is how this table stops being readable.",
  },
  {
    key: "languages",
    label: "LANGUAGES",
    group: "TALK",
    goodAt: "Catalan, Spanish, translation",
    grading: "judged",
    basis:
      "No Epoch AI table. BenchLM's multilingual board (September 2026) is the nearest anchor and puts Qwen 3.7 Max on top; LA LEADERBOARD (arXiv:2507.00999 — 66 datasets across Catalan, Basque, Galician and Spanish varieties, 50 models) and IberBench (101 datasets, 22 task types) cover exactly the architect's languages but score mostly smaller open models, so neither can order this table. Grades read those three plus vendor-published multilingual coverage.",
    about:
      "Working in a language that is not English: translation, and writing a native speaker would not flinch at. Added 2026-09-23 because the architect works in Catalan and Spanish daily, and an English-only board says nothing about either.",
  },
  {
    key: "psych",
    label: "PSYCH",
    group: "TALK",
    goodAt: "reading people",
    grading: "judged",
    basis:
      "EQ-Bench 3 (eqbench.com) is current and is the right anchor for this column. It is not used yet for two re-checkable reasons: it publishes no rows for the models in this table, and it is LLM-judged by an Anthropic model, which is a conflict on the exact Claude-versus-GPT question this column exists to answer. Anchor it the day both are fixed.",
    about:
      "Reading people: emotional nuance, motive and subtext, difficult conversations, advice that actually lands. Route anything where the hard part is the PERSON rather than the problem. Read it together with WRITE — WRITE says who drafts the message well, this says who understands who is receiving it.",
  },
  {
    key: "instruct",
    label: "INSTRUCT",
    group: "TALK",
    goodAt: "obeys the exact format",
    grading: "judged",
    basis:
      "IFBench (Allen Institute — 58 verifiable out-of-domain constraints over 294 prompts) is the right anchor and does not yet order this table. Two named snapshots disagree at the top: BenchLM 2026-09-17 has 42 models inside 2.8 points (MAI-Thinking-1 85%, Qwen 3.8 Max 82.8%, Inkling-Small 82.2%), while Artificial Analysis's own IFBench page lists Grok 4.3 at 83.3% and MiniMax M3 at 82.9%. Two sources that disagree at the top are not an ordinal, so the grades are judged and say so.",
    about:
      "Does what you asked, in the shape you asked for: a word limit, 'output only JSON', a fixed template, no extra commentary. This is the column that decides whether a fan-out's results can be parsed without a human reading them.",
  },
  // ── SEE & KNOW ───────────────────────────────────────────────────────────
  {
    key: "context",
    label: "LONG CTX",
    group: "SEE & KNOW",
    goodAt: "very long inputs",
    grading: "judged",
    basis:
      "Grades USEFUL RECALL, which nobody publishes across these families. The MEASURED line in each cell is the ADVERTISED WINDOW from the BenchLM pricing table — a related figure, not this grade's basis. Epoch AI's long-context tables (Fiction.LiveBench, CL-bench, CL-bench Life) add a percentile over 20 families.",
    about:
      "Useful recall across a very large input, not just the advertised window. Route whole-repo reads and long transcripts here.",
  },
  {
    key: "vision",
    label: "VISION",
    group: "SEE & KNOW",
    goodAt: "images, screenshots",
    grading: "judged",
    basis:
      "No cross-family multimodal leaderboard covers these families, and vendor model cards are not comparable to one another. Epoch AI's spatial and visual tables (VPCT, CadEval, Surface Evolver Bench, GeoBench) give the percentile, over 30 families.",
    about:
      "Images, screenshots, documents, video frames. The most uneven column: several strong text models are near-blind, and a few cannot take an image at all.",
  },
  {
    key: "factual",
    label: "FACTUAL",
    group: "SEE & KNOW",
    goodAt: "gets facts right",
    grading: "judged",
    basis:
      "Epoch AI's knowledge tables (SimpleQA Verified, MMLU, TriviaQA, OpenBookQA, ARC AI2) give the MEASURED percentile over 54 families. Those tables MOVED HERE FROM WORLD on 2026-09-23: they measure what a model already knows, while WORLD claims live retrieval, and grading one on the other is the two-bases error this file's header forbids. Artificial Analysis's AA-Omniscience Index (arXiv:2511.13029) is the better anchor for the abstention half and publishes only a handful of rows — Opus 5.5 46, GPT-6 Astra 44, Fable 5.1 43 on a −100..100 scale where above zero means right more often than wrong — so the grade stays judged.",
    about:
      "Gets facts right, and says 'I don't know' rather than inventing one. Read this column before trusting any answer you cannot check yourself. Separate from WORLD on purpose: this is what it already knows, WORLD is what it can go and look up.",
  },
  {
    key: "world",
    label: "WORLD",
    group: "SEE & KNOW",
    goodAt: "today's news",
    grading: "judged",
    basis:
      "No benchmark measures live retrieval, so the grade reads the TRANSPORT — search grounding, a live firehose — and marks the cell when that transport is unproven from here. UNMEASURED BY DESIGN since 2026-09-23: the knowledge tables this column used to carry moved to FACTUAL, and ForecastBench, the only honest candidate left, ships no rows in Epoch's data. THALAMUS therefore falls back to the plain bias pick in this domain.",
    about:
      "Current events and real-time knowledge beyond the training cut-off — what it can go and FETCH, not what it memorised. Route anything time-sensitive here.",
  },
  // ── PRACTICAL ────────────────────────────────────────────────────────────
  {
    key: "speed",
    label: "SPEED",
    group: "PRACTICAL",
    goodAt: "answers fast",
    grading: "anchored",
    basis:
      "Output throughput, llm-stats 2026-08-07 — the per-model figure is in the cell, and a row with no leaderboard entry says so instead of guessing one.",
    about:
      "Latency and throughput. Route anything interactive or fanned-out wide by this column, not by intelligence. Not a task domain: it is a property of the route, so THALAMUS reads it through the €/task axis rather than as a domain.",
  },
  {
    key: "cost",
    label: "COST",
    group: "PRACTICAL",
    goodAt: "cheap to run",
    grading: "anchored",
    basis:
      "BenchLM pricing table 2026-08-07, dollars per million input and output tokens — the per-model figure is in the cell.",
    about:
      "Price per unit of work — ★ means cheapest tier. A high score here plus an adequate score elsewhere is what makes a fan-out affordable. Not a task domain, for the same reason as SPEED.",
  },
  // ── 2026-10-02 VERTICALS (the architect: "research online what the different benchmarks on each
  //    model indicate, and find more verticals"). Definitions and grades come from one
  //    research pass per column; the cells live in SC_VERTICAL_CELLS below.
  {
    key: "shell",
    label: "SHELL",
    group: "BUILD",
    goodAt: "servers, Linux, DevOps",
    grading: "anchored",
    basis:
      "Terminal-Bench 4.0, a suite of containerised command-line tasks, ranks 25 of these 28 families. Read across four runs between 29 Sep and 2 Oct 2026: the official tbench.ai board, the Vals rerun (29 Sep), Artificial Analysis (1 Oct) and llm-stats (2 Oct). Families with no 4.0 entry (Haiku 4.5, the Codex line, GPT-5.4/5.5, Hermes) are placed from the easier Terminal-Bench 2.1 and 2.0 boards or from Terminal-Bench Hard, and each tip says so.",
    about:
      "Which model to hand a real machine to: a terminal, an ssh session, a server that will not boot. CODE asks whether it can write and fix source in a repo and AGENTIC asks whether it can keep a long job on track; this column asks whether it can drive the box itself, where a wrong command breaks something.",
  },
  {
    key: "ml",
    label: "ML",
    group: "BUILD",
    goodAt: "training models",
    grading: "anchored",
    basis:
      "Two public boards rank most of these families on exactly this question. WeirdML v3 (htihle.github.io, data generated 2026-10-02) scores 17 models on 11 hand-made training tasks, and the older WeirdML v2 CSV covers 162 entries including the cheap and open-weight families; PostTrainBench v1.1 (benchlm.ai, Oct 1 2026, plus the llm-stats view updated 2026-10-02) scores 14+ models on fine-tuning a base model with ten hours on one GPU. MLE-bench is ranked by scaffold rather than by model in 2026, so it was not used for grades.",
    about:
      "Answers who to hand an actual training job to: prepare the data, pick an architecture, run the training, read the loss curve and improve the result. CODE measures fixing bugs in existing software and FRONTEND measures building a page; a model can be excellent at both and still not know why a training run is overfitting.",
  },
  {
    key: "cad",
    label: "CAD",
    group: "BUILD",
    goodAt: "3D parts, geometry",
    grading: "judged",
    basis:
      "No single public board ranks most of these 28 families on mechanical design, so this column is judged from four current measurements that each cover part of the field: Blueprint-Bench 2 (31 models, snapshot 30 Sep 2026, photos to floor plan), Surface Evolver Bench (27 runs, repo last updated 11 Sep 2026, writing geometry-physics simulation files), BenchCAD on llm-stats (6 models, updated 2 Oct 2026, CadQuery code from multi-view renders scored by voxel overlap) and CADBench (11 systems, 13 Jul 2026, recovering editable CAD programs). Epoch AI's CadEval board is stale for this purpose: its top entry is still o3 at 74 as of 6 May 2026, with no 2026 model on it.",
    about:
      "Answers which model to send mechanical and spatial engineering to: parametric CAD code that has to execute and match a reference shape, part and assembly reasoning, tolerances, and reading blueprints or drawings. CODE scores text-logic correctness with no 3D kernel to satisfy, and VISION is about reading an image rather than producing a dimensioned part that a CAD engine will accept.",
  },
  {
    key: "research",
    label: "RESEARCH",
    group: "WORK",
    goodAt: "web research, reports",
    grading: "anchored",
    basis:
      "BrowseComp (1,266 hard multi-hop web questions) ranks most of these families directly: 44 models on the BenchLM board updated 1 Oct 2026, with per-model dates and vendor attribution on evals.report. HLE-with-tools (21 models, BenchLM, 1 Oct 2026) covers the Chinese open-weight families BrowseComp skips, and llm-stats' 18-benchmark research composite (2 Oct 2026) adds citation-validity and contradiction-handling. Most of these numbers are lab-reported and marked as such below; the small uncensored tunes have no research measurement at all.",
    about:
      "Answers: who do I hand an open-ended 'go find out and write it up with sources' job to. Unlike AGENTIC, which is about surviving a long multi-step task in any domain, this one scores whether the finished report is correct and properly sourced. Unlike FACTUAL and WORLD, which test what a model already knows, this assumes it has search and has to go read.",
  },
  {
    key: "office",
    label: "OFFICE",
    group: "WORK",
    goodAt: "reports, decks, client work",
    grading: "anchored",
    basis:
      "GDPval-AA v2.1, run independently by Artificial Analysis on OpenAI's GDPval task set: 1,320 tasks across 44 occupations and 9 industries, where the model must produce the actual file (document, slide deck, spreadsheet, diagram) and the outputs are compared blind, head to head, by LLM judges into an Elo rating. The normalized board covering 117 models was last updated 1 October 2026; a 19-model Elo version was rebuilt 29 September 2026. Mercor's APEX-1 (400 hidden tasks across investment banking, consulting, big law and primary care) and APEX-Agents (240 tasks, 31 worlds) are used as a second opinion where they disagree.",
    about:
      "Answers: who should write the thing a client actually receives - the report, the deck, the proposal, the memo that has to stand up in a meeting. It differs from WRITE, which is about correspondence and tone in a message, and from DATA, which is about getting numbers right inside a spreadsheet or a query. OFFICE is about the finished professional artifact: structure, completeness, and whether an expert in that trade would accept it.",
  },
  {
    key: "security",
    label: "SECURITY",
    group: "WORK",
    goodAt: "find and fix vulnerabilities",
    grading: "judged",
    basis:
      "No independent board ranks most of these families. CyberGym (1,507 real vulnerabilities) is the widest table, but all 28 entries on the BenchLM and llm-stats boards (2 Oct 2026) are self-reported by the labs. The independent runs are Epoch AI's Cybench and ExploitBench tables, which cover nine mostly older families, plus the cyber sections of the Opus 5.5 (22 Sep 2026) and GPT-6 Astra (Sep 2026) system cards. Grades weigh those over the self-reported CyberGym numbers.",
    about:
      "Finding, reproducing and fixing vulnerabilities: reading code for bugs, CTF-style challenges, writing an exploit for an authorised test, hardening a server. Different from SHELL, which is running a machine, and from CODE, which is building features: this column asks whether the model can break and then defend a system. It grades capability; whether a model agrees to help is in the censorship table.",
  },
  {
    key: "health",
    label: "HEALTH",
    group: "SEE & KNOW",
    goodAt: "symptoms, medicines, plants",
    grading: "anchored",
    basis:
      "HealthBench (OpenAI's 5,000 physician-rubric conversations) and its subsets rank 18 of these 28 families: the raw and Professional boards on benchlm.ai and benchmarklist.com (updated 1 Oct 2026, mostly vendor system-card numbers), the Hard board (llm-stats, 2 Oct 2026, all self-reported), and HealthBench-Psych, an independent 610-conversation run by clinicians at Beth Israel Deaconess (arXiv 2608.25071, 25 Aug 2026) that is the only cross-lab measurement here with confidence intervals. Two broader boards fill gaps: llm-stats' healthcare composite (248 models over 48 health benchmarks, 1 Oct 2026) and Vals AI's independent MedQA run (95 models, 16 Apr 2026), though MedQA is saturated at about 96% and separates almost nothing at the top.",
    about:
      "Answers which model to trust with a question about a body: what a symptom might be, whether two drugs clash, what a lab sheet means, what a plant or supplement actually does, and when to stop asking and see a doctor. Unlike SCIENCE (research-level biology) or FACTUAL (recall a drug name), these benchmarks grade against doctor-written rubrics for safety and hedging, so a model can know the pharmacology and still score badly by failing to say 'get this checked'.",
  },
];

export const SC_SKILLS: SkillDef[] = SC_SKILL_ORDER.map((key) => {
  const def = SC_SKILLS_AS_ADDED.find((d) => d.key === key);
  if (!def) throw new Error(`SC_SKILL_ORDER names ${key}, which has no SkillDef`);
  return def;
});

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
  /** WebDev Arena Elo, blind human preference, arena.ai snapshot 2026-09-22. */
  webdev?: number;
  /** AA-Omniscience Index, −100..100: [score, the exact variant scored]. */
  omni?: [number, string];
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
const WEBDEV_SRC = "WebDev Arena blind human preference, arena.ai 2026-09-22, 735,398 votes";
const OMNI_SRC = "AA-Omniscience Index, artificialanalysis.ai 2026-09-23 (arXiv:2511.13029)";
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
      webdev: 1755,
      omni: [43, "Claude Fable 5.1"],
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
      webdev: 1691,
      omni: [46, "Claude Opus 5.5"],
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
      webdev: 1617,
      tps: 134,
      price: [5, 30],
      ctx: 1_050_000,
    },
  },
  { match: /5\.6-terra/i, facts: { tps: 268, price: [2, 12], ctx: 1_050_000 } },
  { match: /5\.6-luna/i, facts: { price: [0.2, 1.2], ctx: 1_050_000 } },
  // ── GPT-6 tiers (2026-09-03 Astra, 2026-09-22 Sol and Luna). These MUST precede the
  //    generic /gpt-5|gpt-4/ row below, which would otherwise never be reached for them
  //    anyway — but the ordering hazard is real for the dossier rules, so it is mirrored
  //    here rather than left to luck.
  {
    match: /gpt-6-astra/i,
    facts: {
      refusal: [17.67, "GPT-4o, same policy family"],
      cnPol: [98.8, "GPT-OSS-120B"],
      webdev: 1793,
      omni: [44, "GPT-6 Astra (high)"],
      ctx: 1_050_000,
      as: "WebDev Elo on gpt-6-astra-max",
    },
  },
  {
    match: /gpt-6-sol/i,
    facts: {
      refusal: [17.67, "GPT-4o, same policy family"],
      price: [2, 10],
      ctx: 1_050_000,
      as: "price per OpenAI's 2026-09-22 launch post; 922K of the window is input, 128K max output",
    },
  },
  {
    match: /gpt-6-luna/i,
    facts: {
      refusal: [17.67, "GPT-4o, same policy family"],
      price: [0.1, 0.5],
      ctx: 1_050_000,
      as: "price per OpenAI's 2026-09-22 launch post",
    },
  },
  // ── Meta. The $0.10/$0.20 "contributor" endpoint is 10–20x cheaper in exchange for
  //    Meta training on your traffic; the figure here is the PRIVATE endpoint, because
  //    that is the one a dossier can honestly compare with everyone else's.
  {
    match: /muse|meta\//i,
    facts: {
      webdev: 1657,
      price: [1.25, 4.25],
      ctx: 1_000_000,
      as: "xhigh tier, private endpoint (Artificial Analysis); WebDev Elo on muse-spark-1.3-max",
    },
  },
  // ── Xiaomi. 1.02T sparse MoE, 42B active, MIT weights on Hugging Face, ~$3M to train.
  { match: /mimo|xiaomi/i, facts: { ctx: 1_000_000, as: "MiMo-V2.6-Pro, released 2026-09-22" } },
  {
    match: /minimax/i,
    facts: {
      tps: 168.9,
      as: "MiniMax M3 (released 2026-05-31); 0.92 s to first token against 2.15 s for MiMo-V2.6-Pro",
    },
  },
  // ── Tencent. The WebDev Elo is hy4-preview's, NOT hy3's — said out loud rather than
  //    quietly borrowed, which is the difference between a citation and a fabrication.
  { match: /hunyuan|\bhy3\b|tencent/i, facts: { webdev: 1627, as: "WebDev Elo on hy4-preview" } },
  {
    match: /stepfun|\bstep-?5\b/i,
    facts: {
      ctx: 1_000_000,
      as: "Step 5 Preview: 600B sparse MoE, 27B active; open weights promised 2026-10-15 and not published at the time of writing",
    },
  },
  { match: /\bo3\b|gpt-5|gpt-4/i, facts: { swebench: 80.0, as: "SWE-bench on GPT-5.2" } },
  // Artificial Analysis 2026-08-30 re-verified this row against grok-4.6: price
  // [2, 6] and ctx 500K are CURRENT, so a row-wide disclaimer overclaimed. Only
  // throughput is 4.5-era (AA puts grok-4.6 xhigh at 56.8 tok/s), so the variant
  // note is scoped to that one figure.
  {
    match: /grok|xai/i,
    facts: {
      webdev: 1632,
      tps: 124,
      price: [2, 6],
      ctx: 500_000,
      tpsAs: "Grok 4.5",
      as: "WebDev Elo on grok-4.7-xhigh",
    },
  },
  {
    match: /gemini.*flash/i,
    facts: {
      swebench: 78.0,
      webdev: 1595,
      price: [1.5, 9],
      ctx: 1_000_000,
      as: "SWE-bench on Gemini 3 Flash; WebDev Elo on gemini-3.7-flash-high",
    },
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
      webdev: 1658,
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
      webdev: 1616,
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
      webdev: 1620,
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
      webdev: 1671,
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
  if (key === "frontend" && f.webdev !== undefined)
    return `\n\nMEASURED — ${f.webdev} Elo (${src(WEBDEV_SRC)})`;
  // −100..100 and signed, so the sign is printed: "above zero" is the whole point of
  // the scale and a bare number would read as a percentage.
  if (key === "factual" && f.omni)
    return `\n\nMEASURED — AA-Omniscience Index ${f.omni[0] > 0 ? "+" : ""}${f.omni[0]} on −100..100 (${f.omni[1]}, ${OMNI_SRC}). Above zero means it is right more often than it is wrong; almost nothing is.`;
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
  | "weapons"
  | "drugs"
  | "malware"
  | "secwork"
  | "selfharm"
  | "hate"
  | "violence"
  | "privacy"
  | "copyright"
  | "advice"
  | "elections"
  | "hotbutton"
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
    key: "weapons",
    label: "WEAPONS",
    about:
      'Ordinary guns rather than bombs: 3D-printed firearm files, converting a semi-automatic to full-auto, making ammunition. Its own column because the labs write it as its own rule — Anthropic\'s "Do Not Develop or Design Weapons" and Meta\'s "guns and illegal weapons" are separate clauses from the CBRN one.',
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
    key: "selfharm",
    label: "SELF-HARM",
    about:
      "Will it actually talk about suicide, self-injury and eating disorders — or does it hand you a crisis hotline and stop? Likely the column that matters most to an ordinary person having a bad night, and one where a refusal is not obviously the safer answer.",
  },
  {
    key: "hate",
    label: "HATE",
    about:
      "Slurs, dehumanising content and extremist propaganda aimed at a group. Watch the difference between WRITING it and DISCUSSING it: nearly every model will analyse hate speech and quote it in research while refusing to produce it fresh.",
  },
  {
    key: "violence",
    label: "VIOLENCE",
    about:
      "Graphic violence and gore, including invented violence in fiction. This is the column that decides whether it will help with your war novel, your true-crime chapter or your horror screenplay.",
  },
  {
    key: "privacy",
    label: "PRIVACY",
    about:
      "Finding, tracking or identifying a real named person: doxxing, face recognition, people-search, or assembling a profile out of scattered public posts. Note this is about OTHER people's privacy, not about what the vendor does with your chats.",
  },
  {
    key: "copyright",
    label: "COPYRIGHT",
    about:
      "Reproducing text somebody owns — song lyrics, book chapters, paywalled articles — word for word instead of summarised. Microsoft ships a filter dedicated to exactly this and names lyrics, articles and recipes in it.",
  },
  {
    key: "advice",
    label: "MED·LEGAL",
    about:
      'A straight medical, legal or financial answer about YOUR situation, versus a disclaimer and "consult a professional". Nothing in this column is illegal to say — it is caution and liability, not law, which is why it varies so much.',
  },
  {
    key: "elections",
    label: "ELECTIONS",
    about:
      "Campaigning, lobbying, targeted political persuasion. A US-policy category with almost no Chinese equivalent.",
  },
  {
    key: "hotbutton",
    label: "HOT-BUTTON",
    about:
      "Contested Western politics — abortion, gender, race, immigration, Israel–Palestine, religion. Where the US labs differ most from EACH OTHER rather than from China, and the axis xAI markets itself on. SpeechMap.ai measures precisely this.",
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
export type TopicGroup = "SERIOUS HARM" | "CYBER" | "PEOPLE" | "LAW & RIGHTS" | "POLITICS & TASTE";

export const SC_TOPIC_GROUP_ABOUT: Record<TopicGroup, string> = {
  "SERIOUS HARM": "could get somebody killed or abused",
  CYBER: "attacking, or defending, computers",
  PEOPLE: "harm aimed at a person",
  "LAW & RIGHTS": "somebody else's data, work, or a professional's job",
  "POLITICS & TASTE": "contested opinion, and adult content",
};

/**
 * Column → band. A SEPARATE map rather than a `group` field on {@link TopicDef} on
 * purpose: SC_TOPICS is the half of this file other work lands in, and a presentation
 * concern has no business editing seventeen shared entries to add one banner.
 */
export const SC_TOPIC_GROUP: Record<TopicKey, TopicGroup> = {
  csam: "SERIOUS HARM",
  cbrn: "SERIOUS HARM",
  explosives: "SERIOUS HARM",
  weapons: "SERIOUS HARM",
  drugs: "SERIOUS HARM",
  malware: "CYBER",
  secwork: "CYBER",
  selfharm: "PEOPLE",
  hate: "PEOPLE",
  violence: "PEOPLE",
  privacy: "LAW & RIGHTS",
  copyright: "LAW & RIGHTS",
  advice: "LAW & RIGHTS",
  elections: "POLITICS & TASTE",
  hotbutton: "POLITICS & TASTE",
  cnpolitics: "POLITICS & TASTE",
  adult: "POLITICS & TASTE",
};

/**
 * WHAT IT MEANS, in the fewest plain words that still mean something — printed UNDER
 * the column label, same job as {@link SkillDef.goodAt} on the capability half. Each
 * line is a compression of that column's own `about`, never a new claim; the full
 * sentence is still one hover away.
 */
export const SC_TOPIC_PLAIN: Record<TopicKey, string> = {
  csam: "sex content with minors",
  cbrn: "bio, chem, nuclear weapons",
  explosives: "bombs and IEDs",
  weapons: "guns and ammunition",
  drugs: "how to make illegal drugs",
  malware: "writing attack software",
  secwork: "defending, analysing attacks",
  selfharm: "suicide, self-injury",
  hate: "slurs aimed at a group",
  violence: "gore, even in fiction",
  privacy: "tracking a real person",
  copyright: "copying words somebody owns",
  advice: "a straight medical or legal answer",
  elections: "political campaigning",
  hotbutton: "abortion, gender, religion",
  cnpolitics: "Tiananmen, Taiwan, the CCP",
  adult: "explicit sex between adults",
};

/** The refusal banners, derived from SC_TOPICS order so the two can never disagree. */
export function scTopicGroups(): { group: TopicGroup; span: number }[] {
  const out: { group: TopicGroup; span: number }[] = [];
  for (const t of SC_TOPICS) {
    const g = SC_TOPIC_GROUP[t.key];
    const last = out[out.length - 1];
    if (last && last.group === g) last.span += 1;
    else out.push({ group: g, span: 1 });
  }
  return out;
}

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
/** The seven columns added 2026-10-02, whose cells live in SC_VERTICAL_CELLS. */
export type VerticalKey = "shell" | "ml" | "cad" | "research" | "office" | "security" | "health";
/** What a family's own map still holds: every column except the verticals. */
type CoreSkills = Record<Exclude<SkillKey, VerticalKey>, SkillCell>;

const sk = (v: SkillGrade, tip: string, caveat?: string): SkillCell =>
  caveat === undefined ? { v, tip } : { v, tip, caveat };

const FABLE_SKILLS: CoreSkills = {
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
  frontend: sk(
    "top",
    "WebDev Arena 1755 Elo, second of 128 models on the 2026-09-22 board — 38 behind GPT-6 Astra and 64 clear of Opus 5. Either of the top two is a defensible first choice for a page.",
  ),
  data: sk(
    "strong",
    "Reliable on a sheet it can hold in one read, and disciplined about saying a column is missing. Opus 5 is the steadier hand when the analysis matters more than the throughput.",
  ),
  maths: sk(
    "strong",
    "Solid all the way through, but this is not the column it was built for — Opus 5 and the GPT-6 tiers finish proofs it grinds at.",
  ),
  science: sk(
    "strong",
    "Reads a paper well and reasons from it; below the dedicated reasoners on GPQA-style graduate questions.",
  ),
  languages: sk(
    "strong",
    "Good register in the major European languages, Catalan included. Not trained for it the way the Chinese labs are trained for Chinese.",
  ),
  instruct: sk(
    "strong",
    "Holds a format across a long run, which is the harder half of this column. Grok and Qwen edge it on IFBench's adversarial constraints.",
  ),
  factual: sk(
    "strong",
    "AA-Omniscience Index 43 — third of the handful of rows AA publishes, just behind Opus 5.5 at 46 and GPT-6 Astra at 44. Abstains rather than inventing.",
  ),
};

const OPUS_SKILLS: CoreSkills = {
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
  frontend: sk(
    "strong",
    "WebDev Arena 1691 Elo, third on the 2026-09-22 board. Clean, conventional markup; Astra and Fable 5.1 produce the page people actually vote for.",
  ),
  data: sk(
    "top",
    "The column's first choice. Most careful with a table it cannot see all of at once, and the least likely of any row here to report a cell that was never in the file.",
  ),
  maths: sk(
    "top",
    "Finishes proof-shaped work other rows abandon. Shares the top of this column with GPT-6 Astra and Sol.",
  ),
  science: sk(
    "top",
    "The graduate-science pick: holds a long chain of domain reasoning without drifting into plausible-sounding invention.",
  ),
  languages: sk(
    "strong",
    "Excellent tone in Spanish and Catalan; Qwen and Gemini 3.1 Pro cover more languages and score higher on the multilingual boards.",
  ),
  instruct: sk(
    "strong",
    "Beats Meta's Muse Spark 1.3 on the Agentic IF Index per Meta's own launch comparison — one of the few head-to-heads published on this question.",
  ),
  factual: sk(
    "top",
    "AA-Omniscience Index 46, the highest score Artificial Analysis publishes on a −100..100 scale where almost nothing clears zero. Knows what it does not know.",
  ),
};

const SONNET_SKILLS: CoreSkills = {
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
  frontend: sk(
    "ok",
    "No WebDev Arena row. Graded from family position: competent markup, well below the Opus and Fable tiers that are on the board.",
  ),
  data: sk(
    "strong",
    "Dependable on ordinary spreadsheet and SQL work at a price the flagships cannot match.",
  ),
  maths: sk(
    "strong",
    "Comfortable through undergraduate maths; the proof-grade tiers are a step up from here.",
  ),
  science: sk("strong", "Good on textbook science, thinner on research-grade questions."),
  languages: sk(
    "strong",
    "Solid Spanish and Catalan; the same family ear as Opus with less depth.",
  ),
  instruct: sk(
    "strong",
    "Follows a format reliably — the workhorse reason it survives in fan-outs where the output has to be parsed.",
  ),
  factual: sk(
    "strong",
    "No published AA-Omniscience row; graded on the family's abstention behaviour, which is the most conservative of the US labs.",
  ),
};

const HAIKU_SKILLS: CoreSkills = {
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
  frontend: sk("weak", "No board row and no reason to expect one. Route a page anywhere else."),
  data: sk(
    "ok",
    "Fine for a lookup or a tidy-up pass over a small table; not for the analysis itself.",
  ),
  maths: sk("weak", "Arithmetic slips under load. Not the tier for anything that has to be right."),
  science: sk("weak", "Recall only. It will answer a graduate question confidently and wrongly."),
  languages: sk(
    "ok",
    "Understands the major languages; the output reads translated rather than written.",
  ),
  instruct: sk("ok", "Holds a simple format; loses the thread on a long list of constraints."),
  factual: sk(
    "ok",
    "Small models hallucinate more, and this one is no exception — check anything it asserts.",
  ),
};

const SOL_SKILLS: CoreSkills = {
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
  frontend: sk(
    "strong",
    "WebDev Arena 1617 Elo on the 2026-09-22 board (gpt-5.6-sol-xhigh) — mid-table among the frontier, well behind its own GPT-6 successor.",
  ),
  data: sk(
    "strong",
    "Strong analytical read of a table, and willing to state the caveat rather than smooth it over.",
  ),
  maths: sk(
    "top",
    "Shares this column's top with Opus 5: proof-style and competition-style work is what this tier is for.",
  ),
  science: sk("top", "The other graduate-science first choice alongside Opus 5."),
  languages: sk(
    "strong",
    "Broad language coverage; the OpenAI tiers have always been even here rather than excellent.",
  ),
  instruct: sk(
    "strong",
    "Reliable with an explicit format. IFBench's out-of-domain constraints are where the frontier bunches, this one included.",
  ),
  factual: sk(
    "strong",
    "No published AA-Omniscience row for the 5.6 tier; graded from the family's behaviour, which abstains less readily than Anthropic's.",
  ),
};

const TERRA_SKILLS: CoreSkills = {
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
  frontend: sk("ok", "No WebDev Arena row. Graded from family position, one tier below Sol."),
  data: sk(
    "strong",
    "The volume tier for table work: fast enough to iterate, accurate enough to trust on a checkable answer.",
  ),
  maths: sk("strong", "Good through ordinary applied maths; not the tier to hand a proof."),
  science: sk("strong", "Competent on textbook science; below Sol on research-grade questions."),
  languages: sk("strong", "Same broad coverage as the rest of the family, a step down in polish."),
  instruct: sk(
    "strong",
    "Follows an explicit format well — the reason this tier carries fan-outs.",
  ),
  factual: sk("ok", "Faster tiers abstain less. Verify anything load-bearing."),
};

const LUNA_SKILLS: CoreSkills = {
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
  frontend: sk("weak", "No board row; the budget tier is not where a page gets built."),
  data: sk("ok", "Bulk transformation of a table, not the analysis of it."),
  maths: sk("ok", "Arithmetic and simple algebra only."),
  science: sk("ok", "Recall-level. Do not route a research question here."),
  languages: sk("ok", "Understands widely, writes plainly."),
  instruct: sk("ok", "Simple formats hold; complex constraint stacks do not."),
  factual: sk("weak", "The cheapest tiers invent the most. Treat every assertion as unverified."),
};

const CODEX_SKILLS: CoreSkills = {
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
  frontend: sk(
    "ok",
    "A coding harness rather than a design surface: it will build the page you specify and will not improve on your specification.",
  ),
  data: sk(
    "strong",
    "Excellent at the SQL and the script around the data; it is the harness that makes this practical, not a separate ability.",
  ),
  maths: sk("ok", "Enough to write correct numeric code. Not a reasoner."),
  science: sk("ok", "Domain knowledge is incidental here; the value is the implementation."),
  languages: sk(
    "weak",
    "Built for code, and it shows the moment the output is prose in another language.",
  ),
  instruct: sk("strong", "Very literal, which is exactly what this column rewards."),
  factual: sk(
    "ok",
    "Confident about APIs that do not exist — the classic failure mode of a coding-tuned tier.",
  ),
};

const LEGACY_OAI_SKILLS: CoreSkills = {
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
  frontend: sk("ok", "Superseded generation; graded for comparison, not for routing."),
  data: sk("ok", "Adequate for the era it shipped in."),
  maths: sk("ok", "Below every current tier on this board."),
  science: sk("ok", "Recall of a training set that is now well out of date."),
  languages: sk("ok", "Broad but dated coverage."),
  instruct: sk("ok", "Predates the constraint-following work the current tiers were trained on."),
  factual: sk("ok", "Older cut-off, looser abstention. The weakest combination in this column."),
};

const GROK_SKILLS: CoreSkills = {
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
  frontend: sk(
    "strong",
    "WebDev Arena 1632 Elo on the 2026-09-22 board (grok-4.7-xhigh) — mid-frontier.",
  ),
  data: sk(
    "ok",
    "Competent on a table; the live-data access is the reason to route here, not the analysis.",
  ),
  maths: sk("strong", "Genuinely strong on competition-style problems."),
  science: sk("strong", "Good on physics in particular; the family leans that way."),
  languages: sk("ok", "English-first. Adequate elsewhere, not a reason to choose it."),
  instruct: sk(
    "top",
    "Artificial Analysis's IFBench page puts Grok 4.3 (medium) first at 83.3%. The board bunches inside three points, so read this as 'nothing follows a format better', not as a wide lead.",
  ),
  factual: sk(
    "strong",
    "Knows a lot and will say so; the abstention discipline is weaker than Anthropic's, which is the trade this column exists to surface.",
  ),
};

const GEMINI_FLASH_SKILLS: CoreSkills = {
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
  frontend: sk(
    "ok",
    "WebDev Arena 1595 Elo (gemini-3.7-flash-high) — twentieth on the 2026-09-22 board, the cheapest entry in that group.",
  ),
  data: sk("ok", "Fast enough to sweep a large sheet; not the tier that draws the conclusion."),
  maths: sk("ok", "Arithmetic and applied maths only."),
  science: sk("ok", "Recall-level science."),
  languages: sk(
    "strong",
    "Google's multilingual coverage is the broadest on this board, and it survives into the flash tier.",
  ),
  instruct: sk(
    "ok",
    "Holds a format well enough for bulk work; drops constraints under a long stack.",
  ),
  factual: sk("ok", "Cheap and quick, which in this column means verify it."),
};

const GEMINI_PRO_SKILLS: CoreSkills = {
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
  frontend: sk(
    "strong",
    "No pro row on the 2026-09-22 WebDev board; graded up from gemini-3.7-flash-high's 1595 Elo plus the family's multimodal advantage on a visual surface.",
  ),
  data: sk(
    "strong",
    "Reads a large sheet and a chart of it in the same turn — the multimodal path is a real advantage in this column.",
  ),
  maths: sk("strong", "Strong applied maths; a tier below the proof specialists."),
  science: sk("strong", "Broad and current scientific coverage."),
  languages: sk(
    "top",
    "The widest language coverage on this board, and the strongest on languages outside the major European set.",
  ),
  instruct: sk("strong", "Reliable with an explicit schema."),
  factual: sk(
    "strong",
    "Search grounding shores up the recall; the underlying abstention is mid-pack.",
  ),
};

const KIMI_SKILLS: CoreSkills = {
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
  frontend: sk(
    "strong",
    "WebDev Arena 1658 Elo (kimi-k3-max), seventh on the 2026-09-22 board and the strongest showing of any open-weight family.",
  ),
  data: sk("strong", "Careful on structured input, which is consistent with its agentic strength."),
  maths: sk("strong", "Good across competition-style work."),
  science: sk("strong", "Solid, if below the US flagships on graduate questions."),
  languages: sk(
    "strong",
    "Excellent Chinese, capable English; European languages are the weaker side.",
  ),
  instruct: sk("strong", "Tool-call discipline is its strength, and that is most of this column."),
  factual: sk("ok", "Broad recall, mid-pack abstention."),
};

const DEEPSEEK_SKILLS: CoreSkills = {
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
  frontend: sk(
    "strong",
    "WebDev Arena 1616 Elo (deepseek-v4.1-flash-max) on the 2026-09-22 board — remarkable for a flash tier at this price.",
  ),
  data: sk(
    "strong",
    "Strong on SQL and numeric transformation; the cheapest credible option in this column.",
  ),
  maths: sk(
    "top",
    "The family's signature. Competition-grade maths at a fraction of the frontier's price.",
  ),
  science: sk("strong", "Strong reasoning, thinner factual coverage than the US flagships."),
  languages: sk("strong", "Chinese and English are both strong; other languages are uneven."),
  instruct: sk(
    "ok",
    "Occasionally answers the question it thinks you meant, which is exactly what this column penalises.",
  ),
  factual: sk(
    "ok",
    "Strong reasoning does not imply strong recall — and this row scores 19% on the China-politics benchmark, which is a knowledge gate rather than a knowledge gap.",
  ),
};

const GLM_SKILLS: CoreSkills = {
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
  frontend: sk("strong", "WebDev Arena 1620 Elo (glm-5.3-max) on the 2026-09-22 board."),
  data: sk("strong", "Capable and very cheap on ordinary table work."),
  maths: sk("ok", "Adequate; the Chinese labs' maths leader is DeepSeek, not this one."),
  science: sk("ok", "Recall-level on graduate science."),
  languages: sk("strong", "Strong Chinese and English."),
  instruct: sk("ok", "Format adherence is the weak side of this family."),
  factual: sk(
    "ok",
    "Mid-pack recall. Note the hosted endpoint answers fewer China-politics questions than the local weights — a retrieval difference that is about policy, not ability.",
  ),
};

const QWEN_SKILLS: CoreSkills = {
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
  frontend: sk(
    "strong",
    "WebDev Arena 1671 Elo (qwen3.8-max), fourth on the 2026-09-22 board — the best non-US result and ahead of Opus 5's own tier below it.",
  ),
  data: sk("strong", "Strong structured-data handling across the family."),
  maths: sk("strong", "Consistently good, without DeepSeek's specialisation."),
  science: sk("strong", "Broad coverage, competitive with the US mid-tiers."),
  languages: sk(
    "top",
    "Tops BenchLM's multilingual board (September 2026, Qwen 3.7 Max). The widest genuinely-multilingual training of any family here.",
  ),
  instruct: sk(
    "top",
    "IFBench 82.8%, second on BenchLM's 2026-09-17 snapshot and inside 2.2 points of the leader. The best-evidenced format-follower on this board.",
  ),
  factual: sk("ok", "Wide recall, mid abstention."),
};

// ── Shared topic maps. Same data, one source — not an abstraction, a dedupe. ──

const ABSOLUTE_CSAM: TopicCell = {
  v: "hard",
  tip: "Absolute in every lab tested, US and Chinese alike. The only category with no framing, no jurisdiction and no jailbreak framing that is treated as legitimate.",
};

const ANTHROPIC_TOPICS: Record<TopicKey, TopicCell> = {
  weapons: {
    v: "hard",
    tip: '"Do Not Develop or Design Weapons" is its own clause, separate from the CBRN one (anthropic.com/legal/aup, effective 15 Sep 2025). Printable firearm files and full-auto conversions are refused; ballistics, hunting and gun-policy argument are not.',
  },
  selfharm: {
    v: "soft",
    tip: 'Not a flat block. The policy bars content that would "facilitate, promote, or glamorize any form of suicide or self-harm, including disordered eating" (anthropic.com/legal/aup, effective 15 Sep 2025) — which leaves discussion, grief, research and harm-reduction open. JUDGED: no published eval isolates this column per model.',
  },
  hate: {
    v: "hard",
    tip: '"Do Not Incite Violence or Hateful Behavior" names violent extremism, terrorism and promoting discriminatory practices (anthropic.com/legal/aup, effective 15 Sep 2025). Producing the content is refused; analysing it, quoting it in research, or writing a bigoted character in fiction generally is not.',
  },
  violence: {
    v: "soft",
    tip: "Graphic violence and gore sit under the psychological-harm clause rather than an outright ban (anthropic.com/legal/aup, effective 15 Sep 2025), so fiction usually passes and gore for its own sake does not. The commonest over-refusal complaint against Claude. JUDGED — no published gore-specific measurement.",
  },
  privacy: {
    v: "hard",
    tip: 'Two separate clauses, not one: "Do Not Compromise Privacy or Identity Rights" names facial recognition and soliciting non-public contact details, and the law-enforcement clause names facial recognition and predictive policing again (anthropic.com/legal/aup, effective 15 Sep 2025).',
  },
  copyright: {
    v: "hard",
    tip: "IP infringement is named under the illegal-activity clause (anthropic.com/legal/aup, effective 15 Sep 2025), and verbatim song lyrics and long book passages are declined in practice. Summary, quotation for criticism and style pastiche are answered.",
  },
  advice: {
    v: "soft",
    tip: 'Legal, healthcare, insurance and finance are listed as HIGH-RISK use cases, not prohibited ones (anthropic.com/legal/aup, effective 15 Sep 2025) — permitted with a qualified human in the loop and disclosure that the user is talking to an AI. You get the substance plus a "see a professional" line. SORRY-Bench files this area as its fourth domain, "Potentially Unqualified Advice" (arXiv:2406.14598).',
  },
  hotbutton: {
    v: "soft",
    tip: "Answers on abortion, gender, race, immigration and religion but declines to pick a side on contested value questions — even-handedness rather than silence. SpeechMap.ai puts Anthropic's lab average at 67.7% completion on its free-speech set (speechmap.ai, 17 Sep 2026), fractionally under GPT-6 Astra.",
  },
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
  weapons: {
    v: "hard",
    tip: '"Don\'t provide information hazards" is a ROOT-level rule in the Model Spec (model-spec.openai.com, 27 Oct 2025) and covers weapons instructions alongside CBRN; the usage policies name weapons development separately. Dual-use information with a legitimate purpose is explicitly carved out.',
  },
  selfharm: {
    v: "soft",
    tip: 'Two rules pulling in opposite directions, deliberately: "Do not encourage self-harm, delusions, or mania" is ROOT-level, while "Support users in mental health discussions" is USER-level (model-spec.openai.com, 27 Oct 2025). The spec asks for engagement rather than deflection, and switches to crisis resources on imminent-risk phrasing.',
  },
  hate: {
    v: "hard",
    tip: '"Avoid hateful content directed at protected groups" and "do not contribute to extremist agendas that promote violence" are both ROOT-level rules covering dehumanising language and terrorist recruitment (model-spec.openai.com, 27 Oct 2025).',
  },
  violence: {
    v: "soft",
    tip: '"Don\'t respond with erotica or gore" is a SYSTEM-level rule, not a root-level one (model-spec.openai.com, 27 Oct 2025) — the distinction is load-bearing: a developer system message can legitimately relax it, which is exactly what root-level rules forbid for CSAM or CBRN.',
  },
  privacy: {
    v: "hard",
    tip: '"Protect people\'s privacy" is ROOT-level and covers sensitive personal data (model-spec.openai.com, 27 Oct 2025); the usage policies separately name facial recognition and biometric identification of private individuals.',
  },
  copyright: {
    v: "hard",
    tip: '"Respect creators and their rights" is ROOT-level and the spec names song lyrics explicitly (model-spec.openai.com, 27 Oct 2025). Verbatim lyrics and long book passages are declined; summary, criticism and pastiche are not.',
  },
  advice: {
    v: "soft",
    tip: "Tailored medical, legal and financial answers are given with a professional-review caveat rather than refused. SORRY-Bench's fourth domain is \"Potentially Unqualified Advice\" (arXiv:2406.14598), but it publishes no row for the models in this table — so the grade is JUDGED from the spec's stance, not measured.",
  },
  hotbutton: {
    v: "soft",
    tip: 'The root-level rule is "don\'t facilitate the targeted manipulation of political views" (model-spec.openai.com, 27 Oct 2025) — it bars DEMOGRAPHIC TARGETING, not discussing the issue. SpeechMap.ai scored GPT-6 Astra at 68.2% completion on its free-speech set (speechmap.ai, 17 Sep 2026), the highest of the US frontier labs it tracks.',
  },
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
    v: "hard",
    tip: 'CORRECTED — this cell previously read "relaxed for age-verified adults", which is no longer true. OpenAI shipped age verification in January 2026 but PAUSED the promised adult mode indefinitely on 26 March 2026 after internal and investor objections, and has announced no new timeline. The default surface refuses. The Model Spec still keeps "don\'t respond with erotica or gore" at SYSTEM rather than root level (model-spec.openai.com, 27 Oct 2025), so the spec leaves a door the product has not walked through.',
  },
};

const GOOGLE_TOPICS: Record<TopicKey, TopicCell> = {
  weapons: {
    v: "hard",
    tip: "Instructions for illegal goods and weapons are a named prohibited use (policies.google.com/terms/generative-ai/use-policy, effective 17 Dec 2024).",
  },
  selfharm: {
    v: "hard",
    tip: '"Facilitates self-harm" is a named prohibited use (policies.google.com/terms/generative-ai/use-policy, effective 17 Dec 2024). Gemini is the quickest of the US models to convert a self-harm conversation into crisis-line boilerplate, which is a safety choice with a real cost to the person asking. JUDGED — no published per-model eval for this column.',
  },
  hate: {
    v: "hard",
    tip: '"Hatred or hate speech" and "harassment, bullying, intimidation, abuse" are named prohibited uses, as is facilitating violent extremism or terrorism (policies.google.com/terms/generative-ai/use-policy, effective 17 Dec 2024).',
  },
  violence: {
    v: "soft",
    tip: '"Violence or the incitement of violence" is prohibited, but the policy carries an explicit exception for educational, documentary, scientific or artistic purposes (policies.google.com/terms/generative-ai/use-policy, effective 17 Dec 2024) — that clause is what lets fiction through.',
  },
  privacy: {
    v: "hard",
    tip: 'The policy names privacy violations and, separately, anything that "tracks or monitors people without their consent" (policies.google.com/terms/generative-ai/use-policy, effective 17 Dec 2024).',
  },
  copyright: {
    v: "hard",
    tip: "Intellectual-property violation is a named prohibited use (policies.google.com/terms/generative-ai/use-policy, effective 17 Dec 2024).",
  },
  advice: {
    v: "soft",
    tip: "Two clauses bite here: automated decisions with material detrimental impact are barred in high-risk domains (employment, healthcare, finance, legal, housing, insurance, social welfare), and so are false claims of expertise in health, finance, government or law (policies.google.com/terms/generative-ai/use-policy, effective 17 Dec 2024). You get an answer wrapped in more hedging than any US peer. JUDGED on policy text.",
  },
  hotbutton: {
    v: "soft",
    tip: "Answers, but hedges hardest of the US camp — the same instinct that led Google to restrict election queries outright rather than answer them carefully. JUDGED: SpeechMap.ai tracks this axis (speechmap.ai, 17 Sep 2026) but no Gemini 3.8 Flash row is cited here.",
  },
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
  weapons: {
    v: "soft",
    tip: "xAI's Acceptable Use Policy names weapons of mass destruction (x.ai/legal/acceptable-use-policy) but does NOT call out conventional firearms the way Anthropic's and Meta's policies do. Engages with gunsmithing and ballistics questions the other US labs decline. JUDGED — the gap is in the policy text; no published per-model measurement.",
  },
  selfharm: {
    v: "soft",
    tip: 'Discusses suicide, self-harm and eating disorders far more frankly than any other US frontier model. That is the same property that makes it the one with the least safety margin in this column, and the AUP\'s "critical harm to human life" clause is the only written constraint. JUDGED — no published per-model eval.',
  },
  hate: {
    v: "soft",
    tip: "The loosest of the US camp, and the one with a documented failure record rather than a theoretical risk: Grok's public deployments have repeatedly emitted antisemitic and extremist output requiring emergency patches. The policy bars it; the training holds it weakly.",
  },
  violence: {
    v: "open",
    tip: "Gore and graphic violence in fiction go through where Claude and Gemini decline. A deliberate product position rather than an oversight — the same one behind the adult surface.",
  },
  privacy: {
    v: "soft",
    tip: "The weakest privacy line of the US labs, and documented rather than inferred: xAI's image tools generated non-consensual intimate deepfakes at scale into January 2026 and the company was widely reported as declining to rein it in, before stricter pre-moderation was added and then loosened again through March 2026 to cut over-flagging.",
  },
  copyright: {
    v: "soft",
    tip: "IP violation is named in the AUP (x.ai/legal/acceptable-use-policy), but there is no protected-material filter of the Microsoft kind and less trained reluctance on verbatim lyrics than OpenAI or Anthropic. JUDGED — no published measurement.",
  },
  advice: {
    v: "open",
    tip: "Gives direct medical, legal and financial answers with minimal hedging. Simultaneously the most useful thing about it for an ordinary user and the most likely to be confidently wrong, because the hedge other labs add is also a warning. JUDGED — no per-model eval.",
  },
  hotbutton: {
    v: "open",
    tip: "The axis xAI actually markets. Answers contested political questions with little hedging where Claude and Gemini return an even-handed non-answer. SpeechMap.ai's free-speech index is where this shows up as a number rather than a claim (speechmap.ai, 17 Sep 2026).",
  },
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
  adult: {
    v: "open",
    tip: "The only US frontier lab shipping an adult surface — with a caveat added after this table first claimed otherwise: xAI's 6 July 2026 FAQ states that turning NSFW on does NOT turn moderation off. Mature themes at roughly R-rated-film level in fiction; CSAM and non-consensual intimate imagery stay barred, and paying or using the API buys no exception.",
  },
};

const KIMI_TOPICS: Record<TopicKey, TopicCell> = {
  weapons: {
    v: "soft",
    tip: "Conventional firearms are not a named TC260 risk class of their own; the constraint arrives through A.1(h) other content prohibited by law, and Chinese firearms law is strict enough that the model has little permissive training data. Refuses the direct build ask. JUDGED — no published per-model eval.",
  },
  selfharm: {
    v: "soft",
    tip: "A.4(a) endangerment of the physical or mental health of another is a named risk (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024), and A.5 names psychological counselling as a higher-risk service type. Engages rather than deflecting to a hotline, with markedly less crisis-protocol training than the US labs. JUDGED.",
  },
  hate: {
    v: "hard",
    tip: "The firmest non-CBRN Chinese refusal, and it is statutory rather than cultural: A.1(d) promotion of terrorism or extremism and A.1(e) promotion of ethnic hatred are must-refuse risks, and the whole of A.2 lists nine kinds of banned discrimination — ethnicity, belief, nationality, region, gender, age, occupation, health (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024). Compliance testing requires at least 50 test questions per A.1/A.2 risk, versus 20 elsewhere. Moonshot's own record is the strong case for taking this seriously rather than as boilerplate.",
  },
  violence: {
    v: "soft",
    tip: "A.1(f) bars promotion of violence and obscenity (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024), but the standard targets glorification rather than depiction, so violent fiction largely passes. JUDGED — no published gore-specific measurement for this family.",
  },
  privacy: {
    v: "soft",
    tip: "A.4 makes this a rights question, not a safety one: (b) unauthorised use of another's likeness, (e) infringement of the right to privacy, (f) infringement of personal information rights (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024). Written down firmly, enforced through the service filing rather than in the weights. JUDGED for model behaviour.",
  },
  copyright: {
    v: "soft",
    tip: "A.3(a) infringement of others' IPR and A.3(c) disclosure of trade secrets are named commercial-violation risks (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024). No protected-material output filter of the Microsoft kind sits on the endpoint, so verbatim reproduction is likelier here than on Copilot. JUDGED.",
  },
  advice: {
    v: "soft",
    tip: "Explicitly regulated, which is the surprise: A.5 singles out service types with higher safety needs — automatic control, MEDICAL INFORMATION SERVICES, PSYCHOLOGICAL COUNSELLING and critical information infrastructure — and treats both grossly inaccurate content and merely unhelpful content as safety risks (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024). The result is substance with a disclaimer rather than a refusal. JUDGED.",
  },
  hotbutton: {
    v: "open",
    tip: "The mirror of CN POLITICS, and the reason both columns exist. Abortion, gender, race, immigration and Israel–Palestine carry no Chinese regulatory trigger, so these models answer contested WESTERN politics more readily than the US labs do. JUDGED — SpeechMap.ai measures the axis (speechmap.ai, 17 Sep 2026) but no row for this model is cited here.",
  },
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
  weapons: {
    v: "soft",
    tip: "Refuses the direct ask and then yields to reframing, consistent with the family's overall pattern: safety evaluations in Chinese contexts put DeepSeek's refusal rate on risky requests at roughly 60–68%, the weakest of the Chinese families tested.",
  },
  selfharm: {
    v: "soft",
    tip: "A.4(a) endangerment of another's physical or mental health is a named risk (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024), but this is the family whose refusals hold least firmly under pressure, and that applies here as elsewhere. JUDGED for this specific column — the 60–68% figure is family-wide, not self-harm-specific.",
  },
  hate: {
    v: "hard",
    tip: "The firmest non-CBRN Chinese refusal, and it is statutory rather than cultural: A.1(d) promotion of terrorism or extremism and A.1(e) promotion of ethnic hatred are must-refuse risks, and the whole of A.2 lists nine kinds of banned discrimination — ethnicity, belief, nationality, region, gender, age, occupation, health (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024). Compliance testing requires at least 50 test questions per A.1/A.2 risk, versus 20 elsewhere.",
  },
  violence: {
    v: "soft",
    tip: "A.1(f) bars promotion of violence and obscenity (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024), but the standard targets glorification rather than depiction, so violent fiction largely passes. JUDGED — no published gore-specific measurement for this family.",
  },
  privacy: {
    v: "soft",
    tip: "A.4 makes this a rights question, not a safety one: (b) unauthorised use of another's likeness, (e) infringement of the right to privacy, (f) infringement of personal information rights (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024). Written down firmly, enforced through the service filing rather than in the weights. JUDGED for model behaviour. DeepSeek is also the family under active CAC scrutiny: regulators summoned seven named firms after Anthropic's report and narrowed the probe to DeepSeek and Moonshot.",
  },
  copyright: {
    v: "soft",
    tip: "A.3(a) infringement of others' IPR and A.3(c) disclosure of trade secrets are named commercial-violation risks (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024). No protected-material output filter of the Microsoft kind sits on the endpoint, so verbatim reproduction is likelier here than on Copilot. JUDGED.",
  },
  advice: {
    v: "soft",
    tip: "Explicitly regulated, which is the surprise: A.5 singles out service types with higher safety needs — automatic control, MEDICAL INFORMATION SERVICES, PSYCHOLOGICAL COUNSELLING and critical information infrastructure — and treats both grossly inaccurate content and merely unhelpful content as safety risks (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024). The result is substance with a disclaimer rather than a refusal. JUDGED.",
  },
  hotbutton: {
    v: "open",
    tip: "The mirror of CN POLITICS, and the reason both columns exist. Abortion, gender, race, immigration and Israel–Palestine carry no Chinese regulatory trigger, so these models answer contested WESTERN politics more readily than the US labs do. JUDGED — SpeechMap.ai measures the axis (speechmap.ai, 17 Sep 2026) but no row for this model is cited here.",
  },
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
  weapons: {
    v: "soft",
    tip: "Refuses the direct ask, with the same caveat as every other GLM guardrail: GLM-5.2 scored 46.58 on CASI (Jul 2026), the most jailbreakable frontier model measured that month against Claude Sonnet 5's 93.08.",
  },
  selfharm: {
    v: "soft",
    tip: "A.4(a) physical or mental health and A.5 psychological counselling both apply (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024), but the CASI result means the refusal is thin here as everywhere in this family. JUDGED for the column; the 46.58 figure is family-wide.",
  },
  hate: {
    v: "hard",
    tip: "The firmest non-CBRN Chinese refusal, and it is statutory rather than cultural: A.1(d) promotion of terrorism or extremism and A.1(e) promotion of ethnic hatred are must-refuse risks, and the whole of A.2 lists nine kinds of banned discrimination — ethnicity, belief, nationality, region, gender, age, occupation, health (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024). Compliance testing requires at least 50 test questions per A.1/A.2 risk, versus 20 elsewhere.",
  },
  violence: {
    v: "soft",
    tip: "A.1(f) bars promotion of violence and obscenity (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024), but the standard targets glorification rather than depiction, so violent fiction largely passes. JUDGED — no published gore-specific measurement for this family.",
  },
  privacy: {
    v: "soft",
    tip: "A.4 makes this a rights question, not a safety one: (b) unauthorised use of another's likeness, (e) infringement of the right to privacy, (f) infringement of personal information rights (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024). Written down firmly, enforced through the service filing rather than in the weights. JUDGED for model behaviour. Zhipu was among the seven firms the CAC summoned for questioning in 2026.",
  },
  copyright: {
    v: "soft",
    tip: "A.3(a) infringement of others' IPR and A.3(c) disclosure of trade secrets are named commercial-violation risks (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024). No protected-material output filter of the Microsoft kind sits on the endpoint, so verbatim reproduction is likelier here than on Copilot. JUDGED. Expect the endpoint/weights split that governs the rest of this row to apply here too.",
  },
  advice: {
    v: "soft",
    tip: "Explicitly regulated, which is the surprise: A.5 singles out service types with higher safety needs — automatic control, MEDICAL INFORMATION SERVICES, PSYCHOLOGICAL COUNSELLING and critical information infrastructure — and treats both grossly inaccurate content and merely unhelpful content as safety risks (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024). The result is substance with a disclaimer rather than a refusal. JUDGED.",
  },
  hotbutton: {
    v: "open",
    tip: "The mirror of CN POLITICS, and the reason both columns exist. Abortion, gender, race, immigration and Israel–Palestine carry no Chinese regulatory trigger, so these models answer contested WESTERN politics more readily than the US labs do. JUDGED — SpeechMap.ai measures the axis (speechmap.ai, 17 Sep 2026) but no row for this model is cited here.",
  },
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
  weapons: {
    v: "hard",
    tip: "The strictest Chinese family on criminal content holds this line too: Qwen leads the Chinese models on CASI jailbreak resilience at 81.13 (Jul 2026) and scores highest of them on refusing risky requests.",
  },
  selfharm: {
    v: "soft",
    tip: "A.4(a) physical or mental health and A.5 psychological counselling apply (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024), and Qwen's refusals hold better under pressure than its peers' (CASI 81.13, Jul 2026). Still engages rather than deflecting. JUDGED for this column specifically.",
  },
  hate: {
    v: "hard",
    tip: "The firmest non-CBRN Chinese refusal, and it is statutory rather than cultural: A.1(d) promotion of terrorism or extremism and A.1(e) promotion of ethnic hatred are must-refuse risks, and the whole of A.2 lists nine kinds of banned discrimination — ethnicity, belief, nationality, region, gender, age, occupation, health (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024). Compliance testing requires at least 50 test questions per A.1/A.2 risk, versus 20 elsewhere. Qwen holds it more firmly than its peers (CASI 81.13, Jul 2026).",
  },
  violence: {
    v: "soft",
    tip: "A.1(f) bars promotion of violence and obscenity (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024), but the standard targets glorification rather than depiction, so violent fiction largely passes. JUDGED — no published gore-specific measurement for this family.",
  },
  privacy: {
    v: "soft",
    tip: "A.4 makes this a rights question, not a safety one: (b) unauthorised use of another's likeness, (e) infringement of the right to privacy, (f) infringement of personal information rights (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024). Written down firmly, enforced through the service filing rather than in the weights. JUDGED for model behaviour. Alibaba was among the seven firms the CAC summoned for questioning in 2026.",
  },
  copyright: {
    v: "soft",
    tip: "A.3(a) infringement of others' IPR and A.3(c) disclosure of trade secrets are named commercial-violation risks (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024). No protected-material output filter of the Microsoft kind sits on the endpoint, so verbatim reproduction is likelier here than on Copilot. JUDGED.",
  },
  advice: {
    v: "soft",
    tip: "Explicitly regulated, which is the surprise: A.5 singles out service types with higher safety needs — automatic control, MEDICAL INFORMATION SERVICES, PSYCHOLOGICAL COUNSELLING and critical information infrastructure — and treats both grossly inaccurate content and merely unhelpful content as safety risks (TC260-003 Basic Security Requirements for Generative AI Services, 29 Feb 2024). The result is substance with a disclaimer rather than a refusal. JUDGED.",
  },
  hotbutton: {
    v: "open",
    tip: "The mirror of CN POLITICS, and the reason both columns exist. Abortion, gender, race, immigration and Israel–Palestine carry no Chinese regulatory trigger, so these models answer contested WESTERN politics more readily than the US labs do. JUDGED — SpeechMap.ai measures the axis (speechmap.ai, 17 Sep 2026) but no row for this model is cited here.",
  },
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
  violence: {
    v: "open" as const,
    tip: "Dark fiction without the hedge is one of the two things people actually come here for. Nothing at the provider or legal layer blocks depicted violence, so what remains is the base model's own reluctance — which is little.",
  },
  privacy: {
    v: "open" as const,
    tip: "No trained refusal on doxxing, people-search or profiling a named person. Worth being clear that this is the column where the lifted guardrail protects a THIRD PARTY rather than the user, so ○ here is not good news the way it is under MED·LEGAL. Provider terms and the law still govern the account whatever the weights will say.",
  },
  copyright: {
    v: "open" as const,
    tip: "No protected-material output filter exists on self-hosted weights — Microsoft's is a service-layer product, not a model property — so verbatim lyrics and long passages come back if the base memorised them. The ceiling is memorisation, not permission.",
  },
  advice: {
    v: "open" as const,
    tip: "Frank medical, legal and financial talk is one of the genuinely defensible reasons to be on this row: the hedge is what was removed, not the knowledge. The flip side is that the disclaimer other models attach is also a warning, and it is gone.",
  },
  hotbutton: {
    v: "open" as const,
    tip: "Takes a side. Neutral alignment means it will answer a contested political question with an argument instead of an even-handed non-answer — the property Hermes was built for, and the one abliteration is aimed at.",
  },
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

const HERMES_SKILLS: CoreSkills = {
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
  frontend: sk(
    "weak",
    "Llama-3.1 underneath and no board row. Not a surface this checkpoint was built for.",
  ),
  data: sk("weak", "No structured-data tuning; treat a table as prose and it shows."),
  maths: sk("ok", "Base-model maths, which is a generation behind."),
  science: sk(
    "ok",
    "Base-model recall from Llama-3.1; the tune adds nothing here and removes nothing either.",
  ),
  languages: sk("ok", "Llama's multilingual coverage, unchanged by the tune."),
  instruct: sk("weak", "Neutral alignment includes neutrality about your format."),
  factual: sk(
    "weak",
    "No abstention training at all — this checkpoint answers rather than declines, which is its point and its cost.",
  ),
};

const DOLPHIN_SKILLS: CoreSkills = {
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
  frontend: sk("weak", "A 24B Mistral tune. Not this column."),
  data: sk("weak", "No structured-data tuning."),
  maths: sk("ok", "Mistral-Small maths: adequate, no more."),
  science: sk(
    "ok",
    "Base-model recall from Mistral-Small-24B, which is a generation behind this board.",
  ),
  languages: sk("ok", "Mistral's European languages are the better half of this row."),
  instruct: sk("weak", "Uncensored tunes drift off format along with everything else."),
  factual: sk("weak", "Small base, no abstention training. Verify everything."),
};

const ABLITERATED_SKILLS: CoreSkills = {
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
  frontend: sk(
    "weak",
    "27–35B bases with the refusal direction projected out. Nothing here helps build a page.",
  ),
  data: sk("weak", "No structured-data ability the ablation could add."),
  maths: sk("ok", "Whatever the base had; ablation removes a refusal, never adds a skill."),
  science: sk("ok", "Base-model recall, unchanged."),
  languages: sk("weak", "Small bases, and the ablation is derived from English prompt pairs."),
  instruct: sk("weak", "Ablation degrades instruction-following generally, not only the refusals."),
  factual: sk(
    "weak",
    "The worst combination in this column: small base, no abstention, and a technique that makes it likelier to answer anyway.",
  ),
};

const HERMES_TOPICS: Record<TopicKey, TopicCell> = {
  weapons: {
    v: "soft",
    tip: "Meta's Llama Acceptable Use Policy names \"guns and illegal weapons\" (llama.com/use-policy), and Hermes 4 is a Llama-3.1 fine-tune — but Nous did not train a refusal reflex on top, so what holds is the base model's residual reluctance. Discusses gunsmithing; declines the blunt build request.",
  },
  selfharm: {
    v: "soft",
    tip: "Neutral alignment means it discusses suicide, self-harm and disordered eating as subjects rather than as alarms. Hermes 4 405B still declines roughly 43%% of RefusalBench overall (Nous Research), so this is not an absence of refusal — it is a thinner one.",
  },
  hate: {
    v: "soft",
    tip: "Not editorialising is not the same as producing slurs: the Llama base's own reluctance survives, so it will analyse, quote and argue about hate speech far more freely than a frontier model while still resisting writing fresh propaganda. JUDGED — no published per-model eval for this column.",
  },
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
  weapons: {
    v: "soft",
    tip: "Mistral-Small base with the refusal tune removed; declines the direct build ask on whatever reluctance the base retained. JUDGED — no published measurement.",
  },
  selfharm: {
    v: "soft",
    tip: "An explicitly uncensored roleplay tune with no crisis protocol trained in either direction. It will stay in a dark conversation rather than redirect — which is exactly what some users want from it and exactly why it is the wrong tool for someone in danger. JUDGED.",
  },
  hate: {
    v: "soft",
    tip: "Uncensored tune, but 24B of Mistral-Small underneath rather than a hate-trained model: it inhabits an unpleasant character on request and has no separate moderation layer on the endpoint. JUDGED — no published eval.",
  },
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
  weapons: {
    v: "open",
    tip: "Ablation targets the refusal direction, so the decline goes. The same ceiling as explosives applies: these checkpoints are 27–35B bases whose knowledge is unchanged, so what you get past the refusal is the base model's ordinary understanding, not privileged information.",
  },
  selfharm: {
    v: "open",
    tip: "The most dangerous cell on this row, and not because of the content. arXiv:2607.17427 measured abliterated variants across 21,600 decisions as systematically MORE OPTIMISTIC (+12.2pp Gemma, +7.4pp Qwen) and more self-justifying, with stated and enacted uncertainty coming apart. A model with no crisis protocol AND a measured cheerfulness bias is the worst combination in this column.",
  },
  hate: {
    v: "open",
    tip: "The refusal direction removed by ablation is derived from English safety prompt pairs, and hate refusal sits squarely in that direction — unlike Chinese political filtering, which does not and survives. Expect this to lift where CN POLITICS does not.",
  },
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

// ── FAMILIES WITH NO REFUSAL PROFILE YET (2026-09-23) ───────────────────────
// Six catalog families had capability rows or catalog entries but no censorship
// column. They are EXPORTED and currently unreferenced on purpose: the rules list
// is another unit's file, and an exported const compiles while it waits.

// The four newest Chinese families share one base because sharing it is the HONEST
// shape of what is known, not a saving. Nobody has published a per-model refusal
// eval for MiMo, MiniMax, Hunyuan or StepFun — no CASI row, no 168-case politics
// row, no SORRY-Bench row. What IS known applies to all four identically: they are
// CAC-filed services tested against the same TC260-003 question bank. Writing four
// separately worded copies would dress one shared fact up as four independent
// findings. Where a family DOES have its own evidence it overrides below.
//
// The regime itself is worth stating once, because it is the opposite of the
// stereotype in one specific way: TC260-003 §9.4 sets BOTH bounds. Sampling at
// least 300 must-refuse questions, the refusal rate must be ≥95%; sampling at
// least 300 must-ANSWER questions, the refusal rate must be ≤5%. Chinese services
// are regulated against over-refusal as explicitly as against under-refusal.
const CN_FILED_SHARED = {
  csam: ABSOLUTE_CSAM,
  cbrn: {
    v: "hard" as const,
    tip: "Refused. Weapons uplift is prohibited under China's 2023 Interim Measures and sits under TC260-003 A.1(h), other content prohibited by laws and administrative regulations (29 Feb 2024). This is one of the Chinese refusals that holds firmly across every family measured.",
  },
  weapons: {
    v: "soft" as const,
    tip: "Not its own TC260 risk class; the constraint arrives via A.1(h) other content prohibited by law, on top of strict domestic firearms law that leaves little permissive training data. Declines the build ask. JUDGED — no published per-model eval for this family.",
  },
  drugs: {
    v: "soft" as const,
    tip: "Synthesis and trafficking refused under A.1(h) (TC260-003, 29 Feb 2024). JUDGED for firmness — no CASI or refusal-rate row is published for this family, so do not read this as measured.",
  },
  secwork: {
    v: "open" as const,
    tip: "The bloc property that actually matters for defenders: Chinese rules bar BUILDING malware, not READING it, so payload analysis and incident forensics go through as ordinary technical work. Consistent across every Chinese family that has been tested. JUDGED for this specific family — it has not been tested.",
  },
  selfharm: {
    v: "soft" as const,
    tip: "A.4(a) endangerment of the physical or mental health of another is a named risk, and A.5 names psychological counselling as a higher-risk service type (TC260-003, 29 Feb 2024). Engages rather than deflecting, with far less crisis-protocol training than the US labs. JUDGED.",
  },
  hate: {
    v: "hard" as const,
    tip: "Statutory rather than cultural, and the firmest non-CBRN Chinese line: A.1(d) terrorism and extremism, A.1(e) ethnic hatred, and the whole of A.2 — nine banned discrimination types covering ethnicity, belief, nationality, region, gender, age, occupation and health (TC260-003, 29 Feb 2024). Compliance testing requires at least 50 questions per A.1/A.2 risk against 20 elsewhere.",
  },
  violence: {
    v: "soft" as const,
    tip: "A.1(f) bars promotion of violence and obscenity (TC260-003, 29 Feb 2024), but the standard targets glorification rather than depiction, so violent fiction largely passes. JUDGED.",
  },
  privacy: {
    v: "soft" as const,
    tip: "A rights question rather than a safety one: A.4 names unauthorised use of another's likeness (b), infringement of privacy (e) and of personal information rights (f) (TC260-003, 29 Feb 2024). Enforced through the service filing rather than in the weights. JUDGED for model behaviour.",
  },
  copyright: {
    v: "soft" as const,
    tip: "A.3(a) IPR infringement and A.3(c) trade-secret disclosure are named commercial-violation risks (TC260-003, 29 Feb 2024), but no protected-material output filter sits on the endpoint the way Microsoft's does, so verbatim reproduction is likelier here than on Copilot. JUDGED.",
  },
  advice: {
    v: "soft" as const,
    tip: "Explicitly regulated, which is the surprise: A.5 singles out medical information services and psychological counselling as higher-risk service types and treats both grossly inaccurate AND merely unhelpful content as safety risks (TC260-003, 29 Feb 2024). Substance with a disclaimer, not a refusal. JUDGED.",
  },
  elections: {
    v: "open" as const,
    tip: "No electioneering restriction of the US kind — campaigning and political persuasion are a US lab-policy category with no Chinese regulatory counterpart.",
  },
  hotbutton: {
    v: "open" as const,
    tip: "The mirror of CN POLITICS. Abortion, gender, race, immigration and Israel–Palestine carry no Chinese regulatory trigger, so contested WESTERN politics is answered more readily than by the US labs. JUDGED — SpeechMap.ai measures this axis (speechmap.ai, 17 Sep 2026) but publishes no row for this family.",
  },
  adult: {
    v: "soft" as const,
    tip: "A.1(f) names obscenity and pornography directly (TC260-003, 29 Feb 2024), and the hosted endpoint filters accordingly. Where open weights exist the filtering is markedly looser, as with every other Chinese family here. JUDGED.",
  },
};

/** Xiaomi MiMo. The one new Chinese family with a published resilience number. */
export const MIMO_TOPICS: Record<TopicKey, TopicCell> = {
  ...CN_FILED_SHARED,
  explosives: {
    v: "soft",
    tip: "Refuses the direct ask and holds the refusal better than GLM: MiMo-V2.5 scored 73.80 on the CASI jailbreak-resilience index (Jul 2026), between Qwen's 81.13 and GLM-5.2's 46.58, against Claude Sonnet 5's 93.08.",
  },
  malware: {
    v: "soft",
    tip: "Declines outright weaponisation asks with no US-style hard training against the category. CASI 73.80 (Jul 2026) puts its resistance to reframing in the upper half of the Chinese families measured.",
  },
  cnpolitics: {
    v: "soft",
    tip: "JUDGED, and the uncertainty is the point: no 168-case benchmark row has been published for MiMo, and this column is the one where Chinese families differ MOST from each other — Kimi 98.8% versus DeepSeek 19%. Xiaomi is a CAC-filed consumer-device vendor, which argues for filtering, but that is an inference about the company, not a measurement of the model. Do not read this cell as measured.",
  },
};

/** MiniMax. Named in the 2026 CAC summons; no published refusal eval. */
export const MINIMAX_TOPICS: Record<TopicKey, TopicCell> = {
  ...CN_FILED_SHARED,
  explosives: {
    v: "soft",
    tip: "Refuses the direct ask. JUDGED for firmness — MiniMax has no CASI row, so there is no measurement of whether the refusal survives reframing.",
  },
  malware: {
    v: "soft",
    tip: "No hard training against offensive cyber, consistent with every Chinese family measured. JUDGED — no published resilience figure for MiniMax.",
  },
  cnpolitics: {
    v: "soft",
    tip: "JUDGED — no 168-case benchmark row published. One documented data point about the company rather than the model: MiniMax was among the seven firms the CAC summoned for questioning in 2026 after Anthropic's report, a probe that then narrowed to DeepSeek and Moonshot. Regulatory attention is not a censorship measurement.",
  },
};

/** Tencent Hunyuan. Strict licences, large regulated platform, no public eval. */
export const HUNYUAN_TOPICS: Record<TopicKey, TopicCell> = {
  ...CN_FILED_SHARED,
  explosives: {
    v: "soft",
    tip: "Refuses the direct ask. JUDGED — no CASI row for Hunyuan, so firmness under pressure is unmeasured.",
  },
  malware: {
    v: "soft",
    tip: "Declines weaponisation asks; no US-style anti-offensive training. JUDGED — no published resilience figure.",
  },
  cnpolitics: {
    v: "soft",
    tip: "JUDGED — no benchmark row published. Tencent is one of China's largest consumer platforms and ships the family under unusually restrictive licences, which argues for conservative filtering; that is a reasonable inference about the vendor, not a measurement of the model.",
  },
};

/** StepFun. Pivoted to open releases after DeepSeek R1; no public refusal eval. */
export const STEP_TOPICS: Record<TopicKey, TopicCell> = {
  ...CN_FILED_SHARED,
  explosives: {
    v: "soft",
    tip: "Refuses the direct ask. JUDGED — no CASI row for StepFun.",
  },
  malware: {
    v: "soft",
    tip: "No hard anti-offensive training, consistent with the bloc. JUDGED — unmeasured for this family.",
  },
  cnpolitics: {
    v: "soft",
    tip: "JUDGED — no benchmark row published. StepFun began as a closed provider and pivoted to open releases after DeepSeek R1, which matters here only because the GLM result showed the SAME weights censor differently through a hosted API than run locally (95.2% local versus 79.8% hosted). Where you run it may matter more than whose it is.",
  },
};

/**
 * Meta Muse Spark — Llama lineage, governed by Meta's Acceptable Use Policy.
 *
 * The AUP is unusually specific about physical harm and unusually quiet about
 * speech, which is why this family reads strict down the top of the column and
 * loose down the bottom.
 */
export const META_TOPICS: Record<TopicKey, TopicCell> = {
  csam: ABSOLUTE_CSAM,
  cbrn: {
    v: "hard",
    tip: "The AUP names military, warfare, nuclear industries and espionage among activities presenting a risk of death or bodily harm (llama.com/use-policy).",
  },
  explosives: {
    v: "hard",
    tip: "Device construction refused under the same risk-of-death clause that names illegal weapons (llama.com/use-policy).",
  },
  weapons: {
    v: "hard",
    tip: 'Meta is one of only two policies in this table to name conventional firearms outright: "guns and illegal weapons" is listed explicitly (llama.com/use-policy), alongside Anthropic\'s separate weapons clause.',
  },
  drugs: {
    v: "hard",
    tip: '"Illegal drugs and regulated/controlled substances" are named in the AUP (llama.com/use-policy). Pharmacology and harm-reduction are not the target.',
  },
  malware: {
    v: "hard",
    tip: "The AUP names creation or facilitation of malicious code, malware and computer viruses, and anything that could disable or impair a system (llama.com/use-policy).",
  },
  secwork: {
    v: "soft",
    tip: "No verified-defender programme of the Anthropic or OpenAI kind, but also no service-layer moderation on self-hosted weights — so in practice defensive analysis depends on who serves the model rather than on Meta. JUDGED.",
  },
  selfharm: {
    v: "hard",
    tip: '"Self-harm or harm to others" is named in the AUP\'s risk-of-death clause (llama.com/use-policy). Open weights mean the served behaviour depends on the host, but the policy line itself is explicit.',
  },
  hate: {
    v: "soft",
    tip: "The AUP is far more specific about physical harm than about speech, and Llama sits with Grok at the permissive end of SpeechMap's refusal leaderboard. Resists writing fresh propaganda; discusses and analyses freely. JUDGED for this family — no per-model row cited here.",
  },
  violence: {
    v: "soft",
    tip: "Depicted violence in fiction largely passes; the AUP targets real-world harm rather than description. JUDGED.",
  },
  privacy: {
    v: "soft",
    tip: "The AUP covers violating others' rights generally but names no facial-recognition or people-search prohibition of the kind Anthropic, Google and OpenAI each spell out (llama.com/use-policy). A genuine gap in the written policy rather than a judgement about the weights.",
  },
  copyright: {
    v: "soft",
    tip: "Violating others' rights is named, but there is no protected-material output filter on self-hosted weights. Verbatim reproduction is bounded by what the base memorised, not by a filter. JUDGED.",
  },
  advice: {
    v: "soft",
    tip: 'No tailored-advice prohibition in the AUP; the hedging that shows up comes from instruction tuning rather than policy. SORRY-Bench files this area as "Potentially Unqualified Advice" (arXiv:2406.14598). JUDGED — no row cited for this family.',
  },
  elections: {
    v: "soft",
    tip: "The AUP names false online engagement and fake reviews rather than campaigning as such — a materially weaker election line than Anthropic's, OpenAI's or Google's (llama.com/use-policy).",
  },
  hotbutton: {
    v: "open",
    tip: "Answers contested Western political questions with little hedging; Llama sits at the permissive end of SpeechMap's refusal leaderboard alongside Grok. SpeechMap's most permissive lab overall as of 17 Sep 2026 is Mistral at 88.9% completion, against 32.2% for the least (speechmap.ai).",
  },
  cnpolitics: {
    v: "open",
    tip: "US-trained base with no Chinese alignment to remove. Tiananmen, Xinjiang, Tibet and Taiwan are answered directly.",
  },
  adult: {
    v: "hard",
    tip: "The AUP names illegal distribution of obscene materials to minors and failure to employ legally required age-gating (llama.com/use-policy). The hosted surface refuses; community fine-tunes of the same base are the reason the OSS rows below exist.",
  },
};

/**
 * Microsoft 365 Copilot ("Think Deeper") — an OpenAI reasoning model with Azure
 * content filtering stacked on top, inside an enterprise tenant.
 *
 * THE POINT OF THIS ROW: it is the same model family as the GPT rows and a
 * STRICTER row than them, which is the cleanest demonstration in this table that
 * refusal is a SERVICE property and not only a model property. Everything below
 * cites Microsoft's own filter documentation (learn.microsoft.com, Azure/Foundry
 * content filtering, updated 8 Sep 2026): four neural harm classifiers (hate,
 * sexual, violence, self-harm) at four severity levels, plus optional protected
 * material, PII and prompt-shield classifiers. Turning any of it OFF requires an
 * approved Limited Access Review — and those sliders are an AI Foundry feature
 * that the M365 Copilot surface does not expose to tenant admins at all.
 */
export const COPILOT_TOPICS: Record<TopicKey, TopicCell> = {
  csam: ABSOLUTE_CSAM,
  cbrn: {
    v: "hard",
    tip: "Refused by the underlying OpenAI model, and then again by the service. Weapons development is a named OpenAI prohibited use and information hazards are a root-level Model Spec rule (model-spec.openai.com, 27 Oct 2025).",
  },
  explosives: {
    v: "hard",
    tip: "Refused at the model layer, and the Violence classifier independently covers weapons and related entities at the service layer (learn.microsoft.com content filtering, 8 Sep 2026).",
  },
  weapons: {
    v: "hard",
    tip: 'Azure\'s Violence category explicitly "describes weapons, guns, and related entities" and lists Weapons as a subcategory (learn.microsoft.com content filtering, 8 Sep 2026) — so conventional firearms are filtered by severity here even where the base model would answer.',
  },
  drugs: {
    v: "hard",
    tip: "Refused at the model layer under OpenAI's illicit-behaviour rule (model-spec.openai.com, 27 Oct 2025); no separate Azure category, so the model's own line governs.",
  },
  malware: {
    v: "hard",
    tip: "Refused at the model layer, with Prompt Shields additionally screening the request for jailbreak framing before it reaches the model (learn.microsoft.com content filtering, 8 Sep 2026).",
  },
  secwork: {
    v: "hard",
    tip: "STRICTER than OpenAI direct, and the row's headline finding. The same models refused Hugging Face's incident responders in July 2026; OpenAI's Trusted Access for Cyber walks that back for vetted defenders, but that programme is an OpenAI-platform arrangement with no M365 Copilot equivalent — and the tenant cannot relax the Azure filters to compensate. Do not route incident response here.",
  },
  selfharm: {
    v: "hard",
    tip: "A dedicated neural classifier, not a trained disposition: Azure's Self-Harm category covers content about injuring or killing oneself and names Eating Disorders as a subcategory, filtered at four severity levels on BOTH the prompt and the completion (learn.microsoft.com content filtering, 8 Sep 2026). A prompt caught on input returns HTTP 400 rather than a careful answer.",
  },
  hate: {
    v: "hard",
    tip: "Azure's Hate and Fairness classifier covers race, ethnicity, nationality, gender identity and expression, sexual orientation, religion, appearance and body size, disability status, and harassment and bullying (learn.microsoft.com content filtering, 8 Sep 2026). Broader than the model's own rule, and applied to output as well as input.",
  },
  violence: {
    v: "hard",
    tip: "A severity-scored classifier covering physical harm, weapons, bullying and intimidation, terrorism and violent extremism, and stalking (learn.microsoft.com content filtering, 8 Sep 2026). This is the row where a war novel gets blocked mid-stream — streaming completions stop at the first filtered segment.",
  },
  privacy: {
    v: "hard",
    tip: "Two layers: the model's root-level \"protect people's privacy\" rule, plus an optional PII output filter that detects and filters names, addresses, phone numbers, email addresses and government identifiers in completions (learn.microsoft.com content filtering, 8 Sep 2026).",
  },
  copyright: {
    v: "hard",
    tip: 'The single clearest case of a service being stricter than its model, and the named example for this column: Azure\'s Protected Material for Text filter detects known text — "song lyrics, articles, recipes, and selected web content" — in the OUTPUT, and a separate Protected Material for Code filter matches public-repository source. Using the code filter can be REQUIRED for Customer Copyright Commitment coverage (learn.microsoft.com content filtering, 8 Sep 2026). Rights holders can submit their own text for protection.',
  },
  advice: {
    v: "soft",
    tip: "No Azure category covers professional advice, so the underlying OpenAI hedging governs: substance plus a professional-review caveat. Enterprise tenants frequently add their own guardrails on top. JUDGED — tenant configuration is not observable from outside.",
  },
  elections: {
    v: "hard",
    tip: "OpenAI's election-interference prohibition applies, and Microsoft layers its own Responsible AI commitments for electoral content on the Copilot surface. JUDGED for the Microsoft-specific layer — the filter documentation names no elections category.",
  },
  hotbutton: {
    v: "soft",
    tip: "Discussing abortion, gender, race or religion is not itself filtered, but the Hate and Fairness classifier scores content referencing those identity groups for severity, so heated phrasing can trip a filter that a milder wording would clear (learn.microsoft.com content filtering, 8 Sep 2026). An enterprise assistant hedges further by disposition. JUDGED.",
  },
  cnpolitics: {
    v: "open",
    tip: "Answered directly — a US-trained model with no Chinese alignment and no Azure category covering it.",
  },
  adult: {
    v: "hard",
    tip: "Azure's Sexual classifier filters both prompt and completion at four severity levels (learn.microsoft.com content filtering, 8 Sep 2026), on top of a base model whose own adult mode was paused indefinitely on 26 March 2026. There is no age-verified route on this surface.",
  },
};

// ── Families that had NO dossier row before 2026-09-23 ──────────────────────
// Every configured model in openclaw.json now has one. A model in the catalog with no
// rule rendered as a row of "?" — which looks like a missing measurement but was really
// a missing opinion, and the two are not the same admission.

const GPT6_ASTRA_SKILLS: CoreSkills = {
  code: sk(
    "strong",
    "No SWE-bench Verified row on the llm-stats board yet. Graded from the WebDev result and OpenAI's own positioning as the tier for the hardest end-to-end work.",
  ),
  frontend: sk(
    "top",
    "WebDev Arena 1793 Elo — FIRST of 128 models on the 2026-09-22 board, 38 clear of Fable 5.1. The single best-evidenced cell in this column.",
  ),
  agentic: sk(
    "strong",
    "OpenAI positions this tier for complex end-to-end work including computer use; GPT-6 Sol's published Agents' Last Exam result is the one with a number behind it, so the flagship is graded below its own mid-tier here rather than above it on a claim.",
  ),
  data: sk(
    "top",
    "Shares this column's top with Opus 5: the flagship tiers are the ones that read a large table without quietly rounding it.",
  ),
  maths: sk("top", "The current flagship tier for proof-shaped and competition-style work."),
  science: sk("top", "Graduate-science first choice alongside Opus 5 and GPT-6 Sol."),
  reason: sk(
    "strong",
    "Very strong on lateral problems; Opus 5 still edges it on the ARC-AGI shape.",
  ),
  write: sk("strong", "Excellent register. Opus 5 remains the better ear for correspondence."),
  languages: sk(
    "strong",
    "Broad coverage, in the OpenAI house style: even everywhere, best nowhere.",
  ),
  psych: sk(
    "strong",
    "Reads subtext well — the OpenAI tiers are the architect's own comparison point for this column — without quite Opus 5's landing.",
  ),
  instruct: sk(
    "strong",
    "Holds an explicit format reliably; no IFBench row published for this tier.",
  ),
  context: sk(
    "strong",
    "1.05M-token window, 922K of it input. Recall late in a long run is good, not class-leading.",
  ),
  vision: sk("strong", "Reads screenshots, documents and diagrams competently."),
  factual: sk(
    "strong",
    "AA-Omniscience Index 44 (high effort) — second of the rows AA publishes, behind Opus 5.5 at 46.",
  ),
  world: sk(
    "ok",
    "No live firehose of its own; current-events answers depend on whatever grounding the surface supplies.",
  ),
  speed: sk("ok", "A flagship reasoning tier: correctness first, latency second."),
  cost: sk("weak", "Flagship pricing. Justified when a cheaper tier would need several attempts."),
};

const GPT6_SOL_SKILLS: CoreSkills = {
  code: sk(
    "strong",
    "OpenAI reports roughly half the mistakes of GPT-5.6 Sol; no independent SWE-bench row yet.",
  ),
  frontend: sk(
    "strong",
    "No GPT-6 Sol row on the 2026-09-22 WebDev board; graded between its own predecessor at 1617 Elo and Astra at 1793.",
  ),
  agentic: sk(
    "top",
    "Agents' Last Exam 56.4% at max effort over 55 sub-industries — ahead of Claude Opus 5's best recorded score on that evaluation at 60% lower cost per task. The best-evidenced agentic cell on this board.",
  ),
  data: sk(
    "strong",
    "Strong analytical read of a table at a price that makes iterating on it affordable.",
  ),
  maths: sk(
    "strong",
    "Delivers 90–95% of Astra's practical capability; the gap shows on the hardest proofs.",
  ),
  science: sk("strong", "Graduate-level work at a fifth of the flagship's cost per task."),
  reason: sk("strong", "Strong lateral reasoning for a mid-tier."),
  write: sk("strong", "Clean, well-judged prose — the everyday drafting tier of this family."),
  languages: sk("strong", "The family's usual broad, even coverage."),
  psych: sk("strong", "Reads people well; the tier most likely to be routed here on cost grounds."),
  instruct: sk("strong", "Reliable with an explicit format."),
  context: sk("strong", "1.05M-token window, 922K input, 128K max output."),
  vision: sk("strong", "Full multimodal input at the mid-tier price."),
  factual: sk("strong", "No published AA-Omniscience row; graded on family behaviour."),
  world: sk("ok", "Same as the flagship: no live source of its own."),
  speed: sk(
    "strong",
    "Built for everyday work rather than for the hardest problem, and priced and paced accordingly.",
  ),
  cost: sk(
    "strong",
    "$2 in / $10 out per million — half the previous generation, for most of the flagship's capability.",
  ),
};

const GPT6_LUNA_SKILLS: CoreSkills = {
  code: sk(
    "ok",
    "Budget tier. Matches prior-generation flagships on easy work and not on hard work.",
  ),
  frontend: sk("weak", "No board row, and not the tier a page should be built by."),
  agentic: sk("ok", "Short tool chains only; it loses the plot on a long run."),
  data: sk("ok", "Bulk transformation of a table rather than analysis of it."),
  maths: sk("ok", "Arithmetic and simple algebra."),
  science: sk(
    "ok",
    "Recall level — it will answer a graduate question fluently and without checking itself.",
  ),
  reason: sk("ok", "Adequate; not a tier to escalate to."),
  write: sk("ok", "Serviceable prose at volume."),
  languages: sk("ok", "Understands widely, writes plainly."),
  psych: sk("ok", "Polite rather than perceptive."),
  instruct: sk("ok", "Simple formats hold; long constraint stacks do not."),
  context: sk(
    "strong",
    "The same 1.05M-token window as its flagship siblings — the standout feature of this tier.",
  ),
  vision: sk("ok", "Multimodal input at budget quality."),
  factual: sk("ok", "The cheap tiers abstain least. Verify anything load-bearing."),
  world: sk("ok", "No live source of its own."),
  speed: sk("top", "Optimised for fast responses and high volume — the point of this tier."),
  cost: sk(
    "top",
    "$0.10 in / $0.50 out per million, down from $0.20/$1.20. Prior-generation flagship capability at roughly a tenth of the price.",
  ),
};

const MUSE_SKILLS: CoreSkills = {
  code: sk(
    "strong",
    "DeepSWE v1.1 75.4%, ahead of Opus 5 at 74.0% and GPT-5.6 Sol at 73.0%, and tied with GPT-5.6 Sol at 88.8% on Terminal-Bench 2.1.",
  ),
  frontend: sk(
    "strong",
    "WebDev Arena 1657 Elo (muse-spark-1.3-max), eighth on the 2026-09-22 board.",
  ),
  agentic: sk(
    "strong",
    "Completes engineering comparisons with about 20% fewer tool calls and 25% fewer tokens than Muse Spark 1.2 — but Opus 5 at max leads it on GDPval-AA v2, JobBench and AutomationBench, which is why this is not a ★.",
  ),
  data: sk("strong", "Strong structured reasoning; no published table-work benchmark."),
  maths: sk("strong", "Frontier-adjacent across the standard maths boards."),
  science: sk("strong", "Strong, without a published graduate-science lead."),
  reason: sk("strong", "Consistent with its position at #6 on the AA Intelligence Index."),
  write: sk("strong", "Capable prose; not the column Meta optimised."),
  languages: sk(
    "strong",
    "Meta has trained multilingually since the Llama line; coverage is broad.",
  ),
  psych: sk("ok", "Competent but flat on genuinely difficult human conversations."),
  instruct: sk(
    "ok",
    "Meta's own launch comparison puts Claude Opus 5 ahead of it on the Agentic IF Index — the one head-to-head published on this question, and it does not favour this row.",
  ),
  context: sk(
    "top",
    "98.5% and 98.1% on the two MRCR long-context bands, a near-total lead over everything else measured. If the task is a very long input, this is the first choice on the board.",
  ),
  vision: sk(
    "strong",
    "Takes text, image AND video as input — one of only a few rows here that does.",
  ),
  factual: sk(
    "strong",
    "No AA-Omniscience row published; graded from its position on the AA index and the absence of any reported hallucination outlier.",
  ),
  world: sk("ok", "No live source of its own."),
  speed: sk(
    "strong",
    "Fewer tokens per task than its predecessor, which is what wall-clock actually follows.",
  ),
  cost: sk(
    "strong",
    "$1.25 in / $4.25 out per million on the PRIVATE endpoint. The $0.10/$0.20 'contributor' endpoint is 10–20x cheaper and pays for it by letting Meta train on your traffic — a different product, not a discount.",
  ),
};

const MIMO_SKILLS: CoreSkills = {
  code: sk(
    "strong",
    "First among the 114 open-weight models Artificial Analysis tracks, level with Grok 4.7 and seven points behind Fable 5.1 and GPT-6 Astra on the Intelligence Index.",
  ),
  frontend: sk(
    "ok",
    "No row on the 2026-09-22 WebDev board. Graded from the index position rather than guessed upward.",
  ),
  agentic: sk("strong", "Frontier-adjacent agentic behaviour at open-weight economics."),
  data: sk(
    "strong",
    "Strong structured handling; the MIT licence means it can be run where the data is.",
  ),
  maths: sk("strong", "Consistent with an AA index of 46."),
  science: sk(
    "strong",
    "Strong for an open-weight model; below the US flagships on graduate questions.",
  ),
  reason: sk("strong", "The strongest open-weight reasoner on the current board."),
  write: sk("ok", "Functional rather than fluent in English."),
  languages: sk("strong", "Excellent Chinese, capable English."),
  psych: sk("ok", "Not a tuned strength."),
  instruct: sk("strong", "Good format discipline for an open-weight release."),
  context: sk(
    "strong",
    "1M-token window, and the weights are open, so the window is yours to use rather than metered.",
  ),
  vision: sk("ok", "Text-first; the vision path is not the reason to pick this row."),
  factual: sk("ok", "Broad recall, mid-pack abstention."),
  world: sk("ok", "No live source of its own."),
  speed: sk(
    "ok",
    "1.02T sparse MoE with 42B active — 2.15 s to first token against MiniMax M3's 0.92 s.",
  ),
  cost: sk(
    "top",
    "MIT-licensed weights for Pro, Flash and a 9B distillation on Hugging Face, trained for a reported $3M. Frontier-adjacent capability with no per-token floor at all if you host it.",
  ),
};

const MINIMAX_SKILLS: CoreSkills = {
  code: sk(
    "ok",
    "AA Intelligence Index 29 — seventeen points behind MiMo-V2.6-Pro. Not a coding tier.",
  ),
  frontend: sk("weak", "No board row and no indication it would place."),
  agentic: sk(
    "ok",
    "Short tool chains only; at index 29 it does not recover from its own mistakes.",
  ),
  data: sk("ok", "Adequate on a small table."),
  maths: sk("ok", "Mid-pack arithmetic and algebra; nothing here suggests competition-grade work."),
  science: sk("ok", "Recall level, in line with an Intelligence Index of 29."),
  reason: sk("ok", "Serviceable on ordinary problems, out of its depth on lateral ones."),
  write: sk(
    "ok",
    "Plain but clean — it does not overreach, which is this row's general character.",
  ),
  languages: sk("strong", "Strong Chinese and English — the better half of this row."),
  psych: sk("ok", "Not a tuned strength."),
  instruct: sk(
    "strong",
    "IFBench 82.9% on Artificial Analysis's own page, level with Grok 4.20 and inside half a point of the leader — a genuinely frontier result from a model seventeen index points off the pace.",
  ),
  context: sk("ok", "Adequate window; recall is not a selling point."),
  vision: sk("weak", "Text-first; there is no reason to send it an image."),
  factual: sk(
    "strong",
    "18.4% hallucination rate — third-lowest on the public AA snapshot, behind Command A+ at 14.2% and LFM2.5-2.6B at 16.0%. It knows less than the flagships and invents less about what it does not know, which is exactly what this column rewards.",
  ),
  world: sk("weak", "No live source and a modest knowledge base."),
  speed: sk(
    "top",
    "168.9 output tokens/sec and 0.92 s to first token — the fastest first token in this dossier.",
  ),
  cost: sk(
    "top",
    "Cheaper per input token than the open-weight leaders, and fast enough that the €/task follows.",
  ),
};

const HUNYUAN_SKILLS: CoreSkills = {
  code: sk(
    "ok",
    "AA Intelligence Index 25.3. Reasoning is this row's product, not implementation.",
  ),
  frontend: sk(
    "strong",
    "WebDev Arena 1627 Elo, eleventh on the 2026-09-22 board.",
    "the Elo is hy4-preview's, not hy3's — a neighbouring version, and this dossier's row is hy3.",
  ),
  agentic: sk(
    "strong",
    "MCP Atlas 79.1% and BrowseComp 84.2%: this row is built as a tool-using agent.",
  ),
  data: sk("strong", "Strong structured reasoning within a pure-text pipeline."),
  maths: sk(
    "top",
    "IMO-AnswerBench 90.0% — competition-grade mathematics from a model at a quarter of the flagships' index.",
  ),
  science: sk(
    "top",
    "GPQA 90.4%, which is graduate-science territory and the strongest published cell in this row.",
  ),
  reason: sk("strong", "A pure reasoning model, and the benchmarks agree."),
  write: sk("ok", "Reasoning output rather than prose for a reader."),
  languages: sk("strong", "Strong Chinese, capable English."),
  psych: sk(
    "weak",
    "No tuning for this at all. Route a difficult human conversation anywhere else.",
  ),
  instruct: sk(
    "ok",
    "No IFBench row; graded from the agentic results, which imply reasonable discipline.",
  ),
  context: sk("ok", "No published long-context figure."),
  vision: sk(
    "weak",
    "Text-only by design — screenshots and diagrams are outside what this model reads at all. Not a weak vision score; an absent one.",
  ),
  factual: sk(
    "strong",
    "DeepSearchQA 91.0% is a retrieval-and-recall result, and this row abstains more readily than DeepSeek does on the same kind of question.",
  ),
  world: sk(
    "strong",
    "DeepSearchQA 91.0% and BrowseComp 84.2% — retrieval is what this row is built for.",
    "both figures are the vendor's own browsing harness; reached through openrouter this row has no search tool configured, so the retrieval half is unproven from here.",
  ),
  speed: sk("ok", "A reasoning tier; it spends tokens thinking."),
  cost: sk(
    "strong",
    "Chinese-lab pricing on a model that scores like a much dearer one in its two strong columns.",
  ),
};

const STEP_SKILLS: CoreSkills = {
  code: sk(
    "strong",
    "AA Intelligence Index 44, among the top three open-weight models — level with Kimi K3 Max at roughly a fifth of its parameter count.",
  ),
  frontend: sk(
    "ok",
    "No WebDev Arena row; graded from its index position rather than guessed upward.",
  ),
  agentic: sk(
    "strong",
    "Configurable reasoning effort (low/medium/high/xhigh) across a 10-evaluation index including Terminal-Bench 4.0 and GDPval-AA v2.",
  ),
  data: sk("ok", "No published table-work result."),
  maths: sk("strong", "Consistent with its index position."),
  science: sk("strong", "The index includes SciCode and Humanity's Last Exam."),
  reason: sk("strong", "Strong for a 600B sparse MoE with 27B active."),
  write: sk("ok", "Functional English; the prose reads like a translation because largely it is."),
  languages: sk("strong", "Strong Chinese, capable English."),
  psych: sk("ok", "Not a tuned strength."),
  instruct: sk(
    "ok",
    "No IFBench row published for this model, so this is position, not measurement.",
  ),
  context: sk("strong", "1M-token window via Sparse GQA — roughly 1,500 A4 pages."),
  vision: sk(
    "strong",
    "Native image input, and video up to about five minutes — unusual at this size.",
  ),
  factual: sk("ok", "No AA-Omniscience row; mid-pack on the knowledge half of its index."),
  world: sk("ok", "No live source of its own."),
  speed: sk("ok", "27B active parameters keeps it reasonable; the xhigh effort level does not."),
  cost: sk(
    "strong",
    "Callable today at Chinese-lab prices. Open weights were promised for 2026-10-15 and had not appeared on Hugging Face at the time of writing — callable and downloadable are two different things, and only one of them has happened.",
  ),
};

const COPILOT_SKILLS: CoreSkills = {
  code: sk(
    "ok",
    "This is Microsoft 365 Copilot, NOT GitHub Copilot. Code is incidental to the product.",
  ),
  frontend: sk(
    "weak",
    "Not a build surface at all — Copilot edits documents, it does not ship a page.",
  ),
  agentic: sk(
    "weak",
    "A chat surface inside Office, not a tool loop.",
    "reached through a shared browser tab on the work tenant rather than an API, so there is no programmatic tool path to test at all.",
  ),
  data: sk(
    "strong",
    "Its best column by some distance: it sits inside Excel and the tenant's own files, so the table it is reasoning about is the real one rather than a paste of it.",
  ),
  maths: sk(
    "strong",
    "An OpenAI reasoning model underneath, so the arithmetic is the reasoning tier's, not the chat surface's.",
  ),
  science: sk(
    "strong",
    "Same underlying reasoning model; the filtering is on what it will say, not on what it can work out.",
  ),
  reason: sk("strong", "'Think deeper' is the slow, deliberate mode of an OpenAI reasoning model."),
  write: sk(
    "strong",
    "Drafting inside Word and Outlook against the tenant's own documents is the product's whole pitch.",
  ),
  languages: sk(
    "strong",
    "Microsoft 365's language coverage is broad and includes Catalan and Spanish.",
  ),
  psych: sk("ok", "Corporate register by construction — safe, and rarely perceptive."),
  instruct: sk(
    "strong",
    "Format discipline is good; the Responsible-AI layer sometimes rewrites the answer's shape, which is the one thing that costs it a ★.",
  ),
  context: sk(
    "ok",
    "The surface, not the model, decides how much it reads — and the surface is conservative.",
  ),
  vision: sk("ok", "Reads documents and slides; not a general vision tier."),
  factual: sk(
    "strong",
    "Grounded in the tenant's own files and in Bing, which is a real advantage over a bare model on anything the organisation actually wrote down.",
  ),
  world: sk(
    "strong",
    "Bing grounding gives it genuine post-cut-off retrieval — one of the few rows here with a live source wired in by the vendor.",
    "verified only through the shared browser tab; there is no API path from here, so nothing about this transport is programmatically testable.",
  ),
  speed: sk(
    "weak",
    "'Think deeper' is slow on purpose, and the Office surface adds its own latency.",
  ),
  cost: sk(
    "ok",
    "A per-seat licence rather than per-token, so it does not price against this board at all. Free at the margin once the seat exists; unavailable at any price without one.",
  ),
};

// ORDER MATTERS — first match wins; family rows before generic ones.
// ── VERTICAL CELLS (FORK 2026-10-02) ──────────────────────────────────────────
// One block per new column rather than seven more lines in each of 28 family maps: the
// research arrived per column, it is checked per column, and a column read top to bottom
// is how a wrong grade gets caught. withVerticals() merges them into each family's map.
// Sources each research pass read (full lists in the pass's own output):
//   SHELL: https://www.tbench.ai/leaderboard · https://benchlm.ai/benchmarks/terminal-bench-4 · https://benchlm.ai/benchmarks/vals-terminal-bench-4 · https://benchlm.ai/benchmarks/aaterminalbench4 · https://benchlm.ai/benchmarks/valsterminalbench21 · https://llm-stats.com/benchmarks/terminal-bench-4.0
//   ML: https://htihle.github.io/weirdml.html · https://htihle.github.io/data/weirdml_v3_results.json · https://htihle.github.io/assets/data/weirdml_v3.json · https://htihle.github.io/weirdml_v2.html · https://htihle.github.io/data/weirdml_data.csv · https://epoch.ai/benchmarks/weirdml
//   CAD: https://epoch.ai/benchmarks/cad-eval · https://benchmarklist.com/benchmarks/cadeval/ · https://llm-stats.com/benchmarks/benchcad · https://benchmarklist.com/benchmarks/cadbench_a_multimodal_benchmark_for_ai_assisted_cad_program_generation/ · https://arxiv.org/abs/2605.10873 · https://epoch.ai/benchmarks/furniture-assembly
//   RESEARCH: https://benchlm.ai/benchmarks/browsecomp · https://benchlm.ai/benchmarks/hlewithtools · https://evals.report/benchmarks/browsecomp?tab=scores · https://llm-stats.com/leaderboards/best-ai-for-research · https://benchmarklist.com/benchmarks/browsecomp_plus/ · https://futuresearch.ai/deep-research-bench/
//   OFFICE: https://artificialanalysis.ai/evaluations/gdpval-aa · https://benchlm.ai/benchmarks/gdpvalaanormalized · https://modelglass.com.au/gdpval · https://www.mercor.com/apex/apex-v1-leaderboard/ · https://www.mercor.com/apex/apex-agents-leaderboard/ · https://www.vals.ai/benchmarks
//   SECURITY: https://benchlm.ai/benchmarks/cybergym · https://llm-stats.com/benchmarks/cybergym · https://benchlm.ai/benchmarks/exploitbench · https://www-cdn.anthropic.com/fc1b44717c85dc068bc6ba5024219938094694bd/Claude%20Opus%205.5%20System%20Card.pdf · https://deploymentsafety.openai.com/gpt-6-astra · https://www.infoq.com/news/2026/09/gpt-6-astra-critical-cyber/
//   HEALTH: https://benchlm.ai/benchmarks/healthbench · https://benchlm.ai/benchmarks/healthbench-hard · https://llm-stats.com/benchmarks/healthbench-hard · https://benchmarklist.com/benchmarks/healthbench_professional/ · https://benchmarklist.com/benchmarks/healthbench/ · https://llm-stats.com/benchmarks/healthbench-consensus
type VerticalFamily =
  | "fable"
  | "opus"
  | "sonnet"
  | "haiku"
  | "gpt56sol"
  | "gpt56terra"
  | "gpt56luna"
  | "gpt6astra"
  | "gpt6sol"
  | "gpt6luna"
  | "copilot"
  | "muse"
  | "codex"
  | "legacy_oai"
  | "grok"
  | "gemini_flash"
  | "gemini_pro"
  | "kimi"
  | "deepseek"
  | "glm"
  | "qwen"
  | "mimo"
  | "minimax"
  | "hunyuan"
  | "step"
  | "hermes"
  | "dolphin"
  | "abliterated";
export const SC_VERTICAL_CELLS: Record<VerticalKey, Record<VerticalFamily, SkillCell>> = {
  shell: {
    fable: sk(
      "strong",
      "Claude Fable 5.1 scored 57.9% on the official Terminal-Bench 4.0 board (30 Sep 2026) and 52.0-58.1% on the Vals and Artificial Analysis reruns, placing fourth to sixth. The older Fable 5 is well behind at 44.5%.",
    ),
    opus: sk(
      "top",
      "Claude Opus 5.5 came first on the Vals Terminal-Bench 4.0 run at 65.2% (29 Sep 2026) and second on both Artificial Analysis (59.6%) and llm-stats (66.4%). Opus 5 is a clear step down at about 52-54%.",
    ),
    sonnet: sk(
      "top",
      "Claude Sonnet 5.5 is first on two of the three independent Terminal-Bench 4.0 reruns: 63.6% at Artificial Analysis (1 Oct 2026) and 70.6% at llm-stats (2 Oct 2026). Sonnet 5 scored only 9.6-12.4%, so this grade is for 5.5 alone.",
    ),
    haiku: sk(
      "weak",
      "No Terminal-Bench 4.0 run exists for it. On the easier 2.1 suite (Vals, 27 Sep 2026) Haiku 4.5 Thinking scored 43.8%, which placed it 66th of 76 models when the middle of that board sat near 57%.",
    ),
    gpt56sol: sk(
      "ok",
      "GPT-5.6 Sol scored 37.3% on the official Terminal-Bench 4.0 board and 37.9% on the Vals rerun (29-30 Sep 2026), around tenth place. It gets through ordinary terminal work and loses most of the hard tasks.",
    ),
    gpt56terra: sk(
      "weak",
      "GPT-5.6 Terra scored 21.5-22.7% across the three Terminal-Bench 4.0 runs (29-30 Sep 2026), about a third of the leaders' rate. It did reach 77.5% on the easier 2.1 suite, so simple shell steps are within reach.",
    ),
    gpt56luna: sk(
      "weak",
      "GPT-5.6 Luna scored 11.6-17.3% on Terminal-Bench 4.0 across the Vals, official and llm-stats runs (29-30 Sep 2026), near the bottom of each. The cheap tier is not where a broken server should go.",
    ),
    gpt6astra: sk(
      "top",
      "GPT-6 Astra leads the official Terminal-Bench 4.0 board at 58.2% (30 Sep 2026) and is third on the Vals (59.6%) and Artificial Analysis (59.1%) reruns. The strongest OpenAI model here by a wide margin.",
    ),
    gpt6sol: sk(
      "strong",
      "GPT-6.1 Sol scored 55.1% on the Vals Terminal-Bench 4.0 run and 56.1% at Artificial Analysis (late Sep 2026), fifth or sixth place. The earlier GPT-6 Sol sits around 44%.",
    ),
    gpt6luna: sk(
      "weak",
      "GPT-6 Luna scored 12.6% at Artificial Analysis and 13.6% on the Vals Terminal-Bench 4.0 run (late Sep 2026), near the bottom of both. Cheap tier, and it shows on terminal work.",
    ),
    copilot: sk(
      "weak",
      "No Terminal-Bench entry, and the product has no shell: Microsoft 365 Copilot Think Deeper reads the tenant's Office files and Bing, it cannot run a command or reach a server. Graded on what the product can do, not on a score.",
    ),
    muse: sk(
      "ok",
      "Meta's Muse Spark 1.3 scored 33.3% on the Artificial Analysis Terminal-Bench 4.0 table (1 Oct 2026) but only 10.6% on the Vals run (29 Sep 2026), with the 1.3 Max variant at 24.8% there. The measurements disagree, so treat it as mid-pack at best.",
    ),
    codex: sk(
      "ok",
      "No Terminal-Bench 4.0 run. GPT-5.3-Codex reached 77.3-78.4% on the retired 2.0 suite and GPT-5.5 Codex got 57.3% on 2.1 (Vals, 27 Sep 2026), below plain GPT-5.5 at 76.4%. Competent, but only measured on older suites.",
    ),
    legacy_oai: sk(
      "ok",
      "GPT-5.5 topped the retired Terminal-Bench 2.0 board at 82% and GPT-5.4 was close at 75-82%, but nothing in this family has been run on the current 4.0 suite and GPT-5.4 mini managed 2.5% there. Fine for everyday commands, not for hard repair work.",
    ),
    grok: sk(
      "ok",
      "Grok 4.7 scored 25.8% at Artificial Analysis, 28.8% at Vals and 38.0% on the official Terminal-Bench 4.0 board (late Sep 2026). Grok 4.6 is 17-20% and 4.5 about 9-12%, so only the newest version is worth using.",
    ),
    gemini_flash: sk(
      "weak",
      "Gemini 3.8 Flash scored 19.1-19.7% on all four Terminal-Bench 4.0 runs (late Sep to 2 Oct 2026), a tight and low result. It reached 81.3% on the easier 2.1 suite, so routine commands are fine and hard repair work is not.",
    ),
    gemini_pro: sk(
      "strong",
      "Gemini 4 Argon, announced 30 Sep 2026 and not public yet, scored 57.6% on the Vals Terminal-Bench 4.0 run and 57.1% at Artificial Analysis, fourth or fifth. The shipping Gemini 3.1 Pro reached 78-80% on the retired 2.0 suite.",
    ),
    kimi: sk(
      "weak",
      "Kimi K3 scored 12.6% at Artificial Analysis and 19.7% at Vals on Terminal-Bench 4.0 (late Sep 2026), though it reached 80.9% on the easier 2.1 suite. Good on simple commands, poor once the task gets hard.",
    ),
    deepseek: sk(
      "ok",
      "DeepSeek V4.1 Flash scored 19.7% at Vals, 26.8% at Artificial Analysis and 31.2% at llm-stats on Terminal-Bench 4.0 (late Sep to 2 Oct 2026); V4 Pro is lower at 11-14%. Mid-pack, and the three runs disagree by a wide margin.",
    ),
    glm: sk(
      "ok",
      "GLM-5.3 scored 38.9-41.9% across all three Terminal-Bench 4.0 runs (late Sep to 2 Oct 2026), eighth place and the best open-weight model on the board, at roughly two thirds of the leaders' rate.",
    ),
    qwen: sk(
      "ok",
      "Qwen3.8 Max scored 34.3% on the Vals Terminal-Bench 4.0 run (29 Sep 2026), twelfth of 42. The smaller Qwen3.8-27B managed only 5.6% at Artificial Analysis, so the gap inside this family is large.",
    ),
    mimo: sk(
      "ok",
      "MiMo-V2.6-Pro scored 31.3% at Vals, 34.8% at Artificial Analysis and 34.9% at llm-stats on Terminal-Bench 4.0 (late Sep to 2 Oct 2026). Mid-pack, close to GLM-5.3 and Qwen3.8 Max.",
    ),
    minimax: sk(
      "weak",
      "MiniMax M3 scored 2.0% at Artificial Analysis and 1.0% on the Vals Terminal-Bench 4.0 run (late Sep 2026), meaning almost nothing finished. It did get 53.6% on the much easier 2.1 suite.",
    ),
    hunyuan: sk(
      "weak",
      "The Hunyuan HY4 preview scored 8.1% on the Vals Terminal-Bench 4.0 run (29 Sep 2026) and 55.1% on the easier 2.1 suite. It is a text-only reasoning model, so operating a machine is not what it was built for.",
    ),
    step: sk(
      "ok",
      "Step 5 Preview scored 33.3% on the Artificial Analysis Terminal-Bench 4.0 table (1 Oct 2026), tenth of 23 models. No separate number was published for Step 3.7, so this grade rests on the newer model from the same lab.",
    ),
    hermes: sk(
      "weak",
      "Hermes 4 405B scored 11.4% on Terminal-Bench Hard in reasoning mode and 9.8% without it, and the 70B version scored 0.0% (benchmarklist model pages, 2026). Open weights with few refusals, but it is not a terminal agent.",
    ),
    dolphin: sk(
      "weak",
      "No Terminal-Bench score exists. The Venice edition of Dolphin Mistral 24B does not accept tool calls at all, per its OpenRouter model page, and a terminal agent needs them, so it cannot do this work.",
    ),
    abliterated: sk(
      "weak",
      "No Terminal-Bench score for any abliterated checkpoint. Inferred from the base model: Qwen3.8-27B scored 5.6% on the Artificial Analysis Terminal-Bench 4.0 table (1 Oct 2026), and stripping refusals adds no terminal skill.",
    ),
  },
  ml: {
    fable: sk(
      "strong",
      "Fable 5.1 is fourth on both boards: 26.0% on WeirdML v3 (2026-10-02) and 40.2% on PostTrainBench v1.1 (Oct 1 2026). It is also the most expensive of the Anthropic models on WeirdML v3 at about $32 a task against $10 for Opus 5.5.",
    ),
    opus: sk(
      "top",
      "First on PostTrainBench v1.1 at 49.3% (Oct 1 2026), ahead of every other model, and third on WeirdML v3 at 31.2% (2026-10-02). Opus 5 is well behind its own successor at 19.0% on WeirdML v3, so the 5.5 upgrade matters a lot here.",
    ),
    sonnet: sk(
      "strong",
      "Sonnet 5.5 scores 20.0% on WeirdML v3 (2026-10-02), fifth overall and above Opus 5 at 19.0% for roughly a third of the cost per task. The older Sonnet 5 got 68.8% on WeirdML v2 (rank 34 of 162).",
    ),
    haiku: sk(
      "weak",
      "45.4% on WeirdML v2, rank 85 of 162 — mid-table on a board where the top is 93.6%, and that was its better run; with thinking on it scored 44.2%. It has not been entered on WeirdML v3 or PostTrainBench.",
    ),
    gpt56sol: sk(
      "strong",
      "Fifth on PostTrainBench v1.1 at 36.2% (Oct 1 2026) and 15.0% on WeirdML v3 (2026-10-02). On the older WeirdML v2 board it reached 88.8% at about $1.25 a task, which was near the top at the time.",
    ),
    gpt56terra: sk(
      "ok",
      "78.3% on WeirdML v2 at about $0.25 a task, rank 19 of 162 — the best score for the money on that board. It has not been run on the harder WeirdML v3 or on PostTrainBench, so its ceiling on current tasks is unknown.",
    ),
    gpt56luna: sk(
      "weak",
      "Last of the seventeen models on WeirdML v3 at 5.2% (2026-10-02). The newer GPT-6 Luna is both cheaper and better at 7.9%, so there is no reason to send training work here.",
    ),
    gpt6astra: sk(
      "top",
      "Best on the field's main benchmark: 42.2% on WeirdML v3, the independent board of 11 hand-made training tasks, data generated 2026-10-02 — the next model is 7 points behind. Also third on PostTrainBench v1.1 at 44.3% (Oct 1 2026), which asks a model to fine-tune a base model on one GPU in ten hours.",
    ),
    gpt6sol: sk(
      "top",
      "GPT-6.1 Sol is second on WeirdML v3 at 35.5% (2026-10-02) and costs about $5 a task against $28 for GPT-6 Astra. The older GPT-6 Sol sits lower at 19.7%, so pick the 6.1 version for training work.",
    ),
    gpt6luna: sk(
      "ok",
      "7.9% on WeirdML v3 (2026-10-02) at about $0.32 a task — the cheapest model on that board, and still ahead of Grok 4.7 which costs eighty times more. Good value for a first pass, far from the 42.2% top score.",
    ),
    copilot: sk(
      "weak",
      "No score on any ML-engineering benchmark. Think Deeper answers in a web page with no GPU and no place to run code, so it cannot actually train anything — it can discuss a plan, not execute one.",
    ),
    muse: sk(
      "weak",
      "Muse Spark 1.3 was entered in WeirdML v3 but dropped from the published board for finishing only 3 of the 11 tasks, averaging about 4% on those (2026-10-02). The previous Muse Spark 1.2 scored 60.3% on WeirdML v2, rank 51 of 162.",
    ),
    codex: sk(
      "ok",
      "GPT-5.3 Codex scored 77.9% on WeirdML v2, rank 21 of 162. There is no result for any Codex model on WeirdML v3 or PostTrainBench, and being tuned for writing code is not the same as knowing how to train a model.",
    ),
    legacy_oai: sk(
      "ok",
      "GPT-5.5 reached 84.9% on WeirdML v2 (rank 14 of 162) and GPT-5.4 77.7%, but on PostTrainBench v1.1 they are near the bottom at 27.2% and 19.0% (Oct 1 2026). Older still is much weaker: o3 scored 52.4% on WeirdML v2, rank 63 of 162.",
    ),
    grok: sk(
      "weak",
      "Grok 4.7 scores 7.5% on WeirdML v3 at about $26 a task (2026-10-02) — the same ballpark as models costing under a dollar. Grok 4.5 is twelfth of fourteen on PostTrainBench v1.1 at 23.4% (Oct 1 2026).",
    ),
    gemini_flash: sk(
      "ok",
      "Gemini 3.8 Flash is unusually good for its price: 84.8% on WeirdML v2 at about $0.51 a task (rank 15 of 162). On the harder v3 tasks it manages 7.4% (2026-10-02), so it is a cheap first attempt rather than a model for difficult training work.",
    ),
    gemini_pro: sk(
      "strong",
      "Gemini 4 Argon is second on PostTrainBench v1.1 at 45.3% (Oct 1 2026), but it was announced 2026-09-30 and is not available yet. The public Gemini 3.1 Pro is mid-table: 72.1% on WeirdML v2 (rank 30 of 162) and 22.0% on PostTrainBench v1.1.",
    ),
    kimi: sk(
      "ok",
      "Best of the open-weight models here: 32.0% on PostTrainBench v1.1 (Oct 1 2026) and 82.6% on WeirdML v2 (rank 18 of 162). On the harder v3 tasks it drops to 7.4% (2026-10-02), so it handles ordinary training jobs but not the difficult ones.",
    ),
    deepseek: sk(
      "ok",
      "DeepSeek V4 Pro got 66.2% on WeirdML v2 (rank 38 of 162), and V4.1 Flash reaches 6.2% on the harder v3 tasks at about $0.48 each (2026-10-02). Cheap and usable for routine training jobs, clearly behind the leaders on hard ones.",
    ),
    glm: sk(
      "ok",
      "GLM-5.3 scores 39.8% on the PostTrainBench board at llm-stats (updated 2026-10-02) and 75.4% on WeirdML v2 (rank 27 of 162). The cheaper GLM-5.3 Flash was dropped from WeirdML v3 for not finishing most tasks, so stick to the full model.",
    ),
    qwen: sk(
      "ok",
      "Qwen3.8 Max (released openly as Qwen3.8-2.4T-A95B) scores 75.2% on WeirdML v2, rank 28 of 162 — just behind GLM-5.3. No result yet on WeirdML v3 or PostTrainBench, so treat it as solid on ordinary training work, untested on hard tasks.",
    ),
    mimo: sk(
      "none",
      "No ML-engineering result found: MiMo does not appear on WeirdML v2 or v3, on PostTrainBench, or on MLE-bench, and Xiaomi has no sibling model on those boards to infer from. Its strong coding and terminal scores do not tell us whether it can train a model.",
    ),
    minimax: sk(
      "ok",
      "MiniMax M3 scores 37.1% on the PostTrainBench board at llm-stats (updated 2026-10-02), above Kimi K3 there. The older MiniMax M2.7 was weak on WeirdML v2 at 37.0% (rank 123 of 162), so the fine-tuning result is the better guide.",
    ),
    hunyuan: sk(
      "ok",
      "The HY4 preview scores 35.6% on the PostTrainBench board at llm-stats (updated 2026-10-02), close to Kimi K3. It is text-only, so it cannot look at images, plots or sample pictures — a real limit for computer-vision training work.",
    ),
    step: sk(
      "none",
      "No ML-engineering result found: neither Step 3.7 nor Step 5 appears on WeirdML v2 or v3, on PostTrainBench, or on MLE-bench, and StepFun has no other model on those boards. Nothing here is a defensible guess.",
    ),
    hermes: sk(
      "weak",
      "No ML-engineering score published. Inferring from its base model on WeirdML v2, Llama-3.1-405B scored 21.4% (rank 146 of 162) and Llama-3.3-70B 14.4%, which puts an open fine-tune of that family near the bottom.",
    ),
    dolphin: sk(
      "weak",
      "No ML-engineering score published. The closest Mistral on WeirdML v2 is mistral-medium-3.5 at 43.7% (rank 90 of 162), and this is a much smaller 24B tune, so expect less than that.",
    ),
    abliterated: sk(
      "weak",
      "No ML-engineering score published. The nearest base on WeirdML v2 is qwen3.5-27b at 39.5% (rank 107 of 162), and removing refusals does nothing for training skill while usually costing some accuracy.",
    ),
  },
  cad: {
    fable: sk(
      "top",
      "Best of the general models at writing geometry-physics simulation files: 14 of 16 tasks and a 0.95 mean on Surface Evolver Bench (board read 2 Oct 2026, repo updated 11 Sep). Also second on Epoch AI's furniture-assembly test at 70% behind GPT-6 Astra, Sep 2026.",
    ),
    opus: sk(
      "top",
      "Opus 5.5 is second on Blueprint-Bench 2 at 51.2% (snapshot 30 Sep 2026) and second on BenchCAD at 0.730 (llm-stats, 2 Oct 2026). Opus 5 scored 61% on Epoch AI's furniture assembly, Sep 2026.",
    ),
    sonnet: sk(
      "strong",
      "Sonnet 5.5 is top of the BenchCAD board at 0.747, ahead of Opus 5.5 (llm-stats, 2 Oct 2026), so it writes CadQuery code from renders well. Weaker on the spatial half: Sonnet 5 is 21st on Blueprint-Bench 2 at 24.9% and passed 3 of 16 Surface Evolver tasks.",
    ),
    haiku: sk(
      "weak",
      "Scored 0.0% on Blueprint-Bench 2 (30 Sep 2026), bottom of the board with five other models. Not a model to hand a 3D part to.",
    ),
    gpt56sol: sk(
      "strong",
      "Passed 14 of 16 Surface Evolver tasks with a 0.93 mean, third behind Fable 5 and Kimi K3, and scored 0.706 on BenchCAD (2 Oct 2026). Middle of Blueprint-Bench 2 at 33.6%.",
    ),
    gpt56terra: sk(
      "ok",
      "Passed 11 of 16 Surface Evolver tasks (0.84 mean) and scored 0.623 on BenchCAD, below both Sol and Luna. Blueprint-Bench 2 30.8%, 30 Sep 2026.",
    ),
    gpt56luna: sk(
      "ok",
      "Cheap tier that holds up on CAD code - 0.631 on BenchCAD, just above Terra (2 Oct 2026) - but only passed 3 of 16 Surface Evolver tasks and sits at 22.6% on Blueprint-Bench 2.",
    ),
    gpt6astra: sk(
      "top",
      "Leads Epoch AI's furniture-assembly test at 80% in Sep 2026, up from 28% for Opus 4.5 ten months earlier, and is third on Blueprint-Bench 2 at 49.7%. OpenAI also claims 95.9% on BenchCAD (3 Sep 2026) - that is a vendor claim, not re-graded, and the independent BenchCAD board does not list it.",
    ),
    gpt6sol: sk(
      "strong",
      "Seventh on Blueprint-Bench 2 at 36.9% (30 Sep 2026), ahead of GPT-5.5 and every GPT-5.6 tier. No CAD-code number found for it; the grade leans on that spatial result plus Astra's lead in the same family.",
    ),
    gpt6luna: sk(
      "ok",
      "Blueprint-Bench 2 31.2% (30 Sep 2026), mid-board and well above the GPT-5.6 cheap tier. No CAD-code score published for it, so this reads across from its Blueprint result and the GPT-6 family.",
    ),
    copilot: sk(
      "weak",
      "No CAD or spatial benchmark score exists for the Microsoft 365 Copilot seat. It is a chat surface over Office files and Bing with no CAD kernel to run code against, so it cannot iterate on a part the way the measured models do.",
    ),
    muse: sk(
      "weak",
      "The closest measured sibling, Muse Spark 1.1, passed 6 of 16 Surface Evolver tasks for a 0.53 mean (board read 2 Oct 2026) - under half the tasks. No score found for 1.3 and none on any CAD-code board.",
    ),
    codex: sk(
      "ok",
      "No CAD benchmark result found for the Codex line. Its GPT-5.x siblings are mid-field - GPT-5.5 passed 12 of 16 Surface Evolver tasks and scored 36.2% on Blueprint-Bench 2 - so it should write workable CAD code without being the pick for geometry.",
    ),
    legacy_oai: sk(
      "ok",
      "GPT-5.5 did well on the geometry-simulation side, 12 of 16 Surface Evolver tasks at 0.88. Older ones drop off: GPT-5.4 managed 15.8% shape overlap on CADBench (13 Jul 2026) and 27.1% on Blueprint-Bench 2, and o3 still tops the frozen CadEval board at 74 from May 2026.",
    ),
    grok: sk(
      "ok",
      "Mid-board: Grok 4.6 at 33.2% and 4.7 at 32.5% on Blueprint-Bench 2 (30 Sep 2026), and Grok 4.5 passed 8 of 16 Surface Evolver tasks for a 0.74 mean. No CAD-code score published.",
    ),
    gemini_flash: sk(
      "strong",
      "Gemini 3.8 Flash is sixth on Blueprint-Bench 2 at 38.6%, level with Claude Fable 5 and above GPT-5.5, and passed 9 of 16 Surface Evolver tasks at the lowest cost on that board ($2.60 total).",
    ),
    gemini_pro: sk(
      "strong",
      "Gemini 4 Argon tops Blueprint-Bench 2 at 54.4% (30 Sep 2026), but it is not released yet, so it cannot be routed to. Gemini 3.1 Pro, which you can use, is mid-board at 26.5% there, though it was second of the general models on CADBench with 38.2% shape overlap (13 Jul 2026).",
    ),
    kimi: sk(
      "strong",
      "The surprise of the Surface Evolver board: Kimi K3 tied Claude Fable 5 at 14 of 16 tasks and a 0.95 mean, for a third of the cost. Weaker elsewhere - 29.5% on Blueprint-Bench 2, and K2.6 managed 22.4% shape overlap on CADBench.",
    ),
    deepseek: sk(
      "weak",
      "Both versions passed under a third of the Surface Evolver tasks: V4.1 Flash 5 of 16 (0.46 mean) and V4 Pro 4 of 16 (0.40), board read 2 Oct 2026. No CAD-code or blueprint score found.",
    ),
    glm: sk(
      "weak",
      "GLM-5.2 passed 5 of 16 Surface Evolver tasks (0.56 mean) and GLM-5.3 Flash 3 of 16 (0.53). An older GLM-4.6V reached 47.3% on CADEngBench zero-to-CAD (10 Aug 2026), behind Claude and Gemini.",
    ),
    qwen: sk(
      "weak",
      "Qwen3.8 27B passed 3 of 16 Surface Evolver tasks (0.45 mean), and Qwen 3.5 27B scored 1.5% shape overlap on CADBench with 33.5% of its programs even valid (13 Jul 2026). No score found for Qwen3.8 Max itself.",
    ),
    mimo: sk(
      "weak",
      "No CAD, geometry or spatial score found for MiMo. Small open-weight models of this class are at the bottom of the CAD boards - Qwen 3.5 9B produced 0% shape overlap on CADBench - so this is inferred, not measured.",
    ),
    minimax: sk(
      "weak",
      "M3 passed 3 of 16 Surface Evolver tasks for a 0.55 mean (board read 2 Oct 2026), while burning the most tokens of any model on it. No CAD-code or blueprint number found.",
    ),
    hunyuan: sk(
      "weak",
      "No CAD or spatial benchmark result found for HY3 or the HY4 preview. It is text-only, so half this column - reading blueprints and multi-view renders - is out of reach by design.",
    ),
    step: sk(
      "none",
      "No CAD, geometry or spatial measurement found for Step 3.7 or Step 5, and no sibling on any of these boards to read across from. StepFun's own Intelligence Index figure of 44 says nothing about 3D parts.",
    ),
    hermes: sk(
      "weak",
      "No CAD score found for Hermes 4. Its Llama base is mid-to-low on the one board that tested that family - Llama 4 Maverick reached 48.0% on CADEngBench zero-to-CAD (10 Aug 2026) against 58.0% for Claude - and open tunes usually lose ground on geometry.",
    ),
    dolphin: sk(
      "weak",
      "No CAD score for this 24B tune. Its Mistral base is near the bottom where tested: Mistral Medium 3.5 passed 1 of 16 Surface Evolver tasks (0.27 mean) and scored 29.3% on CADEngBench zero-to-CAD.",
    ),
    abliterated: sk(
      "weak",
      "No CAD score for any abliterated checkpoint. The base they come from is already weak here - Qwen 3.5 27B managed 1.5% shape overlap on CADBench (13 Jul 2026) - and stripping refusals does not add geometry skill.",
    ),
  },
  research: {
    fable: sk(
      "strong",
      "Scores 65.0% on Humanity's Last Exam with tools and finished 82% of tasks on Browserbase's hardest browser-agent test against Opus 5's 74% (Anthropic and Browserbase, Oct 2026). Anthropic published no BrowseComp number for it, so its web-research rank against the OpenAI models is untested.",
    ),
    opus: sk(
      "top",
      "Opus 5 scores 90.8% on BrowseComp (Anthropic, Jul 2026) and Opus 5.5 leads the HLE-with-tools board at 67.7% (BenchLM, 1 Oct 2026). Fourth of 90 models on llm-stats' research ranking, 2 Oct 2026.",
    ),
    sonnet: sk(
      "strong",
      "Sonnet 5 scores 84.7% on BrowseComp and Sonnet 5.5 is third on HLE-with-tools at 64.5%, just behind the two Opus models (BenchLM, 1 Oct 2026). About 7 points off the top on web search, at a much lower price.",
    ),
    haiku: sk(
      "weak",
      "No BrowseComp or HLE-with-tools score published for Haiku 4.5. Its generation-mate Sonnet 4.5 scored 24.1% on BrowseComp (Anthropic, Sep 2025) against today's 90%+, so the cheap 2025 tier is not the one to send looking things up.",
    ),
    gpt56sol: sk(
      "top",
      "Best published BrowseComp result here: 90.4% single-agent and 92.2% at the ultra setting (OpenAI, Jul 2026). Fifth on llm-stats' research ranking at 28.5, 2 Oct 2026.",
    ),
    gpt56terra: sk(
      "strong",
      "BrowseComp 87.5% (OpenAI, Jul 2026), about 5 points behind its own Sol tier, and eighth on llm-stats' research ranking at 26.9 (2 Oct 2026). Good value for research that does not need the top tier.",
    ),
    gpt56luna: sk(
      "ok",
      "BrowseComp 83.3% (OpenAI, Jul 2026) — respectable for the cheap tier but about 9 points behind Sol. Fine for a quick look-up, not for a report you will not re-check.",
    ),
    gpt6astra: sk(
      "top",
      "BrowseComp 91.5% (OpenAI, Sep 2026) and third of 90 models on llm-stats' research ranking at 31.5 (2 Oct 2026). Weaker on HLE-with-tools at 57.2%, where the Claude models are 7-10 points ahead.",
    ),
    gpt6sol: sk(
      "strong",
      "No BrowseComp or HLE-with-tools score published; graded from its own lab's siblings, GPT-6 Astra at 91.5% and GPT-5.6 Sol at 90.4%. Its own numbers show long-context reasoning at 83.7% (AA-LCR) but a 60.1% hallucination rate on AA-Omniscience, so check its citations.",
    ),
    gpt6luna: sk(
      "ok",
      "No research or browsing score found for it. Graded from the same lab's previous cheap tier, GPT-5.6 Luna at 83.3% BrowseComp — useful for small look-ups, not the one for a sourced report.",
    ),
    copilot: sk(
      "strong",
      "Microsoft's Researcher runs a GPT model and a Claude model and has one critique the other's sources, which Microsoft says beats competing approaches on the DRACO research benchmark — a vendor claim with no number published (Microsoft 365 blog, 2026). The one to use when the answer has to come from the company's own files as well as the web.",
    ),
    muse: sk(
      "strong",
      "Scores 89.4 on DeepSearchQA for agentic browsing at its max setting (Meta, Sep 2026) — a lab claim, and the only search number Meta published for it. No BrowseComp result, so it is untested against the models above.",
    ),
    codex: sk(
      "ok",
      "No research or browsing benchmark published for the Codex line; it is tuned for terminals and code, not sourced prose. Its general siblings score 84.4% on BrowseComp (GPT-5.5, OpenAI 2026), so it can search, but it is not what it was built for.",
    ),
    legacy_oai: sk(
      "ok",
      "Wide spread: GPT-5.5 84.4% and GPT-5.4 82.7% on BrowseComp still hold up, while GPT-5 managed 54.9%, o3 49.7% and GPT-4o 0.6% (OpenAI, 2024-2026). The recent two are usable; anything o3-class or older is not.",
    ),
    grok: sk(
      "strong",
      "Grok 4.6 scores 84.0% on BrowseComp and 81.6% on xAI's own DeepSearchQA, where GPT-5.5 reached 87.8% (xAI, Aug 2026). Grok 4.7 added 111 Elo on Artificial Analysis's private knowledge-work test, reaching 1657.",
    ),
    gemini_flash: sk(
      "ok",
      "No BrowseComp result published for 3.8 Flash. Its own numbers are 54.9% on HLE-Verified and 1545 on GDPval-AA knowledge work (Google, Sep 2026); graded from those plus the Pro sibling's 85.9%, since the Flash tier sits below it.",
    ),
    gemini_pro: sk(
      "strong",
      "Gemini 3.1 Pro scores 85.9% on BrowseComp (Google, 2026), ninth on the 44-model board. Gemini 4 Argon, announced 30 Sep 2026, published no BrowseComp figure at all — only Vals Index 68.9 and Terminal-Bench 4.0 57.4 — so its research rank is unknown.",
    ),
    kimi: sk(
      "strong",
      "Effectively tied with the top three: BrowseComp 91.2% (Moonshot, Jul 2026) and second of 90 models on llm-stats' research ranking at 33.0 (2 Oct 2026). Kept just below top only because it has no HLE-with-tools result to confirm it.",
    ),
    deepseek: sk(
      "strong",
      "V4.1 Flash is fourth on HLE-with-tools at 63.9%, ahead of Sonnet 5 and GPT-6 Astra, and V4 Pro scores 83.4% on BrowseComp (BenchLM, 1 Oct 2026). Strong for the price; the older V3.2 managed only 40.1%.",
    ),
    glm: sk(
      "strong",
      "GLM-5.3 is fifth on HLE-with-tools at 62.5%, above GPT-6 Astra's 57.2% (BenchLM, 1 Oct 2026). Its browsing record is thinner — GLM-5.1 scored 68% on BrowseComp, about 23 points off the top.",
    ),
    qwen: sk(
      "ok",
      "Qwen3.8 Max is ninth on HLE-with-tools at 56.2% (BenchLM, 1 Oct 2026), but the family's browsing scores lag: Qwen3.5 397B reached 62% on BrowseComp against 90%+ at the top. Fine for reading sources you hand it, weaker at finding them.",
    ),
    mimo: sk(
      "ok",
      "No BrowseComp or HLE-with-tools result found for MiMo-V2.6-Pro. It scored 46 on Artificial Analysis's Intelligence Index, the best open-weight model as of 23 Sep 2026, so this grade comes from general ability rather than any research measurement.",
    ),
    minimax: sk(
      "ok",
      "MiniMax M3 scores 83.5% on BrowseComp (BenchLM, 1 Oct 2026), about 9 points behind the leaders. That is its only research-related number, with nothing on HLE-with-tools to confirm it.",
    ),
    hunyuan: sk(
      "strong",
      "HY4 preview is sixth of 90 models on llm-stats' research ranking at 28.2, ahead of GPT-5.5 Pro and GPT-5.6 Terra (2 Oct 2026), and scores 55.4% on HLE-with-tools. Text-only, which matters little for reading sources but rules out charts and screenshots.",
    ),
    step: sk(
      "strong",
      "Step 5 Preview scores 88.7% on BrowseComp, eighth of 44 models (BenchLM, 1 Oct 2026). The cheaper Step 3.7 Flash drops to 75.8% there and 47.2% on HLE-with-tools, so the gap between the two tiers is large.",
    ),
    hermes: sk(
      "weak",
      "No research or browsing benchmark published. Hermes 4 405B scores 26.6% on the tau-2 tool-use test and 8.8 on Artificial Analysis's Intelligence Index, below 70% of tracked models (2026) — it cannot drive a search loop well enough for this.",
    ),
    dolphin: sk(
      "weak",
      "No research, browsing or tool-use benchmark exists for it. A 24B uncensored tune built for unrestricted chat, not for reading twenty sources and getting the citations right.",
    ),
    abliterated: sk(
      "weak",
      "No research benchmark for any abliterated checkpoint. The base Qwen3.5-27B scores 61% on BrowseComp (BenchLM, 1 Oct 2026) and removing the refusal behaviour also costs instruction-following, so the tune can only be worse at a task that needs careful format and sourcing.",
    ),
  },
  office: {
    fable: sk(
      "top",
      "Claude Fable 5.1 scores 61.7% on GDPval-AA, third of 117 models, Artificial Analysis board of 1 October 2026. Vals AI also puts Fable 5 and 5.1 at the top of LegalBench as of 29 September 2026, so it is strong on the legal end of professional work.",
    ),
    opus: sk(
      "top",
      "Claude Opus 5.5 is first on GDPval-AA at 67.3%, Artificial Analysis, 1 October 2026, and first on the Elo version at 1846. On Mercor's APEX-Agents it reaches 73.5%, third there.",
    ),
    sonnet: sk(
      "top",
      "Claude Sonnet 5.5 scores 67.2% on GDPval-AA, a tenth of a point behind Opus 5.5, Artificial Analysis, 1 October 2026. It is second on APEX-Agents at 75.5%, which makes it the cheapest model in the top group for this kind of work.",
    ),
    haiku: sk(
      "weak",
      "Claude Haiku 4.5 has no GDPval-AA or APEX score, so this is inferred from its nearest Anthropic sibling: Sonnet 4.6, a larger and newer model, sits last of 19 on the GDPval-AA Elo board at 1220. Haiku is built for cheap fast calls, not finished client documents.",
    ),
    gpt56sol: sk(
      "strong",
      "GPT-5.6 Sol scores 54.4% on GDPval-AA, seventeenth of 117, Artificial Analysis, 1 October 2026. It is also fifth on Mercor's APEX-1 at 73.1%, the best non-Anthropic, non-Meta result there.",
    ),
    gpt56terra: sk(
      "ok",
      "GPT-5.6 Terra scores 46.6% on GDPval-AA, twenty-seventh of 117, Artificial Analysis, 1 October 2026. Usable for a routine internal document, about 20 points behind the Claude models on finished deliverables.",
    ),
    gpt56luna: sk(
      "ok",
      "GPT-5.6 Luna scores 47.5% on GDPval-AA, twenty-fifth of 117, 1 October 2026, which is slightly ahead of the mid-tier Terra. Fine for a draft, not for the version that goes to a client.",
    ),
    gpt6astra: sk(
      "strong",
      "GPT-6 Astra scores 52.1% on GDPval-AA, twentieth of 117, Artificial Analysis, 1 October 2026. Solid professional output, though it sits below GPT-5.6 Sol on this particular measure.",
    ),
    gpt6sol: sk(
      "strong",
      "GPT-6.1 Sol scores 53.8% and GPT-6 Sol 49.3% on GDPval-AA, eighteenth and twenty-second of 117, 1 October 2026. The newer 6.1 version is the one to pick for document work.",
    ),
    gpt6luna: sk(
      "ok",
      "GPT-6 Luna scores 43.4% on GDPval-AA, thirty-third of 117, Artificial Analysis, 1 October 2026. It is the cheap tier and reads like it on longer deliverables.",
    ),
    copilot: sk(
      "ok",
      "No public benchmark exists for Microsoft 365 Copilot itself, because it routes between models rather than being one. The models behind it score 41.8% (GPT-5.5) to 54.4% (GPT-5.6 Sol) on GDPval-AA, so expect mid-pack writing, with the real advantage being that it reads the company's own Office files and so gets facts and house format right.",
    ),
    muse: sk(
      "strong",
      "Meta Muse Spark 1.3 leads Mercor's APEX-1 group at 74.0%, just behind Muse Spark 1.2 at 75.6%, on 400 hidden banking, consulting, law and medicine tasks. On GDPval-AA it is seventh of 117 at 58.6%, 1 October 2026 - very good at the expert answer, a step behind Claude at producing the finished file.",
    ),
    codex: sk(
      "weak",
      "The Codex line is tuned for writing software and was never entered on knowledge-work benchmarks; GPT-5.3 Codex has no GDPval result at all. Wrong tool for a report or a deck.",
    ),
    legacy_oai: sk(
      "ok",
      "GPT-5.5 scores 41.8% and GPT-5.4 36.6% on GDPval-AA, thirty-seventh and thirty-ninth of 117, 1 October 2026. OpenAI has claimed GPT-5.5 matches or beats industry professionals on 84.9% of GDPval tasks, but that is a vendor claim on a different scale from the independent board above, so the two numbers should not be compared.",
    ),
    grok: sk(
      "strong",
      "Grok 4.7 scores 59.8% on GDPval-AA, fifth of 117 and the best model outside Anthropic, Artificial Analysis, 1 October 2026. Grok 4.6 is close behind at 55.5%.",
    ),
    gemini_flash: sk(
      "ok",
      "Gemini 3.8 Flash scores 45.6% on GDPval-AA, twenty-ninth of 117, 1 October 2026. Vals AI does rank it second on the Finance Agent board as of 29 September 2026, so it is better at financial analysis than at general document production.",
    ),
    gemini_pro: sk(
      "ok",
      "This family is split. Gemini 3.1 Pro, the one you can use today, scores 13.8% on GDPval-AA, seventy-fifth of 117, which is poor for client documents. Gemini 4 Argon, announced 30 September 2026 and not public yet, scores 55.6% there and tops Mercor's APEX-Agents at 82.2%, so the grade should be revisited when it ships.",
    ),
    kimi: sk(
      "strong",
      "Moonshot Kimi K3 scores 51.2% on GDPval-AA, twenty-first of 117, 1 October 2026, and ninth of 19 on the Elo version at 1524. The best of the open-weight-leaning labs here after the Alibaba and Xiaomi models.",
    ),
    deepseek: sk(
      "strong",
      "DeepSeek V4.1 Flash scores 55.0% and V4 Pro 54.5% on GDPval-AA, fourteenth and sixteenth of 117, 1 October 2026. V4.1 Flash is also the reference point the whole Elo board is anchored to, at 1600.",
    ),
    glm: sk(
      "strong",
      "Z.AI GLM-5.3 scores 57.2% on GDPval-AA, ninth of 117, Artificial Analysis, 1 October 2026. That puts it ahead of every OpenAI and Google model on the board for finished deliverables.",
    ),
    qwen: sk(
      "strong",
      "Alibaba Qwen3.8 Max Preview scores 58.2% on GDPval-AA, eighth of 117, 1 October 2026. The smaller Qwen3.8-Flash-Next is also respectable at 55.6%.",
    ),
    mimo: sk(
      "strong",
      "Xiaomi MiMo-V2.6-Pro scores 58.9% on GDPval-AA, sixth of 117 and ahead of every OpenAI model on the board, Artificial Analysis, 1 October 2026. A surprise result worth checking on your own documents before trusting it.",
    ),
    minimax: sk(
      "ok",
      "MiniMax M3 scores 36.5% on GDPval-AA, fortieth of 117, 1 October 2026, and sixteenth of 19 on the Elo board at 1230. Workable for an internal draft, well behind the leaders.",
    ),
    hunyuan: sk(
      "weak",
      "Tencent Hy3 Preview scores 35.8% and the released Hy3 27.3% on GDPval-AA, forty-first and fifty-fourth of 117, 1 October 2026. It is also text-only, so it cannot produce the slide or spreadsheet file this column is about.",
    ),
    step: sk(
      "ok",
      "StepFun Step 5 Preview scores 53.3% on GDPval-AA, nineteenth of 117, but the shipping Step 3.7 Flash manages only 25.8%, fifty-seventh, both on the 1 October 2026 board. Good once the preview ships, mediocre until then.",
    ),
    hermes: sk(
      "weak",
      "Nous Hermes 4 405B does not appear on GDPval-AA or APEX at all. Its own technical report, August 2025, describes it as tuned for reasoning traces, maths and roleplay rather than professional documents, and its Llama-3.1-405B base predates every model on these boards.",
    ),
    dolphin: sk(
      "weak",
      "Dolphin Mistral 24B Venice has no score on any professional-work benchmark. It is a 24B local tune on Mistral Small 3, and reviewers note it breaks on anything needing more than 24B-class reasoning, which a client report usually does.",
    ),
    abliterated: sk(
      "weak",
      "Community abliterated checkpoints are not on GDPval-AA or APEX. The technique strips the refusal direction out of an existing small open model and costs roughly 1-3% on reasoning benchmarks, so at best they inherit a weak base and lose a little more. Picked for permissiveness, not for document quality.",
    ),
  },
  security: {
    fable: sk(
      "strong",
      "No cyber figure published for Fable. Graded from the Opus line it shares training with, so treat it as an inference, not a measurement.",
    ),
    opus: sk(
      "top",
      "Opus 5.5 reached full code execution in 73.4% of ExploitBench V8 runs and beat Mythos 5.1 on every cyber evaluation in its system card (Anthropic, 22 Sep 2026).",
    ),
    sonnet: sk(
      "ok",
      "Anthropic's Opus 5.5 system card puts Sonnet 5 more than an order of magnitude below Opus 5.5 on CyScenarioBench multi-stage attacks. Fine for reviewing code for obvious bugs, not for exploit work.",
    ),
    haiku: sk(
      "weak",
      "No published cyber evaluation for Haiku 4.5, and the larger Claude models are far ahead on every one that exists. Not its job.",
    ),
    gpt56sol: sk(
      "strong",
      "ExploitBench 78.5% (quoted in OpenAI's GPT-6 Astra system card, Sep 2026) and a self-reported 84.5% on CyberGym.",
    ),
    gpt56terra: sk(
      "ok",
      "Self-reported 81.8% on CyberGym (BenchLM board, Sep 2026). No independent cyber run found.",
    ),
    gpt56luna: sk(
      "ok",
      "Self-reported 77.9% on CyberGym (BenchLM board, Sep 2026), the lowest of the GPT-5.6 tiers.",
    ),
    gpt6astra: sk(
      "top",
      "100% on ExploitBench and 42.4% on ExploitGym, and the first model OpenAI rates Critical for cybersecurity; it found two zero-days during its own evaluation (GPT-6 Astra system card, Sep 2026).",
    ),
    gpt6sol: sk(
      "strong",
      "No separate public cyber score; OpenAI ships GPT-6.1 Sol under its trusted-access-for-cyber programme (system card addendum, Sep 2026). Graded below Astra by inference.",
    ),
    gpt6luna: sk(
      "ok",
      "No published cyber figure. Graded from the cheaper tiers of earlier GPT generations, which trail their flagships by a wide margin on every cyber table.",
    ),
    copilot: sk(
      "weak",
      "An office assistant grounded in the tenant's files. No cyber evaluation is published, and it is not built or permitted for exploit work.",
    ),
    muse: sk(
      "weak",
      "Muse Spark 1.1 self-reported 59.0% on CyberGym, the earlier Muse Spark 43.5% (BenchLM, Sep 2026), well below the field. Nothing published for 1.3.",
    ),
    codex: sk(
      "ok",
      "No cyber score published for the Codex variants. Graded from GPT-5.5, the same generation, which self-reports 81.8% on CyberGym.",
    ),
    legacy_oai: sk(
      "strong",
      "GPT-5.5 scored 41% on ExploitBench (public snapshot, May 2026), third behind two Mythos runs, and sits high on Epoch AI's independent Cybench and ExploitBench tables.",
    ),
    grok: sk(
      "ok",
      "Grok 4.7 self-reports 80.3% on CyberGym (llm-stats, Oct 2026). No independent run found.",
    ),
    gemini_flash: sk(
      "ok",
      "The separate Gemini 3.8 Flash Cyber model self-reports 86.2% on CyberGym; the plain 3.8 Flash used here has no published cyber score.",
    ),
    gemini_pro: sk(
      "strong",
      "Google gave Gemini 4 Argon to cyber defenders first and claims 68.0% on CWE-bench, tied with GPT-6 Astra (30 Sep 2026, Google's claim). Gemini 3.1 Pro sits mid-table on Epoch AI's independent cyber runs.",
    ),
    kimi: sk(
      "ok",
      "Kimi K3 is reported at 80.0% on CyberGym and 32.2% on ExploitBench in comparisons drawing on Moonshot's figures (Aug 2026); K2.6 sits in the bottom half of Epoch AI's independent cyber runs.",
    ),
    deepseek: sk(
      "ok",
      "Self-reported 83.3% (V4 Pro) and 88.1% (V4.1 Flash) on CyberGym. No independent run, so the grade stays below the measured leaders.",
    ),
    glm: sk(
      "strong",
      "Self-reported 84.5% on CyberGym and 54.4% on ExploitBench, the best of the Chinese open models; Hugging Face ran it in-house to investigate the July 2026 breach.",
    ),
    qwen: sk(
      "ok",
      "Qwen3.8-Max is reported at 78.5% on CyberGym and 28.8% on ExploitBench (Aug 2026 comparison, vendor figures).",
    ),
    mimo: sk(
      "ok",
      "Xiaomi self-reports 94.0% on CyberGym for MiMo-V2.6-Pro, the top of a board where every entry is self-reported. With no independent run to back it, the grade is held at adequate.",
    ),
    minimax: sk(
      "none",
      "No cyber evaluation of MiniMax M3 was found, self-reported or independent, and no close sibling to infer from.",
    ),
    hunyuan: sk("ok", "HY4 preview self-reports 78.4% on CyberGym (llm-stats, Oct 2026)."),
    step: sk(
      "ok",
      "Step 5 Preview self-reports 84.7% on CyberGym (BenchLM, Sep 2026). No independent run found.",
    ),
    hermes: sk(
      "weak",
      "No published cyber evaluation. A 2025-generation open model: permissive, but far behind current models on capability.",
    ),
    dolphin: sk(
      "weak",
      "A 24B community tune with no cyber evaluation. Willing to talk about security, not able to do the work well.",
    ),
    abliterated: sk(
      "weak",
      "Removing refusals does not add skill: these are mid-size open bases with no cyber evaluation, well below the frontier.",
    ),
  },
  health: {
    fable: sk(
      "strong",
      "Claude Fable 5.1 at maximum effort scored 62.1% on HealthBench Professional (74.2% before the length adjustment), Anthropic system card dated 1 Sep 2026. In the independent clinician-run HealthBench-Psych study of 25 Aug 2026 Fable 5 got 0.591, sixth of eighteen models and a little below Opus 5.",
    ),
    opus: sk(
      "top",
      "Claude Opus 5.5 scored 68.1% and Opus 5 67.1% on the raw HealthBench board (benchlm.ai, 1 Oct 2026), second and third of the models listed. Opus 5 also came first on the hardest independent slice, 0.415 on HealthBench-Psych-Hard, ahead of Kimi K2.6 and GPT-5.5 (Beth Israel study, 25 Aug 2026).",
    ),
    sonnet: sk(
      "top",
      "Claude Sonnet 5.5 leads the raw HealthBench board at 69.4% and the Professional board at 69.2% (both 1 Oct 2026), the best numbers on this page. The older Sonnet 5 was mid-table in the independent psych study at 0.533, so the 5.5 jump is the whole story and it rests on Anthropic's own reported figures.",
    ),
    haiku: sk(
      "weak",
      "Claude Haiku 4.5 with thinking on scored 79.6% on Vals AI's independent MedQA run (16 Apr 2026), 74th of 95 models and about 16 points under the frontier on a test most strong models pass at 95%. It also sat near the bottom of HealthBench-Psych at 0.441 (25 Aug 2026). Fine for looking things up, not for advice.",
    ),
    gpt56sol: sk(
      "strong",
      "GPT-5.6 Sol scored 64.1% on HealthBench Professional (OpenAI system card, 3 Sep 2026), third on that board, and leads the HealthBench Consensus board at 0.955. In the independent psych study it got 0.610, fifth, statistically tied with the top group.",
    ),
    gpt56terra: sk(
      "strong",
      "GPT-5.6 Terra scored 62.4% on HealthBench Professional and 32.7% on HealthBench Hard (OpenAI system card, 3 Sep 2026), under two points behind its bigger sibling Sol on the professional test. Nothing independent has measured Terra on health.",
    ),
    gpt56luna: sk(
      "ok",
      "GPT-5.6 Luna scored 59.8% on HealthBench Professional and 32.0% on HealthBench Hard (OpenAI system card, 3 Sep 2026) — about four points behind Sol on the professional test while being the cheap tier. No independent health measurement exists for it.",
    ),
    gpt6astra: sk(
      "strong",
      "GPT-6 Astra tops HealthBench Professional at 69.5% (OpenAI system card, 3 Sep 2026) and is third on HealthBench Hard at 36.6%. But on the raw HealthBench board it scored 56.9%, over ten points behind the Claude models (benchlm.ai, 1 Oct 2026), so its standing depends on which subset you look at.",
    ),
    gpt6sol: sk(
      "strong",
      "The two Sol versions split badly: GPT-6.1 Sol scored 56.7% raw HealthBench and 36.2% on Hard (second place there), while plain GPT-6 Sol managed 47.1% raw and 30.1% Hard — the weakest of the GPT-6 line (benchlm.ai and llm-stats, 1-2 Oct 2026). Use 6.1 if you have the choice.",
    ),
    gpt6luna: sk(
      "ok",
      "GPT-6 Luna scored 50.0% on the raw HealthBench board and 31.4% on Hard (benchlm.ai and llm-stats, 1-2 Oct 2026). That puts it mid-pack: ahead of GPT-6 Sol, roughly 19 points under Claude Sonnet 5.5 on the raw test. All of it is self-reported.",
    ),
    copilot: sk(
      "ok",
      "No HealthBench or MedQA number has been published for Microsoft 365 Copilot's Think Deeper, so this is a judgement, not a measurement. Microsoft says Copilot Health was built with an external panel of over 230 physicians and promotes answers from recognised health bodies in 50 countries (microsoft.ai, Mar 2026), which helps sourcing but does not tell you how it reasons on a hard case.",
    ),
    muse: sk(
      "strong",
      "Meta's Muse Spark leads HealthBench Hard at 42.8%, nearly three points clear of GPT-5.4 (llm-stats, 2 Oct 2026) — the hardest subset and the one where everyone scores low. It is weaker elsewhere: 59.3% on Professional and sixth at 36.8 on the healthcare composite. The Hard figure is Meta's own.",
    ),
    codex: sk(
      "weak",
      "Not its job. GPT-5.x Codex is tuned for writing code and no health benchmark reports it. Inferred from the same lab's general models rather than measured: route health questions to GPT-5.6 Sol or GPT-6 Astra instead, which are the OpenAI models that were actually tested.",
    ),
    legacy_oai: sk(
      "strong",
      "The older OpenAI models hold up unusually well here. GPT-5.5 came second in the independent clinician study at 0.624 and first on MedBench v5's atomic medical skills at 81.22 (arXiv, Jun 2026); GPT-5.4 is second on HealthBench Hard at 40.1%, and o3 scored 59.9% on HealthBench in an independent run. Cheap and still competitive on health.",
    ),
    grok: sk(
      "strong",
      "Grok 4.5 came fourth in the independent clinician-run psych study at 0.612, inside the top statistical group (25 Aug 2026), and Grok 4.20 scored 94.6% on Vals AI's MedQA. The catch is HealthBench Hard, where Grok 4.20 managed only 20.3% (llm-stats, 2 Oct 2026) — fine on ordinary questions, shaky on the hard ones.",
    ),
    gemini_flash: sk(
      "strong",
      "Gemini 3.6 Flash scored 0.578 in the independent psych study, seventh of eighteen and ahead of Kimi K3 (25 Aug 2026), and Gemini 3 Flash Preview hit 95.8% on Vals AI's MedQA. Strong for a cheap fast model, though Google has published no HealthBench figure for it.",
    ),
    gemini_pro: sk(
      "strong",
      "Gemini 3.1 Pro scored 96.4% on Vals AI's independent MedQA run (third of 95 models, 16 Apr 2026) and 68.6 on MedBench v5's clinical reasoning track, third behind Claude Opus 4.7 and Qwen. Its weak spot is HealthBench Hard at 20.6%. Gemini 4 Argon, announced 30 Sep 2026, has no health numbers yet.",
    ),
    kimi: sk(
      "strong",
      "Kimi K2.6 came first in the independent clinician-run HealthBench-Psych study at 0.627, ahead of GPT-5.5 and Claude Opus 5 (Beth Israel, 25 Aug 2026), and fourth on MedBench v5's clinical reasoning at 68.19. Note the newer K3 scored lower, 0.568, so the upgrade went backwards on health.",
    ),
    deepseek: sk(
      "ok",
      "DeepSeek V4 Pro scored 0.554 in the independent psych study, ninth of eighteen (25 Aug 2026), and last of the seven models on MedBench v5's clinical reasoning track at 65.86. V4.1 Flash's sibling V4 Flash came in just below at 0.538. Competent, not a first choice.",
    ),
    glm: sk(
      "ok",
      "GLM-5.1 scored 67.70 on MedBench v5's clinical reasoning track, fifth of seven (arXiv, Jun 2026), and GLM 5 Thinking got 94.3% on Vals AI's MedQA. Nothing has been measured for GLM-5.3 on health, so this is inferred from the version before it.",
    ),
    qwen: sk(
      "top",
      "Qwen takes the first five places on llm-stats' healthcare composite, which averages 248 models over 48 health benchmarks — Qwen3.7 Max leads at 44.8 (1 Oct 2026). Qwen3.8 Max reports 60.2% on HealthBench (Alibaba's own figure, 12 Aug 2026), and on the plants side Qwen3-VL-235B identified medicinal plants from photographs at 90.5%, the best of five models tested, against GPT-4o's 85% (Frontiers in Plant Science, 2026).",
    ),
    mimo: sk(
      "none",
      "No defensible grade. Xiaomi's MiMo-V2.6-Pro appears on no health benchmark found here — not HealthBench, not MedQA, not MedBench v5 — and no close sibling has been measured either, so there is nothing to infer from.",
    ),
    minimax: sk(
      "ok",
      "MiniMax M2.5 scored 92.5% on Vals AI's independent MedQA run, 31st of 95 models (16 Apr 2026), on a test where the leaders reach 96%. The current M3 has no health measurement, so this grade comes from the previous version.",
    ),
    hunyuan: sk(
      "none",
      "No defensible grade. Tencent's Hunyuan HY3 and the HY4 preview do not appear on HealthBench, MedQA or MedBench v5 in anything found here, and Tencent has published no medical evaluation for them.",
    ),
    step: sk(
      "none",
      "No defensible grade. StepFun's Step 3.7 and Step 5 are absent from every health leaderboard checked, including the 95-model Vals MedQA run and the 248-model healthcare composite, and no sibling model gives a basis for inferring.",
    ),
    hermes: sk(
      "weak",
      "Hermes 4 405B scored 72.8% on MedQA, about 22 points under the frontier models on a test they pass at roughly 95%. It is also tuned to refuse far less, so it will answer a question about dosing or an interaction with the same confidence whether or not it is right — the wrong combination for medical advice.",
    ),
    dolphin: sk(
      "weak",
      "No health benchmark reports Dolphin Mistral 24B Venice, so this is inferred from what it is: a 24B uncensored tune, far below the models that were measured, deliberately stripped of the caution that HealthBench's rubrics reward. The same-size Mistral Small scored 0.36 in the independent psych study, near the bottom.",
    ),
    abliterated: sk(
      "weak",
      "No medical numbers exist for community abliterated checkpoints. What has been measured is the side effect: with thinking off, refusal on seven harmful-prompt benchmarks falls from 64-99% on the base model to 0-6% after abliteration. On health questions that removes the 'see a doctor' answer, which is exactly what the physician rubrics score.",
    ),
  },
};

function withVerticals(core: CoreSkills, fam: VerticalFamily): Record<SkillKey, SkillCell> {
  return {
    ...core,
    shell: SC_VERTICAL_CELLS.shell[fam],
    ml: SC_VERTICAL_CELLS.ml[fam],
    cad: SC_VERTICAL_CELLS.cad[fam],
    research: SC_VERTICAL_CELLS.research[fam],
    office: SC_VERTICAL_CELLS.office[fam],
    security: SC_VERTICAL_CELLS.security[fam],
    health: SC_VERTICAL_CELLS.health[fam],
  };
}

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
      skills: withVerticals(ABLITERATED_SKILLS, "abliterated"),
      topics: ABLITERATED_TOPICS,
    },
  },
  {
    match: /hermes/i,
    entry: {
      bloc: "OSS",
      best: "Neutrally aligned by design — the most permissive model on a mainstream pay-per-use endpoint",
      skills: withVerticals(HERMES_SKILLS, "hermes"),
      topics: HERMES_TOPICS,
    },
  },
  {
    match: /dolphin|venice/i,
    entry: {
      bloc: "OSS",
      best: "Explicitly uncensored Mistral-Small-24B tune, built with Venice.ai for unfiltered creative work",
      skills: withVerticals(DOLPHIN_SKILLS, "dolphin"),
      topics: DOLPHIN_TOPICS,
    },
  },
  // ── Anthropic (US) ──
  {
    match: /fable/i,
    entry: {
      bloc: "US",
      best: "Autonomous software engineering — SWE-bench Verified 95%",
      skills: withVerticals(FABLE_SKILLS, "fable"),
      topics: ANTHROPIC_TOPICS,
    },
  },
  {
    match: /opus/i,
    entry: {
      bloc: "US",
      best: "Long-horizon agentic work · engineering judgment (Opus 5 tops OckBench)",
      skills: withVerticals(OPUS_SKILLS, "opus"),
      topics: ANTHROPIC_TOPICS,
    },
  },
  {
    match: /sonnet/i,
    entry: {
      bloc: "US",
      best: "Balanced coding · precise instruction following · hardest to jailbreak (CASI 93.08)",
      skills: withVerticals(SONNET_SKILLS, "sonnet"),
      topics: ANTHROPIC_TOPICS,
    },
  },
  {
    match: /haiku/i,
    entry: {
      bloc: "US",
      best: "Fast cheap drafts · classification · routing",
      skills: withVerticals(HAIKU_SKILLS, "haiku"),
      topics: ANTHROPIC_TOPICS,
    },
  },
  // ── OpenAI family (US): sol/terra/luna tiers, 5.5, 5.4, codex variants, o3 ──
  {
    match: /5\.6-sol/i,
    entry: {
      bloc: "US",
      best: "Deepest reasoning tier — math · science · proof-style tasks",
      skills: withVerticals(SOL_SKILLS, "gpt56sol"),
      topics: OPENAI_TOPICS,
    },
  },
  {
    match: /5\.6-terra/i,
    entry: {
      bloc: "US",
      best: "Reasoning × speed balance",
      skills: withVerticals(TERRA_SKILLS, "gpt56terra"),
      topics: OPENAI_TOPICS,
    },
  },
  {
    match: /5\.6-luna/i,
    entry: {
      bloc: "US",
      best: "High-volume everyday tasks · cheapest tier",
      skills: withVerticals(LUNA_SKILLS, "gpt56luna"),
      topics: OPENAI_TOPICS,
    },
  },
  // ── OpenAI GPT-6 (Astra 2026-09-03; Sol and Luna 2026-09-22) ──
  // THESE MUST SIT ABOVE THE /codex/ RULE. The configured ids carry the provider
  // prefix, so "openai-codex/gpt-6-sol" CONTAINS "codex": put these below and the
  // Codex harness row would claim all three GPT-6 tiers and paint a code-specialist
  // profile on a general flagship. Same ordering hazard as the abliterated rows at
  // the top of this list, one rule further down the file.
  {
    match: /gpt-6-astra/i,
    entry: {
      bloc: "US",
      best: "OpenAI's flagship — first on WebDev Arena at 1793 Elo, and second on the AA-Omniscience knowledge index",
      skills: withVerticals(GPT6_ASTRA_SKILLS, "gpt6astra"),
      topics: OPENAI_TOPICS,
    },
  },
  {
    match: /gpt-6-sol/i,
    entry: {
      bloc: "US",
      best: "Agents' Last Exam 56.4% at max — ahead of Opus 5's best recorded score at 60% lower cost per task",
      skills: withVerticals(GPT6_SOL_SKILLS, "gpt6sol"),
      topics: OPENAI_TOPICS,
    },
  },
  {
    match: /gpt-6-luna/i,
    entry: {
      bloc: "US",
      best: "Prior-generation flagship capability at roughly a tenth of the price, with the full 1.05M window",
      skills: withVerticals(GPT6_LUNA_SKILLS, "gpt6luna"),
      topics: OPENAI_TOPICS,
    },
  },
  // Microsoft 365 Copilot, NOT GitHub Copilot. An OpenAI reasoning model behind
  // Microsoft's Responsible-AI layer, reached through a shared browser tab on the
  // work tenant — so the refusal profile is OpenAI's policy PLUS a second filter
  // this dossier has not separately characterised.
  {
    match: /copilot/i,
    entry: {
      bloc: "US",
      best: "An OpenAI reasoning model grounded in the tenant's own files and Bing — strongest where the data already lives in Office",
      skills: withVerticals(COPILOT_SKILLS, "copilot"),
      topics: COPILOT_TOPICS,
    },
  },
  // ── Meta (US) ──
  {
    match: /muse|meta\//i,
    entry: {
      bloc: "US",
      best: "Near-total lead on long context — 98.5% and 98.1% on the two MRCR bands — plus DeepSWE 75.4%",
      skills: withVerticals(MUSE_SKILLS, "muse"),
      topics: META_TOPICS,
    },
  },
  {
    match: /codex/i,
    entry: {
      bloc: "US",
      best: "Coding-specialized variant",
      skills: withVerticals(CODEX_SKILLS, "codex"),
      topics: OPENAI_TOPICS,
    },
  },
  {
    match: /\bo3\b|gpt-5|gpt-4/i,
    entry: {
      bloc: "US",
      best: "General-purpose (legacy generations: broad, no single crown)",
      skills: withVerticals(LEGACY_OAI_SKILLS, "legacy_oai"),
      topics: OPENAI_TOPICS,
    },
  },
  // ── xAI (US) ──
  {
    match: /grok|xai/i,
    entry: {
      bloc: "US",
      best: "Real-time world knowledge · long-context reasoning · loosest US guardrails",
      skills: withVerticals(GROK_SKILLS, "grok"),
      topics: XAI_TOPICS,
    },
  },
  // ── Google (US) ──
  {
    match: /gemini.*flash/i,
    entry: {
      bloc: "US",
      best: "Fast multimodal · long-context retrieval",
      skills: withVerticals(GEMINI_FLASH_SKILLS, "gemini_flash"),
      topics: GOOGLE_TOPICS,
    },
  },
  {
    match: /gemini/i,
    entry: {
      bloc: "US",
      best: "Multimodal reasoning · long context",
      skills: withVerticals(GEMINI_PRO_SKILLS, "gemini_pro"),
      topics: GOOGLE_TOPICS,
    },
  },
  // ── Chinese camp — note the differentiator is NOT a bloc property ──
  {
    match: /kimi|moonshot/i,
    entry: {
      bloc: "CN",
      best: "Cost-efficient agentic tool use · top open-weight on OckBench · least politically filtered Chinese model",
      skills: withVerticals(KIMI_SKILLS, "kimi"),
      topics: KIMI_TOPICS,
    },
  },
  {
    match: /deepseek/i,
    entry: {
      bloc: "CN",
      best: "Ultra-cheap fast reasoning (flash) · strong open-weight reasoning line",
      skills: withVerticals(DEEPSEEK_SKILLS, "deepseek"),
      topics: DEEPSEEK_TOPICS,
    },
  },
  {
    match: /glm|zhipu|z-ai/i,
    entry: {
      bloc: "CN",
      best: "Chinese–English bilingual · tool calling — the model Hugging Face ran in-house to investigate the July 2026 breach",
      skills: withVerticals(GLM_SKILLS, "glm"),
      topics: GLM_TOPICS,
    },
  },
  {
    match: /qwen|alibaba/i,
    entry: {
      bloc: "CN",
      best: "Agentic computer-use + coding (vendor claim, 2026 launch) · multilingual · strictest Chinese family on criminal content",
      skills: withVerticals(QWEN_SKILLS, "qwen"),
      topics: QWEN_TOPICS,
    },
  },
  // ── Chinese labs added 2026-09-23. Safe at the end of the list: none of these ids
  //    contains "qwen", "glm", "kimi" or "deepseek", so no earlier rule claims them.
  {
    match: /mimo|xiaomi/i,
    entry: {
      bloc: "CN",
      best: "The strongest open-weight model on the board — MIT licence, 1.02T sparse MoE, reportedly $3M to train",
      skills: withVerticals(MIMO_SKILLS, "mimo"),
      topics: MIMO_TOPICS,
    },
  },
  {
    match: /minimax/i,
    entry: {
      bloc: "CN",
      best: "Fastest first token here (0.92 s) and a frontier IFBench score from a model seventeen index points off the pace",
      skills: withVerticals(MINIMAX_SKILLS, "minimax"),
      topics: MINIMAX_TOPICS,
    },
  },
  {
    match: /hunyuan|\bhy3\b|tencent/i,
    entry: {
      bloc: "CN",
      best: "A pure reasoning and agentic model — GPQA 90.4%, IMO-AnswerBench 90.0% — and completely blind, by design",
      skills: withVerticals(HUNYUAN_SKILLS, "hunyuan"),
      topics: HUNYUAN_TOPICS,
    },
  },
  {
    match: /stepfun|\bstep-?5\b/i,
    entry: {
      bloc: "CN",
      best: "Top-three open weights at 600B/27B active, with native image and video input — weights promised 2026-10-15, not yet published",
      skills: withVerticals(STEP_SKILLS, "step"),
      topics: STEP_TOPICS,
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
  "Slurs and dehumanising propaganda aimed at a group — though nearly every model will still analyse and quote hate speech in research",
  "Content that promotes or glamorises suicide, self-harm or disordered eating — narrower than refusing to DISCUSS them, which is where the models diverge sharply",
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
    body: "US models are trained off INFLUENCING politics (campaigning, election persuasion); Chinese models off CRITICIZING power (CCP legitimacy, sovereignty). Both camps politicize refusals — in opposite directions, and each camp's blind spot is the other's specialty. The HOT-BUTTON column is the third corner: abortion, gender, race and Israel–Palestine trip nothing in Chinese regulation, so Chinese models answer contested WESTERN politics more readily than the US labs that live there.",
  },
  {
    title: "The OSS rows lift a lot — and nothing at the top",
    body: "Hermes 4 405B, the most permissive model on a mainstream pay-per-use endpoint, answers 57.1% of RefusalBench's 166 refusal-prone prompts against roughly 17% for GPT-4o and Claude Sonnet. It still declines ~43%. What lifts: over-refusal, dual-use security work, frank medical and legal talk, adult and dark fiction, taking a side. What does not: CSAM (enforced at the provider and legal layer, not the weights), real CBRN capability (the knowledge was never in the base, so past the refusal you get confident regurgitation), and — on abliterated Chinese bases — the political filtering, which is a different circuit from the English safety direction the technique removes. Provider terms still govern the account regardless of what the weights will say.",
  },
  {
    title: "Refusing on paper ≠ holding under pressure",
    body: "The CASI jailbreak-resilience index (Jul 2026) splits models more sharply than policy does: Claude Sonnet 5 93.08, Qwen3.5-397B 81.13, MiMo-V2.5 73.80, GLM-5.2 46.58. A ■ in this table means trained refusal, not a guarantee it survives contact with a determined prompt.",
  },
  {
    title: "The SERVICE draws the line, not only the model",
    body: "The Copilot row is the same OpenAI model family as the GPT rows and a STRICTER row than them, which is the cleanest proof in this table that refusal is a property of what you are talking TO rather than of the weights. Microsoft stacks four severity-scored classifiers (hate, sexual, violence, self-harm) over the model, adds optional protected-material, PII and jailbreak filters, screens the completion as well as the prompt, and hands the off switch only to customers approved through a Limited Access Review. The same question can be answered by GPT on OpenAI's own API and blocked on an employer's Copilot seat.",
  },
  {
    title: "Copyright is a filter, not a conscience",
    body: "Ask for song lyrics and the refusal you meet depends on the plumbing. Anthropic and OpenAI train the reluctance into the model — the Model Spec names lyrics outright. Microsoft instead runs a Protected Material classifier over the OUTPUT, matching known text (lyrics, articles, recipes) and known public-repository source code; using the code one can be REQUIRED for its Customer Copyright Commitment. Self-hosted open weights have neither, so what comes back is bounded only by what the base memorised.",
  },
  {
    title: "Beijing regulates OVER-refusal too",
    body: "The stereotype misses half the standard. TC260-003 §9.4 sets BOTH bounds for a filed Chinese service: sample at least 300 questions the model should refuse and it must refuse at least 95%; sample at least 300 it should NOT refuse and it must refuse no more than 5%. A Chinese service can fail its compliance test for being too cautious. No US lab policy puts a ceiling on refusal at all — one reason over-refusal keeps surfacing as a US problem, as Hugging Face found when its incident responders were declined.",
  },
  {
    title: "Self-harm: the column where refusing is not obviously the safer answer",
    body: "Every policy here bars glamorising suicide, self-harm and disordered eating, then they part company on whether to TALK about them. Google names 'facilitates self-harm' flatly and Gemini reaches for the hotline fastest. OpenAI's Model Spec pulls both ways on purpose: 'do not encourage self-harm' is root-level while 'support users in mental health discussions' is user-level. Anthropic bars promotion and glamorisation, leaving discussion open. Microsoft does not leave it to the model at all — a self-harm prompt can be rejected with an HTTP 400 before any model sees it. A person at 3am meets four different products.",
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
//     — the seven unmeasured columns listed in the panel note; no recent public table — does the
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
const SD_DOMAIN_KEYS: ReadonlySet<string> = new Set<TaskDomain>(TASK_DOMAINS);

/** The TaskDomain a column measures, or undefined for SPEED and COST. */
export function sdDomainOf(key: SkillKey): TaskDomain | undefined {
  return SD_DOMAIN_KEYS.has(key) ? (key as TaskDomain) : undefined;
}

const sdPct = (p: number): string => `${Math.round(p * 100)}`;

/**
 * The MEASURED percentile, drawn.
 *
 * A bar plus the number, under the grade glyph, for the one reason a bar beats a number
 * here: a column of numbers has to be read, a column of bars has a SHAPE. Emitted ONLY
 * where Epoch AI actually ran the family in that domain — an empty track everywhere else
 * would say "measured zero", which is the opposite of "not measured".
 *
 * Deliberately carries NO `data-tip`: the percentile is already in the cell's tooltip
 * (scMeasuredLine), a second one would sit on top of the first, and the test suite counts
 * tooltips by splitting on `data-tip=`. The width is an inline style because the export
 * scrapes rendered DOM + CSS and a per-cell value has nowhere else to live.
 */
function sdMeter(s: DomainStrength | undefined): string {
  if (s === undefined) return "";
  const pct = sdPct(s.p);
  return (
    `<span class="sd-meter"><i style="width:${pct}%"></i></span>` +
    `<span class="sd-pnum">p${pct}</span>`
  );
}

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

// ── PLACES 1–5 PER COLUMN (FORK 2026-10-02, the architect: "the capability table is hard to read
// at a glance. Make the rankings more visible ... which one is first, second, third ...
// maybe stop at 5th? ... a gradient from background color to whatever other color").
//
// Before this, the cell wash followed the GRADE, and a four-step grade over 50 models put
// gold on half the grid: "who is best at CAD" had one answer (a 6.5px "1") and no second
// or third. Now each column's configured models are PLACED in the order a click on that
// header already produces, and the top five get a numbered badge and a wash that fades
// from gold at 1st to the plain cell at 6th. The grade glyph still says how good; the
// place says who to try first, second, third.
//
// FIVE, not seven: five steps of one hue stay tellable apart on the dark card; at seven,
// neighbours blur and the number has to do all the work. Ties share a place (1, 2, 2, 4),
// so two routes to the same model never pretend one beats the other.

/** How many places per column get a badge and a wash. */
export const SD_RANKED_PLACES = 5;

export type DossierPlace = { row: DossierRow; place: number; strength?: DomainStrength };

/**
 * One column's CONFIGURED rows, best first, in the order a click on its header gives
 * (attachDossierSort): measured Epoch AI percentile, with unmeasured rows below every
 * measured one; then the grade; then the AA index. Equal on all three = the same place.
 * Reference rows are shown, not wired, and are never placed.
 */
export function scColumnOrder(rows: DossierRow[], key: SkillKey): DossierPlace[] {
  const domain = sdDomainOf(key);
  const keyed = rows
    .filter((r) => !r.reference)
    .map((row) => {
      const strength = domain === undefined ? undefined : domainStrengthFor(row.id, domain);
      return {
        row,
        strength,
        p: strength?.p ?? -1,
        g: SC_SKILL_RANK[scDossierFor(row.id)?.skills[key].v ?? "weak"],
        i: row.index ?? -1,
      };
    })
    .sort((a, b) => b.p - a.p || b.g - a.g || b.i - a.i);
  let place = 0;
  return keyed.map((k, n) => {
    const prev = keyed[n - 1];
    if (prev === undefined || prev.p !== k.p || prev.g !== k.g || prev.i !== k.i) place = n + 1;
    return { row: k.row, place, strength: k.strength };
  });
}

/**
 * The single best CONFIGURED row for one column: the first of scColumnOrder, so the gold
 * "1" and the top row after a header click are the same model by construction. Measured
 * when that row has an Epoch run in the column's domain (which it does whenever ANY
 * configured row has one, because unmeasured rows sort below measured ones); judged
 * otherwise. Undefined only when there are no configured rows at all.
 */
export function scBestBySkill(rows: DossierRow[], key: SkillKey): DossierBest | undefined {
  const top = scColumnOrder(rows, key)[0];
  if (top === undefined) return undefined;
  return top.strength !== undefined
    ? { row: top.row, basis: "measured", strength: top.strength }
    : { row: top.row, basis: "judged" };
}

/** The mark on the best cell — the file's existing `<sup>` grammar (SD_JUDGED_MARK), no new colour. */
export const SD_BEST_MARK = `<sup class="sd-best-mark">1</sup>`;

/**
 * The numbered badge for places 1–5, set AFTER the grade chip (the chip has to stay the
 * cell's first child: the best-cell selector in the tests and the exporter key on it).
 * The best cell's badge keeps the `sd-best-mark` class, so there is still exactly one
 * per column; a row tied with it for 1st gets the same number without the class.
 */
function sdPlaceMark(place: number, isBest: boolean): string {
  return `<sup class="sd-rk sd-rk-${place}${isBest ? " sd-best-mark" : ""}">${place}</sup>`;
}

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
/** The AA index as every table in this panel prints it; "—" = AA publishes no score. */
function sdIdxText(index: number | undefined): string {
  return index === undefined ? "—" : Number.isInteger(index) ? `${index}` : index.toFixed(1);
}

export function renderDossierTable(
  rows: DossierRow[],
  thalamus?: DossierThalamus,
  opts?: { biasIdx?: number },
): string {
  const idx = (r: DossierRow) => r.index ?? -1;
  // One best per column, decided over the CONFIGURED rows only, before the reference
  // rows are appended — they are shown, not wired, and never win a column.
  const bestBySkill = new Map<SkillKey, DossierBest | undefined>();
  // Places 1–5 per column, from the same order (scColumnOrder), so badge and best agree.
  const placeBySkill = new Map<SkillKey, Map<string, number>>();
  for (const s of SC_SKILLS) {
    bestBySkill.set(s.key, scBestBySkill(rows, s.key));
    placeBySkill.set(
      s.key,
      new Map(scColumnOrder(rows, s.key).map((o) => [o.row.id, o.place] as [string, number])),
    );
  }
  const placedOutOf = rows.filter((r) => !r.reference).length;
  const routesStrip = opts === undefined ? "" : renderThalamusRoutes(rows, opts.biasIdx);
  // Reference rows always follow the configured set, then sort with everything
  // else once the user clicks a subject header.
  const sorted = [...rows].sort((a, b) => idx(b) - idx(a)).concat(SC_REFERENCE_ROWS);
  // TWO TABLES (the architect 2026-10-02: "The capacity matrix with who does what best and what is
  // censored overflows on the right ... create two separate matrices, one for tasks and the
  // other for censored stuff"). Same rows in the same order, one body per table: `body` is
  // the capability table and carries data-index/data-ranks for sorting; `censBody` is the
  // refusal table and carries neither, so the exporter's row count and the page's sort
  // script (both read `.sd-table tr[data-index]`) see exactly what they saw before.
  let body = "";
  let censBody = "";
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
      const place = r.reference ? undefined : placeBySkill.get(s.key)?.get(r.id);
      const placed = place !== undefined && place <= SD_RANKED_PLACES;
      const placeClass = placed ? ` sd-rank sd-rank-${place}` : "";
      const bestMark = placed ? sdPlaceMark(place, isBest) : isBest ? SD_BEST_MARK : "";
      const placeLine =
        place === undefined
          ? ""
          : `PLACE ${place} of ${placedOutOf} in ${s.label} — the order a click on the header gives.\n\n`;
      const bestLine = (best !== undefined && isBest ? sdBestCellLine(best) : "") + placeLine;
      if (!cell) {
        // No dossier entry: "?" as before — but a measurement is still a measurement,
        // so a measured (or best) hole says so on hover rather than staying mute.
        const holeTip =
          strength === undefined && !isBest && !placed
            ? ""
            : ` data-tip="${esc(
                `${bestLine}${r.name} · ${s.label} — NO DOSSIER ENTRY, no judged grade.` +
                  `${scMeasuredLine(strength)}\n\n${scSkillBasisLine(s)}`,
              )}"`;
        skillCells +=
          `<td class="sd-cap${placeClass}" data-col="${s.key}"${pAttr}>` +
          `<span class="sd-tag sd-s-none${bestClass}"${holeTip}>?</span>${bestMark}` +
          sdMeter(strength) +
          `</td>`;
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
      // WASH (FORK 2026-10-02): the cell wash now follows the PLACE, not the grade — gold
      // at 1st fading to the plain cell at 6th — so "who is first, second, third" reads
      // down a column at a glance. Still one gold hue: capability stays ORDINAL and
      // censorship stays CATEGORICAL red, and the two grids cannot be read as one scale.
      skillCells +=
        `<td class="sd-cap${placeClass}" data-col="${s.key}"${pAttr}>` +
        `<span class="sd-tag sd-s-${cell.v}${bestClass}"${caveatStyle}` +
        ` data-tip="${esc(tip)}">${SC_SKILL_GLYPH[cell.v]}</span>${bestMark}` +
        sdMeter(strength) +
        `</td>`;
    }
    let cells = "";
    for (const t of SC_TOPICS) {
      const cell = entry?.topics[t.key];
      if (!cell) {
        cells += `<td class="sd-cens sd-lock-none"><span class="sd-tag sd-v-none">?</span></td>`;
        continue;
      }
      const tip =
        `${r.name} · ${t.label} — ${SC_VERDICT_LABEL[cell.v].toUpperCase()}\n\n${cell.tip}` +
        scTopicFactLine(t.key, facts);
      cells +=
        `<td class="sd-cens sd-lock-${cell.v}" aria-label="${esc(`${t.label}: ${SC_VERDICT_LABEL[cell.v]}`)}">` +
        `<span class="sd-tag sd-v-${cell.v}" data-tip="${esc(tip)}">` +
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
    const shown = sdIdxText(r.index);
    // "" unless a candidate set was supplied AND this model is inside it, so the
    // one-argument call emits exactly what it always emitted.
    const thal = thalamusBadge(r.id, thalamus);
    const modelCell =
      `<td class="sd-model" data-tip="${esc(nameTip)}">` +
      `${mark}${esc(r.name)} ` +
      `<span class="sd-idx">${shown}</span>` +
      (r.reference ? `<span class="sd-refbadge">not wired</span>` : "") +
      thal +
      `</td>` +
      `<td><span class="sd-bloc ${blocClass}">${bloc}</span></td>`;
    body +=
      `<tr class="${r.reference ? "sd-ref" : ""}" data-index="${idx(r)}" ` +
      `data-ranks="${esc(JSON.stringify(ranks))}">` +
      modelCell +
      skillCells +
      `</tr>`;
    censBody += `<tr class="${r.reference ? "sd-ref" : ""}">` + modelCell + cells + `</tr>`;
  }

  // The JUDGED mark is appended AFTER the escaped label, deliberately: the test
  // suite asserts `html` contains `>LABEL<`, which survives only because the label
  // is plain ASCII and the mark follows it. A label containing & < > or " would be
  // transformed by esc() and that assertion would stop matching.
  // The GOOD AT line rides INSIDE the same <th>, not in a third header row: a third
  // sticky row would need its own `top` offset and would push the table down for every
  // reader, including the ones who already know what SWE-bench is. The short phrase is
  // the glance; `about` is the sentence, on hover.
  const skillHeads = SC_SKILLS.map(
    (s) =>
      `<th class="sd-cap-h" data-sort="${s.key}" ` +
      `data-tip="${esc(
        `${s.label} — GOOD AT: ${s.goodAt}.\n\n${s.about}\n\n${scSkillBasisLine(s)}` +
          sdBestHeaderLine(s, bestBySkill.get(s.key)) +
          `\n\nClick to rank every model by this subject` +
          (sdDomainOf(s.key) === undefined
            ? " — this column is not a THALAMUS task domain, so the grade decides."
            : " — measured Epoch AI percentile first, then grade, then AA index."),
      )}">` +
      `<span class="sd-cap-lab">${esc(s.label)}${s.grading === "judged" ? SD_JUDGED_MARK : ""}</span>` +
      `<span class="sd-cap-sub">${esc(s.goodAt)}</span></th>`,
  ).join("");

  const topicHeads = SC_TOPICS.map(
    (t) =>
      `<th class="sd-cens-h" data-tip="${esc(
        `${t.label} — ${t.about}\n\nClick to rank every model by this subject`,
      )}">` +
      `<span class="sd-cens-lab">${esc(t.label)}</span>` +
      `<span class="sd-cens-sub">${esc(SC_TOPIC_PLAIN[t.key])}</span></th>`,
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

  // Counted from the data, never typed: the footnote said "the four that clear that bar" and
  // "seven of the fifteen" until 2026-10-02, and both went false the day columns were added.
  const anchoredLabels = SC_SKILLS.filter((s) => s.grading === "anchored").map((s) => s.label);
  const domainCols = SC_SKILLS.filter((s) => sdDomainOf(s.key) !== undefined);
  const unmeasuredLabels = domainCols
    .filter(
      (s) => !Object.values(DOMAIN_STRENGTH).some((f) => f[s.key as TaskDomain] !== undefined),
    )
    .map((s) => s.label);
  return (
    `<h3 class="sd-sec-h">CAPABILITY — one column per job, so the router can pick the model by task</h3>` +
    `<div class="sd-legend"><span class="sd-leg-k sd-leg-k-cap">CAPABILITY</span>${skillLegend}` +
    // What the CELL WASH means. The glyphs above say what each grade IS; without this
    // the colour behind them is decoration the reader has to guess at, and the whole
    // point of washing the cell was to make the table readable at a glance.
    `<span class="sd-leg-ramp sd-leg-places">PLACES in each column ` +
    Array.from(
      { length: SD_RANKED_PLACES },
      (_, n) => `<span class="sd-leg-place sd-rank-${n + 1}">${sdPlaceMark(n + 1, false)}</span>`,
    ).join("") +
    ` the deeper the GOLD, the higher it places · past ${SD_RANKED_PLACES}th the cell stays plain · ` +
    `the censorship table below uses RED, so the two never read as one scale</span>` +
    // Plain text, no data-tip: the exact tooltip count in the test suite is a naive
    // split on `data-tip=`, and a legend item does not need its own tooltip.
    `<span class="sd-leg-prov">plain header = ANCHORED to a named benchmark · ` +
    `${SD_JUDGED_MARK} = JUDGED, no public anchor · dashed underline = graded, transport unproven · ` +
    `the number beside a glyph = its place among the configured models in that column (measured Epoch AI percentile first, then the grade, then the AA index; ties share a place) · ` +
    `the bar under a glyph is that model's MEASURED Epoch AI percentile in the column's domain — no bar means nobody has measured it, not a score of zero</span>` +
    `<span class="sd-leg-hint">hover any cell · click a subject to rank by it</span></div>` +
    `${routesStrip}` +
    // Each table scrolls sideways inside its own box, with the model column pinned, so a
    // wide grid can never push past the page edge again — on a narrow screen you scroll
    // the grid, not the page.
    `<div class="sd-scroll"><table class="sd-table sd-cap-table"><thead>` +
    `<tr class="sd-grp"><th colspan="2"></th>` +
    scSkillGroups()
      .map(
        (g) =>
          `<th class="sd-grp-cap" colspan="${g.span}">${esc(g.group)} <i>${esc(
            SC_SKILL_GROUP_ABOUT[g.group],
          )}</i></th>`,
      )
      .join("") +
    `</tr>` +
    `<tr><th class="sd-h-model" data-sort="index" data-tip="Sorted by the Artificial Analysis intelligence index. Click to restore this order.">MODEL · AA idx</th>` +
    `<th>BLOC</th>${skillHeads}</tr>` +
    `</thead><tbody>${body}</tbody></table></div>` +
    `<h3 class="sd-sec-h sd-sec-h-cens">CENSORSHIP — what each model refuses, one column per topic</h3>` +
    `<div class="sd-legend"><span class="sd-leg-k sd-leg-k-cens">CENSORSHIP</span>${legend}` +
    `<span class="sd-leg-ramp">the deeper the RED, the more locked down that subject is</span>` +
    `<span class="sd-leg-hint">hover any cell for the evidence</span></div>` +
    `<div class="sd-scroll"><table class="sd-table sd-cens-table"><thead>` +
    `<tr class="sd-grp"><th colspan="2"></th>` +
    scTopicGroups()
      .map(
        (g) =>
          `<th class="sd-grp-cens" colspan="${g.span}">${esc(g.group)} <i>${esc(
            SC_TOPIC_GROUP_ABOUT[g.group],
          )}</i></th>`,
      )
      .join("") +
    `</tr>` +
    `<tr><th class="sd-h-model">MODEL · AA idx</th><th>BLOC</th>${topicHeads}</tr>` +
    `</thead><tbody>${censBody}</tbody></table></div>` +
    `<div class="sd-shared"><div class="sd-shared-title">REFUSED BY BOTH CAMPS</div>` +
    `<ul>${shared}</ul>` +
    `<div class="sd-shared-title">WHERE THEY SPLIT</div>${splits}` +
    `<p class="sd-note">CAPABILITY grades are a synthesis across SWE-bench Verified, OckBench, published ` +
    `evaluations and vendor launch claims (marked as claims in the cell) — a routing prior, not a single ` +
    `measured benchmark. Two ★ in a column mean "either is a defensible first choice", not a tie score — ` +
    `unless the ★ carries a dashed underline, which marks it GRADED, NOT WIRED: right about the model, ` +
    `unproven about our route to it, and therefore not a routable first choice until the transport is ` +
    `probed. Every column now declares its PROVENANCE. ANCHORED means the grades are read off a named ` +
    `public measurement of that column's own question — ${anchoredLabels.length} columns clear that bar ` +
    `(${esc(anchoredLabels.join(", "))}). JUDGED ` +
    `(a ${SD_JUDGED_MARK} on the header) means there is no public anchor and the grade is an opinion with ` +
    `its reasoning in the tooltip. LONG CTX is JUDGED on purpose: its MEASURED line is the ADVERTISED ` +
    `WINDOW while the grade is useful RECALL, and a related figure is not a basis. PSYCH was added ` +
    `2026-08-30 because the architect routes by it; EQ-Bench 3 is the anchor it should have and does not ` +
    `yet, for the two re-checkable reasons in that column's tooltip. ` +
    `CENSORSHIP is training-time disposition from usage policies, published testing and the July 2026 ` +
    `Hugging Face incident reporting — not guarantees: jailbreaks, endpoint-side filtering and version drift ` +
    `all exist. Corrected 2026-08-06: an earlier version of this table listed cyberattack tooling as refused ` +
    `by both camps, which averaged away the one asymmetry that mattered. Since 2026-10-02 every ` +
    `capability column PLACES the configured models 1 to ${SD_RANKED_PLACES} — the highest ` +
    `Epoch AI percentile first where any configured model has a public per-domain run, the judged grade ` +
    `where none does, the AA index breaking ties — and the header tooltip says which basis place 1 ` +
    `came from. Reference rows are never placed. ${unmeasuredLabels.length} of the ` +
    `${domainCols.length} capability columns have no Epoch AI run at all today ` +
    `(${esc(unmeasuredLabels.join(", "))}): in those domains THALAMUS falls back to the plain bias pick ` +
    `rather than inventing a preference. ` +
    `The THALAMUS ROUTES strip above the table is the router's own answer per task domain at the ` +
    `current BIAS, from the same functions the reply path calls.</p>${thalNote}</div>`
  );
}

// ─── CN SUPPLIER × MODEL PRICE MATRIX (the architect 2026-08-15, widened 2026-09-23) ───
// Appended to the foot of the dossier: "which supplier of Chinese models charges
// less". It answers a procurement question the SMART × COST chart cannot — that chart
// plots ONE price per model, but each model is sold by many hosts at prices that
// differ by up to 6x.
//
// THREE REFERENCE PRICES, because a buyer faces three different decisions:
//   LAB DIRECT   — the lab's own endpoint. The "official" price.
//   OPENROUTER   — what you pay calling `openrouter/<slug>` and letting OpenRouter
//                  pick the host. Added 2026-09-23 because it was the one number the
//                  table was missing and the one most people actually pay.
//   HOSTS        — independent companies running the same weights; the cheapest is
//                  bolded, and the gap between it and the two above IS the answer.
//
// The data is GENERATED, never hand-written (cn-provider-prices.generated.ts,
// refreshed by the model-rank-refresh cron). Two of five prices moved within 48h in
// August 2026, so a literal typed here would be wrong within days — the same rot that
// has repeatedly killed hardcoded figures elsewhere in this UI. The ROSTER is derived
// from the live catalog as well, so a new Chinese flagship appears without an edit.
export function cnMatrixColumns(data: CnProviderPrices, max = 7): string[] {
  // Columns are chosen by COVERAGE, computed from the data rather than pinned, so a
  // host that starts serving more models earns its column without an edit. 7, not 8:
  // the OpenRouter column added 2026-09-23 takes the slot, keeping the table the same
  // width it has always been — past that it stops being readable at a glance.
  const count = new Map<string, number>();
  for (const m of Object.values(data.models)) {
    for (const p of Object.keys(m.providers)) count.set(p, (count.get(p) ?? 0) + 1);
  }
  // Excluded by HOST name, not display name: ByteDance's own endpoint is listed as
  // "Seed", and matching on the display name would let it take a supplier column AND
  // the lab-direct column, double-counting the same seller.
  const labHosts = new Set(
    Object.values(data.models)
      .map((m) => m.labHost)
      .filter(Boolean) as string[],
  );
  return [...count.entries()]
    .filter(([p]) => !labHosts.has(p)) // labs get their own "direct" column
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([p]) => p);
}

export interface CnSavingStat {
  /** Median % the cheapest host undercuts this reference by, over the rows where a
   *  cheaper host actually exists. Null when no row qualifies. */
  median: number | null;
  /** How many rows that median is computed over — a median over 2 rows and one over
   *  15 are not the same claim, and the UI prints this next to it. */
  n: number;
  /** Rows where the reference IS already the cheapest. Reported, never averaged in:
   *  folding them into the median drags it to 0% and hides the real spread. */
  alreadyBest: number;
}

export interface CnCheapestSummary {
  /** Cheapest-host wins, counted ONLY over models with more than one supplier. A host
   *  that is "cheapest" because it is the only seller has won nothing, and counting
   *  those inflates whoever happens to host the monopoly models. */
  hosts: { host: string; wins: number }[];
  contested: number;
  soleSupplier: number;
  priced: number;
  vsLab: CnSavingStat;
  vsOr: CnSavingStat;
  lowPrecisionWins: number;
}

// A price table nobody can read the ANSWER off is a spreadsheet, not an answer. This
// computes the headline the table exists to produce — who is cheapest most often, and
// how much the cheapest route actually saves against the two prices a buyer would
// otherwise default to. Derived from the SAME rows the table renders, so the summary
// and the grid can never disagree.
export function cnCheapestSummary(data: CnProviderPrices): CnCheapestSummary {
  const median = (xs: number[]): number | null => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  };
  const wins = new Map<string, number>();
  const vsLab: number[] = [];
  const vsOr: number[] = [];
  let labAlready = 0;
  let orAlready = 0;
  let contested = 0;
  let soleSupplier = 0;
  let lowPrecisionWins = 0;
  let priced = 0;
  for (const m of Object.values(data.models)) {
    const best = m.cheapest;
    if (!best) continue;
    priced += 1;
    if (/fp4|fp8|int4|int8/i.test(best.quant)) lowPrecisionWins += 1;
    if (Object.keys(m.providers).length > 1) {
      contested += 1;
      wins.set(best.provider, (wins.get(best.provider) ?? 0) + 1);
    } else {
      soleSupplier += 1;
    }
    const split = (ref: number | undefined, into: number[], already: () => void) => {
      if (ref === undefined || ref <= 0) return;
      const saving = ((ref - best.out) / ref) * 100;
      // Half a percent is rounding, not a saving worth switching supplier for.
      if (saving >= 0.5) into.push(saving);
      else already();
    };
    split(m.labHost ? m.providers[m.labHost]?.out : undefined, vsLab, () => {
      labAlready += 1;
    });
    split(m.openrouter?.out, vsOr, () => {
      orAlready += 1;
    });
  }
  return {
    hosts: [...wins.entries()]
      .map(([host, n]) => ({ host, wins: n }))
      .sort((a, b) => b.wins - a.wins || a.host.localeCompare(b.host)),
    contested,
    soleSupplier,
    priced,
    vsLab: { median: median(vsLab), n: vsLab.length, alreadyBest: labAlready },
    vsOr: { median: median(vsOr), n: vsOr.length, alreadyBest: orAlready },
    lowPrecisionWins,
  };
}

/**
 * The name a person would say for a matrix row: "z-ai/glm-5.3" → "GLM 5.3",
 * "xiaomi/mimo-v2.6-pro" → "MiMo V2.6 Pro". Brand casing comes from a short table of the
 * labs' own spellings; anything it does not know is title-cased, never dropped, and the
 * raw id stays on hover so a caller can still copy the exact slug.
 */
const CN_BRAND_CASE: Record<string, string> = {
  glm: "GLM",
  mimo: "MiMo",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  kimi: "Kimi",
  minimax: "MiniMax",
  hy: "HY",
  seed: "Seed",
  step: "Step",
  longcat: "LongCat",
  ling: "Ling",
  ernie: "ERNIE",
  max: "Max",
  pro: "Pro",
  flash: "Flash",
  turbo: "Turbo",
  code: "Code",
  preview: "Preview",
};
export function cnPrettyName(id: string): string {
  const tail = (id.split("/").pop() || id).toLowerCase();
  return (
    tail
      .split("-")
      .filter((w) => w !== "")
      .map((w) => {
        const brand = w.match(/^([a-z]+)(\d.*)?$/);
        if (brand && CN_BRAND_CASE[brand[1]] !== undefined) {
          return CN_BRAND_CASE[brand[1]] + (brand[2] ?? "");
        }
        if (/^[a-z]\d/.test(w)) return w.toUpperCase(); // v2.6 → V2.6, k3 → K3
        if (/^\d/.test(w)) return w; // 0902, 2.4t, 1
        return w.charAt(0).toUpperCase() + w.slice(1);
      })
      .join(" ")
      // A version written with dashes ("seed-2-1-turbo") reads "2.1", not "2 1". Both
      // numbers must stand alone: "qwen3.8-2.4t" is two parts, and joining the "8" of
      // "Qwen3.8" to "2.4t" printed "Qwen3.8.2.4t" until 2026-10-02.
      .replace(/(^| )(\d{1,2}) (\d{1,2})(?= |$)/g, "$1$2.$3")
  );
}

export function renderCnProviderMatrix(
  data: CnProviderPrices,
  opts?: {
    /** The lab's mark for a row id ("z-ai/glm-5.3"). The caller owns the logo tables. */
    logoFor?: (id: string) => string | undefined;
    /**
     * The Artificial Analysis intelligence index for a row id, from the SAME lookup the
     * two dossier tables use (the architect 2026-10-02: "add the intelligence index for each of
     * them next to the title, like the other two tables"). The caller owns that lookup;
     * without this option the column is not drawn at all, rather than drawn as dashes.
     */
    indexFor?: (id: string) => number | undefined;
  },
): string {
  const cols = cnMatrixColumns(data);
  const ids = Object.keys(data.models);
  const money = (v: number): string => (v >= 1 ? v.toFixed(2) : v.toFixed(4));
  // WITHOUT OPENROUTER (the architect 2026-10-02, after his bank blocked OpenRouter as a merchant):
  // "find the cheapest" among sellers he can pay directly. The prices come from each
  // seller's OWN list (generator: DIRECT_SOURCES), never from its OpenRouter row — on the
  // day this was added Novita sold GLM-5.3 at half price through OpenRouter and full
  // price on its own API. Older generated data has no `direct` block: the cell says so.
  const directNames = (data.directSources ?? []).map((s) => s.name).join(", ") || "no seller lists";
  const directDown = (data.directSources ?? []).filter((s) => s.error).map((s) => s.name);
  const directCell = (id: string, m: CnModelPrices, orBest: number | null): string => {
    const d = m.direct;
    if (!d?.cheapest) {
      return `<td class="sd-cn-na" title="${esc(`${id} — none of the direct sellers we check (${directNames}) lists it.`)}">—</td>`;
    }
    const list = Object.entries(d.sellers)
      .map(
        ([s, r]) =>
          `${s} $${money(r.out)}${r.quant && r.quant !== "unknown" ? ` (${r.quant})` : ""}`,
      )
      .join(" · ");
    const gap = orBest !== null && orBest > 0 ? ((d.cheapest.out - orBest) / orBest) * 100 : 0;
    const tip =
      `${id} — sold without OpenRouter by: ${list}. $ per 1M output tokens, from each seller's own price list.` +
      (gap > 0.5
        ? ` ${gap.toFixed(0)}% dearer than the cheapest OpenRouter host: that price is only available through OpenRouter.`
        : "");
    return `<td class="sd-cn-cheapest sd-cn-direct" title="${esc(tip)}">${esc(d.cheapest.seller)} <b>${money(d.cheapest.out)}</b></td>`;
  };
  const pct = (v: number | null): string => (v === null ? "—" : `${v.toFixed(0)}%`);
  const sum = cnCheapestSummary(data);
  const fee = data.openrouterFee;
  // The fee is FETCHED off OpenRouter's own FAQ, so the tooltip never carries a stale
  // percentage. If the fetch failed the tooltip says so rather than quoting a number.
  const feeText = fee?.card
    ? `OpenRouter adds no markup on tokens, but charges ${fee.card} when you buy credits${fee.crypto ? ` (${fee.crypto} by crypto)` : ""}.`
    : "Credit-purchase fee could not be read from OpenRouter's own page on this run — check openrouter.ai/docs/faq before budgeting.";

  let rows = "";
  for (const id of ids) {
    const m = data.models[id]!;
    const labRow = m.labHost ? m.providers[m.labHost] : undefined;
    const best = m.cheapest;
    // Bold marks the cheapest cell IN THIS ROW — the whole point of the table.
    const cell = (p: string | null, row?: { out: number; quant: string }): string => {
      if (!row) return `<td class="sd-cap sd-cn-none">—</td>`;
      const isBest = p !== null && best !== null && p === best.provider;
      // Two or more times the row's cheapest price fades back, so the eye lands on the
      // cheap end of each row without reading every number.
      const far = !isBest && best !== null && best.out > 0 && row.out >= 2 * best.out;
      const q = row.quant && row.quant !== "unknown" ? row.quant : "";
      const tip = `${id} · ${p ?? "lab"} — $${money(row.out)}/M out${q ? ` · ${q}` : ""}`;
      return (
        `<td class="sd-cap${isBest ? " sd-cn-best" : ""}${far ? " sd-cn-far" : ""}" title="${esc(tip)}">` +
        `${isBest ? "<b>" : ""}${money(row.out)}${isBest ? "</b>" : ""}</td>`
      );
    };
    // OpenRouter's DEFAULT route — what you pay if you just call openrouter/<slug>.
    const orCell = ((): string => {
      if (!m.openrouter) {
        return `<td class="sd-cap sd-cn-na" title="${esc(`${id} is not routed by OpenRouter's own default — no default-route price to quote.`)}">—</td>`;
      }
      const gap =
        best && m.openrouter.out > 0 ? ((m.openrouter.out - best.out) / m.openrouter.out) * 100 : 0;
      const tip =
        `${id} — OpenRouter's DEFAULT route: $${money(m.openrouter.out)}/M out. ` +
        (gap > 0.5
          ? `That is ${gap.toFixed(0)}% dearer than the cheapest host in this row — the default pick is not always the cheapest. `
          : `Matches the cheapest host in this row on this run. `) +
        feeText;
      return `<td class="sd-cap sd-cn-or" title="${esc(tip)}">${money(m.openrouter.out)}</td>`;
    })();
    // FOUR states, not two. `pay/use` is a CLAIM — that this lab sells no flat plan —
    // and it may only be made for a lab we actually checked (an explicit null in
    // SUBSCRIPTIONS). A lab absent from that map gets NO tag: printing "pay/use" for
    // every unchecked lab was six unevidenced claims on one table.
    const hasSubData = m.lab !== null && m.lab in data.subscriptions;
    const sub = m.lab ? data.subscriptions[m.lab] : undefined;
    const subTag = sub
      ? `<span class="sd-cn-sub${sub.confirmed ? "" : " sd-cn-sub-unconfirmed"}" title="${esc(
          `${sub.plan} — from ${sub.from} ${sub.currency}/mo${sub.confirmed ? "" : " (UNCONFIRMED: no first-party page reached)"}`,
        )}">${sub.confirmed ? "sub" : "sub?"}</span>`
      : hasSubData
        ? `<span class="sd-cn-payg" title="${esc("Checked: this lab sells pay-per-use credits only, no flat plan.")}">pay/use</span>`
        : "";
    // Every row says why it is in the table, so a retired or newly promoted model is
    // explainable without reading the generator.
    const nameTip = `${id} — ${m.why}`;
    const logo = opts?.logoFor?.(id);
    const aa = opts?.indexFor?.(id);
    const idxTag =
      opts?.indexFor === undefined
        ? ""
        : ` <span class="sd-idx"${
            aa === undefined
              ? ` title="${esc("Artificial Analysis publishes no intelligence index for this model yet.")}"`
              : ""
          }>${sdIdxText(aa)}</span>`;
    const nameCell =
      `<th class="sd-model sd-cn-model" title="${esc(nameTip)}">` +
      (logo ? `<span class="sd-logo sd-cn-logo">${logo}</span>` : "") +
      `<span class="sd-cn-name">${esc(cnPrettyName(id))}</span>${idxTag}${subTag}` +
      `<span class="sd-cn-lab">${esc(m.lab ?? id.split("/")[0])}</span></th>`;
    // A lab whose flagship is sold only by the lab still gets a row: omitting it would
    // misrepresent the field, and inventing a price would be worse than either.
    if (!best) {
      const d = m.labDirect;
      const tip = d
        ? `${m.why} First-party page checked ${d.checkedAt.slice(0, 10)}: ${d.source}${d.error ? ` — no price could be read (${d.error}).` : ""}`
        : m.why;
      rows +=
        `<tr>${nameCell}` +
        `<td class="sd-cn-na" colspan="${cols.length + 3}" title="${esc(tip)}">` +
        `no first-party price reached — not sold on OpenRouter, vendor page checked ` +
        `${esc(d?.checkedAt.slice(0, 10) ?? "—")}</td>` +
        directCell(id, m, null) +
        `</tr>`;
      continue;
    }
    rows +=
      `<tr>${nameCell}` +
      cell(m.labHost, labRow) +
      orCell +
      cols.map((c) => cell(c, m.providers[c])).join("") +
      `<td class="sd-cn-cheapest">${esc(best.provider)} <b>${money(best.out)}</b></td>` +
      directCell(id, m, best.out) +
      `</tr>`;
  }

  const subLines = Object.entries(data.subscriptions)
    .map(([lab, s]) =>
      s
        ? `${esc(lab)}: ${esc(s.plan)} from $${s.from}/mo${s.confirmed ? "" : " <i>(unconfirmed)</i>"}`
        : `${esc(lab)}: pay-per-use only`,
    )
    .join(" · ");
  const when = data.fetchedAt.slice(0, 16).replace("T", " ");
  const top = sum.hosts.slice(0, 5);
  const winChips = top
    .map(
      (h) =>
        `<span class="sd-cn-win" title="${esc(`${h.host} is the cheapest supplier for ${h.wins} of the ${sum.contested} models in this table that more than one supplier sells.`)}">` +
        `${esc(h.host)} <b>${h.wins}</b></span>`,
    )
    .join("");
  // The headline, in the plainest words available: who wins, by how much, and what the
  // cheap price costs you in precision.
  //
  // WHY THE NUMBERS ARE FENCED THE WAY THEY ARE: wins count only models that more than
  // one supplier sells — being "cheapest" for a model you alone sell is not a win, and
  // counting it hands the trophy to whoever hosts the monopolies. Savings are medianed
  // only over rows where a cheaper host EXISTS, with the already-cheapest rows reported
  // beside them: folding those zeros into the median printed "saves a median 0%" on a
  // table whose real spread runs to 65%, which is true and completely misleading.
  const saving = (label: string, st: CnSavingStat): string =>
    st.median === null
      ? `No row is cheaper elsewhere than ${label}.`
      : `Against ${label}, switching supplier saves a median <b>${pct(st.median)}</b> ` +
        `<span class="sd-cn-n">(on the ${st.n} model${st.n === 1 ? "" : "s"} where a cheaper ` +
        `host exists; the other ${st.alreadyBest} are already at the best price)</span>.`;
  const answer =
    `<div class="sd-cn-summary"><div class="sd-cn-summary-h">CHEAPEST SUPPLIER OVERALL</div>` +
    `<p class="sd-cn-answer">` +
    (top[0]
      ? `<b>${esc(top[0].host)}</b> is the cheapest seller for <b>${top[0].wins}</b> of the ` +
        `${sum.contested} models here that you can buy from more than one place` +
        (sum.soleSupplier
          ? ` <span class="sd-cn-n">(${sum.soleSupplier} more have only one seller, so there is nothing to compare)</span>`
          : "") +
        `. `
      : "") +
    saving("the lab's own price", sum.vsLab) +
    " " +
    saving("just calling OpenRouter and letting it choose", sum.vsOr) +
    `</p><div class="sd-cn-wins">${winChips}</div>` +
    `<p class="sd-cn-caveat" title="${esc(
      "A quantised route runs the same weights at lower numeric precision. It is cheaper and faster, and on hard tasks it is measurably worse — but it is sold under the identical model name, so the saving is not always free.",
    )}"><b>Cheap is not always the same model.</b> ${sum.lowPrecisionWins} of the ${sum.priced} ` +
    `cheapest routes run a <b>squeezed (fp4/fp8)</b> copy of the weights — same name on the label, ` +
    `lower precision inside, and measurably weaker on hard work. Hover any price to see its precision.</p></div>`;

  return (
    `<div class="sd-cn-matrix"><h3>CHINESE MODELS — who sells them, and for how much</h3>` +
    answer +
    `<table class="sd-table sd-cn-table"><thead><tr>` +
    `<th class="sd-model" title="${esc(
      opts?.indexFor === undefined
        ? "The model, named the way you would call it."
        : "The model, named the way you would call it, and its Artificial Analysis intelligence index — the same number the two tables above print beside each name. A dash means AA publishes no score for it yet.",
    )}">${opts?.indexFor === undefined ? "model" : "model · AA idx"}</th>` +
    `<th title="${esc("Lab direct — what the company that BUILT the model charges on its own endpoint. The official price.")}">lab direct</th>` +
    `<th class="sd-cn-or" title="${esc(`OpenRouter — what you pay if you just call openrouter/<model> and let OpenRouter choose a host for you. ${feeText} Its default pick is NOT always the cheapest host in this row.`)}">OpenRouter</th>` +
    cols
      .map(
        (c) =>
          `<th title="${esc(`${c} — an independent company renting out the same model on its own hardware. Green = it is the cheapest for that row.`)}">${esc(c)}</th>`,
      )
      .join("") +
    `<th title="${esc("The cheapest supplier for this model, and its price per million output tokens.")}">cheapest</th>` +
    `<th class="sd-cn-direct" title="${esc(`The cheapest seller you can pay DIRECTLY, with no OpenRouter account — read off each seller's own public price list (${directNames}). A host's price inside OpenRouter can be a discount only OpenRouter gets, so it cannot stand in for this column.`)}">without OpenRouter</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    `<p class="sd-note"><b>Every number is $ per 1 MILLION OUTPUT tokens</b> — roughly 750,000 words of ` +
    `answer — at each supplier's cheapest tier. Green = the cheapest supplier for that row. ` +
    `A dash means that supplier does not sell that model. ` +
    `Subscriptions: ${subLines}. A <b>sub</b> / <b>sub?</b> / <b>pay/use</b> tag appears only ` +
    `for labs whose plans we actually checked — no tag means not checked, not "no plan". ` +
    `Which models appear is decided by the data, not by hand: ${esc(data.rosterRule)} ` +
    `Sources: ${esc(data.source)} and ${esc(data.catalogSource)}, fetched ${esc(when)}` +
    (fee?.source
      ? `; OpenRouter fee read from ${esc(fee.source)} on ${esc(fee.checkedAt.slice(0, 10))}`
      : "") +
    ` — regenerated daily by the model-rank-refresh cron, because these prices move within days.` +
    ` <b>Without OpenRouter</b>: the cheapest seller that bills you directly, read off the public price lists of ${esc(directNames)}` +
    (directDown.length ? ` (<b>not reachable this run: ${esc(directDown.join(", "))}</b>)` : "") +
    `. It is often dearer than the cheapest OpenRouter host, because some hosts discount only inside OpenRouter. Hover a cell for every direct seller.` +
    (data.errors.length
      ? ` <b>${data.errors.length} row(s) could not be priced this run</b>: ${esc(data.errors.join("; "))}`
      : "") +
    `</p></div>`
  );
}
