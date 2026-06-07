import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { RecipeParamSpec } from "./recipe-author.js";
import { createVarStore, mergePrecedence, envVarName } from "./recipe-var-store.js";

describe("recipe-var-store: VarStore", () => {
  let baseDir: string;

  beforeEach(() => {
    // NEVER the real ~/.openclaw — always an os.tmpdir() sandbox.
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-vars-"));
  });
  afterEach(() => fs.rmSync(baseDir, { recursive: true, force: true }));

  it("missing file = empty store (no throw)", () => {
    const store = createVarStore(baseDir);
    expect(fs.existsSync(store.path)).toBe(false);
    expect(store.read("global", "funnel_repo")).toBeUndefined();
    expect(store.readScope("global")).toEqual({});
    expect(store.isSecret("global", "funnel_repo")).toBe(false);
  });

  it("set -> read round-trip, per scope (no cross-scope fallback)", () => {
    const store = createVarStore(baseDir);
    store.set("global", "funnel_repo", "globalcaos/tinkerclaw");
    store.set("owner/slug", "target", "thetinkerzone.com");
    expect(store.read("global", "funnel_repo")).toBe("globalcaos/tinkerclaw");
    expect(store.read("owner/slug", "target")).toBe("thetinkerzone.com");
    // scopes are isolated — no implicit fall-through
    expect(store.read("global", "target")).toBeUndefined();
    expect(store.readScope("owner/slug")).toEqual({ target: "thetinkerzone.com" });
  });

  it("persists across instances (file-backed)", () => {
    createVarStore(baseDir).set("global", "k", "v");
    const reopened = createVarStore(baseDir);
    expect(reopened.read("global", "k")).toBe("v");
  });

  it("chmod 600 on every write", () => {
    const store = createVarStore(baseDir);
    store.set("global", "k", "v");
    expect(fs.statSync(store.path).mode & 0o777).toBe(0o600);
    // a second write keeps it 600
    store.set("global", "k2", "v2");
    expect(fs.statSync(store.path).mode & 0o777).toBe(0o600);
  });

  it("creates baseDir on first set when absent", () => {
    const nested = path.join(baseDir, "deep", "nested");
    const store = createVarStore(nested);
    store.set("global", "k", "v");
    expect(fs.existsSync(store.path)).toBe(true);
    expect(store.read("global", "k")).toBe("v");
  });

  it("secret flag round-trips + isSecret true; value still stored RAW", () => {
    const store = createVarStore(baseDir);
    store.set("owner/slug", "api_key", "sk-live-123", true);
    expect(store.isSecret("owner/slug", "api_key")).toBe(true);
    // the store holds the raw value (it IS the private file); masking is the caller's job
    expect(store.read("owner/slug", "api_key")).toBe("sk-live-123");
    // a non-secret in the same scope is not flagged
    store.set("owner/slug", "target", "x");
    expect(store.isSecret("owner/slug", "target")).toBe(false);
    // re-setting without secret clears the flag
    store.set("owner/slug", "api_key", "sk-live-456");
    expect(store.isSecret("owner/slug", "api_key")).toBe(false);
  });

  it("atomic write leaves no partial/temp file behind", () => {
    const store = createVarStore(baseDir);
    store.set("global", "k", "v");
    const leftovers = fs.readdirSync(baseDir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    // the final file is valid JSON (never a half-written file)
    expect(() => JSON.parse(fs.readFileSync(store.path, "utf-8"))).not.toThrow();
  });

  it("corrupt file reads as empty (never throws)", () => {
    const store = createVarStore(baseDir);
    fs.writeFileSync(store.path, "{ not json");
    expect(store.read("global", "k")).toBeUndefined();
    expect(store.readScope("global")).toEqual({});
  });
});

describe("recipe-var-store: envVarName", () => {
  it("upper-cases + sanitizes non-alnum to underscore", () => {
    expect(envVarName("target")).toBe("RECIPE_VAR_TARGET");
    expect(envVarName("funnel_repo")).toBe("RECIPE_VAR_FUNNEL_REPO");
    expect(envVarName("owned-domains")).toBe("RECIPE_VAR_OWNED_DOMAINS");
  });
});

describe("recipe-var-store: mergePrecedence (one assertion per tier)", () => {
  let baseDir: string;
  const decls: Record<string, RecipeParamSpec> = {
    v: { type: "string", default: "from-default" },
  };

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-vars-merge-"));
  });
  afterEach(() => fs.rmSync(baseDir, { recursive: true, force: true }));

  it("tier 1: call-site beats everything", () => {
    const store = createVarStore(baseDir);
    store.set("owner/slug", "v", "from-recipe");
    store.set("global", "v", "from-global");
    const { resolvedParams, provenance } = mergePrecedence(
      decls,
      { v: "from-call" },
      store,
      "owner/slug",
      { RECIPE_VAR_V: "from-env" },
    );
    expect(resolvedParams.v).toBe("from-call");
    expect(provenance.v).toBe("call-site");
  });

  it("tier 2: recipe-scope beats global/env/default", () => {
    const store = createVarStore(baseDir);
    store.set("owner/slug", "v", "from-recipe");
    store.set("global", "v", "from-global");
    const { resolvedParams, provenance } = mergePrecedence(decls, {}, store, "owner/slug", {
      RECIPE_VAR_V: "from-env",
    });
    expect(resolvedParams.v).toBe("from-recipe");
    expect(provenance.v).toBe("recipe-store");
  });

  it("tier 3: global beats env/default", () => {
    const store = createVarStore(baseDir);
    store.set("global", "v", "from-global");
    const { resolvedParams, provenance } = mergePrecedence(decls, {}, store, "owner/slug", {
      RECIPE_VAR_V: "from-env",
    });
    expect(resolvedParams.v).toBe("from-global");
    expect(provenance.v).toBe("global-store");
  });

  it("tier 4: env beats default", () => {
    const store = createVarStore(baseDir);
    const { resolvedParams, provenance } = mergePrecedence(decls, {}, store, "owner/slug", {
      RECIPE_VAR_V: "from-env",
    });
    expect(resolvedParams.v).toBe("from-env");
    expect(provenance.v).toBe("env");
  });

  it("tier 5: declared default is the final fallback", () => {
    const store = createVarStore(baseDir);
    const { resolvedParams, provenance } = mergePrecedence(decls, {}, store, "owner/slug", {});
    expect(resolvedParams.v).toBe("from-default");
    expect(provenance.v).toBe("default");
  });

  it("tier 6: no source → unresolved (no value, Unit 4 clear-fails)", () => {
    const store = createVarStore(baseDir);
    const noDefault: Record<string, RecipeParamSpec> = { v: { type: "string", required: true } };
    const { resolvedParams, provenance } = mergePrecedence(noDefault, {}, store, "owner/slug", {});
    expect(resolvedParams.v).toBeUndefined();
    expect(provenance.v).toBe("unresolved");
  });

  it("undeclared params pass call-site values through unchanged", () => {
    const store = createVarStore(baseDir);
    const { resolvedParams } = mergePrecedence(undefined, { x: "y" }, store, "owner/slug", {});
    expect(resolvedParams).toEqual({ x: "y" });
  });
});
