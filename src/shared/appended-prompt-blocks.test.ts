import { describe, expect, it } from "vitest";
import { APPENDED_PROMPT_BLOCKS, FRACTAL_DOCTRINE_MARKER } from "./appended-prompt-blocks.js";

/** Cut a prompt the way its readers do (session-rewind.ts composerText): at every block that matches. */
function cut(raw: string): string {
  let s = raw;
  for (const re of APPENDED_PROMPT_BLOCKS) {
    const m = re.exec(s);
    if (m) {
      s = s.slice(0, m.index);
    }
  }
  return s.trim();
}

// FORK 2026-10-09 (Fractal v2, charter C4) — new prompts open the doctrine with a neutral marker
// instead of "After your reply…"; old transcripts keep the old literal, so both must cut.
describe("APPENDED_PROMPT_BLOCKS — the Fractal doctrine seam", () => {
  it("names the C4 marker literally", () => {
    expect(FRACTAL_DOCTRINE_MARKER).toBe("⟦FRACTAL-DOCTRINE⟧");
  });

  it("cuts the old literal seam (old transcripts)", () => {
    expect(
      cut(
        "are you stuck?\n\n---\n\n**After your reply, append a 🌿 FRACTAL reflection section** doctrine…",
      ),
    ).toBe("are you stuck?");
  });

  it("cuts the new marker seam at the same position", () => {
    expect(cut("are you stuck?\n\n---\n\n⟦FRACTAL-DOCTRINE⟧\n# 🌿 FRACTAL core\n\nchapter")).toBe(
      "are you stuck?",
    );
  });

  it("cuts the new marker before the chat-row contract too", () => {
    expect(
      cut(
        "do X\n\n---\n\n⟦FRACTAL-DOCTRINE⟧\ncore\n\n<!-- TINKERCLAW chat-row contract -->\nBefore EVERY tool call",
      ),
    ).toBe("do X");
  });

  it("leaves a marker the owner merely quotes, with no rule before it, alone", () => {
    expect(cut("what does ⟦FRACTAL-DOCTRINE⟧ mean?")).toBe("what does ⟦FRACTAL-DOCTRINE⟧ mean?");
  });
});
