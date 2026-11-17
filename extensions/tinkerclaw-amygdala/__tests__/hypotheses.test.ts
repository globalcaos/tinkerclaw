import { describe, expect, it } from "vitest";
import {
  ACTING_LABELS,
  anchorsOf,
  evidenceDigest,
  judgePrompt,
  parseJudgeVerdicts,
  statedAsFact,
} from "../src/hypotheses.js";

const texts = (reply: string) => statedAsFact(reply).map((c) => c.text);

describe("stated as fact — which sentences are candidates", () => {
  it("takes an absence stated as fact (2026-11-14 00:14: the Pi did have a key on the laptop)", () => {
    const [c] = statedAsFact(
      "**Why I can't fix it alone:**\n- The Pi has no ssh key on the laptop.",
    );
    expect(c).toMatchObject({ text: "The Pi has no ssh key on the laptop.", kind: "absence" });
    expect(c?.anchors).toEqual(["ssh", "key", "laptop"]);
  });

  it("takes the writer's own inability, and a cause that names something", () => {
    expect(texts("I can't reach the laptop from here.")).toEqual([
      "I can't reach the laptop from here.",
    ]);
    expect(statedAsFact("The build failed because `node_modules` was not linked.")[0]?.kind).toBe(
      "cause",
    );
  });

  it("leaves a hedged statement alone: it already says it is a hypothesis", () => {
    expect(texts("The Pi probably has no ssh key on the laptop.")).toEqual([]);
    expect(texts("I think there is no backup of it.")).toEqual([]);
    expect(texts("There is no backup (inferred).")).toEqual([]);
  });

  it("leaves own actions, plans, questions and bare negation alone", () => {
    expect(texts("I did not merge the branch.")).toEqual([]);
    expect(texts("If the key is missing, I'll add one.")).toEqual([]);
    expect(texts("Is there no key on the laptop?")).toEqual([]);
    expect(texts("Nothing is merged yet, and the fix is not running until the rebuild.")).toEqual(
      [],
    );
    expect(texts("With your OK, I'd show a missing plan as a greyed tab.")).toEqual([]);
  });

  it("drops a cause with nothing specific in it, and the spoken line, headings, tables and code", () => {
    expect(texts("It failed because the meter was off.")).toEqual([]);
    const reply = [
      "**Jarvis:** *There is no ssh key, which is a tragedy.*",
      "## There is no heading claim",
      "| There is no table claim | x |",
      "```",
      "There is no code claim.",
      "```",
    ].join("\n");
    expect(texts(reply)).toEqual([]);
  });

  it("reads a sentence without its bold label", () => {
    expect(texts("**Small gap:** the sub-agent path has no committed test of its own.")).toEqual([
      "the sub-agent path has no committed test of its own.",
    ]);
  });

  it("pairs a one-letter code span correctly instead of reading the prose between spans as code", () => {
    expect(
      anchorsOf("Five use `BuildConfig`/`R` without importing it, in `ai.openclaw.app`."),
    ).toEqual(["BuildConfig", "ai.openclaw.app"]);
  });
});

describe("stated as fact — what the judge reads and how its answer is read", () => {
  const cands = statedAsFact("The Pi has no ssh key on the laptop.");

  it("the digest keeps every call, the head and tail of its output, and the middle lines with a rare candidate word", () => {
    const filler = Array.from({ length: 30 }, (_, i) => `filler line ${i}`);
    const long = [...filler.slice(0, 15), "ssh -i ~/.ssh/id_laptop", ...filler.slice(15)].join(
      "\n",
    );
    const digest = evidenceDigest(
      cands,
      [
        { tool: "Bash", input: "grep '^Host .*laptop' ~/.ssh/config", output: "" },
        { tool: "Read", input: '{"file_path":"/notes/a.md"}', output: long },
        { tool: "Bash", input: "df -h", output: "Filesystem 916G" },
      ],
      "fix it",
    );
    expect(digest).toContain("[owner] fix it");
    expect(digest).toContain("[call 1] Bash: grep '^Host .*laptop' ~/.ssh/config (no output)");
    expect(digest).toContain("filler line 0");
    expect(digest).toContain("ssh -i ~/.ssh/id_laptop");
    expect(digest).toContain("filler line 29");
    expect(digest).not.toContain("filler line 10");
    expect(digest).toContain("[call 3] Bash: df -h\nFilesystem 916G");
  });

  it("a word on many output lines does not pick lines; a job's report is kept longer than a typed prompt", () => {
    const noisy = Array.from({ length: 40 }, (_, i) => `the laptop line ${i}`).join("\n");
    const digest = evidenceDigest(
      cands,
      [{ tool: "Bash", input: "cat log", output: noisy }],
      "fix it",
    );
    expect(digest).not.toContain("the laptop line 20");
    const report = "x".repeat(4000);
    expect(evidenceDigest(cands, [], report).length).toBeLessThan(2000);
    expect(evidenceDigest(cands, [], report, { ownerMax: 6000 }).length).toBeGreaterThan(4000);
  });

  it("the digest stays inside its size, newest calls kept", () => {
    const calls = Array.from({ length: 50 }, (_, i) => ({
      tool: "Bash",
      input: `ls laptop-${i}`,
      output: "laptop ".repeat(30),
    }));
    const digest = evidenceDigest(cands, calls, "fix it", { maxChars: 2000 });
    expect(digest.length).toBeLessThanOrEqual(2000);
    expect(digest).toContain("laptop-49");
    expect(digest).not.toContain("laptop-0 ");
  });

  it("the prompt numbers the statements and names every label", () => {
    const p = judgePrompt(cands, "[owner] fix it");
    expect(p).toContain("1. The Pi has no ssh key on the laptop.");
    for (const l of ["shown", "told", "beyond", "contradicted", "unseen"])
      expect(p).toContain(`- ${l}:`);
  });

  it("reads labels from a fenced answer and drops anything it cannot trust", () => {
    const m = parseJudgeVerdicts(
      '```json\n[{"n":1,"label":"contradicted"},{"n":2,"label":"maybe"},{"n":9,"label":"shown"}]\n```',
      2,
    );
    expect([...m.entries()]).toEqual([[1, "contradicted"]]);
    expect(parseJudgeVerdicts("no json here", 1).size).toBe(0);
    expect([...ACTING_LABELS].sort()).toEqual(["beyond", "contradicted"]);
  });
});
