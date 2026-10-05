import { describe, expect, test } from "vitest";
import {
  FRACTAL_DOCTRINE_MARKER,
  isGatewayRestartResume,
  stripInjectedFractalDoctrine,
} from "./fractal-prompt-strip.js";

// FORK 2026-09-07 (the architect: "The clawhub tab just showed me a nonesense-bubble as if I was
// prompting in strange html").
//
// He typed `keep going` — 11 characters. The stored user turn was 22,548, because the reflection
// doctrine is APPENDED to every prompt. app.ts hides a fractal prompt only when the text contains
// the literal `# FRACTAL REFLECTION`, at six separate sites. The injected doctrine does not
// contain that string anywhere — the template's heading is `# FRACTAL — the slow thinker`, and
// `grep -c 'FRACTAL REFLECTION'` on it returns 0. So nothing stripped, and the whole block painted
// inside his own bubble, including the five angle-bracket placeholders that read as HTML:
// `<a distinctive phrase from the reply>`, `<commit>`, `<details>`, `<dir>`, `<slug>`.
//
// Hiding the WHOLE message (what the six sites do) is wrong here: the doctrine is appended to what
// he actually typed, so it would take "keep going" with it. The boundary is the cut.
const REAL_PROMPT = "[Mon 2026-09-07 15:41 GMT+2] keep going";
const REAL_DOCTRINE = `${REAL_PROMPT}

---

**After your reply, append a 🌿 FRACTAL reflection section** on its own line (blank line before it). This is the doctrine that governs it:

## Who Fractal is

The main turn is the fast thinker: it does the work.

 1. **Disk** — \`grep -rl "<a distinctive phrase from the reply>" ~/.openclaw\`.
 <dir>/<slug>/recipe.md, <commit>, and \`<details>\` collapse.`;

describe("stripInjectedFractalDoctrine", () => {
  test("keeps what the human typed and drops the appended doctrine", () => {
    const out = stripInjectedFractalDoctrine(REAL_DOCTRINE);
    expect(out).toBe(REAL_PROMPT);
    expect(out).not.toContain("Who Fractal is");
    // The angle-bracket placeholders that read as stray HTML must be gone.
    for (const tag of ["<details>", "<dir>", "<slug>", "<commit>", "<a distinctive phrase"]) {
      expect(out).not.toContain(tag);
    }
  });

  test("is a no-op on a prompt that carries no doctrine", () => {
    expect(stripInjectedFractalDoctrine(REAL_PROMPT)).toBe(REAL_PROMPT);
    expect(stripInjectedFractalDoctrine("")).toBe("");
  });

  test("tolerates a missing or differently spaced --- separator", () => {
    const noRule = `do the thing\n\n${FRACTAL_DOCTRINE_MARKER} a 🌿 FRACTAL reflection section**\n\n## Who Fractal is`;
    expect(stripInjectedFractalDoctrine(noRule)).toBe("do the thing");
  });

  test("keeps the sender-metadata envelope intact — that is a separate concern", () => {
    const withSender = `Sender (untrusted metadata):\n\`\`\`json\n{"id":"webchat-ui"}\n\`\`\`\n\n${REAL_DOCTRINE}`;
    const out = stripInjectedFractalDoctrine(withSender);
    expect(out).toContain("Sender (untrusted metadata)");
    expect(out).toContain("keep going");
    expect(out).not.toContain("Who Fractal is");
  });

  test("a message that is ONLY doctrine collapses to empty, so the caller can hide it", () => {
    const only = `${FRACTAL_DOCTRINE_MARKER} a 🌿 FRACTAL reflection section**\n\n## Who Fractal is\n\nbody`;
    expect(stripInjectedFractalDoctrine(only)).toBe("");
  });

  test("does not fire on ordinary prose that merely mentions the words", () => {
    const prose = "Can you explain what happens after your reply, append-only logs and all?";
    expect(stripInjectedFractalDoctrine(prose)).toBe(prose);
  });

  test("cuts at the FIRST marker when the doctrine somehow appears twice", () => {
    const twice = `${REAL_DOCTRINE}\n\n${REAL_DOCTRINE}`;
    expect(stripInjectedFractalDoctrine(twice)).toBe(REAL_PROMPT);
  });
});

// The verbatim resume prompt injected into the ClawHub tab at 2026-09-07 15:40:35 and again at
// 15:41:16, after the gateway restart. app.ts meant to paint this as an orange centered notice but
// tested `startsWith("⚠️ Gateway restarted")`, which this text does not satisfy.
const REAL_RESUME =
  "[Mon 2026-09-07 15:39 GMT+2] [System] The gateway restarted and interrupted your previous turn. Resume it, and make the resume legible to the user:\n1. ORIENT FIRST — post one short message";

describe("isGatewayRestartResume", () => {
  test("matches the resume prompt actually injected, timestamp prefix and all", () => {
    expect(isGatewayRestartResume(REAL_RESUME)).toBe(true);
  });

  test("still matches the legacy wording the old predicate expected", () => {
    expect(isGatewayRestartResume("⚠️ Gateway restarted — resuming")).toBe(true);
    expect(isGatewayRestartResume("⚠ Gateway restarted — resuming")).toBe(true);
  });

  test("does not fire on the architect talking about a restart", () => {
    expect(isGatewayRestartResume("did you restart the gateway yet?")).toBe(false);
    expect(isGatewayRestartResume("rebuild and restart gateway")).toBe(false);
    expect(isGatewayRestartResume("")).toBe(false);
  });
});
