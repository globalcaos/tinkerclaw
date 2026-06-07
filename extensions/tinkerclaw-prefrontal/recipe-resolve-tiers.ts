import type { RecipeParamSpec } from "./recipe-author.js";
import { resolveFromContext, type GatewayCall } from "./recipe-resolve-context.js";
import { resolveFromMemory, type MemoryCallGateway } from "./recipe-resolve-memory.js";
import type { VarSource } from "./recipe-var-store.js";

// ─── BROCA CONTEXT+MEMORY resolution ingress (Seam 3 of the micro-design) ──────
//
// This is the THIN orchestrator the recipe.run ingress calls AFTER the shipped P0
// precedence merge (recipe-var-store.ts mergePrecedence) and BEFORE the runner's
// validateParams gate. It runs the two autonomy tiers IN ORDER:
//
//   1. CONTEXT (recipe-resolve-context.ts) — extract still-missing NON-SECRET vars
//      from the run intent + recent conversation (one structured-extraction call).
//   2. MEMORY  (recipe-resolve-memory.ts)  — recall whatever CONTEXT could not, by
//      scraping the episodic engram.
//
// Three invariants (all proven by recipe-resolve-tiers.test.ts §4.D):
//   - SECRET-SKIP (#12): a decl with `secret:true` is NEVER handed to either tier.
//     An inferred credential is a hint, not ground truth — it must flow through the
//     confirmed durable ASK, not be auto-resolved. Such a var stays 'unresolved'.
//   - TIER-ORDER (#13): CONTEXT runs first, so a var resolvable by BOTH ends up
//     stamped 'context'; a var only in MEMORY ends 'memory'. A var already resolved
//     by P0 (provenance ≠ 'unresolved') is never touched — these tiers only fill
//     genuine gaps; they never override an already-resolved value.
//   - BEST-EFFORT: each tier is wrapped in its own try/catch. A throwing tier falls
//     through to the next (or to validateParams) — it can never throw into the run.
//
// The result is RUN-SCOPED: callers must NOT persist these values to the VarStore.
// We mutate the SAME `resolvedParams` / `provenance` maps the caller passed (so the
// already-built masked provenance trail records the tier automatically) and return
// them for convenience.

/**
 * The injected gateway loopback. Structurally identical to both tier loopback
 * types (`GatewayCall` / `MemoryCallGateway`) and to src/gateway/call.ts
 * `callGateway` — `{ method, params?, timeoutMs? } => Promise<T>` — so the real
 * `callGateway` is assignable here without an adapter.
 */
export type TierCallGateway = <T = unknown>(opts: {
  method: string;
  params?: unknown;
  timeoutMs?: number;
}) => Promise<T>;

export interface ResolveContextMemoryTiersArgs {
  /** The recipe's declared params (Unit 1 frontmatter). undefined → no-op. */
  declaredParams: Record<string, RecipeParamSpec> | undefined;
  /** P0's resolved values (mutated in place: name → coerced string). */
  resolvedParams: Record<string, string>;
  /** P0's provenance map (mutated in place: name → VarSource). */
  provenance: Record<string, VarSource>;
  /** The run intent (steers CONTEXT extraction). */
  intent?: string;
  /** The run's session key (scopes both the chat poll and the engram search). */
  sessionKey?: string;
  /** Recipe fitness success rate in [0,1]; widens the J16 tier timeouts when low. */
  fitnessSuccessRate?: number;
  /** Recipe step count, threaded to CONTEXT's J16 signal surface. */
  stepCount?: number;
  /** The gateway loopback (injected — keeps the runner gateway-decoupled). */
  callGateway: TierCallGateway;
}

export interface ResolveContextMemoryTiersResult {
  resolvedParams: Record<string, string>;
  provenance: Record<string, VarSource>;
}

/**
 * Run the CONTEXT then MEMORY tiers over the params P0 left 'unresolved'.
 *
 * Best-effort end-to-end: each tier is independently try/caught, so a failure in
 * one never blocks the other or the run. Mutates and returns `resolvedParams` /
 * `provenance` (run-scoped — do NOT persist to the VarStore).
 */
export async function resolveContextMemoryTiers(
  args: ResolveContextMemoryTiersArgs,
): Promise<ResolveContextMemoryTiersResult> {
  const {
    declaredParams,
    resolvedParams,
    provenance,
    intent,
    sessionKey,
    fitnessSuccessRate,
    stepCount,
    callGateway,
  } = args;

  // No decls → un-parameterized recipe → nothing to resolve (overlay, back-compat).
  if (!declaredParams) return { resolvedParams, provenance };

  // SECRET-SKIP up front (#12): a still-'unresolved' var is a CANDIDATE only if it
  // is NOT a secret. A secret is never passed to either tier — it stays 'unresolved'
  // and flows on to the confirmed durable ASK.
  const candidates: Record<string, RecipeParamSpec> = {};
  for (const [name, spec] of Object.entries(declaredParams)) {
    if (provenance[name] !== "unresolved") continue; // already resolved by P0 → never touch
    if (spec?.secret === true) continue; // secret → never auto-resolved by these tiers
    candidates[name] = spec;
  }
  if (Object.keys(candidates).length === 0) return { resolvedParams, provenance };

  // 1. CONTEXT tier (best-effort). Stamp + drop each resolved name.
  let stillUnresolved: Record<string, RecipeParamSpec> = candidates;
  try {
    const fromContext = await resolveFromContext({
      missingDecls: stillUnresolved,
      intent,
      sessionKey,
      fitnessSuccessRate,
      stepCount,
      callGateway: callGateway as GatewayCall,
    });
    const remaining: Record<string, RecipeParamSpec> = {};
    for (const [name, spec] of Object.entries(stillUnresolved)) {
      const value = fromContext[name];
      if (typeof value === "string" && value.length > 0 && provenance[name] === "unresolved") {
        resolvedParams[name] = value;
        provenance[name] = "context";
      } else {
        remaining[name] = spec; // not resolved here → hand to MEMORY
      }
    }
    stillUnresolved = remaining;
  } catch {
    // CONTEXT threw → fall through with the full candidate set intact.
  }

  if (Object.keys(stillUnresolved).length === 0) return { resolvedParams, provenance };

  // 2. MEMORY tier (best-effort) for whatever CONTEXT could not resolve.
  try {
    const fromMemory = await resolveFromMemory({
      missingDecls: stillUnresolved,
      sessionKey,
      fitnessSuccessRate,
      callGateway: callGateway as MemoryCallGateway,
    });
    for (const [name, value] of Object.entries(fromMemory)) {
      if (typeof value === "string" && value.length > 0 && provenance[name] === "unresolved") {
        resolvedParams[name] = value;
        provenance[name] = "memory";
      }
    }
  } catch {
    // MEMORY threw → leave the remainder 'unresolved' for the downstream ASK.
  }

  return { resolvedParams, provenance };
}
