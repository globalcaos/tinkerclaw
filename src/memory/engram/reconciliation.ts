/**
 * ENGRAM — Mem0-style write reconciliation (Upgrade 8).
 *
 * Classifies each candidate memory event as:
 *   - ADD    : new fact, persist it (the only thing that ever touched the JSONL before)
 *   - UPDATE : supersedes an existing fact (logical, recorded in a ledger; never mutates JSONL)
 *   - DELETE : redundant/stale fact (logical tombstone; never mutates JSONL)
 *   - NONE   : not worth storing on the hot path (skip the append)
 *
 * TWO PLANES (load-bearing design constraint):
 *   1. Audit plane (JSONL) stays append-only and immutable — preserves the
 *      per-session parallelism-safety invariant the EventStore is built on.
 *   2. Working-memory plane (reconciliation ledger + the regenerated MEMORY.md)
 *      is where UPDATE/DELETE take effect, as *logical* supersede/tombstone rows.
 *
 * HOT-PATH SAFETY (highest risk): `decide()` runs every turn via the ingestion
 * pipeline. It MUST be cheap and MUST only ever return ADD or NONE — never
 * UPDATE/DELETE. UPDATE/DELETE are deferred to the nightly consolidation sweep
 * (`reconcileWindow`), which may be LLM-backed.
 *
 * BACKWARD COMPAT: the default reconciler is `createAlwaysAddReconciler()` which
 * returns ADD for every event. With it (or with no reconciler at all) the
 * ingestion + consolidation behavior is byte-identical to today.
 *
 * FORK-ISOLATED: unique to our fork (Total Recall paper, Upgrade 8).
 */

import type { MemoryEvent } from "./event-types.js";

export type ReconcileAction = "ADD" | "UPDATE" | "DELETE" | "NONE";

export interface ReconciliationDecision {
  action: ReconcileAction;
  reason?: string;
  /** For UPDATE/DELETE: which prior event/fact this supersedes or tombstones. */
  targetEventId?: string;
  /** Optional refined importance (overrides the static IMPORTANCE_BY_KIND map). */
  importance?: number;
}

export interface ReconciliationContext {
  /** Current size of the working store, bytes. */
  totalMemoryBytes: number;
  /** Number of events currently in the store. */
  eventCount: number;
  /** Current MEMORY.md line count — the bound we defend. */
  memoryMdLineCount: number;
  /** "ingest" = hot path (ADD/NONE only); "consolidation" = nightly sweep. */
  phase: "ingest" | "consolidation";
}

export interface MemoryReconciler {
  /**
   * Hot path. MUST return only ADD or NONE. Cheap, synchronous-ish.
   * Called once per candidate event from the ingestion pipeline.
   */
  decide(event: MemoryEvent, ctx: ReconciliationContext): Promise<ReconciliationDecision>;
  /**
   * Synchronous hot-path variant for the ingestion fast path (which is sync).
   * MUST return only ADD or NONE. The ingestion pipeline uses this when present.
   */
  decideSync(event: MemoryEvent, ctx: ReconciliationContext): ReconciliationDecision;
  /**
   * Nightly sweep. May return UPDATE/DELETE; may call an LLM. Operates over the
   * unprocessed consolidation window and returns one decision per input event.
   */
  reconcileWindow(
    events: MemoryEvent[],
    ctx: ReconciliationContext,
  ): Promise<ReconciliationDecision[]>;
}

/** Kinds that should never be reconciled away (mirrors NON_EVICTABLE_KINDS intent). */
const PROTECTED_KINDS = new Set(["system_event", "persona_state", "compaction_marker"]);

/**
 * Default reconciler: every event is ADD, nothing is ever reconciled away.
 * Restores exact pre-reconciliation behavior (risk #4, backward compat).
 */
export function createAlwaysAddReconciler(): MemoryReconciler {
  return {
    async decide(): Promise<ReconciliationDecision> {
      return { action: "ADD" };
    },
    decideSync(): ReconciliationDecision {
      return { action: "ADD" };
    },
    async reconcileWindow(events: MemoryEvent[]): Promise<ReconciliationDecision[]> {
      return events.map(() => ({ action: "ADD" }));
    },
  };
}

export interface BoundedReconcilerOptions {
  /** MEMORY.md line bound above which low-value events are skipped. Default 500. */
  maxMemoryMdLines?: number;
  /** Working-store byte bound above which low-value events are skipped. */
  maxMemoryBytes?: number;
  /** Importance at/below which an event is droppable when over budget. Default 3. */
  lowImportanceFloor?: number;
}

const DEFAULT_BOUNDED_OPTIONS: Required<BoundedReconcilerOptions> = {
  maxMemoryMdLines: 500,
  maxMemoryBytes: 50 * 1024 * 1024,
  lowImportanceFloor: 3,
};

/**
 * Size-aware reconciler for the hot path. Returns NONE for low-importance,
 * non-protected events once the working store is over budget; ADD otherwise.
 * NEVER returns UPDATE/DELETE — the hot-path safety invariant.
 */
export function createBoundedReconciler(opts: BoundedReconcilerOptions = {}): MemoryReconciler {
  const cfg = { ...DEFAULT_BOUNDED_OPTIONS, ...opts };

  function hotDecide(event: MemoryEvent, ctx: ReconciliationContext): ReconciliationDecision {
    if (PROTECTED_KINDS.has(event.kind)) {
      return { action: "ADD", reason: "protected kind" };
    }
    const overLines = ctx.memoryMdLineCount > cfg.maxMemoryMdLines;
    const overBytes = ctx.totalMemoryBytes > cfg.maxMemoryBytes;
    const importance = event.metadata?.importance ?? 5;
    if ((overLines || overBytes) && importance <= cfg.lowImportanceFloor) {
      return {
        action: "NONE",
        reason: `over budget (lines=${ctx.memoryMdLineCount}, bytes=${ctx.totalMemoryBytes}) and importance=${importance} <= ${cfg.lowImportanceFloor}`,
      };
    }
    return { action: "ADD" };
  }

  return {
    async decide(event, ctx): Promise<ReconciliationDecision> {
      // Hot-path safety: never UPDATE/DELETE here.
      return hotDecide(event, ctx);
    },
    decideSync(event, ctx): ReconciliationDecision {
      return hotDecide(event, ctx);
    },
    async reconcileWindow(events): Promise<ReconciliationDecision[]> {
      // Bounded reconciler does not do semantic supersede; defer to heuristic.
      return reconcileWindowHeuristic(events);
    },
  };
}

/**
 * Normalise an event's content to a comparable "fact key" for dedup/supersede
 * detection. Conservative — only message/result kinds are reconciled.
 */
function factKey(event: MemoryEvent): string | null {
  if (PROTECTED_KINDS.has(event.kind)) {
    return null;
  }
  const norm = event.content.trim().toLowerCase().replace(/\s+/g, " ");
  if (!norm) {
    return null;
  }
  return `${event.kind}:${norm}`;
}

/**
 * Heuristic window reconciliation (deterministic, no LLM). Detects:
 *   - exact-duplicate content (same factKey) → later one DELETEs the duplicate
 *     (targetEventId = the earlier duplicate).
 *
 * This is the safe, testable default for the nightly sweep. A richer LLM-backed
 * reconciler (semantic supersede/contradiction) can be supplied separately.
 */
export function reconcileWindowHeuristic(events: MemoryEvent[]): ReconciliationDecision[] {
  const seen = new Map<string, MemoryEvent>();
  const decisions: ReconciliationDecision[] = [];

  for (const event of events) {
    const key = factKey(event);
    if (key === null) {
      decisions.push({ action: "ADD", reason: "protected/empty" });
      continue;
    }
    const prior = seen.get(key);
    if (prior) {
      decisions.push({
        action: "DELETE",
        targetEventId: prior.id,
        reason: `exact duplicate of ${prior.id}`,
      });
      // The newer event becomes the canonical survivor for this key.
      seen.set(key, event);
    } else {
      seen.set(key, event);
      decisions.push({ action: "ADD" });
    }
  }

  return decisions;
}

/**
 * LLM-backed reconciler (true Mem0). On the hot path it degrades to ADD/NONE
 * via the bounded reconciler's hot rule; the nightly sweep delegates semantic
 * supersede/contradiction decisions to the injected `classify` callback.
 *
 * The callback is given the new event plus candidate prior facts and returns a
 * decision; if it throws or returns an out-of-band action on the hot path, we
 * fall back to ADD to preserve safety.
 */
export type ReconcileClassifier = (
  event: MemoryEvent,
  priorFacts: MemoryEvent[],
) => Promise<ReconciliationDecision> | ReconciliationDecision;

export function createMem0Reconciler(
  classify: ReconcileClassifier,
  opts: BoundedReconcilerOptions = {},
): MemoryReconciler {
  const bounded = createBoundedReconciler(opts);

  return {
    async decide(event, ctx): Promise<ReconciliationDecision> {
      // Hot path is ALWAYS ADD/NONE — no LLM, no UPDATE/DELETE.
      return bounded.decide(event, ctx);
    },
    decideSync(event, ctx): ReconciliationDecision {
      return bounded.decideSync(event, ctx);
    },
    async reconcileWindow(events): Promise<ReconciliationDecision[]> {
      const survivors: MemoryEvent[] = [];
      const decisions: ReconciliationDecision[] = [];
      for (const event of events) {
        const key = factKey(event);
        if (key === null) {
          decisions.push({ action: "ADD", reason: "protected/empty" });
          survivors.push(event);
          continue;
        }
        try {
          const d = await classify(event, survivors);
          decisions.push(d);
          if (d.action === "ADD" || d.action === "UPDATE") {
            survivors.push(event);
          }
        } catch {
          // On classifier failure, default to ADD (never lose data).
          decisions.push({ action: "ADD", reason: "classifier error → ADD" });
          survivors.push(event);
        }
      }
      return decisions;
    },
  };
}
