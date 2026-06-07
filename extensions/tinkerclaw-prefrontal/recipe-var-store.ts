import fs from "node:fs";
import path from "node:path";
import type { RecipeParamSpec } from "./recipe-author.js";

// ─── BROCA private VarStore (Unit 3 / §4 of the params+varstore micro-design) ──
//
// A private, on-disk value store for recipe parameters. PII boundary: recipe .md
// files carry param NAMES + types + prompts + schemas ONLY — never values. Every
// real value lives here, in `${baseDir}/recipe-vars.json`, which sits at the
// `.openclaw` ROOT (NOT under /engram) so it is OUTSIDE every `~/.openclaw/.gitignore`
// whitelist → it can never reach the public fork. Every write chmods the file 600
// (matches the openclaw.json / token-cache precedent) and is atomic (temp sibling +
// renameSync), so a parallel reader never sees a partial file.
//
// The store does NOT do cross-scope precedence — `read(scope,name)` resolves within
// ONE scope; `mergePrecedence` below applies the call-site > recipe > global > env >
// default order. Secret values are held RAW in the file (it's the private store);
// MASKING IS THE CALLER'S JOB on every emit (trail / onRecipeState / dry-run / log).

/** A value scope: the special "global" bucket, or an "owner/slug" recipe scope. */
export type VarScope = "global" | string;

export interface VarStore {
  /** Resolved value for (scope,name), or undefined. Does NOT fall back across scopes — the caller does precedence. */
  read(scope: VarScope, name: string): string | undefined;
  /** Persist a value; chmods the backing file 600 on write; if secret, records it in the secret-name set for masking. */
  set(scope: VarScope, name: string, value: string, secret?: boolean): void;
  /** All (name→value) for a scope, for the precedence merge. Secret values returned RAW (caller masks for emit). */
  readScope(scope: VarScope): Record<string, string>;
  /** Is (scope,name) flagged secret? — drives masking in trail / onRecipeState. */
  isSecret(scope: VarScope, name: string): boolean;
  /** Path of the backing file (for trail provenance + tests). */
  readonly path: string;
}

interface VarStoreFile {
  version: 1;
  scopes: Record<string, Record<string, string>>;
  secrets: string[]; // "scope.name" keys flagged secret
}

/** The masked stand-in shown for a secret value in ANY emit (never the raw value). */
export const SECRET_MASK = "••••";

function secretKey(scope: VarScope, name: string): string {
  return `${scope}.${name}`;
}

function emptyFile(): VarStoreFile {
  return { version: 1, scopes: {}, secrets: [] };
}

/**
 * Create a VarStore backed by `${baseDir}/recipe-vars.json`.
 *
 * - Missing file → behaves as an empty store (no throw); the first `set` creates it
 *   (mkdir -p baseDir if absent).
 * - Every `set` writes atomically (temp sibling + renameSync) then chmods the final
 *   file 0o600.
 */
export function createVarStore(baseDir: string): VarStore {
  const filePath = path.join(baseDir, "recipe-vars.json");

  function load(): VarStoreFile {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch {
      return emptyFile(); // missing file = empty store
    }
    try {
      const parsed = JSON.parse(raw) as Partial<VarStoreFile> | null;
      if (!parsed || typeof parsed !== "object") return emptyFile();
      return {
        version: 1,
        scopes:
          parsed.scopes && typeof parsed.scopes === "object" && !Array.isArray(parsed.scopes)
            ? (parsed.scopes as Record<string, Record<string, string>>)
            : {},
        secrets: Array.isArray(parsed.secrets)
          ? parsed.secrets.filter((s): s is string => typeof s === "string")
          : [],
      };
    } catch {
      return emptyFile(); // corrupt file = empty store (never throw on read)
    }
  }

  function persist(data: VarStoreFile): void {
    fs.mkdirSync(baseDir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath); // atomic replace
    fs.chmodSync(filePath, 0o600); // chmod 600 the final file on EVERY write
  }

  return {
    path: filePath,

    read(scope, name) {
      const data = load();
      return data.scopes[scope]?.[name];
    },

    readScope(scope) {
      const data = load();
      return { ...(data.scopes[scope] ?? {}) };
    },

    isSecret(scope, name) {
      const data = load();
      return data.secrets.includes(secretKey(scope, name));
    },

    set(scope, name, value, secret) {
      const data = load();
      if (!data.scopes[scope]) data.scopes[scope] = {};
      data.scopes[scope][name] = value;
      const key = secretKey(scope, name);
      if (secret) {
        if (!data.secrets.includes(key)) data.secrets.push(key);
      } else {
        data.secrets = data.secrets.filter((k) => k !== key);
      }
      persist(data);
    },
  };
}

// ─── Resolution-precedence merge (§4.3) ───────────────────────────────────────
//
// For each declared param, resolve in this order, stop at first hit:
//   1. call-site         provided[name]
//   2. recipe-scoped     varStore.read(scope, name)              (scope = the run's kitRef)
//   3. global store      varStore.read("global", name)
//   4. env vars          process.env["RECIPE_VAR_" + UPPER(name)]
//   5. declared default  decls[name].default
//   6. (ASK)             OUT OF SCOPE — left unresolved (Unit 4 clear-fail).
//
// Pure + fs-free (the VarStore does the I/O); unit-testable with one assertion per tier.

export type VarSource =
  | "call-site"
  | "recipe-store"
  | "global-store"
  | "context"
  | "memory"
  | "env"
  | "default"
  | "unresolved";

export interface PrecedenceResult {
  resolvedParams: Record<string, string>;
  provenance: Record<string, VarSource>;
}

/** Canonical env-var name for a param: `RECIPE_VAR_` + UPPER(name), non-alnum → `_`. */
export function envVarName(name: string): string {
  return "RECIPE_VAR_" + name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function mergePrecedence(
  decls: Record<string, RecipeParamSpec> | undefined,
  provided: Record<string, string> | undefined,
  varStore: VarStore,
  scope: VarScope,
  env: Record<string, string | undefined> = process.env,
): PrecedenceResult {
  const resolvedParams: Record<string, string> = {};
  const provenance: Record<string, VarSource> = {};
  if (!decls) return { resolvedParams: { ...(provided ?? {}) }, provenance };

  for (const name of Object.keys(decls)) {
    // 1. call-site
    const callSite = provided?.[name];
    if (callSite !== undefined && callSite !== "") {
      resolvedParams[name] = callSite;
      provenance[name] = "call-site";
      continue;
    }
    // 2. recipe-scoped store
    const recipeScoped = varStore.read(scope, name);
    if (recipeScoped !== undefined && recipeScoped !== "") {
      resolvedParams[name] = recipeScoped;
      provenance[name] = "recipe-store";
      continue;
    }
    // 3. global store
    const global = varStore.read("global", name);
    if (global !== undefined && global !== "") {
      resolvedParams[name] = global;
      provenance[name] = "global-store";
      continue;
    }
    // 4. env vars (flag-like, opt-in)
    const fromEnv = env[envVarName(name)];
    if (fromEnv !== undefined && fromEnv !== "") {
      resolvedParams[name] = fromEnv;
      provenance[name] = "env";
      continue;
    }
    // 5. declared default
    const def = decls[name].default;
    if (def !== undefined) {
      resolvedParams[name] = String(def);
      provenance[name] = "default";
      continue;
    }
    // 6. unresolved (Unit 4's clear-fail backstop reports this)
    provenance[name] = "unresolved";
  }
  return { resolvedParams, provenance };
}
