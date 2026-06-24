import { describe, it, expect } from "vitest";
import {
  skillMdToRecipeSpec,
  buildBridgedKitMd,
  assertNoSymlink,
  BRIDGED_AUTHORED_BY,
  BRIDGED_SKILLS_DIRNAME,
} from "../cc-skills-bridge.js";
import { validateRecipeSpec } from "../recipe-author.js";
import { parseKitStepsAndParallelism } from "../recipe-runner.js";

// A minimal but realistic Claude-Code SKILL.md: YAML frontmatter (name +
// description) followed by a documented numbered procedure.
const GOOD_SKILL = `---
name: deploy-check
description: "Verify a deploy is healthy before promoting it to prod."
trigger: /deploy-check
---

# Deploy Check

Run this after a release lands on staging.

## Steps

### 1. Read the release manifest
Open the manifest and note the target version.

### 2. Run the smoke suite
Execute the smoke tests against staging.

### 3. Promote or roll back
If green, promote; otherwise roll back.
`;

// Same shape but the procedure is documented as a "Step N -" heading form,
// which CC skills (e.g. graphify) commonly use.
const STEP_DASH_SKILL = `---
name: graphify-lite
description: Turn a folder into a knowledge graph.
---

# Graphify Lite

### Step 0 - Clone the repo
Clone the target repository locally.

### Step 1 - Extract entities
Run the extractor over the files.

### Step 2 - Build the graph
Assemble nodes and edges into a graph.
`;

describe("skillMdToRecipeSpec", () => {
  it("transpiles a SKILL.md with 3 numbered steps into a 3-step RecipeSpec", () => {
    const spec = skillMdToRecipeSpec(GOOD_SKILL);
    expect(spec.slug).toBe("deploy-check");
    expect(spec.summary).toBe("Verify a deploy is healthy before promoting it to prod.");
    expect(spec.steps).toHaveLength(3);
    expect(spec.steps.map((s) => s.title)).toEqual([
      "Read the release manifest",
      "Run the smoke suite",
      "Promote or roll back",
    ]);
  });

  it("infers steps from `Step N -` headings too", () => {
    const spec = skillMdToRecipeSpec(STEP_DASH_SKILL);
    expect(spec.slug).toBe("graphify-lite");
    expect(spec.steps.map((s) => s.title)).toEqual([
      "Clone the repo",
      "Extract entities",
      "Build the graph",
    ]);
  });

  it("slugifies a name with spaces / mixed case", () => {
    const md = GOOD_SKILL.replace("name: deploy-check", "name: Deploy Check Pro");
    const spec = skillMdToRecipeSpec(md);
    expect(spec.slug).toBe("deploy-check-pro");
  });
});

describe("bridge output passes the real validators", () => {
  it("produces a RecipeSpec that validateRecipeSpec accepts", () => {
    const spec = skillMdToRecipeSpec(GOOD_SKILL);
    const v = validateRecipeSpec(spec);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("round-trips through buildBridgedKitMd + the runner parser, tagged tinker-bridge", () => {
    const spec = skillMdToRecipeSpec(GOOD_SKILL);
    const md = buildBridgedKitMd(spec);
    expect(md).toContain('schema: "kit/1.0"');
    expect(md).toContain('authoredBy: "tinker-bridge"');
    expect(md).not.toContain('authoredBy: "jarvis-on-the-fly"');
    const parsed = parseKitStepsAndParallelism(md);
    expect(parsed.steps.map((s) => s.title)).toEqual([
      "Read the release manifest",
      "Run the smoke suite",
      "Promote or roll back",
    ]);
  });

  it("exports the tinker-bridge authorship constant + scan dir name", () => {
    expect(BRIDGED_AUTHORED_BY).toBe("tinker-bridge");
    expect(BRIDGED_SKILLS_DIRNAME).toBe("bridged-skills");
  });
});

describe("malformed SKILL.md is rejected before any write", () => {
  it("throws when frontmatter is absent", () => {
    expect(() => skillMdToRecipeSpec("# Just a heading\nno frontmatter here")).toThrow(
      /frontmatter/i,
    );
  });

  it("throws when name is missing", () => {
    const md = `---\ndescription: "has a desc but no name"\n---\n\n### 1. Do\nbody`;
    expect(() => skillMdToRecipeSpec(md)).toThrow(/name/i);
  });

  it("throws when description is missing", () => {
    const md = `---\nname: no-desc\n---\n\n### 1. Do\nbody`;
    expect(() => skillMdToRecipeSpec(md)).toThrow(/description/i);
  });

  it("throws when no procedure / steps can be inferred", () => {
    const md = `---\nname: empty-proc\ndescription: "does nothing documented"\n---\n\n# Empty\n\nThis skill has prose but no numbered procedure.`;
    expect(() => skillMdToRecipeSpec(md)).toThrow(/step/i);
  });

  it("rejects a name that cannot produce a safe slug", () => {
    const md = `---\nname: "../../etc/passwd"\ndescription: "evil"\n---\n\n### 1. Do\nbody`;
    expect(() => skillMdToRecipeSpec(md)).toThrow(/slug/i);
  });
});

describe("symlink-safety (Risk 6: imported content must never follow symlinks)", () => {
  it("assertNoSymlink passes for a regular file path", async () => {
    await expect(assertNoSymlink(__filename)).resolves.toBeUndefined();
  });

  it("assertNoSymlink rejects a path whose final component is a symlink", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-"));
    const real = path.join(dir, "real-SKILL.md");
    const link = path.join(dir, "link-SKILL.md");
    await fs.writeFile(real, GOOD_SKILL, "utf8");
    await fs.symlink(real, link);
    try {
      await expect(assertNoSymlink(link)).rejects.toThrow(/symlink/i);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
