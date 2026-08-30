import { describe, expect, it } from "vitest";
import { createBlockKeyTracker } from "./stream.js";

// FORK 2026-08-25 (the architect: "the original chat of this cloned tab just swallowed
// intermediate thinking text").
//
// A content-block `index` is unique only within ONE assistant message, but the
// bridge kept its per-block accumulators (and its bubble-break decision) keyed
// on the bare index for the whole turn. claude-cli emits each tool-loop step as
// its own message with indices restarting at 0, so two consecutive narrations
// collided on key 0. Observed verbatim in the rendered chat:
//   "…Waiting for it to finish before merging.488 species researched…"
// — two separate messages glued into one bubble with no separator, and on the
// cumulative path the second was dropped entirely (it does not prefix the first).
//
// The shape below is a real opus-5 stream, captured 2026-08-25.
const LIVE_STREAM = [
  {
    msg: "msg_011CePb5h9nPdkKB",
    blocks: [
      { index: 0, type: "thinking" },
      { index: 1, type: "text" },
      { index: 2, type: "tool_use" },
    ],
  },
  {
    msg: "msg_011CePb64MzYJ696",
    blocks: [
      { index: 0, type: "text" },
      { index: 1, type: "tool_use" },
    ],
  },
  { msg: "msg_011CePb6D3dLDCWU", blocks: [{ index: 0, type: "text" }] },
];

const textKeys = (): string[] => {
  const t = createBlockKeyTracker();
  const keys: string[] = [];
  for (const m of LIVE_STREAM) {
    t.noteMessage(m.msg);
    for (const b of m.blocks) {
      if (b.type === "text") {
        keys.push(t.keyFor(b.index));
      }
    }
  }
  return keys;
};

describe("createBlockKeyTracker (swallowed intermediate text)", () => {
  it("gives every message's text block its own key, even when indices repeat", () => {
    const keys = textKeys();
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
  });

  it("does NOT collide the two index-0 text blocks that used to fuse", () => {
    // msg2 and msg3 both put their prose at index 0 — the exact collision that
    // glued two narrations together and swallowed one of them.
    const keys = textKeys();
    expect(keys[1]).not.toBe(keys[2]);
  });

  it("keeps one message's blocks distinct from each other", () => {
    const t = createBlockKeyTracker();
    t.noteMessage("msg_a");
    expect(t.keyFor(0)).not.toBe(t.keyFor(1));
  });

  it("is stable across repeated notes of the SAME message (cumulative re-emits)", () => {
    // The cumulative `assistant` line re-announces a message already seen via
    // message_start. Re-noting it must not shift the key, or a block's own
    // accumulated text would be orphaned mid-stream.
    const t = createBlockKeyTracker();
    t.noteMessage("msg_a");
    const first = t.keyFor(1);
    t.noteMessage("msg_a");
    expect(t.keyFor(1)).toBe(first);
  });

  it("ignores a missing or non-string id rather than opening a bogus block", () => {
    const t = createBlockKeyTracker();
    t.noteMessage("msg_a");
    const before = t.keyFor(0);
    t.noteMessage(undefined);
    t.noteMessage(42);
    t.noteMessage("");
    expect(t.keyFor(0)).toBe(before);
  });
});
