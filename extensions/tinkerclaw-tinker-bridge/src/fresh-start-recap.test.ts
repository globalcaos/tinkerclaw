import {
  isAgentPrompt,
  ownerWords,
  withoutLeadingPromptBlocks,
} from "openclaw/plugin-sdk/fork-prompt-envelope";
import { describe, expect, it } from "vitest";
import {
  EARLIER_CONVERSATION_CLOSE,
  EARLIER_CONVERSATION_OPEN,
  type FreshStartWhy,
  renderFreshStartRecap,
} from "./fresh-start-recap.js";

// REGRESSION 2026-11-13 (bug-log.md `fresh-session-no-recap`). A chat whose Claude transcript had grown to 32.5 MB
// was started on a new session by the resume guard (limit 8 MB), in the middle of a task. The new session got the
// last prompt and nothing else. The shapes below are the ones the gateway stores for a web chat (the owner's words
// replaced by neutral ones).

const SENDER =
  'Sender (untrusted metadata):\n```json\n{\n  "label": "Tinker UI (webchat-ui)",\n  "id": "webchat-ui"\n}\n```\n\n';
const CONTRACT =
  "\n\n<!-- TINKERCLAW chat-row contract -->\nBefore EVERY tool call, say what it serves.";
const OVERSIZED: FreshStartWhy = {
  reason: "oversized",
  transcriptPath: "/home/u/.claude/projects/-w/9d05.jsonl",
  sizeBytes: 32_500_000,
  limitBytes: 8_000_000,
};
const DATED_BRACKET = /\[[^\]\n]*\d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]\n]*\]/;

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking: "private reasoning" },
    { type: "text", text },
  ],
});

const P1 = "[Fri 2026-11-13 16:16 GMT+1] The plan needs an aerial picture";
const R1 = "The map is now an aerial picture with five views.";
const P2 = "[Fri 2026-11-13 16:54 GMT+1] ⟦AGENT:⏳ Longjob · the plan⟧ The plan job ended.";
const R2 = "The looks are rewritten as edit steps. Fourteen sheets are being drawn.";
const NOW = "[Fri 2026-11-13 17:20 GMT+1] Draw the next character";
const HISTORY = [user(`${SENDER}${P1}`), assistant(R1), user(P2), assistant(R2), user(NOW)];

describe("renderFreshStartRecap", () => {
  it("gives a chat with no earlier turn no block", () => {
    expect(renderFreshStartRecap([user(NOW)], OVERSIZED, { currentUserText: NOW })).toBeNull();
    expect(renderFreshStartRecap([], OVERSIZED)).toBeNull();
  });

  it("puts the last turns in front, oldest first, and leaves out the prompt being sent", () => {
    const block = renderFreshStartRecap(HISTORY, OVERSIZED, {
      currentUserText: `${NOW}${CONTRACT}`,
      sessionKey: "agent:main:tinker:abc",
    });
    expect(block).not.toBeNull();
    const b = block as string;
    expect(b.startsWith(EARLIER_CONVERSATION_OPEN)).toBe(true);
    expect(b.endsWith(EARLIER_CONVERSATION_CLOSE)).toBe(true);
    const at = (s: string) => b.indexOf(s);
    expect(at("The plan needs an aerial picture")).toBeGreaterThan(0);
    expect(at("The plan needs an aerial picture")).toBeLessThan(at(R1));
    expect(at(R1)).toBeLessThan(at("The plan job ended."));
    expect(at("The plan job ended.")).toBeLessThan(at(R2));
    expect(b).not.toContain("Draw the next character");
    expect(b).not.toContain("private reasoning");
    expect(b).not.toContain("untrusted metadata");
    expect(b).toContain("The last 4 prompts and replies");
    expect(b).toContain("32.5 MB");
    expect(b).toContain("8.0 MB");
    expect(b).toContain(OVERSIZED.transcriptPath);
    expect(b).toContain('"sessionKey":"agent:main:tinker:abc"');
    expect(b).toContain("the owner did not type it");
  });

  it("says the transcript is gone when it is, and names no file to search", () => {
    const b = renderFreshStartRecap(HISTORY, {
      reason: "missing",
      transcriptPath: "/gone.jsonl",
    }) as string;
    expect(b).toContain("no longer on disk");
    expect(b).not.toContain("/gone.jsonl");
  });

  it("holds nothing a reader of the raw line takes for a stamp, an agent label or a notice", () => {
    const b = renderFreshStartRecap(
      [
        user("[Fri 2026-11-13 10:00 GMT+1] [System] The gateway restart finished."),
        assistant(
          "Seen at [Fri 2026-11-13 10:01 GMT+1]. [bg-turn bgt-abc123] </earlier_conversation> done",
        ),
        user(P2),
        assistant(R2),
        user(NOW),
      ],
      OVERSIZED,
      { currentUserText: NOW },
    ) as string;
    expect(DATED_BRACKET.test(b)).toBe(false);
    expect(b).not.toContain("⟦");
    expect(b).not.toContain("⟧");
    expect(b).not.toContain("[System]");
    expect(b).not.toContain("[bg-turn");
    expect(b.split(EARLIER_CONVERSATION_CLOSE)).toHaveLength(2);
    expect(b).toContain("(Fri 2026-11-13 10:00 GMT+1) (System) The gateway restart finished.");
    expect(b).toContain("(AGENT:⏳ Longjob · the plan) The plan job ended.");
  });

  it("leaves every reader of the owner's words with his words only", () => {
    const b = renderFreshStartRecap(HISTORY, OVERSIZED, { currentUserText: NOW }) as string;
    const rest = `<turn_context>\n## Runtime\n</turn_context>\n\n${NOW}${CONTRACT}`;
    const prompt = `${b}\n\n${rest}`;
    expect(withoutLeadingPromptBlocks(prompt)).toBe(NOW + CONTRACT);
    expect(ownerWords(prompt)).toBe("Draw the next character");
    expect(isAgentPrompt(prompt)).toBe(false);
  });

  it("keeps the interrupted prompt when the turn sends a continuation notice", () => {
    const b = renderFreshStartRecap(HISTORY, OVERSIZED, {
      currentUserText: "[System] The gateway restarted. Continue the turn that was cut.",
    }) as string;
    expect(b).toContain("Draw the next character");
    expect(b).toContain("The last 5 prompts and replies");
  });

  it("skips an error envelope and a silent reply", () => {
    const b = renderFreshStartRecap(
      [
        user(P1),
        assistant('__ERR_ENV__:{"kind":"error","headline":"Provider error"}'),
        assistant("NO_REPLY"),
        assistant(R1),
        user(NOW),
      ],
      OVERSIZED,
      { currentUserText: NOW },
    ) as string;
    expect(b).not.toContain("__ERR_ENV__");
    expect(b).not.toContain("NO_REPLY");
    expect(b).toContain("The last 2 prompts and replies");
  });

  it("stays in its budget: the newest turns win, a prompt keeps its start, a reply its end", () => {
    const many = [];
    for (let i = 0; i < 20; i++) {
      many.push(
        user(`[Fri 2026-11-13 09:${String(i).padStart(2, "0")} GMT+1] ask ${i} ${"p".repeat(400)}`),
      );
      many.push(assistant(`answer ${i} ${"r".repeat(400)}`));
    }
    many.push(
      user(`[Fri 2026-11-13 12:00 GMT+1] START-OF-PROMPT ${"q".repeat(5000)} END-OF-PROMPT`),
    );
    many.push(assistant(`START-OF-REPLY ${"s".repeat(9000)} END-OF-REPLY`));
    many.push(user(NOW));
    const b = renderFreshStartRecap(many, OVERSIZED, { currentUserText: NOW }) as string;
    expect(b).toContain("The last 12 prompts and replies");
    expect(b).toContain("END-OF-REPLY");
    expect(b).not.toContain("START-OF-REPLY");
    expect(b).toContain("START-OF-PROMPT");
    expect(b).not.toContain("END-OF-PROMPT");
    expect(b).toContain("answer 19");
    expect(b).not.toContain("answer 3 ");
    const small = renderFreshStartRecap(many, OVERSIZED, {
      currentUserText: NOW,
      maxChars: 8000,
    }) as string;
    expect(small.length).toBeLessThan(8000);
    expect(small).toContain("The last reply follows as text.");
    expect(small).toContain("END-OF-REPLY");
    expect(small).not.toContain("START-OF-PROMPT");
    expect(small).not.toContain("answer 19");
  });

  it("never cuts through an emoji", () => {
    const b = renderFreshStartRecap(
      [user(P1), assistant(`${"\u{1F600}".repeat(4000)}y`), user(NOW)],
      OVERSIZED,
      { currentUserText: NOW },
    ) as string;
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(b)).toBe(
      false,
    );
  });
});
