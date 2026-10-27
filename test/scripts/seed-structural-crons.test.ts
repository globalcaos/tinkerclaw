import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..", "..");

/**
 * The seeder in a throwaway repo root whose `openclaw.mjs` is a stub: `cron list` answers with the
 * ids in EXISTING, and `cron add` appends its argv to a log. Nothing reaches a real gateway.
 */
function makeRoot(existing: string[]): { root: string; log: string } {
  const root = mkdtempSync(path.join(tmpdir(), "seed-crons-"));
  mkdirSync(path.join(root, "scripts"));
  cpSync(
    path.join(REPO, "scripts", "seed-structural-crons.mjs"),
    path.join(root, "scripts", "seed-structural-crons.mjs"),
  );
  cpSync(
    path.join(REPO, "extensions", "tinkerclaw-tinker-bridge", "crons"),
    path.join(root, "extensions", "tinkerclaw-tinker-bridge", "crons"),
    { recursive: true },
  );
  const log = path.join(root, "adds.jsonl");
  writeFileSync(
    path.join(root, "openclaw.mjs"),
    [
      'import fs from "node:fs";',
      "const args = process.argv.slice(2);",
      'if (args[0] === "cron" && args[1] === "list") {',
      `  console.log(JSON.stringify({ jobs: ${JSON.stringify(existing)}.map((id) => ({ id, name: id })) }));`,
      '} else if (args[0] === "cron" && args[1] === "add") {',
      `  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");`,
      "} else { process.exit(3); }",
      "",
    ].join("\n"),
  );
  return { root, log };
}

function seed(root: string, ...args: string[]): string {
  return execFileSync("node", [path.join(root, "scripts", "seed-structural-crons.mjs"), ...args], {
    encoding: "utf8",
  });
}

describe("seed-structural-crons", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("installs wind-down on its schedule with a message that names the bundled routine", () => {
    const made = makeRoot([]);
    root = made.root;
    const out = JSON.parse(seed(root, "--json")) as { added: string[]; failed: unknown[] };
    expect(out.failed).toEqual([]);
    expect(out.added).toContain("wind-down");
    expect(out.added).toContain("memory-consolidation");
    const adds = readFileSync(made.log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
    const wind = adds.find((a) => a.includes("Wind Down (Daily Reflection)"));
    expect(wind).toBeDefined();
    const arg = (flag: string) => wind![wind!.indexOf(flag) + 1];
    expect(arg("--cron")).toBe("0 3 * * *");
    expect(arg("--thinking")).toBe("high");
    expect(arg("--message")).toContain(
      path.join(root, "extensions", "tinkerclaw-tinker-bridge", "crons", "wind-down", "routine.md"),
    );
    expect(wind).not.toContain("--tz");
  });

  it("adds nothing for a job that is already installed under the same id", () => {
    const made = makeRoot(["wind-down", "memory-consolidation"]);
    root = made.root;
    const list = JSON.parse(seed(root, "--list", "--json")) as {
      jobs: { id: string; installed: boolean }[];
    };
    expect(list.jobs.find((j) => j.id === "wind-down")?.installed).toBe(true);
    const out = JSON.parse(seed(root, "--json")) as { added: string[] };
    expect(out.added).not.toContain("wind-down");
    expect(out.added).not.toContain("memory-consolidation");
  });
});
