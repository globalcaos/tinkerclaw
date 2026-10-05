import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MORAL_CODE_MARKER as BRIDGE_MARKER } from "../../tinkerclaw-tinker-bridge/src/moral-code-delivery.js";
import register from "../index.js";
import {
  buildMoralCodePack,
  materializedPackPath,
  materializeMoralCodePack,
  messagesContainMoralCode,
  MORAL_CODE_MARKER,
  MORAL_CODE_SOURCES,
} from "./pack.js";

const BUNDLED = path.join(__dirname, "..", "prompts");
let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moral-code-"));
});
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("buildMoralCodePack", () => {
  it("bundles every source, ethical rules first, wrapped in the marker", () => {
    const pack = buildMoralCodePack({ stateDir, bundledDirs: [BUNDLED] });
    expect(pack.missing).toEqual([]);
    expect(pack.sources).toHaveLength(MORAL_CODE_SOURCES.length);
    expect(pack.sources[0]).toMatch(/ethical-rules-default\.md$/);
    expect(pack.text.startsWith(MORAL_CODE_MARKER)).toBe(true);
    expect(pack.text.trimEnd().endsWith("</moral_code>")).toBe(true);
  });

  it("prefers the user's workspace file over the bundled default", () => {
    const ws = path.join(stateDir, "workspace", "memory", "knowledge");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "jarvis-ethical-rules.md"), "---\nx: 1\n---\nMY RULES");
    const pack = buildMoralCodePack({ stateDir, bundledDirs: [BUNDLED] });
    expect(pack.sources[0]).toBe(path.join(ws, "jarvis-ethical-rules.md"));
    expect(pack.text).toContain("MY RULES");
    expect(pack.text).not.toContain("x: 1");
  });

  it("uses the same marker the bridge looks for", () => {
    expect(BRIDGE_MARKER).toBe(MORAL_CODE_MARKER);
  });
});

describe("materializeMoralCodePack", () => {
  it("writes once and skips identical content", () => {
    const pack = buildMoralCodePack({ stateDir, bundledDirs: [BUNDLED] });
    expect(materializeMoralCodePack(pack, stateDir)).toBe(true);
    expect(materializeMoralCodePack(pack, stateDir)).toBe(false);
    expect(fs.readFileSync(materializedPackPath(stateDir), "utf8")).toBe(pack.text);
  });
});

describe("messagesContainMoralCode", () => {
  it("finds the marker in string and block content", () => {
    expect(messagesContainMoralCode([])).toBe(false);
    expect(messagesContainMoralCode([{ role: "user", content: "hi" }])).toBe(false);
    expect(
      messagesContainMoralCode([
        { role: "user", content: [{ type: "text", text: `${MORAL_CODE_MARKER}\nrules` }] },
      ]),
    ).toBe(true);
  });
});

describe("before_prompt_build delivery", () => {
  function setup() {
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const handlers: Record<string, (p: unknown, c: unknown) => Promise<unknown>> = {};
    register({
      logger: { info: vi.fn(), warn: vi.fn() },
      on: (name: string, fn: (p: unknown, c: unknown) => Promise<unknown>) => {
        handlers[name] = fn;
      },
    } as never);
    return handlers.before_prompt_build!;
  }
  afterEach(() => vi.unstubAllEnvs());

  it("prepends the pack on a session without it, for a non-Claude provider", async () => {
    const hook = setup();
    const out = (await hook({ prompt: "hi", messages: [] }, { modelProviderId: "openai" })) as {
      prependContext?: string;
    };
    expect(out?.prependContext?.startsWith(MORAL_CODE_MARKER)).toBe(true);
    expect(fs.existsSync(materializedPackPath(stateDir))).toBe(true);
  });

  it("stays silent once the session carries it (no per-turn repeat)", async () => {
    const hook = setup();
    const out = await hook(
      { prompt: "hi", messages: [{ role: "user", content: `${MORAL_CODE_MARKER} …` }] },
      { modelProviderId: "xai" },
    );
    expect(out).toBeUndefined();
  });

  it("leaves claude-code turns to the Claude Code SessionStart hook", async () => {
    const hook = setup();
    expect(await hook({ prompt: "hi", messages: [] }, { modelProviderId: "claude-code" })).toBe(
      undefined,
    );
  });

  it("Claude out of tokens: the fallback attempt of the SAME turn gets the pack from TinkerClaw", async () => {
    // The architect, 2026-09-23: "what will happen if I run out of claude tokens?" The hook runs
    // per model attempt with that attempt's provider, over the gateway's own session messages —
    // which never carry the pack on a Claude-driven session (Claude received it on its side).
    const hook = setup();
    const session = [
      { role: "user", content: "earlier prompt" },
      { role: "assistant", content: [{ type: "text", text: "earlier Claude answer" }] },
    ];
    const claudeAttempt = await hook(
      { prompt: "next", messages: session },
      { modelProviderId: "claude-code" },
    );
    expect(claudeAttempt).toBeUndefined();
    const fallbackAttempt = (await hook(
      { prompt: "next", messages: session },
      { modelProviderId: "xai" },
    )) as { prependContext?: string };
    expect(fallbackAttempt?.prependContext?.startsWith(MORAL_CODE_MARKER)).toBe(true);
  });
});

describe("tinkerclaw-core SessionStart hook script", () => {
  const script = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "claude-plugins",
    "tinkerclaw-core",
    "scripts",
    "moral-code-session-start.mjs",
  );
  const run = (input: object, part = 1) =>
    execFileSync("node", [script, "--part", String(part)], {
      input: JSON.stringify(input),
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      encoding: "utf8",
    });

  // FORK 2026-10-02 — the hook delivers the pack as parts, one per hooks.json slot, each a complete
  // block under the claude CLI's 10,000-char hook-context cap (src/moral-code/delivery-parts.test.ts
  // holds the cap and the reassembly at full size). Here: the BUILT pack comes back whole.
  it("emits the materialized pack as SessionStart parts that reassemble to it, once per session+source", () => {
    const pack = buildMoralCodePack({ stateDir, bundledDirs: [BUNDLED] });
    materializeMoralCodePack(pack, stateDir);
    const sid = `test-${Date.now()}-${Math.random()}`;
    const bodies: string[] = [];
    for (let part = 1; part <= 10; part++) {
      const out = run({ session_id: sid, source: "startup" }, part);
      if (!out) {
        continue;
      }
      const parsed = JSON.parse(out) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
      const m =
        /^<moral_code source="tinkerclaw">\n\[moral code, part (\d+) of (\d+)\]\n([\s\S]*)<\/moral_code>$/.exec(
          parsed.hookSpecificOutput.additionalContext,
        );
      expect(m?.[1]).toBe(String(part));
      bodies.push(m![3]);
    }
    const text = pack.text.trim();
    expect(`<moral_code source="tinkerclaw">${bodies.join("")}</moral_code>`).toBe(text);
    expect(run({ session_id: sid, source: "startup" }, 1)).toBe("");
    expect(run({ session_id: sid, source: "compact" }, 1)).not.toBe("");
  });

  it("is silent when no pack has been built yet", () => {
    expect(run({ session_id: "none", source: "startup" })).toBe("");
  });
});
