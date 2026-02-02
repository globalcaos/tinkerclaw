import type { GatewayBrowserClient } from "../gateway";
import type { UsageSummary } from "../types";

export type ProviderUsageState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  providerUsage: UsageSummary | null;
  providerUsageLoading: boolean;
  providerUsageError: string | null;
};

export async function loadProviderUsage(state: ProviderUsageState) {
  if (!state.client || !state.connected) return;
  if (state.providerUsageLoading) return;
  state.providerUsageLoading = true;
  state.providerUsageError = null;
  try {
    const result = await state.client.request<UsageSummary>("usage.status", {});
    state.providerUsage = result;
  } catch (err) {
    state.providerUsageError = err instanceof Error ? err.message : String(err);
  } finally {
    state.providerUsageLoading = false;
  }
}
