import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedCards } from "openclaw/plugin-sdk/fork-thalamus";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig, type LessonsConfig } from "../src/config.js";
import { createCorrectionCapture } from "../src/correction-capture.js";
import { LESSON_SPECS } from "../src/lesson-ladder.js";
import { appendLessonLine, createLessonSleep, LESSONS_HEADING } from "../src/lesson-sleep.js";
import { ThalamusStore } from "../src/store.js";

// The nightly pass on a real folder: a workspace with its always-read files, a skills folder and a notes folder, in a
// temp directory. What it may write is the point: watch changes no rule file, apply adds only a line that tightens.

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 25, 4, 15);
const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"),
) as {
  configSchema: { properties: { lessons: { properties: Record<string, { default?: unknown }> } } };
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function workspace(files: Record<string, string>, mtimeMs = NOW - 30 * DAY) {
  const root = mkdtempSync(join(tmpdir(), "lesson-sleep-"));
  dirs.push(root);
  const ws = join(root, "ws");
  for (const [rel, text] of Object.entries(files)) {
    const p = join(ws, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
    utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  }
  return { root, ws, data: join(root, "data") };
}

function pass(
  w: { ws: string; data: string },
  mode: LessonsConfig["mode"],
  store = new ThalamusStore(":memory:"),
) {
  const cfg = parseConfig({ lessons: { mode } }).lessons;
  const sleep = createLessonSleep({
    store: () => store,
    config: () => cfg,
    dataDir: w.data,
    workspaceDir: () => w.ws,
    noteDirs: () => [join(w.ws, "memory")],
    cards: () => [],
    now: () => NOW,
  });
  return { sleep, store };
}

const correction = (
  store: ThalamusStore,
  runId: string,
  ts: number,
  words: string,
  cls = "reply_language",
) =>
  store.addCorrection({
    ts,
    session: "agent:main:tinker:t",
    runId,
    cls,
    via: "rule",
    cards: [],
    words,
  });

describe("config", () => {
  it("ships watch-only, and a typo is off", () => {
    expect(parseConfig({}).lessons).toEqual({
      mode: "watch",
      minSlips: 2,
      windowHours: 24,
      alwaysRead: [],
      taskDirs: [],
      noteDirs: [],
      target: "",
    });
    expect(manifest.configSchema.properties.lessons.properties.mode.default).toBe("watch");
    expect(manifest.configSchema.properties.lessons.properties.minSlips.default).toBe(2);
    expect(parseConfig({ lessons: { mode: "aply" } }).lessons.mode).toBe("off");
    expect(parseConfig({ lessons: { minSlips: 1 } }).lessons.minSlips).toBe(2);
  });
});

describe("the nightly pass", () => {
  const files = {
    "AGENTS.md": "# AGENTS\n\n## Tools\n\nSkills provide your tools.\n",
    "USER.md": "- Reply in English even when the files on disk are Catalan or Spanish.\n",
    "memory/language.md": "Reply in the same language he uses.\n",
  };

  it("watch: finds why the lesson slipped, drafts the repair, and changes no rule file", async () => {
    const w = workspace(files);
    const { sleep, store } = pass(w, "watch");
    correction(store, "r1", NOW - 5 * 3_600_000, "why did you switch to Spanish");
    correction(store, "r2", NOW - 2 * 3_600_000, "wrong language again");
    const out = await sleep.run({ dry: false });
    expect(out).toMatchObject({
      ok: true,
      mode: "watch",
      corrections: 2,
      applied: [],
      lessons: [{ id: "reply_language", status: "repair", cause: "not-loaded", rungAfter: 1 }],
    });
    for (const [rel, text] of Object.entries(files)) {
      expect(readFileSync(join(w.ws, rel), "utf8")).toBe(text);
    }
    const report = readFileSync(join(w.data, "lessons", "reports", "2026-10-25.md"), "utf8");
    expect(report).toContain("Why it slipped: not loaded");
    expect(report).toContain(`Repair: "${LESSON_SPECS.reply_language.rule}" in AGENTS.md.`);
    expect(report).toContain(`Yours to decide: ${join(w.ws, "USER.md")}:1`);
    const ledger = JSON.parse(readFileSync(join(w.data, "lessons", "ledger.json"), "utf8"));
    expect(ledger).toMatchObject({
      lastRunTs: NOW,
      lessons: { reply_language: { slipCount: 2, rung: 1 } },
    });
  });

  it("a dry run writes nothing at all and returns the same report", async () => {
    const w = workspace(files);
    const { sleep, store } = pass(w, "apply");
    correction(store, "r1", NOW - 5 * 3_600_000, "why did you switch to Spanish");
    correction(store, "r2", NOW - 2 * 3_600_000, "wrong language again");
    const out = await sleep.run({ dry: true });
    expect(out).toMatchObject({ ok: true, dry: true, applied: [] });
    expect(existsSync(w.data)).toBe(false);
    expect(readFileSync(join(w.ws, "AGENTS.md"), "utf8")).toBe(files["AGENTS.md"]);
  });

  it("apply: adds the tightening line where it is read every turn, never strikes a line, and reads it there the next night", async () => {
    const w = workspace(files);
    const { sleep, store } = pass(w, "apply");
    correction(store, "r1", NOW - 5 * 3_600_000, "why did you switch to Spanish");
    correction(store, "r2", NOW - 2 * 3_600_000, "wrong language again");
    const out = await sleep.run({ dry: false });
    expect(out.ok && out.applied).toHaveLength(1);
    const agents = readFileSync(join(w.ws, "AGENTS.md"), "utf8");
    expect(agents).toContain(`${LESSONS_HEADING}\n`);
    expect(agents).toContain(
      `- ${LESSON_SPECS.reply_language.rule} _(nightly lesson 2026-10-25: corrected 2 times)_`,
    );
    // The opposing line is the owner's to strike: untouched.
    expect(readFileSync(join(w.ws, "USER.md"), "utf8")).toBe(files["USER.md"]);

    // The next night: one more slip. The rule is now in view, and the opposing line is the cause.
    const next = createLessonSleep({
      store: () => store,
      config: () => parseConfig({ lessons: { mode: "apply" } }).lessons,
      dataDir: w.data,
      workspaceDir: () => w.ws,
      noteDirs: () => [join(w.ws, "memory")],
      cards: () => [],
      now: () => NOW + DAY,
    });
    correction(store, "r3", NOW + DAY - 3_600_000, "Spanish, please");
    const night2 = await next.run({ dry: false });
    expect(night2).toMatchObject({
      lessons: [{ id: "reply_language", status: "repair", cause: "contradicted", rungAfter: 3 }],
      applied: [],
    });
    expect(readFileSync(join(w.ws, "AGENTS.md"), "utf8")).toBe(agents);
  });

  it("drafts a check, under the data folder, for a rule in view, clear, unopposed and still broken", async () => {
    const w = workspace({
      "AGENTS.md": `- ${LESSON_SPECS.dont_ask.rule}\n`,
    });
    const { sleep, store } = pass(w, "watch");
    correction(store, "r1", NOW - 6 * 3_600_000, "do it yourself", "dont_ask");
    correction(store, "r2", NOW - 3_600_000, "don't ask me to run commands", "dont_ask");
    const out = await sleep.run({ dry: false });
    expect(out).toMatchObject({ lessons: [{ id: "dont_ask", status: "promoted", rungAfter: 4 }] });
    const draft = readFileSync(join(w.data, "lessons", "checks", "dont_ask.md"), "utf8");
    expect(draft).toContain("**How it starts:** watch-only.");
    expect(draft).toContain(`"don't ask me to run commands"`);
  });

  it("from the owner's prompt to the ledger: the capture keeps his words, a named card is its own lesson", async () => {
    const w = workspace({
      "AGENTS.md": "# AGENTS\n",
      "skills/youtube-ultimate/SKILL.md": "# youtube-ultimate\n",
    });
    const store = new ThalamusStore(":memory:");
    const cards = seedCards([
      { kind: "skill", name: "youtube-ultimate", description: "Download YouTube videos." },
    ]);
    let t = NOW - 4 * 3_600_000;
    const cap = createCorrectionCapture({
      store: () => store,
      cards: () => cards,
      now: () => t,
      emit: () => {},
      keep: (c) =>
        store.addCorrection({
          ts: t,
          session: c.input.sessionKey,
          runId: c.input.runId,
          cls: c.cls,
          via: c.via,
          cards: c.cards.map((x) => ({ id: x.id, name: x.name, kind: x.kind })),
          words: c.words,
        }),
    });
    const typed = (runId: string, text: string) => ({
      runId,
      sessionKey: "agent:main:tinker:abc",
      text,
      source: "tinker",
      trigger: "user",
    });
    cap.observe(typed("a", "Did you forget we have a youtube skill?"));
    t += 3_600_000;
    cap.observe(
      typed("b", "Why didn't you use the youtube-ultimate skill? We have a skill for this"),
    );
    expect(
      store.listCorrections().map((r) => [r.runId, r.cls, r.cards.map((c) => c.name)]),
    ).toEqual([
      ["a", "use_existing", ["youtube-ultimate"]],
      ["b", "use_existing", ["youtube-ultimate"]],
    ]);
    const { sleep } = pass(w, "watch", store);
    const out = await sleep.run({ dry: false });
    expect(out).toMatchObject({
      lessons: [
        {
          id: "use_existing:youtube-ultimate",
          status: "repair",
          cause: "not-loaded",
          rungAfter: 2,
        },
      ],
    });
  });

  it("mode off runs nothing", async () => {
    const w = workspace(files);
    const { sleep } = pass(w, "off");
    expect(await sleep.run({ dry: false })).toEqual({ ok: false, error: "lessons-off" });
  });
});

describe("appendLessonLine", () => {
  it("puts the line inside its section when other sections follow, and never twice", () => {
    const w = workspace({
      "AGENTS.md": `# A\n\n${LESSONS_HEADING}\n\n- one\n\n## Later\n\ntext\n`,
    });
    const p = join(w.ws, "AGENTS.md");
    expect(appendLessonLine(p, "two", "_(n)_")).toBe("added");
    expect(readFileSync(p, "utf8")).toBe(
      `# A\n\n${LESSONS_HEADING}\n\n- one\n- two _(n)_\n\n## Later\n\ntext\n`,
    );
    expect(appendLessonLine(p, "two", "_(n)_")).toBe("present");
    expect(appendLessonLine(join(w.ws, "missing.md"), "x", "")).toBe("missing");
  });
});
