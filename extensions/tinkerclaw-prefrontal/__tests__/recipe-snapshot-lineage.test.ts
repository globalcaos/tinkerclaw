/**
 * SS3 Task 6 — snapshot lineage in FRONTMATTER (review O2: not a sidecar).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { injectLineageFrontmatter, snapshotKit } from "../recipe-snapshot.js";

const KIT = `---
schema: "kit/1.0"
slug: "x"
title: "X"
---

# X

## Steps

### 1. Apply
invoke skill: stdlib-summarize-text

Apply the skill.
`;

describe("snapshotKit lineage (SS3 Task 6)", () => {
  let root: string;
  let ownRecipesDir: string;
  beforeEach(async () => {
    // ownRecipesDir is a SUBDIR of root so the sibling .recipe-archive is contained.
    root = await fs.mkdtemp(path.join(os.tmpdir(), "snap-lineage-"));
    ownRecipesDir = path.join(root, "kits");
    await fs.mkdir(ownRecipesDir, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("injects lineage into the snapshot frontmatter", async () => {
    const file = await snapshotKit(ownRecipesDir, "x", KIT, "2026-06-04T10:00:00.000Z", {
      composedFrom: "compose",
      sourceQuery: "summarize a document",
      composedSkills: ["stdlib-summarize-text", "stdlib-web-search-and-cite"],
    });
    const text = await fs.readFile(file, "utf-8");
    expect(text).toContain("lineage:");
    expect(text).toContain('composedFrom: "compose"');
    expect(text).toContain('sourceQuery: "summarize a document"');
    expect(text).toContain(
      'composedSkills: ["stdlib-summarize-text", "stdlib-web-search-and-cite"]',
    );
    // lineage sits INSIDE the frontmatter (before the closing ---).
    const closeIdx = text.indexOf("\n---", 4);
    expect(text.indexOf("lineage:")).toBeGreaterThan(0);
    expect(text.indexOf("lineage:")).toBeLessThan(closeIdx);
  });

  it("no lineage → snapshot text unchanged", async () => {
    const file = await snapshotKit(ownRecipesDir, "x", KIT, "2026-06-04T10:00:00.000Z");
    const text = await fs.readFile(file, "utf-8");
    expect(text).toBe(KIT);
    expect(text).not.toContain("lineage:");
  });

  it("injectLineageFrontmatter leaves a frontmatter-less doc unchanged", () => {
    expect(injectLineageFrontmatter("no frontmatter here", { composedFrom: "compose" })).toBe(
      "no frontmatter here",
    );
  });
});
