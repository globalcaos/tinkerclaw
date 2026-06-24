// src/infra/usage-snapshot-store.ts
// FORK: Shared in-memory bridge between budget-panel extension (writer)
// and billing-gate module (reader). Decouples plugin from core code.

export interface UsageSnapshot {
  /** Timestamp of last SUCCESSFUL API fetch (not last cache write) */
  lastSuccessfulFetch: number;
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
    openai?: {
      monthSpendUsd: number;
    };
    google?: {
      rpdUsed: number;
      rpdLimit: number;
    };
  };
}

let snapshot: UsageSnapshot | null = null;

export function setUsageSnapshot(s: UsageSnapshot | null): void {
  snapshot = s;
}

export function getUsageSnapshot(): UsageSnapshot | null {
  return snapshot;
}
