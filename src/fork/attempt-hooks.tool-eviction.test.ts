import { afterEach, describe, expect, it } from "vitest";
import { renderToolResultEvictionMarker } from "../memory/engram/eviction-marker.js";
import { evictOldToolResults } from "./attempt-hooks.js";

const big = (n: number) => "x".repeat(n * 4); // ~n tokens
const user = (t: string) => ({ role: "user", content: [{ type: "text", text: t }] });
const call = (id: string) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "exec" }],
});
const result = (id: string, tokens: number) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "exec",
  isError: false,
  content: [{ type: "text", text: big(tokens) }],
});
const turn = (i: number, tokens: number) => [user(`q${i}`), call(`c${i}`), result(`c${i}`, tokens)];

describe("evictOldToolResults (junk-first eviction)", () => {
  afterEach(() => delete process.env["ENGRAM_TOOL_EVICTION"]);

  it("does nothing below 80% of the window", () => {
    const msgs = [1, 2, 3, 4, 5].flatMap((i) => turn(i, 1000));
    expect(evictOldToolResults(msgs, 100_000).messages).toBeNull();
  });

  it("stubs old tool output, oldest first, until under 60%, keeping pairing and the hot tail", () => {
    const msgs = [1, 2, 3, 4, 5, 6].flatMap((i) => turn(i, 15_000)); // ~90k of 100k
    const r = evictOldToolResults(msgs, 100_000);
    expect(r.messages).not.toBeNull();
    const out = r.messages!;
    expect(out).toHaveLength(msgs.length);
    // ids and roles untouched everywhere
    out.forEach((m, i) => {
      expect(m.role).toBe(msgs[i].role);
      if (m.role === "toolResult")
        expect((m as { toolCallId: string }).toolCallId).toBe(
          (msgs[i] as { toolCallId: string }).toolCallId,
        );
    });
    const stubbed = out.map(
      (m) => m.role === "toolResult" && JSON.stringify(m.content).includes("Evicted exec output"),
    );
    const resultIdx = msgs.map((m, i) => (m.role === "toolResult" ? i : -1)).filter((i) => i >= 0);
    const flags = resultIdx.map((i) => stubbed[i]);
    // oldest first: once one is kept, no later one is stubbed
    expect(flags[0]).toBe(true);
    expect(flags.indexOf(false)).toBeGreaterThan(0);
    expect(flags.slice(flags.indexOf(false)).every((f) => !f)).toBe(true);
    // the last three turns (results 4, 5, 6) stay verbatim
    expect(flags.slice(-3)).toEqual([false, false, false]);
    const total = out.reduce((s, m) => s + JSON.stringify(m.content).length / 4, 0);
    expect(total).toBeLessThanOrEqual(60_000);
  });

  it("leaves a marker that quotes the result and names the toolCallId recall fetches it by", () => {
    const log = (id: string) => ({
      role: "toolResult",
      toolCallId: id,
      toolName: "exec",
      isError: false,
      content: [
        { type: "text", text: `$ make build\n${"compiling...\n".repeat(5_000)}BUILD OK in 41s` },
      ],
    });
    const msgs = [1, 2, 3, 4, 5, 6].flatMap((i) => [user(`q${i}`), call(`c${i}`), log(`c${i}`)]);
    const r = evictOldToolResults(msgs, 50_000);
    const first = r.messages![2] as unknown as {
      toolCallId: string;
      content: Array<{ text: string }>;
    };
    expect(first.toolCallId).toBe("c1");
    // Exactly the shared marker, so the recall side parses one format.
    expect(first.content).toEqual([
      { type: "text", text: renderToolResultEvictionMarker({ ...log("c1") }) },
    ]);
    expect(first.content[0].text).toContain('"$ make build"');
    expect(first.content[0].text).toContain('"BUILD OK in 41s"');
    expect(first.content[0].text).toContain('recall({"id":"c1"})');
  });

  it("is idempotent: a second pass over its own markers evicts nothing new", () => {
    // The hot tail alone (3 x 30k) keeps the desk over the 80% trigger after the old output goes,
    // so the second pass runs its loop and must find nothing left worth evicting.
    const msgs = [
      ...[1, 2, 3].flatMap((i) => turn(i, 15_000)),
      ...[4, 5, 6].flatMap((i) => turn(i, 30_000)),
    ];
    const once = evictOldToolResults(msgs, 100_000);
    expect(once.evicted).toBe(3);
    const twice = evictOldToolResults(once.messages!, 100_000);
    expect(twice.messages).toBeNull();
  });

  it("never touches the last three turns or small outputs", () => {
    const msgs = [...turn(1, 50), ...[2, 3, 4].flatMap((i) => turn(i, 30_000))];
    expect(evictOldToolResults(msgs, 100_000).messages).toBeNull();
  });

  it("can be switched off", () => {
    process.env["ENGRAM_TOOL_EVICTION"] = "0";
    const msgs = [1, 2, 3, 4, 5, 6].flatMap((i) => turn(i, 15_000));
    expect(evictOldToolResults(msgs, 100_000).messages).toBeNull();
  });
});
