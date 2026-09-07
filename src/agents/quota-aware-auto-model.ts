// src/agents/quota-aware-auto-model.ts
/**
 * Quota-aware Auto model fallback — the ladder that decides what **Auto** should run when the
 * provider Auto would have picked has spent its token window.
 *
 * Design: `docs/superpowers/specs/2026-08-28-quota-aware-auto-model-fallback-design.md` §A.2–A.4
 * (jarvis-icu). Auto ONLY: a pinned model hard-stops instead. And only a KNOWN QUOTA STATE
 * triggers this — never a 429, a timeout or an "overloaded". That is the whole difference from the
 * silent substitution `317825d0f7a` removed, which fired on transport blips.
 *
 * PURE. No I/O, no `Date.now()`, no config read from disk — everything arrives in `params`, so
 * every decision is reproducible in a test. `nowMs` is an argument for the same reason the shared
 * predicate takes one (`src/shared/quota-window.ts`): a hidden clock would let the gateway and the
 * browser disagree about the same window. Nothing is persisted either (spec §A.4) — the ladder is
 * re-resolved every turn, so the snap-back when a window rolls over falls out of the quota state
 * itself instead of a stored field that can get stuck.
 *
 * The rules, in the architect's order:
 *   0. original provider NOT exhausted -> null. This is the common path on every single turn, so
 *      nothing is built, filtered or sorted above that check.
 *   1. rank candidates by `intelligenceIndex` DESCENDING, read DIRECTLY from
 *      `cfg.agents.defaults.models["<provider>/<model>"]`.
 *   2. VETO any candidate whose `relCost` exceeds 1.5x the original's. Cost is a VETO, never a
 *      preference: no tolerance band, no cost tie-break. A candidate 0.01 AA points better and 5x
 *      dearer still wins. That is deliberate — predictability over thrift.
 *   3. skip candidates whose own provider is also exhausted.
 *   4. first survivor wins.
 *
 * DO NOT source the ranking from `buildConfiguredModelCatalog`
 * (`src/agents/model-selection-shared.ts`, the catalog push near line 795): it copies `rank` and
 * DROPS `intelligenceIndex`. That trap has already cost one investigation.
 *
 * KNOWN GAP — OPENROUTER IS INVISIBLE. OpenRouter publishes no quota at any layer, and
 * `isAuthCooldownBypassedForProvider` (`src/agents/auth-profiles/usage-state.ts`) hard-excludes it
 * from the cooldown machinery too. This resolver may therefore route TO a spent OpenRouter
 * provider and will not know. Not theoretical: rung 3 of the live ladder is an OpenRouter model.
 *
 * SECOND GAP — COVERAGE IS PARTLY DYNAMIC, so there is no single static list to trust.
 * Two sources, and `providerQuotaExhaustion` is the only place that joins them:
 *   · the Anthropic OAuth pool, read from `providers.anthropic` — STATICALLY guaranteed, and the
 *     set of config providers drawing on it is `QUOTA_COVERED_PROVIDERS`;
 *   · every other provider, read from `snapshot.windows[provider]` — covered IF AND ONLY IF the
 *     budget-panel producer published windows for it on the last poll (`ea34b99e32d` folds in the
 *     xai / chatgpt / copilot / gemini payloads it was already fetching). So coverage is a
 *     property of the live snapshot, not of a constant in this file.
 * A provider ABSENT from `windows` is UNKNOWN and therefore left alone. Do NOT read absence as
 * headroom: that routes traffic straight at an exhausted provider, which is exactly what still
 * happens for openrouter (FIRST GAP above).
 *
 * `providers.openai` is deliberately NOT read: it publishes `monthSpendUsd` with no cap alongside
 * it, so no utilization percentage can be formed from the snapshot without inventing one.
 *
 * There was a third reader here until 2026-08-29 — a `providers.google` rpd-vs-limit path. That
 * field was declared on `UsageSnapshot` but written by NO producer in the codebase's history;
 * `ea34b99e32d` deleted it, and the generic `windows` lookup replaced it and covers Gemini
 * properly. A declared-but-never-written field is a lie the type system endorses.
 *
 * `providerExhausted` from the shared module is deliberately NOT called here: it returns the
 * binding window but drops its label, and the label is exactly what the disclosure string needs.
 * The scan below calls the same shipped `windowExhausted` predicate that `providerExhausted` is
 * built from, in the same shortest-window-first order, and allocates no array on the step-0 path.
 */

import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { UsageSnapshot } from "../infra/usage-snapshot-store.js";
import { windowExhausted, type QuotaWindow } from "../shared/quota-window.js";

/** A candidate may cost at most this multiple of the original's `relCost`. Veto, not preference. */
export const COST_CEILING_MULTIPLIER = 1.5;

/**
 * Greppable token stamped into `reason` whenever the 1.5x veto could not actually be applied.
 * A metered model slipping through as "free" is the exact failure the veto exists to stop, so the
 * gap is surfaced in the disclosure string rather than swallowed. Machine-detectable on purpose:
 * prose decays into being ignored, a token can be asserted on.
 */
export const COST_UNVERIFIED_MARKER = "cost-unverified";

/**
 * The providers this resolver can actually see quota for. Everything absent from this list is
 * assumed available — see the header's SECOND GAP. Checked by a test so it cannot drift away from
 * `providerQuotaExhaustion`.
 */
export const QUOTA_COVERED_PROVIDERS: readonly string[] = ["anthropic", "claude-code"];

/** Both config providers draw on the same Anthropic OAuth pool the snapshot reports. */
const ANTHROPIC_POOL_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "claude-code"]);

const FIVE_HOUR = "5-hour";
const SEVEN_DAY = "7-day";

/** An exhausted window plus the human label the disclosure string needs. */
export type QuotaExhaustion = { label: string; window: QuotaWindow };

/** Why a candidate was dropped. Recorded in algorithm order; a candidate can collect several. */
export type CandidateExclusion = "not-routable" | "cost-veto" | "provider-exhausted";

export type LadderCandidate = {
  key: string;
  provider: string;
  model: string;
  intelligenceIndex: number;
  relCost: number | undefined;
  /** Every rule that excluded this candidate. Empty => eligible. */
  exclusions: CandidateExclusion[];
  /** `relCost` missing, so the veto could not prove this candidate cheap OR expensive. */
  costUnverified: boolean;
  selected: boolean;
};

export type QuotaAwareAutoModelChoice = {
  provider: string;
  model: string;
  reason: string;
};

export type QuotaAwareAutoLadder = {
  originalKey: string;
  /** null => the original provider still has window; nothing is substituted. */
  exhaustion: QuotaExhaustion | null;
  /** The `relCost` ceiling, or undefined when the original has no `relCost` (veto disabled). */
  ceiling: number | undefined;
  /** True when the original has no `relCost`, so NO candidate could be cost-vetoed at all. */
  costVetoDisabled: boolean;
  /** Candidates in strict `intelligenceIndex`-descending order. */
  candidates: LadderCandidate[];
  /** Keys dropped before ranking because config publishes no `intelligenceIndex` for them. */
  unranked: string[];
  selected: QuotaAwareAutoModelChoice | null;
};

export type ResolveQuotaAwareAutoModelParams = {
  cfg: OpenClawConfig;
  /** The provider Auto would have used. */
  provider: string;
  model: string;
  /** Optional routability filter (`provider/model` keys, as `buildAllowedModelSet` produces). */
  allowedModelKeys?: ReadonlySet<string>;
  snapshot: UsageSnapshot | undefined;
  nowMs: number;
};

/**
 * `relCost` is not on `AgentModelEntryConfig` yet — spec §7.2 / unit A1 adds it to
 * `src/config/types.agent-defaults.ts`, the zod object (which is `.strict()`) and the generated
 * schema. Until that lands the field cannot be typed at the source, so it is widened once here at
 * the boundary and every read below is fully typed. When A1 lands, delete this alias and the cast
 * in `modelCatalog` — nothing else changes.
 */
type ModelEntryWithCost = AgentModelEntryConfig & { relCost?: number };

function modelCatalog(cfg: OpenClawConfig): Record<string, ModelEntryWithCost> {
  return (cfg.agents?.defaults?.models as Record<string, ModelEntryWithCost> | undefined) ?? {};
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** One quota-bearing row (the collapsed provider scalars, or a single OAuth account). */
type QuotaRow = {
  fiveHourUtilization: number;
  sevenDayUtilization: number;
  fiveHourResetAt?: number;
  sevenDayResetAt?: number;
};

/**
 * The binding exhausted window of one row, or null when the row still has headroom.
 *
 * Shortest window first: when both are spent the 5-hour is the one whose reset actually unblocks
 * the row, so it is the one worth naming. A non-finite utilization reads as 0 (headroom) — the
 * safe direction, because substituting is the risky action and not substituting is the status quo.
 */
function rowExhaustion(row: QuotaRow, nowMs: number): QuotaExhaustion | null {
  const fiveHour: QuotaWindow = {
    usedPercent: finiteNumber(row.fiveHourUtilization) ?? 0,
    resetAtMs: row.fiveHourResetAt,
  };
  if (windowExhausted(fiveHour, nowMs)) {
    return { label: FIVE_HOUR, window: fiveHour };
  }
  const sevenDay: QuotaWindow = {
    usedPercent: finiteNumber(row.sevenDayUtilization) ?? 0,
    resetAtMs: row.sevenDayResetAt,
  };
  if (windowExhausted(sevenDay, nowMs)) {
    return { label: SEVEN_DAY, window: sevenDay };
  }
  return null;
}

/** Of two exhausted windows, the one that unblocks first. A known reset beats an unknown one. */
function sooner(current: QuotaExhaustion | null, next: QuotaExhaustion): QuotaExhaustion {
  if (current === null) {
    return next;
  }
  const currentReset = current.window.resetAtMs;
  const nextReset = next.window.resetAtMs;
  if (currentReset === undefined) {
    return nextReset === undefined ? current : next;
  }
  if (nextReset === undefined) {
    return current;
  }
  return nextReset < currentReset ? next : current;
}

/**
 * POOL SEMANTICS, and this is load-bearing. The gateway round-robins and fails over across the
 * Anthropic OAuth accounts, so the pool only throttles when the LAST account exhausts — the same
 * binding-constraint reading `deriveQuotaPressure` (`src/agents/effort-allocator.ts`) uses. One
 * spent account is not a stop. Driving off the collapsed `fiveHourUtilization` /
 * `sevenDayUtilization` scalars instead would be wrong: they are the MAX across accounts, so a
 * single spent account would substitute the whole pool away while it still had capacity.
 *
 * `accounts[]` is optional (absent until the budget-panel poller populates it), so the collapsed
 * scalars remain the documented back-compat path.
 */
function anthropicPoolExhaustion(
  anthropic: NonNullable<UsageSnapshot["providers"]["anthropic"]>,
  nowMs: number,
): QuotaExhaustion | null {
  const accounts = anthropic.accounts;
  if (!accounts || accounts.length === 0) {
    return rowExhaustion(anthropic, nowMs);
  }
  let binding: QuotaExhaustion | null = null;
  for (const account of accounts) {
    const hit = rowExhaustion(account, nowMs);
    if (hit === null) {
      return null;
    }
    binding = sooner(binding, hit);
  }
  return binding;
}

/**
 * Every provider the budget panel publishes windows for.
 *
 * FORK 2026-08-29: this REPLACED a `providers.google`-specific reader. That field was declared on
 * `UsageSnapshot` but written by no producer in the codebase's history, and `ea34b99e32d` deleted
 * it in favour of `windows` — a map keyed by provider id, populated from the xai / chatgpt /
 * copilot / gemini payloads the panel was already fetching and discarding. Reading `windows` makes
 * the ladder cover every provider the panel can see instead of Anthropic plus a phantom.
 *
 * ORDER IS LOAD-BEARING: `windows[provider]` is SHORTEST WINDOW FIRST, so the first exhausted
 * entry is the BINDING one — a spent 5-hour bucket throttles right now even while the weekly
 * bucket is half empty.
 *
 * ABSENT means UNKNOWN, never "has headroom". A provider with no entry is left alone, because
 * treating silence as headroom is how you route traffic straight at an exhausted provider — which
 * is precisely what happens today for openrouter (see the header's KNOWN GAP).
 */
function publishedWindowExhaustion(
  snapshot: UsageSnapshot,
  provider: string,
  nowMs: number,
): QuotaExhaustion | null {
  const entries = snapshot.windows?.[provider];
  if (!entries?.length) {
    return null;
  }
  for (const entry of entries) {
    const usedPercent = finiteNumber(entry.usedPercent);
    if (usedPercent === undefined) {
      continue;
    }
    const window: QuotaWindow = {
      usedPercent,
      ...(entry.resetAtMs === undefined ? {} : { resetAtMs: entry.resetAtMs }),
    };
    if (windowExhausted(window, nowMs)) {
      return { label: entry.label, window };
    }
  }
  return null;
}

/**
 * Is this config provider's token window spent right now? The SINGLE dispatcher from a config
 * provider id to the snapshot rows that describe it — extend this together with
 * `QUOTA_COVERED_PROVIDERS` when the producer widens.
 *
 * Note `github-copilot/claude-*` is Copilot's quota, not Anthropic's, and is correctly absent
 * from the pool set.
 */
export function providerQuotaExhaustion(
  snapshot: UsageSnapshot | undefined,
  provider: string,
  nowMs: number,
): QuotaExhaustion | null {
  if (!snapshot) {
    return null;
  }
  if (ANTHROPIC_POOL_PROVIDERS.has(provider)) {
    const anthropic = snapshot.providers?.anthropic;
    return anthropic ? anthropicPoolExhaustion(anthropic, nowMs) : null;
  }
  return publishedWindowExhaustion(snapshot, provider, nowMs);
}

/**
 * `resets 15:00 UTC`, or an honest `no published reset`.
 *
 * UTC, not host-local: this string is compared in tests and read by two processes, and a
 * host-timezone-dependent clock would make it disagree with itself. `new Date(ms)` here formats an
 * ARGUMENT — it is not a clock read, and this module still never calls `Date.now()`.
 */
function formatReset(resetAtMs: number | undefined): string {
  const ms = finiteNumber(resetAtMs);
  if (ms === undefined) {
    return "no published reset";
  }
  const at = new Date(ms);
  const hours = String(at.getUTCHours()).padStart(2, "0");
  const minutes = String(at.getUTCMinutes()).padStart(2, "0");
  return `resets ${hours}:${minutes} UTC`;
}

function buildReason(args: {
  provider: string;
  exhaustion: QuotaExhaustion;
  originalKey: string;
  chosen: LadderCandidate;
  costVetoDisabled: boolean;
}): string {
  const reset = formatReset(args.exhaustion.window.resetAtMs);
  const head = `${args.provider} ${args.exhaustion.label} window exhausted (${reset})`;
  const route = `Auto routed ${args.originalKey} -> ${args.chosen.key}`;
  const gaps: string[] = [];
  if (args.costVetoDisabled) {
    gaps.push(
      `no relCost for ${args.originalKey} (original), so the ` +
        `${COST_CEILING_MULTIPLIER}x veto did not run for any candidate`,
    );
  }
  if (args.chosen.costUnverified) {
    gaps.push(`no relCost for ${args.chosen.key}, so its cost was never checked`);
  }
  const tail = gaps.length === 0 ? "" : ` [${COST_UNVERIFIED_MARKER}: ${gaps.join("; ")}]`;
  return `${head} — ${route}${tail}`;
}

/**
 * The one code path both public entry points share, so the diagnostic view can never drift away
 * from the decision it is supposed to explain.
 *
 * Every candidate is fully evaluated (all applicable exclusions recorded) rather than
 * short-circuited, which costs nothing at catalog scale and is what lets a caller — or a test —
 * assert WHY a model was dropped instead of merely that it is absent.
 */
function buildLadder(
  params: ResolveQuotaAwareAutoModelParams,
  exhaustion: QuotaExhaustion,
): QuotaAwareAutoLadder {
  const { cfg, provider, model, allowedModelKeys, snapshot, nowMs } = params;
  const originalKey = `${provider}/${model}`;
  const models = modelCatalog(cfg);
  const originalRelCost = finiteNumber(models[originalKey]?.relCost);
  const costVetoDisabled = originalRelCost === undefined;
  const ceiling =
    originalRelCost === undefined ? undefined : originalRelCost * COST_CEILING_MULTIPLIER;

  const candidates: LadderCandidate[] = [];
  const unranked: string[] = [];
  for (const [key, entry] of Object.entries(models)) {
    if (key === originalKey) {
      continue;
    }
    const slash = key.indexOf("/");
    const intelligenceIndex = finiteNumber(entry?.intelligenceIndex);
    if (intelligenceIndex === undefined || slash <= 0 || slash === key.length - 1) {
      // No published AA score (or an unparseable key) means the model cannot be placed in a
      // strict-intelligence order at all. Dropped rather than ranked last: unknown is not worst.
      unranked.push(key);
      continue;
    }
    candidates.push({
      key,
      provider: key.slice(0, slash),
      model: key.slice(slash + 1),
      intelligenceIndex,
      relCost: finiteNumber(entry?.relCost),
      exclusions: [],
      costUnverified: false,
      selected: false,
    });
  }

  // STRICT intelligence order, descending. Array.prototype.sort is stable, so equal AA scores keep
  // config order — deterministic, and NOT a cost tie-break: the architect ruled cost out as a
  // preference entirely, so do not add one here.
  candidates.sort((a, b) => b.intelligenceIndex - a.intelligenceIndex);

  let selected: QuotaAwareAutoModelChoice | null = null;
  for (const candidate of candidates) {
    if (allowedModelKeys && !allowedModelKeys.has(candidate.key)) {
      candidate.exclusions.push("not-routable");
    }
    if (candidate.relCost === undefined) {
      candidate.costUnverified = true;
    } else if (ceiling !== undefined && candidate.relCost > ceiling) {
      candidate.exclusions.push("cost-veto");
    }
    // Same-provider candidates are caught here, which is why the original needs no special case:
    // its own provider is exhausted by construction.
    if (providerQuotaExhaustion(snapshot, candidate.provider, nowMs) !== null) {
      candidate.exclusions.push("provider-exhausted");
    }
    if (selected === null && candidate.exclusions.length === 0) {
      candidate.selected = true;
      selected = {
        provider: candidate.provider,
        model: candidate.model,
        reason: buildReason({
          provider,
          exhaustion,
          originalKey,
          chosen: candidate,
          costVetoDisabled,
        }),
      };
    }
  }

  return { originalKey, exhaustion, ceiling, costVetoDisabled, candidates, unranked, selected };
}

/**
 * The substitute Auto should run, or null to leave the selection alone.
 *
 * null means "change nothing" in both of its cases — the provider is healthy, or nothing survived
 * the ladder. A caller must not read null as "no quota problem"; use `explainQuotaAwareAutoLadder`
 * when the difference matters.
 */
export function resolveQuotaAwareAutoModel(
  params: ResolveQuotaAwareAutoModelParams,
): QuotaAwareAutoModelChoice | null {
  // STEP 0 — the common path on EVERY turn. Nothing is allocated, filtered or sorted above this
  // line: while the provider Auto picked still has window, the whole feature costs a couple of
  // property reads and a comparison.
  const exhaustion = providerQuotaExhaustion(params.snapshot, params.provider, params.nowMs);
  if (exhaustion === null) {
    return null;
  }
  return buildLadder(params, exhaustion).selected;
}

/**
 * The same decision with its reasoning attached: the exhausted window, the cost ceiling, and every
 * candidate with the exclusions it collected. For tests, diagnostics and disclosure surfaces.
 */
export function explainQuotaAwareAutoLadder(
  params: ResolveQuotaAwareAutoModelParams,
): QuotaAwareAutoLadder {
  const exhaustion = providerQuotaExhaustion(params.snapshot, params.provider, params.nowMs);
  if (exhaustion === null) {
    return {
      originalKey: `${params.provider}/${params.model}`,
      exhaustion: null,
      ceiling: undefined,
      costVetoDisabled: false,
      candidates: [],
      unranked: [],
      selected: null,
    };
  }
  return buildLadder(params, exhaustion);
}
