/**
 * FORK: fork.prefrontal.setRecipe -- orchestration observability broadcast.
 *
 * Jarvis calls this RPC (via the openclaw-recipe-state CLI or directly) to
 * publish the current recipe + step state so the Tinker UI's Prefrontal
 * panel can show what playbook is driving the subagent tree.
 *
 * The RPC does one thing: emit an agent event on the `lifecycle` stream with
 * phase="prefrontal-recipe-state" and the caller's payload. The UI subscribes
 * and re-renders the panel header. Zero persistence on the gateway side --
 * the UI holds the last-known state in memory and clears it when the current
 * run ends.
 *
 * Stays frontier-clean: no modifications to pi-agent-core, no new plugin hook
 * surface. When the fork swaps tinker-bridge for a regular LLM provider, the
 * regular provider's sessions_spawn tool keeps working; this RPC just sits
 * unused until someone wires a different frontend to it.
 */
import { createHash } from "node:crypto";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { getRuntimeConfig } from "../config/io.js";
import { createConfiguredEmbeddingProvider } from "../gateway/embeddings-http.js";
import { ErrorCodes, errorShape } from "../gateway/protocol/index.js";
import type { GatewayRequestHandlers } from "../gateway/server-methods/shared-types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveEmbeddingEndpointBaseUrl } from "../memory/embedding-endpoint.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import { estimateTokensFromChars } from "../utils/cjk-chars.js";
// FORK 2026-05-30 (J8 THALAMUS, 2e): NO-MATCH trail events feed the curiosity buffer.
import { appendGap, classifyGap, makeGap } from "./curiosity-store.js";
// FORK 2026-10-29: the per-machine embedder decision and its governor, for the J13 semantic lane
// (TINKER_UI_DESIGN_BIBLE/embedder-fit.md).
import {
  EMBED_CEILINGS,
  isEmbeddingOff,
  MISS_COST_PRIOR,
  readEmbedderFit,
  readRawMemorySearchProvider,
} from "./embedder-fit.js";
import {
  EmbedderUnavailableError,
  getEmbedGovernor,
  governEmbeddingProvider,
  type EmbedGovernor,
} from "./embedder-governor.js";

const log = createSubsystemLogger("fork-prefrontal-state");

function readStr(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function readNum(p: Record<string, unknown>, k: string): number | undefined {
  const v = p[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function readStrArray(p: Record<string, unknown>, k: string): string[] | undefined {
  const v = p[k];
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return out.length > 0 ? out : undefined;
}

// -------------------------------------------------------------------------------------------------
// FORK 2026-10-29: J13 semantic recipe lane, server half (TINKER_UI_DESIGN_BIBLE/embedder-fit.md)
// -------------------------------------------------------------------------------------------------
//
// The lane used to embed [prompt, ...every recipe] (about 100 texts) on every weak-lexical turn.
// On a CPU embedder one such call took minutes: the client gave up at 10 s, and the abandoned
// batch kept the one-slot embedder busy (on the reference host, 26 turns waited 10 s each in 48 h
// and none got a usable answer). Now the recipe vectors are cached per model and filled once in
// the governor's background lane, each turn embeds only its prompt within a derived budget, and
// the lane runs as a trial that retires itself when it rescues nothing (#25).

/**
 * Input caps, mirroring the /v1/embeddings limits, so a runaway caller cannot OOM the embed
 * provider. The background fill splits its calls within the same caps.
 */
const MAX_INPUTS = 128;
const MAX_INPUT_CHARS = 8_192;
const MAX_TOTAL_CHARS = 65_536;

/**
 * Most recipe vectors kept per process. Objective: hold the live catalog plus one full second set
 * (every recipe text edited once, or a second model's vectors during a model change), so a refill
 * never evicts what the next turn reads; the capacity is 2 x the largest catalog seen. Derived
 * from: the catalog the lane sends, at least 100 recipes plus extra kit dirs on the reference
 * install (2026-10-29), so the live capacity is about 200. The ceiling bounds memory: 1,000
 * vectors of 1,024 dimensions (the widest model on the ladder) are about 8 MB. Break-even: below
 * 1x the catalog, every weak turn misses and refills. Changes if the catalog passes 500 recipes
 * (the ceiling then binds) or vectors get wider.
 */
const RECIPE_VECTOR_CEILING = 1_000;
const RECIPE_VECTOR_SLOT = Symbol.for("openclaw.prefrontalRecipeVectors.v1");

type RecipeVectorStore = {
  /** sha256(model NUL text) -> vector. Map order is recency, oldest first. */
  vectors: Map<string, number[]>;
  /** The most recipe texts one request carried. */
  largestCatalog: number;
  /** The running background fill per catalog key: at most one per catalog. */
  fills: Map<string, Promise<void>>;
  /** Why the last fill stopped: a stop is logged once per new reason, not once per turn. */
  lastFillStop?: string;
};

/** Process-wide, on a globalThis slot looked up per call (architecture.md, cross-bundle state). */
function recipeVectorStore(): RecipeVectorStore {
  const slot = globalThis as Record<PropertyKey, unknown>;
  let store = slot[RECIPE_VECTOR_SLOT] as RecipeVectorStore | undefined;
  if (!store) {
    store = { vectors: new Map(), largestCatalog: 0, fills: new Map() };
    slot[RECIPE_VECTOR_SLOT] = store;
  }
  return store;
}

function recipeVectorKey(model: string, text: string): string {
  return createHash("sha256").update(`${model}\0${text}`).digest("hex");
}

/** sha256 of the model and the sorted recipe texts; the trial starts over when it changes. */
function catalogKeyOf(model: string, recipes: readonly string[]): string {
  const hash = createHash("sha256").update(model);
  for (const text of recipes.toSorted()) {
    hash.update(`\0${text}`);
  }
  return hash.digest("hex");
}

/** A cached vector, marked as the most recently used. */
function takeRecipeVector(store: RecipeVectorStore, key: string): number[] | undefined {
  const vector = store.vectors.get(key);
  if (vector) {
    store.vectors.delete(key);
    store.vectors.set(key, vector);
  }
  return vector;
}

function putRecipeVector(store: RecipeVectorStore, key: string, vector: number[]): void {
  const capacity = Math.min(RECIPE_VECTOR_CEILING, 2 * store.largestCatalog);
  store.vectors.delete(key);
  store.vectors.set(key, vector);
  for (const oldest of store.vectors.keys()) {
    if (store.vectors.size <= capacity) {
      break;
    }
    store.vectors.delete(oldest);
  }
}

/**
 * The missing recipe texts as background calls, each within this RPC's input caps (128 inputs,
 * 65,536 characters) and within the endpoint's batch size in tokens, governor.budget('index')
 * .batchTokens: the fit's batch plan, else the 8,000-token ceiling. Objective: no fill call holds
 * a one-slot embedder longer than a foreground query can wait, so a turn's prompt embed gets the
 * slot between two fill calls. A text over the token budget goes alone.
 */
function fillCalls(texts: readonly string[], batchTokens: number): string[][] {
  const calls: string[][] = [];
  let call: string[] = [];
  let chars = 0;
  let tokens = 0;
  for (const text of texts) {
    const textTokens = estimateTokensFromChars(text.length);
    const full =
      call.length >= MAX_INPUTS ||
      chars + text.length > MAX_TOTAL_CHARS ||
      tokens + textTokens > batchTokens;
    if (call.length > 0 && full) {
      calls.push(call);
      call = [];
      chars = 0;
      tokens = 0;
    }
    call.push(text);
    chars += text.length;
    tokens += textTokens;
  }
  if (call.length > 0) {
    calls.push(call);
  }
  return calls;
}

type RecipeFill = {
  store: RecipeVectorStore;
  catalogKey: string;
  provider: Pick<EmbeddingProvider, "embedBatch">;
  model: string;
  texts: readonly string[];
  batchTokens: number;
};

/**
 * Fill the missing recipe vectors in the governor's background lane, unless this catalog already
 * has a fill running. Not awaited: the turn that starts it answers 'warming' at once.
 */
function startRecipeFill(p: RecipeFill): void {
  const { store, catalogKey } = p;
  if (store.fills.has(catalogKey)) {
    return;
  }
  // Registered before its first call goes out, so a fill that ends at once still clears itself.
  const fill = Promise.resolve()
    .then(() => fillRecipeVectors(p))
    .finally(() => {
      store.fills.delete(catalogKey);
    });
  store.fills.set(catalogKey, fill);
}

/**
 * One call after another, each stored as it lands. A refusal ('busy': the idle gate is closed or
 * a fit is measuring) or any failure ends the fill and keeps what it stored; the next weak-lexical
 * turn starts another for what is still missing. Never rejects.
 */
async function fillRecipeVectors(p: RecipeFill): Promise<void> {
  const { store, model } = p;
  let filled = 0;
  let calls = 0;
  try {
    for (const call of fillCalls(p.texts, p.batchTokens)) {
      // A turn or another catalog's fill may have stored some of these meanwhile.
      const todo = call.filter((text) => !store.vectors.has(recipeVectorKey(model, text)));
      if (todo.length === 0) {
        continue;
      }
      calls += 1;
      const vectors = await p.provider.embedBatch(todo, { priority: "background" });
      if (vectors.length !== todo.length) {
        throw new Error(`${vectors.length} vectors came back for ${todo.length} recipe texts`);
      }
      for (let i = 0; i < todo.length; i++) {
        putRecipeVector(store, recipeVectorKey(model, todo[i]), vectors[i]);
      }
      filled += todo.length;
    }
    store.lastFillStop = undefined;
    if (filled > 0) {
      log.info(
        `fork.prefrontal.embed: ${filled} recipe vectors filled in ${calls} background calls (${model})`,
      );
    }
  } catch (err) {
    const reason = err instanceof EmbedderUnavailableError ? err.reason : "error";
    if (store.lastFillStop !== reason) {
      store.lastFillStop = reason;
      log.info(
        `fork.prefrontal.embed: the recipe fill stopped after ${filled} vectors (${reason}: ${errorText(err)}); the next weak-lexical turn resumes it`,
      );
    }
  }
}

/**
 * The lane's per-turn wait, sent back as budgetMs: min(EMBED_CEILINGS.laneBudgetMs, 2 x the
 * endpoint's measured query p95). Objective: wait for a prompt embed as long as a normal one
 * takes, with 2x headroom for its tail, and never past the 1 s ceiling. Derived from: the
 * governor's live query window (the newest 200 embedQuery calls on this endpoint), so it follows
 * the model and the host's load; with no query measured yet it is the ceiling. Break-even: the
 * wait pays only while the lane rescues at least mean_q / t_miss of its invocations, which the
 * trial measures. Changes with the model, the endpoint and the host's load.
 */
function laneBudgetMsFor(governor: Pick<EmbedGovernor, "liveQueryWindow">): number {
  const p95 = governor.liveQueryWindow().p95Ms;
  return typeof p95 === "number" && Number.isFinite(p95) && p95 > 0
    ? Math.min(EMBED_CEILINGS.laneBudgetMs, Math.ceil(2 * p95))
    : EMBED_CEILINGS.laneBudgetMs;
}

/**
 * t_miss for the lane's trial: the fit record's median model step on this install, else the
 * labelled prior MISS_COST_PRIOR (21.57 s over 81 steps, measured on another install).
 */
function laneMissCostMs(): number {
  const measured = readEmbedderFit()?.missCostSec?.value;
  return typeof measured === "number" && Number.isFinite(measured) && measured > 0
    ? measured * 1000
    : MISS_COST_PRIOR.value * 1000;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const forkPrefrontalStateHandlers: GatewayRequestHandlers = {
  "fork.prefrontal.setRecipe": async ({ params, respond }) => {
    const p = params ?? {};
    const recipeId = readStr(p, "recipeId");
    if (!recipeId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "fork.prefrontal.setRecipe: 'recipeId' required (e.g. 'revise-paper').",
        ),
      );
      return;
    }
    const step = readNum(p, "step");
    const totalSteps = readNum(p, "totalSteps");
    const stepName = readStr(p, "stepName");
    const sessionKey = readStr(p, "sessionKey") ?? readStr(p, "parentSessionKey");
    const runId = readStr(p, "runId") ?? "prefrontal-recipe-state";
    const parallelismCap = readNum(p, "parallelismCap");
    const inFlightLabels = readStrArray(p, "inFlightLabels");
    const note = readStr(p, "note");
    // BROCA visibility (2026-06-06): optional per-turn id + current-step skill id.
    // Both back-compat (omitted when absent → old clients/payloads unaffected).
    const turnId = readStr(p, "turnId");
    const skillId = readStr(p, "skillId");

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "prefrontal-recipe-state",
        recipeId,
        step,
        totalSteps,
        stepName,
        parallelismCap,
        inFlightLabels,
        note,
        ts: Date.now(),
        ...(turnId ? { turnId } : {}),
        ...(skillId ? { skillId } : {}),
        ...(sessionKey ? { sessionKey } : {}),
      },
      ...(sessionKey ? { sessionKey } : {}),
    });

    log.info(
      `fork.prefrontal.setRecipe recipeId=${recipeId} step=${step ?? "-"}/${totalSteps ?? "-"} stepName=${stepName ?? "-"} sessionKey=${sessionKey ?? "-"}`,
    );
    respond(true, { ok: true, recipeId, step, totalSteps, stepName }, undefined);
  },

  "fork.prefrontal.trailEvent": async ({ params, respond }) => {
    const p = params ?? {};
    // kind: existing callers use "dispatch" | "complete" | "note" | "transition".
    // FORK 2026-05-30 (2e): additive "NO-MATCH" kind for recipe-gap / tool-failure
    // detection — it carries a structured payload and feeds the curiosity buffer.
    const kind = readStr(p, "kind");
    const isNoMatch = kind === "NO-MATCH";
    // NO-MATCH derives a default message from its structured fields, so `message`
    // is required for the legacy kinds but optional for NO-MATCH.
    const recipeName = readStr(p, "recipeName");
    const stepName = readStr(p, "stepName");
    const toolName = readStr(p, "toolName");
    const reason = readStr(p, "reason");
    const message =
      readStr(p, "message") ??
      (isNoMatch ? `NO-MATCH: ${toolName ?? "tool"}${reason ? ` — ${reason}` : ""}` : undefined);
    if (!kind || !message) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "fork.prefrontal.trailEvent: 'kind' and 'message' required.",
        ),
      );
      return;
    }
    const sessionKey = readStr(p, "sessionKey") ?? readStr(p, "parentSessionKey");
    const runId = readStr(p, "runId") ?? "prefrontal-trail";
    const icon = readStr(p, "icon");
    const label = readStr(p, "label");
    // FORK 2026-05-31: forward an optional structured payload (recipeId, op,
    // applied, reason, …) so RPC-emitted trail events carry the same provenance
    // the in-extension emitTrail broadcasts inline. The UI reads data.payload.
    const payloadRaw = (p as { payload?: unknown }).payload;
    const payload =
      payloadRaw && typeof payloadRaw === "object"
        ? (payloadRaw as Record<string, unknown>)
        : undefined;

    // 2e: classify the gap so a transient outage is never logged as learnable.
    const resolutionType = isNoMatch ? classifyGap(toolName, reason) : undefined;

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "prefrontal-trail-event",
        kind,
        message,
        icon,
        label,
        ...(payload ? { payload } : {}),
        ...(isNoMatch
          ? {
              recipeName,
              stepName,
              toolName,
              reason,
              resolutionType,
            }
          : {}),
        ts: Date.now(),
        ...(sessionKey ? { sessionKey } : {}),
      },
      ...(sessionKey ? { sessionKey } : {}),
    });

    // 2e: only a "knowledge-gap" NO-MATCH (the agent doesn't know how to use the
    // tool) is a learnable curiosity driver. "recoverable" (permission) and
    // "external-outage" emit the trail event but write NO buffer entry.
    let bufferedGapId: string | undefined;
    if (isNoMatch && resolutionType === "knowledge-gap") {
      try {
        const gap = makeGap({
          topic: `use ${toolName ?? "tool"}`,
          source: "no-match",
          sessionKey,
          runId,
          recipeName,
          stepName,
          toolName,
          reason,
          resolutionType,
          // a knowledge-gap NO-MATCH is highly learnable + externally grounded
          learnability: 0.8,
          importance: 0.6,
        });
        appendGap(gap);
        bufferedGapId = gap.id;
      } catch (err) {
        console.error("[fork.prefrontal.trailEvent NO-MATCH] appendGap failed", err);
      }
    }

    log.info(
      `fork.prefrontal.trailEvent kind=${kind} label=${label ?? "-"} msg.len=${message.length}${isNoMatch ? ` resolutionType=${resolutionType ?? "-"} buffered=${bufferedGapId ?? "no"}` : ""}`,
    );
    respond(true, { ok: true, ...(bufferedGapId ? { gapId: bufferedGapId } : {}) }, undefined);
  },

  // FORK 2026-05-31: scoped INTERNAL embeddings RPC for the J13 semantic
  // recipe-match lane. The matcher's embedFn previously POSTed /v1/embeddings,
  // which 404s unless the openAiCompat HTTP surface is enabled. This RPC reuses
  // the SAME in-process embedding provider (the configured memorySearch one) with
  // NO new HTTP/chat surface. Lives in core (not the bundled extension) so the
  // provider/native-dep stack is never dragged into the extension bundle. Fails
  // SAFE: any error returns empty embeddings so the matcher degrades to lexical.
  //
  // FORK 2026-10-29: params {texts, budgetMs?, prevRecovered?}; texts[0] is the prompt and the
  // rest are recipe texts. A turn costs one prompt embed: the recipe vectors come from the cache
  // above, filled once in the background, and the lane runs as a trial that retires itself. Every
  // answer is ok:true and carries one state: vectors, warming, armed:false, degraded or error. The
  // client turns each state without vectors into an error, so the matcher stays lexical.
  "fork.prefrontal.embed": async ({ params, respond }) => {
    const p = params ?? {};
    const rawTexts = (p as { texts?: unknown }).texts;
    const rawText = (p as { text?: unknown }).text;
    let texts: string[];
    if (Array.isArray(rawTexts)) {
      texts = rawTexts.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    } else if (typeof rawText === "string" && rawText.trim().length > 0) {
      texts = [rawText];
    } else {
      texts = [];
    }
    if (texts.length === 0) {
      respond(true, { embeddings: [], count: 0 }, undefined);
      return;
    }
    // FORK 2026-10-29: the input caps moved above the handlers, since the fill splits within
    // them too. More than MAX_INPUTS texts is refused rather than cut: the matcher needs one
    // vector per text it sent, so a cut list could never be used.
    if (texts.length > MAX_INPUTS) {
      respond(true, { embeddings: [], error: `too many inputs (max ${MAX_INPUTS})` }, undefined);
      return;
    }
    let total = 0;
    texts = texts.map((t) => (t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) : t));
    for (const t of texts) {
      total += t.length;
      if (total > MAX_TOTAL_CHARS) {
        respond(true, { embeddings: [], error: "input too large" }, undefined);
        return;
      }
    }
    // FORK 2026-10-29: the prompt embed waits as long as the client asked, at most the ceiling.
    const askedBudgetMs = readNum(p, "budgetMs");
    const queryBudgetMs =
      askedBudgetMs !== undefined && askedBudgetMs > 0
        ? Math.min(askedBudgetMs, EMBED_CEILINGS.laneBudgetMs)
        : EMBED_CEILINGS.laneBudgetMs;
    // Rescues the client saw since its previous request, for the trial.
    const reported = readNum(p, "prevRecovered");
    const prevRecovered = reported !== undefined && reported > 0 ? Math.floor(reported) : 0;
    try {
      const cfg = getRuntimeConfig();
      // Use the gateway's actual default agent (not a hardcoded "main") so we read
      // the right agent's memorySearch config even when agents.list renames it.
      const agentId = resolveDefaultAgentId(cfg);
      const agentDir = resolveAgentDir(cfg, agentId);
      const memorySearch = resolveMemorySearchConfig(cfg, agentId);
      // FORK 2026-10-29: words only on this machine (no memory search, no provider, or 'none',
      // which the fit gives when it chose no model): answer at once and build no provider.
      if (!memorySearch || isEmbeddingOff(memorySearch)) {
        respond(true, { embeddings: [], armed: false, reason: "embeddings off" }, undefined);
        return;
      }
      const created = await createConfiguredEmbeddingProvider({
        cfg,
        agentDir,
        provider: memorySearch.provider,
        model: memorySearch.model,
        // Pass only the fields the factory reads (it Picks local/remote/dims).
        memorySearch: {
          local: memorySearch.local,
          remote: memorySearch.remote,
          outputDimensionality: memorySearch.outputDimensionality,
        },
      });
      // FORK 2026-10-29: governed like every fork-path provider, under the core index's endpoint
      // key so both share one queue, in mode 'fit' when the configured provider is 'auto' (the fit
      // chose it).
      // FORK 2026-10-30: the key carries the base URL the provider calls, for every HTTP provider
      // and not Ollama's alone, so a loopback OpenAI-compatible server is governed as local.
      const baseUrl = await resolveEmbeddingEndpointBaseUrl({
        providerId: created.id,
        config: cfg,
        remote: memorySearch.remote,
      });
      const provider = governEmbeddingProvider(created, {
        consumer: "prefrontal",
        ...(baseUrl ? { baseUrl } : {}),
        mode: readRawMemorySearchProvider(cfg, agentId) === "auto" ? "fit" : "pin",
      });
      const governor = getEmbedGovernor({
        providerId: provider.id,
        model: provider.model,
        ...(baseUrl ? { baseUrl } : {}),
      });
      const model = provider.model;
      const prompt = texts[0];
      const recipes = texts.slice(1);
      const store = recipeVectorStore();
      store.largestCatalog = Math.max(store.largestCatalog, recipes.length);
      const catalogKey = catalogKeyOf(model, recipes);

      // The trial (#25): retired after n = ceil(3 x t_miss / mean_q) invocations with no rescue.
      // With no query measured yet, mean_q is unknown (NaN, as the governor marks an unmeasured
      // input), n is unbounded and the lane cannot retire.
      const trialInput = {
        missCostMs: laneMissCostMs(),
        meanQueryMs: governor.liveQueryWindow().meanMs ?? Number.NaN,
        catalogKey,
      };
      let trial = governor.trialState("prefrontal", trialInput);
      if (prevRecovered > 0) {
        // What the lane's previous answer rescued belongs to an earlier invocation, so it counts
        // before this turn's retire check.
        governor.noteTrial("prefrontal", { invoked: false, recovered: prevRecovered });
        trial = governor.trialState("prefrontal", trialInput);
      }
      if (trial.retired) {
        respond(
          true,
          {
            embeddings: [],
            armed: false,
            reason: `retired: 0 recoveries in ${trial.invocations} invocations`,
          },
          undefined,
        );
        return;
      }

      const cached: number[][] = [];
      const missing: string[] = [];
      const missingKeys = new Set<string>();
      for (const text of recipes) {
        const key = recipeVectorKey(model, text);
        const vector = takeRecipeVector(store, key);
        if (vector) {
          cached.push(vector);
        } else if (!missingKeys.has(key)) {
          missingKeys.add(key);
          missing.push(text);
        }
      }
      if (missing.length > 0) {
        startRecipeFill({
          store,
          catalogKey,
          provider,
          model,
          texts: missing,
          batchTokens: governor.budget("index").batchTokens,
        });
        respond(
          true,
          {
            embeddings: [],
            warming: true,
            missing: missing.length,
            budgetMs: laneBudgetMsFor(governor),
          },
          undefined,
        );
        return;
      }

      let vector: number[];
      try {
        vector = await provider.embedQuery(prompt, {
          priority: "foreground",
          budgetMs: queryBudgetMs,
        });
      } catch (err) {
        if (err instanceof EmbedderUnavailableError) {
          // Refused up front or abandoned at the budget: this turn stays lexical. The current
          // budget rides along, so a client holding a stale one is not refused forever.
          respond(
            true,
            { embeddings: [], degraded: err.reason, budgetMs: laneBudgetMsFor(governor) },
            undefined,
          );
          return;
        }
        throw err;
      }
      governor.noteTrial("prefrontal", { invoked: true, recovered: 0 });
      respond(
        true,
        {
          embeddings: [vector, ...cached],
          model,
          count: texts.length,
          budgetMs: laneBudgetMsFor(governor),
        },
        undefined,
      );
    } catch (err) {
      // Soft failure → empty embeddings → matcher uses lexical-only (unchanged).
      log.info(`fork.prefrontal.embed soft-fail (lexical fallback): ${String(err)}`);
      respond(true, { embeddings: [], error: String(err) }, undefined);
    }
  },
};

/** Tests only: forget every cached recipe vector and every running fill. */
export function __resetPrefrontalRecipeVectorsForTest(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[RECIPE_VECTOR_SLOT];
}

/** Tests only: settles once every running recipe fill has ended. */
export async function __prefrontalRecipeFillsForTest(): Promise<void> {
  await Promise.all(recipeVectorStore().fills.values());
}
