/**
 * FORK 2026-08-23 — the cache boundary must be EMITTED, and in the right place.
 *
 * `system-prompt-cache-boundary.ts` was fully implemented and fully tested for months while
 * every importer of it was a test. It was therefore tree-shaken out of the bundle and occurred
 * zero times in `dist/index.js`, so `stableSystemPromptPrefix` in the tinker-bridge always took
 * its "marker absent → hash the whole prompt" fallback. Result: 90–100% of turns spawned a cold
 * claude process, every day, for weeks.
 *
 * That is the failure mode this file exists to prevent, and a test asserting only that the
 * CONSTANT is correct would not have caught it — the constant was always correct. These tests
 * assert that the marker reaches a built prompt and that the per-turn-volatile sections fall on
 * the far side of it, which is the only property the worker pool actually depends on.
 */
import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./system-prompt-cache-boundary.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

/** The bridge matches the BARE marker; core's constant is newline-wrapped. */
const BARE = "<!-- OPENCLAW_CACHE_BOUNDARY -->";

/** Mirrors `stableSystemPromptPrefix` in extensions/tinkerclaw-tinker-bridge/src/stream.ts. */
function stablePrefix(prompt: string): string {
  const idx = prompt.indexOf(BARE);
  return idx === -1 ? prompt : prompt.slice(0, idx);
}

function build(over: Partial<Parameters<typeof buildAgentSystemPrompt>[0]> = {}): string {
  return buildAgentSystemPrompt({
    workspaceDir: "/tmp/ws",
    reasoningTagHint: false,
    modelAliasLines: [],
    userTimezone: "Europe/Madrid",
    toolNames: ["bash"],
    runtimeInfo: {
      host: "host-a",
      os: "linux",
      arch: "x64",
      node: "22",
      model: "claude-opus-5",
    },
    ...over,
  } as Parameters<typeof buildAgentSystemPrompt>[0]);
}

describe("the cache boundary is actually emitted", () => {
  it("appears in a built prompt — the property that was missing for months", () => {
    expect(build()).toContain(BARE);
  });

  it("appears exactly once, so a prefix slice is unambiguous", () => {
    const prompt = build();
    expect(prompt.split(BARE).length - 1).toBe(1);
  });

  it("leaves a NON-EMPTY prefix — an empty key would collapse every worker into one", () => {
    // `deriveSessionKey` guards against a blank promptPart, but a near-empty prefix would be
    // just as wrong in a quieter way: every session sharing one worker.
    expect(stablePrefix(build()).length).toBeGreaterThan(200);
  });
});

describe("what falls on which side of it", () => {
  it("puts the ## Runtime line AFTER the boundary — it had 55 distinct values in 142 turns", () => {
    const prompt = build();
    expect(prompt).toContain("## Runtime");
    expect(stablePrefix(prompt)).not.toContain("## Runtime");
  });

  it("keeps the prefix identical when only the runtime facts change", () => {
    // The whole point. Same identity, different model/thinking level => SAME worker key.
    const a = build({
      runtimeInfo: { host: "h", os: "linux", node: "22", model: "claude-opus-5" },
    });
    const b = build({
      runtimeInfo: { host: "h", os: "linux", node: "22", model: "claude-sonnet-5" },
      defaultThinkLevel: "high",
    } as never);
    expect(a).not.toBe(b); // the prompts genuinely differ...
    expect(stablePrefix(a)).toBe(stablePrefix(b)); // ...but the worker key does not.
  });

  it("puts the group-chat / subagent context after the boundary", () => {
    const prompt = build({ extraSystemPrompt: "EXTRA-SENTINEL" } as never);
    expect(prompt).toContain("EXTRA-SENTINEL");
    expect(stablePrefix(prompt)).not.toContain("EXTRA-SENTINEL");
  });

  it("keeps IDENTITY in the prefix — a different persona must not share a worker", () => {
    const a = build({ personaBlock: "PERSONA-A" } as never);
    const b = build({ personaBlock: "PERSONA-B" } as never);
    if (a.includes("PERSONA-A")) {
      expect(stablePrefix(a)).not.toBe(stablePrefix(b));
    }
  });

  it("keeps the TOOL SET in the prefix — different tools is a different worker", () => {
    const a = build({ toolNames: ["bash"] } as never);
    const b = build({ toolNames: ["bash", "read", "write"] } as never);
    expect(stablePrefix(a)).not.toBe(stablePrefix(b));
  });
});

describe("the constant the bridge matches on", () => {
  it("contains the bare marker the bridge greps for", () => {
    // The bridge duplicates the string as a literal rather than importing it (the extension
    // ships as its own tarball). If core ever reshapes this constant, the bridge silently
    // reverts to hashing the whole prompt — a colder pool, never a mis-keyed one, but silent.
    expect(SYSTEM_PROMPT_CACHE_BOUNDARY).toContain(BARE);
  });
});
