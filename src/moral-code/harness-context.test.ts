/**
 * FORK 2026-10-09 — the tinkerclaw-core harness context. One assistant runs in two harnesses on one
 * machine: plain Claude Code, and the TinkerClaw chat worker the gateway spawns for each chat
 * (TC_SESSION_KEY set). The SessionStart hook tells each side which one it is and what it shares
 * with the other, and hands the workspace persona files to the plain-Claude-Code side only: a worker
 * already has them in its system prompt.
 *
 * Black-box, like delivery-parts.test.ts: each command hooks.json registers runs as the CLI runs it
 * (CLAUDE_PLUGIN_ROOT set, the hook input on stdin) against a temporary state dir.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PLUGIN_ROOT = path.resolve(__dirname, "../../claude-plugins/tinkerclaw-core");
/** The hook keeps every part, wrapper included, at or under this (the CLI's cap is 10,000). */
const PART_MAX_CHARS = 9_500;
/** Harness-context slots hooks.json registers. */
const SLOTS = 12;
const FILE_NAMES = ["SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "AGENTS.md"];
const WORKER = { TC_SESSION_KEY: "fixture-session-key" };

type HookEntry = {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
};
type HookConfig = { hooks: Record<string, HookEntry[]> };

function hookConfig(): HookConfig {
  return JSON.parse(
    fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"),
  ) as HookConfig;
}

function sessionStartCommands(): string[] {
  return hookConfig().hooks.SessionStart.flatMap((e) => e.hooks.map((h) => h.command));
}

function harnessCommands(): string[] {
  return sessionStartCommands().filter((c) => c.includes("/scripts/harness-context.mjs"));
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

/** Workspace files shaped like real ones: a title, a marker line, `##` sections; AGENTS.md is ~30k. */
function writeWorkspace(dir: string): Record<string, string> {
  fs.mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {};
  for (const name of FILE_NAMES) {
    let text = `# ${name} fixture\n\nMarker line for ${name}.\n`;
    const sections = name === "AGENTS.md" ? 12 : 2;
    for (let s = 1; s <= sections; s++) {
      text += `\n## Section ${s}\n\n${"Guidance the assistant reads when a session starts. ".repeat(45)}\n`;
    }
    fs.writeFileSync(path.join(dir, name), text);
    files[name] = text;
  }
  return files;
}

type Fixture = { state: string; workspace: string; files: Record<string, string> };

/** A state dir with a default workspace, plus harness-identity.json when `identity` is given. */
function fixture(identity?: unknown): Fixture {
  const state = tempDir("harness-ctx-state-");
  const workspace = path.join(state, "workspace");
  const files = writeWorkspace(workspace);
  if (identity !== undefined) {
    writeJson(path.join(state, "harness-identity.json"), identity);
  }
  return { state, workspace, files };
}

let uniq = 0;
const sid = () => `harness-${process.pid}-${Date.now()}-${uniq++}`;

/** Run `commands` as the CLI does; each one's additionalContext, or undefined when it printed nothing. */
function run(
  commands: string[],
  state: string,
  extraEnv: Record<string, string> = {},
  sessionId = sid(),
): Array<string | undefined> {
  // The side switch and the profile must not leak in from the shell that runs the tests.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "TC_SESSION_KEY" && k !== "OPENCLAW_PROFILE"),
  );
  const env = {
    ...inherited,
    OPENCLAW_STATE_DIR: state,
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    ...extraEnv,
  };
  return commands.map((command) => {
    const cmd = command.replace("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT);
    const out = execFileSync("/bin/sh", ["-c", cmd], {
      input: JSON.stringify({
        session_id: sessionId,
        source: "startup",
        hook_event_name: "SessionStart",
      }),
      env,
      encoding: "utf8",
    });
    if (!out.trim()) {
      return undefined;
    }
    const parsed = JSON.parse(out) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    return parsed.hookSpecificOutput.additionalContext;
  });
}

function runHarness(
  state: string,
  extraEnv: Record<string, string> = {},
): Array<string | undefined> {
  return run(harnessCommands(), state, extraEnv);
}

const PART =
  /^<harness_context source="tinkerclaw-core">\n\[harness context, part (\d+) of (\d+)\]\n([\s\S]*)<\/harness_context>$/;

/** The label and body of one delivered part. */
function bodyOf(part: string): { i: number; n: number; body: string } {
  const m = PART.exec(part);
  expect(m, `not a complete labelled part: ${part.slice(0, 120)}`).not.toBeNull();
  return { i: Number(m![1]), n: Number(m![2]), body: m![3] };
}

/** The delivered parts, in part order. */
function partsOf(outs: Array<string | undefined>): Array<{ i: number; n: number; body: string }> {
  return outs
    .filter((x): x is string => x !== undefined)
    .map(bodyOf)
    .sort((a, b) => a.i - b.i);
}

/** Part 1's body: the card. */
function cardOf(outs: Array<string | undefined>): string {
  const parts = partsOf(outs);
  expect(parts[0]?.i).toBe(1);
  return parts[0].body;
}

describe("tinkerclaw-core harness context: each side is told which harness it is in", () => {
  it("registers 12 slots on the moral code's matcher and leaves the moral code's 10 as they were", () => {
    const entries = hookConfig().hooks.SessionStart;
    expect(entries).toHaveLength(1);
    expect(entries[0].matcher).toBe("startup|clear|compact");
    const slot = (script: string, i: number) =>
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/' + script + '" --part ' + String(i + 1);
    const moral = sessionStartCommands().filter((c) =>
      c.includes("/scripts/moral-code-session-start.mjs"),
    );
    expect(moral).toEqual(
      Array.from({ length: 10 }, (_, i) => slot("moral-code-session-start.mjs", i)),
    );
    expect(harnessCommands()).toEqual(
      Array.from({ length: SLOTS }, (_, i) => slot("harness-context.mjs", i)),
    );
  });

  it("plain Claude Code: the card, then every workspace file, in parts under the cap; later slots say nothing", () => {
    const fx = fixture();
    const outs = runHarness(fx.state);
    const parts = partsOf(outs);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.length).toBeLessThanOrEqual(SLOTS);
    // Slot k prints part k of n; every slot past n prints nothing.
    expect(outs.map((o) => (o === undefined ? undefined : bodyOf(o).i))).toEqual(
      Array.from({ length: SLOTS }, (_, k) => (k < parts.length ? k + 1 : undefined)),
    );
    for (const p of parts) {
      expect(p.n).toBe(parts.length);
    }
    for (const o of outs) {
      expect((o ?? "").length).toBeLessThanOrEqual(PART_MAX_CHARS);
    }
    const card = parts[0].body;
    expect(card).toContain("You are running in plain Claude Code, outside the TinkerClaw gateway");
    expect(card).toContain(`- State dir: ${fx.state}`);
    expect(card).toContain(`- Workspace: ${fx.workspace}`);
    expect(card).toContain("`sessions_list` and `sessions_history`");
    expect(card).not.toContain("engram.search");
    const all = parts.map((p) => p.body).join("");
    for (const [name, text] of Object.entries(fx.files)) {
      expect(all).toContain(`## Workspace file: ${name} (${path.join(fx.workspace, name)})`);
      expect(all).toContain(text.trim());
    }
  });

  it("a chat worker (TC_SESSION_KEY set) gets the card alone: the workspace files never twice", () => {
    const fx = fixture();
    const outs = runHarness(fx.state, WORKER);
    expect(outs[0]).toBeDefined();
    expect(outs.slice(1).every((o) => o === undefined)).toBe(true);
    const p = bodyOf(outs[0]!);
    expect([p.i, p.n]).toEqual([1, 1]);
    expect(p.body).toContain("You are running as a TinkerClaw chat worker");
    expect(p.body).toContain("Workflow tool");
    expect(p.body).toContain(`- Workspace: ${fx.workspace}`);
    expect(p.body).not.toContain("## Workspace file:");
    for (const name of FILE_NAMES) {
      expect(p.body).not.toContain(`Marker line for ${name}`);
    }
  });

  it("names come from harness-identity.json and nowhere else", () => {
    const named = fixture({
      claudeCode: { name: "Fixture Terminal" },
      worker: { name: "Fixture Chat" },
    });
    const cc = cardOf(runHarness(named.state));
    expect(cc).toContain("You are Fixture Terminal, running in plain Claude Code");
    expect(cc).toContain("there it goes by Fixture Chat");
    const worker = cardOf(runHarness(named.state, WORKER));
    expect(worker).toContain("You are Fixture Chat, running as a TinkerClaw chat worker");
    expect(worker).toContain("there it goes by Fixture Terminal");
    for (const bare of [fixture(), fixture("not an object")]) {
      for (const card of [cardOf(runHarness(bare.state)), cardOf(runHarness(bare.state, WORKER))]) {
        expect(card).not.toContain("Fixture Terminal");
        expect(card).not.toContain("Fixture Chat");
        expect(card).not.toContain("there it goes by");
      }
    }
  });

  it("bootstrapFiles in harness-identity.json picks the files, and a missing one is skipped", () => {
    const fx = fixture({ bootstrapFiles: ["USER.md", "MISSING.md"] });
    const all = partsOf(runHarness(fx.state))
      .map((p) => p.body)
      .join("");
    expect(all).toContain(`## Workspace file: USER.md (${path.join(fx.workspace, "USER.md")})`);
    expect(all).toContain("Marker line for USER.md");
    expect(all).not.toContain("Marker line for AGENTS.md");
    expect(all).not.toContain("MISSING.md");
  });

  it("finds the workspace as the gateway does: openclaw.json, else workspace-<profile>, else workspace", () => {
    // A profile other than "default" reads <state>/workspace-<profile>.
    const profiled = tempDir("harness-ctx-state-");
    const lab = path.join(profiled, "workspace-lab");
    writeWorkspace(lab);
    expect(cardOf(runHarness(profiled, { OPENCLAW_PROFILE: "lab" }))).toContain(
      `- Workspace: ${lab}`,
    );
    // Without the profile, <state>/workspace is missing here: nothing to say.
    expect(runHarness(profiled).every((o) => o === undefined)).toBe(true);
    // "default" is the plain workspace.
    const plain = fixture();
    expect(cardOf(runHarness(plain.state, { OPENCLAW_PROFILE: "default" }))).toContain(
      `- Workspace: ${plain.workspace}`,
    );
    // agents.defaults.workspace in openclaw.json wins over both.
    const configured = tempDir("harness-ctx-state-");
    const elsewhere = tempDir("harness-ctx-workspace-");
    writeWorkspace(elsewhere);
    writeJson(path.join(configured, "openclaw.json"), {
      agents: { defaults: { workspace: elsewhere } },
    });
    const parts = partsOf(runHarness(configured, { OPENCLAW_PROFILE: "lab" }));
    expect(parts[0].body).toContain(`- Workspace: ${elsewhere}`);
    expect(parts.map((p) => p.body).join("")).toContain(
      `## Workspace file: SOUL.md (${path.join(elsewhere, "SOUL.md")})`,
    );
  });

  it("says nothing on either side when there is no workspace to share", () => {
    const state = tempDir("harness-ctx-state-");
    expect(runHarness(state).every((o) => o === undefined)).toBe(true);
    expect(runHarness(state, WORKER).every((o) => o === undefined)).toBe(true);
  });

  it("shares a session with the moral code without taking its lock", () => {
    const fx = fixture();
    const pack = path.join(fx.state, "moral-code", "moral-code.md");
    fs.mkdirSync(path.dirname(pack), { recursive: true });
    fs.writeFileSync(
      pack,
      '<moral_code source="tinkerclaw">\n\nA small fixture pack.\n</moral_code>',
    );
    const outs = run(sessionStartCommands(), fx.state).filter((x): x is string => x !== undefined);
    expect(outs.some((o) => o.startsWith('<moral_code source="tinkerclaw">'))).toBe(true);
    expect(outs.some((o) => o.startsWith('<harness_context source="tinkerclaw-core">'))).toBe(true);
  });
});
