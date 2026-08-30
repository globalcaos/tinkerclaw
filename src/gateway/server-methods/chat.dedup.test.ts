import { afterEach, describe, expect, it, vi } from "vitest";
import { projectRecentChatDisplayMessages } from "../chat-display-projection.js";
import { MAX_LIVE_CHAT_BUFFER_CHARS, resolveMergedAssistantText } from "../live-chat-projector.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createToolEventRecipientRegistry,
  isLiveChatBufferReplaced,
} from "../server-chat.js";
import { augmentChatHistoryWithCanvasBlocks } from "./chat.js";

// FORK 2026-08-05: this file used to guard `dedupeServedAssistantAnswers`, the content-based
// serve-boundary dedup in chat.ts. THAT FUNCTION IS GONE, and the suite is inverted.
//
// What it did: dropped any assistant message whose normalized text was a strict PREFIX of any
// other assistant message anywhere in the session — earlier OR LATER, because the double loop
// was `for i: for j`, not `j < i` — and additionally dropped the LONGER message whenever it
// ENDED WITH a shorter one. Measured on the real store for agent:main:tinker:ms39dshj it deleted
// 19 of 59 assistant messages (32%), one of them killed by a message 13 positions LATER.
// `loadChat` consumed the result, so it was permanent, silent deletion from screen. The case
// that used to sit under "intentional trade-off (documented behavior, not a bug)" was asserting
// exactly that data loss; it is now the headline regression test below.
//
// New contract, pinned here: chat.history serves the PROJECTED history VERBATIM and IN ORDER,
// with nothing dropped on content. Tests run the real serve pipeline
// (`augmentChatHistoryWithCanvasBlocks(projectRecentChatDisplayMessages(...))`, the exact
// composition chat.history uses) rather than an identity stub, so they would actually catch a
// re-introduced filter anywhere in that path.
//
// The duplicate text the dedup was papering over is fixed at its SOURCE — the live-delta
// buffer-replace signal in server-chat.ts — covered by the second describe block.

const a = (text: string): unknown => ({ role: "assistant", content: [{ type: "text", text }] });
const aString = (text: string): unknown => ({ role: "assistant", content: text });
const u = (text: string): unknown => ({ role: "user", content: [{ type: "text", text }] });

const LONG_A = "The CF wall got solved with curl_cffi, so the brain publish is unblocked now.";
const LONG_B = "The auto-allocator routed this tab to OpenAI gpt-5.5, which is out of quota.";

/** The exact transform chat.history applies before byte budgeting. */
const serve = (messages: unknown[]): unknown[] =>
  augmentChatHistoryWithCanvasBlocks(
    projectRecentChatDisplayMessages(messages, { maxChars: 100_000, maxMessages: 1_000 }),
  );

const assistantTexts = (messages: unknown[]): string[] =>
  messages
    .filter(
      (m): m is Record<string, unknown> =>
        Boolean(m) && typeof m === "object" && (m as { role?: unknown }).role === "assistant",
    )
    .map((m) => {
      const content = m.content;
      if (typeof content === "string") {
        return content;
      }
      if (!Array.isArray(content)) {
        return "";
      }
      return content
        .map((block) =>
          block &&
          typeof block === "object" &&
          typeof (block as { text?: unknown }).text === "string"
            ? (block as { text: string }).text
            : "",
        )
        .join("");
    });

describe("chat.history serves assistant answers verbatim (no content dedup)", () => {
  // THE INVERTED CASE. This fixture previously asserted `[short, long] -> [long]` under an
  // "intentional trade-off" heading. A genuine answer that happens to be a strict prefix of a
  // later, fuller one is a real answer, and deleting it is silent data loss. It must SURVIVE.
  it("keeps a genuine answer that is a strict prefix of a later, fuller one", () => {
    const short = "Here is the plan to fix the duplicate-answers rendering bug now.";
    const long = `${short} Step one: add a serve-boundary dedup pass.`;
    expect(assistantTexts(serve([a(short), a(long)]))).toEqual([short, long]);
  });

  it("keeps the same answer when the fuller one comes FIRST", () => {
    const short = "Let me read the merge layer directly to confirm the prefix dedup case.";
    const long = `${short} Found it: lines 128-135 already handle it.`;
    expect(assistantTexts(serve([a(long), a(short)]))).toEqual([long, short]);
  });

  // The forward-looking kill: the old loop scanned the WHOLE list, so a message could be deleted
  // by one appearing far LATER. Worst measured case in the real store was 13 positions.
  it("keeps an answer even when a message 13 positions LATER starts with it", () => {
    const victim = "Comprovo l'origen de cada candidat i busco un canal de contacte.";
    const later = `${victim} He trobat el canal i ja he enviat el missatge.`;
    const filler = Array.from({ length: 12 }, (_, i) =>
      a(`Interim step ${i} of the investigation, written out at length.`),
    );
    const out = assistantTexts(serve([a(victim), ...filler, a(later)]));
    expect(out).toHaveLength(14);
    expect(out[0]).toBe(victim);
    expect(out.at(-1)).toBe(later);
  });

  // The old `endsWith` rule dropped the LONGER message. Both must survive now.
  it("keeps a coalesced blob and the shorter answer that is its tail — both orders", () => {
    const answer =
      "Done — the taskbar icon now boots Windows with the DRIVERS disc attached and verified.";
    const blob = `On it — finding the taskbar launcher to add the flag.${answer}`;
    expect(assistantTexts(serve([a(blob), a(answer)]))).toEqual([blob, answer]);
    expect(assistantTexts(serve([a(answer), a(blob)]))).toEqual([answer, blob]);
  });

  it("keeps repeated identical answers — asking twice and getting the same reply is legal", () => {
    const out = serve([u("first prompt"), a(LONG_A), u("ask me that again"), a(LONG_A)]);
    expect(out).toHaveLength(4);
    expect(assistantTexts(out)).toEqual([LONG_A, LONG_A]);
  });

  it("keeps three copies of the same answer", () => {
    expect(assistantTexts(serve([a(LONG_A), a(LONG_A), a(LONG_A)]))).toEqual([
      LONG_A,
      LONG_A,
      LONG_A,
    ]);
  });

  it("keeps the same text served in string and block content shapes as two rows", () => {
    expect(assistantTexts(serve([aString(LONG_B), a(LONG_B)]))).toEqual([LONG_B, LONG_B]);
  });

  it("preserves order and count across a realistic transcript", () => {
    const out = serve([u("p1"), a(LONG_A), u("p2"), a(LONG_B), u("p3"), a(LONG_A)]);
    expect(out).toHaveLength(6);
    expect(assistantTexts(out)).toEqual([LONG_A, LONG_B, LONG_A]);
  });

  // Retained and strengthened from the previous suite's "never over-collapses" block.
  it("keeps two distinct answers that share a long prefix but diverge", () => {
    const shared = "Here is the detailed implementation plan for the dedup fix today: ";
    const first = `${shared}first we add a serve-boundary pass.`;
    const second = `${shared}instead we harden the merge layer.`;
    expect(assistantTexts(serve([a(first), a(second)]))).toEqual([first, second]);
  });

  it("never drops user messages — distinct prompts and repeats both survive", () => {
    const long = "Please keep going and also append a fractal reflection at the very end.";
    expect(serve([u(long), u(long), u("ok"), u("ok do it")])).toHaveLength(4);
  });

  it("is a no-op for an empty history", () => {
    expect(serve([])).toEqual([]);
  });

  it("no longer exports dedupeServedAssistantAnswers", async () => {
    const mod = await import("./chat.js");
    expect(Object.keys(mod)).not.toContain("dedupeServedAssistantAnswers");
  });
});

// FORK 2026-08-05 (duprep): the real reason repeated text reached the front end. Chat delta
// events carry the SERVER-CUMULATIVE buffer and the client slices it with integer cursors, so a
// buffer re-base silently invalidates every cursor and the client re-renders text it already
// showed. `isLiveChatBufferReplaced` is what server-chat.ts uses to say so explicitly.
describe("live chat buffer replace signal", () => {
  it("is false on the first delta of a run (no previous buffer)", () => {
    expect(isLiveChatBufferReplaced("", "Fresh start with no previous buffer at all.")).toBe(false);
  });

  it("is false for an ordinary prefix-extension", () => {
    expect(isLiveChatBufferReplaced("The answer is", "The answer is 42.")).toBe(false);
  });

  it("is false for the delta-append path across a tool call", () => {
    const merged = resolveMergedAssistantText({
      previousText: "Before tool call",
      nextText: "After tool call",
      nextDelta: "\nAfter tool call",
    });
    expect(merged).toBe("Before tool call\nAfter tool call");
    expect(isLiveChatBufferReplaced("Before tool call", merged)).toBe(false);
  });

  it("is false when a stale shorter snapshot is ignored and the buffer is kept", () => {
    const previous = "Hello world";
    const merged = resolveMergedAssistantText({
      previousText: previous,
      nextText: "Hello",
      nextDelta: "",
    });
    expect(merged).toBe(previous);
    expect(isLiveChatBufferReplaced(previous, merged)).toBe(false);
  });

  // The reset branch: this is what the agent stream produces when it decides the text is a
  // replacement (embedded-agent-subscribe.handlers.messages.ts clears the delta on replace), and
  // it is the shape that made cc-bridge narration render on top of the answer.
  it("is true when a non-prefix snapshot resets the whole buffer", () => {
    const previous = "The answer is 42.";
    const merged = resolveMergedAssistantText({
      previousText: previous,
      nextText: "On it — computing.The answer is 42.",
      nextDelta: "",
    });
    expect(merged).toBe("On it — computing.The answer is 42.");
    expect(isLiveChatBufferReplaced(previous, merged)).toBe(true);
  });

  // No upstream flag can announce this one — only the gateway knows it re-based the buffer.
  it("is true when the 500k cap tail-slices the buffer", () => {
    const previous = "a".repeat(MAX_LIVE_CHAT_BUFFER_CHARS - 2);
    const merged = resolveMergedAssistantText({
      previousText: previous,
      nextText: "",
      nextDelta: "bbbb",
    });
    expect(merged).toHaveLength(MAX_LIVE_CHAT_BUFFER_CHARS);
    expect(isLiveChatBufferReplaced(previous, merged)).toBe(true);
  });
});

// End-to-end: the flag must actually reach the wire, not just the predicate. This drives the
// REAL agent event handler, so it fails if the payload spread is dropped in a future refactor.
// No vi.mock needed: shouldHideHeartbeatChatOutput early-returns false for a non-heartbeat run
// (server-chat.ts:56-58), so nothing here reads the runtime config.
describe("chat delta events carry the replace flag on a buffer re-base", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** emitChatDelta throttles at 150 ms against Date.now, so the clock must be steerable. */
  const createHarness = (startNow: number) => {
    let now = startNow;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const broadcast = vi.fn();
    const chatRunState = createChatRunState();
    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds: vi.fn(),
      nodeSendToSession: vi.fn(),
      agentRunSeq: new Map<string, number>(),
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
      toolEventRecipients: createToolEventRecipientRegistry(),
      sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    });
    chatRunState.registry.add("run-1", { sessionKey: "session-1", clientRunId: "client-1" });
    let seq = 0;
    return {
      advance: (ms: number) => {
        now += ms;
      },
      emitAssistantText: (text: string) => {
        seq += 1;
        handler({ runId: "run-1", seq, stream: "assistant", ts: now, data: { text } });
      },
      deltaPayloads: () =>
        broadcast.mock.calls
          .filter((call) => call[0] === "chat")
          .map((call) => call[1] as { state?: string; replace?: unknown }),
    };
  };

  it("omits `replace` on an ordinary prefix-extension and sets it on a reset", () => {
    const h = createHarness(1_000_000);

    h.emitAssistantText("The answer is");
    h.advance(200);
    h.emitAssistantText("The answer is 42.");
    h.advance(200);
    // Not a prefix-extension of the buffer and no delta → resolveMergedAssistantText RESETS.
    h.emitAssistantText("On it — computing.The answer is 42.");

    const payloads = h.deltaPayloads();
    expect(payloads).toHaveLength(3);
    expect(payloads.every((p) => p.state === "delta")).toBe(true);
    // Ordinary extensions must not carry the field at all — absent, not `false`.
    expect(payloads[0]).not.toHaveProperty("replace");
    expect(payloads[1]).not.toHaveProperty("replace");
    expect(payloads[2]?.replace).toBe(true);
  });

  it("still reports a reset that landed inside the 150 ms throttle window", () => {
    const h = createHarness(2_000_000);

    h.emitAssistantText("The answer is 42.");
    // Same millisecond: the throttle drops this event before any payload is built. The reset it
    // carried must NOT be lost — that is why pendingDeltaReplace is sticky.
    h.emitAssistantText("On it — computing.The answer is 42.");
    expect(h.deltaPayloads()).toHaveLength(1);

    h.advance(200);
    h.emitAssistantText("On it — computing.The answer is 42. Done.");

    const payloads = h.deltaPayloads();
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).not.toHaveProperty("replace");
    expect(payloads[1]?.replace).toBe(true);
  });
});
