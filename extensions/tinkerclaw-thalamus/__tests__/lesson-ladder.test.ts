import { describe, expect, it } from "vitest";
import {
  addSlip,
  decide,
  emptyLedger,
  isClear,
  LESSON_SPECS,
  locate,
  renderLessonsReport,
  specFor,
  type Ledger,
  type LessonEntry,
  type LessonSpec,
  type SourceFile,
} from "../src/lesson-ladder.js";

// The ladder on the post's own story ("Why your AI assistant forgets what you told it", section 7), and on the lines the
// probes were checked against in the live always-read files on 2026-10-25 (SOUL.md's language principle, USER.md's
// "Reply in English even when the files on disk are Catalan or Spanish").

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);
const SPEC = LESSON_SPECS.reply_language;
const SOUL_LINE =
  "Reply in the language the architect is typing, even when the files on disk are in another. He said so on 2026-09-02: keep the chat in English.";
const USER_LINE =
  "- **Notes:** Reply in English even when the files on disk are Catalan or Spanish.";

const file = (path: string, rung: 1 | 2 | 3, text: string, mtimeMs = T0): SourceFile => ({
  path,
  rung,
  mtimeMs,
  text,
});

function lesson(slipDays: number[], spec: LessonSpec = SPEC): { ledger: Ledger; e: LessonEntry } {
  const ledger = emptyLedger();
  let e: LessonEntry | undefined;
  for (const [i, d] of slipDays.entries()) {
    e = addSlip(
      ledger,
      {
        ts: T0 + d * DAY,
        runId: `run-${i}`,
        via: "rule",
        words: "why did you switch to Spanish",
        cls: "reply_language",
      },
      spec,
    );
  }
  if (!e) {
    throw new Error("a lesson needs at least one slip");
  }
  return { ledger, e };
}

const opts = (now: number, checkExists = false) => ({
  now,
  minSlips: 2,
  checkExists,
  target: "AGENTS.md",
});

describe("locate", () => {
  it("finds the rule on its strongest rung, and the opposing line, but never counts the rule's own line against it", () => {
    const l = locate(SPEC, [
      file("/ws/memory/lang.md", 1, "Reply in the same language he uses."),
      file("/ws/SOUL.md", 3, `<principle>\n${SOUL_LINE}\n</principle>`),
      file("/ws/USER.md", 3, `# USER\n${USER_LINE}`),
    ]);
    expect(l.rung).toBe(3);
    expect(l.affirm.map((a) => `${a.path}:${a.line}`)).toEqual([
      "/ws/SOUL.md:2",
      "/ws/memory/lang.md:1",
    ]);
    expect(l.oppose.map((a) => `${a.path}:${a.line}`)).toEqual(["/ws/USER.md:2"]);
    expect(l.clear).toBe(true);
  });

  it("an opposing line in a saved note is not in view and does not count", () => {
    const l = locate(SPEC, [file("/ws/memory/old.md", 1, "Always answer in English.")]);
    expect(l).toMatchObject({ rung: 0, oppose: [] });
  });

  it("a named card's lesson looks for the card's name", () => {
    const spec = specFor("use_existing", {
      name: "torrent-scout",
      kind: "skill",
      purpose: "Find a torrent",
    });
    expect(spec.rule).toBe("Find a torrent → skill `torrent-scout`: run it before improvising.");
    expect(
      locate(spec, [file("/ws/skills/torrent-scout/SKILL.md", 2, "# torrent-scout")]).rung,
    ).toBe(2);
  });

  it("a word that only mentions the topic is not the rule (the 2026-10-25 replay's false matches)", () => {
    const skill = file(
      "/ws/skills/x/SKILL.md",
      2,
      "Keep going until the build is green.\nThe listing uses plain language.",
    );
    expect(locate(LESSON_SPECS.keep_going, [skill]).rung).toBe(0);
    expect(locate(LESSON_SPECS.simpler, [skill]).rung).toBe(0);
    const rules = file(
      "/ws/AGENTS.md",
      3,
      "A bare 'keep going' means you stopped too early.\nExplain it in plain words, with one everyday example.",
    );
    expect(locate(LESSON_SPECS.keep_going, [rules]).rung).toBe(3);
    expect(locate(LESSON_SPECS.simpler, [rules]).rung).toBe(3);
  });
});

describe("isClear", () => {
  it("a directive with no hedge is clear; a softened or wordless one is not", () => {
    expect(isClear("Reply in the language the owner is typing.")).toBe(true);
    expect(isClear("Never ask the owner to run a command you can run.")).toBe(true);
    expect(isClear("Try to reply in the user's language where possible.")).toBe(false);
    expect(isClear("Language matters to him.")).toBe(false);
  });
});

describe("decide", () => {
  it("one correction is not a lesson yet", () => {
    const { e } = lesson([1]);
    expect(decide(e, SPEC, locate(SPEC, []), opts(T0 + 2 * DAY)).status).toBe("seen-once");
  });

  it("a rule only in a saved note was not loaded: the repair is a line read every turn, which only tightens", () => {
    const { e } = lesson([1, 3]);
    const v = decide(
      e,
      SPEC,
      locate(SPEC, [file("/ws/memory/lang.md", 1, "Reply in the same language he uses.")]),
      opts(T0 + 4 * DAY),
    );
    expect(v).toMatchObject({ status: "repair", cause: "not-loaded", rungAfter: 1 });
    expect(v.repairs).toEqual([
      { kind: "add-line", text: SPEC.rule, where: "AGENTS.md", owner: false },
    ]);
  });

  it("a rule in view with a line that says the opposite is contradicted, and striking that line is the owner's", () => {
    const { e } = lesson([1, 3]);
    const v = decide(
      e,
      SPEC,
      locate(SPEC, [file("/ws/SOUL.md", 3, SOUL_LINE), file("/ws/USER.md", 3, USER_LINE)]),
      opts(T0 + 4 * DAY),
    );
    expect(v).toMatchObject({ status: "repair", cause: "contradicted", rungAfter: 3 });
    expect(v.repairs).toEqual([
      { kind: "strike-opposing", text: USER_LINE, where: "/ws/USER.md:1", owner: true },
    ]);
  });

  it("a rule in view but soft is vague: the repair is the concrete line beside it, never a lock", () => {
    const { e } = lesson([1, 3]);
    const v = decide(
      e,
      SPEC,
      locate(SPEC, [file("/ws/AGENTS.md", 3, "Try to reply in his language where possible.")]),
      opts(T0 + 4 * DAY),
    );
    expect(v).toMatchObject({ status: "repair", cause: "vague" });
    expect(v.repairs.map((r) => r.kind)).toEqual(["add-line"]);
  });

  it("in view, clear, unopposed and broken after it was there: moves up one rung, to a drafted check", () => {
    const { e } = lesson([5, 6]);
    const v = decide(
      e,
      SPEC,
      locate(SPEC, [file("/ws/SOUL.md", 3, SOUL_LINE, T0)]),
      opts(T0 + 7 * DAY),
    );
    expect(v).toMatchObject({
      status: "promoted",
      cause: "still-broken",
      rungBefore: 0,
      rungAfter: 4,
      slipsAfter: 2,
    });
    expect(v.repairs).toEqual([
      { kind: "draft-check", text: SPEC.rule, where: "checks/reply_language.md", owner: false },
    ]);
    expect(e.check).toEqual({ path: "checks/reply_language.md", at: T0 + 7 * DAY });
  });

  it("a file changed after the slips proves nothing: the lesson waits for a slip after it", () => {
    const { e } = lesson([1, 2]);
    const v = decide(
      e,
      SPEC,
      locate(SPEC, [file("/ws/SOUL.md", 3, SOUL_LINE, T0 + 3 * DAY)]),
      opts(T0 + 4 * DAY),
    );
    expect(v).toMatchObject({ status: "waiting", rungAfter: 3, slipsAfter: 0 });
  });

  it("a drafted check watches; a deleted one is the owner's no and is not drafted again", () => {
    const { ledger, e } = lesson([5, 6]);
    decide(e, SPEC, locate(SPEC, [file("/ws/SOUL.md", 3, SOUL_LINE)]), opts(T0 + 7 * DAY));
    addSlip(
      ledger,
      {
        ts: T0 + 8 * DAY,
        runId: "run-9",
        via: "rule",
        words: "again English",
        cls: "reply_language",
      },
      SPEC,
    );
    const watching = decide(
      e,
      SPEC,
      locate(SPEC, [file("/ws/SOUL.md", 3, SOUL_LINE)]),
      opts(T0 + 9 * DAY, true),
    );
    expect(watching).toMatchObject({ status: "watching", rungAfter: 4, slipsAfter: 1 });

    addSlip(
      ledger,
      {
        ts: T0 + 10 * DAY,
        runId: "run-10",
        via: "rule",
        words: "English again",
        cls: "reply_language",
      },
      SPEC,
    );
    const gone = decide(
      e,
      SPEC,
      locate(SPEC, [file("/ws/SOUL.md", 3, SOUL_LINE)]),
      opts(T0 + 11 * DAY, false),
    );
    expect(gone).toMatchObject({ status: "declined", rungAfter: 3, repairs: [] });
    expect(e.checkDeclinedAt).toBe(T0 + 11 * DAY);
  });

  it("harm that cannot be undone skips the ladder: a check on the first correction", () => {
    const spec: LessonSpec = { ...SPEC, title: "Never delete files unasked", irreversible: true };
    const { e } = lesson([1], spec);
    expect(decide(e, spec, locate(spec, []), opts(T0 + 2 * DAY))).toMatchObject({
      status: "promoted",
      rungAfter: 4,
    });
  });

  it("the post's story, night by night: not loaded, then contradicted, then a check", () => {
    // Night 1: two corrections, the rule only in a saved note.
    const { ledger, e } = lesson([1, 2]);
    const note = file("/ws/memory/lang.md", 1, "Reply in the same language he uses.");
    expect(decide(e, SPEC, locate(SPEC, [note]), opts(T0 + 3 * DAY)).cause).toBe("not-loaded");
    // The line goes into the file read every turn, where an older line says to answer in English.
    const agents = file("/ws/AGENTS.md", 3, `${USER_LINE}\n- ${SPEC.rule}`, T0 + 3 * DAY);
    addSlip(
      ledger,
      {
        ts: T0 + 13 * DAY,
        runId: "run-a",
        via: "rule",
        words: "wrong language",
        cls: "reply_language",
      },
      SPEC,
    );
    expect(decide(e, SPEC, locate(SPEC, [note, agents]), opts(T0 + 14 * DAY)).cause).toBe(
      "contradicted",
    );
    // The owner strikes the old line; a month later it slips once more, after the file last changed.
    const fixed = file("/ws/AGENTS.md", 3, `- ${SPEC.rule}`, T0 + 15 * DAY);
    addSlip(
      ledger,
      {
        ts: T0 + 40 * DAY,
        runId: "run-b",
        via: "rule",
        words: "Spanish again",
        cls: "reply_language",
      },
      SPEC,
    );
    expect(decide(e, SPEC, locate(SPEC, [note, fixed]), opts(T0 + 41 * DAY))).toMatchObject({
      status: "promoted",
      rungAfter: 4,
    });
  });
});

describe("the ledger and the report", () => {
  it("the same run is one slip", () => {
    const ledger = emptyLedger();
    const s = { ts: T0, runId: "r", via: "rule", words: "x", cls: "reply_language" as const };
    addSlip(ledger, s, SPEC);
    addSlip(ledger, { ...s, ts: T0 + 1 }, SPEC);
    expect(ledger.lessons.reply_language).toMatchObject({ slipCount: 1, slips: [{ ts: T0 }] });
  });

  it("says why each lesson slipped and which repair is the owner's", () => {
    const { ledger, e } = lesson([1, 3]);
    const v = decide(
      e,
      SPEC,
      locate(SPEC, [file("/ws/SOUL.md", 3, SOUL_LINE), file("/ws/USER.md", 3, USER_LINE)]),
      opts(T0 + 4 * DAY),
    );
    const md = renderLessonsReport([v], ledger, {
      now: T0 + 4 * DAY,
      mode: "watch",
      applied: new Set(),
      corrections: 2,
    });
    expect(md).toContain("## Lessons (2026-10-05)");
    expect(md).toContain("1 with a repair only you can make");
    expect(md).toContain("Watch mode: repairs are drafted, nothing was changed.");
    expect(md).toContain("**Reply in the language the owner is typing**: corrected 2 times");
    expect(md).toContain("Why it slipped: contradicted: a line in view says the opposite.");
    expect(md).toContain('Yours to decide: /ws/USER.md:1 says "- **Notes:** Reply in English');
  });

  it("a quiet night is one line", () => {
    expect(
      renderLessonsReport([], emptyLedger(), {
        now: T0,
        mode: "watch",
        applied: new Set(),
        corrections: 0,
      }),
    ).toBe("## Lessons (2026-10-01)\n\nNo corrections since the last pass.");
  });
});
