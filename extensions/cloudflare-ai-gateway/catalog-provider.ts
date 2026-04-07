import {
  coerceSecretRef,
  ensureAuthProfileStore,
  resolveNonEnvSecretRefApiKeyMarker,
} from "openclaw/plugin-sdk/provider-auth";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  buildCloudflareAiGatewayModelDefinition,
  resolveCloudflareAiGatewayBaseUrl,
} from "./models.js";

export type CloudflareAiGatewayCredential =
  | ReturnType<typeof ensureAuthProfileStore>["profiles"][string]
  | undefined;

export function resolveCloudflareAiGatewayApiKey(
  cred: CloudflareAiGatewayCredential,
): string | undefined {
  if (!cred || cred.type !== "api_key") {
    return undefined;
  }

  const keyRef = coerceSecretRef(cred.keyRef);
  const keyRefId = normalizeOptionalString(keyRef?.id);
  if (keyRef && keyRefId) {
    return keyRef.source === "env" ? keyRefId : resolveNonEnvSecretRefApiKeyMarker(keyRef.source);
  }
  return normalizeOptionalString(cred.key);
}

export function resolveCloudflareAiGatewayMetadata(cred: CloudflareAiGatewayCredential): {
  accountId?: string;
  gatewayId?: string;
} {
  if (!cred || cred.type !== "api_key") {
    return {};
  }
  return {
    accountId: normalizeOptionalString(cred.metadata?.accountId),
    gatewayId: normalizeOptionalString(cred.metadata?.gatewayId),
  };
}

export function buildCloudflareAiGatewayCatalogProvider(params: {
  credential: CloudflareAiGatewayCredential;
  envApiKey?: string;
}): ModelProviderConfig | null {
  const apiKey =
    normalizeOptionalString(params.envApiKey) ??
    resolveCloudflareAiGatewayApiKey(params.credential);
  if (!apiKey) {
    return null;
  }
  const { accountId, gatewayId } = resolveCloudflareAiGatewayMetadata(params.credential);
  if (!accountId || !gatewayId) {
    return null;
  }
  const baseUrl = resolveCloudflareAiGatewayBaseUrl({ accountId, gatewayId });
  if (!baseUrl) {
    return null;
  }
  return {
    baseUrl,
    api: "anthropic-messages",
    apiKey,
    models: [buildCloudflareAiGatewayModelDefinition()],
  };
}
