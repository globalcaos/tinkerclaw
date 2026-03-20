// src/infra/usage-snapshot-store.ts
// FORK: Shared in-memory bridge between budget-panel extension (writer)
// and billing-gate module (reader). Decouples plugin from core code.

export interface UsageSnapshot {
  /** Timestamp of last SUCCESSFUL API fetch (not last cache write) */
  lastSuccessfulFetch: number;
  providers: {
    anthropic?: {
      sevenDayUtilization: number; // 0-100, max across profiles
      fiveHourUtilization: number; // 0-100, max across profiles
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
