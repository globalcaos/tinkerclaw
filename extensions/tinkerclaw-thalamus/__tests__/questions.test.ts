import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NEEDS,
  OUTCOME_QUESTION_IDS,
  OUTCOMES,
  SHAPES,
  STEP_KINDS,
  STEP_QUESTION_IDS,
  TASK_QUESTION_IDS,
  TOPIC_CLASSES,
  URGENCIES,
  WORK_KINDS,
} from "openclaw/plugin-sdk/fork-thalamus";
import { describe, expect, it } from "vitest";
import {
  buildParallelQuestions,
  loadQuestions,
  type RoutingQuestion,
} from "../src/reads/questions.js";
import { redactForRouting } from "../src/reads/redact.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "questions");
const q = loadQuestions(dir);

const keys = (x: RoutingQuestion) => Object.keys(x.criteria as object);
const byId = (list: RoutingQuestion[], id: string) => list.find((x) => x.id === id)!;

// Fields a question may read: the amygdala's situation fields that the routing reads use.
const ALLOWED_FIELDS = new Set([
  "request",
  "tool",
  "args",
  "toolRecord",
  "reply",
  "repeatedErrors",
]);

describe("question files", () => {
  it("hold exactly the questions the reads module expects", () => {
    expect(q.task.map((x) => x.id)).toEqual([...TASK_QUESTION_IDS]);
    expect(q.step.map((x) => x.id)).toEqual([...STEP_QUESTION_IDS]);
    expect(q.outcome.map((x) => x.id)).toEqual([...OUTCOME_QUESTION_IDS]);
  });

  it("are all in the routing family, with a version, a type and a cut-off that never acts alone", () => {
    for (const x of [...q.task, ...q.step, ...q.outcome]) {
      expect(x.family, x.id).toBe("routing");
      expect(x.version, x.id).toBeGreaterThanOrEqual(1);
      expect(["choice", "score", "noul"]).toContain(x.type);
      expect(x.cutoff, x.id).toEqual({ kind: "none" });
      expect(x.status, x.id).toBe("active");
      expect(x.instructions.trim().length, x.id).toBeGreaterThan(10);
      expect(x.purpose.length, x.id).toBeGreaterThan(10);
      expect(x.seams.length, x.id).toBeGreaterThan(0);
    }
  });

  it("use kebab-case ids and read only fields a situation has", () => {
    for (const x of [...q.task, ...q.step, ...q.outcome]) {
      expect(x.id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
      for (const f of x.fields) expect(ALLOWED_FIELDS.has(f), `${x.id} reads ${f}`).toBe(true);
    }
  });

  it("offer exactly the options their answers are read from", () => {
    expect(keys(byId(q.task, "route-work-kind")).toSorted()).toEqual([...WORK_KINDS].toSorted());
    expect(keys(byId(q.task, "route-topic-class")).toSorted()).toEqual(
      [...TOPIC_CLASSES].toSorted(),
    );
    expect(keys(byId(q.task, "route-urgency")).toSorted()).toEqual([...URGENCIES].toSorted());
    expect(keys(byId(q.task, "route-shape")).toSorted()).toEqual([...SHAPES].toSorted());
    expect(keys(byId(q.step, "step-kind")).toSorted()).toEqual([...STEP_KINDS].toSorted());
    expect(keys(byId(q.step, "step-context-need")).toSorted()).toEqual([...NEEDS].toSorted());
    expect(keys(byId(q.outcome, "outcome-state")).toSorted()).toEqual([...OUTCOMES].toSorted());
  });

  it("give scores the number of levels the reads module maps", () => {
    expect((byId(q.task, "route-difficulty").criteria as string[]).length).toBe(5);
    expect((byId(q.step, "step-depth").criteria as string[]).length).toBe(3);
    expect((byId(q.step, "step-run-length").criteria as string[]).length).toBe(5);
  });

  it("make the commit question a yes/no", () => {
    const c = byId(q.step, "step-commits-or-claims");
    expect(c.type).toBe("noul");
    expect(Object.keys(c.criteria as object).toSorted()).toEqual(["false", "true"]);
  });

  it("read the task at the prompt, the step before a tool, the outcome after one", () => {
    for (const x of q.task) expect(x.seams).toEqual(["prompt"]);
    for (const x of q.step) expect(x.seams).toEqual(["prompt", "pre-tool"]);
    expect(q.outcome[0].seams).toEqual(["post-tool", "stop"]);
  });
});

describe("templates", () => {
  it("carry their placeholders", () => {
    expect(q.enhancement.fitInstructions).toContain("{card}");
    expect(q.parallel.instructions).toContain("{item}");
    expect(Object.keys(q.enhancement.fitOptions).toSorted()).toEqual([
      "by-structure",
      "covers-part",
      "made-for",
    ]);
    expect(q.enhancement.familyNoneText.length).toBeGreaterThan(3);
    expect(q.enhancement.memberNoneText.length).toBeGreaterThan(3);
  });

  it("build one yes/no question per pending item, at most six, numbered by position", () => {
    const { questions, asked } = buildParallelQuestions(
      ["a", "b", "c", "d", "e", "f", "g", "h"],
      q.parallel,
    );
    expect(asked).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(questions.map((x) => x.id)).toEqual(
      Array.from({ length: 6 }, (_, i) => `step-parallel-ok-${i + 1}`),
    );
    for (const x of questions) expect(x.type).toBe("noul");
    expect(questions[0].instructions).toContain("Item: a");
    expect(questions[0].instructions).not.toContain("{item}");
  });

  it("cut a long item description", () => {
    const { questions } = buildParallelQuestions(["x".repeat(1000)], q.parallel);
    expect(questions[0].instructions.length).toBeLessThan(q.parallel.instructions.length + 260);
  });

  it("ask nothing when there are no pending items", () => {
    expect(buildParallelQuestions([], q.parallel)).toEqual({ questions: [], asked: [] });
  });
});

describe("wording lives only in the question files", () => {
  it("does not appear in the design document", () => {
    const doc = readFileSync(
      join(here, "..", "..", "..", "docs", "plans", "2026-09-30-thalamus-v4-design.md"),
      "utf8",
    );
    const wording = [
      ...[...q.task, ...q.step, ...q.outcome].map((x) => x.instructions),
      q.enhancement.familyInstructions,
      q.enhancement.memberInstructions,
      q.enhancement.fitInstructions,
      q.parallel.instructions,
    ];
    for (const w of wording) expect(doc.includes(w), w.slice(0, 50)).toBe(false);
  });
});

describe("redaction before anything leaves the machine", () => {
  it("removes emails, keys, addresses, numbers and home paths", () => {
    const out = redactForRouting(
      "Mail jane.doe@example.com the file /home/user/src/x.ts, key sk-abcdefghijklmnop1234, host 192.0.2.10, call +34 600 123 456",
    );
    expect(out).not.toContain("jane.doe@example.com");
    expect(out).not.toContain("/home/user");
    expect(out).not.toContain("sk-abcdefghijklmnop1234");
    expect(out).not.toContain("192.0.2.10");
    expect(out).not.toContain("600 123 456");
    expect(out).toContain("~/src/x.ts");
  });

  it("removes long tokens and hashes", () => {
    expect(redactForRouting(`token ${"a1".repeat(30)}`)).toContain("[secret]");
    expect(redactForRouting(`hash ${"deadbeef".repeat(5)}`)).toContain("[secret]");
  });

  it("keeps ordinary prose and cuts at the limit", () => {
    expect(redactForRouting("Compare the translation with the source.")).toBe(
      "Compare the translation with the source.",
    );
    expect(redactForRouting("word ".repeat(2000)).length).toBe(4000);
    expect(redactForRouting("word ".repeat(2000), 100).length).toBe(100);
  });

  it("handles a non-string without throwing", () => {
    expect(redactForRouting(undefined as unknown as string)).toBe("");
  });
});
