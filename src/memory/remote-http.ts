// Intent: clean code refactoring applied (naming, clarity, DRY, magic numbers)
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";

export function buildRemoteBaseUrlPolicy(baseUrl: string): SsrFPolicy | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    // Keep policy tied to the configured host so private operator endpoints
    // continue to work, while cross-host redirects stay blocked.
    return { allowedHostnames: [parsed.hostname] };
  } catch {
    return undefined;
  }
}

export async function withRemoteHttpResponse<T>(params: {
  url: string;
  init?: RequestInit;
  ssrfPolicy?: SsrFPolicy;
  auditContext?: string;
  // FORK 2026-10-29: an embedding deadline aborts the request instead of only racing it. Both go
  // to fetchWithSsrFGuard, which already takes them; timeoutMs also bounds the undici dispatcher.
  signal?: AbortSignal;
  timeoutMs?: number;
  onResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    init: params.init,
    policy: params.ssrfPolicy,
    auditContext: params.auditContext ?? "memory-remote",
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
  try {
    return await params.onResponse(response);
  } finally {
    await release();
  }
}
