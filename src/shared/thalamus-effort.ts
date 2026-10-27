// THALAMUS — the TASK chooses the EFFORT (FORK 2026-10-09).
//
// WHY. The owner, 2026-10-09: "Auto is supposed to mean that Thalamus should take over deciding which
// effort is best for each task. A complex coding task would need ultracode, whereas a hello would only
// need low." Until this module an Auto turn ran at the effort the dial's stop suggested — smart =
// Opus @max — whatever the prompt said, so a ten-character "hello" ran at max. The dial and the domain
// still choose the MODEL (src/shared/thalamus-plan.ts, unchanged); this module reads the task and
// chooses the EFFORT, never above the stop's suggestion.
//
// WHAT IT READS. A `TaskRead` (src/shared/thalamus-v4-types.ts): a Jev read when the caller already
// holds one, else the local rules (src/shared/thalamus-reads.ts) on the user's own words
// (src/shared/user-task-text.ts strips the injected trailer). NO JEV WAIT on this path: a reply must
// not stall on a classifier call. A read whose difficulty FELL BACK (Jev silent or unsure) is not
// used: the cautious value is difficulty 4, right for the router and wrong for the effort — it would
// send "hello" to high, the very defect this fixes. The local rules answer instead, and `basis` says so.
//
// THE MAPPING, difficulty -> effort: 1-2 low · 3 medium · 4 high (xhigh when the shape is parts or
// chain) · 5 max. ULTRACODE (the fan-out composition, read by the reply path from
// `thalamusRoute.ultracode`) when the task is hard (>= 4), in a build domain (code, frontend, shell,
// agentic — the read's own names) and either comes in parts, carries multi-file / debug / refactor /
// migrate cues, or says the word "ultracode"; that word alone forces it. Ultracode means max.
//
// THE CLAMPS. `ceiling` is the stop's suggested effort (the rung the router picked): the task can lower
// it, never raise it. `ladder` is the efforts the routed model actually has on the board: the level
// snaps to the highest rung at or below the want, so a model that stops at xhigh gets xhigh for a max
// want. Ultracode only when the ceiling is max — a stop that caps lower has said "no fan-out", and
// `why` says so.
//
// PURE. No clock, no I/O, no process: the browser bundle may import it.

import type { TaskDomain } from "./thalamus-frontier.js";
import { localTaskRead } from "./thalamus-reads.js";
import type { TaskRead } from "./thalamus-v4-types.js";

/** Vendor efforts in rising order; a model's ladder is a subset (src/shared/provider-effort-ladders.ts). */
export const EFFORT_ORDER: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** Domains where a hard, many-part task is a job for the fan-out. The read's own names. */
export const ULTRACODE_DOMAINS: ReadonlySet<TaskDomain> = new Set<TaskDomain>([
  "code",
  "frontend",
  "shell",
  "agentic",
]);

/** The literal word: the owner asking for the fan-out by name. */
const ULTRACODE_WORD = /\bultracode\b/i;
/** Work that spans files or needs a hunt: the shape of a task the fan-out pays for. */
const SPREAD_CUES = {
  "multi-file":
    /\b(multi-?file|several files|many files|all (?:the )?files|every file|across (?:the |all )?(?:files|modules|packages|repo|codebase|tree))\b/i,
  refactor: /\brefactor(?:ing|ed)?\b/i,
  debug: /\b(debug(?:ging)?|root cause)\b/i,
  migration: /\bmigrat(?:e|ion|ing)\b/i,
} as const;

export type TaskEffortInput = {
  /** The user's own words (`userTaskText`), not the prompt with our trailer on it. */
  text: string;
  /** A Jev read already in hand. Absent, or with a fallback difficulty: the local rules read `text`. */
  read?: TaskRead;
  /** The stop's suggested effort (the rung the router picked): the task never goes above it. "" = no ladder. */
  ceiling: string;
  /** The efforts the routed model has on the board. Empty = no graded ladder. */
  ladder: readonly string[];
};

export type TaskEffort = {
  /** The effort to run at, on the model's own ladder; "" when the model has none. */
  level: string;
  /** Run the fan-out composition. Only ever true with a `max` ceiling. */
  ultracode: boolean;
  /** Which read chose: Jev's, or the local rules. */
  basis: "jev" | "local";
  /** One short human phrase, e.g. "low: greeting" or "max + ultracode: multi-file debug". */
  why: string;
};

const rank = (effort: string): number => EFFORT_ORDER.indexOf(effort);

/** The highest ladder rung at or below `want`; the ladder's lowest rung when none is; "" with no ladder. */
export function snapToLadder(want: string, ladder: readonly string[]): string {
  const rungs = ladder.filter((e) => rank(e) >= 0).toSorted((a, b) => rank(a) - rank(b));
  if (rungs.length === 0) {
    return "";
  }
  const w = rank(want);
  let pick = rungs[0];
  for (const r of rungs) {
    if (rank(r) <= w) {
      pick = r;
    }
  }
  return pick;
}

/** The lower of a level and a ceiling; an unknown ceiling (or "") is no cap. */
function capAt(level: string, ceiling: string): string {
  const c = rank(ceiling);
  if (c < 0) {
    return level;
  }
  return rank(level) > c ? ceiling : level;
}

function wantFor(read: TaskRead): { level: string; label: string } {
  const d = read.difficulty.value;
  const shape = read.shape.value;
  if (d <= 1) {
    return { level: "low", label: "greeting" };
  }
  if (d === 2) {
    return { level: "low", label: "routine ask" };
  }
  if (d === 3) {
    return { level: "medium", label: "involved" };
  }
  if (d === 4) {
    return shape === "answer"
      ? { level: "high", label: "hard" }
      : { level: "xhigh", label: shape === "parts" ? "hard, in parts" : "hard, in steps" };
  }
  return { level: "max", label: "research-grade" };
}

function spreadLabel(text: string, read: TaskRead): string {
  const hits: string[] = (Object.keys(SPREAD_CUES) as (keyof typeof SPREAD_CUES)[]).filter((k) =>
    SPREAD_CUES[k].test(text),
  );
  if (hits.length === 0) {
    hits.push(read.shape.value === "parts" ? "many-part" : "hard");
  }
  return `${hits.join(" ")} ${read.kind.value}`;
}

export function taskEffort(input: TaskEffortInput): TaskEffort {
  const text = input.text ?? "";
  // A Jev read is used only when its difficulty is Jev's own answer. A fallback difficulty is the
  // cautious 4 — right for the router, wrong for the effort: it would send "hello" to high.
  const fromJev = input.read !== undefined && input.read.difficulty.source === "jev";
  const read: TaskRead = fromJev
    ? (input.read as TaskRead)
    : localTaskRead({ id: "task-effort", ts: 0, sessionKey: "", text, private: false });
  const basis: TaskEffort["basis"] = fromJev ? "jev" : "local";

  const named = ULTRACODE_WORD.test(text);
  const hard = read.difficulty.value >= 4;
  const build = ULTRACODE_DOMAINS.has(read.kind.value);
  const spread =
    read.shape.value === "parts" || Object.values(SPREAD_CUES).some((re) => re.test(text));
  const wantsUltracode = named || (hard && build && spread);

  const want = wantsUltracode
    ? { level: "max", label: named ? "asked for ultracode" : spreadLabel(text, read) }
    : wantFor(read);
  const capped = capAt(want.level, input.ceiling);
  const level =
    input.ladder.length > 0 ? snapToLadder(capped, input.ladder) : input.ceiling ? capped : "";
  const ultracode = wantsUltracode && input.ceiling === "max";

  const notes: string[] = [];
  if (rank(input.ceiling) >= 0 && rank(want.level) > rank(input.ceiling)) {
    notes.push(`stop caps at ${input.ceiling}`);
  }
  if (wantsUltracode && !ultracode) {
    notes.push("no ultracode below a max stop");
  }
  if (level && rank(level) < rank(capped)) {
    notes.push(`ladder stops at ${level}`);
  }
  const why =
    `${level || "no ladder"}${ultracode ? " + ultracode" : ""}: ${want.label}` +
    (notes.length > 0 ? ` (${notes.join(", ")})` : "");
  return { level, ultracode, basis, why };
}
