/**
 * FORK 2026-10-09 — the tinkerclaw-core recipe hint. On plain Claude Code a UserPromptSubmit hook names
 * up to three saved recipes whose words overlap the prompt, from the catalog the gateway's prefrontal
 * plugin publishes at <state dir>/prefrontal/recipe-index.json. A chat worker (TC_SESSION_KEY set) gets
 * nothing from it: the gateway already matched recipes for that turn.
 *
 * Black-box: the command hooks.json registers runs as the CLI runs it, the prompt on stdin.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PLUGIN_ROOT = path.resolve(__dirname, "../../claude-plugins/tinkerclaw-core");
const WORKER = { TC_SESSION_KEY: "fixture-session-key" };
const OPEN =
  '<recipe_hint source="tinkerclaw-core">Saved recipes that may fit (keyword match, not a decision):\n';
const CLOSE =
  "\nIf one fits, follow it with the jarvis-recipe skill; if none fits, ignore this.</recipe_hint>";

type HookEntry = {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
};
type HookConfig = { hooks: Record<string, HookEntry[]> };

function promptHooks(): HookEntry[] {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"),
  ) as HookConfig;
  return cfg.hooks.UserPromptSubmit ?? [];
}

const RECIPES = [
  {
    slug: "clean-public-push",
    owner: "fixture",
    title: "Publish develop to the public remote",
    summary: "Scrub private data, then push the branch to the public mirror.",
    tags: ["publish", "public push", "git"],
    path: "recipes/clean-public-push.md",
  },
  {
    slug: "camera-calibration",
    owner: "fixture",
    title: "Calibrate a camera",
    summary: "Run the checkerboard routine and store the intrinsics.",
    tags: ["camera", "calibration"],
    path: "recipes/camera-calibration.md",
  },
  {
    slug: "weekly-report",
    owner: "fixture",
    title: "Write the weekly report",
    summary: "Collect merged work and draft the summary email.",
    tags: ["report", "email"],
    path: "recipes/weekly-report.md",
  },
];

const catalog = (recipes: unknown[]) => ({
  version: 1,
  generatedAt: "2026-10-09T00:00:00.000Z",
  recipes,
});

/** A state dir holding `index` (JSON) or `raw` (text) as the catalog, and `identity` as harness-identity.json. */
function stateWith(opts: { index?: unknown; raw?: string; identity?: unknown } = {}): string {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-hint-state-"));
  if (opts.index !== undefined || opts.raw !== undefined) {
    const file = path.join(state, "prefrontal", "recipe-index.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, opts.raw ?? JSON.stringify(opts.index));
  }
  if (opts.identity !== undefined) {
    fs.writeFileSync(path.join(state, "harness-identity.json"), JSON.stringify(opts.identity));
  }
  return state;
}

let uniq = 0;
const sid = () => `hint-${process.pid}-${Date.now()}-${uniq++}`;

/** Run the hook as the CLI does; its additionalContext, or undefined when it printed nothing. */
function runHint(
  state: string,
  prompt: string,
  extraEnv: Record<string, string> = {},
): string | undefined {
  // The side switch must not leak in from the shell that runs the tests.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "TC_SESSION_KEY"),
  );
  const cmd = promptHooks()[0].hooks[0].command.replace("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT);
  const out = execFileSync("/bin/sh", ["-c", cmd], {
    input: JSON.stringify({ session_id: sid(), prompt, hook_event_name: "UserPromptSubmit" }),
    env: { ...inherited, OPENCLAW_STATE_DIR: state, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...extraEnv },
    encoding: "utf8",
  });
  if (!out.trim()) {
    return undefined;
  }
  const parsed = JSON.parse(out) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  return parsed.hookSpecificOutput.additionalContext;
}

/** The bullet lines of a hint, after checking its fixed opening and closing. */
function bullets(hint: string): string[] {
  expect(hint.startsWith(OPEN)).toBe(true);
  expect(hint.endsWith(CLOSE)).toBe(true);
  return hint.slice(OPEN.length, hint.length - CLOSE.length).split("\n");
}

const PUBLISH = "Please handle publishing this branch to the public remote";

describe("tinkerclaw-core recipe hint: saved recipes named per prompt in plain Claude Code", () => {
  it("runs from one UserPromptSubmit command with a 5 s budget", () => {
    const entries = promptHooks();
    expect(entries).toHaveLength(1);
    expect(entries[0].hooks).toEqual([
      {
        type: "command",
        command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/recipe-hint.mjs"',
        timeout: 5,
      },
    ]);
  });

  it("names the recipe tagged publish / public push for a prompt about publishing a branch to a public remote", () => {
    const hint = runHint(stateWith({ index: catalog(RECIPES) }), PUBLISH);
    expect(hint).toBeDefined();
    expect(bullets(hint!)).toEqual([
      "- `clean-public-push`: Publish develop to the public remote (recipes/clean-public-push.md)",
    ]);
  });

  it("says nothing for small talk, a slash command, or a prompt no recipe matches", () => {
    const state = stateWith({ index: catalog(RECIPES) });
    expect(runHint(state, "hello there")).toBeUndefined();
    expect(runHint(state, "/publish the public branch to the remote")).toBeUndefined();
    expect(runHint(state, "what is the weather like today")).toBeUndefined();
  });

  it("says nothing on a chat worker: the gateway already matched", () => {
    expect(runHint(stateWith({ index: catalog(RECIPES) }), PUBLISH, WORKER)).toBeUndefined();
  });

  it("says nothing with no catalog, a broken one, or recipe hints turned off", () => {
    expect(runHint(stateWith(), PUBLISH)).toBeUndefined();
    expect(runHint(stateWith({ raw: "{ not json" }), PUBLISH)).toBeUndefined();
    expect(runHint(stateWith({ index: { version: 1, recipes: "none" } }), PUBLISH)).toBeUndefined();
    expect(
      runHint(stateWith({ index: catalog(RECIPES), identity: { recipeHints: false } }), PUBLISH),
    ).toBeUndefined();
  });

  it("names three recipes at most, the best first", () => {
    const variants = [1, 2, 3, 4, 5].map((k) => ({
      slug: `publish-variant-${k}`,
      owner: "fixture",
      title: `Publish variant ${k}`,
      summary: "A near copy.",
      tags: ["publish", "public"],
      path: `recipes/publish-variant-${k}.md`,
    }));
    const hint = runHint(stateWith({ index: catalog([...variants, ...RECIPES]) }), PUBLISH);
    expect(hint).toBeDefined();
    const lines = bullets(hint!);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("`clean-public-push`");
  });
});
