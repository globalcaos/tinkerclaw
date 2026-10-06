import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateRecipeSpec } from "../recipe-author.js";
import {
  expandRecipeSteps,
  extractSection,
  nodeIo,
  splitSteps,
  type ExtractIo,
  type ExtractParams,
} from "../recipe-extract.js";
import { findRecipeFile } from "../recipe-locate.js";
import {
  invalidateRecipeIndexCache,
  loadRecipeIndex,
  matchRecipesDetailed,
} from "../recipe-matcher.js";
import { parseRecipeMd } from "../recipe-parse.js";
import { parseParamsFromText, parseUsesDirective, runRecipe } from "../recipe-runner.js";

// Phase D of the Broca retrieval v2 build: lift one step of a recipe into its own recipe, leaving `uses:` behind. Every
// test runs on a fixture library in a temp directory; no real recipe is read or written.

const FRONTMATTER = `---
schema: "kit/1.0"
slug: "trip-plan"
title: "Plan a trip"
summary: "Plan a trip from the dates to a brief."
version: "1.0.0"
owner: "globalcaos"
category: "operations"
tags: ["trip", "holiday"]
authoredBy: "jarvis"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
params:
  destination: { type: "string", required: true, description: "Where the trip goes" }
  budget: { type: "number", default: 1500, description: "Euros" }
  token: { type: "string", secret: true, default: "SECRET-DEFAULT-DO-NOT-COPY", description: "Flight API token" }
  unused: { type: "string", default: "never referenced by the moved step" }
---
`;

const STEPS = `# Plan a trip

> Plan a trip from the dates to a brief.

## Steps

### 1. Pick the dates

Choose dates for {{destination}}.

### 2. Find flights

max-tokens: 4000

**Tools:** flight-scan
Search flights to {{destination}} under {{budget}} euros with the key {{token}}.
Keep a shortlist of three.
**Done when:** a shortlist exists

### 3. Book the stay

Pick a stay in {{destination}}.

### 4. Brief the family

Write the brief.
`;

const PARENT = FRONTMATTER + STEPS;
const PARAMS = { destination: "Lisbon", budget: "1500", token: "tok-123" };

let tmp: string;
let root: string;
let other: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "extract-"));
  root = path.join(tmp, "recipes");
  other = path.join(tmp, "overlay");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(other, { recursive: true });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const put = async (rel: string, text: string, base = root): Promise<string> => {
  const file = path.join(base, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  return file;
};

/** Every file and directory under `dir` with its bytes, as one comparable string. */
async function tree(dir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of (await fs.readdir(d, { withFileTypes: true })).toSorted((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full);
      if (e.isDirectory()) {
        out.push(`D ${rel}`);
        await walk(full);
      } else {
        out.push(`F ${rel}\n${await fs.readFile(full, "utf-8")}`);
      }
    }
  };
  await walk(dir);
  return out.join("\n");
}

const archiveDir = () => path.join(tmp, "archive");
const params = (over: Partial<ExtractParams> = {}): ExtractParams => ({
  from: "trip-plan",
  section: "2",
  slug: "flights-step",
  title: "Find flights for a trip",
  ...over,
});
const run = (over: Partial<ExtractParams> = {}, io?: ExtractIo) =>
  extractSection([root, other], params(over), {
    archiveDir: archiveDir(),
    stamp: "2026-10-06T08:00:00.000Z",
    ...(io ? { io } : {}),
  });

describe("extracting a step", () => {
  it("writes the step as a recipe of its own and leaves `uses:` where it was", async () => {
    const parentPath = await put("trip-plan/recipe.md", PARENT);
    const r = await run();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe(path.join(root, "flights-step", "recipe.md"));
    expect(r.kitRef).toBe("globalcaos/flights-step");
    expect(r.step).toBe(2);

    const parent = await fs.readFile(parentPath, "utf-8");
    const steps = splitSteps(parent);
    expect(steps.map((s) => s.title)).toEqual([
      "Pick the dates",
      "Find flights",
      "Book the stay",
      "Brief the family",
    ]);
    expect(steps[1].body).toBe("uses: flights-step");
    expect(parseUsesDirective(steps[1].body)).toBe("globalcaos/flights-step");

    const child = await fs.readFile(r.path, "utf-8");
    const childSteps = splitSteps(child);
    expect(childSteps).toHaveLength(1);
    expect(childSteps[0].title).toBe("Find flights");
    expect(childSteps[0].body).toContain("Search flights to {{destination}}");
    expect(childSteps[0].body).toContain("max-tokens: 4000");
    expect(parseRecipeMd(child).slug).toBe("flights-step");
    expect(parseRecipeMd(child).title).toBe("Find flights for a trip");
  });

  it("changes nothing else in the parent: frontmatter, other steps and spacing are byte-identical", async () => {
    const parentPath = await put("trip-plan/recipe.md", PARENT);
    await run();
    const parent = await fs.readFile(parentPath, "utf-8");
    const expected = PARENT.replace(
      /### 2\. Find flights\n[\s\S]*?(?=### 3\.)/,
      "### 2. Find flights\n\nuses: flights-step\n\n",
    );
    expect(parent).toBe(expected);
  });

  it("the original and the pair expand to the same steps, title for title and body for body", async () => {
    await put("trip-plan/recipe.md", PARENT);
    const resolveFromDisk = async (ref: string) => {
      const f = await findRecipeFile(root, ref.split("/")[1]);
      return f ? fs.readFile(f, "utf-8") : undefined;
    };
    const before = await expandRecipeSteps(PARENT, resolveFromDisk);
    const r = await run();
    expect(r.ok).toBe(true);
    const parent = await fs.readFile(path.join(root, "trip-plan", "recipe.md"), "utf-8");
    const after = await expandRecipeSteps(parent, resolveFromDisk);
    expect(after).toEqual(before);
    expect(after).toHaveLength(4);
    if (r.ok) expect(r.expandedSteps).toBe(4);
  });

  it("the runner builds the same task for the moved step from the child as it did from the parent", async () => {
    const prevHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = path.join(tmp, "home");
    try {
      await put("trip-plan/recipe.md", PARENT);
      const dry = async (kit: string) => {
        const res = await runRecipe({
          kitRef: `globalcaos/${kit}`,
          sessionKey: "s",
          intent: "i",
          parameters: PARAMS,
          dryRun: true,
          ownRecipesDir: root,
          recipeInstallSandbox: path.join(tmp, "sandbox"),
        });
        expect(res.ok, res.errorMessage).toBe(true);
        return res.dryRunPlan!.groups.flat();
      };
      const bodyOf = (task: string) => task.slice(task.indexOf("\n\n") + 2);
      const before = await dry("trip-plan");
      const r = await run();
      expect(r.ok).toBe(true);
      const after = await dry("trip-plan");
      const child = await dry("flights-step");

      // the moved step: the child's task text is the parent's task text, step prefix aside
      expect(child).toHaveLength(1);
      expect(bodyOf(child[0].task)).toBe(bodyOf(before[1].task));
      expect(bodyOf(child[0].task)).toContain(
        "Search flights to Lisbon under 1500 euros with the key tok-123",
      );
      // the parent: the other three steps are the same dispatches, and step 2 is now a composition edge
      for (const i of [0, 2, 3]) expect(after[i].task).toBe(before[i].task);
      expect(after[1].usesKitRef).toBe("globalcaos/flights-step");
    } finally {
      if (prevHome === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = prevHome;
    }
  });

  it("tags the new recipe so only its slug or its exact title phrase matches, never a common word", async () => {
    await put("trip-plan/recipe.md", PARENT);
    const r = await run();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(parseRecipeMd(await fs.readFile(r.path, "utf-8")).tags).toEqual([
      "flights-step",
      "find flights for a trip",
    ]);
    invalidateRecipeIndexCache();
    const index = await loadRecipeIndex(root);
    const slugs = (prompt: string) =>
      matchRecipesDetailed(prompt, index).matches.map((m) => m.entry.slug);
    // a common word that is only a TAG candidate ("for") must not pull the step in on its own: an exact single-word tag
    // alone scores the matcher's threshold. (A word that is in the title scores through the title and summary like it
    // does for every recipe; that is the matcher's ordinary lexical scoring, not something tags decide.)
    for (const prompt of ["buy a gift for my sister", "take the next step"]) {
      expect(slugs(prompt), prompt).not.toContain("flights-step");
    }
    expect(slugs("please find flights for a trip to Rome")).toContain("flights-step");
    invalidateRecipeIndexCache();
  });

  it("selects by number or by title, whole title, any case", async () => {
    await put("trip-plan/recipe.md", PARENT);
    const byTitle = await run({ section: "  FIND   flights " });
    expect(byTitle.ok).toBe(true);
    if (byTitle.ok) expect(byTitle.step).toBe(2);
  });

  it("archives the parent's previous text, byte for byte, and deletes nothing", async () => {
    await put("trip-plan/recipe.md", PARENT);
    const before = await tree(root);
    const r = await run();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await fs.readFile(r.archive, "utf-8")).toBe(PARENT);
    const after = await tree(root);
    // everything that was in the library is still there; the parent changed and one recipe was added
    for (const line of before.split("\n").filter((l) => l.startsWith("F ") || l.startsWith("D "))) {
      const name = line.split("\n")[0];
      expect(after.includes(name)).toBe(true);
    }
    expect(after).toContain("D flights-step");
  });

  it("works on a legacy kit.md parent and on a category file, and the child resolves from the root either way", async () => {
    await put("legacy-trip/kit.md", PARENT.replace('slug: "trip-plan"', 'slug: "legacy-trip"'));
    const a = await run({ from: "legacy-trip", slug: "legacy-flights" });
    expect(a.ok).toBe(true);
    await put(
      "operations/flat-trip.md",
      PARENT.replace('slug: "trip-plan"\n', "").replace(
        'schema: "kit/1.0"',
        'schema: "kit/1.0"\nid: flat-trip',
      ),
    );
    const b = await run({ from: "flat-trip", slug: "flat-flights" });
    expect(b.ok).toBe(true);
    expect(await findRecipeFile(root, "flat-flights")).toBe(
      path.join(root, "flat-flights", "recipe.md"),
    );
    expect(
      parseUsesDirective(
        splitSteps(await fs.readFile(path.join(root, "operations", "flat-trip.md"), "utf-8"))[1]
          .body,
      ),
    ).toBe("globalcaos/flat-flights");
  });

  it("preserves the parent's file mode", async () => {
    const parentPath = await put("trip-plan/recipe.md", PARENT);
    await fs.chmod(parentPath, 0o640);
    expect((await run()).ok).toBe(true);
    expect((await fs.stat(parentPath)).mode & 0o777).toBe(0o640);
  });

  it("finds the parent in the second library and creates the child beside it", async () => {
    await put("trip-plan/recipe.md", PARENT, other);
    const r = await run();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(path.join(other, "flights-step", "recipe.md"));
    await expect(fs.stat(path.join(root, "flights-step"))).rejects.toThrow();
  });
});

describe("parameters move as names and specs, never as values", () => {
  it("declares in the child exactly the params the step uses, with the parent's own specs", async () => {
    const parentPath = await put("trip-plan/recipe.md", PARENT);
    const r = await run();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.paramsMoved.toSorted()).toEqual(["budget", "destination", "token"]);
    const child = await fs.readFile(r.path, "utf-8");
    const decl = parseParamsFromText(child)!;
    const parentDecl = parseParamsFromText(PARENT)!;
    expect(Object.keys(decl).toSorted()).toEqual(["budget", "destination", "token"]);
    expect(decl.destination).toEqual(parentDecl.destination);
    expect(decl.budget).toEqual(parentDecl.budget);
    expect("unused" in decl).toBe(false);
    // the parent still declares all four, untouched
    expect(parseParamsFromText(await fs.readFile(parentPath, "utf-8"))).toEqual(parentDecl);
  });

  it("does not copy a secret default, and says so", async () => {
    await put("trip-plan/recipe.md", PARENT);
    const r = await run();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const child = await fs.readFile(r.path, "utf-8");
    expect(child).not.toContain("SECRET-DEFAULT-DO-NOT-COPY");
    expect(parseParamsFromText(child)!.token).toMatchObject({ secret: true });
    expect(parseParamsFromText(child)!.token.default).toBeUndefined();
    expect(r.notes.join(" ")).toContain('"token" is secret');
  });

  it("never reads or writes the private variable store", async () => {
    await put("trip-plan/recipe.md", PARENT);
    const vars = path.join(tmp, "recipe-vars.json");
    const content = JSON.stringify({
      version: 1,
      scopes: { "globalcaos/trip-plan": { destination: "PRIVATE-VALUE" } },
      secrets: [],
    });
    await fs.writeFile(vars, content, { mode: 0o600 });
    const before = await fs.stat(vars);
    const r = await run();
    expect(r.ok).toBe(true);
    expect(await fs.readFile(vars, "utf-8")).toBe(content);
    expect((await fs.stat(vars)).mtimeMs).toBe(before.mtimeMs);
    if (r.ok) expect(await fs.readFile(r.path, "utf-8")).not.toContain("PRIVATE-VALUE");
  });

  it("leaves a step with no parameters with a child that declares none", async () => {
    await put("trip-plan/recipe.md", PARENT);
    const r = await run({ section: "4", slug: "family-brief" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.paramsMoved).toEqual([]);
    expect(parseParamsFromText(await fs.readFile(r.path, "utf-8"))).toBeUndefined();
  });

  it("the new recipe is a valid recipe by the author's own validator", async () => {
    await put("trip-plan/recipe.md", PARENT);
    const r = await run();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const spec = parseRecipeMd(await fs.readFile(r.path, "utf-8"));
    expect(validateRecipeSpec(spec).ok).toBe(true);
  });
});

describe("what it refuses, and that a refusal writes nothing", () => {
  const withStep2 = (body: string) =>
    PARENT.replace(
      /### 2\. Find flights\n[\s\S]*?(?=### 3\.)/,
      `### 2. Find flights\n\n${body}\n\n`,
    );

  const refusedWith = async (
    text: string,
    over: Partial<ExtractParams>,
    reason: RegExp,
  ): Promise<void> => {
    await put("trip-plan/recipe.md", text);
    const before = await tree(tmp);
    const r = await run(over);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refused.join(" | ")).toMatch(reason);
    expect(await tree(tmp)).toBe(before);
  };

  it("a parameter the parent does not declare", async () => {
    await refusedWith(withStep2("Fly to {{nowhere}}."), {}, /\{\{nowhere\}\}.*does not declare/);
  });

  it("an output of another step", async () => {
    await refusedWith(
      withStep2("Use {{steps.1.out.dates}} to search."),
      {},
      /\{\{steps\.1\.out\.dates\}\}.*another step/,
    );
  });

  it("a per-element binding", async () => {
    await refusedWith(withStep2("Fly {{item}}."), {}, /\{\{item\}\}/);
    await fs.rm(path.join(root, "trip-plan"), { recursive: true });
    await refusedWith(withStep2("Fly {{index}}."), {}, /\{\{index\}\}/);
  });

  it.each([
    ["in", 'in: [{"name":"d","from":"steps.1.out"}]'],
    ["out", 'out: {"type":"object"}'],
    ["when", "when: steps.1.out.ok"],
    ["return", "return:"],
    ["onError", "onError: retry 2"],
    ["uses", "uses: other-recipe"],
    ["loop", "loop: 3"],
    ["map", "map: steps.1.out.items"],
    ["invoke skill", "invoke skill: web-search"],
  ])("a `%s:` directive", async (name, line) => {
    await refusedWith(withStep2(`${line}\n\nSearch flights.`), {}, new RegExp(`\`${name}:\``, "i"));
  });

  it("per-step budget directives are allowed and move with the step", async () => {
    await put(
      "trip-plan/recipe.md",
      withStep2("allow-tools: web_search\nmax-tool-calls: 5\n\nSearch flights to {{destination}}."),
    );
    const r = await run();
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = splitSteps(await fs.readFile(r.path, "utf-8"))[0].body;
      expect(body).toContain("allow-tools: web_search");
      expect(body).toContain("max-tool-calls: 5");
    }
  });

  it("a heading as high as the step's own inside its body (a trailing section)", async () => {
    const text = PARENT.replace(
      "Write the brief.\n",
      "Write the brief.\n\n## Constraints\n\n- keep it short\n",
    );
    await refusedWith(text, { section: "4", slug: "family-brief" }, /heading "## Constraints"/);
  });

  it("but allows a deeper heading and a heading inside a code fence", async () => {
    const text = withStep2("Search flights.\n\n#### Notes\n\n```\n## not a heading\n```");
    await put("trip-plan/recipe.md", text);
    expect((await run()).ok).toBe(true);
  });

  it("a step whose body is empty", async () => {
    await refusedWith(
      PARENT.replace("Write the brief.\n", ""),
      { section: "4", slug: "family-brief" },
      /empty body/,
    );
  });

  it("an unknown or out-of-range section, naming the steps there are", async () => {
    await refusedWith(
      PARENT,
      { section: "Book a boat" },
      /no step "Book a boat".*2\. Find flights/,
    );
    await fs.rm(path.join(root, "trip-plan"), { recursive: true });
    await refusedWith(PARENT, { section: "9" }, /no step "9"/);
  });

  it("an ambiguous title", async () => {
    const dup = PARENT.replace("### 3. Book the stay", "### 3. Find flights");
    await refusedWith(dup, { section: "find flights" }, /matches 2 steps/);
  });

  it("steps that are not numbered 1..N in order", async () => {
    await refusedWith(
      PARENT.replace("### 3. Book", "### 5. Book"),
      {},
      /not numbered 1\.\.4 in order/,
    );
  });

  it("a recipe that is not there, or has no numbered steps", async () => {
    const before = await tree(tmp);
    const r = await run({ from: "ghost" });
    expect(r.ok).toBe(false);
    expect(await tree(tmp)).toBe(before);
    await put("flat/recipe.md", "---\nslug: flat\n---\n# Flat\n\nJust prose.\n");
    const s = await run({ from: "flat" });
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.refused.join(" ")).toMatch(/no numbered steps/);
  });

  it("a slug that is not a valid slug, or that is the parent's own", async () => {
    await refusedWith(PARENT, { slug: "Bad Slug" }, /slug must match/);
    await fs.rm(path.join(root, "trip-plan"), { recursive: true });
    await refusedWith(PARENT, { slug: "../escape" }, /slug must match/);
    await fs.rm(path.join(root, "trip-plan"), { recursive: true });
    await refusedWith(PARENT, { slug: "trip-plan" }, /must differ/);
  });

  it("a slug that already exists in either library, and a bare directory of that name", async () => {
    await put("trip-plan/recipe.md", PARENT);
    await put("taken/recipe.md", "---\nslug: taken\n---\n### 1. A\n\nbody\n", other);
    const before = await tree(tmp);
    const a = await run({ slug: "taken" });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.refused.join(" ")).toMatch(/already exists/);
    await fs.mkdir(path.join(root, "flights-step"));
    const b = await run();
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.refused.join(" ")).toMatch(/already exists/);
    await fs.rmdir(path.join(root, "flights-step"));
    expect(await tree(tmp)).toBe(before);
  });

  it("reports every problem at once, not the first", async () => {
    await put(
      "trip-plan/recipe.md",
      withStep2("when: steps.1.out.ok\n\nFly to {{nowhere}} with {{steps.1.out.x}}."),
    );
    const r = await run();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refused.length).toBeGreaterThanOrEqual(3);
  });

  it("the composition edge it leaves is not the card parent field: it is a uses: step", async () => {
    await put("trip-plan/recipe.md", PARENT);
    const r = await run();
    expect(r.ok).toBe(true);
    const parent = await fs.readFile(path.join(root, "trip-plan", "recipe.md"), "utf-8");
    expect(parent).not.toMatch(/^parent:/m);
    expect(parseUsesDirective(splitSteps(parent)[1].body)).toBe("globalcaos/flights-step");
  });
});

// A wrapper that makes the Nth call of one file operation fail.
const failing = (op: keyof ExtractIo, nth: number): { io: ExtractIo; calls: () => number } => {
  let n = 0;
  const io = { ...nodeIo } as ExtractIo;
  const real = nodeIo[op] as (...a: never[]) => Promise<unknown>;
  (io as unknown as Record<string, unknown>)[op] = async (...a: never[]) => {
    n += 1;
    if (n === nth) throw new Error(`injected ${op} failure #${nth}`);
    return real(...a);
  };
  return { io, calls: () => n };
};

describe("a failure at any file operation leaves the library byte-identical", () => {
  const ops: Array<keyof ExtractIo> = ["createFile", "rename", "mkdir", "chmod", "readFile"];

  it.each(ops)("fails the Nth %s, for every N the extraction reaches", async (op) => {
    await put("trip-plan/recipe.md", PARENT);
    const before = await tree(tmp);
    let reached = 0;
    for (let nth = 1; nth <= 12; nth++) {
      const { io, calls } = failing(op, nth);
      const r = await run({}, io);
      if (r.ok) {
        // the extraction made fewer than `nth` calls, so the failure never fired: stop, and put the library back
        expect(calls()).toBeLessThan(nth);
        break;
      }
      reached += 1;
      expect(r.refused.join(" | ")).toMatch(/injected|could not read/);
      expect(await tree(tmp)).toBe(before);
    }
    expect(reached).toBeGreaterThan(0);
  });

  it("a read-back that finds something other than what was written is rolled back, and the parent is restored", async () => {
    const parentPath = await put("trip-plan/recipe.md", PARENT);
    const before = await tree(tmp);
    let reads = 0;
    const io: ExtractIo = {
      ...nodeIo,
      readFile: async (p) => {
        reads += 1;
        const text = await nodeIo.readFile(p);
        // the 3rd read is the read-back of the parent: pretend someone else changed it in between
        return reads === 3 ? `${text}\nsomeone else's edit` : text;
      },
    };
    const r = await run({}, io);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refused.join(" ")).toMatch(/rolled back/);
    expect(await fs.readFile(parentPath, "utf-8")).toBe(PARENT);
    expect(await tree(tmp)).toBe(before);
  });

  it("a parent edited while the extraction was staged is not overwritten", async () => {
    const parentPath = await put("trip-plan/recipe.md", PARENT);
    let reads = 0;
    const io: ExtractIo = {
      ...nodeIo,
      readFile: async (p) => {
        reads += 1;
        // the 2nd read is the guard just before the parent is replaced
        if (reads === 2) await fs.writeFile(parentPath, `${PARENT}\n<!-- edited -->\n`);
        return nodeIo.readFile(p);
      },
    };
    const r = await run({}, io);
    expect(r.ok).toBe(false);
    expect(await fs.readFile(parentPath, "utf-8")).toBe(`${PARENT}\n<!-- edited -->\n`);
    await expect(fs.stat(path.join(root, "flights-step"))).rejects.toThrow();
  });

  it("says so when the rollback itself could not remove something", async () => {
    await put("trip-plan/recipe.md", PARENT);
    // fail the parent rename, then every unlink the rollback attempts
    let renames = 0;
    const io: ExtractIo = {
      ...nodeIo,
      rename: async (a, b) => {
        renames += 1;
        if (renames === 2) throw new Error("injected parent rename failure");
        return nodeIo.rename(a, b);
      },
      unlink: async () => {
        throw new Error("injected unlink failure");
      },
    };
    const r = await run({}, io);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refused.join(" | ")).toMatch(/rollback left problems/);
  });

  it("leaves no staging file behind after a success", async () => {
    await put("trip-plan/recipe.md", PARENT);
    expect((await run()).ok).toBe(true);
    expect((await tree(tmp)).includes(".tmp")).toBe(false);
  });
});
