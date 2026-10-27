import { describe, expect, it } from "vitest";
import { extractSpokenLine } from "../../extensions/tinkerclaw-computational-humor/src/spoken-line.js";
import { spokenLineOf, voiceReactionChips, voiceTapKey } from "./voice-reaction.js";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 2026-10-10 (plan Phase 1.4): the chips on the purple line must name the same line the humour plugin records. */
describe("purple-line reaction chips", () => {
  const replies = [
    "**Jarvis:** *Four hours, one comma.*\n\nThe fix is in.",
    "**Jarvis:** *First.*\n\nbody\n\n**Jarvis:** *Merged, and the laptop has not been told.*",
    '**Jarvis:** *It says "done" & means it.*',
    "No purple line here.",
    "**Jarvis:** *Torrent scout is built",
  ];

  it("finds the line exactly as the plugin does", () => {
    for (const r of replies) {
      expect(spokenLineOf(r, "Jarvis")).toBe(extractSpokenLine(r));
    }
    expect(spokenLineOf("**GOKU:** *Kamehameha, deployed.*", "GOKU")).toBe("Kamehameha, deployed.");
  });

  it("renders three chips, marks the pressed one, and escapes the line", () => {
    const html = voiceReactionChips('It says "done" & means it.', "not-now", escapeHtml);
    expect(html).toContain('data-line="It says &quot;done&quot; &amp; means it."');
    expect(html.match(/class="voice-react-chip/g)).toHaveLength(3);
    expect(html).toMatch(/is-on" data-reaction="not-now" aria-pressed="true"/);
    expect(html).toMatch(/data-reaction="laughed" aria-pressed="false"/);
    expect(voiceReactionChips("x", undefined, escapeHtml)).not.toContain("is-on");
  });

  it("keys taps by chat and line", () => {
    expect(voiceTapKey("agent:main:tinker:a", "x")).not.toBe(
      voiceTapKey("agent:main:tinker:b", "x"),
    );
  });
});
