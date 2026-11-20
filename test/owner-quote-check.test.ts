import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// FORK 2026-10-28 — the pre-commit gate that keeps the owner's prompts out of this public repo.
const SCRIPT = path.resolve(import.meta.dirname, "..", "scripts", "owner-quote-check.sh");
const run = (diff: string, env: NodeJS.ProcessEnv = {}) =>
  spawnSync("bash", [SCRIPT], { input: diff, encoding: "utf8", env: { ...process.env, ...env } })
    .status;
const added = (file: string, line: string) => `+++ b/${file}\n+${line}\n`;

describe("scripts/owner-quote-check.sh", () => {
  it("blocks a FORK comment that quotes the architect", () => {
    expect(run(added("a.ts", '// FORK 2026-10-28 (the architect: "make it faster")'))).toBe(1);
  });

  it("blocks a bug-log symptom written in the owner's words", () => {
    expect(run(added("bug.md", '- **Symptom, in the user\'s words:** _"it froze"_'))).toBe(1);
  });

  it("blocks an unnamed first-person quote in docs and comments, not in code strings", () => {
    expect(
      run(
        added("chapter.md", '- rule (2026-10-19). "I did not ask you to remove all the buttons."'),
      ),
    ).toBe(1);
    expect(run(added("a.ts", '  // the report: "You failed to show the chart again"'))).toBe(1);
    expect(run(added("a.ts", 'const msg = "I could not reach the gateway, retrying";'))).toBe(0);
  });

  it("blocks capitalised and comma forms of a named quote", () => {
    expect(
      run(added("q.md", '> The owner, 2026-09-24: _"We have two mechanisms for queued prompts"_')),
    ).toBe(1);
    expect(
      run(
        added(
          "q.md",
          '- **Surface:** "it breaks" (the user, 2026-05-23, said: "I cannot move tasks")',
        ),
      ),
    ).toBe(1);
  });

  it("passes neutral comments and upstream-style prompts that address the user", () => {
    expect(run(added("a.ts", "// FORK 2026-10-28: wake the phone app via FCM"))).toBe(0);
    expect(run(added("a.ts", 'const p = "Ask the user: \\"Continue?\\"";'))).toBe(0);
  });

  it("says how many hits it held back, and prints every one on request (2026-11-17)", () => {
    // A publish squash held 16 quoted lines; a 20-line cap can hide the rest of a larger one.
    const many = Array.from({ length: 25 }, (_, i) =>
      added(`f${i}.ts`, `// (the architect: "line ${i}")`),
    ).join("");
    const out = (env: NodeJS.ProcessEnv = {}) =>
      spawnSync("bash", [SCRIPT], {
        input: many,
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
    const capped = out();
    expect(capped.status).toBe(1);
    expect(capped.stderr).toContain("5 more (25 in all)");
    expect(capped.stderr.split("\n").filter((l) => l.startsWith("f")).length).toBe(20);
    const all = out({ OWNER_QUOTE_ALL: "1" });
    expect(all.status).toBe(1);
    expect(all.stderr.split("\n").filter((l) => l.startsWith("f")).length).toBe(25);
  });

  it("ignores the rule's own documentation and honours the bypass", () => {
    expect(run(added("CLAUDE.md", '// FORK <date> (the architect: "example")'))).toBe(0);
    expect(run(added("a.ts", '// (the architect: "x")'), { OWNER_QUOTE_GUARD: "off" })).toBe(0);
  });
});
