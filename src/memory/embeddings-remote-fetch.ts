import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { postJson } from "./post-json.js";

export async function fetchRemoteEmbeddingVectors(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  body: unknown;
  errorPrefix: string;
  // FORK 2026-10-30: handed on to postJson, so an aborted embedding call stops its request.
  signal?: AbortSignal;
}): Promise<number[][]> {
  return await postJson({
    url: params.url,
    headers: params.headers,
    ssrfPolicy: params.ssrfPolicy,
    body: params.body,
    errorPrefix: params.errorPrefix,
    signal: params.signal,
    parse: (payload) => {
      const typedPayload = payload as {
        data?: Array<{ embedding?: number[] }>;
      };
      const data = typedPayload.data ?? [];
      return data.map((entry) => entry.embedding ?? []);
    },
  });
}
