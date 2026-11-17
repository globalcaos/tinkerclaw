import { describe, expect, it } from "vitest";
import { cardCarryLength, endsInsideCard } from "./cut-card.js";
import { mendCutCard } from "./final-supersede.js";
import { advanceCursor, closeSegment, nextSegmentWrite } from "./live-continuation.js";
import { renderSectionedReply, splitSectionedReply, trailingCard } from "./sectioned-reply.js";

// The shape of a 2026-11-04 phone report: a reply ending in ✨ DEEPER and a closing card, then a
// stop-check send-back and a second answer. The first bubble ended on the card's last content line;
// the next one began with the card's end, its closing fence and the second answer.
const reply1 =
  "**Jarvis:** *Twenty picks.*\n\nThe list.\n\n✨ DEEPER\n\nA hard magic system.\n\n" +
  '```html-render\n<div style="padding:10px"><div>\n<b>Open:</b> the scratch needs your call';
const reply2Head = "</div></div>\n```";
const reply2 = "\n\n**Jarvis:** *The claim holds.*\n\nThe deletes printed nothing.";

describe("endsInsideCard / cardCarryLength", () => {
  it("sees a card opened and not closed", () => {
    expect(endsInsideCard(reply1)).toBe(true);
    expect(endsInsideCard(reply1 + reply2Head)).toBe(false);
    expect(endsInsideCard("```js\nx\n```")).toBe(false);
    expect(endsInsideCard("no card")).toBe(false);
  });
  it("carries up to and including the closing fence, or everything while it is open", () => {
    expect(cardCarryLength(reply1, reply2Head + reply2)).toBe(reply2Head.length);
    expect(cardCarryLength(reply1, "</div>")).toBe("</div>".length);
    expect(cardCarryLength("closed", reply2Head + reply2)).toBe(0);
  });
});

describe("mendCutCard — a cut between two bubbles", () => {
  it("moves the card's end up into the bubble that opened it", () => {
    const plan = mendCutCard([reply1, reply2Head + reply2], "");
    expect(plan.texts[0]).toBe(reply1 + reply2Head);
    expect(plan.texts[1]).toBe(reply2.trimStart());
    expect(plan.appendTail).toBe("");
  });
  it("never empties the lower bubble", () => {
    expect(mendCutCard([reply1, reply2Head], "").texts).toEqual([reply1, reply2Head]);
  });
  it("still mends the last bubble against the tail", () => {
    const plan = mendCutCard(["Narration.", reply1], reply2Head + reply2);
    expect(plan.texts[1]).toBe(reply1 + reply2Head);
    expect(plan.appendTail).toBe(reply2.trimStart());
  });
});

describe("closeSegment keeps a bubble open inside a card", () => {
  it("the thought's closing fence grows the bubble that opened the card", () => {
    const thought = "Drafting:\n```html-render\n<div>half";
    let cur = { uid: "m1", start: 0, seen: thought };
    cur = closeSegment(cur);
    expect(cur.uid).toBe("m1");
    const buffer = `${thought}</div>\n\`\`\``;
    expect(nextSegmentWrite(cur, buffer, thought)).toEqual({ kind: "grow", text: buffer });
  });
  it("closes as before once the card is closed", () => {
    const buffer = "```html-render\n<div></div>\n```";
    const cur = closeSegment(
      advanceCursor(
        { uid: null, start: 0, seen: "" },
        { kind: "open", start: 0, text: buffer },
        buffer,
        "m1",
      ),
    );
    expect(cur.uid).toBe(null);
  });
});

describe("sectioned-reply tolerates a DEEPER body cut inside its card", () => {
  it("finds an unterminated trailing card and closes its fence", () => {
    const sec = splitSectionedReply(reply1)!;
    const card = trailingCard(sec.deeper!)!;
    expect(card.fence.startsWith("```html-render")).toBe(true);
    expect(card.fence.endsWith("needs your call\n```")).toBe(true);
  });
  it("draws the cut card after the yellow bubble, as a card", () => {
    const html = renderSectionedReply(
      splitSectionedReply(reply1)!,
      "",
      (t) => `<p>${t}</p>`,
      (t) => t,
    );
    const yellow = html.indexOf("msg-deeper");
    const cardAt = html.indexOf("```html-render");
    expect(cardAt).toBeGreaterThan(yellow);
    expect(html.slice(yellow, cardAt)).toContain('</div><div class="msg assistant">');
    expect(html).toContain("needs your call\n```</p>");
  });
});
