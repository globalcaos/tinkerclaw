// Correction capture (J-series plan 2026-10-09, Phase 1.3; gap census C3-C9).
//
// WHAT THIS IS FOR. The owner's corrections are the best labels this system will ever get, and until now they stayed
// text: `enh_pins` held 0 rows while he said "you have a skill for this" at least eight times, and the repeated rules
// (don't ask, simpler, reply language, purple line, keep going) were counted by hand in a census. This module reads
// ONLY his words in a prompt (`ownerWords`: no stamp, no sender block, no doctrine, no agent prompt) and records:
//   - an `enh_pins` row when he names a skill, recipe or plugin that exists. A corrective naming ("did you forget we
//     have a youtube skill?") pins the PREVIOUS task of the chat, the one that should have used it, `by: "correction"`.
//     A plain instruction ("use the linkedin skill to search") pins the current task, `by: "named"`.
//   - one `j.correction` row per repeated-rule class the prompt carries, label = the class, `via` = rule or jev.
//
// RULES FIRST, JEV FOR THE AMBIGUOUS. The patterns below come from his own prompts (Tinker transcripts 07-01 → 10-10,
// 212 cue-bearing prompts read). A prompt that hits a class rule is decided by the rule and Jev is not asked. A prompt
// with only a weak cue ("again", "I told you", a long "keep going …") and no class goes to Jev once, in the
// background, through Thalamus's own client and privacy gate; nothing waits on it. Jev never writes a pin: a pin needs
// a card he named, and naming is a rule.
//
// NEVER GUESSES A CARD. "you have a skill for this" with no name, or a name two cards share ("amazon"), writes the
// `j.correction` row with n1 = 0 and no pin: a wrong card in `enh_pins` would teach the ranker the wrong lesson.
//
// HARNESS = CODE. No learner runs here; it only records. Nothing it does can break a prompt. The learner is the nightly
// lesson pass (`lesson-sleep.ts`), which reads the rows `keep` writes: which rule had to be given again, and why it slipped.

import type { JevQuestion, JevVerdict } from "openclaw/plugin-sdk/fork-jev";
import { ownerWords } from "openclaw/plugin-sdk/fork-prompt-envelope";
import { emitEvent } from "openclaw/plugin-sdk/fork-telemetry";
import {
  isInteractiveSession,
  type EnhancementCard,
  type EnhancementKind,
} from "openclaw/plugin-sdk/fork-thalamus";
import type { ThalamusStore } from "./store.js";

export const CORRECTION_CLASSES = [
  "use_existing",
  "dont_ask",
  "simpler",
  "reply_language",
  "purple_line",
  "keep_going",
] as const;
export type CorrectionClass = (typeof CORRECTION_CLASSES)[number];

/** Jev's answer below this probability is not a label. */
export const CORRECTION_JEV_MIN_PROB = 0.6;

// ─── the rules (from his prompts; each line names a real one) ───────────────────────────────────

/** He says the enhancement, login or tool already exists, or that the agent skipped it. Points at the previous task. */
const USE_EXISTING_CORRECTIVE: readonly RegExp[] = [
  // "you have a gmail skill", "you have the login and passwords", "we have a skill that overcomes", "you have the root password"
  /\b(?:you|we)(?:'ve| have| already have)(?: got)? (?:a|an|the|your|our)\b(?: [\w-]+){0,3}? (?:skills?|recipes?|plugins?|logins?|passwords?|root password)\b/,
  // "Did you forget we have a youtube skill?"
  /\bforg[eo]t (?:that )?(?:we|you) (?:have|had)\b/,
  // "Remember we have a skill …", "Remember we have a recipe we developed for work commits". Not "Remember we have
  // rules about hard thresholds" or "Remember we have fractal": a reminder of a rule or a resource is not a card.
  /\bremember,? (?:that )?(?:we|you) (?:have|had|used) (?:a |an |the |our |your )?(?:[\w-]+ ){0,3}?(?:skills?|recipes?|plugins?|logins?|passwords?)\b/,
  // "Nope, you are not following the right script or recipe. Remember the one you used last time"
  /\bremember the one you used\b/,
  // "You should have a skill to restart the gateway"
  /\bshould (?:already )?have (?:a|an|the) (?:[\w-]+ ){0,3}(?:skill|recipe|plugin)\b/,
  // "you failed to use the right recipe", "you forgot to inject in it napkin diagrams as our recipe calls for"
  /\b(?:failed|forgot) to (?:use|apply|follow|inject|run)\b/,
  // "you are not following the right script or recipe"
  /\bnot (?:following|using) the right (?:script|recipe|skill)\b/,
  /\bas (?:our|the|your) (?:[\w-]+ )?recipe (?:calls for|says)\b/,
  /\bthere(?:'s| is) (?:already )?(?:a|an) (?:[\w-]+ ){0,3}(?:skill|recipe) for (?:this|that)\b/,
  /\bwhy (?:didn'?t|did not|don'?t) you use\b/,
  // Catalan: "El skill sharepoint-download permet descarregar els arxius, collons! Fes-lo servir"
  /\bfes-(?:lo|la|ho) servir\b/,
];

const DONT_ASK: readonly RegExp[] = [
  // "Make it work, don't ask me to run commands, fix it", "configure it, don't ask me for its address". Not "you did well
  // deducing that I don't ask anything twice".
  /\b(?:don'?t|do not) ask (?:me|for (?:permission|confirmation)|again)\b/,
  /\bstop asking\b/,
  // "why do you even ask?"
  /\bwhy (?:do|did|would) you (?:even )?ask\b/,
  // "ok, do it yourself, you have the tab", "Do the sudo thing in the pi yourself", "Can you do it yourself?". The verb
  // opens a clause: "ideas on how to do it yourself" and "take its input and do it yourself" are plain instructions.
  /(?:^|[.,;:!?]\s*)(?:(?:ok|okay|so|then|now|just|please)\s*,?\s*)*(?:can you\s+)?(?:do|run|fix|add) (?:it|that|this|the [^,.?!]{1,40}?) yourself\b/,
  /\bdon'?t make me\b/,
  /\bno (?:em |me )?preguntis\b/,
  /\bno me preguntes\b/,
  /\bfes-ho tu\b/,
  /\bhazlo t[uú]\b/,
];

// The explanation, not the thing: "simplify the panel" and "a simpler architecture" are design asks, not this class.
const SIMPLER: readonly RegExp[] = [
  // "Simplify your explanation for me, will you?"
  /\bsimplify (?:your |the |this |that |my )?(?:explanation|answer|reply|text|wording|language)\b/,
  /\b(?:explain|say|put|write|word) (?:it |this |that )?(?:simpler|plainer|more simply|more plainly)\b/,
  /\bplainer\b/,
  /\bin plain (?:english|words|terms|language)\b/,
  // "bring it down to human terms", "Put it in human terms"
  /\bhuman terms\b/,
  // "Explain it as if I was a grandma without computer knowledge" (not "Baba means grandma in Russian")
  /\b(?:as if|like) (?:i (?:was|were|am) )?(?:a |my )?grandma\b/,
  // "No clue, I don't understand anything here", "When I open a prompt from Jev, I don't understand it". Not "I don't
  // understand how SOL could cost more" or "I don't understand the difference between …": those are questions.
  /\bi (?:don'?t|do not) understand (?:it|anything|this|that|a thing|a word)\b/,
  // "Your one-line is too complex", "The title is way too complicated", "a bit complicated for me to understand". Not
  // "the 'expression' field is redundant and too complicated, remove it": a field is design, not an explanation.
  /\b(?:explanation|answer|reply|title|text|wording|one-line|one-liner|command|description|summary)s? (?:is|are|was|were|seems?) (?:way |a bit |far |much |still )?too (?:complex|complicated|technical|convoluted)\b/,
  /\b(?:complex|complicated|technical) for me\b/,
  // "Expain better the invariant gate question"
  /\bexp(?:l)?ain (?:(?:it|this|that|me) )?better\b/,
];

const REPLY_LANGUAGE: readonly RegExp[] = [
  // "The rule is that if I speak in one language, you respond in the same one."
  /\b(?:respond|reply|answer|speak|write)\b[^.?!]{0,30}\bsame (?:one|language)\b/,
  // "Why did you switch language to Spanish?", "Why did you switch to Spanish all of a sudden?"
  /\bwhy did you switch\b[^.?!]{0,20}\b(?:language|spanish|catalan|english)\b/,
  /\b(?:spanish|catalan|english) all of a sudden\b/,
  // "let's switch to English please"
  /\bswitch (?:back )?to english\b/,
  /\bwrong language\b/,
  /\bentirely in english\b/,
];

const PURPLE_LINE: readonly RegExp[] = [
  // "I haven't seen the purple text in a long while", "Your humor will only go in the purple text"
  /\bpurple (?:text|line)\b/,
  /\bspoken line\b/,
  /\byou (?:didn'?t|did not|stopped) (?:speak|talking)\b/,
];

/** "are you stuck?", "you seem to have gotten stuck", "I cannot see an answer yet", "something interrupted your thinking" */
const STUCK: readonly RegExp[] = [
  /\b(?:are you|you(?:'re| are)?|you seem(?: to (?:be|have gotten))?|did you(?: get)?|you got)\s+stuck\b/,
  /\bi (?:cannot|can'?t|don'?t) see (?:an? |any )?(?:answer|reply|response|progress)\b/,
  /\bsomething interrupted\b/,
];

/** A bare nudge: "keep going", "continue", "Good. Keep going", "keep going with opus". */
const NUDGE = /^(?:keep going|continue|go on|carry on|segueix|continua|sigue)\b/;
const NUDGE_LEAD = /^(?:(?:ok|okay|great|good|yes|so|then|dude)[,.!]?\s+)+/;
const NUDGE_MAX_EXTRA_WORDS = 4;

/**
 * A plain instruction to use one: "Use your amazon skill to search …", "utilitza el skill sharepoint-download". Without
 * it, a name he says ("Let's create a linkedin skill", "Improve the 365 copilot skill") is about building the card, and
 * pins nothing.
 */
const USE_DIRECTIVE =
  /\b(?:use|using|utilitza|utilitzant|usa|usant|usando|fes servir|apply|follow)\s+(?:(?:the|your|our|my|el|la|l'|this|that)\s+)?(?:[\w-]+\s+){0,2}?(?:skills?|recipes?|recepta|plugins?)\b(?:\s+(?:de\s+|called\s+|named\s+)?[a-z0-9][\w-]*)?/g;
/** "without using the browser plugin", "don't use the X skill": the opposite of an instruction to use it. */
const NEGATED = /\b(?:without|not|never|instead of|don'?t|do not)\s+$/;

/** Says something is wrong, but not which rule: Jev reads these when no class rule fired. */
const WEAK_CUE =
  /\b(?:again|i (?:told|said|asked)|how many times|nope|you forgot|you should have|not what i asked|i was not asking|i didn'?t ask|keep going|continue)\b/;

// ─── the read ───────────────────────────────────────────────────────────────────────────────

export type CorrectionRead = {
  /** The classes the rules found. */
  classes: CorrectionClass[];
  /** The owner says an enhancement already exists or was skipped: the pin goes to the previous task. */
  corrective: boolean;
  /** The cards he named, each resolved to exactly one card; empty unless he corrects or tells the agent to use one. */
  named: EnhancementCard[];
  /** No class rule fired, but a weak cue did: Jev may decide. */
  ambiguous: boolean;
};

const KIND_WORD: Record<string, EnhancementKind> = {
  skill: "skill",
  skills: "skill",
  recipe: "recipe",
  recipes: "recipe",
  recepta: "recipe",
  plugin: "plugin",
  plugins: "plugin",
};

/** Words in front of "skill" that are not a name: "the right recipe", "a skill", "your amazon skill". */
const NOT_A_NAME = new Set([
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "your",
  "our",
  "my",
  "his",
  "her",
  "their",
  "its",
  "right",
  "wrong",
  "new",
  "old",
  "same",
  "other",
  "another",
  "any",
  "some",
  "which",
  "what",
  "one",
  "basic",
  "whole",
  "last",
  "el",
  "la",
  "els",
  "les",
  "un",
  "una",
  "de",
  "del",
  "and",
  "or",
  "to",
  "for",
  "with",
  "use",
  "using",
  "have",
  "has",
]);

function canon(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** One phrase to one card, or none. Exact name, then a whole hyphen part of a name, then a word of one card's purpose. */
export function resolveCard(
  phrase: string,
  kind: EnhancementKind | undefined,
  cards: readonly EnhancementCard[],
  o: { byPurpose?: boolean } = {},
): EnhancementCard | undefined {
  const p = canon(phrase);
  if (!p || NOT_A_NAME.has(p)) {
    return undefined;
  }
  const pool = cards.filter(
    (c) => c.status !== "retired" && (kind === undefined || c.kind === kind),
  );
  const exact = pool.filter((c) => c.name.toLowerCase() === p);
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    return undefined;
  }
  const parts = p.split("-");
  const byName = pool.filter((c) => {
    const n = c.name.toLowerCase();
    return n.startsWith(`${p}-`) || n.endsWith(`-${p}`) || n.includes(`-${p}-`);
  });
  if (byName.length === 1) {
    return byName[0];
  }
  if (byName.length > 1) {
    return undefined;
  }
  // "you have a gmail skill" is `gog`, whose purpose says Gmail. Only in a correction (on the corpus a plain instruction
  // matched "broca recipe" to the wrong recipe this way), only a single word of four letters or more, found in the
  // purpose of exactly one card of the kind he said.
  if (!o.byPurpose || kind === undefined || parts.length !== 1 || p.length < 4) {
    return undefined;
  }
  const word = new RegExp(`\\b${p}\\b`, "i");
  const byPurpose = pool.filter((c) => word.test(c.purpose));
  return byPurpose.length === 1 ? byPurpose[0] : undefined;
}

/** The cards he named, by "X skill", "skill X", "skill de X", or a hyphenated name that is a card's exact name. */
export function namedCards(
  words: string,
  cards: readonly EnhancementCard[],
  o: { byPurpose?: boolean } = {},
): EnhancementCard[] {
  const s = words.toLowerCase();
  const found = new Map<string, EnhancementCard>();
  const add = (phrase: string, kind: EnhancementKind | undefined): boolean => {
    const c = resolveCard(phrase, kind, cards, o);
    if (c) {
      found.set(c.id, c);
    }
    return c !== undefined;
  };
  // "youtube skill", "the sharepoint-download skill", "amazon skill": try the two words in front, then the one.
  for (const m of s.matchAll(
    /((?:[a-z0-9][\w-]*\s+)?[a-z0-9][\w-]*)\s+(skills?|recipes?|recepta|plugins?)\b/g,
  )) {
    const kind = KIND_WORD[m[2]];
    const two = m[1].trim();
    const one = two.split(/\s+/).pop() ?? "";
    if (two !== one && !NOT_A_NAME.has(two.split(/\s+/)[0]) && add(two, kind)) {
      continue;
    }
    add(one, kind);
  }
  // "skill sharepoint-download", "el skill de linkedin", "the recipe called orbis-coding"
  for (const m of s.matchAll(
    /\b(skills?|recipes?|recepta|plugins?)\s+(?:de\s+|called\s+|named\s+)?([a-z0-9][\w-]*)/g,
  )) {
    add(m[2], KIND_WORD[m[1]]);
  }
  // A bare hyphenated name: "sharepoint-download", "torrent-scout".
  for (const m of s.matchAll(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g)) {
    const exact = cards.filter((c) => c.status !== "retired" && c.name.toLowerCase() === m[0]);
    if (exact.length === 1) {
      found.set(exact[0].id, exact[0]);
    }
  }
  return [...found.values()];
}

function isNudge(s: string): boolean {
  const t = s
    .replace(NUDGE_LEAD, "")
    .replace(/[!?.,;:]+/g, " ")
    .trim();
  if (!NUDGE.test(t)) {
    return false;
  }
  const rest = t.replace(NUDGE, "").trim();
  return rest === "" || rest.split(/\s+/).length <= NUDGE_MAX_EXTRA_WORDS;
}

/** The cards inside each "use the X skill" phrase he did not negate. */
function directiveCards(s: string, cards: readonly EnhancementCard[]): EnhancementCard[] {
  const found = new Map<string, EnhancementCard>();
  for (const m of s.matchAll(USE_DIRECTIVE)) {
    if (NEGATED.test(s.slice(Math.max(0, m.index - 20), m.index))) {
      continue;
    }
    for (const c of namedCards(m[0], cards)) {
      found.set(c.id, c);
    }
  }
  return [...found.values()];
}

/** The rules over the owner's words. Pure. */
export function readCorrection(words: string, cards: readonly EnhancementCard[]): CorrectionRead {
  const s = words.toLowerCase().replace(/[’‘]/g, "'");
  const any = (rs: readonly RegExp[]) => rs.some((r) => r.test(s));
  const classes: CorrectionClass[] = [];
  const corrective = any(USE_EXISTING_CORRECTIVE);
  if (corrective) {
    classes.push("use_existing");
  }
  if (any(DONT_ASK)) {
    classes.push("dont_ask");
  }
  if (any(SIMPLER)) {
    classes.push("simpler");
  }
  if (any(REPLY_LANGUAGE)) {
    classes.push("reply_language");
  }
  if (any(PURPLE_LINE)) {
    classes.push("purple_line");
  }
  if (any(STUCK) || isNudge(s)) {
    classes.push("keep_going");
  }
  return {
    classes,
    corrective,
    named: corrective ? namedCards(words, cards, { byPurpose: true }) : directiveCards(s, cards),
    ambiguous: classes.length === 0 && WEAK_CUE.test(s),
  };
}

/** Jev's choice, read as a class. Below the bar, `none`, skipped or unknown: undefined. */
export function correctionFromVerdict(v: JevVerdict | undefined): CorrectionClass | undefined {
  if (!v || v.skipped || v.type !== "choice" || typeof v.answer !== "string") {
    return undefined;
  }
  if (v.prob < CORRECTION_JEV_MIN_PROB) {
    return undefined;
  }
  return (CORRECTION_CLASSES as readonly string[]).includes(v.answer)
    ? (v.answer as CorrectionClass)
    : undefined;
}

// ─── the capture ────────────────────────────────────────────────────────────────────────────

export type CorrectionInput = {
  runId: string;
  sessionKey: string;
  text: string;
  source: string;
  trigger?: string;
};

export type CorrectionAsk = (
  situation: { id: string; request: { value: string } },
  questions: JevQuestion[],
  o: { budgetMs: number },
) => Promise<JevVerdict[]>;

export type CorrectionCaptured = {
  read: CorrectionRead;
  pins: Array<{ taskId: string; cardId: string; by: "correction" | "named" }>;
  /** Jev was asked; the promise settles when its rows are written. */
  jev?: Promise<CorrectionClass | undefined>;
};

export function createCorrectionCapture<I extends CorrectionInput = CorrectionInput>(d: {
  store: () => ThalamusStore | undefined;
  cards: () => readonly EnhancementCard[];
  now: () => number;
  /** Jev, its question, and whether this input may go to Jev (Thalamus's reader gate). Any absent: rules only. */
  jev?: {
    ask?: CorrectionAsk;
    question?: JevQuestion;
    allowed: (i: I) => boolean;
    budgetMs: () => number;
  };
  emit?: typeof emitEvent;
  /** Keeps each correction with his words for the nightly lesson pass (`lesson-sleep.ts`). Absent: events only. */
  keep?: (c: {
    input: I;
    cls: CorrectionClass;
    via: "rule" | "jev";
    words: string;
    cards: EnhancementCard[];
  }) => void;
}) {
  const emit = d.emit ?? emitEvent;
  const row = (
    i: I,
    cls: CorrectionClass,
    via: "rule" | "jev",
    pinned: number | null,
    words: string,
    cards: EnhancementCard[],
  ) => {
    emit("j.correction", {
      label: cls,
      n1: pinned,
      fields: { via },
      sessionKey: i.sessionKey,
      runId: i.runId,
    });
    try {
      d.keep?.({ input: i, cls, via, words, cards: cls === "use_existing" ? cards : [] });
    } catch {
      /* the lesson pass is a nightly reader; a failed write never touches the prompt */
    }
  };

  return {
    /** Reads one prompt. Returns undefined when the prompt is out of scope (not his words, not a typed chat turn). */
    observe(i: I): CorrectionCaptured | undefined {
      if (!isInteractiveSession(i.sessionKey)) {
        return undefined;
      }
      if (i.trigger !== undefined && i.trigger !== "user") {
        return undefined;
      }
      const words = ownerWords(i.text);
      if (!words) {
        return undefined;
      }
      const read = readCorrection(words, d.cards());
      const store = d.store();

      const pins: CorrectionCaptured["pins"] = [];
      if (store && read.named.length > 0) {
        // A corrective naming is about what the agent just did; a plain naming is about this task.
        const prev = read.corrective ? store.lastUseOfSession(i.sessionKey, i.runId) : undefined;
        const taskId = prev?.taskId ?? i.runId;
        const by = read.corrective ? "correction" : "named";
        for (const c of read.named) {
          store.addPin({ id: `${taskId}:${c.id}`, taskId, cardId: c.id, by, createdAt: d.now() });
          pins.push({ taskId, cardId: c.id, by });
        }
      }

      for (const cls of read.classes) {
        row(i, cls, "rule", cls === "use_existing" ? pins.length : null, words, read.named);
      }

      let jev: Promise<CorrectionClass | undefined> | undefined;
      const j = d.jev;
      if (read.ambiguous && j?.ask && j.question && j.allowed(i)) {
        const question = j.question;
        jev = j
          .ask({ id: `correction:${i.runId}`, request: { value: words } }, [question], {
            budgetMs: j.budgetMs(),
          })
          .then(
            (vs) => {
              const cls = correctionFromVerdict(vs.find((v) => v.questionId === question.id));
              if (cls) {
                row(i, cls, "jev", cls === "use_existing" ? 0 : null, words, []);
              }
              return cls;
            },
            () => undefined,
          );
      }
      return { read, pins, ...(jev ? { jev } : {}) };
    },
  };
}

export type CorrectionCapture<I extends CorrectionInput = CorrectionInput> = ReturnType<
  typeof createCorrectionCapture<I>
>;
