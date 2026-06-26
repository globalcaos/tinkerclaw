import { describe, expect, it } from "vitest";
import { dedupeServedAssistantAnswers } from "./chat.js";

// FORK 2026-06-24: regression guard for the Tinker "repeating answers" bug. chat.history serves
// `rawMessages` = local store merged with the cc-bridge CLI-session JSONL, which floods duplicate
// answers when a heavily-compacted session loses the local anchors the merge dedup relies on.
// `dedupeServedAssistantAnswers` is the content-based, timestamp-independent serve-boundary guard.
// This bug has regressed multiple times; these cases pin the contract so a future merge that strips
// the call or breaks the logic fails CI instead of shipping duplicated answers.

const a = (text: string): unknown => ({ role: "assistant", content: text });
const aBlocks = (...texts: string[]): unknown => ({
  role: "assistant",
  content: texts.map((t) => ({ type: "text", text: t })),
});
const u = (text: string): unknown => ({ role: "user", content: text });
const toolOnly = (): unknown => ({
  role: "assistant",
  content: [{ type: "tool_use", name: "x", input: {} }],
});

// A 50-char floor mirrors merge.ts LONG_TEXT_DEDUP_MIN_LEN; fixtures stay comfortably above it.
const LONG_A = "The CF wall got solved with curl_cffi, so the brain publish is unblocked now.";
const LONG_B = "The auto-allocator routed this tab to OpenAI gpt-5.5, which is out of quota.";

describe("dedupeServedAssistantAnswers", () => {
  describe("dedups duplicated answers (the bug)", () => {
    it("drops an exact-duplicate assistant answer, keeping the first occurrence", () => {
      const q1 = u("first prompt"),
        q2 = u("second prompt");
      const first = a(LONG_A),
        dup = a(LONG_A);
      const out = dedupeServedAssistantAnswers([q1, first, q2, dup]);
      expect(out).toEqual([q1, first, q2]); // the later copy is gone, order preserved
      expect(out).toContain(first);
    });

    it("collapses three copies of the same answer to one", () => {
      const out = dedupeServedAssistantAnswers([a(LONG_A), a(LONG_A), a(LONG_A)]);
      expect(out).toHaveLength(1);
    });

    it("drops a short prefix echo of a fuller answer — echo BEFORE full", () => {
      const echo = "Let me read the merge layer directly to confirm the prefix dedup case.";
      const full = `${echo} Found it: lines 128-135 already handle it.`;
      expect(dedupeServedAssistantAnswers([a(echo), a(full)])).toEqual([a(full)]);
    });

    it("drops a short prefix echo of a fuller answer — full BEFORE echo", () => {
      const echo = "Let me read the merge layer directly to confirm the prefix dedup case.";
      const full = `${echo} Found it: lines 128-135 already handle it.`;
      expect(dedupeServedAssistantAnswers([a(full), a(echo)])).toEqual([a(full)]);
    });

    it("dedups across string and block content shapes", () => {
      expect(dedupeServedAssistantAnswers([a(LONG_B), aBlocks(LONG_B)])).toHaveLength(1);
    });

    it("coalesces multi-block assistant content before comparing", () => {
      const full = "This is a long coalesced assistant answer split across two text blocks here.";
      const out = dedupeServedAssistantAnswers([
        aBlocks("This is a long coalesced assistant answer ", "split across two text blocks here."),
        a(full),
      ]);
      expect(out).toHaveLength(1);
    });

    it("preserves order and removes only the duplicate copy in a realistic transcript", () => {
      const q1 = u("p1"),
        q2 = u("p2"),
        q3 = u("p3");
      const ansA = a(LONG_A),
        ansB = a(LONG_B);
      const out = dedupeServedAssistantAnswers([q1, ansA, q2, ansB, q3, a(LONG_A)]);
      expect(out).toEqual([q1, ansA, q2, ansB, q3]);
    });
  });

  describe("never over-collapses (must NOT dedup)", () => {
    it("keeps two distinct answers that share a >=50-char prefix but diverge", () => {
      const shared = "Here is the detailed implementation plan for the dedup fix today: ";
      const a1 = a(`${shared}first we add a serve-boundary pass.`);
      const a2 = a(`${shared}instead we harden the merge layer.`);
      expect(dedupeServedAssistantAnswers([a1, a2])).toEqual([a1, a2]);
    });

    it("keeps short repeated answers below the 50-char floor", () => {
      const out = dedupeServedAssistantAnswers([a("Done."), a("Done."), a("ok")]);
      expect(out).toHaveLength(3);
    });

    it("never dedups user messages — distinct prompts and repeats both survive", () => {
      const long = "Please keep going and also append a fractal reflection at the very end.";
      const out = dedupeServedAssistantAnswers([u(long), u(long), u("ok"), u("ok do it")]);
      expect(out).toHaveLength(4);
    });

    it("ignores assistant messages with no visible text (tool-only)", () => {
      expect(dedupeServedAssistantAnswers([toolOnly(), toolOnly()])).toHaveLength(2);
    });
  });

  describe("structural", () => {
    it("is a no-op for empty and single-message lists", () => {
      expect(dedupeServedAssistantAnswers([])).toEqual([]);
      const one = [a(LONG_A)];
      expect(dedupeServedAssistantAnswers(one)).toBe(one); // same array reference when nothing dropped
    });
  });

  describe("intentional trade-off (documented behavior, not a bug)", () => {
    it("collapses a genuine answer that is a strict prefix of a later, fuller one", () => {
      // Mirrors merge.ts LONG_TEXT_DEDUP_MIN_LEN: a >=50-char message that is a strict prefix of
      // another assistant message is treated as a narration echo and dropped. Accepted trade-off —
      // distinct answers are virtually never an exact whitespace-normalized prefix of each other.
      const short = "Here is the plan to fix the duplicate-answers rendering bug now.";
      const long = `${short} Step one: add a serve-boundary dedup pass.`;
      expect(dedupeServedAssistantAnswers([a(short), a(long)])).toEqual([a(long)]);
    });
  });
});
