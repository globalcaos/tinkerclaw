// FORK 2026-08-28 (the architect: the CONTEXT WINDOW panel's manual "evict" button); moved here
// with the function 2026-09-24 (context-window-panel.md §6.1 A5).
//
// evictTranscriptTail is the transcript-aware half of `sessions.compact { keepFraction }`. It
// exists because the older `maxLines` path is a blind `lines.slice(-n)` on a file that is NOT a
// flat log: line 0 is a `{type:"session"}` header and every later entry chains through
// `parentId`, which SessionManager.getBranch() walks. The first block pins the three properties
// that make the rewrite safe — the header survives, the chain is unbroken, and the cut never
// lands mid-turn. The rest pins what A5 added: the estimates sit on the anatomy's scale, the
// eviction refuses on a lane whose runtime owns the context without touching anything, and a
// real eviction is heard as exactly one compaction start / end pair.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type AgentEventPayload, onAgentEvent } from "../infra/agent-events.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { ErrorCodes, errorShape } from "./protocol/index.js";
import {
  evictSessionTranscript,
  evictTranscriptTail,
  resolveContextOwningRuntime,
  resolveEvictionRefusal,
} from "./session-eviction.js";

// isCliProvider asks the live plugin registries; pin it so the lane tests are hermetic.
// claude-cli stands in for "a registered CLI backend".
vi.mock("../agents/model-selection-cli.js", () => ({
  isCliProvider: (provider: string) => provider === "claude-cli",
}));

// The anatomy's estimator, passed through untouched unless a case injects a fault into it: the
// absent-not-zero control below needs an estimate that is not a finite count, and
// ceil(chars / 3.5) never yields one on its own.
const estimator = vi.hoisted(() => ({
  fault: undefined as ((chars: number) => number) | undefined,
}));
vi.mock("../agents/context-anatomy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/context-anatomy.js")>();
  return {
    ...actual,
    estimateTokens: (chars: number) =>
      estimator.fault ? estimator.fault(chars) : actual.estimateTokens(chars),
  };
});

type Entry = Record<string, unknown>;

/**
 * Build a realistic transcript: header, two control entries, then N user/assistant turns.
 * `envelopeChars` adds a bulky NON-content field to every message, the way real assistant
 * entries carry a usage block.
 */
function transcript(
  turns: number,
  opts?: { toolResultOnUser?: number; envelopeChars?: number },
): string {
  const envelope = opts?.envelopeChars ? { usage: { note: "x".repeat(opts.envelopeChars) } } : {};
  const lines: Entry[] = [
    { type: "session", version: 1, id: "s0", timestamp: 0, cwd: "/tmp" },
    { type: "model_change", id: "c1", parentId: "s0", provider: "anthropic", modelId: "opus" },
    { type: "thinking_level_change", id: "c2", parentId: "c1", thinkingLevel: "medium" },
  ];
  let prev = "c2";
  for (let t = 0; t < turns; t++) {
    const userId = `u${t}`;
    const content =
      opts?.toolResultOnUser === t
        ? [{ type: "tool_result", toolCallId: `tc${t}`, output: "ok" }]
        : [{ type: "text", text: `question ${t}` }];
    lines.push({
      type: "message",
      id: userId,
      parentId: prev,
      message: { role: "user", content, ...envelope },
    });
    const asstId = `a${t}`;
    lines.push({
      type: "message",
      id: asstId,
      parentId: userId,
      message: { role: "assistant", content: [{ type: "text", text: `answer ${t}` }], ...envelope },
    });
    prev = asstId;
  }
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

function parse(lines: string[]): Entry[] {
  return lines.map((l) => JSON.parse(l) as Entry);
}

/** Every entry after the first must point at the entry before it. */
function chainIsUnbroken(entries: Entry[]): boolean {
  for (let i = 1; i < entries.length; i++) {
    if (!("parentId" in entries[i])) {
      continue;
    }
    if (entries[i].parentId !== entries[i - 1].id) {
      return false;
    }
  }
  return true;
}

describe("evictTranscriptTail", () => {
  it("keeps the session header and every structural entry", () => {
    const res = evictTranscriptTail(transcript(10), 0.5);
    expect(res.ok).toBe(true);
    if (!res.ok || res.lines === null) {
      throw new Error("expected an eviction");
    }
    const kept = parse(res.lines);
    expect(kept[0].type).toBe("session");
    // model_change and thinking_level_change are structural and survive regardless of position.
    expect(kept.map((e) => e.type)).toContain("model_change");
    expect(kept.map((e) => e.type)).toContain("thinking_level_change");
  });

  it("leaves the parentId chain unbroken end to end", () => {
    const res = evictTranscriptTail(transcript(10), 0.5);
    if (!res.ok || res.lines === null) {
      throw new Error("expected an eviction");
    }
    expect(chainIsUnbroken(parse(res.lines))).toBe(true);
  });

  it("actually drops the oldest turns", () => {
    const res = evictTranscriptTail(transcript(10), 0.5);
    if (!res.ok || res.lines === null) {
      throw new Error("expected an eviction");
    }
    // 20 messages, keep ~10 → about half evicted, and the survivors are the NEWEST.
    expect(res.evicted).toBeGreaterThan(0);
    expect(res.kept).toBeGreaterThanOrEqual(2);
    expect(res.evicted + res.kept).toBe(20);
    const text = res.lines.join("\n");
    expect(text).toContain("question 9");
    expect(text).not.toContain("question 0");
  });

  it("cuts at a user message that carries no tool result", () => {
    const res = evictTranscriptTail(transcript(10), 0.5);
    if (!res.ok || res.lines === null) {
      throw new Error("expected an eviction");
    }
    const firstMessage = parse(res.lines).find((e) => e.type === "message");
    const msg = firstMessage?.message as { role?: string; content?: Array<{ type?: string }> };
    expect(msg.role).toBe("user");
    expect(msg.content?.some((b) => b.type === "tool_result")).toBe(false);
  });

  it("snaps FORWARD past a tool-result user message rather than orphaning it", () => {
    // Turn 5's user message is a tool result. A 0.5 keep targets message ordinal 10 — which is
    // exactly that turn's user entry — so the cut must move on to the next safe boundary.
    const res = evictTranscriptTail(transcript(10, { toolResultOnUser: 5 }), 0.5);
    if (!res.ok || res.lines === null) {
      throw new Error("expected an eviction");
    }
    const kept = parse(res.lines).filter((e) => e.type === "message");
    const first = kept[0].message as { role?: string; content?: Array<{ type?: string }> };
    expect(first.role).toBe("user");
    expect(first.content?.some((b) => b.type === "tool_result")).toBe(false);
    // Snapping forward keeps FEWER messages than the naive target, never more.
    expect(res.kept).toBeLessThanOrEqual(10);
  });

  it("writes nothing for a transcript with fewer than four messages", () => {
    const res = evictTranscriptTail(transcript(1), 0.5);
    expect(res).toMatchObject({ ok: true, evicted: 0, evictedTokens: 0, lines: null });
    if (res.ok && res.lines === null) {
      expect(res.reason).toBe("too few messages to evict");
    }
  });

  it("refuses to rewrite a transcript it cannot fully parse", () => {
    const broken = `${transcript(10)}{not json\n`;
    expect(evictTranscriptTail(broken, 0.5)).toEqual({
      ok: false,
      reason: "unparsable transcript",
    });
  });

  it("keeps at least two messages however small the fraction", () => {
    const res = evictTranscriptTail(transcript(10), 0.01);
    if (!res.ok || res.lines === null) {
      throw new Error("expected an eviction");
    }
    expect(res.kept).toBeGreaterThanOrEqual(2);
    expect(chainIsUnbroken(parse(res.lines))).toBe(true);
  });
  it("estimates the tokens the eviction bought, over dropped messages only", () => {
    const res = evictTranscriptTail(transcript(10), 0.5);
    if (!res.ok || res.lines === null) {
      throw new Error("expected an eviction");
    }
    // A real saving, on the anatomy's ceil(chars/3.5) ladder.
    expect(res.evictedTokens).toBeGreaterThan(0);
    // Sanity: it cannot exceed the whole transcript, and it must scale with what was dropped.
    const whole = Math.ceil(transcript(10).length / 3.5);
    expect(res.evictedTokens).toBeLessThan(whole);
    const harsher = evictTranscriptTail(transcript(10), 0.2);
    if (harsher.ok && harsher.lines !== null) {
      expect(harsher.evictedTokens).toBeGreaterThanOrEqual(res.evictedTokens);
    }
  });
});

describe("evictTranscriptTail — estimates (P11)", () => {
  it("reports before and after as parts on one estimator", () => {
    const res = evictTranscriptTail(transcript(10), 0.5);
    if (!res.ok || res.lines === null) {
      throw new Error("expected an eviction");
    }
    expect(res.tokensBefore).toBeGreaterThan(res.tokensAfter);
    expect(res.tokensAfter).toBeGreaterThan(0);
    // Three independent ceil()s: the parts agree to within one token (parts, never a delta — P5).
    expect(Math.abs(res.tokensBefore - res.tokensAfter - res.evictedTokens)).toBeLessThanOrEqual(1);
  });

  it("measures what the model is sent, not the transcript entry's envelope", () => {
    // Same conversation twice; the second carries a bulky non-content field on every message.
    // The model never sees it, so no estimate may move. The entry-JSON measure this replaced
    // would read the bulky run far higher.
    const lean = evictTranscriptTail(transcript(10), 0.5);
    const bulky = evictTranscriptTail(transcript(10, { envelopeChars: 5000 }), 0.5);
    if (!lean.ok || lean.lines === null || !bulky.ok || bulky.lines === null) {
      throw new Error("expected two evictions");
    }
    expect(bulky.evictedTokens).toBe(lean.evictedTokens);
    expect(bulky.tokensBefore).toBe(lean.tokensBefore);
    expect(bulky.tokensAfter).toBe(lean.tokensAfter);
  });
});

describe("resolveContextOwningRuntime (P8)", () => {
  const cfg = {} as OpenClawConfig;

  it("names the claude-code runtime, however the id is cased", () => {
    expect(resolveContextOwningRuntime("claude-code", cfg)).toBe("claude-code");
    expect(resolveContextOwningRuntime("Claude-Code", cfg)).toBe("claude-code");
  });

  it("names a registered CLI backend", () => {
    expect(resolveContextOwningRuntime("claude-cli", cfg)).toBe("claude-cli");
  });

  it("leaves an embedded provider evictable", () => {
    expect(resolveContextOwningRuntime("anthropic", cfg)).toBeUndefined();
    expect(resolveContextOwningRuntime("", cfg)).toBeUndefined();
  });
});

describe("resolveEvictionRefusal — the lane of the NEXT call", () => {
  const cfg = {
    agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
  } as OpenClawConfig;
  const base = { sessionId: "s1", updatedAt: 1 };

  afterEach(() => {
    resetConfigRuntimeState();
  });

  it("refuses a claude-code session with a reason that names the runtime", () => {
    const reason = resolveEvictionRefusal({
      cfg,
      agentId: "main",
      entry: { ...base, modelProvider: "claude-code", model: "claude-opus-5" } as SessionEntry,
    });
    expect(reason).toContain("claude-code");
  });

  it("allows an embedded session", () => {
    const reason = resolveEvictionRefusal({
      cfg,
      agentId: "main",
      entry: { ...base, modelProvider: "anthropic", model: "claude-opus-4-6" } as SessionEntry,
    });
    expect(reason).toBeUndefined();
  });

  it("follows the model picker: an override to an embedded model makes it evictable", () => {
    const reason = resolveEvictionRefusal({
      cfg,
      agentId: "main",
      entry: {
        ...base,
        modelProvider: "claude-code",
        model: "claude-opus-5",
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-6",
      } as SessionEntry,
    });
    expect(reason).toBeUndefined();
  });
});

const STORE_KEY = "agent:main:main";

/** A real store + transcript on disk, isolated in a temp state dir. */
async function withEvictionFixture(
  run: (fx: {
    dir: string;
    storePath: string;
    filePath: string;
    cfg: OpenClawConfig;
  }) => Promise<void>,
): Promise<void> {
  resetConfigRuntimeState();
  clearSessionStoreCacheForTest();
  try {
    await withStateDirEnv("session-eviction-", async ({ stateDir }) => {
      const dir = path.join(stateDir, "agents", "main", "sessions");
      fs.mkdirSync(dir, { recursive: true });
      const storePath = path.join(dir, "sessions.json");
      fs.writeFileSync(
        storePath,
        JSON.stringify(
          {
            [STORE_KEY]: {
              sessionId: "sess-1",
              updatedAt: 1,
              inputTokens: 5,
              outputTokens: 6,
              totalTokens: 999,
              totalTokensFresh: true,
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      const filePath = path.join(dir, "sess-1.jsonl");
      fs.writeFileSync(filePath, transcript(10), "utf8");
      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: {
          defaults: { model: { primary: "anthropic/claude-opus-4-6" } },
          list: [{ id: "main", default: true }],
        },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);
      await run({ dir, storePath, filePath, cfg });
    });
  } finally {
    clearSessionStoreCacheForTest();
    resetConfigRuntimeState();
  }
}

function captureCompactionEvents(): { events: AgentEventPayload[]; stop: () => void } {
  const events: AgentEventPayload[] = [];
  const stop = onAgentEvent((evt) => {
    if (evt.stream === "compaction") {
      events.push(evt);
    }
  });
  return { events, stop };
}

describe("evictSessionTranscript", () => {
  it("refuses on the claude-code lane with a reason, touching neither the run nor the transcript", async () => {
    await withEvictionFixture(async ({ dir, storePath, filePath, cfg }) => {
      const before = fs.readFileSync(filePath, "utf8");
      const interruptRun = vi.fn(() => Promise.resolve({}));
      const { events, stop } = captureCompactionEvents();
      const outcome = await evictSessionTranscript({
        cfg,
        entry: {
          sessionId: "sess-1",
          updatedAt: 1,
          modelProvider: "claude-code",
          model: "claude-opus-5",
        } as SessionEntry,
        agentId: "main",
        canonicalKey: STORE_KEY,
        storePath,
        storeKey: STORE_KEY,
        filePath,
        keepFraction: 0.5,
        interruptRun,
      });
      stop();

      if (outcome.kind !== "reply") {
        throw new Error("expected a reply");
      }
      expect(outcome.evicted).toBe(false);
      expect(outcome.reply).toMatchObject({ ok: false, key: STORE_KEY, compacted: false });
      expect(outcome.reply.reason).toContain("claude-code");
      // The two things a refusal must NOT do: abort the live turn, rewrite the transcript.
      expect(interruptRun).not.toHaveBeenCalled();
      expect(fs.readFileSync(filePath, "utf8")).toBe(before);
      expect(fs.readdirSync(dir).filter((f) => f.includes(".bak."))).toEqual([]);
      expect(events).toEqual([]);
      expect(loadSessionStore(storePath, { skipCache: true })[STORE_KEY]?.totalTokens).toBe(999);
    });
  });

  it("returns an interrupt failure as an RPC error and leaves the transcript alone", async () => {
    await withEvictionFixture(async ({ storePath, filePath, cfg }) => {
      const before = fs.readFileSync(filePath, "utf8");
      const error = errorShape(ErrorCodes.UNAVAILABLE, "failed to interrupt active session");
      const outcome = await evictSessionTranscript({
        cfg,
        entry: {
          sessionId: "sess-1",
          updatedAt: 1,
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
        } as SessionEntry,
        agentId: "main",
        canonicalKey: STORE_KEY,
        storePath,
        storeKey: STORE_KEY,
        filePath,
        keepFraction: 0.5,
        interruptRun: () => Promise.resolve({ error }),
      });
      expect(outcome).toEqual({ kind: "error", error });
      expect(fs.readFileSync(filePath, "utf8")).toBe(before);
    });
  });

  it("evicts on an embedded lane: before / after on the reply, cached counts dropped, one compaction pair heard", async () => {
    await withEvictionFixture(async ({ storePath, filePath, cfg }) => {
      const { events, stop } = captureCompactionEvents();
      const outcome = await evictSessionTranscript({
        cfg,
        entry: {
          sessionId: "sess-1",
          updatedAt: 1,
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
        } as SessionEntry,
        agentId: "main",
        canonicalKey: STORE_KEY,
        storePath,
        storeKey: STORE_KEY,
        filePath,
        keepFraction: 0.5,
        interruptRun: () => Promise.resolve({}),
      });
      stop();

      if (outcome.kind !== "reply" || !outcome.evicted) {
        throw new Error("expected an eviction");
      }
      const { tokensBefore, tokensAfter, evictedTokens, archived } = outcome.reply;
      if (tokensBefore === undefined || tokensAfter === undefined || archived === undefined) {
        throw new Error("expected estimates and an archive on the reply");
      }
      expect(outcome.reply).toMatchObject({ ok: true, key: STORE_KEY, compacted: true });
      expect(tokensBefore).toBeGreaterThan(tokensAfter);
      expect(fs.existsSync(archived)).toBe(true);
      expect(fs.readFileSync(filePath, "utf8")).not.toContain("question 0");

      const row = loadSessionStore(storePath, { skipCache: true })[STORE_KEY];
      expect(row?.totalTokens).toBeUndefined();
      expect(row?.totalTokensFresh).toBeUndefined();
      expect(row?.inputTokens).toBeUndefined();
      expect(row?.outputTokens).toBeUndefined();

      expect(events.map((e) => e.data.phase)).toEqual(["start", "end"]);
      expect(events[0].runId).toBe(events[1].runId);
      expect(events.every((e) => e.sessionKey === STORE_KEY)).toBe(true);
      // Omitted, never zeroed: a start has no numbers to report yet.
      expect(events[0].data).toEqual({
        phase: "start",
        trigger: "evict",
        lane: "embedded",
        provenance: "estimated",
      });
      expect(events[1].data).toMatchObject({
        phase: "end",
        trigger: "evict",
        lane: "embedded",
        completed: true,
        tokensBefore,
        tokensAfter,
        tokensDropped: evictedTokens,
        provenance: "estimated",
      });
      expect(typeof events[1].data.durationMs).toBe("number");
      // The end event's key set, EXACTLY: nothing extra, and `willRetry` — pi-auto's field alone —
      // never. This pin passes on the pre-re-point tree too, by design: A1's owner writes the same
      // keys from the same values, so the wire payload of a MEASURED eviction did not change. What
      // the re-point did change is pinned by the next case (an unmeasured figure is omitted) and by
      // the structural guard at the bottom of this file (the stream literal is A1's alone).
      expect(Object.keys(events[1].data).sort()).toEqual([
        "completed",
        "durationMs",
        "lane",
        "phase",
        "provenance",
        "tokensAfter",
        "tokensBefore",
        "tokensDropped",
        "trigger",
      ]);
    });
  });

  it("omits an estimate that is not a finite count instead of sending it (A1's absent-not-zero pass)", async () => {
    // CONTROL for the A1 re-point. Until 2026-09-24 this module published through its own
    // emitAgentEvent and forwarded the call site's object untouched, so a NaN estimate went out
    // as `tokensBefore: NaN` (and After / Dropped likewise). The owner builds the payload through
    // buildCompactionEventData, which drops anything that is not a finite number >= 0: the field
    // is ABSENT ("unknown"), never a fabricated or poisoned figure.
    await withEvictionFixture(async ({ storePath, filePath, cfg }) => {
      const { events, stop } = captureCompactionEvents();
      estimator.fault = () => Number.NaN;
      try {
        const outcome = await evictSessionTranscript({
          cfg,
          entry: {
            sessionId: "sess-1",
            updatedAt: 1,
            modelProvider: "anthropic",
            model: "claude-opus-4-6",
          } as SessionEntry,
          agentId: "main",
          canonicalKey: STORE_KEY,
          storePath,
          storeKey: STORE_KEY,
          filePath,
          keepFraction: 0.5,
          interruptRun: () => Promise.resolve({}),
        });
        if (outcome.kind !== "reply" || !outcome.evicted) {
          throw new Error("expected an eviction");
        }
      } finally {
        estimator.fault = undefined;
        stop();
      }

      expect(events.map((e) => e.data.phase)).toEqual(["start", "end"]);
      expect(Object.keys(events[1].data).sort()).toEqual([
        "completed",
        "durationMs",
        "lane",
        "phase",
        "provenance",
        "trigger",
      ]);
      expect(events[1].data).toMatchObject({ completed: true, trigger: "evict" });
    });
  });
});

// FORK 2026-09-24 — structural guards no runtime assertion can make: each is a cheap check that
// fails loudly on the exact regression it names, which is what the bible asks for over prose.
describe("session-eviction's structural invariants", () => {
  const moduleSource = fs.readFileSync(
    fileURLToPath(new URL("./session-eviction.ts", import.meta.url)),
    "utf8",
  );

  it("publishes through A1's owner and never names the compaction stream itself", () => {
    // P7 has ONE owner: src/infra/compaction-telemetry.ts. This mirrors frontmatter gate 7 of
    // TINKER_UI_DESIGN_BIBLE/context-window-panel.md into the unit suite, where it runs on every
    // test run rather than only under `pnpm bible:invariants`.
    expect(moduleSource).not.toMatch(/stream\s*:\s*["']compaction["']/);
    expect(moduleSource).toContain("emitCompactionTelemetry");
  });

  // True when `source` re-exports evictTranscriptTail: a named export list (from the module, or of
  // a local import), `export *` of the module, or an exported re-definition. Comments are stripped
  // first, so a comment quoting the old line is history, not an export.
  const reExportsEvictTranscriptTail = (source: string): boolean => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    return (
      /\bexport\s*(?:type\s+)?\{[^}]*\bevictTranscriptTail\b[^}]*\}/.test(code) ||
      /\bexport\s*\*\s*(?:as\s+\w+\s+)?from\s*["'][^"']*\/session-eviction(?:\.[jt]s)?["']/.test(
        code,
      ) ||
      /\bexport\s+(?:async\s+)?(?:function\*?|const|let|var)\s+evictTranscriptTail\b/.test(code)
    );
  };

  it("is not re-exported from sessions.ts: its one home is session-eviction.ts", () => {
    // Replaces "is the only home of the eviction tests", which asked to be retired in the commit
    // that dropped sessions.ts's re-export (b5f50c2173c). That re-export existed only so a duplicate
    // of this file's first block (server-methods/sessions-evict-transcript.test.ts, deleted in
    // f2f6d18d021) could import the function from there; a verbatim return of that duplicate now
    // fails on its own, since its import from ./sessions.js no longer resolves (TS2305). What can
    // still come back silently is the re-export itself: sessions.ts is a tier-1 merge-driver file,
    // where a merge can put a deleted line back without a conflict, and a re-export compiles and
    // passes every other test. If this fails, delete the re-export and import from
    // ../session-eviction.js instead.
    const sessionsSource = fs.readFileSync(
      fileURLToPath(new URL("./server-methods/sessions.ts", import.meta.url)),
      "utf8",
    );
    expect(reExportsEvictTranscriptTail(sessionsSource)).toBe(false);

    // CONTROL, kept in the test so it cannot rot: the same source with the removed line put back
    // (in memory; sessions.ts is never written) must trip the guard, and so must the other ways of
    // re-exporting it. A pattern that matched nothing would pass the assertion above just as well.
    const removedLine = 'export { evictTranscriptTail } from "../session-eviction.js";';
    expect(reExportsEvictTranscriptTail(`${sessionsSource}\n${removedLine}\n`)).toBe(true);
    expect(reExportsEvictTranscriptTail('export * from "../session-eviction.js";')).toBe(true);
    expect(
      reExportsEvictTranscriptTail(
        'import { evictTranscriptTail } from "../session-eviction.js";\nexport { evictTranscriptTail };',
      ),
    ).toBe(true);
    // ...and must not trip on what sessions.ts legitimately holds: the delegate it imports, and a
    // comment that quotes the old line.
    expect(
      reExportsEvictTranscriptTail(
        `import { evictSessionTranscript } from "../session-eviction.js";\n// was: ${removedLine}\n`,
      ),
    ).toBe(false);
  });
});
