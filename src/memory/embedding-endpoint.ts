/**
 * FORK 2026-10-30 (TINKER_UI_DESIGN_BIBLE/embedder-fit.md): the base URL a configured embedding
 * provider will call.
 *
 * The embedder governor keys its queue by provider id plus URL origin and classifies the endpoint
 * by host (endpointKeyFor and classifyEmbeddingEndpoint in src/fork/embedder-fit.ts). The memory
 * index passes its client's own base URL (createEmbeddingProvider in src/memory/embeddings.ts).
 * Skill search and the prefrontal lane build their provider through
 * createConfiguredEmbeddingProvider, which hands back no client, so they ask this function. Every
 * consumer of one server then shares one endpoint key and one queue, and an OpenAI-compatible
 * server on 127.0.0.1 is governed as local-http.
 *
 * Ollama answers through resolveOllamaEmbeddingBaseUrl. OpenAI, Gemini, Voyage and Mistral answer
 * through the adapter's own exported client resolver, so the order (memorySearch.remote.baseUrl,
 * then the adapter's models.providers entry, then its default) and Gemini's differences (it reads
 * models.providers.google and trims an OpenAI-compatible path) stay the adapter's, and nothing is
 * copied here. The in-process 'local' provider, and any id this function does not know, calls no
 * URL: undefined.
 *
 * FORK-ISOLATED: unique to our fork.
 */
import { resolveGeminiEmbeddingClient } from "./embeddings-gemini.js";
import { resolveMistralEmbeddingClient } from "./embeddings-mistral.js";
import { resolveOllamaEmbeddingBaseUrl } from "./embeddings-ollama.js";
import { resolveOpenAiEmbeddingClient } from "./embeddings-openai.js";
import { resolveVoyageEmbeddingClient } from "./embeddings-voyage.js";
import type { EmbeddingProviderOptions } from "./embeddings.js";

/**
 * Stands in for the API key when a client resolver is asked only for its URL. Given a key, the
 * resolver skips the auth store. The key ends up only inside a client this function drops at once,
 * so it never reaches a request.
 */
const URL_ONLY_API_KEY = "url-only"; // pragma: allowlist secret

export async function resolveEmbeddingEndpointBaseUrl(params: {
  providerId: string;
  config: EmbeddingProviderOptions["config"];
  remote?: { baseUrl?: string } | null;
}): Promise<string | undefined> {
  const { providerId, config } = params;
  if (providerId === "ollama") {
    return resolveOllamaEmbeddingBaseUrl({ config, remote: params.remote });
  }
  const urlOnly = (provider: EmbeddingProviderOptions["provider"]): EmbeddingProviderOptions => ({
    config,
    provider,
    model: "",
    fallback: "none",
    remote: { baseUrl: params.remote?.baseUrl, apiKey: URL_ONLY_API_KEY },
  });
  switch (providerId) {
    case "openai":
      return (await resolveOpenAiEmbeddingClient(urlOnly("openai"))).baseUrl;
    case "gemini":
      return (await resolveGeminiEmbeddingClient(urlOnly("gemini"))).baseUrl;
    case "voyage":
      return (await resolveVoyageEmbeddingClient(urlOnly("voyage"))).baseUrl;
    case "mistral":
      return (await resolveMistralEmbeddingClient(urlOnly("mistral"))).baseUrl;
    default:
      return undefined;
  }
}
