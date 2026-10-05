// The per-call seam between the embedded runner and THALAMUS v4 (design doc section 6.2; paper P§5).
//
// WHAT THIS IS FOR. Every model call of an embedded run goes through `agent.streamFn(model, context, options)`.
// A router registered here is told about each call BEFORE it goes out, so THALAMUS can compute the decision it
// would take on the real path. In shadow mode that is all it does: it observes, it never changes what is sent.
//
// FAIL OPEN, NEVER LATE. The router is called synchronously and must be quick; anything it throws is swallowed
// by the wrapper, and anything slow (a ledger write, a broadcast) is the router's job to defer.
//
// WHY A globalThis SLOT. The runner lives in the gateway bundle and the plugin reaches this file through the
// `openclaw/plugin-sdk/fork-thalamus` bundle. Each gets its own copy of this module, so the registration sits on a
// Symbol.for key that both copies read.

export type CallRouteMeta = {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  trigger?: string;
  provider: string;
  model: string;
  api?: string;
  thinkLevel?: string;
};

export type CallRouteCall = {
  /** The model the runner is about to call, exactly as it will be sent. Read only. */
  model: unknown;
  /** The conversation the call carries. Read only. */
  context: unknown;
  meta: CallRouteMeta;
  /** 0-based ordinal of the calls this run has made through the router. */
  callIndex: number;
};

export interface CallRouter {
  /** Observe one call. Must not throw, must not block, and must not modify its arguments. */
  observe(call: CallRouteCall): void;
}

const KEY = Symbol.for("openclaw.thalamus.callRouter");
type Slot = { [KEY]?: CallRouter };

/** Register a router; the returned function removes it (and only it). */
export function registerCallRouter(router: CallRouter): () => void {
  (globalThis as Slot)[KEY] = router;
  return () => {
    if ((globalThis as Slot)[KEY] === router) delete (globalThis as Slot)[KEY];
  };
}

export function getCallRouter(): CallRouter | undefined {
  return (globalThis as Slot)[KEY];
}

// ─── the tool-result digester (design doc section 6.2, unit D3; paper P§5.2) ────────────────────────────────────
//
// A second seam of the same family. When a tool returns a long text result, a registered digester may hand back a
// shorter text to put in the thread in its place (the raw result stays on disk under a name, kept by the digester).
// It is ASYNC because a reader model may be called, which is why it sits on the tool's own `execute` and not on the
// synchronous `tool_result_persist` hook. It is only ever registered in enforce mode with the digest flag on.
//
// FAIL OPEN. Undefined, a throw or a rejection all mean "keep the result as it was".

export type ToolResultDigestInput = {
  meta: CallRouteMeta;
  toolName: string;
  toolCallId: string;
  params: unknown;
  /** The result's text, when every content block is text. Results with an image or any other block are never offered. */
  text: string;
};

export interface ToolResultDigester {
  digest(input: ToolResultDigestInput): Promise<string | undefined>;
}

const DIGEST_KEY = Symbol.for("openclaw.thalamus.toolResultDigester");
type DigestSlot = { [DIGEST_KEY]?: ToolResultDigester };

export function registerToolResultDigester(d: ToolResultDigester): () => void {
  (globalThis as DigestSlot)[DIGEST_KEY] = d;
  return () => {
    if ((globalThis as DigestSlot)[DIGEST_KEY] === d) delete (globalThis as DigestSlot)[DIGEST_KEY];
  };
}

export function getToolResultDigester(): ToolResultDigester | undefined {
  return (globalThis as DigestSlot)[DIGEST_KEY];
}

// ─── the Claude Code worker lane (design doc section 6.2, unit D5; paper P§4) ──────────────────────────────────
//
// WHAT THIS IS FOR. Every main chat runs through the tinker-bridge worker, which spawns `claude`. A provider
// registered here may add `--agents` (sub-agents on other models), a per-turn model and a few environment variables
// to that spawn, and is told about each call a sub-agent makes inside a turn (the bridge's per-call feed skips those).
//
// INERT WHEN EMPTY. No provider means the bridge builds exactly the argument list and environment it builds today;
// a test on the bridge pins that. The bridge reads the slot by its `Symbol.for` key and imports nothing from here, so
// a missing export can never break a spawn. The key below and the bridge's must stay equal (a test compares them).
//
// FAIL OPEN. A provider that throws or returns junk is ignored for that spawn.

export type WorkerSpawnInfo = {
  sessionKey: string;
  /** The model the bridge would pass to `--model` today. */
  model?: string;
};

export type WorkerSpawnExtras = {
  /** Replaces the model for this spawn only (a turn boundary respawn). */
  model?: string;
  /** A JSON object for `--agents`: sub-agent name to its definition, each with its own `model`. */
  agentsJson?: string;
  /** Extra environment for the child, for example `CLAUDE_CODE_SUBAGENT_MODEL`. Only `string` values are passed. */
  env?: Record<string, string>;
};

/** One model call that a Claude Code sub-agent made inside a turn (a stream event with `parent_tool_use_id`). */
export type SubagentCallEvent = {
  sessionKey?: string;
  /** `start` is the call's `message_start` (model, prompt counts); `end` its `message_delta` (output count). One call is one of each. */
  phase: "start" | "end";
  parentToolUseId: string;
  /** Present when the call's `message_start` carried a model. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  t: number;
};

export interface WorkerProvider {
  spawnExtras?(info: WorkerSpawnInfo): WorkerSpawnExtras | undefined;
  /** Counting only. Must not throw and must not block. */
  noteSubagentCall?(event: SubagentCallEvent): void;
}

export const WORKER_PROVIDER_SLOT = "openclaw.thalamus.workerProvider";
const WORKER_KEY = Symbol.for(WORKER_PROVIDER_SLOT);
type WorkerSlot = { [WORKER_KEY]?: WorkerProvider };

export function registerWorkerProvider(p: WorkerProvider): () => void {
  (globalThis as WorkerSlot)[WORKER_KEY] = p;
  return () => {
    if ((globalThis as WorkerSlot)[WORKER_KEY] === p) delete (globalThis as WorkerSlot)[WORKER_KEY];
  };
}

export function getWorkerProvider(): WorkerProvider | undefined {
  return (globalThis as WorkerSlot)[WORKER_KEY];
}

// ─── the orchestrate leaf model (design doc section 12; charter phase E) ───────────────────────────────────────────
//
// WHAT THIS IS FOR. A script run by `openclaw-orchestrate` may ask for `agent(task, { model: "auto" })`. A resolver
// registered here picks the model for that one unit. The prefrontal extension reads the slot by its `Symbol.for` key and
// imports nothing from here, so a missing export cannot break a spawn; a test compares the two keys.
//
// INERT WHEN EMPTY. With no resolver, "auto" is treated exactly like no model at all: the runtime's default leaf model.
// The billing guard stays with the reader of the answer: whatever comes back is still forced to a `claude-code/*` model.
// FAIL OPEN. A resolver that throws, or returns a model that is not a non-empty string, is ignored for that unit.

/**
 * FORK 2026-10-03 — which choice point is asking. the architect: "Make sure Thalamus is owner of all those model choices when it
 * is working." Every site is priced the same way (a fresh point); the site only decides which enforce flag lets the
 * answer through, and it goes into the record. `orchestrate-auto` is a script's own `model: "auto"`; the others are
 * places that used to name a fixed model and keep it as their fallback when no answer comes back: a leaf with no model,
 * a sub-agent spawned with no model, and the Claude roles of a round-table debate.
 */
export type ModelChoiceSite =
  | "orchestrate-auto"
  | "orchestrate-default"
  | "subagent"
  | "round-table";

export type LeafModelRequest = {
  prompt: string;
  label?: string;
  /** What the unit reads and what it changes, as the script declared them. Only the declared writes are ever trusted. */
  reads?: string[];
  writes?: string[];
  thinking?: string;
  /** Absent means `orchestrate-auto`, the first and original consumer. */
  site?: ModelChoiceSite;
};

export type LeafModelChoice = {
  /** A route key, `claude-code/claude-sonnet-5-5`. */
  model: string;
  /** Effort for the unit; absent keeps the script's own. */
  thinking?: string;
};

export interface LeafModelResolver {
  resolve(req: LeafModelRequest): LeafModelChoice | undefined;
  /**
   * True when `resolve` for this site would hand back its pick (Thalamus in enforce with that site's flag on). Prompt text
   * that tells the agent who chooses reads this. It does not promise a board: a pick can still come back empty, and the
   * site's fallback applies.
   */
  owns?(site: ModelChoiceSite): boolean;
}

export const LEAF_RESOLVER_SLOT = "openclaw.thalamus.leafModelResolver";
const LEAF_KEY = Symbol.for(LEAF_RESOLVER_SLOT);
type LeafSlot = { [LEAF_KEY]?: LeafModelResolver };

export function registerLeafModelResolver(r: LeafModelResolver): () => void {
  (globalThis as LeafSlot)[LEAF_KEY] = r;
  return () => {
    if ((globalThis as LeafSlot)[LEAF_KEY] === r) delete (globalThis as LeafSlot)[LEAF_KEY];
  };
}

export function getLeafModelResolver(): LeafModelResolver | undefined {
  return (globalThis as LeafSlot)[LEAF_KEY];
}

/**
 * Ask the registered resolver to pick for one site. Fail open: no resolver, a throw, or an answer that is not a
 * `provider/model` key is no answer, and the caller keeps its own fallback.
 */
export function pickOwnedModel(
  site: ModelChoiceSite,
  req: Omit<LeafModelRequest, "site">,
): LeafModelChoice | undefined {
  const r = getLeafModelResolver();
  if (!r) return undefined;
  try {
    const out = r.resolve({ ...req, site });
    if (!out || typeof out.model !== "string" || !out.model.includes("/")) return undefined;
    return out;
  } catch {
    return undefined;
  }
}

/** Whether Thalamus owns this site's model choice right now. False with no resolver, an older one, or a throw. */
export function modelChoiceOwned(site: ModelChoiceSite): boolean {
  try {
    return getLeafModelResolver()?.owns?.(site) === true;
  } catch {
    return false;
  }
}
