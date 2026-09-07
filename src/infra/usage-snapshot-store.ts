// src/infra/usage-snapshot-store.ts
// FORK: Shared in-memory bridge between budget-panel extension (writer)
// and billing-gate module (reader). Decouples plugin from core code.

/**
 * One quota window, provider-agnostic.
 *
 * Deliberately tiny and structural: this is the ONLY shape a consumer needs in order to ask
 * "is this provider spent, and when does it come back?" for ANY vendor.
 *
 * `resetAtMs` is epoch ms — the name carries the unit on purpose, because every provider hands
 * us an ISO-8601 string and exactly one helper is allowed to parse it (`isoToMs` in the
 * tinkerclaw-budget-panel extension). ABSENT means UNKNOWN, never "resets now".
 *
 * NOTE: `provider-usage.types.ts#UsageWindow` is the same idea for the CLI/UI `usage` surface
 * and names the field `resetAt`. Separate surfaces, separate producers — do not alias one to
 * the other without moving both producers in the same commit.
 */
export interface UsageWindowEntry {
  /** Human window name as the PROVIDER names it: "5-hour", "7-day", "Weekly", "monthly". */
  label: string;
  /** 0-100. */
  usedPercent: number;
  /** epoch ms; omitted when the provider publishes no reset instant. */
  resetAtMs?: number;
}

export interface UsageSnapshot {
  /**
   * Timestamp of the last SUCCESSFUL **Anthropic** fetch (not last cache write).
   *
   * The Anthropic scope is load-bearing: `agents/billing-gate.ts` reads a stale value as "no
   * usage data" and BLOCKS every metered model, so a poll that refreshed only a non-Anthropic
   * provider must never bump it — that would report dead Anthropic auth as fresh and open the
   * gate. Freshness of `windows` is carried separately by `windowsUpdatedAt`.
   */
  lastSuccessfulFetch: number;
  /**
   * FORK 2026-08-29: quota windows for EVERY provider the budget panel can see, keyed by
   * provider id — "anthropic" | "xai" | "openai-codex" | "github-copilot" | "google" | …
   *
   * A SIBLING of `providers`, not a replacement: `providers.anthropic` keeps its exact shape and
   * its two readers (`agents/effort-allocator.ts`, `agents/billing-gate.ts`) are untouched.
   * `windows` exists because those readers were Anthropic-only, which made every quota-aware
   * routing decision Anthropic-only.
   *
   * ORDER IS LOAD-BEARING. Each provider's array is SHORTEST WINDOW FIRST, because a consumer
   * takes the FIRST exhausted entry as the BINDING window: a spent 5-hour bucket throttles right
   * now even while the weekly bucket is half empty. A producer that appends in fetch order
   * instead of duration order silently changes which deadline routing believes in, and nothing
   * fails loudly.
   *
   * KNOWN GAP (2026-08-29): openrouter has NO quota signal at ANY layer. It is hard-excluded
   * from the cooldown machinery by `isAuthCooldownBypassedForProvider`
   * (`agents/auth-profiles/usage-state.ts`) and no fetcher reports windows for it, so the ~20
   * models routed through it — every Kimi, Qwen, GLM, DeepSeek — are invisible here and can
   * never be KNOWN to be spent. A consumer MUST read "absent from this map" as UNKNOWN, never
   * as "has headroom"; treating absence as headroom routes traffic at an exhausted provider.
   */
  windows?: Record<string, UsageWindowEntry[]>;
  /**
   * When `windows` was last refreshed. Separate from `lastSuccessfulFetch` on purpose — see that
   * field. A consumer routing on `windows` must check THIS for staleness, not that one.
   */
  windowsUpdatedAt?: number;
  providers: {
    anthropic?: {
      sevenDayUtilization: number; // 0-100, MAX across accounts (kept for UI/billing-gate back-compat)
      fiveHourUtilization: number; // 0-100, MAX across accounts
      // FORK 2026-06-18 (bible §5.84a): epoch-ms reset times so the burn-down effort
      // allocator (deriveQuotaPressure) can read them synchronously. Optional — absent
      // until the budget-panel poller publishes a live OAuth-usage fetch.
      sevenDayResetAt?: number; // SOONEST 7d reset (informational)
      fiveHourResetAt?: number; // SOONEST 5h reset (informational)
      // FORK 2026-06-19 (bible §5.84b): per-OAuth-account rows so the burn-down
      // allocator can use the BINDING (last-to-exhaust = max-headroom) constraint
      // instead of a blunt MAX. The gateway round-robins + fails over across these
      // accounts, so the pool only fully throttles when ALL are exhausted. Optional —
      // absent until the budget-panel poller populates it.
      accounts?: Array<{
        label: string; // e.g. "cli-sv" | "cli-gm"
        sevenDayUtilization: number; // 0-100, this account only
        fiveHourUtilization: number; // 0-100, this account only
        sevenDayResetAt?: number; // epoch ms, this account
        fiveHourResetAt?: number; // epoch ms, this account
      }>;
    };
    /**
     * READ but NEVER WRITTEN — verified 2026-08-29 by grepping every `getUsageSnapshot()` call
     * site (there are exactly two). `agents/billing-gate.ts` compares
     * `providers.openai.monthSpendUsd` against a model's `monthlyCapUsd`, but no producer has
     * ever set it, so that branch is unreachable and every metered `openai/*` candidate falls
     * through to the "unknown provider with no spend data" bag and is blocked as `over_cap`.
     * That is the CURRENT live behaviour, not a bug being introduced here.
     *
     * The number already exists: `fetchOpenAICosts()` in tinkerclaw-budget-panel computes
     * month-to-date org spend from the OpenAI Admin API. Wiring it is one line — and it would
     * start ALLOWING metered OpenAI models under cap. That is a deliberate change to a spend
     * gate, not a ride-along in a "widen the snapshot" patch, so it is left unwired.
     *
     * Do NOT delete this field to tidy up: billing-gate.ts and 7 of its tests construct it.
     */
    openai?: {
      monthSpendUsd: number;
    };
    // REMOVED 2026-08-29: `google?: { rpdUsed; rpdLimit }` had zero readers AND zero writers.
    // billing-gate's `provider === "google"` branch never touched it, and the only other
    // rpdUsed/rpdLimit in the tree (tinker-ui/src/model-usage.ts:479-495) reads snake_case
    // `rpd_used` off the `budget.usage` RPC payload — a different object. Google
    // request-per-day headroom now arrives as a real, POPULATED signal under `windows.google`.
  };
}

let snapshot: UsageSnapshot | null = null;

export function setUsageSnapshot(s: UsageSnapshot | null): void {
  snapshot = s;
}

export function getUsageSnapshot(): UsageSnapshot | null {
  return snapshot;
}
