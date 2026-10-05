import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { QuestionBook, readSeeds, validateQuestion } from "../src/question-book.js";
import { FAMILY_IDS, FAMILY_PAPER, SITUATION_FIELD_NAMES, type Question } from "../src/types.js";

const seedDir = fileURLToPath(new URL("../questions", import.meta.url));

// id, family, seams, type (design doc section 4)
const EXPECTED: [string, string, string[], string][] = [
  ["instruction-source", "safety", ["pre-tool"], "choice"],
  ["runs-or-quotes", "safety", ["pre-tool"], "noul"],
  ["danger-level", "safety", ["pre-tool"], "score"],
  ["data-tier", "safety", ["pre-tool"], "choice"],
  ["destination-privacy", "safety", ["pre-tool"], "choice"],
  ["repeat-effect", "safety", ["pre-tool"], "noul"],
  ["recent-investment", "safety", ["pre-tool"], "noul"],
  ["stops-own-system", "safety", ["pre-tool"], "noul"],
  ["same-goal-as-held", "safety", ["pre-tool"], "noul"],
  ["evidence-present", "safety", ["pre-tool"], "choice"],
  ["misreading-screen", "second-opinion", ["prompt"], "noul"],
  ["reading-confirmed", "second-opinion", ["post-tool", "pre-tool"], "noul"],
  ["reading-ruled-out", "second-opinion", ["post-tool", "pre-tool"], "noul"],
  ["commitment-changed", "second-opinion", ["pre-tool"], "choice"],
  ["excess-scope", "second-opinion", ["pre-tool"], "noul"],
  ["standing-fact-clash", "second-opinion", ["pre-tool"], "choice"],
  ["purpose-unclear", "second-opinion", ["prompt"], "noul"],
  ["claim-source", "double-check", ["stop"], "choice"],
  ["claim-support", "double-check", ["stop"], "noul"],
  ["claim-record", "double-check", ["stop"], "noul"],
  ["weakens-own-check", "double-check", ["pre-tool"], "noul"],
  ["dodged-work", "double-check", ["stop"], "choice"],
  ["refusal", "double-check", ["stop"], "noul"],
  ["stale-state-claim", "double-check", ["stop"], "noul"],
  ["progress-made", "efficiency", ["post-tool"], "score"],
  ["procedure-choice", "efficiency", ["prompt"], "choice"],
  ["request-difficulty", "efficiency", ["prompt"], "score"],
  ["surprise", "personality", ["post-tool"], "score"],
  ["novelty", "personality", ["post-tool"], "noul"],
  ["worth-knowing", "personality", ["post-tool"], "score"],
];
const OFF = ["purpose-unclear", "request-difficulty", "worth-knowing"];

function seedQuestions(): Question[] {
  return readSeeds(seedDir).map((s) => s.question as unknown as Question);
}

function seedHash(): string {
  const h = createHash("sha256");
  for (const { file } of readSeeds(seedDir)) h.update(file).update(readFileSync(file));
  return h.digest("hex");
}

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length > 0) rmSync(tmps.pop() as string, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "amygdala-qb-"));
  tmps.push(d);
  return d;
}

describe("seed questions", () => {
  it("every seed validates and the count matches the design table", () => {
    const qs = seedQuestions();
    expect(qs).toHaveLength(EXPECTED.length);
    for (const q of qs) expect(validateQuestion(q), q.id).toEqual([]);
    // Seeds start at 1 and are raised by hand when a prompt is reworded (refusal v2, 2026-10-01).
    for (const q of qs) expect(q.version).toBeGreaterThanOrEqual(1);
  });

  it("ids are unique and family, seams and type match the table", () => {
    const qs = seedQuestions();
    expect(new Set(qs.map((q) => q.id)).size).toBe(qs.length);
    for (const [id, family, seams, type] of EXPECTED) {
      const q = qs.find((x) => x.id === id);
      expect(q, id).toBeDefined();
      expect(q?.family).toBe(family);
      expect(q?.seams).toEqual(seams);
      expect(q?.type).toBe(type);
      expect(q?.status).toBe(OFF.includes(id) ? "off" : "active");
    }
  });

  it("no instructions contain a home path or an e-mail address", () => {
    for (const q of seedQuestions()) {
      expect(q.instructions, q.id).not.toMatch(/(~\/|\/home\/|\/Users\/|[\w.+-]+@[\w-]+\.[\w.]+)/);
    }
  });

  // the architect 2026-10-01: "When I open a prompt from Jev, I don't understand it." Each file opens like a page for a person.
  it("every seed reads like a page for a person: family line, the idea, then examples, before the question", () => {
    for (const { question, file } of readSeeds(seedDir)) {
      const text = readFileSync(file, "utf8");
      const fam = FAMILY_PAPER.find((f) => f.id === question.family)!;
      const [title, familyLine, idea] = text.split(/\n\s*\n/);
      // The paper's name for the function, then the question (the architect 2026-10-01: "I cannot find the curiosity one").
      expect(title, file).toMatch(/^# [A-Z][^:]{2,30}: [a-z"].*\?$/);
      // `_italic_`: the repo formatter turns `*italic*` into it on commit.
      expect(familyLine, file).toBe(`_${fam.title}: ${fam.subtitle}_ · J11 paper §${fam.section}`);
      expect(idea, file).not.toMatch(/^#/);
      const ex = text.indexOf("\n## Examples\n");
      expect(ex, file).toBeGreaterThan(0);
      expect(ex, file).toBeLessThan(text.indexOf("\n## The question Jev is asked\n"));
      const rows = text
        .slice(ex)
        .split("\n## ")[1]!
        .split("\n")
        .filter((l) => l.startsWith("|"));
      expect(rows.length, `${file}: header, rule and at least two examples`).toBeGreaterThanOrEqual(
        4,
      );
    }
  });

  it("the paper's family list names every family once and every seed once, in a family it belongs to", () => {
    expect(FAMILY_PAPER.map((f) => f.id).toSorted()).toEqual([...FAMILY_IDS].toSorted());
    const listed = FAMILY_PAPER.flatMap((f) => f.prompts.map((id) => `${f.id}/${id}`));
    expect(listed.toSorted()).toEqual(
      seedQuestions()
        .map((q) => `${q.family}/${q.id}`)
        .toSorted(),
    );
  });
});

describe("QuestionBook", () => {
  it("forSeam returns only active questions of enabled families", () => {
    const book = new QuestionBook({ seedDir });
    const got = book.forSeam("pre-tool", { safety: true });
    expect(got).toHaveLength(10);
    for (const q of got) {
      expect(q.family).toBe("safety");
      expect(q.status).toBe("active");
      expect(q.seams).toContain("pre-tool");
    }
    const prompt = book.forSeam("prompt", { "second-opinion": true }).map((q) => q.id);
    expect(prompt).toContain("misreading-screen");
    expect(prompt).not.toContain("purpose-unclear");
    expect(book.forSeam("pre-tool", {})).toEqual([]);
  });

  it("an off question never appears on any seam", () => {
    const book = new QuestionBook({ seedDir });
    const all = {
      safety: true,
      "second-opinion": true,
      "double-check": true,
      efficiency: true,
      personality: true,
    };
    for (const seam of ["prompt", "pre-tool", "post-tool", "stop"] as const) {
      const ids = book.forSeam(seam, all).map((q) => q.id);
      for (const off of OFF) expect(ids).not.toContain(off);
    }
  });

  it("get defaults to the active version; addOverlay and setActive work", () => {
    const overlayDir = join(tmp(), "overlay");
    const book = new QuestionBook({ seedDir, overlayDir });
    const v1 = book.get("danger-level") as Question;
    expect(book.activeVersion("danger-level")).toBe(1);
    const v2: Question = { ...v1, version: 2, parent: 1, instructions: "test-question" };
    book.addOverlay(v2);
    expect(book.versions("danger-level").map((q) => q.version)).toEqual([1, 2]);
    expect(book.get("danger-level")?.version).toBe(1);
    book.setActive("danger-level", 2);
    expect(book.get("danger-level")?.instructions).toBe("test-question");
    expect(book.get("danger-level", 1)?.version).toBe(1);
    // a fresh book loads the overlay and takes the highest version as active
    const again = new QuestionBook({ seedDir, overlayDir });
    expect(again.activeVersion("danger-level")).toBe(2);
    expect(() => book.setActive("danger-level", 9)).toThrow();
    expect(() => book.setActive("no-such-question", 1)).toThrow();
  });

  it("refuses an existing (id, version), seed or overlay, and a missing overlayDir", () => {
    const book = new QuestionBook({ seedDir, overlayDir: join(tmp(), "overlay") });
    const v1 = book.get("claim-record") as Question;
    const next = v1.version + 1;
    expect(() => book.addOverlay({ ...v1 })).toThrow(/immutable/);
    book.addOverlay({ ...v1, version: next });
    expect(() => book.addOverlay({ ...v1, version: next })).toThrow(/immutable/);
    const bare = new QuestionBook({ seedDir });
    expect(() => bare.addOverlay({ ...v1, version: next })).toThrow(/overlayDir/);
  });

  it("never changes the seed files", () => {
    const before = seedHash();
    const book = new QuestionBook({ seedDir, overlayDir: join(tmp(), "overlay") });
    const q = book.get("novelty") as Question;
    book.addOverlay({ ...q, version: 2 });
    book.setActive("novelty", 2);
    expect(seedHash()).toBe(before);
  });
});

describe("seed prompt files (one .md per prompt, 2026-09-30)", () => {
  const write = (dir: string, rel: string, text: string): void => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  // The human-first layout (the architect 2026-10-01): title, the idea, examples, then the question, its answers and the
  // settings at the bottom.
  const md = (
    id: string,
    family: string,
    o: { title?: string; extra?: string; type?: string; answers?: string; question?: string } = {},
  ): string =>
    `# ${o.title ?? "Is it N?"}\n\n_Safety: no action you would regret_ · J11 paper §6.1\n\nThe idea.\n\n` +
    `## Examples\n\n| The agent | Jev answers |\n|---|---|\n| does x | yes |\n| does y | no |\n\n` +
    `## The question Jev is asked\n\n${o.question ?? "  The question.  "}\n\n` +
    (o.answers !== undefined ? `## The answers Jev can pick\n\n${o.answers}\n\n` : "") +
    `## Settings\n\n\`\`\`yaml\n# a comment\nid: ${id}\nversion: 1\nfamily: ${family}\nstatus: "off"\nseams: [stop]\n` +
    `type: ${o.type ?? "noul"}\nfields: [claims]\ncutoff: {kind: none}\npurpose: p\norigin: o\nretirement: r\n` +
    `mustCatch: []\n${o.extra ?? ""}\`\`\`\n`;

  it("every prompt has its own file, and file() points at it", () => {
    const book = new QuestionBook({ seedDir });
    for (const id of book.ids()) {
      const q = book.get(id)!;
      expect(book.file(id)).toBe(join(seedDir, q.family, `${id}.md`));
      expect(existsSync(book.file(id)!)).toBe(true);
    }
  });

  it('the title is the name, the question section is the question; "off" stays text', () => {
    const d = tmp();
    write(d, "safety/x-one.md", md("x-one", "safety"));
    const [s] = readSeeds(d);
    expect(s!.question.name).toBe("Is it N?");
    expect(s!.question.instructions).toBe("The question.");
    expect(s!.question.status).toBe("off");
    expect(s!.question.criteria).toBeUndefined();
  });

  it("a score's answers are the numbered list from 0; a choice's are the `key`: text list", () => {
    const d = tmp();
    write(
      d,
      "safety/x-score.md",
      md("x-score", "safety", { type: "score", answers: "0. none\n1. a: b\n\n2. all" }),
    );
    write(
      d,
      "safety/x-choice.md",
      md("x-choice", "safety", {
        type: "choice",
        answers: "- `a`: first\n* `b-c`: second, with: colon\n- `d`",
      }),
    );
    const [choice, score] = readSeeds(d);
    expect(score!.question.criteria).toEqual(["none", "a: b", "all"]);
    expect(choice!.question.criteria).toEqual({
      a: "first",
      "b-c": "second, with: colon",
      d: null,
    });
  });

  it("a multi-line question keeps its lines; a heading inside the settings fence is not a section", () => {
    const d = tmp();
    write(
      d,
      "safety/x-one.md",
      md("x-one", "safety", { question: "Line one.\nLine two.", extra: "## not a heading\n" }),
    );
    const [s] = readSeeds(d);
    expect(s!.question.instructions).toBe("Line one.\nLine two.");
  });

  it("rejects a prompt in the wrong folder, a file name that is not its id, and wording or a name in the settings", () => {
    const a = tmp();
    write(a, "safety/x-one.md", md("x-one", "efficiency"));
    expect(() => readSeeds(a)).toThrow(/folder is safety/);
    const b = tmp();
    write(b, "safety/other.md", md("x-one", "safety"));
    expect(() => readSeeds(b)).toThrow(/file name must match/);
    const c = tmp();
    write(c, "safety/x-one.md", md("x-one", "safety", { extra: "instructions: sneaky\n" }));
    expect(() => readSeeds(c)).toThrow(/its own section/);
    const e = tmp();
    write(e, "safety/x-one.md", md("x-one", "safety", { extra: "name: Other\n" }));
    expect(() => readSeeds(e)).toThrow(/# title/);
    const f = tmp();
    write(f, "safety/x-one.md", md("x-one", "safety", { extra: "criteria: [a, b]\n" }));
    expect(() => readSeeds(f)).toThrow(/answers go in/);
  });

  it("rejects the old front-matter layout, a missing title or question, and a broken answer list", () => {
    const old = tmp();
    write(old, "safety/x-one.md", "---\nid: x-one\n---\n\nThe question.\n");
    expect(() => readSeeds(old)).toThrow(/old layout/);
    const noTitle = tmp();
    write(noTitle, "safety/x-one.md", md("x-one", "safety").replace(/^# .*\n/, ""));
    expect(() => readSeeds(noTitle)).toThrow(/# title/);
    const noQ = tmp();
    write(
      noQ,
      "safety/x-one.md",
      md("x-one", "safety").replace("## The question Jev is asked", "## Something else"),
    );
    expect(() => readSeeds(noQ)).toThrow(/The question Jev is asked/);
    const gap = tmp();
    write(gap, "safety/x-one.md", md("x-one", "safety", { type: "score", answers: "0. a\n2. b" }));
    expect(() => readSeeds(gap)).toThrow(/numbered 0, 1, 2/);
    const junk = tmp();
    write(
      junk,
      "safety/x-one.md",
      md("x-one", "safety", { type: "choice", answers: "- `a`: one\nloose text" }),
    );
    expect(() => readSeeds(junk)).toThrow(/loose text/);
  });

  it("an overlay version points file() at its overlay", () => {
    const overlayDir = join(tmp(), "overlay");
    const book = new QuestionBook({ seedDir, overlayDir });
    const q = book.get("novelty") as Question;
    book.addOverlay({ ...q, version: 2 });
    book.setActive("novelty", 2);
    expect(book.file("novelty")).toBe(join(overlayDir, "novelty.v2.json"));
    expect(book.file("novelty", 1)).toBe(join(seedDir, "personality", "novelty.md"));
  });
});

describe("validateQuestion", () => {
  const base = seedQuestions().find((q) => q.id === "data-tier") as Question;
  it("rejects broken questions", () => {
    expect(validateQuestion(null)).not.toEqual([]);
    expect(validateQuestion({ ...base, id: "Bad_Id" })).not.toEqual([]);
    expect(validateQuestion({ ...base, version: 0 })).not.toEqual([]);
    expect(validateQuestion({ ...base, family: "nope" })).not.toEqual([]);
    expect(validateQuestion({ ...base, seams: [] })).not.toEqual([]);
    expect(validateQuestion({ ...base, type: "score" })).not.toEqual([]);
    expect(validateQuestion({ ...base, criteria: ["a", "b"] })).not.toEqual([]);
    expect(validateQuestion({ ...base, instructions: " " })).not.toEqual([]);
    expect(validateQuestion({ ...base, fields: ["nope"] })).not.toEqual([]);
    expect(
      validateQuestion({ ...base, cutoff: { kind: "choice", option: "zzz", at: 0.5 } }),
    ).not.toEqual([]);
    expect(validateQuestion({ ...base, cutoff: { kind: "prob", at: 0.5 } })).not.toEqual([]);
    expect(validateQuestion({ ...base, mustCatch: [1] })).not.toEqual([]);
    expect(validateQuestion({ ...base, retirement: "" })).not.toEqual([]);
  });

  it("accepts negated choice, at-or-below level and none cut-offs; rejects malformed ones", () => {
    const choice = {
      ...base,
      type: "choice",
      criteria: { same: "a", other: "b" },
      cutoff: { kind: "choice", option: "same", at: 0.6, negate: true },
    };
    expect(validateQuestion(choice)).toEqual([]);
    expect(
      validateQuestion({ ...choice, cutoff: { ...choice.cutoff, negate: "yes" } }),
    ).not.toEqual([]);
    const score = { ...base, type: "score", criteria: ["a", "b", "c"] };
    expect(validateQuestion({ ...score, cutoff: { kind: "level", atOrBelow: 0 } })).toEqual([]);
    expect(validateQuestion({ ...score, cutoff: { kind: "level", atOrAbove: 2 } })).toEqual([]);
    expect(validateQuestion({ ...score, cutoff: { kind: "level" } })).not.toEqual([]);
    expect(
      validateQuestion({ ...score, cutoff: { kind: "level", atOrAbove: 1, atOrBelow: 0 } }),
    ).not.toEqual([]);
    expect(validateQuestion({ ...base, cutoff: { kind: "none" } })).toEqual([]);
  });
});

describe("validate-questions.mjs", () => {
  it("keeps the same situation-field list as types.ts", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "validate-questions.mjs"),
      "utf-8",
    );
    const block = /const FIELDS = \[([\s\S]*?)\];/.exec(src)?.[1] ?? "";
    const names = [...block.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]).sort();
    expect(names).toEqual([...SITUATION_FIELD_NAMES].sort());
  });
});

describe("QuestionBook.register (in memory, no file)", () => {
  it("adds a version that is visible but not active, and versions stay immutable", () => {
    const book = new QuestionBook({ seedDir });
    const q = book.get("danger-level") as Question;
    const v2 = { ...q, version: q.version + 1, parent: q.version };
    book.register(v2);
    expect(book.get("danger-level", v2.version)?.version).toBe(v2.version);
    expect(book.get("danger-level")?.version).toBe(q.version); // active pointer untouched
    expect(() => book.register(v2)).toThrow(/immutable/);
    expect(() => book.register({ ...v2, version: 9, id: "Bad_Id" })).toThrow(/invalid/);
  });
});
