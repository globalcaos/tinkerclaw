import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createKitRpcs } from "./kit-rpcs.js";
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

  it("prefrontal.kit.search returns parsed results (flat array shape)", async () => {
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
    const res = await rpcs["prefrontal.kit.search"]({ query: "feature" });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].kitRef).toBe("globalcaos/feature");
  });

  it("prefrontal.kit.search dedupes by kitRef keeping highest releaseTag", async () => {
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
    const res = await rpcs["prefrontal.kit.search"]({ query: "feature" });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].releaseTag).toBe("3.0.0");
    expect(res.results[0].title).toBe("Build Feature v3 (latest)");
  });

  it("prefrontal.kit.get returns the kit", async () => {
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
    const res = await rpcs["prefrontal.kit.get"]({ kitRef: "globalcaos/feature" });
    expect(res.kit.slug).toBe("feature");
  });

  it("prefrontal.kit.install refuses Critical-risk kits unless allowRisky=true", async () => {
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
    await expect(rpcs["prefrontal.kit.install"]({ kitRef: "foo/bar" })).rejects.toThrow(
      /risk|Critical/,
    );
  });

  it("prefrontal.kit.install rejects file entries that escape the sandbox", async () => {
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
    await expect(rpcs["prefrontal.kit.install"]({ kitRef: "foo/bar" })).rejects.toThrow(
      /escapes sandbox/,
    );
  });

  it("prefrontal.kit.install with allowRisky writes files when risk is High", async () => {
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
    const res = await rpcs["prefrontal.kit.install"]({ kitRef: "foo/bar", allowRisky: true });
    expect(res.ok).toBe(true);
    expect(res.installedPath).toContain("foo/bar");
    expect(fs.existsSync(path.join(root, "foo/bar/kit.md"))).toBe(true);
  });

  it("prefrontal.kit.list returns inventory under sandbox", async () => {
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
    const res = await rpcs["prefrontal.kit.list"]({});
    expect(res.kits.find((k) => k.kitRef === "globalcaos/feature")).toBeTruthy();
  });

  it("prefrontal.kit.publish requires apiKey", async () => {
    const rpcs = createKitRpcs({
      store,
      baseUrl: "https://www.journeykits.ai",
      apiKey: null,
      kitInstallSandbox: store.rootDirPublic(),
      ownKitsDir,
    });
    await expect(
      rpcs["prefrontal.kit.publish"]({ slug: "feature", visibility: "public" }),
    ).rejects.toThrow(/apiKey|missing.*key/i);
  });

  it("prefrontal.kit.publish reads source kit body and POSTs to Journey", async () => {
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
    const res = await rpcs["prefrontal.kit.publish"]({ slug: "feature", visibility: "public" });
    expect(res.ok).toBe(true);
    expect(res.url).toContain("globalcaos/feature");
  });
});
