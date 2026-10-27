import { describe, expect, it } from "vitest";
import {
  applyTap,
  buildHumorBlock,
  extractSpokenLine,
  jokesOff,
  lastTurnReplyText,
  reactionTo,
} from "../src/spoken-line.js";

describe("the spoken line (J7 v4.9 §9, 2026-10-01)", () => {
  it("finds the purple line in a reply", () => {
    expect(extractSpokenLine("**Jarvis:** *Four hours, one comma.*\n\nThe fix is in.")).toBe(
      "Four hours, one comma.",
    );
    expect(extractSpokenLine("No purple line here.")).toBeUndefined();
    expect(extractSpokenLine(undefined)).toBeUndefined();
  });

  it("reads explicit reactions; 'not funny' wins over 'funny'", () => {
    expect(reactionTo("hahaha good one")).toBe("laughed");
    expect(reactionTo("jajaja")).toBe("laughed");
    expect(reactionTo("😂 ok now fix the build")).toBe("laughed");
    expect(reactionTo("that was not funny")).toBe("not-funny");
    expect(reactionTo("please, no jokes today")).toBe("not-funny");
    expect(reactionTo("Ok, what about your humor?")).toBe("no-reaction");
  });

  it("switches jokes off when he is frustrated or rushed, not on ordinary messages", () => {
    expect(jokesOff("it's still not working!!")).toBe(true);
    expect(jokesOff("again it doesn't show the button")).toBe(true);
    expect(jokesOff("nope.")).toBe(true);
    expect(jokesOff("WHY IS THIS BROKEN AGAIN")).toBe(true);
    expect(jokesOff("Ok, what about your humor? Revise the J7 paper and the TTS API")).toBe(false);
    expect(jokesOff("Keep improving Jev's prompts")).toBe(false);
  });

  it("collects the previous turn's assistant text across tool calls, and takes its last purple line", () => {
    const msgs = [
      { role: "user", content: "old" },
      { role: "assistant", content: [{ type: "text", text: "**Jarvis:** *Old line.*" }] },
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading the file." },
          { type: "toolCall", id: "1" },
        ],
      },
      { role: "toolResult", content: [{ type: "text", text: "ok" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "**Jarvis:** *Fixed. The comma confessed.*\n\nDetails." }],
      },
    ];
    const text = lastTurnReplyText(msgs);
    expect(text).not.toContain("Old line");
    expect(extractSpokenLine(text)).toBe("Fixed. The comma confessed.");
    expect(lastTurnReplyText(undefined)).toBeUndefined();
  });

  it("the block says whether a joke is welcome and lists recent lines with reactions", () => {
    const off = buildHumorBlock({ jokesOff: true, recent: [] });
    expect(off).toMatch(/NO JOKE/);
    const on = buildHumorBlock({
      jokesOff: false,
      recent: [{ ts: 1, sessionKey: "k", line: "Four hours, one comma.", reaction: "laughed" }],
    });
    expect(on).toMatch(/one line in three/);
    expect(on).toContain('"Four hours, one comma." → he laughed');
  });
});

// Real prompt shapes from the 2026-10-01 … 10-09 transcripts. The gateway stamps every prompt, the chat appended the
// Fractal doctrine to his prompts from 10-01 to 10-08, and agents, jobs and the gateway write turns of their own.
const STAMP = "[Thu 2026-10-01 05:21 GMT+2] ";
/** The appended doctrine, verbatim up to the sentence that tripped the gate on 619 of 619 armed prompts (J7 §8). */
const DOCTRINE =
  "\n\n---\n\n**After your reply, append a 🌿 FRACTAL reflection section** on its own line (blank line before it). This is the doctrine that governs it:\n\n## Who Fractal is\n\nThe main turn is the fast thinker: it does the work. Fractal is the slow thinker in the shadows:\nafter the work is done, it asks what the work _meant_ — what it taught, what it broke, what should\nnever happen again — and it leaves **durable change on disk**, not commentary. ";
const AGENT_TURNS = [
  `[Fri 2026-10-09 13:10 GMT+2] ⟦AGENT:🌿 Fractal · prompt 174⟧ The turn above is finished. This is its Fractal reflection: a turn of its own, with every tool.${DOCTRINE}`,
  "[Fri 2026-10-09 11:07 GMT+2] [System] The gateway restarted and interrupted your previous turn. Resume it, and make the resume legible to the user:\n1. ORIENT FIRST — post one short message (1-3 sentences) stating where you are picking up.",
  'Sender (untrusted metadata):\n```json\n{\n  "label": "longjob (webchat-ui)",\n  "id": "webchat-ui"\n}\n```\n\n[Wed 2026-10-07 08:12 GMT+2] ⟦AGENT:⏳ Longjob · build finished⟧ [longjob] build finished, exit 0',
  "[Fri 2026-10-09 08:33 GMT+2] <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nOpenClaw runtime context (internal):\nThis context is runtime-generated, not user-authored. Keep internal details private.",
  "[Wed 2026-09-30 06:30 GMT+2] 🤖 [longjob] second model-rank-refresh run ended (exit 0 = ok, 1 = error).",
  "[Thu 2026-10-01 20:10 GMT+2] ⟦AGENT:⏱ Background⟧ Background task: “tests” completed. The answer below is the one the worker gave on its own. [bg-turn bgt-1a2b]",
];

describe("his words only (J7 §8, 2026-10-09)", () => {
  it("the stamp and the appended doctrine never switch jokes off; his own frustration still does", () => {
    expect(jokesOff(`${STAMP}Keep improving Jev's prompts${DOCTRINE}`)).toBe(false);
    // The stamp's GMT was the third capital word.
    expect(jokesOff(`${STAMP}check the MSI DNS entry`)).toBe(false);
    expect(jokesOff(`${STAMP}it's still not working!!${DOCTRINE}`)).toBe(true);
  });

  it("a turn an agent, a job or the gateway wrote is unobserved, never his reaction", () => {
    for (const p of AGENT_TURNS) {
      expect(reactionTo(p)).toBe("unobserved");
      expect(jokesOff(p)).toBe(false);
    }
    expect(reactionTo(`${STAMP}hahaha ok, next${DOCTRINE}`)).toBe("laughed");
    expect(reactionTo(`${STAMP}that was not funny`)).toBe("not-funny");
  });

  it("the block names an unobserved line as one he never saw", () => {
    const block = buildHumorBlock({
      jokesOff: false,
      recent: [{ ts: 1, sessionKey: "k", line: "Done.", reaction: "unobserved" }],
    });
    expect(block).toContain('"Done." → unobserved');
  });

  // 2026-10-10 (plan Phase 1.4): the chips on the purple line write the outcome for that line's row.
  it("applyTap updates the matching row in that chat only, or appends one", () => {
    const rows = [
      {
        ts: 1,
        sessionKey: "agent:main:tinker:a",
        line: "Same line.",
        reaction: "no-reaction" as const,
      },
      {
        ts: 2,
        sessionKey: "agent:main:tinker:b",
        line: "Same line.",
        reaction: "no-reaction" as const,
      },
    ];
    const hit = applyTap(rows, {
      sessionKey: "agent:main:tinker:b",
      line: "Same line.",
      reaction: "laughed",
      now: 9,
    });
    expect(hit.rows).toHaveLength(2);
    expect(hit.rows[0]).toBe(rows[0]);
    expect(hit.rows[1]).toEqual({
      ts: 2,
      sessionKey: "agent:main:tinker:b",
      line: "Same line.",
      reaction: "laughed",
      reactionSource: "tap",
      isJoke: true,
    });
    const miss = applyTap(rows, {
      sessionKey: "agent:main:tinker:c",
      line: "New line.",
      reaction: "neutral",
      now: 9,
    });
    expect(miss.rows).toHaveLength(3);
    expect(miss.row).toEqual({
      ts: 9,
      sessionKey: "agent:main:tinker:c",
      line: "New line.",
      reaction: "neutral",
      reactionSource: "tap",
    });
  });

  it("the block marks judged lines joke or plain and words the taps", () => {
    const block = buildHumorBlock({
      jokesOff: false,
      recent: [
        {
          ts: 1,
          sessionKey: "k",
          line: "A.",
          reaction: "laughed",
          reactionSource: "tap",
          isJoke: true,
        },
        { ts: 2, sessionKey: "k", line: "B.", reaction: "no-reaction", isJoke: false },
        { ts: 3, sessionKey: "k", line: "C.", reaction: "neutral" },
      ],
    });
    expect(block).toContain('- "A." (a joke) → he laughed');
    expect(block).toContain('- "B." (plain) → no reaction');
    expect(block).toContain('- "C." → he tapped neutral');
  });

  it("at frequency max the personality is always on, with no quota, never when jokes are off", () => {
    expect(buildHumorBlock({ jokesOff: false, recent: [], frequency: "max" })).toContain(
      "no quota and no schedule",
    );
    expect(buildHumorBlock({ jokesOff: false, recent: [] })).toContain("one line in three");
    expect(buildHumorBlock({ jokesOff: true, recent: [], frequency: "max" })).toContain("NO JOKE");
  });
});
