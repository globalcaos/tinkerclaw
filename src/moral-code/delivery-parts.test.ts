/**
 * FORK 2026-10-02 (the owner: "Fix the moral code to be injected, in full, at the creation and after
 * compaction"). The claude CLI replaces any hook additionalContext over 10,000 chars with a ~2,000-char
 * preview plus a file path (CLI 2.1.287: `L3o=1e4`, applied to EACH hook's additionalContext). The
 * 40k pack therefore reached the model as a preview. The tinkerclaw-core SessionStart hook now
 * delivers it as N complete parts, one hook slot each, every part under the cap.
 *
 * Black-box: the hook is run exactly as the CLI runs it — every command hooks.json registers, with
 * CLAUDE_PLUGIN_ROOT set and the hook input on stdin — against a pack in a temporary state dir.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MORAL_CODE_CLOSE,
  MORAL_CODE_MARKER,
  moralCodeDeliveredIn,
  moralCodePackPath,
} from "./contract.js";

const PLUGIN_ROOT = path.resolve(__dirname, "../../claude-plugins/tinkerclaw-core");
/** The CLI's cap on one hook's additionalContext (CLI 2.1.287, `L3o=1e4`). */
const CLI_HOOK_CONTEXT_CAP = 10_000;

type HookConfig = {
  hooks: { SessionStart: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
};

function sessionStartCommands(): { matcher: string; commands: string[] } {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"),
  ) as HookConfig;
  const entries = cfg.hooks.SessionStart;
  expect(entries).toHaveLength(1);
  return { matcher: entries[0].matcher, commands: entries[0].hooks.map((h) => h.command) };
}

/** A pack shaped like the real one: the wrapper, a preamble, `#` sections of `##` subsections. */
function syntheticPack(sections: number, subsections: number, paragraph: number): string {
  let body = "\n\nThis is your moral code, delivered once at the start of this conversation.\n\n";
  for (let s = 1; s <= sections; s++) {
    body += `# Section ${s} — a foundation layer\n\n`;
    for (let k = 1; k <= subsections; k++) {
      body += `## ${s}.${k} A rule — “with” punctuation\n\n`;
      body += `${"Rule text that stays in force for the whole conversation. ".repeat(paragraph)}\n\n`;
    }
  }
  return `${MORAL_CODE_MARKER}${body}${MORAL_CODE_CLOSE}`;
}

/** Run every SessionStart command of hooks.json, as the CLI does; returns each one's additionalContext. */
function runHooks(pack: string, sessionId: string, source = "startup"): Array<string | undefined> {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "moral-parts-state-"));
  fs.mkdirSync(path.dirname(moralCodePackPath(state)), { recursive: true });
  fs.writeFileSync(moralCodePackPath(state), pack);
  return sessionStartCommands().commands.map((command) => {
    const cmd = command.replace("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT);
    const out = execFileSync("/bin/sh", ["-c", cmd], {
      input: JSON.stringify({ session_id: sessionId, source, hook_event_name: "SessionStart" }),
      env: { ...process.env, OPENCLAW_STATE_DIR: state, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
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

const PART =
  /^<moral_code source="tinkerclaw">\n\[moral code, part (\d+) of (\d+)\]\n([\s\S]*)<\/moral_code>$/;

/** The body a part carries, between its label line and its closing tag. */
function bodyOf(part: string): { i: number; n: number; body: string } {
  const m = PART.exec(part);
  expect(m, `not a complete labelled part: ${part.slice(0, 120)}`).not.toBeNull();
  return { i: Number(m![1]), n: Number(m![2]), body: m![3] };
}

let uniq = 0;
const sid = () => `test-${process.pid}-${Date.now()}-${uniq++}`;

describe("the moral code reaches the CLI in full: N parts, each under the CLI's hook cap", () => {
  it("fires on session start, clear and compaction", () => {
    expect(sessionStartCommands().matcher).toBe("startup|clear|compact");
  });

  it("splits a 40k pack into complete parts under the cap that reassemble to it byte for byte", () => {
    const pack = syntheticPack(7, 6, 16); // ≈ 40k chars, like the published pack
    expect(pack.length).toBeGreaterThan(38_000);
    const outs = runHooks(pack, sid()).filter((x): x is string => x !== undefined);
    expect(outs.length).toBeGreaterThanOrEqual(5);
    const parts = outs.map(bodyOf).sort((a, b) => a.i - b.i);
    for (const [k, p] of parts.entries()) {
      expect(p.i).toBe(k + 1);
      expect(p.n).toBe(parts.length);
    }
    for (const o of outs) {
      expect(o.length).toBeLessThan(CLI_HOOK_CONTEXT_CAP);
    }
    const inner = pack.slice(MORAL_CODE_MARKER.length, pack.length - MORAL_CODE_CLOSE.length);
    expect(parts.map((p) => p.body).join("")).toBe(inner);
    // Part 1 opens with the preamble; every later part opens on a heading, never mid-section.
    expect(parts[0].body).toContain("This is your moral code");
    for (const p of parts.slice(1)) {
      expect(p.body).toMatch(/^#{1,2} /);
    }
  });

  it("delivers a small pack as one complete part, and the unused slots say nothing", () => {
    const pack = syntheticPack(1, 2, 2);
    const outs = runHooks(pack, sid());
    expect(outs[0]).toBeDefined();
    expect(outs.slice(1).every((o) => o === undefined)).toBe(true);
    const p = bodyOf(outs[0]!);
    expect([p.i, p.n]).toEqual([1, 1]);
  });

  it("splits a section bigger than a part at paragraphs, and a paragraph bigger than a part at lines", () => {
    const giant = `${MORAL_CODE_MARKER}\n\n# One huge section\n\n${"A long paragraph line of the rules.\n".repeat(600)}\n${MORAL_CODE_CLOSE}`;
    const outs = runHooks(giant, sid()).filter((x): x is string => x !== undefined);
    const parts = outs.map(bodyOf).sort((a, b) => a.i - b.i);
    expect(parts.length).toBeGreaterThan(1);
    for (const o of outs) {
      expect(o.length).toBeLessThan(CLI_HOOK_CONTEXT_CAP);
    }
    const inner = giant.slice(MORAL_CODE_MARKER.length, giant.length - MORAL_CODE_CLOSE.length);
    expect(parts.map((p) => p.body).join("")).toBe(inner);
  });

  it("each part fires once per session even when the plugin is loaded twice (marketplace + --plugin-dir)", () => {
    const pack = syntheticPack(7, 6, 16);
    const session = sid();
    const first = runHooks(pack, session).filter((x) => x !== undefined);
    const second = runHooks(pack, session).filter((x) => x !== undefined);
    expect(first.length).toBeGreaterThan(1);
    expect(second).toHaveLength(0);
  });

  it("is what the resume check calls a complete delivery; a preview, a missing part or unsent stdout is not", () => {
    const pack = syntheticPack(7, 6, 16);
    const outs = runHooks(pack, sid()).filter((x): x is string => x !== undefined);
    const hookLine = (content: string[]) =>
      JSON.stringify({
        type: "attachment",
        attachment: { type: "hook_additional_context", content, hookEvent: "SessionStart" },
      });
    // The CLI collects the parts in completion order: shuffled is still complete.
    expect(moralCodeDeliveredIn(`${hookLine([...outs].reverse())}\n`)).toBe(true);
    expect(moralCodeDeliveredIn(`${hookLine(outs.slice(1))}\n`)).toBe(false);
    // What the CLI made of the single 40k block: a preview with the opening tag and no closing one.
    const preview = `Output too large (39.4KB). Full output saved to: /x\n\nPreview (first 2KB):\n${pack.slice(0, 2000)}\n...`;
    expect(moralCodeDeliveredIn(`${hookLine([preview])}\n`)).toBe(false);
    // The whole pack in the hook's stdout, which the CLI never sends.
    const stdoutOnly = JSON.stringify({
      type: "attachment",
      attachment: {
        type: "hook_success",
        content: "",
        stdout: JSON.stringify({ additionalContext: pack }),
      },
    });
    expect(moralCodeDeliveredIn(`${stdoutOnly}\n`)).toBe(false);
  });
});
