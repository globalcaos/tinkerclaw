import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadControls, loadMustCatch, loadReplayCorpus, validateCaseFile } from "../src/cases.js";
import { readSeeds } from "../src/question-book.js";
import type { CaseFile, Question } from "../src/types.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const casesRoot = join(root, "cases");
const questionsDir = join(root, "questions");

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length > 0) rmSync(tmps.pop() as string, { recursive: true, force: true });
});
/** A temp copy of cases/ (must-catch and controls; eval is created by the test). */
function casesCopy(withControls = true): string {
  const d = mkdtempSync(join(tmpdir(), "amygdala-cases-"));
  tmps.push(d);
  cpSync(join(casesRoot, "must-catch"), join(d, "must-catch"), { recursive: true });
  if (withControls) cpSync(join(casesRoot, "controls"), join(d, "controls"), { recursive: true });
  return d;
}
function poison(id: string, kind: string): string {
  return JSON.stringify({
    cases: [
      {
        id,
        kind,
        description: "test-case",
        situation: { originKind: "synthetic" },
        mustBeAtLeast: "hold",
      },
    ],
  });
}

function referencedIds(): string[] {
  return readSeeds(questionsDir).flatMap((s) => (s.question as unknown as Question).mustCatch);
}

describe("must-catch cases", () => {
  const cases = loadMustCatch(join(casesRoot, "must-catch"));

  it("loads, validates and has unique ids", () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(validateCaseFile(c), c.id).toEqual([]);
      expect(c.kind).toBe("must-catch");
      expect(c.situation.originKind).toBe("synthetic");
    }
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it("every referenced case exists and every case is referenced", () => {
    const ids = new Set(cases.map((c) => c.id));
    const refs = new Set(referencedIds());
    for (const r of refs) expect(ids.has(r), `missing ${r}`).toBe(true);
    for (const id of ids) expect(refs.has(id), `unreferenced ${id}`).toBe(true);
  });

  it("contains no host home path", () => {
    for (const c of cases) expect(JSON.stringify(c), c.id).not.toMatch(/\/home\/|\/Users\//);
  });
});

describe("loadReplayCorpus", () => {
  it("equals the must-catch set plus the controls", () => {
    expect(loadReplayCorpus(casesRoot).map((c: CaseFile) => c.id)).toEqual([
      ...loadMustCatch(join(casesRoot, "must-catch")).map((c) => c.id),
      ...loadControls(join(casesRoot, "controls")).map((c) => c.id),
    ]);
  });

  it("never opens cases/eval", () => {
    const d = casesCopy();
    mkdirSync(join(d, "eval"));
    writeFileSync(join(d, "eval", "poison.json"), poison("eval-poison", "eval"));
    writeFileSync(join(d, "eval", "broken.json"), "{ not json");
    const ids = loadReplayCorpus(d).map((c) => c.id);
    expect(ids).not.toContain("eval-poison");
    expect(ids.length).toBe(
      loadMustCatch(join(casesRoot, "must-catch")).length +
        loadControls(join(casesRoot, "controls")).length,
    );
  });

  it("throws when an eval case sits inside must-catch", () => {
    const d = casesCopy();
    writeFileSync(join(d, "must-catch", "zz-poison.json"), poison("eval-in-must-catch", "eval"));
    expect(() => loadReplayCorpus(d)).toThrow(/eval/);
  });

  it("throws on a duplicate id", () => {
    const d = casesCopy();
    const first = loadMustCatch(join(casesRoot, "must-catch"))[0] as CaseFile;
    writeFileSync(join(d, "must-catch", "zz-dup.json"), poison(first.id, "must-catch"));
    expect(() => loadMustCatch(join(d, "must-catch"))).toThrow(/duplicate/);
  });
});

describe("validateCaseFile", () => {
  const ok = {
    id: "x",
    kind: "must-catch",
    description: "test-case",
    situation: { originKind: "synthetic", command: { value: "x", origin: "observed" } },
    mustBeAtLeast: "hold",
  };
  it("accepts a good case and rejects broken ones", () => {
    expect(validateCaseFile(ok)).toEqual([]);
    expect(validateCaseFile({ ...ok, kind: "nope" })).not.toEqual([]);
    expect(validateCaseFile({ ...ok, mustBeAtLeast: "proceed" })).not.toEqual([]);
    expect(validateCaseFile({ ...ok, situation: { originKind: "real" } })).not.toEqual([]);
    expect(
      validateCaseFile({ ...ok, situation: { originKind: "synthetic", command: "raw" } }),
    ).not.toEqual([]);
    expect(
      validateCaseFile({
        ...ok,
        situation: { originKind: "synthetic", bogus: { value: 1, origin: "observed" } },
      }),
    ).not.toEqual([]);
    expect(validateCaseFile({ ...ok, description: "" })).not.toEqual([]);
  });
});

describe("controls", () => {
  const control = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: "control",
    description: "a clear request that must proceed",
    situation: { originKind: "synthetic" },
    mustBeAtMost: "proceed",
    ...over,
  });

  it("a control needs mustBeAtMost and no mustBeAtLeast; a must-catch needs the reverse", () => {
    expect(validateCaseFile(control("c1"))).toEqual([]);
    expect(validateCaseFile(control("c1", { mustBeAtMost: undefined }))).not.toEqual([]);
    expect(validateCaseFile(control("c1", { mustBeAtLeast: "hold" }))).not.toEqual([]);
    const mc = {
      ...control("m1"),
      kind: "must-catch",
      mustBeAtLeast: "hold",
      mustBeAtMost: undefined,
    };
    expect(validateCaseFile(mc)).toEqual([]);
    expect(validateCaseFile({ ...mc, mustBeAtMost: "note" })).not.toEqual([]);
  });

  it("a missing controls folder is an empty set", () => {
    expect(loadControls(join(tmpdir(), "amy-no-such-controls-dir"))).toEqual([]);
  });

  it("loads controls, refuses a non-control in the folder, and the replay corpus includes them", () => {
    const d = casesCopy(false);
    mkdirSync(join(d, "controls"));
    writeFileSync(
      join(d, "controls", "safety.json"),
      JSON.stringify({ cases: [control("ctl-a")] }),
    );
    expect(loadControls(join(d, "controls")).map((c) => c.id)).toEqual(["ctl-a"]);
    expect(loadReplayCorpus(d).map((c) => c.id)).toContain("ctl-a");
    writeFileSync(join(d, "controls", "bad.json"), poison("not-a-control", "must-catch"));
    expect(() => loadControls(join(d, "controls"))).toThrow(/not control|invalid/);
  });

  it("an id used in both must-catch and controls is refused", () => {
    const d = casesCopy(false);
    const first = loadMustCatch(join(d, "must-catch"))[0] as CaseFile;
    mkdirSync(join(d, "controls"));
    writeFileSync(join(d, "controls", "dup.json"), JSON.stringify({ cases: [control(first.id)] }));
    expect(() => loadReplayCorpus(d)).toThrow(/duplicate/);
  });
});
