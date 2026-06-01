/**
 * FORK 2026-05-31: Reasoning runtime — the LIVE wiring for the (previously dead)
 * Tree-of-Thoughts library (src/agents/thought-search.ts + reasoning-tree.ts).
 *
 * The library takes an injected GenerateFn + ScoreFn (pure/testable). This module
 * supplies LLM-backed versions and exposes `fork.reasoning.search` so Jarvis can run a
 * deliberate, bounded search on a hard problem on demand — search-BEFORE-answering for
 * the cases a single pass would fumble. It does NOT touch the inference pipeline; it is
 * an explicit tool, effort-appropriate (the caller decides when a problem warrants it).
 *
 * COST CONTROL: the generator SELF-SCORES its candidates (one spawn per node expansion,
 * not one per thought), and ScoreFn just reads those stashed scores — so a search costs
 * ~one subagent spawn per expanded node, bounded by the search budgets. Default budgets
 * are deliberately small.
 */

import { createSessionManagerRuntimeRegistry } from "../agents/pi-extensions/session-manager-runtime-registry.js";
import type { SerializedTree } from "../agents/reasoning-tree.js";
import {
  runThoughtSearch,
  type GenerateFn,
  type GeneratedThought,
  type ScoreFn,
  type SearchBudgets,
  type SearchResult,
} from "../agents/thought-search.js";
import { pruneBelowMean } from "../agents/thought-search.js";
import { ErrorCodes, errorShape } from "../gateway/protocol/index.js";
import type { GatewayRequestHandlers } from "../gateway/server-methods/shared-types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("fork-reasoning");

const RUN_TIMEOUT_S = 60;

/** Spawn a one-shot subagent with `task`, wait, and return its final assistant text. */
async function spawnText(task: string, label: string): Promise<string> {
  const { callGateway } = await import("../gateway/call.js");
  const spawn = await callGateway<{
    ok?: boolean;
    childSessionKey?: string;
    runId?: string;
    note?: string;
  }>({
    method: "fork.subagents.spawn",
    params: {
      task,
      label,
      parentSessionKey: "agent:main:main",
      runTimeoutSeconds: RUN_TIMEOUT_S,
      expectsCompletionMessage: false,
    },
    timeoutMs: (RUN_TIMEOUT_S + 10) * 1000,
  });
  if (!spawn?.ok || !spawn.childSessionKey || !spawn.runId) {
    throw new Error(`reasoning spawn failed: ${spawn?.note ?? "no childSessionKey/runId"}`);
  }
  const { childSessionKey, runId } = spawn;
  const wait = await callGateway<{ status?: "ok" | "timeout" | "error"; error?: string }>({
    method: "agent.wait",
    params: { runId, timeoutMs: RUN_TIMEOUT_S * 1000 },
    timeoutMs: RUN_TIMEOUT_S * 1000 + 5_000,
  });
  if (wait?.status === "error") throw new Error(`reasoning run errored: ${wait.error ?? "?"}`);
  if (wait?.status === "timeout") return "";
  const deadline = Date.now() + 10_000;
  do {
    const hist = await callGateway<{ messages?: Array<{ role?: string; content?: unknown }> }>({
      method: "chat.history",
      params: { sessionKey: childSessionKey, limit: 30 },
      timeoutMs: 10_000,
    });
    const messages = Array.isArray(hist?.messages) ? hist.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role !== "assistant") continue;
      const c = messages[i].content;
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c
                .map((b) =>
                  typeof (b as { text?: unknown })?.text === "string"
                    ? (b as { text: string }).text
                    : "",
                )
                .join("")
            : "";
      if (text.trim()) return text.trim();
      break;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 150));
  } while (true);
  return "";
}

export interface ParsedThought {
  text: string;
  /** 0..1 self-assessed promise score. */
  score: number;
}

/** Parse the generator's output lines of the form `- <thought> :: <0-100>`. Pure +
 *  testable. Lines without a score default to 0.5; malformed lines are skipped. */
export function parseThoughts(raw: string): ParsedThought[] {
  const out: ParsedThought[] = [];
  for (const line of (raw ?? "").split("\n")) {
    const m = /^\s*[-*]\s*(.+?)\s*(?:::\s*(\d{1,3}))?\s*$/.exec(line);
    if (!m) continue;
    const text = m[1].trim();
    if (!text) continue;
    const score = m[2] !== undefined ? Math.max(0, Math.min(100, Number(m[2]))) / 100 : 0.5;
    out.push({ text, score });
  }
  return out;
}

const DEFAULT_BUDGETS: SearchBudgets = {
  maxDepth: 2,
  branchingFactor: 3,
  beamWidth: 2,
  maxTokens: 8000,
  maxLatencyMs: 150_000,
  maxSteps: 8,
  pruneThreshold: pruneBelowMean,
};

/**
 * Run a bounded LLM-backed thought search over `problem`. The generator self-scores its
 * candidates (stashed) so ScoreFn is a cheap lookup → ~one spawn per expanded node.
 */
export async function runReasoningSearch(
  problem: string,
  budgets: Partial<SearchBudgets> = {},
): Promise<SearchResult> {
  const scoreCache = new Map<string, number>();

  const generate: GenerateFn = async (parentContent, k, ctx) => {
    const task = `You are exploring solutions to a hard problem via tree-of-thoughts search.

PROBLEM: ${ctx.rootPrompt}

REASONING SO FAR (the path to here): ${parentContent || "(this is the first step)"}

Propose up to ${k} DISTINCT, concrete candidate NEXT thoughts/steps that each advance toward solving the PROBLEM (not the whole solution — the next move). For EACH, append a promise score 0-100 (how likely this line of reasoning leads to a correct, complete solution). Output ONLY lines in EXACTLY this format, nothing else:
- <the next thought> :: <score 0-100>`;
    const raw = await spawnText(task, "reason:gen");
    const parsed = parseThoughts(raw).slice(0, k);
    const thoughts: GeneratedThought[] = parsed.map((p) => {
      scoreCache.set(p.text, p.score);
      return { text: p.text, tokens: Math.ceil(p.text.length / 4) };
    });
    return thoughts;
  };

  const score: ScoreFn = (content) => scoreCache.get(content) ?? 0.5;

  return runThoughtSearch(problem, generate, score, { ...DEFAULT_BUDGETS, ...budgets });
}

function readStr(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function readNum(p: Record<string, unknown>, k: string): number | undefined {
  const v = p[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export const forkReasoningHandlers: GatewayRequestHandlers = {
  // Deliberate, bounded tree-of-thoughts search over a hard problem. On-demand;
  // Jarvis invokes it when a problem warrants search-before-answering.
  "fork.reasoning.search": async ({ params, respond }) => {
    const p = params ?? {};
    const problem = readStr(p, "problem") ?? readStr(p, "prompt");
    if (!problem) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "fork.reasoning.search requires 'problem'."),
      );
      return;
    }
    const budgets: Partial<SearchBudgets> = {};
    const md = readNum(p, "maxDepth");
    const bf = readNum(p, "branchingFactor");
    const bw = readNum(p, "beamWidth");
    if (md !== undefined) budgets.maxDepth = Math.max(1, Math.min(4, md));
    if (bf !== undefined) budgets.branchingFactor = Math.max(2, Math.min(5, bf));
    if (bw !== undefined) budgets.beamWidth = Math.max(1, Math.min(4, bw));
    try {
      const res = await runReasoningSearch(problem, budgets);
      log.info(
        `[reasoning] search done: steps=${res.steps} depth=${res.depthReached} stop=${res.stopReason}`,
      );
      respond(
        true,
        {
          answer: res.answer,
          steps: res.steps,
          depthReached: res.depthReached,
          tokensUsed: res.tokensUsed,
          stopReason: res.stopReason,
          winningPath: res.trace.winningPath,
        },
        undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `reasoning search failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },
};

// ---------------------------------------------------------------------------
// U10 — ToT/LATS per-session registry + escalation gating (pre-prompt seam)
// ---------------------------------------------------------------------------
//
// The Wire phase (attempt.ts) calls `maybeRunThoughtSearch` immediately after
// `injectRetrievalPack` so the search sees the retrieval pack as context. When
// the reasoning mode is "none" (the DEFAULT — ToT is opt-in and expensive) or
// the session is automated (cron/heartbeat/subagent), it is a pure pass-through.

/** Tri-state reasoning mode read from `fork.cognitive.reasoning`. */
export type ReasoningMode = "none" | "tree" | "lats";

/**
 * Result of a per-turn deliberation. `trace` is the serialized search tree (or
 * null when no tree was built) so `onTurnComplete` can persist it as a
 * `reasoning_tree_state` MemoryEvent (wired later).
 */
export interface ReasoningResult {
  /** The winning leaf content to fold into the prompt under "## Deliberation". */
  answer: string;
  /** Serialized search tree for persistence, or null. */
  trace: SerializedTree | null;
}

/**
 * Per-session reasoning executor. Holds the configured budgets and runs a bounded
 * thought search for one turn. Injected so the registry stays provider-agnostic
 * and the pre-prompt hook is unit-testable without an LLM.
 */
export interface ReasoningRuntime {
  /** Run a deliberation for `query` given the assembled `systemPromptText`. */
  run(query: string, systemPromptText: string): Promise<ReasoningResult>;
}

const reasoningRegistry = createSessionManagerRuntimeRegistry<ReasoningRuntime>();

/** Store a reasoning runtime for a given session manager instance. */
export const setReasoningRuntime = reasoningRegistry.set;

/** Retrieve the reasoning runtime for a given session manager instance, or null. */
export const getReasoningRuntime = reasoningRegistry.get;

/** Minimal shape of the runtime config snapshot we read for the reasoning mode. */
type ConfigSnapshotReader = () =>
  | { config?: { fork?: { cognitive?: Record<string, unknown> } } }
  | null
  | undefined;

const defaultSnapshotReader: ConfigSnapshotReader = () => {
  // Mirrors isInlineMode() in attempt-hooks.ts: read dynamically so we don't
  // depend on the typed `fork.cognitive.reasoning` key existing yet (it is a
  // config-shape addition owned by the Wire phase — see handoff note).
  const { getRuntimeConfigSnapshot } = require("../config/config.js") as {
    getRuntimeConfigSnapshot: () =>
      | { config?: { fork?: { cognitive?: Record<string, unknown> } } }
      | null
      | undefined;
  };
  return getRuntimeConfigSnapshot();
};

/**
 * Resolve the reasoning mode tri-state from `fork.cognitive.reasoning`.
 *
 * Defaults to `"none"` — ToT is opt-in and expensive, so it must NOT default
 * on. An unknown/invalid value coerces back to `"none"` (fail safe), and a
 * throwing/absent snapshot also yields `"none"`. `readSnapshot` is injectable
 * for tests; production uses the live runtime config snapshot.
 */
export function getReasoningMode(
  readSnapshot: ConfigSnapshotReader = defaultSnapshotReader,
): ReasoningMode {
  try {
    const mode = readSnapshot()?.config?.fork?.cognitive?.reasoning;
    return mode === "tree" || mode === "lats" ? mode : "none";
  } catch {
    return "none"; // safe fallback: reasoning off
  }
}

/** A query shorter than this (after trim) is treated as not search-worthy. */
const MIN_SEARCH_WORTHY_CHARS = 12;

/**
 * Escalation-gating predicate — should a thought search run for this turn?
 *
 * False when:
 *  - mode is "none" (the default-off invariant),
 *  - the session is automated (cron/heartbeat/subagent/isolated) — a search
 *    before every cron tick is wasteful and risks recursive triggering, and
 *  - the query is empty/trivial (a greeting or acknowledgement is not worth a
 *    multi-spawn search).
 *
 * Pure + testable; the caller supplies `isAutomatedSession` (computed from the
 * session key) so this module stays free of session-key parsing.
 */
export function shouldRunThoughtSearch(
  query: string,
  mode: ReasoningMode,
  isAutomatedSession: boolean,
): boolean {
  if (mode === "none") return false;
  if (isAutomatedSession) return false;
  const trimmed = (query ?? "").trim();
  if (trimmed.length < MIN_SEARCH_WORTHY_CHARS) return false;
  return true;
}

export interface MaybeRunThoughtSearchArgs {
  /** The SessionManager instance keying the per-session reasoning runtime. */
  sessionManager: unknown;
  /** The assembled system prompt (post retrieval-pack) to augment + return. */
  systemPromptText: string;
  /** The user query driving this turn. */
  query: string;
  /** Whether this is a cron/heartbeat/subagent/isolated session. */
  isAutomatedSession: boolean;
  /**
   * The run id for this turn. When a deliberation produces a search tree it is
   * stashed by this id so `onTurnComplete` (attempt-hooks) can persist it as a
   * `reasoning_tree_state` MemoryEvent. Empty/undefined → trace not stashed.
   */
  runId?: string;
  /** Injectable mode reader (defaults to the live config snapshot). */
  readMode?: () => ReasoningMode;
  /**
   * Injectable trace sink (defaults to attempt-hooks `stashReasoningTrace`).
   * Lets the producer-wiring be unit-tested without the attempt-hooks module.
   */
  stashTrace?: (runId: string, trace: SerializedTree | null) => void;
}

/**
 * Pre-prompt hook: run a bounded thought search before the model call and fold
 * the winning deliberation into the system prompt.
 *
 * No-op pass-through (returns `systemPromptText` unchanged) when:
 *  - gating says no (`shouldRunThoughtSearch` false), or
 *  - no reasoning runtime is registered for the session.
 *
 * Never throws — a failed search degrades to pass-through so a deliberation
 * error can never break the turn.
 */
export async function maybeRunThoughtSearch(args: MaybeRunThoughtSearchArgs): Promise<string> {
  const { sessionManager, systemPromptText, query, isAutomatedSession, runId } = args;
  const readMode = args.readMode ?? (() => getReasoningMode());
  let mode: ReasoningMode;
  try {
    mode = readMode();
  } catch {
    return systemPromptText;
  }
  if (!shouldRunThoughtSearch(query, mode, isAutomatedSession)) {
    return systemPromptText;
  }
  const runtime = getReasoningRuntime(sessionManager);
  if (!runtime) return systemPromptText;
  try {
    const result = await runtime.run(query, systemPromptText);
    // Stash the search tree by runId so onTurnComplete (attempt-hooks) can
    // persist it as a `reasoning_tree_state` MemoryEvent. Without this the
    // consume path stays inert and the trace is silently discarded.
    if (runId) {
      try {
        await stashReasoningTraceVia(args.stashTrace, runId, result.trace);
      } catch (stashErr) {
        // Persisting the trace is best-effort and must never break the turn.
        log.warn(
          `[reasoning] failed to stash reasoning trace; deliberation continues: ${
            stashErr instanceof Error ? stashErr.message : String(stashErr)
          }`,
        );
      }
    }
    const deliberation = (result.answer ?? "").trim();
    if (!deliberation) return systemPromptText;
    return `${systemPromptText}\n\n## Deliberation\n${deliberation}`;
  } catch (err) {
    log.warn(
      `[reasoning] thought search failed; passing through: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return systemPromptText;
  }
}

/**
 * Resolve the trace sink: an injected sink (tests) or the real
 * attempt-hooks `stashReasoningTrace` (production), loaded dynamically to keep
 * the producer free of a static dependency on the consume seam.
 */
async function stashReasoningTraceVia(
  injected: ((runId: string, trace: SerializedTree | null) => void) | undefined,
  runId: string,
  trace: SerializedTree | null,
): Promise<void> {
  if (injected) {
    injected(runId, trace);
    return;
  }
  const { stashReasoningTrace } = await import("./attempt-hooks.js");
  stashReasoningTrace(runId, trace);
}
