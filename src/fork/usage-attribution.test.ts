/**
 * FORK 2026-09-29 — tests for src/fork/usage-attribution.ts (plan
 * 2026-09-29-chat-usage-chips-and-typed-outcomes, unit U6).
 *
 * Every case runs against createUsageRegistry over a mkdtemp fixture, so the rules are proven on
 * real files: skill dirs hold a SKILL.md, recipes are .md files under a recipe root.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attributeToolUsage,
  createUsageRegistry,
  getUsageRegistry,
  isUsageMark,
  mergeUsageMarks,
  type UsageMark,
  type UsageRegistry,
} from "./usage-attribution.js";

let tmp = "";
let home = "";
let wsSkills = "";
let recipes = "";
let reg: UsageRegistry;

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const PLUGIN_MANIFEST = "/plugins/memory-core/openclaw.plugin.json";

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "usage-attribution-")));
  home = path.join(tmp, "home");
  wsSkills = path.join(tmp, "ws", "skills");
  recipes = path.join(tmp, "recipes");
  write(path.join(home, ".claude/skills/foo/SKILL.md"), "---\nname: foo\n---\n# Foo\n");
  write(path.join(home, ".claude/skills/human-voice/SKILL.md"), "---\nname: human-voice\n---\n");
  write(path.join(home, ".claude/skills/human-voice/scripts/voicecheck.py"), "print(1)\n");
  write(path.join(home, ".claude/skills/odd-dir/SKILL.md"), "---\nname: odd-name\n---\n");
  write(path.join(home, ".claude/skills/not-a-skill/readme.txt"), "no SKILL.md here\n");
  write(
    path.join(
      home,
      ".claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills/brainstorming/SKILL.md",
    ),
    "---\nname: brainstorming\n---\n",
  );
  write(path.join(wsSkills, "bar/SKILL.md"), "---\nname: bar\n---\n");
  write(path.join(recipes, "CATALOG.md"), "# Catalog\n");
  write(path.join(recipes, "README.md"), "# Readme\n");
  write(path.join(recipes, "AUTHORING.md"), "# How to author a recipe\n");
  write(path.join(recipes, "coding/readme.md"), "# Coding recipes\n");
  write(
    path.join(recipes, "clean-public-push/recipe.md"),
    '---\nslug: "clean-public-push"\ntitle: "Clean public push"\n---\n# Heading loses to title\n',
  );
  write(path.join(recipes, "my-recipe/recipe.md"), "no frontmatter, no heading\n");
  write(path.join(recipes, "coding/debug.md"), "---\nslug: debug-flow\n---\n\n# Debug a failure\n");
  reg = createUsageRegistry({
    skillRoots: [
      path.join(home, ".claude/skills"),
      path.join(home, ".claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills"),
      wsSkills,
    ],
    recipeRoots: [recipes],
    pluginToolOwner: (tool) =>
      tool === "browser"
        ? { pluginId: "browser" }
        : tool === "memory_search"
          ? { pluginId: "memory-core", path: PLUGIN_MANIFEST }
          : undefined,
  });
});

afterAll(() => {
  if (tmp) {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

const opts = () => ({ homeDir: home, cwd: tmp });
const skill = (name: string, via: UsageMark["via"], file?: string): UsageMark => ({
  kind: "skill",
  name,
  ...(file ? { path: file } : {}),
  via,
});
const bash = (command: string) =>
  attributeToolUsage({ name: "Bash", args: { command } }, reg, opts());

describe("attributeToolUsage — read", () => {
  it("read of <root>/skills/<n>/SKILL.md → skill <n> with its path", () => {
    const file = path.join(wsSkills, "bar/SKILL.md");
    expect(attributeToolUsage({ name: "read", args: { path: file } }, reg, opts())).toEqual([
      skill("bar", "read", file),
    ]);
  });

  it("Read with file_path carries the toolCallId", () => {
    const file = path.join(home, ".claude/skills/foo/SKILL.md");
    expect(
      attributeToolUsage(
        { name: "Read", args: { file_path: file }, toolCallId: "tc1" },
        reg,
        opts(),
      ),
    ).toEqual([{ ...skill("foo", "read", file), toolCallId: "tc1" }]);
  });

  it("expands ~ against homeDir", () => {
    expect(
      attributeToolUsage(
        { name: "read", args: { path: "~/.claude/skills/foo/SKILL.md" } },
        reg,
        opts(),
      ),
    ).toEqual([skill("foo", "read", path.join(home, ".claude/skills/foo/SKILL.md"))]);
  });

  it("resolves a relative path against cwd", () => {
    expect(
      attributeToolUsage({ name: "Read", args: { file_path: "skills/foo/SKILL.md" } }, reg, {
        homeDir: home,
        cwd: path.join(home, ".claude"),
      }),
    ).toEqual([skill("foo", "read", path.join(home, ".claude/skills/foo/SKILL.md"))]);
  });

  it("names a Claude plugin-cache skill <plugin>:<skill>", () => {
    const file = path.join(
      home,
      ".claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills/brainstorming/SKILL.md",
    );
    expect(attributeToolUsage({ name: "Read", args: { file_path: file } }, reg, opts())).toEqual([
      skill("superpowers:brainstorming", "read", file),
    ]);
  });

  it("a file in a directory without SKILL.md is not a skill", () => {
    const file = path.join(home, ".claude/skills/not-a-skill/readme.txt");
    expect(attributeToolUsage({ name: "Read", args: { file_path: file } }, reg, opts())).toEqual(
      [],
    );
  });

  it("read of a recipe .md → recipe titled by frontmatter, else first heading", () => {
    const file = path.join(recipes, "clean-public-push/recipe.md");
    expect(attributeToolUsage({ name: "read", args: { path: file } }, reg, opts())).toEqual([
      { kind: "recipe", name: "Clean public push", path: file, via: "read" },
    ]);
    const debug = path.join(recipes, "coding/debug.md");
    expect(attributeToolUsage({ name: "Read", args: { file_path: debug } }, reg, opts())).toEqual([
      { kind: "recipe", name: "Debug a failure", path: debug, via: "read" },
    ]);
  });

  it("library docs (CATALOG, README, AUTHORING, any case) are not recipes", () => {
    for (const doc of ["CATALOG.md", "README.md", "AUTHORING.md", "coding/readme.md"]) {
      const file = path.join(recipes, doc);
      expect(attributeToolUsage({ name: "read", args: { path: file } }, reg, opts())).toEqual([]);
    }
  });

  it("a .md outside every recipe root is not a recipe", () => {
    const file = write(path.join(tmp, "notes/todo.md"), "# Todo\n");
    expect(attributeToolUsage({ name: "Read", args: { file_path: file } }, reg, opts())).toEqual(
      [],
    );
  });

  it("prefrontal's library read from another checkout is still a recipe", () => {
    const lib = path.join(tmp, "other-checkout/extensions/tinkerclaw-prefrontal/recipes");
    const file = write(path.join(lib, "ship-it/recipe.md"), "---\ntitle: Ship it\n---\n");
    expect(attributeToolUsage({ name: "Read", args: { file_path: file } }, reg, opts())).toEqual([
      { kind: "recipe", name: "Ship it", path: file, via: "read" },
    ]);
    const catalog = write(path.join(lib, "CATALOG.md"), "# Catalog\n");
    expect(attributeToolUsage({ name: "Read", args: { file_path: catalog } }, reg, opts())).toEqual(
      [],
    );
  });
});

describe("attributeToolUsage — exec (D1)", () => {
  it("sed -n on a SKILL.md → skill via exec, under every exec alias", () => {
    const expected = [skill("foo", "exec", path.join(home, ".claude/skills/foo/SKILL.md"))];
    expect(bash("sed -n 1,80p ~/.claude/skills/foo/SKILL.md")).toEqual(expected);
    for (const name of ["bash", "exec", "shell"]) {
      expect(
        attributeToolUsage(
          { name, args: { command: 'head -40 "$HOME/.claude/skills/foo/SKILL.md"' } },
          reg,
          opts(),
        ),
      ).toEqual(expected);
    }
  });

  it("a script run inside a skill dir → that skill", () => {
    const skillMd = path.join(home, ".claude/skills/human-voice/SKILL.md");
    expect(bash("python3 ~/.claude/skills/human-voice/scripts/voicecheck.py x")).toEqual([
      skill("human-voice", "exec", skillMd),
    ]);
    expect(
      bash("cd ~/.claude/skills/human-voice && python3 scripts/voicecheck.py draft.txt"),
    ).toEqual([skill("human-voice", "exec", skillMd)]);
    expect(
      attributeToolUsage(
        {
          name: "exec",
          args: {
            command: "python3 scripts/voicecheck.py x",
            workdir: "~/.claude/skills/human-voice",
          },
        },
        reg,
        opts(),
      ),
    ).toEqual([skill("human-voice", "exec", skillMd)]);
  });

  it("listing or grepping the skills root draws no chip storm", () => {
    expect(bash("ls ~/.claude/skills")).toEqual([]);
    expect(bash("grep -r x ~/.claude/skills/")).toEqual([]);
    expect(bash("cat ~/.claude/skills/*/SKILL.md")).toEqual([]);
    expect(bash("find ~/.claude/skills -name SKILL.md")).toEqual([]);
    expect(bash("ls ~/.claude/skills/foo/")).toEqual([]);
  });

  it("write-shaped commands are skipped", () => {
    expect(bash("sed -i s/a/b/ ~/.claude/skills/foo/SKILL.md")).toEqual([]);
    expect(bash("echo hi > ~/.claude/skills/foo/notes.md")).toEqual([]);
    expect(bash("printf x | tee ~/.claude/skills/foo/SKILL.md")).toEqual([]);
    expect(bash("git -C ~/.claude/skills/foo add SKILL.md")).toEqual([]);
    expect(bash("rm ~/.claude/skills/foo/SKILL.md")).toEqual([]);
  });

  it("a read before a redirect still counts; the redirect target does not", () => {
    expect(bash("cat ~/.claude/skills/foo/SKILL.md > /tmp/copy.md 2>&1")).toEqual([
      skill("foo", "exec", path.join(home, ".claude/skills/foo/SKILL.md")),
    ]);
  });

  it("a recipe .md token → recipe; CATALOG.md → nothing", () => {
    const file = path.join(recipes, "clean-public-push/recipe.md");
    expect(bash(`cat "${file}"`)).toEqual([
      { kind: "recipe", name: "Clean public push", path: file, via: "exec" },
    ]);
    expect(bash(`cat ${path.join(recipes, "CATALOG.md")}`)).toEqual([]);
  });

  it("recipe-state <sub> <slug> and --recipe <slug> → recipe via recipe-cli", () => {
    expect(bash("recipe-state next my-recipe")).toEqual([
      {
        kind: "recipe",
        name: "my-recipe",
        path: path.join(recipes, "my-recipe/recipe.md"),
        via: "recipe-cli",
      },
    ]);
    expect(
      bash("node scripts/openclaw-recipe-state.mjs --recipe clean-public-push --step 2"),
    ).toEqual([
      {
        kind: "recipe",
        name: "Clean public push",
        path: path.join(recipes, "clean-public-push/recipe.md"),
        via: "recipe-cli",
      },
    ]);
    expect(bash("recipe-state next unknown-recipe")).toEqual([
      { kind: "recipe", name: "unknown-recipe", via: "recipe-cli" },
    ]);
  });
});

describe("attributeToolUsage — Skill tool, MCP, plugin tools", () => {
  it("Skill → skill mark with path when registered, without path when not", () => {
    expect(
      attributeToolUsage({ name: "Skill", args: { skill: "human-voice" } }, reg, opts()),
    ).toEqual([
      skill("human-voice", "skill-tool", path.join(home, ".claude/skills/human-voice/SKILL.md")),
    ]);
    const unknown = attributeToolUsage(
      { name: "Skill", args: { skill: "claude-api" } },
      reg,
      opts(),
    );
    expect(unknown).toEqual([skill("claude-api", "skill-tool")]);
    expect("path" in unknown[0]).toBe(false);
    expect(
      attributeToolUsage(
        { name: "Skill", args: { skill: "superpowers:brainstorming" } },
        reg,
        opts(),
      ),
    ).toEqual([
      skill(
        "superpowers:brainstorming",
        "skill-tool",
        path.join(
          home,
          ".claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills/brainstorming/SKILL.md",
        ),
      ),
    ]);
  });

  it("jarvis-recipe <slug> → skill + recipe marks", () => {
    expect(
      attributeToolUsage(
        {
          name: "Skill",
          args: { skill: "jarvis-recipe", args: "clean-public-push — extra notes" },
        },
        reg,
        opts(),
      ),
    ).toEqual([
      skill("jarvis-recipe", "skill-tool"),
      {
        kind: "recipe",
        name: "Clean public push",
        path: path.join(recipes, "clean-public-push/recipe.md"),
        via: "recipe-skill",
      },
    ]);
  });

  it("mcp__<server>__<tool> → the owning plugin, else the server", () => {
    expect(attributeToolUsage({ name: "mcp__jarvis__browser" }, reg, opts())).toEqual([
      { kind: "plugin", name: "browser", via: "mcp" },
    ]);
    expect(attributeToolUsage({ name: "mcp__claude_ai_Gmail__search" }, reg, opts())).toEqual([
      { kind: "plugin", name: "claude_ai_Gmail", via: "mcp" },
    ]);
  });

  it("a plugin-owned embedded tool → plugin mark via plugin-tool", () => {
    expect(attributeToolUsage({ name: "memory_search", args: {} }, reg, opts())).toEqual([
      { kind: "plugin", name: "memory-core", path: PLUGIN_MANIFEST, via: "plugin-tool" },
    ]);
  });

  it("an unknown or core tool → []", () => {
    expect(
      attributeToolUsage({ name: "web_fetch", args: { url: "https://x" } }, reg, opts()),
    ).toEqual([]);
    expect(
      attributeToolUsage({ name: "Grep", args: { path: "~/.claude/skills/foo" } }, reg, opts()),
    ).toEqual([]);
  });

  it("never throws on garbage", () => {
    const throwing: UsageRegistry = {
      skillDirByName: () => {
        throw new Error("boom");
      },
      recipeByPath: () => {
        throw new Error("boom");
      },
      recipeBySlug: () => {
        throw new Error("boom");
      },
      pluginForTool: () => {
        throw new Error("boom");
      },
      isRecipePath: () => {
        throw new Error("boom");
      },
    };
    const calls: unknown[] = [
      null,
      undefined,
      42,
      { name: 42 },
      { name: "Bash", args: { command: 42 } },
      { name: "Bash", args: "not json" },
      { name: "Read", args: ["array"] },
      { name: "Skill", args: { skill: { nested: true } } },
      { name: "mcp__" },
      { name: "Skill", args: { skill: "x" } },
    ];
    for (const call of calls) {
      expect(() => attributeToolUsage(call as never, reg, opts())).not.toThrow();
      expect(attributeToolUsage(call as never, throwing, opts())).toEqual([]);
    }
  });

  it("accepts JSON-string args", () => {
    expect(
      attributeToolUsage(
        { name: "Read", args: JSON.stringify({ file_path: "~/.claude/skills/foo/SKILL.md" }) },
        reg,
        opts(),
      ),
    ).toEqual([skill("foo", "read", path.join(home, ".claude/skills/foo/SKILL.md"))]);
  });
});

describe("a registry without the optional isSkillDir", () => {
  const fake = (dirs: Record<string, string>): UsageRegistry => ({
    skillDirByName: (name) => dirs[name],
    recipeByPath: () => undefined,
    recipeBySlug: () => undefined,
    pluginForTool: () => undefined,
    isRecipePath: () => false,
  });

  it("falls back to the SKILL.md shape, or to skillDirByName naming this exact directory", () => {
    const o = { homeDir: "/h", cwd: "/" };
    expect(
      attributeToolUsage(
        { name: "Read", args: { file_path: "/x/skills/foo/SKILL.md" } },
        fake({}),
        o,
      ),
    ).toEqual([skill("foo", "read", "/x/skills/foo/SKILL.md")]);
    const run = { name: "Bash", args: { command: "python3 /x/skills/foo/scripts/a.py" } };
    expect(attributeToolUsage(run, fake({ foo: "/x/skills/foo" }), o)).toEqual([
      skill("foo", "exec", "/x/skills/foo/SKILL.md"),
    ]);
    expect(attributeToolUsage(run, fake({ foo: "/elsewhere/skills/foo" }), o)).toEqual([]);
    expect(attributeToolUsage(run, fake({}), o)).toEqual([]);
  });
});

describe("mergeUsageMarks / isUsageMark", () => {
  it("dedupes by kind+name and prefers the mark with a path", () => {
    const bare = skill("foo", "skill-tool");
    const linked = skill("foo", "read", "/x/skills/foo/SKILL.md");
    const recipe: UsageMark = { kind: "recipe", name: "foo", via: "recipe-cli" };
    expect(mergeUsageMarks([bare, recipe], [linked])).toEqual([linked, recipe]);
    expect(mergeUsageMarks([linked], [bare])).toEqual([linked]);
    expect(mergeUsageMarks([bare, bare], [])).toEqual([bare]);
  });

  it("drops entries that are not marks", () => {
    expect(
      mergeUsageMarks([{ kind: "skill" } as never, skill("a", "exec")], null as never),
    ).toEqual([skill("a", "exec")]);
  });

  it("isUsageMark guards shape", () => {
    expect(isUsageMark(skill("a", "read"))).toBe(true);
    expect(
      isUsageMark({ kind: "plugin", name: "p", via: "mcp", path: "/m.json", toolCallId: "t" }),
    ).toBe(true);
    expect(isUsageMark(null)).toBe(false);
    expect(isUsageMark({ kind: "tool", name: "a", via: "read" })).toBe(false);
    expect(isUsageMark({ kind: "skill", name: " ", via: "read" })).toBe(false);
    expect(isUsageMark({ kind: "skill", name: "a" })).toBe(false);
    expect(isUsageMark({ kind: "skill", name: "a", via: "read", path: 3 })).toBe(false);
  });
});

describe("createUsageRegistry", () => {
  it("resolves skills by dir name, plugin prefix and frontmatter name", () => {
    expect(reg.skillDirByName("foo")).toBe(path.join(home, ".claude/skills/foo"));
    expect(reg.skillDirByName("superpowers:brainstorming")).toBe(
      path.join(
        home,
        ".claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills/brainstorming",
      ),
    );
    expect(reg.skillDirByName("odd-name")).toBe(path.join(home, ".claude/skills/odd-dir"));
    expect(reg.skillDirByName("brainstorming")).toBeUndefined();
    expect(reg.skillDirByName("not-a-skill")).toBeUndefined();
  });

  it("finds recipes by derived and declared slug, and by path", () => {
    expect(reg.recipeBySlug("my-recipe")).toEqual({
      title: "my-recipe",
      path: path.join(recipes, "my-recipe/recipe.md"),
    });
    expect(reg.recipeBySlug("debug-flow")?.path).toBe(path.join(recipes, "coding/debug.md"));
    expect(reg.recipeBySlug("globalcaos/clean-public-push")?.title).toBe("Clean public push");
    expect(reg.recipeBySlug("nope")).toBeUndefined();
    expect(reg.isRecipePath(path.join(recipes, "CATALOG.md"))).toBe(false);
    expect(reg.isRecipePath(path.join(tmp, "elsewhere.md"))).toBe(false);
  });

  it("lists every skill and recipe it can resolve, with the names a mark carries", () => {
    const listing = reg.list?.() ?? [];
    const names = (kind: "skill" | "recipe") =>
      listing
        .filter((l) => l.kind === kind)
        .map((l) => l.name)
        .toSorted();
    expect(names("skill")).toEqual([
      "bar",
      "foo",
      "human-voice",
      "odd-dir",
      "superpowers:brainstorming",
    ]);
    expect(names("recipe")).toEqual(["Clean public push", "Debug a failure", "my-recipe"]);
    expect(listing.find((l) => l.name === "foo")?.path).toBe(
      path.join(home, ".claude/skills/foo/SKILL.md"),
    );
    expect(listing.find((l) => l.name === "Clean public push")?.path).toBe(
      path.join(recipes, "clean-public-push/recipe.md"),
    );
  });

  it("lists nothing that attribution would not name: a directory with no SKILL.md, CATALOG, README", () => {
    const all = (reg.list?.() ?? []).map((l) => l.name);
    expect(all).not.toContain("not-a-skill");
    expect(all.some((n) => /catalog|readme|authoring/i.test(n))).toBe(false);
  });

  it("puts the same name on the listing as on the mark", () => {
    for (const l of reg.list?.() ?? []) {
      if (l.kind !== "skill") continue;
      const marks = attributeToolUsage({ name: "Read", args: { file_path: l.path } }, reg, opts());
      expect(marks[0]?.name, l.name).toBe(l.name);
    }
  });

  it("lists a first-wins duplicate once", () => {
    const dup = createUsageRegistry({
      skillRoots: [path.join(home, ".claude/skills"), path.join(home, ".claude/skills")],
      recipeRoots: [],
    });
    const names = (dup.list?.() ?? []).map((l) => l.name);
    expect(names.filter((n) => n === "foo")).toHaveLength(1);
  });

  it("lists plugins that register tools, once each, after the skills and recipes", () => {
    const manifest = write(path.join(tmp, "plugins/alpha/openclaw.plugin.json"), '{"id":"alpha"}');
    const withPlugins = createUsageRegistry({
      skillRoots: [path.join(home, ".claude/skills")],
      recipeRoots: [],
      pluginList: () => [
        { pluginId: "alpha", path: manifest },
        { pluginId: "alpha", path: manifest },
        { pluginId: "beta" },
      ],
    });
    const listing = withPlugins.list?.() ?? [];
    const plugins = listing.filter((l) => l.kind === "plugin");
    expect(plugins).toEqual([
      { kind: "plugin", name: "alpha", path: manifest },
      { kind: "plugin", name: "beta", path: "" },
    ]);
    expect(listing.findIndex((l) => l.kind === "plugin")).toBeGreaterThan(
      listing.findIndex((l) => l.kind === "skill"),
    );
  });

  it("puts on a plugin the name a tool call of that plugin carries", () => {
    const owner = createUsageRegistry({
      skillRoots: [],
      recipeRoots: [],
      pluginToolOwner: (t) => (t === "browser" ? { pluginId: "browser" } : undefined),
      pluginList: () => [{ pluginId: "browser" }],
    });
    const marks = attributeToolUsage({ name: "browser", args: {} }, owner, opts());
    expect(marks.map((m) => `${m.kind}:${m.name}`)).toEqual(["plugin:browser"]);
    expect((owner.list?.() ?? []).map((l) => `${l.kind}:${l.name}`)).toContain("plugin:browser");
  });

  it("attributes exactly as before: a plugin list changes no lookup and no mark", () => {
    const base = {
      skillRoots: [path.join(home, ".claude/skills"), wsSkills],
      recipeRoots: [recipes],
      pluginToolOwner: (t: string) => (t === "browser" ? { pluginId: "browser" } : undefined),
    };
    const without = createUsageRegistry(base);
    const withList = createUsageRegistry({
      ...base,
      pluginList: () => [{ pluginId: "browser" }, { pluginId: "other" }],
    });
    const calls = [
      { name: "Read", args: { file_path: path.join(home, ".claude/skills/foo/SKILL.md") } },
      { name: "Read", args: { path: path.join(wsSkills, "bar/SKILL.md") } },
      {
        name: "Bash",
        args: { command: `cat ${path.join(recipes, "clean-public-push/recipe.md")}` },
      },
      { name: "browser", args: {} },
      { name: "Bash", args: { command: "ls -la" } },
      { name: "Grep", args: { pattern: "x" } },
    ];
    for (const c of calls) {
      expect(attributeToolUsage(c, withList, opts()), c.name).toEqual(
        attributeToolUsage(c, without, opts()),
      );
    }
    expect(withList.skillDirByName("foo")).toBe(without.skillDirByName("foo"));
    expect(withList.recipeBySlug("my-recipe")).toEqual(without.recipeBySlug("my-recipe"));
    expect((withList.list?.() ?? []).filter((l) => l.kind !== "plugin")).toEqual(
      without.list?.() ?? [],
    );
  });

  it("loses the plugin entries, not the skills, when the plugin list throws", () => {
    const broken = createUsageRegistry({
      skillRoots: [path.join(home, ".claude/skills")],
      recipeRoots: [],
      pluginList: () => {
        throw new Error("registry not ready");
      },
    });
    const kinds = new Set((broken.list?.() ?? []).map((l) => l.kind));
    expect(kinds.has("skill")).toBe(true);
    expect(kinds.has("plugin")).toBe(false);
  });

  it("lists nothing for a registry with no roots", () => {
    expect(createUsageRegistry({ skillRoots: [], recipeRoots: [] }).list?.()).toEqual([]);
  });

  it("caches the SKILL.md probe (no fs hit on a repeat)", () => {
    const dir = path.join(tmp, "cache-probe/skills/tmp-skill");
    write(path.join(dir, "SKILL.md"), "x");
    const local = createUsageRegistry({ skillRoots: [], recipeRoots: [] });
    expect(local.isSkillDir?.(dir)).toBe(true);
    fs.rmSync(path.join(dir, "SKILL.md"));
    expect(local.isSkillDir?.(dir)).toBe(true);
  });
});

describe("getUsageRegistry", () => {
  it("is cached and never throws", () => {
    const a = getUsageRegistry();
    expect(getUsageRegistry()).toBe(a);
    expect(() => a.skillDirByName("definitely-not-a-skill-xyz")).not.toThrow();
    expect(a.pluginForTool("definitely-not-a-tool-xyz")).toBeUndefined();
    expect(a.isRecipePath("/nowhere/x.md")).toBe(false);
  });
});
