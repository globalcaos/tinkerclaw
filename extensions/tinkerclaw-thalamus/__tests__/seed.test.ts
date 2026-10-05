import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Integration only: the core registry is what production seeds from.
import { createUsageRegistry } from "../../../src/fork/usage-attribution.js";
import {
  listingWithText,
  manifestDescription,
  parseFrontmatter,
  readHead,
  seedFromRegistry,
} from "../src/reads/seed.js";

let tmp = "";
const write = (rel: string, text: string) => {
  const file = join(tmp, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "thalamus-seed-"));
  write(
    "skills/pdf-tools/SKILL.md",
    "---\nname: pdf-tools\ndescription: Extract text and tables from a PDF.\n---\n# PDF\n",
  );
  write(
    "skills/folded/SKILL.md",
    "---\nname: folded\ndescription: >\n  A long description\n  over two lines.\n---\n",
  );
  write("skills/bare/SKILL.md", "no frontmatter at all\n");
  write(
    "recipes/review/recipe.md",
    '---\nslug: "review"\ntitle: "Adversarial review"\nsummary: "Review a diff with fresh context."\ntags:\n  [\n    "review",\n    "code review",\n    "PR review"\n  ]\n---\n# Heading\n',
  );
  write(
    "recipes/dash/recipe.md",
    "---\ntitle: Dashed\ntriggers:\n  - first trigger\n  - second trigger\n---\n",
  );
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("frontmatter", () => {
  it("reads plain, quoted, folded and bracketed values", () => {
    const fm = parseFrontmatter(
      '---\na: plain text\nb: "quoted"\nc: >\n  folded\n  text\nd: [x, "y z"]\ne:\n  - one\n  - two\n---\nbody',
    );
    expect(fm).toEqual({
      a: "plain text",
      b: "quoted",
      c: "folded text",
      d: ["x", "y z"],
      e: ["one", "two"],
    });
  });

  it("reads a multi-line bracketed list", () => {
    expect(parseFrontmatter('---\ntags:\n  [\n    "a b",\n    "c"\n  ]\n---\n').tags).toEqual([
      "a b",
      "c",
    ]);
  });

  it("returns nothing when there is no block", () => {
    expect(parseFrontmatter("# just a heading")).toEqual({});
    expect(parseFrontmatter("")).toEqual({});
  });

  it("reads only the head of a file, and nothing from a missing one", () => {
    expect(readHead(join(tmp, "skills/pdf-tools/SKILL.md"))).toContain("Extract text");
    expect(readHead(join(tmp, "nope.md"))).toBeUndefined();
  });
});

describe("seeding from the registry", () => {
  const reg = () =>
    createUsageRegistry({ skillRoots: [join(tmp, "skills")], recipeRoots: [join(tmp, "recipes")] });

  it("makes a card for every skill and recipe the registry lists, with the text from the files", () => {
    const cards = seedFromRegistry(reg().list?.() ?? []);
    const byId = new Map(cards.map((c) => [c.id, c]));
    expect(byId.get("skill:pdf-tools")).toMatchObject({
      purpose: "Extract text and tables from a PDF.",
      family: "documents",
      version: 1,
      origin: "seed",
    });
    expect(byId.get("skill:folded")?.purpose).toBe("A long description over two lines.");
    expect(byId.get("skill:bare")?.purpose).toBe("bare");
    expect(byId.get("recipe:Adversarial review")?.purpose).toBe(
      "Review a diff with fresh context. Triggers: review; code review; PR review",
    );
    expect(byId.get("recipe:Dashed")?.purpose).toContain("Triggers: first trigger; second trigger");
    expect(cards).toHaveLength(5);
  });

  it("names cards the way a mark names them, so a use lines up with its card", () => {
    const r = reg();
    for (const l of r.list?.() ?? []) {
      const cards = seedFromRegistry([l]);
      expect(cards[0].id).toBe(`${l.kind}:${l.name}`);
    }
  });

  it("still seeds a file that cannot be read, by name", () => {
    const list = listingWithText([{ kind: "skill", name: "ghost", path: "/no/such/SKILL.md" }]);
    expect(list).toEqual([
      { kind: "skill", name: "ghost", path: "/no/such/SKILL.md", description: undefined },
    ]);
    expect(
      seedFromRegistry([{ kind: "skill", name: "ghost", path: "/no/such/SKILL.md" }])[0].purpose,
    ).toBe("ghost");
  });

  it("caps the triggers of a recipe", () => {
    const tags = Array.from({ length: 40 }, (_, i) => `"t${i}"`).join(", ");
    const [l] = listingWithText(
      [{ kind: "recipe", name: "r", path: "x" }],
      () => `---\ntags: [${tags}]\n---\n`,
    );
    expect(l.triggers).toHaveLength(12);
  });
});

describe("seeding a plugin", () => {
  it("reads the description from the manifest, even past the head of a long file", () => {
    expect(
      manifestDescription(
        '{"id":"x","description":"Digital thing that \\"quotes\\" and works.","configSchema":{}}',
      ),
    ).toBe('Digital thing that "quotes" and works.');
    expect(manifestDescription("{}")).toBeUndefined();
    expect(manifestDescription(undefined)).toBeUndefined();
  });

  it("makes a plugin card named by the plugin id, with its manifest as the path", () => {
    const [c] = seedFromRegistry(
      [{ kind: "plugin", name: "memory-core", path: "/p/openclaw.plugin.json" }],
      () => '{"description":"Searches long-term memory."}',
    );
    expect(c).toMatchObject({
      id: "plugin:memory-core",
      kind: "plugin",
      purpose: "Searches long-term memory.",
      path: "/p/openclaw.plugin.json",
    });
  });

  it("still seeds a plugin with no manifest on disk, by name", () => {
    const [c] = seedFromRegistry([{ kind: "plugin", name: "bare", path: "" }]);
    expect(c.purpose).toBe("bare");
    expect(c.path).toBeUndefined();
  });
});
