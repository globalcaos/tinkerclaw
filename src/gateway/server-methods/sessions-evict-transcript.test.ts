// FORK 2026-08-28 (the architect: the CONTEXT WINDOW panel's manual "evict" button).
//
// evictTranscriptTail is the transcript-aware half of `sessions.compact { keepFraction }`. It
// exists because the older `maxLines` path is a blind `lines.slice(-n)` on a file that is NOT a
// flat log: line 0 is a `{type:"session"}` header and every later entry chains through
// `parentId`, which SessionManager.getBranch() walks. These tests pin the three properties that
// make the rewrite safe — the header survives, the chain is unbroken, and the cut never lands
// mid-turn.

import { describe, it, expect } from "vitest";
import { evictTranscriptTail } from "./sessions.js";

type Entry = Record<string, unknown>;

/** Build a realistic transcript: header, two control entries, then N user/assistant turns. */
function transcript(turns: number, opts?: { toolResultOnUser?: number }): string {
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
      message: { role: "user", content },
    });
    const asstId = `a${t}`;
    lines.push({
      type: "message",
      id: asstId,
      parentId: userId,
      message: { role: "assistant", content: [{ type: "text", text: `answer ${t}` }] },
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
