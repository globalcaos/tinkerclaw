import { describe, expect, it } from "vitest";
import { splitInjectedPrompt } from "./injected-prompt.js";

// Fixtures are shortened but structurally faithful to the live transcripts in
// ~/.openclaw/agents/main/sessions (scanned 2026-08-01 → 08-28).

/** The architect's real turn of 2026-08-28 12:06 — two typed lines, stored as 15,747 chars. */
const REAL_FRACTAL_TURN =
  "You seem stuck again (seems very recurrent today, and frustrating, Fractal should debug and " +
  "fix, is it a code or a md problem?). Also create a BROCA-recipe with the present strategy we " +
  "are using for chosing a name for a product\n\n---\n\n" +
  "**After your reply, append a \u{1F33F} FRACTAL reflection section** on its own line (blank line " +
  "before it). This is the doctrine that governs it:\n\n" +
  "## Who Fractal is\n\nThe main turn is the fast thinker: it does the work. Fractal is the slow " +
  "thinker in the shadows: after the work is done, it asks what the work meant.\n\n" +
  "## Hard rules\n\n1. **Attribution is sacred.** You must report as Fractal's only what the " +
  "reflection itself changed after the answer ended. Do not write about the main turn's work.\n";

const RECIPE_BLOCK =
  "run the deploy please\n\n---\n\n" +
  '<active_recipe kits="globalcaos/clean-public-push" steps="4">A plan was auto-seeded from the ' +
  "matched recipe(s). Follow its steps and keep the RECIPES panel honest.</active_recipe>";

describe("splitInjectedPrompt", () => {
  it("folds the fractal doctrine and keeps only what the architect typed", () => {
    const s = splitInjectedPrompt(REAL_FRACTAL_TURN);
    expect(s).not.toBeNull();
    expect(s!.kind).toBe("fractal");
    expect(s!.label).toBe("fractal doctrine");
    expect(s!.visible).toBe(
      "You seem stuck again (seems very recurrent today, and frustrating, Fractal should debug and " +
        "fix, is it a code or a md problem?). Also create a BROCA-recipe with the present strategy " +
        "we are using for chosing a name for a product",
    );
    // The whole doctrine is preserved, just moved out of his voice.
    expect(s!.injected).toContain("## Who Fractal is");
    expect(s!.visible).not.toContain("Who Fractal is");
  });

  it("recognises a recipe injection — the case the old allowlist could never catch", () => {
    const s = splitInjectedPrompt(RECIPE_BLOCK);
    expect(s).not.toBeNull();
    expect(s!.kind).toBe("recipe");
    expect(s!.label).toBe("recipe instructions");
    expect(s!.visible).toBe("run the deploy please");
  });

  it("recognises a kit/1.0 recipe body pasted in as the block", () => {
    const s = splitInjectedPrompt(
      "do the thing\n\n---\n\nkind: kit/1.0\nslug: clean-public-push\nsteps:\n  - title: sanitize\n",
    );
    expect(s?.kind).toBe("recipe");
  });

  it("recognises the briefing injection", () => {
    const s = splitInjectedPrompt(
      "/new\n\n---\n\n**Session Startup.** Read and follow whichever of these briefing files exists.",
    );
    expect(s?.kind).toBe("briefing");
    expect(s?.visible).toBe("/new");
  });

  it("recognises a [System] block", () => {
    const s = splitInjectedPrompt(
      "carry on\n\n---\n\n[System] The gateway restarted and interrupted your previous turn.",
    );
    expect(s?.kind).toBe("system");
  });

  it("catches an unknown injector structurally, with no sentinel at all", () => {
    const block =
      "# Finished-turn digest\n\n" +
      "You are reviewing a turn that already finished. You must never write in the first person " +
      "about anything in this digest.\n\n" +
      "## What happens to your findings\n\n" +
      "They are verified against disk and surfaced to the architect. ".repeat(12);
    const s = splitInjectedPrompt(`ok\n\n---\n\n${block}`);
    expect(s?.kind).toBe("directive");
    expect(s?.visible).toBe("ok");
  });

  it("tolerates the collapsed separator the persistence layer produces", () => {
    const s = splitInjectedPrompt(
      "hi\n---\n**After your reply, append a \u{1F33F} FRACTAL reflection section** on its own line.",
    );
    expect(s?.kind).toBe("fractal");
    expect(s?.visible).toBe("hi");
  });

  // --- the rule that outranks coverage: never mislabel a human -------------------------------

  it("leaves an ordinary message alone", () => {
    expect(splitInjectedPrompt("keep going")).toBeNull();
    expect(splitInjectedPrompt("")).toBeNull();
    expect(splitInjectedPrompt(undefined)).toBeNull();
    expect(splitInjectedPrompt(null)).toBeNull();
  });

  it("does not fold a human's own horizontal rules", () => {
    expect(
      splitInjectedPrompt("first point\n\n---\n\nsecond point\n\n---\n\nthird point"),
    ).toBeNull();
  });

  it("does not fold a long document the human pasted themselves", () => {
    // Long and full of headings, but never addresses the model in the second person.
    const pasted =
      "here is the spec\n\n---\n\n" +
      "# Spec\n\n## Scope\n\nThe detector runs on five cameras. " +
      "Occlusion degrades the detection rate, so redundancy covers the blind spots. ".repeat(15);
    expect(splitInjectedPrompt(pasted)).toBeNull();
  });

  it("does not fold a short sign-off after a rule", () => {
    expect(splitInjectedPrompt("thanks\n\n---\n\nsent from my phone")).toBeNull();
  });

  it("splits at the first rule whose tail is machine-authored, not the first rule", () => {
    const s = splitInjectedPrompt(
      "point one\n\n---\n\npoint two, still me\n\n---\n\n" +
        "**After your reply, append a \u{1F33F} FRACTAL reflection section** on its own line.",
    );
    expect(s?.kind).toBe("fractal");
    expect(s?.visible).toBe("point one\n\n---\n\npoint two, still me");
  });
});
