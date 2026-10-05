import { describe, expect, it } from "vitest";
import { createBlockKeyTracker, keysForAssistantFrame } from "./stream.js";

// FORK 2026-09-24 (the architect: "in nearly every thinking message, in the AI analysis
// tab, the messages show twice"). Opus 5.5 at effort xhigh answers with TWO
// thinking blocks in one API message: an empty, signature-only block, then a
// narration block that carries the visible text. Receipt — claude-cli
// transcript 68da72bf, message msg_011CfMdii8Z7CRd328oUh4uJ:
//   apiBlockIndex 0 = thinking "" (signed) · apiBlockIndex 1 = thinking "I see
//   the issue now…\n\n" (signed) · then tool_use. 17 of that turn's 30 thinking
//   messages had this shape, and every one rendered as "X\n\nX".
//
// claude-cli writes one `assistant` frame PER BLOCK, right after that block's
// deltas and before its content_block_stop (captured live 2026-09-24:
// start(0) → thinking_delta(0) → signature_delta(0) → assistant[thinking] →
// stop(0) → start(1) …). Counting the type-scoped ordinal inside each frame
// made both one-block frames `thinking:0`, so the narration's frame was matched
// against the EMPTY block (prev "") and the whole text was pushed a second
// time on top of what the delta path had already streamed under `thinking:1`.
// The bridge's accumulated thinking — what the gateway persists and what the
// UI's reasoning bubble shows — became "X\n\nX\n\nY\n\nY…".

const MSG = "msg_011CfMdii8Z7CRd328oUh4uJ";
const MSG2 = "msg_011CfMdii8Z7CRd328oUh4uK";
const NARRATION =
  "I see the issue now—last night's changes went to the Tinker UI instead of the " +
  "live page. I'll check the publishing note to figure out how to export and push " +
  "them to the public site.\n\n";
const NARRATION2 =
  "I found that last night's update rebuilt only the Tinker UI but skipped " +
  "re-publishing to the website.\n\n";

/**
 * Both ingest paths of stream.ts over the REAL key tracker and the REAL frame
 * keying, with the handler's own bookkeeping: the delta path appends to the
 * block's seen text; the cumulative arm pushes `cumulative.slice(prev.length)`
 * only when `cumulative.length > prev.length && cumulative.startsWith(prev)`.
 */
function makeIngest() {
  const keys = createBlockKeyTracker();
  const thinkingSeen = new Map<string, string>();
  const textSeen = new Map<string, string>();
  let thinking = "";
  let text = "";
  const extend = (seen: Map<string, string>, key: string, cumulative: string): string => {
    const prev = seen.get(key) ?? "";
    if (cumulative.length > prev.length && cumulative.startsWith(prev)) {
      seen.set(key, cumulative);
      return cumulative.slice(prev.length);
    }
    return "";
  };
  return {
    startMessage: (id: string) => keys.noteMessage(id),
    blockStart: (index: number, type: string) => keys.noteBlockStart(index, type),
    deltaThinking(index: number, delta: string): void {
      const key = keys.keyForStreamIndex(index, "thinking");
      thinking += delta;
      thinkingSeen.set(key, (thinkingSeen.get(key) ?? "") + delta);
    },
    deltaText(index: number, delta: string): void {
      const key = keys.keyForStreamIndex(index, "text");
      text += delta;
      textSeen.set(key, (textSeen.get(key) ?? "") + delta);
    },
    frame(id: string, blocks: Array<{ type: string; thinking?: string; text?: string }>): void {
      keys.noteMessage(id);
      const frameKeys = keysForAssistantFrame(keys, blocks);
      blocks.forEach((b, i) => {
        if (b.type === "thinking" && typeof b.thinking === "string") {
          thinking += extend(thinkingSeen, frameKeys[i], b.thinking);
        } else if (b.type === "text" && typeof b.text === "string") {
          text += extend(textSeen, frameKeys[i], b.text);
        }
      });
    },
    thinking: () => thinking,
    text: () => text,
    keys,
  };
}

/** One Opus 5.5 tool step as claude-cli streams it in partial mode. */
function streamNarratedToolStep(
  ingest: ReturnType<typeof makeIngest>,
  id: string,
  narration: string,
) {
  ingest.startMessage(id);
  ingest.blockStart(0, "thinking");
  ingest.deltaThinking(0, "");
  ingest.deltaThinking(0, "");
  ingest.frame(id, [{ type: "thinking", thinking: "" }]);
  ingest.blockStart(1, "thinking");
  ingest.deltaThinking(1, narration.slice(0, 50));
  ingest.deltaThinking(1, narration.slice(50));
  ingest.frame(id, [{ type: "thinking", thinking: narration }]);
  ingest.blockStart(2, "tool_use");
  ingest.frame(id, [{ type: "tool_use" }]);
}

describe("two thinking blocks in one message (Opus 5.5 narration) stream ONCE", () => {
  it("does not re-push the narration block from its own assistant frame", () => {
    const ingest = makeIngest();
    streamNarratedToolStep(ingest, MSG, NARRATION);
    expect(ingest.thinking()).toBe(NARRATION);
  });

  it("keeps a whole tool loop at one copy per thought (the persisted X\\n\\nX shape)", () => {
    const ingest = makeIngest();
    streamNarratedToolStep(ingest, MSG, NARRATION);
    streamNarratedToolStep(ingest, MSG2, NARRATION2);
    expect(ingest.thinking()).toBe(NARRATION + NARRATION2);
  });

  it("keys a one-block frame to the block the delta path streamed last of that kind", () => {
    const ingest = makeIngest();
    ingest.startMessage(MSG);
    ingest.blockStart(0, "thinking");
    ingest.frame(MSG, [{ type: "thinking", thinking: "" }]);
    ingest.blockStart(1, "thinking");
    ingest.deltaThinking(1, NARRATION);
    expect(keysForAssistantFrame(ingest.keys, [{ type: "thinking" }])).toEqual([
      `${MSG}:thinking:1`,
    ]);
  });

  it("still lets the frame extend a narration block the deltas cut short", () => {
    const ingest = makeIngest();
    ingest.startMessage(MSG);
    ingest.blockStart(0, "thinking");
    ingest.frame(MSG, [{ type: "thinking", thinking: "" }]);
    ingest.blockStart(1, "thinking");
    ingest.deltaThinking(1, NARRATION.slice(0, 30));
    ingest.frame(MSG, [{ type: "thinking", thinking: NARRATION }]);
    expect(ingest.thinking()).toBe(NARRATION);
  });

  it("a text block after the two thinking blocks streams once too", () => {
    const ingest = makeIngest();
    const answer = "Publishing now.";
    ingest.startMessage(MSG);
    ingest.blockStart(0, "thinking");
    ingest.frame(MSG, [{ type: "thinking", thinking: "" }]);
    ingest.blockStart(1, "thinking");
    ingest.deltaThinking(1, NARRATION);
    ingest.frame(MSG, [{ type: "thinking", thinking: NARRATION }]);
    ingest.blockStart(2, "text");
    ingest.deltaText(2, answer);
    ingest.frame(MSG, [{ type: "text", text: answer }]);
    expect(ingest.thinking()).toBe(NARRATION);
    expect(ingest.text()).toBe(answer);
  });

  it("without stream events (no partial messages) each block still lands once", () => {
    const ingest = makeIngest();
    ingest.frame(MSG, [{ type: "thinking", thinking: "" }]);
    ingest.frame(MSG, [{ type: "thinking", thinking: NARRATION }]);
    expect(ingest.thinking()).toBe(NARRATION);
  });
});
