// The lesson ladder (2026-10-25; post "Why your AI assistant forgets what you told it", section 7; paper Sleep
// Consolidation). Pure: no disk, no clock, no model. `lesson-sleep.ts` feeds it files and corrections and writes what it
// decides.
//
// WHAT THIS IS FOR. The model never changes, so every lesson becomes text, and text binds only as hard as the place it
// lives. A lesson can live on four rungs, weakest first: a saved note (1), the task's notes, a skill or recipe (2), a
// line read with every turn (3), a check in code (4). Rung 0 is "written nowhere". When the owner corrects the same thing
// twice, the first lesson failed, and this works out why before it moves anything:
//   not-loaded    the rule is on rung 0, 1 or 2: nothing brought it into the chat. Repair: a line where it is read.
//   contradicted  a line in view says the opposite. Repair: strike or scope that line. Changing an existing rule may
//                 loosen it, so this repair always waits for the owner.
//   vague         the rule is in view but too soft to act on. Repair: the concrete line beside it.
//   still-broken  in view, clear, unopposed, and it slipped AFTER it was there. Only this moves up a rung, to a drafted
//                 check that starts by only watching.
// None of the first three repairs is a lock. A lesson whose harm cannot be undone skips the ladder and goes straight to
// a check (`irreversible`).
//
// THE RUNG IS OBSERVED, NOT REMEMBERED. Each night the rung comes from where the rule text is found on disk, so a rule
// the owner moved by hand is where he put it, and the ledger cannot drift from the files. "It was in view, clear and
// unopposed when it slipped" is proved by the always-read files' mtimes: if none of them changed after the slip, what
// they say tonight is what they said then. A file changed after the slip proves nothing, so the slip waits for the next.
//
// HOW THE PROBES WERE DERIVED. Each class's `find` and `against` patterns were checked against the live always-read files
// on 2026-10-25: reply_language finds SOUL.md's principle and AGENTS.md's pointer, and USER.md's "Reply in English even
// when the files on disk are Catalan or Spanish" is the opposing line (the post's own example); dont_ask finds "come back
// with answers, not questions", and "When in doubt, ask." opposes it; simpler and keep_going were written nowhere that is
// read every turn. A replay of the 25 corrections of the last 30 days over 2,799 live files (always-read, skills, notes)
// first found a bare "keep going" in 48 lines and "plain language" in 50 that were about something else, so those two
// probes ask for the rule's own wording.

import type { CorrectionClass } from "./correction-capture.js";

export type Rung = 0 | 1 | 2 | 3 | 4;

export const RUNG_NAMES: Record<Rung, string> = {
  0: "written nowhere",
  1: "a saved note",
  2: "the task's notes",
  3: "a line read every turn",
  4: "a check in code",
};

export type LessonCause = "not-loaded" | "contradicted" | "vague" | "still-broken";

export type LessonSpec = {
  title: string;
  /** The concrete line a repair writes, in the owner's terms. */
  rule: string;
  /** A line that states the rule. */
  find: readonly RegExp[];
  /** A line that says the opposite. A line that also states the rule is never counted against it. */
  against: readonly RegExp[];
  /** Harm that cannot be undone: straight to a check, whatever the rung. */
  irreversible?: boolean;
};

export const LESSON_SPECS: Record<CorrectionClass, LessonSpec> = {
  reply_language: {
    title: "Reply in the language the owner is typing",
    rule: "Reply in the language the owner is typing in this turn, even when the files or tools are in another.",
    find: [
      /\b(?:reply|respond|answer|write)\b[^.]{0,40}\blanguage\b/i,
      /\blanguage (?:\w+ ){0,2}(?:is |are )?typing\b/i,
      /\bsame language\b/i,
    ],
    against: [/\b(?:reply|respond|answer|write|keep the chat)\b[^.]{0,20}\bin english\b/i],
  },
  dont_ask: {
    title: "Do the reversible step yourself instead of asking",
    rule: "When the next step is reversible and you have the access, do it yourself; never ask the owner to run it or confirm it.",
    find: [
      /\b(?:don'?t|do not|never) ask\b/i,
      /\bcome back with answers,? not questions\b/i,
      /\bdo (?:it|that|the \w+) yourself\b/i,
    ],
    against: [/\bwhen in doubt,? ask\b/i, /\balways ask (?:first|before)\b/i],
  },
  simpler: {
    title: "Explain in plain words",
    rule: "Explain in plain words with one everyday example; no jargon, no mechanism detail unless asked.",
    // About the explanation, not the thing: "plain language" alone is in dozens of skill docs.
    find: [
      /\b(?:explain|answer|reply|say|write|put)\b[^.]{0,40}\b(?:plain (?:words|language|english|terms)|human terms|simply|simpler|plainly)\b/i,
      /\beveryday example\b/i,
    ],
    against: [],
  },
  purple_line: {
    title: "Open with the spoken line",
    rule: "Start every substantive Tinker reply with the spoken line `**Jarvis:** *…*` in italics.",
    find: [/\bpurple (?:spoken )?(?:line|text)\b/i, /\bspoken line\b/i],
    against: [/\b(?:skip|omit|drop) the (?:purple|spoken) (?:line|text)\b/i],
  },
  keep_going: {
    title: "Finish the work before ending the turn",
    rule: "Do not end a turn while the task is unfinished and nothing blocks it; a bare 'keep going' means you stopped too early.",
    // Not a bare "keep going": 48 lines of notes and skills said it about something else (2026-10-25 replay).
    find: [
      /\bstopped too early\b/i,
      /\b(?:never|do not|don'?t) (?:end|stop) (?:the|a|your) turn\b/i,
      /\bkeep going\b[^.]{0,40}\bmeans\b/i,
    ],
    against: [],
  },
  use_existing: {
    title: "Use the skill or recipe that already exists",
    rule: "Before improvising, check the skill list and the recipes for one that fits; when the owner names one, run it.",
    find: [
      /\bcatalog first\b/i,
      /\bgrep the skill list\b/i,
      /\bbefore improvising\b/i,
      /\bcheck (?:its|the) `?skill\.md`?/i,
    ],
    against: [],
  },
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The ledger key of a lesson: the class, or the class and the card the owner named. */
export function lessonKey(cls: CorrectionClass, card?: string): string {
  return card ? `${cls}:${card}` : cls;
}

/** A named card is its own lesson: its rule is a pointer to it in a file read every turn. */
export function specFor(
  cls: CorrectionClass,
  card?: { name: string; kind: string; purpose?: string },
): LessonSpec {
  const base = LESSON_SPECS[cls];
  if (!card) {
    return base;
  }
  const purpose = card.purpose?.trim().replace(/\s+/g, " ").slice(0, 120);
  return {
    title: `Use the ${card.name} ${card.kind}`,
    rule: purpose
      ? `${purpose} → ${card.kind} \`${card.name}\`: run it before improvising.`
      : `When a task fits it, run the ${card.kind} \`${card.name}\` before improvising.`,
    find: [new RegExp(`\\b${escapeRe(card.name)}\\b`, "i")],
    against: [],
  };
}

// ─── locate ─────────────────────────────────────────────────────────────────────────────────

export type SourceFile = { path: string; rung: 1 | 2 | 3; mtimeMs: number; text: string };
export type SourceLine = {
  path: string;
  line: number;
  rung: 1 | 2 | 3;
  mtimeMs: number;
  text: string;
};

export type Located = {
  /** The strongest rung a line stating the rule was found on (0: none). */
  rung: 0 | 1 | 2 | 3;
  /** The lines that state it, strongest rung first. */
  affirm: SourceLine[];
  /** Lines on rungs 2-3 (in view) that say the opposite. */
  oppose: SourceLine[];
  /** Some line on the top rung is concrete enough to act on. */
  clear: boolean;
  /** The newest mtime among the rung-3 files read: what they say tonight they have said at least since then. */
  viewSince?: number;
};

/** Where the rule lives now. Lines over 2,000 characters are skipped: a minified blob is not a rule. */
export function locate(spec: LessonSpec, files: readonly SourceFile[]): Located {
  const affirm: SourceLine[] = [];
  const oppose: SourceLine[] = [];
  for (const f of files) {
    const lines = f.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].trim();
      if (!text || text.length > 2000) {
        continue;
      }
      const at = { path: f.path, line: i + 1, rung: f.rung, mtimeMs: f.mtimeMs, text };
      if (spec.find.some((r) => r.test(text))) {
        affirm.push(at);
      } else if (f.rung >= 2 && spec.against.some((r) => r.test(text))) {
        oppose.push(at);
      }
    }
  }
  affirm.sort((a, b) => b.rung - a.rung);
  const rung = (affirm[0]?.rung ?? 0) as Located["rung"];
  const top = affirm.filter((a) => a.rung === rung);
  const view = files.filter((f) => f.rung === 3);
  return {
    rung,
    affirm,
    oppose,
    clear: top.some((a) => isClear(a.text)),
    ...(view.length > 0 ? { viewSince: Math.max(...view.map((f) => f.mtimeMs)) } : {}),
  };
}

const HEDGE =
  /\b(?:try to|where possible|if possible|when appropriate|as needed|ideally|consider|maybe|perhaps|generally|usually|might|could|prefer(?:ably)?|if you can)\b/i;
const DIRECTIVE =
  /\b(?:always|never|must|do not|don'?t|every|only|first|before|instead|no)\b|^(?:[-*>|#\s]|\*\*)*(?:reply|use|write|answer|check|run|keep|put|ask|do|read|grep|follow|start|end|say|give|make|explain|finish|open|stop)\b/i;

/** A line is clear when it says what to do (a directive) and does not soften it (a hedge), in at most 80 words. */
export function isClear(text: string): boolean {
  const words = text.split(/\s+/).length;
  return words <= 80 && DIRECTIVE.test(text) && !HEDGE.test(text);
}

// ─── the ledger ─────────────────────────────────────────────────────────────────────────────

export type Slip = { ts: number; runId: string; via: string; words: string };

export type LessonEntry = {
  id: string;
  cls: CorrectionClass;
  card?: { name: string; kind: string };
  title: string;
  /** Newest last, at most `MAX_SLIPS` kept; `slipCount` keeps counting past it. */
  slips: Slip[];
  slipCount: number;
  /** The rung seen on the last night it slipped (4 once a check was drafted). */
  rung: Rung;
  /** Since when the rule has been in view, clear and unopposed, as far as the files prove it. Absent: it is not. */
  cleanSince?: number;
  cause?: LessonCause;
  /** Where the drafted check was written, and when. */
  check?: { path: string; at: number };
  /** The owner removed the drafted check: it is not drafted again. */
  checkDeclinedAt?: number;
};

export type Ledger = { version: 1; lastRunTs: number; lessons: Record<string, LessonEntry> };

export const MAX_SLIPS = 20;

export const emptyLedger = (): Ledger => ({ version: 1, lastRunTs: 0, lessons: {} });

/** A ledger read from disk, or an empty one when the file is missing or not this shape. */
export function parseLedger(raw: unknown): Ledger {
  const r = raw as Partial<Ledger> | null;
  if (!r || r.version !== 1 || typeof r.lessons !== "object" || r.lessons === null) {
    return emptyLedger();
  }
  return { version: 1, lastRunTs: Number(r.lastRunTs) || 0, lessons: { ...r.lessons } };
}

/** Adds one slip to its lesson, creating the lesson on its first slip. A slip already recorded (same run) is skipped. */
export function addSlip(
  ledger: Ledger,
  s: Slip & { cls: CorrectionClass; card?: { name: string; kind: string } },
  spec: LessonSpec,
): LessonEntry {
  const id = lessonKey(s.cls, s.card?.name);
  const e =
    ledger.lessons[id] ??
    (ledger.lessons[id] = {
      id,
      cls: s.cls,
      ...(s.card ? { card: s.card } : {}),
      title: spec.title,
      slips: [],
      slipCount: 0,
      rung: 0,
    });
  if (e.slips.some((x) => x.runId === s.runId)) {
    return e;
  }
  e.slips.push({ ts: s.ts, runId: s.runId, via: s.via, words: s.words });
  e.slips.sort((a, b) => a.ts - b.ts);
  if (e.slips.length > MAX_SLIPS) {
    e.slips.splice(0, e.slips.length - MAX_SLIPS);
  }
  e.slipCount += 1;
  return e;
}

// ─── the decision ───────────────────────────────────────────────────────────────────────────

export type Repair = {
  kind: "add-line" | "strike-opposing" | "draft-check";
  /** The line to add, or the line to strike, or what the check must catch. */
  text: string;
  /** The file it goes in, or the file and line it is about. */
  where?: string;
  /** Only the owner may make it: it may loosen an existing rule. */
  owner: boolean;
};

export type LessonStatus =
  /** One slip so far: the first lesson has not failed yet. */
  | "seen-once"
  /** Every slip came before the rule was on its rung (or the file changed since): wait for the next one. */
  | "waiting"
  /** A cause was found; its repair is drafted (and applied in apply mode when it may only tighten). */
  | "repair"
  /** In view, clear, unopposed and still broken: a check is drafted, watch-only. */
  | "promoted"
  /** A check is drafted already; these slips are what it would have caught. */
  | "watching"
  /** The owner removed the drafted check; it is not drafted again. */
  | "declined";

export type LessonVerdict = {
  id: string;
  title: string;
  status: LessonStatus;
  cause?: LessonCause;
  rungBefore: Rung;
  rungAfter: Rung;
  located: Located;
  repairs: Repair[];
  /** Slips after the rule was on its rung: the evidence that it is still broken. */
  slipsAfter: number;
};

const where = (l: SourceLine): string => `${l.path}:${l.line}`;

/**
 * Tonight's decision for one lesson that slipped again. `minSlips` is how many corrections make a lesson (default 2:
 * "when you correct the agent twice about the same thing"). Updates `entry` in place (rung, cleanSince, cause, check).
 */
export function decide(
  entry: LessonEntry,
  spec: LessonSpec,
  located: Located,
  o: { now: number; minSlips: number; checkExists: boolean; target: string },
): LessonVerdict {
  const rungBefore = entry.rung;
  const base = { id: entry.id, title: entry.title, rungBefore, located };

  // A drafted check is rung 4 while its file exists; a removed one is the owner's no.
  if (entry.check && !o.checkExists && entry.checkDeclinedAt === undefined) {
    entry.checkDeclinedAt = o.now;
  }
  const drafted = entry.check !== undefined && o.checkExists;
  entry.rung = drafted ? 4 : located.rung;
  const clean = located.rung >= 3 && located.clear && located.oppose.length === 0;
  if (!drafted) {
    if (clean) {
      const proof = located.viewSince ?? o.now;
      // Clean on its last night too: it has been clean at least since then.
      entry.cleanSince = entry.cleanSince === undefined ? proof : Math.min(entry.cleanSince, proof);
    } else {
      delete entry.cleanSince;
    }
  }
  const since = drafted ? entry.check!.at : (entry.cleanSince ?? Infinity);
  const slipsAfter = entry.slips.filter((s) => s.ts > since).length;
  const done = (v: Omit<LessonVerdict, keyof typeof base | "rungAfter">): LessonVerdict => {
    entry.cause = v.cause;
    return { ...base, rungAfter: entry.rung, ...v };
  };

  if (drafted) {
    return done({ status: "watching", cause: "still-broken", repairs: [], slipsAfter });
  }
  const draftCheck = (): LessonVerdict => {
    entry.rung = 4;
    entry.check = { path: `checks/${entry.id.replace(/[^a-z0-9_-]+/gi, "-")}.md`, at: o.now };
    return done({
      status: "promoted",
      cause: "still-broken",
      repairs: [{ kind: "draft-check", text: spec.rule, where: entry.check.path, owner: false }],
      slipsAfter,
    });
  };
  if (spec.irreversible && entry.checkDeclinedAt === undefined) {
    return draftCheck();
  }
  if (entry.slipCount < o.minSlips) {
    return done({ status: "seen-once", repairs: [], slipsAfter });
  }

  const strike = located.oppose.map(
    (l): Repair => ({ kind: "strike-opposing", text: l.text, where: where(l), owner: true }),
  );
  if (located.rung < 3) {
    return done({
      status: "repair",
      cause: "not-loaded",
      repairs: [{ kind: "add-line", text: spec.rule, where: o.target, owner: false }, ...strike],
      slipsAfter,
    });
  }
  if (strike.length > 0) {
    return done({ status: "repair", cause: "contradicted", repairs: strike, slipsAfter });
  }
  if (!located.clear) {
    return done({
      status: "repair",
      cause: "vague",
      repairs: [{ kind: "add-line", text: spec.rule, where: o.target, owner: false }],
      slipsAfter,
    });
  }
  if (slipsAfter === 0) {
    return done({ status: "waiting", repairs: [], slipsAfter });
  }
  if (entry.checkDeclinedAt !== undefined) {
    return done({ status: "declined", cause: "still-broken", repairs: [], slipsAfter });
  }
  return draftCheck();
}

// ─── the drafted check ──────────────────────────────────────────────────────────────────────

/**
 * A check, drafted for a person to build: what it guards, the owner's own words as the cases it must catch, and the rule
 * that it starts by only watching. Nothing reads this file; building it is code (and its tests are the slips below).
 */
export function renderCheckDraft(entry: LessonEntry, spec: LessonSpec, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10);
  const cases = entry.slips
    .slice(-5)
    .map((s) => `- ${new Date(s.ts).toISOString().slice(0, 10)}: "${s.words}"`)
    .join("\n");
  return [
    `# Drafted check: ${entry.title}`,
    "",
    `Drafted by the nightly lesson pass on ${day}. The rule was read every turn, clear and unopposed, and the owner`,
    `still had to correct it ${entry.slipCount} times, the last after it was in place. A line cannot hold it, so it`,
    "needs a check in code before the action.",
    "",
    `**The rule:** ${spec.rule}`,
    "",
    "**Must catch** (the owner's corrections, newest last; each is a turn the check should have flagged):",
    "",
    cases || "- (no words kept)",
    "",
    "**How it starts:** watch-only. Build it as an amygdala question (`extensions/tinkerclaw-amygdala/questions/README.md`",
    "lists the steps, with one must-catch and one control case). In shadow mode amygdala only records its flags, and a rule",
    "acts only after the reviewer has found it worth it (`earned`), so a new check logs what it would have done before it",
    "may do anything.",
    "",
    "Delete this file to decline it; the pass will not draft it again.",
    "",
  ].join("\n");
}

// ─── the morning report ─────────────────────────────────────────────────────────────────────

const CAUSE_WORDS: Record<LessonCause, string> = {
  "not-loaded": "not loaded: it is not in a file read every turn",
  contradicted: "contradicted: a line in view says the opposite",
  vague: "too vague to act on",
  "still-broken": "in view, clear and unopposed, and still broken",
};

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The "Lessons" section of the morning report: short, one bullet per lesson that slipped again. */
export function renderLessonsReport(
  verdicts: readonly LessonVerdict[],
  ledger: Ledger,
  o: { now: number; mode: "watch" | "apply"; applied: ReadonlySet<string>; corrections: number },
): string {
  const day = new Date(o.now).toISOString().slice(0, 10);
  const acted = verdicts.filter((v) => v.status !== "seen-once");
  const once = verdicts.filter((v) => v.status === "seen-once");
  const owner = acted.filter((v) => v.repairs.some((r) => r.owner)).length;
  const lines: string[] = [`## Lessons (${day})`, ""];
  if (o.corrections === 0) {
    lines.push("No corrections since the last pass.");
    return lines.join("\n");
  }
  lines.push(
    `${o.corrections} correction${o.corrections === 1 ? "" : "s"} since the last pass; ${acted.length} lesson${
      acted.length === 1 ? "" : "s"
    } slipped again${owner > 0 ? `, ${owner} with a repair only you can make` : ""}.${
      o.mode === "watch" ? " Watch mode: repairs are drafted, nothing was changed." : ""
    }`,
    "",
  );
  for (const v of acted) {
    const e = ledger.lessons[v.id];
    const last = e?.slips.at(-1);
    const said = last ? ` Last: "${clip(last.words, 90)}".` : "";
    const head = `- **${v.title}**: corrected ${e?.slipCount ?? 0} times, now on rung ${v.rungAfter} (${RUNG_NAMES[v.rungAfter]}).${said}`;
    lines.push(head);
    if (v.status === "waiting") {
      lines.push(
        "  It was in view, clear and unopposed, but every slip came before the file last changed. Waiting for the next one.",
      );
      continue;
    }
    if (v.status === "watching") {
      lines.push(
        `  A check is drafted (${e?.check?.path}); ${v.slipsAfter} slip${v.slipsAfter === 1 ? "" : "s"} since. It still has to be built.`,
      );
      continue;
    }
    if (v.status === "declined") {
      lines.push("  You declined the drafted check; not drafting it again.");
      continue;
    }
    if (v.cause) {
      lines.push(`  Why it slipped: ${CAUSE_WORDS[v.cause]}.`);
    }
    for (const r of v.repairs) {
      const done = o.applied.has(`${v.id}|${r.kind}|${r.text}`);
      if (r.kind === "add-line") {
        lines.push(`  ${done ? "Added" : "Repair"}: "${clip(r.text, 140)}" in ${r.where}.`);
      } else if (r.kind === "strike-opposing") {
        lines.push(
          `  Yours to decide: ${r.where} says "${clip(r.text, 120)}". Strike it or scope it.`,
        );
      } else {
        lines.push(
          `  Moves up to a check: drafted in ${r.where} (watch-only once built; delete the file to decline).`,
        );
      }
    }
  }
  if (once.length > 0) {
    lines.push(
      "",
      `Seen once (no lesson has failed yet): ${once.map((v) => `${v.title.toLowerCase()} ×${ledger.lessons[v.id]?.slipCount ?? 1}`).join(", ")}.`,
    );
  }
  return lines.join("\n");
}
