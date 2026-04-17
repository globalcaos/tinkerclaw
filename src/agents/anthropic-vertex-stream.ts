import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamAnthropic, type AnthropicOptions, type Model } from "@mariozechner/pi-ai";
import {
  resolveAnthropicVertexClientRegion,
  resolveAnthropicVertexProjectId,
} from "../plugin-sdk/anthropic-vertex.js";
import { updateRateLimitSnapshot } from "./anthropic-ratelimit-store.js";

type AnthropicVertexEffort = NonNullable<AnthropicOptions["effort"]>;
type AnthropicVertexAdaptiveEffort = AnthropicVertexEffort | "xhigh";

function isClaudeOpus47Model(modelId: string): boolean {
  return modelId.includes("opus-4-7") || modelId.includes("opus-4.7");
}

function isClaudeOpus46Model(modelId: string): boolean {
  return modelId.includes("opus-4-6") || modelId.includes("opus-4.6");
}

function supportsAdaptiveThinking(modelId: string): boolean {
  return (
    isClaudeOpus47Model(modelId) ||
    isClaudeOpus46Model(modelId) ||
    modelId.includes("sonnet-4-6") ||
    modelId.includes("sonnet-4.6")
  );
}

function mapAnthropicAdaptiveEffort(
  reasoning: string,
  modelId: string,
): AnthropicVertexAdaptiveEffort {
  const effortMap: Record<string, AnthropicVertexAdaptiveEffort> = {
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: isClaudeOpus47Model(modelId) ? "xhigh" : isClaudeOpus46Model(modelId) ? "max" : "high",
  };
  return effortMap[reasoning] ?? "high";
}

function resolveAnthropicVertexMaxTokens(params: {
  modelMaxTokens: number | undefined;
  requestedMaxTokens: number | undefined;
}): number | undefined {
  const modelMax =
    typeof params.modelMaxTokens === "number" &&
    Number.isFinite(params.modelMaxTokens) &&
    params.modelMaxTokens > 0
      ? Math.floor(params.modelMaxTokens)
      : undefined;
  const requested =
    typeof params.requestedMaxTokens === "number" &&
    Number.isFinite(params.requestedMaxTokens) &&
    params.requestedMaxTokens > 0
      ? Math.floor(params.requestedMaxTokens)
      : undefined;

  if (modelMax !== undefined && requested !== undefined) {
    return Math.min(requested, modelMax);
  }
  return requested ?? modelMax;
}

/**
 * FORK: Wraps the global fetch to capture Anthropic rate limit headers
 * from every API response and store them in the shared snapshot store.
 * Injected into the AnthropicVertex client via its `fetch` option.
 */
function createRateLimitCapturingFetch(): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await globalThis.fetch(input, init);
    const h5Raw = response.headers.get("anthropic-ratelimit-unified-5h-utilization");
    const d7Raw = response.headers.get("anthropic-ratelimit-unified-7d-utilization");
    if (h5Raw != null || d7Raw != null) {
      const h5 = h5Raw != null ? parseFloat(h5Raw) : 0;
      const d7 = d7Raw != null ? parseFloat(d7Raw) : 0;
      const d7SonnetRaw = response.headers.get("anthropic-ratelimit-unified-7d-sonnet-utilization");
      const claim =
        response.headers.get("anthropic-ratelimit-unified-representative-claim") || "five_hour";
      updateRateLimitSnapshot({
        h5: Number.isFinite(h5) ? h5 : 0,
        d7: Number.isFinite(d7) ? d7 : 0,
        d7Sonnet: d7SonnetRaw != null ? parseFloat(d7SonnetRaw) || 0 : undefined,
        claim,
        ts: Date.now(),
      });
    }
    return response;
  };
}

/**
 * Create a StreamFn that routes through pi-ai's `streamAnthropic` with an
 * injected `AnthropicVertex` client.  All streaming, message conversion, and
 * event handling is handled by pi-ai — we only supply the GCP-authenticated
 * client and map SimpleStreamOptions → AnthropicOptions.
 */
export function createAnthropicVertexStreamFn(
  projectId: string | undefined,
  region: string,
  baseURL?: string,
): StreamFn {
  const client = new AnthropicVertex({
    region,
    fetch: createRateLimitCapturingFetch(),
    ...(baseURL ? { baseURL } : {}),
    ...(projectId ? { projectId } : {}),
  });

  return (model, context, options) => {
    const maxTokens = resolveAnthropicVertexMaxTokens({
      modelMaxTokens: model.maxTokens,
      requestedMaxTokens: options?.maxTokens,
    });
    const opts: AnthropicOptions = {
      client: client as unknown as AnthropicOptions["client"],
      temperature: options?.temperature,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      signal: options?.signal,
      cacheRetention: options?.cacheRetention,
      sessionId: options?.sessionId,
      headers: options?.headers,
      onPayload: options?.onPayload,
      maxRetryDelayMs: options?.maxRetryDelayMs,
      metadata: options?.metadata,
    };

    if (options?.reasoning) {
      if (supportsAdaptiveThinking(model.id)) {
        opts.thinkingEnabled = true;
        opts.effort = mapAnthropicAdaptiveEffort(
          options.reasoning,
          model.id,
        ) as AnthropicVertexEffort;
      } else {
        opts.thinkingEnabled = true;
        const budgets = options.thinkingBudgets;
        opts.thinkingBudgetTokens =
          (budgets && options.reasoning in budgets
            ? budgets[options.reasoning as keyof typeof budgets]
            : undefined) ?? 10000;
      }
    } else {
      opts.thinkingEnabled = false;
    }

    return streamAnthropic(model as Model<"anthropic-messages">, context, opts);
  };
}

function resolveAnthropicVertexSdkBaseUrl(baseUrl?: string): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    if (!normalizedPath || normalizedPath === "") {
      url.pathname = "/v1";
      return url.toString().replace(/\/$/, "");
    }
    if (!normalizedPath.endsWith("/v1")) {
      url.pathname = `${normalizedPath}/v1`;
      return url.toString().replace(/\/$/, "");
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

export function createAnthropicVertexStreamFnForModel(
  model: { baseUrl?: string },
  env: NodeJS.ProcessEnv = process.env,
): StreamFn {
  return createAnthropicVertexStreamFn(
    resolveAnthropicVertexProjectId(env),
    resolveAnthropicVertexClientRegion({
      baseUrl: model.baseUrl,
      env,
    }),
    resolveAnthropicVertexSdkBaseUrl(model.baseUrl),
  );
}
