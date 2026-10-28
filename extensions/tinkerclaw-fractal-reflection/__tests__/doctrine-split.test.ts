// FORK 2026-10-09 (Fractal v2, P1) — the doctrine is a short CORE plus four chapters sent by trigger,
// generated into tinker-ui/src/fractal-doctrine.generated.ts. These tests pin the split (core size,
// the rules the core must carry, nothing of v4 lost) and the generator/check pair, so the live copy
// can never drift from the .md files again (the 2026-08-22 decoy: edits to a file nothing loaded).
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHAPTER_NAMES,
  GENERATED_REL,
  doctrineFromMarkdown,
  readDoctrineSources,
  renderDoctrineModule,
} from "../../../scripts/check-fractal-prompt-sync.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const EXT_DIR = join(ROOT, "extensions/tinkerclaw-fractal-reflection");
const CHECK = join(ROOT, "scripts/check-fractal-prompt-sync.mjs");
const SYNC = join(ROOT, "scripts/sync-fractal-prompt.mjs");

const core = doctrineFromMarkdown(readFileSync(join(EXT_DIR, "fractal-prompt.md"), "utf8"));
const chapterText = (name: string) => readFileSync(join(EXT_DIR, "chapters", `${name}.md`), "utf8");
// Prose wraps at ~100 columns, so phrase checks read whitespace-collapsed text.
const flat = (s: string) => s.replace(/\s+/g, " ");
const coreFlat = flat(core);

describe("fractal doctrine split (core + chapters)", () => {
  it("names the four triggers of contract C1, in trigger order", () => {
    expect(CHAPTER_NAMES).toEqual(["correction", "friction", "delivery", "channel"]);
  });

  // Cap raised 8,000 → 9,500 on 2026-10-27: the architect's own 2ef243ae111 (10-26) put
  // "Make the next run cheaper" in the core (8,835 chars). It must stay there: a
  // clean but costly turn gets no chapter. The cap still guards the v4 regression.
  it("keeps the core between 6,000 and 9,500 chars (v4 sent 49.5k on every call)", () => {
    expect(core.length).toBeGreaterThanOrEqual(6000);
    expect(core.length).toBeLessThanOrEqual(9500);
  });

  it("has one chapter file per trigger, each headed by its name", () => {
    for (const name of CHAPTER_NAMES) {
      const p = join(EXT_DIR, "chapters", `${name}.md`);
      expect(existsSync(p), p).toBe(true);
      expect(chapterText(name).startsWith(`## Chapter: ${name}`)).toBe(true);
    }
  });

  it("carries the background mechanics and the Triggers line in the core", () => {
    expect(coreFlat).toContain("background");
    expect(coreFlat).toContain("agent:<id>:fractal:<P>");
    expect(coreFlat).toContain("forked copy");
    expect(coreFlat).toContain("not waiting");
    expect(coreFlat).toContain("`Triggers:`");
    expect(coreFlat).toContain("fractal-parent-trail.py");
  });

  it("puts the decision first and the action ladder in the agreed order", () => {
    const decide = coreFlat.indexOf("## Decide first");
    const ladder = coreFlat.indexOf("## The action ladder");
    expect(decide).toBeGreaterThan(-1);
    expect(ladder).toBeGreaterThan(decide);
    const rungs = [
      "**Fix the code or the check**",
      "**Change the recipe or skill step**",
      "**Correct a wrong record**",
      "**Only then a new memory note**",
    ].map((r) => coreFlat.indexOf(r));
    expect(rungs.every((i) => i > ladder)).toBe(true);
    expect([...rungs].toSorted((a, b) => a - b)).toEqual(rungs);
    expect(coreFlat).toContain("Failures Overcome");
    expect(coreFlat).toContain("Never for a one-off fact");
  });

  it("carries coordination, the quiet-house gate, the output contract and doctrine self-edits", () => {
    expect(coreFlat).toContain("git log -5 develop -- <files>");
    expect(coreFlat).toContain("python3 -I ~/.openclaw/workspace/scripts/fractal-claim.py <slug>");
    expect(coreFlat).toContain("exit 5");
    expect(coreFlat).toContain("the next rebuild carries it");
    expect(coreFlat).toContain("🌿 FRACTAL ACTION:");
    expect(coreFlat).toContain("🌿 FRACTAL:");
    expect(coreFlat).toMatch(/✓ or ✗/);
    expect(coreFlat).toContain("`fractal(doctrine): …`");
    expect(coreFlat).toContain("weekly report");
  });

  // Coverage guard: one sentinel per v4 rule or worked instance. Each must survive somewhere in the
  // core or a chapter; a trim that drops one fails here instead of silently.
  it("loses nothing of v4: every rule's sentinel is in the core or a chapter", () => {
    const all = flat([core, ...CHAPTER_NAMES.map(chapterText)].join("\n"));
    const sentinels = [
      // ch.0
      "8 MB",
      "re-read a file before you edit it",
      "observe → evaluate → adapt",
      "LAST text block",
      // ch.2
      "Done when",
      "missing Napkin",
      "not the real signature",
      "Gantt tab",
      "another read path",
      "another read path",
      "BIOS button",
      "left out two machines",
      "fresh clone",
      "Broca",
      "A moved trigger",
      "fractal-census",
      "longjob",
      "ls -li",
      "orbis-coding",
      "[embed ref=...]",
      // ch.3
      "next time: N calls → 1",
      "tool execution failed",
      "struggled to reach a web app",
      "finding the right query",
      "keep going",
      "gw.boot",
      "claude-usage.py",
      "safety net",
      // ch.4
      "Name the wrong decision",
      "Replay the changed step",
      "layout_report.py",
      // ch.5
      "SERVED output",
      "Sound is not green",
      "written, not running",
      "named the expand step",
      "a population check that fails closed",
      "SMART MODELS",
      // ch.6
      "reproduce it",
      "Too big for one turn",
      "cannot merge is not a fix",
      "Reversibility gates",
      "propose the exact",
      "Securitas",
      "222fa1a6e83",
      // ch.7
      "Define the class",
      "Enumerate it",
      "29 entries",
      // ch.8
      "Fix the column, not the cell",
      "one sharp question",
      "at the layer it actually breaks",
      "MAC",
      "the letter wins",
      // ch.9
      "stored negative",
      "Grok",
      "world moved",
      // ch.10
      "Reload the tab",
      "try again",
      "Disk",
      "TAIL_READ_LIMIT",
      "WINDOW_PAGE",
      'id="messages"',
      "caa186c1ca5",
      "__ERR_ENV__",
      "renderEnvelope",
      "Fused thinking bubbles",
      // ch.11
      "RECIPE",
      "youtube skill",
      "sharepoint-download",
      "RIPPLE",
      "PREEMPT",
      "MEMORY",
      // ch.12
      "jobs-state.json",
      "FallbackSummaryError",
      "find its WRITER",
      "grok-oauth.mjs",
      "never have to tell you something is broken",
      // ch.13
      "(main turn)",
      "fabrication",
      "`stat`",
      "lie, not a lag",
      // ch.14
      "No liturgy",
      "~6 more lines",
      // ch.15
      "could the reflection on the turn he is correcting have caught this",
      "loosening",
    ];
    const missing = sentinels.filter((s) => !all.includes(s));
    expect(missing).toEqual([]);
  });
});

describe("generated module and the sync/check scripts", () => {
  const tmpRoots: string[] = [];
  afterEach(() => {
    for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("the committed generated module equals what the generator renders from the .md files", () => {
    const onDisk = readFileSync(join(ROOT, GENERATED_REL), "utf8");
    expect(onDisk).toBe(renderDoctrineModule(readDoctrineSources(ROOT)));
  });

  it("exports FRACTAL_DOCTRINE_CORE and FRACTAL_CHAPTERS with the .md bodies (contract C4)", () => {
    const src = readFileSync(join(ROOT, GENERATED_REL), "utf8");
    // Evaluate the module's literals as JS: the VALUE must be the .md text, byte for byte. (The old
    // String.raw literal in app.ts kept its escaping backslash, so the model read \` for `.)
    const body = src.replace(/^export const (\w+): [^=]+=/gm, "out.$1 =").replace(/^\/\/.*$/gm, "");
    const out: Record<string, unknown> = {};
    new Function("out", body)(out);
    expect(out.FRACTAL_DOCTRINE_CORE).toBe(core);
    expect(src).toContain(
      'export const FRACTAL_CHAPTERS: Record<"correction" | "friction" | "delivery" | "channel", string> =',
    );
    const chapters = out.FRACTAL_CHAPTERS as Record<string, string>;
    expect(Object.keys(chapters)).toEqual(CHAPTER_NAMES);
    for (const name of CHAPTER_NAMES) expect(chapters[name]).toBe(chapterText(name).trim());
    expect(String(out.FRACTAL_DOCTRINE_CORE)).not.toContain("\\`");
  });

  function fixtureRoot(): string {
    const d = mkdtempSync(join(tmpdir(), "fractal-doctrine-"));
    tmpRoots.push(d);
    const ext = join(d, "extensions/tinkerclaw-fractal-reflection");
    mkdirSync(join(ext, "chapters"), { recursive: true });
    mkdirSync(join(d, "tinker-ui/src"), { recursive: true });
    cpSync(join(EXT_DIR, "fractal-prompt.md"), join(ext, "fractal-prompt.md"));
    for (const name of CHAPTER_NAMES) {
      cpSync(join(EXT_DIR, "chapters", `${name}.md`), join(ext, "chapters", `${name}.md`));
    }
    writeFileSync(
      join(d, "tinker-ui/src/app.ts"),
      'import { FRACTAL_DOCTRINE_CORE } from "./fractal-doctrine.generated.js";\n' +
        "const FRACTAL_PROMPT_PATH =\n" +
        '  "~/src/tinkerclaw/extensions/tinkerclaw-fractal-reflection/fractal-prompt.md";\n',
    );
    return d;
  }
  const run = (script: string, root: string) =>
    spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });

  it("sync writes the generated module and leaves app.ts alone; check then passes", () => {
    const d = fixtureRoot();
    const appBefore = readFileSync(join(d, "tinker-ui/src/app.ts"), "utf8");
    expect(run(CHECK, d).status).toBe(1); // no generated file yet
    const s = run(SYNC, d);
    expect(s.status, s.stderr).toBe(0);
    expect(readFileSync(join(d, "tinker-ui/src/app.ts"), "utf8")).toBe(appBefore);
    expect(readFileSync(join(d, GENERATED_REL), "utf8")).toBe(
      readFileSync(join(ROOT, GENERATED_REL), "utf8"),
    );
    const c = run(CHECK, d);
    expect(c.status, c.stderr).toBe(0);
    expect(c.stdout).toContain("OK");
  });

  it("check fails when a chapter drifts from the generated module", () => {
    const d = fixtureRoot();
    run(SYNC, d);
    const p = join(d, "extensions/tinkerclaw-fractal-reflection/chapters/friction.md");
    writeFileSync(p, readFileSync(p, "utf8") + "\n- [ ] a new rule nobody synced\n");
    const c = run(CHECK, d);
    expect(c.status).toBe(1);
    expect(c.stderr).toContain("friction");
  });

  it("check fails when app.ts still embeds its own doctrine copy (the decoy)", () => {
    const d = fixtureRoot();
    run(SYNC, d);
    const app = join(d, "tinker-ui/src/app.ts");
    writeFileSync(app, readFileSync(app, "utf8") + "const FRACTAL_DOCTRINE = String.raw`old`;\n");
    const c = run(CHECK, d);
    expect(c.status).toBe(1);
    expect(c.stderr).toContain("embeds");
  });

  it("check fails when FRACTAL_PROMPT_PATH points at another file", () => {
    const d = fixtureRoot();
    run(SYNC, d);
    writeFileSync(
      join(d, "tinker-ui/src/app.ts"),
      'const FRACTAL_PROMPT_PATH = "~/elsewhere.md";\n',
    );
    const c = run(CHECK, d);
    expect(c.status).toBe(1);
    expect(c.stderr).toContain("FRACTAL_PROMPT_PATH");
  });
});
