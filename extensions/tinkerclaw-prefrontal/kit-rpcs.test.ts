import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createKitRpcs, inferCategory, parseKitMd } from "./kit-rpcs.js";
import { KitStore } from "./kit-store.js";

describe("kit-rpcs", () => {
  let mock: MockAgent;
  let original: Dispatcher;
  let store: KitStore;
  let root: string;
  let ownKitsDir: string;

  beforeEach(() => {
    original = getGlobalDispatcher();
    mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-kr-"));
    store = new KitStore({ rootDir: root });
    ownKitsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-own-"));
  });
  afterEach(() => {
    setGlobalDispatcher(original);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(ownKitsDir, { recursive: true, force: true });
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

    const rpcs = createKitRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      kitInstallSandbox: store.rootDirPublic(),
      ownKitsDir,
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

    const rpcs = createKitRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      kitInstallSandbox: store.rootDirPublic(),
      ownKitsDir,
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
    const rpcs = createKitRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      kitInstallSandbox: store.rootDirPublic(),
      ownKitsDir,
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
    const rpcs = createKitRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      kitInstallSandbox: store.rootDirPublic(),
      ownKitsDir,
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
    const rpcs = createKitRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      kitInstallSandbox: store.rootDirPublic(),
      ownKitsDir,
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
    const rpcs = createKitRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      kitInstallSandbox: store.rootDirPublic(),
      ownKitsDir,
    });
    const res = await rpcs["prefrontal.recipe.install"]({ kitRef: "foo/bar", allowRisky: true });
    expect(res.ok).toBe(true);
    expect(res.installedPath).toContain("foo/bar");
    expect(fs.existsSync(path.join(root, "foo/bar/kit.md"))).toBe(true);
  });

  it("prefrontal.recipe.list returns inventory under sandbox", async () => {
    await store.writeKitFiles({
      owner: "globalcaos",
      slug: "feature",
      files: [{ path: "kit.md", content: "x" }],
    });
    const rpcs = createKitRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      kitInstallSandbox: store.rootDirPublic(),
      ownKitsDir,
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
    const rpcs = createKitRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      kitInstallSandbox: store.rootDirPublic(),
      ownKitsDir,
    });
    const res = await rpcs["prefrontal.recipe.list"]({});
    const kit = res.kits.find((k) => k.slug === "block-scalar");
    expect(kit?.summary).toBe("Line one of summary continues here.");
  });

  it("prefrontal.recipe.publish requires apiKey", async () => {
    const rpcs = createKitRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      kitInstallSandbox: store.rootDirPublic(),
      ownKitsDir,
    });
    await expect(
      rpcs["prefrontal.recipe.publish"]({ slug: "feature", visibility: "public" }),
    ).rejects.toThrow(/apiKey|missing.*key/i);
  });

  it("prefrontal.recipe.publish reads source kit body and POSTs to Journey", async () => {
    fs.mkdirSync(path.join(ownKitsDir, "feature"), { recursive: true });
    fs.writeFileSync(
      path.join(ownKitsDir, "feature", "kit.md"),
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

    const rpcs = createKitRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: "test-key",
      kitInstallSandbox: store.rootDirPublic(),
      ownKitsDir,
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
    const kitPath = path.join(ownKitsDir, "my-kit", "kit.md");
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
    const kitPath = path.join(ownKitsDir, "comms-kit", "kit.md");
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
    const kitPath = path.join(ownKitsDir, "bare-kit", "kit.md");
    fs.mkdirSync(path.dirname(kitPath), { recursive: true });
    fs.writeFileSync(kitPath, "# Just a body\n", "utf-8");
    const parsed = await parseKitMd(kitPath);
    expect(parsed.slug).toBe("bare-kit"); // falls back to dirname
    expect(parsed.category).toBe("operations"); // catch-all
  });

  // ─── kit.list: source=ours + combined list ──────────────────────────────

  it("prefrontal.recipe.list includes source-tree kits with source:'ours'", async () => {
    fs.mkdirSync(path.join(ownKitsDir, "debug"), { recursive: true });
    fs.writeFileSync(
      path.join(ownKitsDir, "debug", "kit.md"),
      '---\nschema: "kit/1.0"\nslug: "debug"\ntitle: "Debug & Fix"\nsummary: "Systematic debug"\ntags: ["coding"]\n---\n',
      "utf-8",
    );
    const rpcs = createKitRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      kitInstallSandbox: store.rootDirPublic(),
      ownKitsDir,
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
    fs.mkdirSync(path.join(ownKitsDir, "own-kit"), { recursive: true });
    fs.writeFileSync(
      path.join(ownKitsDir, "own-kit", "kit.md"),
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
    const rpcs = createKitRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      kitInstallSandbox: store.rootDirPublic(),
      ownKitsDir,
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
    const rpcs = createKitRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      kitInstallSandbox: store.rootDirPublic(),
      ownKitsDir,
    });
    const res = await rpcs["prefrontal.recipe.list"]({});
    const kit = res.kits.find((k) => k.slug === "feature");
    expect(kit?.category).toBe("coding");
  });
});
