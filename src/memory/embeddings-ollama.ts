// Intent: clean code refactoring applied (naming, clarity, DRY, magic numbers)
import { resolveEnvApiKey } from "../agents/model-auth.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveOllamaApiBase } from "../plugin-sdk/ollama.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import { sanitizeAndNormalizeEmbedding } from "./embedding-vectors.js";
import { normalizeEmbeddingModelWithPrefixes } from "./embeddings-model-normalize.js";
import type {
  EmbedCallOptions,
  EmbeddingProvider,
  EmbeddingProviderOptions,
  EmbedMeasurement,
} from "./embeddings.js";
import { buildRemoteBaseUrlPolicy, withRemoteHttpResponse } from "./remote-http.js";
import { resolveMemorySecretInputString } from "./secret-input.js";

const log = createSubsystemLogger("memory");

export type OllamaEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
  embedBatch: (texts: string[], opts?: EmbedCallOptions) => Promise<number[][]>;
};
type OllamaEmbeddingClientConfig = Omit<OllamaEmbeddingClient, "embedBatch">;

export const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";

// FORK 2026-10-29: the 500-character cut now applies to the legacy /api/embeddings fallback only.
// /api/embed truncates at the model's own context (truncate: true), so whole chunks are embedded
// instead of their first 500 characters. The legacy endpoint cannot truncate: there, 1 char = 1
// token in the worst case (digits, punctuation, CJK), so 500 chars stay under a 512-token context.
const LEGACY_MAX_PROMPT_CHARS = 500;

/** Ollama's /api/embed answer, with the timings it reports per request (#20). */
type OllamaEmbedResponse = {
  embeddings?: unknown;
  prompt_eval_count?: unknown;
  total_duration?: unknown;
  load_duration?: unknown;
};

function normalizeOllamaModel(model: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    model,
    defaultModel: DEFAULT_OLLAMA_EMBEDDING_MODEL,
    prefixes: ["ollama/"],
  });
}

function resolveOllamaApiKey(options: EmbeddingProviderOptions): string | undefined {
  const remoteApiKey = resolveMemorySecretInputString({
    value: options.remote?.apiKey,
    path: "agents.*.memorySearch.remote.apiKey",
  });
  if (remoteApiKey) {
    return remoteApiKey;
  }
  const providerApiKey = normalizeOptionalSecretInput(
    options.config.models?.providers?.ollama?.apiKey,
  );
  if (providerApiKey) {
    return providerApiKey;
  }
  return resolveEnvApiKey("ollama")?.apiKey;
}

/**
 * FORK 2026-10-29: the Ollama base URL memory search embeds against: memorySearch.remote.baseUrl,
 * then models.providers.ollama.baseUrl, then Ollama's default. One definition for the provider, the
 * fit and every fork call site that builds its own adapter, so they all land on one governor queue.
 */
export function resolveOllamaEmbeddingBaseUrl(params: {
  config: EmbeddingProviderOptions["config"];
  remote?: { baseUrl?: string } | null;
}): string {
  return resolveOllamaApiBase(
    params.remote?.baseUrl?.trim() || params.config.models?.providers?.ollama?.baseUrl?.trim(),
  );
}

function resolveOllamaEmbeddingClient(
  options: EmbeddingProviderOptions,
): OllamaEmbeddingClientConfig {
  const providerConfig = options.config.models?.providers?.ollama;
  const baseUrl = resolveOllamaEmbeddingBaseUrl({ config: options.config, remote: options.remote });
  const model = normalizeOllamaModel(options.model);
  const headerOverrides = Object.assign({}, providerConfig?.headers, options.remote?.headers);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...headerOverrides,
  };
  const apiKey = resolveOllamaApiKey(options);
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return {
    baseUrl,
    headers,
    ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl),
    model,
  };
}

/** keep_alive and options.num_thread only when the governor sends them; absent = server default. */
function requestBody(
  body: Record<string, unknown>,
  opts: EmbedCallOptions | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if (typeof opts?.keepAlive === "string" && opts.keepAlive) {
    out.keep_alive = opts.keepAlive;
  }
  if (
    typeof opts?.numThread === "number" &&
    Number.isInteger(opts.numThread) &&
    opts.numThread > 0
  ) {
    out.options = { num_thread: opts.numThread };
  }
  return out;
}

/** /api/embed must answer number[][] with one vector per input. */
function readEmbeddings(value: unknown, expected: number): number[][] {
  const isMatrix =
    Array.isArray(value) &&
    value.every((row) => Array.isArray(row) && row.every((x) => typeof x === "number"));
  if (!isMatrix) {
    throw new Error(
      `Ollama /api/embed returned no number[][] embeddings: expected ${expected} vectors, received ${Array.isArray(value) ? `${value.length} entries that are not all number arrays` : typeof value}`,
    );
  }
  if (value.length !== expected) {
    throw new Error(
      `Ollama /api/embed returned the wrong number of embeddings: expected ${expected}, received ${value.length}`,
    );
  }
  return value as number[][];
}

/** A JSON {error} body: /api/embed exists and refused the request (a model that is not pulled). */
function isOllamaApiError(text: string): boolean {
  try {
    return typeof (JSON.parse(text) as { error?: unknown } | null)?.error === "string";
  } catch {
    return false;
  }
}

function isCount(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

/** One call as Ollama measured it; a timing Ollama did not send is omitted, never 0 (#20). */
function measurementOf(
  texts: string[],
  json: OllamaEmbedResponse,
  wallMs: number,
): EmbedMeasurement {
  const m: EmbedMeasurement = {
    inputs: texts.length,
    chars: texts.reduce((n, text) => n + text.length, 0),
    wallMs,
  };
  if (isCount(json.prompt_eval_count)) {
    m.promptEvalCount = json.prompt_eval_count;
  }
  if (isCount(json.total_duration)) {
    m.totalDurationNs = json.total_duration;
  }
  if (isCount(json.load_duration)) {
    m.loadDurationNs = json.load_duration;
  }
  return m;
}

export async function createOllamaEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: OllamaEmbeddingClient }> {
  const client = resolveOllamaEmbeddingClient(options);
  const base = client.baseUrl.replace(/\/$/, "");
  const embedUrl = `${base}/api/embed`;
  const legacyUrl = `${base}/api/embeddings`;
  let legacyLogged = false;

  // FORK 2026-10-29: ONE POST /api/embed per batch with an input array. It was one /api/embeddings
  // request per text, all in flight at once into a server with one slot. The caller's signal aborts
  // the request, and Ollama's own timings go to opts.onMeasure.
  const embedViaBatchApi = async (
    texts: string[],
    opts: EmbedCallOptions | undefined,
  ): Promise<number[][] | "route-missing"> => {
    const started = performance.now();
    return await withRemoteHttpResponse({
      url: embedUrl,
      ssrfPolicy: client.ssrfPolicy,
      signal: opts?.signal,
      init: {
        method: "POST",
        headers: client.headers,
        body: JSON.stringify(
          requestBody({ model: client.model, input: texts, truncate: true }, opts),
        ),
      },
      onResponse: async (res): Promise<number[][] | "route-missing"> => {
        if (res.status === 404) {
          const text = await res.text();
          if (!isOllamaApiError(text)) {
            return "route-missing";
          }
          throw new Error(`Ollama embeddings HTTP 404: ${text}`);
        }
        if (!res.ok) {
          throw new Error(`Ollama embeddings HTTP ${res.status}: ${await res.text()}`);
        }
        const json = (await res.json()) as OllamaEmbedResponse;
        const vectors = readEmbeddings(json.embeddings, texts.length);
        opts?.onMeasure?.(measurementOf(texts, json, performance.now() - started));
        return vectors.map((vector) => sanitizeAndNormalizeEmbedding(vector));
      },
    });
  };

  const embedOneLegacy = async (
    prompt: string,
    opts: EmbedCallOptions | undefined,
  ): Promise<number[]> => {
    const json = await withRemoteHttpResponse({
      url: legacyUrl,
      ssrfPolicy: client.ssrfPolicy,
      signal: opts?.signal,
      init: {
        method: "POST",
        headers: client.headers,
        body: JSON.stringify(requestBody({ model: client.model, prompt }, opts)),
      },
      onResponse: async (res) => {
        if (!res.ok) {
          throw new Error(`Ollama embeddings HTTP ${res.status}: ${await res.text()}`);
        }
        return (await res.json()) as { embedding?: number[] };
      },
    });
    if (!Array.isArray(json.embedding)) {
      throw new Error(`Ollama embeddings response missing embedding[]`);
    }
    return sanitizeAndNormalizeEmbedding(json.embedding);
  };

  // FORK 2026-10-29: a server without /api/embed (a 404 that is not a JSON error) gets the legacy
  // endpoint, one text at a time and strictly in sequence, never in parallel.
  const embedViaLegacyApi = async (
    texts: string[],
    opts: EmbedCallOptions | undefined,
  ): Promise<number[][]> => {
    if (!legacyLogged) {
      legacyLogged = true;
      log.warn(
        `Ollama at ${base} has no /api/embed (an older server): embedding one text at a time through /api/embeddings, each cut to ${LEGACY_MAX_PROMPT_CHARS} characters; a newer Ollama embeds whole chunks in one request`,
      );
    }
    const started = performance.now();
    const vectors: number[][] = [];
    let chars = 0;
    for (const text of texts) {
      opts?.signal?.throwIfAborted();
      const prompt =
        text.length > LEGACY_MAX_PROMPT_CHARS ? text.slice(0, LEGACY_MAX_PROMPT_CHARS) : text;
      chars += prompt.length;
      vectors.push(await embedOneLegacy(prompt, opts));
    }
    opts?.onMeasure?.({ inputs: texts.length, chars, wallMs: performance.now() - started });
    return vectors;
  };

  const embedBatch = async (texts: string[], opts?: EmbedCallOptions): Promise<number[][]> => {
    if (texts.length === 0) {
      return [];
    }
    const vectors = await embedViaBatchApi(texts, opts);
    return vectors === "route-missing" ? await embedViaLegacyApi(texts, opts) : vectors;
  };

  const provider: EmbeddingProvider = {
    id: "ollama",
    model: client.model,
    embedQuery: async (text, opts) => {
      const [vector] = await embedBatch([text], opts);
      return vector;
    },
    embedBatch,
  };

  return {
    provider,
    client: {
      ...client,
      embedBatch: async (texts, opts) => {
        try {
          return await provider.embedBatch(texts, opts);
        } catch (err) {
          throw new Error(formatErrorMessage(err), { cause: err });
        }
      },
    },
  };
}
