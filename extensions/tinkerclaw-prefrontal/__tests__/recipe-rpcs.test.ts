/**
 * Wire-seam 5 (U11 + U12) RPC wiring tests.
 *
 * U11: recipe.install bridges a CC SKILL.md → recipe/1.0 (into the bridged-skills
 *      dir, scanned by the matcher); recipe.install resolves transitive
 *      composes:/uses: dependencies (cycle-guarded); recipe.search falls back to
 *      LOCAL matchRecipesDetailed when the Journey fetch fails.
 * U12: recipe.publish bumps the frontmatter version per `level` (default patch),
 *      refuses to overwrite an already-published version (immutability), and
 *      enforces an owner-permission check; recipe.get/install resolve an optional
 *      `ref` version-constraint via the marketplace.
 *
 * The Journey network is injected (deps.fetchJsonImpl) so these stay offline +
 * deterministic, mirroring recipe-marketplace's injectable MarketplaceFetch.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGED_SKILLS_DIRNAME } from "../cc-skills-bridge.js";
import {
  createMarketplace,
  type MarketplaceFetch,
  type MarketplaceMeta,
} from "../recipe-marketplace.js";
import { invalidateRecipeIndexCache } from "../recipe-matcher.js";
import { createRecipeRpcs, type KitRpcsDeps } from "../recipe-rpcs.js";
import { RecipeStore } from "../recipe-store.js";

const SKILL_MD = `---
name: deploy-check
description: "Verify a deploy is healthy before promoting it to prod."
trigger: /deploy-check
---

# Deploy Check

### 1. Read the release manifest
Open the manifest and note the target version.

### 2. Run the smoke suite
Execute the smoke tests against staging.
`;

// A locally-curated kit so recipe.search's LOCAL fallback has something to match.
const LOCAL_DEBUG_KIT = `---
schema: "kit/1.0"
slug: "debug"
title: "Debug & Fix"
summary: "reproduce diagnose fix verify"
version: "1.4.2"
owner: "globalcaos"
tags: [debug, bug, crash, error]
---
## Steps
### 1. Reproduce
Reproduce the bug.
`;

let tmp: string;
let ownRecipesDir: string;
let sandbox: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "recipe-rpcs-"));
  ownRecipesDir = path.join(tmp, "own");
  sandbox = path.join(tmp, "sandbox");
  await fs.mkdir(ownRecipesDir, { recursive: true });
  await fs.mkdir(sandbox, { recursive: true });
  invalidateRecipeIndexCache();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  invalidateRecipeIndexCache();
  vi.restoreAllMocks();
});

function baseDeps(over?: Partial<KitRpcsDeps>): KitRpcsDeps {
  return {
    store: new RecipeStore({ rootDir: sandbox }),
    baseUrl: "https://example.invalid",
    apiKey: "test-key",
    recipeInstallSandbox: sandbox,
    ownRecipesDir,
    ...over,
  };
}

async function writeLocalKit(slug: string, md: string): Promise<void> {
  const dir = path.join(ownRecipesDir, slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "kit.md"), md, "utf8");
  invalidateRecipeIndexCache();
}

// ─── U11: recipe.install bridges a CC SKILL.md ───────────────────────────────

describe("U11 recipe.install — CC SKILL.md bridging", () => {
  it("transpiles a SKILL.md into a recipe/1.0 in the bridged-skills dir", async () => {
    const rpcs = createRecipeRpcs(baseDeps());
    const res: any = await rpcs["prefrontal.recipe.install"]({
      kitRef: "cc/deploy-check",
      skillMd: SKILL_MD,
    });
    expect(res.ok).toBe(true);
    expect(res.bridged).toBe(true);
    expect(res.slug).toBe("deploy-check");
    // Written under <sandbox>/<bridged-skills>/<slug>/recipe.md (canonical;
    // dual-read still loads a legacy kit.md), tagged cc-bridge.
    const written = await fs.readFile(
      path.join(sandbox, BRIDGED_SKILLS_DIRNAME, "deploy-check", "recipe.md"),
      "utf8",
    );
    expect(written).toContain('authoredBy: "cc-bridge"');
    expect(written).toContain('schema: "kit/1.0"');
    expect(written).toContain("Read the release manifest");
  });

  it("rejects a malformed SKILL.md before any write", async () => {
    const rpcs = createRecipeRpcs(baseDeps());
    await expect(
      rpcs["prefrontal.recipe.install"]({ kitRef: "cc/bad", skillMd: "no frontmatter here" }),
    ).rejects.toThrow(/frontmatter/i);
  });
});

// ─── U11: transitive composes/uses dependency resolution ─────────────────────

describe("U11 recipe.install — transitive dependency resolution", () => {
  // Journey serves: top composes [mid]; mid has a step that `uses: leaf`.
  const files = {
    "globalcaos/top": [
      {
        path: "kit.md",
        content: `---\nschema: "kit/1.0"\nslug: "top"\ntitle: "Top"\nsummary: "t"\ntags: [top]\ncomposes: ["mid"]\n---\n### 1. Top step\nDo top.\n`,
      },
    ],
    "globalcaos/mid": [
      {
        path: "kit.md",
        content: `---\nschema: "kit/1.0"\nslug: "mid"\ntitle: "Mid"\nsummary: "m"\ntags: [mid]\n---\n### 1. Mid step\nuses: leaf\n`,
      },
    ],
    "globalcaos/leaf": [
      {
        path: "kit.md",
        content: `---\nschema: "kit/1.0"\nslug: "leaf"\ntitle: "Leaf"\nsummary: "l"\ntags: [leaf]\n---\n### 1. Leaf step\nDo leaf.\n`,
      },
    ],
  } as Record<string, Array<{ path: string; content: string }>>;

  function journeyFetch() {
    return vi.fn(async (p: string) => {
      const m = /\/api\/kits\/([^/]+\/[^/]+)\/install/.exec(p);
      if (m) {
        const ref = m[1];
        return { files: files[ref] ?? [], risk: [], preflightChecks: [], nextSteps: [] };
      }
      throw new Error(`unexpected journey path ${p}`);
    });
  }

  it("installs top + its transitive composes(mid) + uses(leaf) deps", async () => {
    const fetchJsonImpl = journeyFetch();
    const rpcs = createRecipeRpcs(baseDeps({ fetchJsonImpl }));
    const res: any = await rpcs["prefrontal.recipe.install"]({ kitRef: "globalcaos/top" });
    expect(res.ok).toBe(true);
    // dependsInstalled lists the transitive set actually written (order: deps then root).
    expect(res.dependenciesInstalled).toEqual(
      expect.arrayContaining(["globalcaos/mid", "globalcaos/leaf"]),
    );
    for (const ref of ["top", "mid", "leaf"]) {
      const written = await fs
        .access(path.join(sandbox, "globalcaos", ref, "kit.md"))
        .then(() => true)
        .catch(() => false);
      expect(written).toBe(true);
    }
  });

  it("does not loop forever on a dependency cycle", async () => {
    const cyclic = {
      "globalcaos/a": [
        {
          path: "kit.md",
          content: `---\nschema: "kit/1.0"\nslug: "a"\ntitle: "A"\nsummary: "a"\ntags: [a]\ncomposes: ["b"]\n---\n### 1. A\nDo a.\n`,
        },
      ],
      "globalcaos/b": [
        {
          path: "kit.md",
          content: `---\nschema: "kit/1.0"\nslug: "b"\ntitle: "B"\nsummary: "b"\ntags: [b]\ncomposes: ["a"]\n---\n### 1. B\nDo b.\n`,
        },
      ],
    } as Record<string, Array<{ path: string; content: string }>>;
    const fetchJsonImpl = vi.fn(async (p: string) => {
      const m = /\/api\/kits\/([^/]+\/[^/]+)\/install/.exec(p);
      if (m) return { files: cyclic[m[1]] ?? [], risk: [] };
      throw new Error(`unexpected ${p}`);
    });
    const rpcs = createRecipeRpcs(baseDeps({ fetchJsonImpl }));
    const res: any = await rpcs["prefrontal.recipe.install"]({ kitRef: "globalcaos/a" });
    expect(res.ok).toBe(true);
    // Each ref fetched at most once (cycle broke) — a + b, never a third time.
    expect(fetchJsonImpl).toHaveBeenCalledTimes(2);
  });
});

// ─── U11: recipe.search LOCAL fallback when Journey is down ───────────────────

describe("U11 recipe.search — LOCAL fallback on Journey failure", () => {
  it("returns local matchRecipesDetailed results when the fetch throws", async () => {
    await writeLocalKit("debug", LOCAL_DEBUG_KIT);
    const fetchJsonImpl = vi.fn(async () => {
      throw new Error("journey down");
    });
    const rpcs = createRecipeRpcs(baseDeps({ fetchJsonImpl }));
    const res: any = await rpcs["prefrontal.recipe.search"]({ query: "debug the crash error" });
    expect(res.source).toBe("local");
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results.some((r: any) => /debug/.test(r.kitRef))).toBe(true);
  });

  it("uses the Journey results when the fetch succeeds (no fallback)", async () => {
    const fetchJsonImpl = vi.fn(async () => [
      { kitRef: "someone/remote-kit", releaseTag: "1.0.0" },
    ]);
    const rpcs = createRecipeRpcs(baseDeps({ fetchJsonImpl }));
    const res: any = await rpcs["prefrontal.recipe.search"]({ query: "anything" });
    expect(res.source).not.toBe("local");
    expect(res.results[0].kitRef).toBe("someone/remote-kit");
  });
});

// ─── U12: publish version bump + immutability + owner check ───────────────────

function mkMarketplace(versions: string[], over?: Partial<MarketplaceMeta>) {
  const fetchImpl: MarketplaceFetch = vi.fn(async (kitRef) => ({
    kitRef,
    versions,
    ...over,
  }));
  return createMarketplace({ fetchImpl });
}

describe("U12 recipe.publish — versioning + immutability + owner check", () => {
  it("bumps the frontmatter version (default patch) and POSTs the bumped doc", async () => {
    await writeLocalKit("debug", LOCAL_DEBUG_KIT); // current version 1.4.2
    const posted: any[] = [];
    const fetchJsonImpl = vi.fn(async (p: string, init?: any) => {
      posted.push({ p, body: JSON.parse(init.body) });
      return { ok: true };
    });
    const marketplace = mkMarketplace(["1.4.2"]); // 1.4.3 not yet published → allowed
    const rpcs = createRecipeRpcs(
      baseDeps({ fetchJsonImpl, marketplace, currentOwner: "globalcaos" }),
    );
    const res: any = await rpcs["prefrontal.recipe.publish"]({
      slug: "debug",
      visibility: "public",
    });
    expect(res.version).toBe("1.4.3"); // patch bump from 1.4.2
    expect(posted[0].body.recipeMd).toContain('version: "1.4.3"');
  });

  it("supports an explicit bump level (minor)", async () => {
    await writeLocalKit("debug", LOCAL_DEBUG_KIT);
    const fetchJsonImpl = vi.fn(async () => ({ ok: true }));
    const marketplace = mkMarketplace(["1.4.2"]);
    const rpcs = createRecipeRpcs(baseDeps({ fetchJsonImpl, marketplace }));
    const res: any = await rpcs["prefrontal.recipe.publish"]({
      slug: "debug",
      visibility: "public",
      level: "minor",
    });
    expect(res.version).toBe("1.5.0");
  });

  it("refuses to publish over an already-published version (immutability)", async () => {
    await writeLocalKit("debug", LOCAL_DEBUG_KIT); // 1.4.2 → bump to 1.4.3
    const fetchJsonImpl = vi.fn(async () => ({ ok: true }));
    const marketplace = mkMarketplace(["1.4.2", "1.4.3"]); // 1.4.3 ALREADY published
    const rpcs = createRecipeRpcs(baseDeps({ fetchJsonImpl, marketplace }));
    await expect(
      rpcs["prefrontal.recipe.publish"]({ slug: "debug", visibility: "public" }),
    ).rejects.toThrow(/immutab|already published/i);
    expect(fetchJsonImpl).not.toHaveBeenCalled(); // never POSTed
  });

  it("refuses to publish a kit owned by someone else (owner permission)", async () => {
    const FOREIGN = LOCAL_DEBUG_KIT.replace('owner: "globalcaos"', 'owner: "someone-else"');
    await writeLocalKit("debug", FOREIGN);
    const fetchJsonImpl = vi.fn(async () => ({ ok: true }));
    const marketplace = mkMarketplace(["1.4.2"]);
    const rpcs = createRecipeRpcs(
      baseDeps({ fetchJsonImpl, marketplace, currentOwner: "globalcaos" }),
    );
    await expect(
      rpcs["prefrontal.recipe.publish"]({ slug: "debug", visibility: "public" }),
    ).rejects.toThrow(/owner|permission/i);
    expect(fetchJsonImpl).not.toHaveBeenCalled();
  });
});

// ─── U12: get/install resolve an optional version-constraint ───────────────────

describe("U12 recipe.get/install — version-constraint resolution", () => {
  it("recipe.get resolves a caret range to the highest published version", async () => {
    const seenRefs: string[] = [];
    const fetchJsonImpl = vi.fn(async (p: string) => {
      const m = /\/api\/kits\/([^/?]+\/[^/?]+)(?:\?ref=([^&]+))?/.exec(p);
      if (m) seenRefs.push(m[2] ?? "");
      return { slug: "debug" };
    });
    const marketplace = mkMarketplace(["1.0.0", "1.2.0", "1.5.3", "2.0.0"]);
    const rpcs = createRecipeRpcs(baseDeps({ fetchJsonImpl, marketplace }));
    await rpcs["prefrontal.recipe.get"]({ kitRef: "globalcaos/debug", ref: "^1.0.0" });
    // The resolved concrete version (1.5.3) is what gets fetched, not the raw "^1.0.0".
    expect(decodeURIComponent(seenRefs[0])).toBe("1.5.3");
  });

  it("recipe.install resolves a version-constraint before fetching the install payload", async () => {
    const seen: string[] = [];
    const fetchJsonImpl = vi.fn(async (p: string) => {
      const ref = /ref=([^&]+)/.exec(p)?.[1];
      if (ref) seen.push(decodeURIComponent(ref));
      return { files: [], risk: [], preflightChecks: [], nextSteps: [] };
    });
    const marketplace = mkMarketplace(["1.0.0", "1.2.0"]);
    const rpcs = createRecipeRpcs(baseDeps({ fetchJsonImpl, marketplace }));
    await rpcs["prefrontal.recipe.install"]({ kitRef: "globalcaos/debug", ref: "^1.0.0" });
    expect(seen[0]).toBe("1.2.0");
  });
});
