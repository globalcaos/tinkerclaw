import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createRecipeArchive } from "../../src/memory/engram/recipe-archive.js";
import { createInitialRecipeFitness, laplace } from "../../src/memory/engram/recipe-fitness.js";
import { createMarketplace, type MarketplaceMeta } from "./recipe-marketplace.js";
import * as kitMatcher from "./recipe-matcher.js";
import { createRecipeRpcs, inferCategory, parseKitMd } from "./recipe-rpcs.js";
import * as kitRunner from "./recipe-runner.js";
import { RecipeStore } from "./recipe-store.js";

// callGateway is the loopback seam the recipe.run onTag forwards through. Mock it
// so the producer test asserts the forward WITHOUT a live gateway.
const callGatewaySpy = vi.fn().mockResolvedValue({ ok: true });
vi.mock("../../src/gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewaySpy(...args),
}));

describe("recipe-rpcs", () => {
  let mock: MockAgent;
  let original: Dispatcher;
  let store: RecipeStore;
  let root: string;
  let ownRecipesDir: string;

  beforeEach(() => {
    original = getGlobalDispatcher();
    mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-kr-"));
    store = new RecipeStore({ rootDir: root });
    ownRecipesDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-own-"));
  });
  afterEach(() => {
    setGlobalDispatcher(original);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(ownRecipesDir, { recursive: true, force: true });
  });

  it("prefrontal.recipe.search returns parsed results (flat array shape)", async () => {
    mock
      .get("https://www.journeykits.ai")
      .intercept({ path: "/api/kits/search?q=feature", method: "GET" })
      .reply(200, [
        {
          kitRef: "globalcaos/feature",
          title: "Build Feature",
          summary: "s",
          tags: [],
          owner: "globalcaos",
          updatedAt: "2026-05-13T00:00:00Z",
        },
      ]);

    const rpcs = createRecipeRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      recipeInstallSandbox: store.rootDirPublic(),
      ownRecipesDir,
    });
    const res = await rpcs["prefrontal.recipe.search"]({ query: "feature" });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].kitRef).toBe("globalcaos/feature");
  });

  it("prefrontal.recipe.search dedupes by kitRef keeping highest releaseTag", async () => {
    mock
      .get("https://www.journeykits.ai")
      .intercept({ path: "/api/kits/search?q=feature", method: "GET" })
      .reply(200, [
        {
          kitRef: "globalcaos/feature",
          title: "Build Feature v1",
          releaseTag: "1.0.0",
          owner: "globalcaos",
        },
        {
          kitRef: "globalcaos/feature",
          title: "Build Feature v3 (latest)",
          releaseTag: "3.0.0",
          owner: "globalcaos",
        },
        {
          kitRef: "globalcaos/feature",
          title: "Build Feature v2",
          releaseTag: "2.0.0",
          owner: "globalcaos",
        },
      ]);

    const rpcs = createRecipeRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      recipeInstallSandbox: store.rootDirPublic(),
      ownRecipesDir,
    });
    const res = await rpcs["prefrontal.recipe.search"]({ query: "feature" });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].releaseTag).toBe("3.0.0");
    expect(res.results[0].title).toBe("Build Feature v3 (latest)");
  });

  it("prefrontal.recipe.get returns the kit", async () => {
    mock
      .get("https://www.journeykits.ai")
      .intercept({ path: "/api/kits/globalcaos/feature", method: "GET" })
      .reply(200, { slug: "feature", title: "Build Feature" });
    const rpcs = createRecipeRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      recipeInstallSandbox: store.rootDirPublic(),
      ownRecipesDir,
    });
    const res = await rpcs["prefrontal.recipe.get"]({ kitRef: "globalcaos/feature" });
    expect(res.kit.slug).toBe("feature");
  });

  it("prefrontal.recipe.install refuses Critical-risk kits unless allowRisky=true", async () => {
    mock
      .get("https://www.journeykits.ai")
      .intercept({ path: "/api/kits/foo/bar/install?target=openclaw&ref=latest", method: "GET" })
      .reply(200, {
        suggestedRootDir: "foo/bar/",
        files: [{ path: "kit.md", content: "hello", writeMode: "overwrite" }],
        preflightChecks: [],
        nextSteps: [],
        verification: null,
        risk: [{ source: "snyk", level: "Critical", alertCount: 3 }],
      });
    const rpcs = createRecipeRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      recipeInstallSandbox: store.rootDirPublic(),
      ownRecipesDir,
    });
    await expect(rpcs["prefrontal.recipe.install"]({ kitRef: "foo/bar" })).rejects.toThrow(
      /risk|Critical/,
    );
  });

  it("prefrontal.recipe.install rejects file entries that escape the sandbox", async () => {
    mock
      .get("https://www.journeykits.ai")
      .intercept({ path: "/api/kits/foo/bar/install?target=openclaw&ref=latest", method: "GET" })
      .reply(200, {
        suggestedRootDir: "foo/bar/",
        files: [{ path: "../../escape.txt", content: "bad", writeMode: "overwrite" }],
        preflightChecks: [],
        nextSteps: [],
        verification: null,
        risk: [{ source: "snyk", level: "Safe" }],
      });
    const rpcs = createRecipeRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      recipeInstallSandbox: store.rootDirPublic(),
      ownRecipesDir,
    });
    await expect(rpcs["prefrontal.recipe.install"]({ kitRef: "foo/bar" })).rejects.toThrow(
      /escapes sandbox/,
    );
  });

  it("prefrontal.recipe.install with allowRisky writes files when risk is High", async () => {
    mock
      .get("https://www.journeykits.ai")
      .intercept({ path: "/api/kits/foo/bar/install?target=openclaw&ref=latest", method: "GET" })
      .reply(200, {
        suggestedRootDir: "foo/bar/",
        files: [{ path: "kit.md", content: "ok", writeMode: "overwrite" }],
        preflightChecks: [],
        nextSteps: [],
        verification: null,
        risk: [{ source: "snyk", level: "High Risk", alertCount: 1 }],
      });
    const rpcs = createRecipeRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      recipeInstallSandbox: store.rootDirPublic(),
      ownRecipesDir,
    });
    const res = await rpcs["prefrontal.recipe.install"]({ kitRef: "foo/bar", allowRisky: true });
    expect(res.ok).toBe(true);
    expect(res.installedPath).toContain("foo/bar");
    expect(fs.existsSync(path.join(root, "foo/bar/kit.md"))).toBe(true);
  });

  it("prefrontal.recipe.install applies p.ref ONLY to the root; transitive composes dep resolves with latest", async () => {
    // Root kit declares a transitive dep via `composes:`. The root install must
    // honour the caller's version constraint (ref=^2.0.0); the transitive dep must
    // NOT inherit it — it resolves with `latest` (its own declared constraint
    // absent). Before the fix, p.ref leaked onto the dep install URL.
    const depInstallHits: string[] = [];
    mock
      .get("https://www.journeykits.ai")
      .intercept({
        path: `/api/kits/globalcaos/root/install?target=openclaw&ref=${encodeURIComponent("^2.0.0")}`,
        method: "GET",
      })
      .reply(200, {
        suggestedRootDir: "globalcaos/root/",
        files: [
          {
            path: "kit.md",
            content:
              "---\nschema: kit/1.0\nslug: root\ncomposes:\n  - globalcaos/leaf\n---\n# root body\n",
            writeMode: "overwrite",
          },
        ],
        preflightChecks: [],
        nextSteps: [],
        risk: [{ source: "snyk", level: "Safe" }],
      });
    mock
      .get("https://www.journeykits.ai")
      .intercept({
        path: "/api/kits/globalcaos/leaf/install?target=openclaw&ref=latest",
        method: "GET",
      })
      .reply(200, () => {
        depInstallHits.push("latest");
        return {
          suggestedRootDir: "globalcaos/leaf/",
          files: [
            { path: "kit.md", content: "---\nslug: leaf\n---\n# leaf\n", writeMode: "overwrite" },
          ],
          preflightChecks: [],
          nextSteps: [],
          risk: [{ source: "snyk", level: "Safe" }],
        };
      });

    const rpcs = createRecipeRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      recipeInstallSandbox: store.rootDirPublic(),
      ownRecipesDir,
    });
    const res = await rpcs["prefrontal.recipe.install"]({
      kitRef: "globalcaos/root",
      ref: "^2.0.0",
    });
    expect(res.ok).toBe(true);
    // The transitive dep was fetched with ref=latest (the intercept above only
    // matches that exact path), proving p.ref did NOT leak onto the dep.
    expect(depInstallHits).toEqual(["latest"]);
    expect(res.dependenciesInstalled).toContain("globalcaos/leaf");
  });

  it("prefrontal.recipe.install transitive dep honours its OWN declared constraint (@ in composes)", async () => {
    // A composes dep carrying `@~1.4.0` resolves with that constraint, NOT the root's.
    mock
      .get("https://www.journeykits.ai")
      .intercept({
        path: "/api/kits/globalcaos/root/install?target=openclaw&ref=latest",
        method: "GET",
      })
      .reply(200, {
        suggestedRootDir: "globalcaos/root/",
        files: [
          {
            path: "kit.md",
            content:
              "---\nschema: kit/1.0\nslug: root\ncomposes:\n  - globalcaos/leaf@~1.4.0\n---\n# root\n",
            writeMode: "overwrite",
          },
        ],
        preflightChecks: [],
        nextSteps: [],
        risk: [{ source: "snyk", level: "Safe" }],
      });
    mock
      .get("https://www.journeykits.ai")
      .intercept({
        path: `/api/kits/globalcaos/leaf/install?target=openclaw&ref=${encodeURIComponent("~1.4.0")}`,
        method: "GET",
      })
      .reply(200, {
        suggestedRootDir: "globalcaos/leaf/",
        files: [
          { path: "kit.md", content: "---\nslug: leaf\n---\n# leaf\n", writeMode: "overwrite" },
        ],
        preflightChecks: [],
        nextSteps: [],
        risk: [{ source: "snyk", level: "Safe" }],
      });

    const rpcs = createRecipeRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      recipeInstallSandbox: store.rootDirPublic(),
      ownRecipesDir,
    });
    // The dep intercept only matches ref=~1.4.0; the install resolves cleanly only
    // if the dep's own declared constraint is used (the producer fires correctly).
    const res = await rpcs["prefrontal.recipe.install"]({ kitRef: "globalcaos/root" });
    expect(res.ok).toBe(true);
    expect(res.dependenciesInstalled).toContain("globalcaos/leaf");
  });

  it("prefrontal.recipe.list returns inventory under sandbox", async () => {
    await store.writeKitFiles({
      owner: "globalcaos",
      slug: "feature",
      files: [{ path: "kit.md", content: "x" }],
    });
    const rpcs = createRecipeRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      recipeInstallSandbox: store.rootDirPublic(),
      ownRecipesDir,
    });
    const res = await rpcs["prefrontal.recipe.list"]({});
    expect(res.kits.find((k) => k.kitRef === "globalcaos/feature")).toBeTruthy();
  });

  it("parses YAML block scalar summary correctly", async () => {
    await store.writeKitFiles({
      owner: "test",
      slug: "block-scalar",
      files: [
        {
          path: "kit.md",
          content:
            "---\nschema: kit/1.0\nslug: block-scalar\ntitle: Block Scalar\nsummary: >-\n  Line one of summary\n  continues here.\nversion: 1.0.0\n---\n# body\n",
        },
      ],
    });
    const rpcs = createRecipeRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      recipeInstallSandbox: store.rootDirPublic(),
      ownRecipesDir,
    });
    const res = await rpcs["prefrontal.recipe.list"]({});
    const kit = res.kits.find((k) => k.slug === "block-scalar");
    expect(kit?.summary).toBe("Line one of summary continues here.");
  });

  it("prefrontal.recipe.publish requires apiKey", async () => {
    const rpcs = createRecipeRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      recipeInstallSandbox: store.rootDirPublic(),
      ownRecipesDir,
    });
    await expect(
      rpcs["prefrontal.recipe.publish"]({ slug: "feature", visibility: "public" }),
    ).rejects.toThrow(/apiKey|missing.*key/i);
  });

  it("prefrontal.recipe.publish: a brand-new recipe with NO version frontmatter publishes 1.0.0", async () => {
    // The first publish of a recipe that has no `version:` line must mint 1.0.0
    // (NOT bump a phantom 0.0.0 -> 0.0.1). Assert the version the producer POSTs.
    fs.mkdirSync(path.join(ownRecipesDir, "fresh"), { recursive: true });
    fs.writeFileSync(
      path.join(ownRecipesDir, "fresh", "kit.md"),
      "---\nschema: kit/1.0\nslug: fresh\nowner: globalcaos\n---\n# body\n",
      "utf-8",
    );

    let postedBody: any;
    mock
      .get("https://www.journeykits.ai")
      .intercept({ path: "/api/kits/publish", method: "POST" })
      .reply(200, (opts) => {
        postedBody = JSON.parse(opts.body as string);
        return { ok: true, kitRef: "globalcaos/fresh" };
      });

    const rpcs = createRecipeRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: "test-key",
      recipeInstallSandbox: store.rootDirPublic(),
      ownRecipesDir,
    });
    const res = await rpcs["prefrontal.recipe.publish"]({ slug: "fresh", visibility: "public" });
    expect(res.version).toBe("1.0.0");
    expect(postedBody.version).toBe("1.0.0");
    // The frontmatter shipped in the POST body carries the minted version too.
    expect(postedBody.recipeMd).toContain('version: "1.0.0"');
  });

  it("prefrontal.recipe.publish reads source kit body and POSTs to Journey", async () => {
    fs.mkdirSync(path.join(ownRecipesDir, "feature"), { recursive: true });
    fs.writeFileSync(
      path.join(ownRecipesDir, "feature", "kit.md"),
      "---\nschema: kit/1.0\nslug: feature\n---\n# body\n",
      "utf-8",
    );

    mock
      .get("https://www.journeykits.ai")
      .intercept({ path: "/api/kits/publish", method: "POST" })
      .reply(200, {
        ok: true,
        kitRef: "globalcaos/feature",
        url: "https://www.journeykits.ai/kits/globalcaos/feature",
        version: "1.0.0",
      });

    const rpcs = createRecipeRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: "test-key",
      recipeInstallSandbox: store.rootDirPublic(),
      ownRecipesDir,
    });
    const res = await rpcs["prefrontal.recipe.publish"]({ slug: "feature", visibility: "public" });
    expect(res.ok).toBe(true);
    expect(res.url).toContain("globalcaos/feature");
  });

  // ─── inferCategory tests ────────────────────────────────────────────────

  it("inferCategory: explicit category field wins over tags", () => {
    expect(inferCategory({ category: "security", tags: ["coding", "refactor"] })).toBe("security");
  });

  it("inferCategory: first tag that exactly matches canonical wins", () => {
    expect(inferCategory({ tags: ["coding", "debug"] })).toBe("coding");
    expect(inferCategory({ tags: ["writing", "paper"] })).toBe("writing");
    expect(inferCategory({ tags: ["communication", "slack"] })).toBe("communication");
    expect(inferCategory({ tags: ["analysis", "research"] })).toBe("analysis");
    expect(inferCategory({ tags: ["operations", "cron"] })).toBe("operations");
    expect(inferCategory({ tags: ["security", "audit"] })).toBe("security");
  });

  it("inferCategory: pattern-match fallback for coding keywords", () => {
    expect(inferCategory({ tags: ["code-review", "tdd"] })).toBe("coding");
    expect(inferCategory({ tags: ["refactor"] })).toBe("coding");
  });

  it("inferCategory: pattern-match fallback for analysis keywords", () => {
    expect(inferCategory({ tags: ["research", "findings"] })).toBe("analysis");
  });

  it("inferCategory: pattern-match fallback for operations keywords", () => {
    expect(inferCategory({ tags: ["watchdog", "monitoring"] })).toBe("operations");
    expect(inferCategory({ tags: ["gateway", "cron"] })).toBe("operations");
  });

  it("inferCategory: falls back to operations when no match", () => {
    expect(inferCategory({ tags: ["unknown-tag", "xyz"] })).toBe("operations");
    expect(inferCategory({})).toBe("operations");
  });

  // ─── parseKitMd tests ───────────────────────────────────────────────────

  it("parseKitMd: parses slug, title, summary, tags, category from frontmatter", async () => {
    const kitPath = path.join(ownRecipesDir, "my-kit", "kit.md");
    fs.mkdirSync(path.dirname(kitPath), { recursive: true });
    fs.writeFileSync(
      kitPath,
      '---\nschema: "kit/1.0"\nslug: "my-kit"\ntitle: "My Kit"\nsummary: "Does something"\ntags: ["coding", "debug"]\n---\n# body\n',
      "utf-8",
    );
    const parsed = await parseKitMd(kitPath);
    expect(parsed.slug).toBe("my-kit");
    expect(parsed.title).toBe("My Kit");
    expect(parsed.summary).toBe("Does something");
    expect(parsed.tags).toContain("coding");
    expect(parsed.category).toBe("coding");
  });

  it("parseKitMd: derives category via inferCategory (first canonical tag)", async () => {
    const kitPath = path.join(ownRecipesDir, "comms-kit", "kit.md");
    fs.mkdirSync(path.dirname(kitPath), { recursive: true });
    fs.writeFileSync(
      kitPath,
      '---\nschema: "kit/1.0"\nslug: "comms-kit"\ntitle: "Comms"\nsummary: ""\ntags: ["communication", "email"]\n---\n',
      "utf-8",
    );
    const parsed = await parseKitMd(kitPath);
    expect(parsed.category).toBe("communication");
  });

  it("parseKitMd: falls back gracefully when kit.md has no frontmatter", async () => {
    const kitPath = path.join(ownRecipesDir, "bare-kit", "kit.md");
    fs.mkdirSync(path.dirname(kitPath), { recursive: true });
    fs.writeFileSync(kitPath, "# Just a body\n", "utf-8");
    const parsed = await parseKitMd(kitPath);
    expect(parsed.slug).toBe("bare-kit"); // falls back to dirname
    expect(parsed.category).toBe("operations"); // catch-all
  });

  // ─── kit.list: source=ours + combined list ──────────────────────────────

  it("prefrontal.recipe.list includes source-tree kits with source:'ours'", async () => {
    fs.mkdirSync(path.join(ownRecipesDir, "debug"), { recursive: true });
    fs.writeFileSync(
      path.join(ownRecipesDir, "debug", "kit.md"),
      '---\nschema: "kit/1.0"\nslug: "debug"\ntitle: "Debug & Fix"\nsummary: "Systematic debug"\ntags: ["coding"]\n---\n',
      "utf-8",
    );
    const rpcs = createRecipeRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      recipeInstallSandbox: store.rootDirPublic(),
      ownRecipesDir,
    });
    const res = await rpcs["prefrontal.recipe.list"]({});
    const kit = res.kits.find((k) => k.slug === "debug");
    expect(kit).toBeTruthy();
    expect(kit?.source).toBe("ours");
    expect(kit?.owner).toBe("globalcaos");
    expect(kit?.category).toBe("coding");
  });

  it("prefrontal.recipe.list combines ours + downloaded, ours appear first", async () => {
    // Set up one own kit
    fs.mkdirSync(path.join(ownRecipesDir, "own-kit"), { recursive: true });
    fs.writeFileSync(
      path.join(ownRecipesDir, "own-kit", "kit.md"),
      '---\nschema: "kit/1.0"\nslug: "own-kit"\ntitle: "Own Kit"\nsummary: ""\ntags: ["coding"]\n---\n',
      "utf-8",
    );
    // Set up one downloaded kit
    await store.writeKitFiles({
      owner: "someone",
      slug: "dl-kit",
      files: [
        {
          path: "kit.md",
          content:
            '---\nschema: "kit/1.0"\nslug: "dl-kit"\ntitle: "DL Kit"\nsummary: ""\ntags: ["analysis"]\n---\n',
        },
      ],
    });
    const rpcs = createRecipeRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      recipeInstallSandbox: store.rootDirPublic(),
      ownRecipesDir,
    });
    const res = await rpcs["prefrontal.recipe.list"]({});
    const ownIdx = res.kits.findIndex((k) => k.slug === "own-kit");
    const dlIdx = res.kits.findIndex((k) => k.slug === "dl-kit");
    expect(ownIdx).toBeGreaterThanOrEqual(0);
    expect(dlIdx).toBeGreaterThanOrEqual(0);
    expect(ownIdx).toBeLessThan(dlIdx); // ours before downloaded
    expect(res.kits[ownIdx].source).toBe("ours");
    expect(res.kits[dlIdx].source).toBe("downloaded");
  });

  it("prefrontal.recipe.list kit items include category field", async () => {
    await store.writeKitFiles({
      owner: "globalcaos",
      slug: "feature",
      files: [
        {
          path: "kit.md",
          content:
            '---\nschema: "kit/1.0"\nslug: "feature"\ntitle: "Feature"\nsummary: ""\ntags: ["coding"]\n---\n',
        },
      ],
    });
    const rpcs = createRecipeRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      recipeInstallSandbox: store.rootDirPublic(),
      ownRecipesDir,
    });
    const res = await rpcs["prefrontal.recipe.list"]({});
    const kit = res.kits.find((k) => k.slug === "feature");
    expect(kit?.category).toBe("coding");
  });

  // ─── U1 + U12 PRODUCER WIRING: recipe.match folds in fitness + rating ─────────
  // The matcher exposes feedback?/rating? seams; before this wiring NO caller
  // supplied them. These tests fail if recipe.match calls matchRecipesDetailed without
  // a non-empty feedback + rating (the unwired-producer regression).

  function meta(
    kitRef: string,
    versions: string[],
    over?: Partial<MarketplaceMeta>,
  ): MarketplaceMeta {
    return { kitRef, versions, rating: over?.rating, downloads: over?.downloads };
  }

  it("prefrontal.recipe.match passes a NON-EMPTY feedback + rating into matchRecipesDetailed", async () => {
    // A curated kit in the catalog.
    fs.mkdirSync(path.join(ownRecipesDir, "debug"), { recursive: true });
    fs.writeFileSync(
      path.join(ownRecipesDir, "debug", "kit.md"),
      '---\nschema: "kit/1.0"\nslug: "debug"\ntitle: "Debug & Fix"\nsummary: "reproduce diagnose fix verify"\ntags: ["debug", "bug", "crash", "error"]\n---\n### 1. Repro\nbody\n',
      "utf-8",
    );

    // An on-disk fitness record so the FitnessLookup resolves a real successRate.
    const engramBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-engram-"));
    const archive = createRecipeArchive({ baseDir: engramBaseDir });
    const fit = createInitialRecipeFitness("globalcaos/debug", 1);
    fit.successRate = laplace(9, 9);
    archive.putVariant("globalcaos/debug", 1, "body", fit);

    // A marketplace with a warmed cache so the RatingLookup resolves a real bonus.
    const marketplace = createMarketplace({ fetchImpl: vi.fn() });
    marketplace.recordMarketplaceCache(
      meta("globalcaos/debug", ["1.0.0"], { rating: 5, downloads: 500 }),
    );

    const spy = vi.spyOn(kitMatcher, "matchRecipesDetailed");
    try {
      const rpcs = createRecipeRpcs({
        store,
        baseUrl: "https://www.journeykits.ai",
        apiKey: null,
        recipeInstallSandbox: store.rootDirPublic(),
        ownRecipesDir,
        marketplace,
        engramBaseDir,
      });
      await rpcs["prefrontal.recipe.match"]({ prompt: "debug the crash error" });

      expect(spy).toHaveBeenCalled();
      const opts = spy.mock.calls[0]?.[2] as
        | {
            feedback?: (s: string) => number | undefined;
            rating?: (s: string) => number | undefined;
          }
        | undefined;
      expect(typeof opts?.feedback).toBe("function");
      expect(typeof opts?.rating).toBe("function");
      // The injected lookups actually RESOLVE real values for the catalog slug —
      // i.e. the producers are wired to live data, not empty stubs.
      expect(opts?.feedback?.("debug")).toBeCloseTo(laplace(9, 9), 10);
      expect(opts?.rating?.("debug")).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
      fs.rmSync(engramBaseDir, { recursive: true, force: true });
    }
  });

  it("prefrontal.recipe.search local fallback also passes feedback + rating", async () => {
    fs.mkdirSync(path.join(ownRecipesDir, "debug"), { recursive: true });
    fs.writeFileSync(
      path.join(ownRecipesDir, "debug", "kit.md"),
      '---\nschema: "kit/1.0"\nslug: "debug"\ntitle: "Debug & Fix"\nsummary: "reproduce diagnose fix verify"\ntags: ["debug", "bug", "crash", "error"]\n---\n### 1. Repro\nbody\n',
      "utf-8",
    );
    const engramBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-engram-"));
    const marketplace = createMarketplace({ fetchImpl: vi.fn() });

    const spy = vi.spyOn(kitMatcher, "matchRecipesDetailed");
    try {
      const rpcs = createRecipeRpcs({
        store,
        baseUrl: "https://www.journeykits.ai",
        apiKey: null,
        recipeInstallSandbox: store.rootDirPublic(),
        ownRecipesDir,
        marketplace,
        engramBaseDir,
        // Force the LOCAL fallback path by failing the Journey fetch.
        fetchJsonImpl: async () => {
          throw new Error("journey down");
        },
      });
      await rpcs["prefrontal.recipe.search"]({ query: "debug crash" });
      expect(spy).toHaveBeenCalled();
      const opts = spy.mock.calls[0]?.[2] as { feedback?: unknown; rating?: unknown } | undefined;
      expect(typeof opts?.feedback).toBe("function");
      expect(typeof opts?.rating).toBe("function");
    } finally {
      spy.mockRestore();
      fs.rmSync(engramBaseDir, { recursive: true, force: true });
    }
  });

  // ─── U1 PRODUCER WIRING: recipe.run passes onTag into runRecipe ──────────────────
  // recipe-runner emits recipe:<owner/slug> TagStamps via opts.onTag, but recipe.run
  // never supplied it → the attribution producer was inert. This asserts the seam.

  it("prefrontal.recipe.run passes a DEFINED onTag into runRecipe that forwards to the trail seam", async () => {
    let capturedOnTag: ((ev: kitRunner.TagStamp) => void) | undefined;
    const runKitSpy = vi
      .spyOn(kitRunner, "runRecipe")
      .mockImplementation(async (opts: kitRunner.RecipeRunOptions) => {
        capturedOnTag = opts.onTag;
        return { ok: true, planId: "test-plan", results: [] };
      });
    callGatewaySpy.mockClear();
    try {
      const rpcs = createRecipeRpcs({
        store,
        baseUrl: "https://www.journeykits.ai",
        apiKey: null,
        recipeInstallSandbox: store.rootDirPublic(),
        ownRecipesDir,
        planStore: {} as never,
      });
      await rpcs["prefrontal.recipe.run"]({
        kitRef: "globalcaos/debug",
        sessionKey: "agent:main:main",
        intent: "debug it",
      });

      // The producer seam is wired: runRecipe received a callable onTag.
      expect(runKitSpy).toHaveBeenCalled();
      expect(typeof capturedOnTag).toBe("function");

      // And invoking it forwards the recipe-attribution tag to the trail/ingestion
      // seam (so recipe-fitness.attributeRecipe sees `recipe:<owner/slug>`).
      capturedOnTag!({
        tag: "recipe:globalcaos/debug",
        phase: "start",
        sessionKey: "agent:main:main",
      });
      const tagCall = callGatewaySpy.mock.calls.find(
        (c) => (c[0] as { method?: string })?.method === "fork.prefrontal.trailEvent",
      );
      expect(tagCall).toBeTruthy();
      const params = (tagCall![0] as { params?: Record<string, unknown> }).params!;
      expect(params.kind).toBe("recipe-tag");
      const payload = params.payload as { recipeTag?: string; tags?: string[] };
      expect(payload.recipeTag).toBe("recipe:globalcaos/debug");
      expect(payload.tags).toContain("recipe:globalcaos/debug");
    } finally {
      runKitSpy.mockRestore();
    }
  });

  describe("prefrontal.recipe.compose (SS3)", () => {
    it("mechanically composes a recipe of invoke skill: steps from search hits", async () => {
      // stub fork.skill.search (the handler's only callGateway call)
      callGatewaySpy.mockResolvedValueOnce({
        skills: [
          { skillId: "stdlib-summarize-text", name: "summarize-text" },
          { skillId: "stdlib-web-search-and-cite", name: "web-search-and-cite" },
        ],
      });
      const rpcs = createRecipeRpcs({
        store,
        baseUrl: "https://www.journeykits.ai",
        apiKey: null,
        recipeInstallSandbox: store.rootDirPublic(),
        ownRecipesDir,
      });
      const res = await rpcs["prefrontal.recipe.compose"]({
        sessionKey: "agent:main:main",
        query: "summarize a document and cite sources",
      });
      expect(res.ok).toBe(true);
      expect(res.composedSkills).toEqual(["stdlib-summarize-text", "stdlib-web-search-and-cite"]);
      // persisted recipe.md carries the invoke skill: directives + the authorship stamp
      const md = fs.readFileSync(path.join(ownRecipesDir, res.slug, "recipe.md"), "utf-8");
      expect(md).toContain("invoke skill: stdlib-summarize-text");
      expect(md).toContain("invoke skill: stdlib-web-search-and-cite");
      expect(md).toContain('authoredBy: "jarvis-on-the-fly"');
    });

    it("returns ok:false when the skill search yields no hits", async () => {
      callGatewaySpy.mockResolvedValueOnce({ skills: [] });
      const rpcs = createRecipeRpcs({
        store,
        baseUrl: "https://www.journeykits.ai",
        apiKey: null,
        recipeInstallSandbox: store.rootDirPublic(),
        ownRecipesDir,
      });
      const res = await rpcs["prefrontal.recipe.compose"]({
        sessionKey: "agent:main:main",
        query: "nothing relevant whatsoever",
      });
      expect(res.ok).toBe(false);
      expect(String(res.note)).toMatch(/no matching skills/i);
    });
  });
});
