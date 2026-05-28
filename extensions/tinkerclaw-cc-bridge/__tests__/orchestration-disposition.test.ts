import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

describe("orchestration-disposition prompt block", () => {
  it("exists, names all 5 kits, and labels loop-until-dry as bounded", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const p = resolve(here, "..", "prompts", "orchestration-disposition.md");
    const text = readFileSync(p, "utf-8");
    for (const slug of [
      "adversarial-verify",
      "judge-panel",
      "completeness-critic",
      "multi-modal-sweep",
      "loop-until-dry",
    ]) {
      expect(text).toContain(slug);
    }
    expect(text.toLowerCase()).toContain("advisory");
    expect(text.toLowerCase()).toContain("bounded");
  });
});
