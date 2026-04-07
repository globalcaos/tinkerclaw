import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

export function normalizeConfig(params: { provider: string; providerConfig: ModelProviderConfig }) {
  return params.providerConfig;
}
