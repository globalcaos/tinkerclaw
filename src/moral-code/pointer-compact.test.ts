import { execFileSync } from "node:child_process";
/**
 * FORK 2026-11-03 — pointer compaction for the claude CLI's own compaction (J1 §5). On the
 * claude-code lane only the CLI's compaction shrinks what the model reads; the tinkerclaw-core
 * PreCompact hook appends J1 marker instructions to it, and the SessionStart hook (source "compact")
 * names the transcript file that still holds every compacted entry.
 *
 * Black-box, like delivery-parts.test.ts: the command hooks.json registers runs as the CLI runs it
 * (CLAUDE_PLUGIN_ROOT set, the hook input on stdin). A non-zero exit fails execFileSync, so every
 * case also proves the hook exits 0 (exit 2 would block the compaction).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PLUGIN_ROOT = path.resolve(__dirname, "../../claude-plugins/tinkerclaw-core");
const SCRIPT = "/scripts/pointer-compact.mjs";

type HookEntry = { matcher?: string; hooks: Array<{ command: string; timeout?: number }> };
type HookConfig = { hooks: Record<string, HookEntry[]> };

function hookConfig(): HookConfig {
  return JSON.parse(
    fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"),
  ) as HookConfig;
}

function commandsIn(event: string): string[] {
  return (hookConfig().hooks[event] ?? []).flatMap((e) =>
    e.hooks.map((h) => h.command).filter((c) => c.includes(SCRIPT)),
  );
}

/** Run the registered command with `input` on stdin; "worker" sets TC_SESSION_KEY, "claude-code" clears it. */
function run(input: unknown, side: "worker" | "claude-code" = "claude-code"): string {
  const [command] = commandsIn("PreCompact");
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT };
  delete env.TC_SESSION_KEY;
  if (side === "worker") {
    env.TC_SESSION_KEY = "fixture-session-key";
  }
  return execFileSync("/bin/sh", ["-c", command.replace("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT)], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env,
    encoding: "utf8",
  });
}

function transcriptFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pointer-compact-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, '{"type":"user"}\n{"type":"system","subtype":"compact_boundary"}\n');
  return file;
}

describe("pointer compaction hook: registration", () => {
  it("runs on every PreCompact and inside the one SessionStart entry", () => {
    const pre = hookConfig().hooks.PreCompact;
    expect(pre).toHaveLength(1);
    expect(pre[0].matcher).toBeUndefined();
    expect(commandsIn("PreCompact")).toHaveLength(1);
    expect(hookConfig().hooks.SessionStart).toHaveLength(1);
    expect(commandsIn("SessionStart")).toEqual(commandsIn("PreCompact"));
  });
});

describe("pointer compaction hook: PreCompact", () => {
  it.each(["manual", "auto"])(
    "appends the J1 marker instructions on a %s compaction",
    (trigger) => {
      const out = run({ hook_event_name: "PreCompact", trigger, session_id: randomUUID() });
      expect(out).toContain("pointer marker, not a narrative");
      expect(out).toContain("quoted verbatim");
      expect(out).toContain("Exact strings");
      expect(out).toContain("Open items");
      // Plain text: the CLI appends stdout as instructions, it does not parse it.
      expect(() => JSON.parse(out)).toThrow();
    },
  );

  it("speaks once when the plugin is loaded twice in one session", () => {
    const input = { hook_event_name: "PreCompact", trigger: "auto", session_id: randomUUID() };
    expect(run(input)).not.toBe("");
    expect(run(input)).toBe("");
  });
});

describe("pointer compaction hook: SessionStart after a compaction", () => {
  it("names the transcript that still holds the compacted entries", () => {
    const transcript = transcriptFixture();
    const out = run({
      hook_event_name: "SessionStart",
      source: "compact",
      session_id: randomUUID(),
      transcript_path: transcript,
    });
    const parsed = JSON.parse(out) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(
      /^<compaction_pointer source="tinkerclaw-core">\n[\s\S]*<\/compaction_pointer>$/,
    );
    expect(ctx).toContain(`\n${transcript}\n`);
    expect(ctx).toContain('"compact_boundary"');
    expect(ctx).not.toContain("recall tool");
  });

  it("tells a TinkerClaw worker that recall reaches the same conversation", () => {
    const out = run(
      {
        hook_event_name: "SessionStart",
        source: "compact",
        session_id: randomUUID(),
        transcript_path: transcriptFixture(),
      },
      "worker",
    );
    expect(out).toContain("recall tool");
  });

  it("stays silent with no record on disk, and on any other session start", () => {
    const base = { hook_event_name: "SessionStart", session_id: randomUUID() };
    expect(run({ ...base, source: "compact" })).toBe("");
    expect(run({ ...base, source: "compact", transcript_path: "/nonexistent/session.jsonl" })).toBe(
      "",
    );
    for (const source of ["startup", "clear", "resume"]) {
      expect(run({ ...base, source, transcript_path: transcriptFixture() })).toBe("");
    }
  });
});

describe("pointer compaction hook: fails open", () => {
  it("prints nothing and exits 0 on input it cannot read", () => {
    expect(run("not json")).toBe("");
    expect(run("")).toBe("");
    expect(run({ hook_event_name: "Stop" })).toBe("");
  });
});
