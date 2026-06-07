import type { RecipeParamSpec } from "./recipe-author.js";

// ─── BROCA MEMORY resolution tier (Seam 2 of the CONTEXT+MEMORY micro-design) ──
//
// The MEMORY tier is the broader/slower autonomy fallback that runs AFTER the
// SHIPPED P0 precedence (recipe-var-store.ts mergePrecedence) and AFTER the
// CONTEXT tier, but BEFORE any human ASK: for each still-unresolved NON-SECRET
// declared param it queries the episodic engram (`fork.memory.search`) and scrapes
// `name: value`-style lines out of the returned prose snippets. The engram was
// never designed as a key/value var store, so this is best-effort BY NATURE — any
// failure, timeout, !ok, or no-match falls through to the next tier and never
// throws into the run or blocks the gateway.
//
// Two hard guardrails (both proven by recipe-resolve-memory.test.ts):
//   1. Every recalled value is re-validated against its declared type/enum/pattern
//      before use — a hallucinated / mis-typed snippet is DROPPED, never injected.
//   2. Secrets are NEVER recalled here. The rpcs ingress excludes `secret:true`
//      vars from `missingDecls` up front; `parseMemoryHit`'s validator is an extra
//      backstop (it only ever sees the decls handed to it).
//
// The module is gateway-coupled (it calls the loopback) but its parse half
// (`parseMemoryHit`) and budget half (`deriveMemoryTimeoutMs`) are PURE and
// unit-testable with no fakes. The `callGateway` loopback is INJECTED (not
// imported) so the runner stays gateway-decoupled and tests need no live gateway.

/** A boolean truthy/falsey token set — mirrors validateParams (recipe-runner.ts). */
const BOOL_TRUE = new Set(["true", "1", "yes"]);
const BOOL_FALSE = new Set(["false", "0", "no"]);

/** Clamp a value into the [0,1] interval. */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * J16 (FOUNDATION §1, "fractal not fixed"): the engram-recall timeout is NOT a
 * constant. It is a function of the live situation:
 *   - missingCount        : more vars widen the OR-query → a slower search
 *   - fitnessSuccessRate  : a shakier recipe (low success) buys more patience
 *
 * Floored at `base` (one round-trip always gets the base budget). The coefficients
 * are a derivation, not the answer; the *output* responds to the inputs (proven by
 * recipe-resolve-memory.test.ts). Do NOT collapse this to a literal — that would
 * re-introduce a frozen MEMORY_TIMEOUT_MS (the exact J16 anti-pattern).
 */
export interface MemoryTimeoutSignals {
  /** Count of still-unresolved non-secret vars this recall must cover. */
  missingCount: number;
  /** Recipe fitness success rate in [0,1]; omit when unmeasured (defaults to 0.5). */
  fitnessSuccessRate?: number;
}

export function deriveMemoryTimeoutMs(signals: MemoryTimeoutSignals): number {
  const base = 5_000; // one engram search round-trip
  const perVar = 1_500 * Math.max(0, signals.missingCount);
  const uncertainty = 1 - clamp01(signals.fitnessSuccessRate ?? 0.5); // [0,1]
  const derived = Math.round((base + perVar) * (1 + 0.5 * uncertainty));
  return Math.max(base, derived); // never below base; never frozen
}

/**
 * Validate ONE recalled value against its declared spec, reusing the same checks
 * `validateParams` (recipe-runner.ts) applies. Returns the COERCED string on pass,
 * or `null` on fail (caller drops a null — a mis-typed recall never reaches a run).
 * Pure; no I/O.
 */
function validateRecalledValue(raw: string, spec: RecipeParamSpec): string | null {
  const value = raw.trim();
  if (value === "") return null;
  switch (spec.type) {
    case "string": {
      if (spec.pattern) {
        let re: RegExp | null = null;
        try {
          re = new RegExp(spec.pattern);
        } catch {
          re = null;
        }
        if (re && !re.test(value)) return null;
      }
      return value;
    }
    case "number": {
      const n = Number(value);
      return Number.isFinite(n) ? String(n) : null;
    }
    case "boolean": {
      const lc = value.toLowerCase();
      if (BOOL_TRUE.has(lc)) return "true";
      if (BOOL_FALSE.has(lc)) return "false";
      return null;
    }
    case "enum": {
      const members = spec.enum ?? [];
      return members.includes(value) ? value : null;
    }
    case "list<string>": {
      const items = value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return items.length > 0 ? items.join(",") : null;
    }
    default:
      return value;
  }
}

/**
 * PURE: scrape one engram snippet for the missing declared vars. For each var,
 * the FIRST `name <sep> value` line wins (sep ∈ `= : >`, case-insensitive on the
 * name), and the captured value is VALIDATED against the decl (enum/type/pattern);
 * a value that fails its own type/enum/pattern is DROPPED. Returns only validated
 * `{name: value}` pairs (possibly empty). Never throws.
 */
export function parseMemoryHit(
  snippet: string,
  missingDecls: Record<string, RecipeParamSpec>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof snippet !== "string" || snippet === "") return out;
  for (const [name, spec] of Object.entries(missingDecls)) {
    if (spec.secret === true) continue; // backstop: never recall a secret
    // Escape the var name for use in a RegExp, then match `name <sep> value`.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`${escaped}\\s*[=:>]\\s*([^\\n]+)`, "i");
    const m = re.exec(snippet); // first match wins
    if (!m) continue;
    const validated = validateRecalledValue(m[1], spec);
    if (validated !== null) out[name] = validated; // drop on validation fail
  }
  return out;
}

/** One engram search hit — the structural subset of MemorySearchResult we read. */
interface MemoryResult {
  snippet?: string;
  score?: number;
}

/** Injected loopback: the same shape as src/gateway/call.ts `callGateway<T>`. */
export type MemoryCallGateway = <T = unknown>(opts: {
  method: string;
  params?: unknown;
  timeoutMs?: number;
}) => Promise<T>;

export interface ResolveFromMemoryArgs {
  /** Still-unresolved NON-SECRET decls (the rpcs ingress already excluded secrets). */
  missingDecls: Record<string, RecipeParamSpec>;
  /** The run's session key, threaded to the engram search for scoping. */
  sessionKey?: string;
  /** Recipe fitness success rate in [0,1]; widens the J16 timeout when low. */
  fitnessSuccessRate?: number;
  /** The gateway loopback (injected — keeps the runner gateway-decoupled). */
  callGateway: MemoryCallGateway;
}

/**
 * MEMORY tier: recall still-unresolved NON-SECRET declared vars from the episodic
 * engram. Best-effort end-to-end — any throw / !ok / empty / no-match returns `{}`
 * so the caller falls through to the next tier. Never throws into the run.
 *
 *   1. `fork.memory.search` over the OR-joined non-secret var names, under the
 *      J16-derived timeout, asking for `missingCount*2` results at `minScore:0.6`.
 *   2. For each returned snippet, `parseMemoryHit` (first-wins per var); merge.
 */
export async function resolveFromMemory(
  args: ResolveFromMemoryArgs,
): Promise<Record<string, string>> {
  try {
    // Non-secret candidate names (the validator is a backstop; this is the gate).
    const names = Object.entries(args.missingDecls)
      .filter(([, spec]) => spec.secret !== true)
      .map(([name]) => name);
    if (names.length === 0) return {};

    const missingCount = names.length;
    const timeoutMs = deriveMemoryTimeoutMs({
      missingCount,
      fitnessSuccessRate: args.fitnessSuccessRate,
    });

    const res = await args.callGateway<{ ok?: boolean; results?: MemoryResult[] }>({
      method: "fork.memory.search",
      params: {
        query: names.join(" OR "),
        maxResults: missingCount * 2,
        minScore: 0.6,
        sessionKey: args.sessionKey,
      },
      timeoutMs,
    });

    if (!res || res.ok === false) return {};
    const results = Array.isArray(res.results) ? res.results : [];
    if (results.length === 0) return {};

    const merged: Record<string, string> = {};
    for (const r of results) {
      const snippet = typeof r?.snippet === "string" ? r.snippet : "";
      if (snippet === "") continue;
      const hits = parseMemoryHit(snippet, args.missingDecls);
      for (const [name, value] of Object.entries(hits)) {
        if (!(name in merged)) merged[name] = value; // first-wins per var
      }
    }
    return merged;
  } catch {
    return {}; // best-effort: any throw / timeout falls through to the next tier
  }
}
