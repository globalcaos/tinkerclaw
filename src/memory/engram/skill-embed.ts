/**
 * Shared resolver for the skill library's semantic-search embedding fn.
 *
 * Extracted so BOTH the consolidation cron (engram-consolidate.ts) and the
 * `fork.skill.search` RPC resolve embeddings the SAME way — there is one canonical
 * in-process embed path (memorySearch's provider and model, which is this machine's
 * embedder fit when the provider is unset: the same stack fork.prefrontal.embed uses),
 * not two drifting copies.
 *
 * FORK 2026-10-29 (TINKER_UI_DESIGN_BIBLE/embedder-fit.md): a machine whose memory search
 * runs words only (isEmbeddingOff) gets undefined, and no provider is built. Any other
 * provider goes through the embedder governor as consumer 'skill-search': the queue every
 * embedding call to that endpoint shares, on the foreground lane, because the
 * fork.skill.search caller waits for the answer.
 *
 * Returns undefined when no provider is configured/available (tests, clones,
 * headless) so the library degrades to its keyword fallback. Never throws.
 *
 * FORK-ISOLATED: unique to our fork (Sleep Consolidation paper, Upgrade 6).
 */
import type { EmbedFn } from "./embedding-worker.js";

export async function resolveSkillEmbedFn(): Promise<EmbedFn | undefined> {
  try {
    const [
      { getRuntimeConfig },
      { resolveDefaultAgentId },
      { resolveAgentDir },
      { resolveMemorySearchConfig },
      { createConfiguredEmbeddingProvider },
      { isEmbeddingOff, readRawMemorySearchProvider },
      { governEmbeddingProvider },
      { resolveEmbeddingEndpointBaseUrl },
    ] = await Promise.all([
      import("../../config/io.js"),
      import("../../agents/agent-scope-config.js"),
      import("../../agents/agent-scope.js"),
      import("../../agents/memory-search.js"),
      import("../../gateway/embeddings-http.js"),
      import("../../fork/embedder-fit.js"),
      import("../../fork/embedder-governor.js"),
      import("../embedding-endpoint.js"),
    ]);
    const cfg = getRuntimeConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const agentDir = resolveAgentDir(cfg, agentId);
    const memorySearch = resolveMemorySearchConfig(cfg, agentId);
    if (!memorySearch || isEmbeddingOff(memorySearch)) {
      return undefined; // words only on this machine → keyword ranking, no provider built
    }
    const created = await createConfiguredEmbeddingProvider({
      cfg,
      agentDir,
      provider: memorySearch.provider,
      model: memorySearch.model,
      memorySearch: {
        local: memorySearch.local,
        remote: memorySearch.remote,
        outputDimensionality: memorySearch.outputDimensionality,
      },
    });
    // The endpoint key the memory index and the prefrontal RPC use for this server: the provider
    // id plus the base URL it calls, for every HTTP provider (FORK 2026-10-30), so all three land
    // on one governor queue. The mode is derived as the prefrontal RPC derives it.
    const baseUrl = await resolveEmbeddingEndpointBaseUrl({
      providerId: created.id,
      config: cfg,
      remote: memorySearch.remote,
    });
    const provider = governEmbeddingProvider(created, {
      consumer: "skill-search",
      baseUrl,
      mode: readRawMemorySearchProvider(cfg, agentId) === "auto" ? "fit" : "pin",
    });
    // Adapt number[][] → Float32Array[] (EmbedFn's contract). cosine() in the
    // skill library accepts either, but the type demands Float32Array.
    return async (texts: string[]): Promise<Float32Array[]> => {
      const vecs = await provider.embedBatch(texts, { priority: "foreground" });
      return vecs.map((v) => (v instanceof Float32Array ? v : Float32Array.from(v)));
    };
  } catch {
    return undefined; // no provider in this environment → keyword fallback
  }
}
