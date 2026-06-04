/**
 * Shared resolver for the skill library's semantic-search embedding fn.
 *
 * Extracted so BOTH the consolidation cron (engram-consolidate.ts) and the
 * `fork.skill.search` RPC resolve embeddings the SAME way — there is one canonical
 * in-process embed path (ollama/mxbai via memorySearch, the same fork.prefrontal.embed
 * stack), not two drifting copies.
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
    ] = await Promise.all([
      import("../../config/io.js"),
      import("../../agents/agent-scope-config.js"),
      import("../../agents/agent-scope.js"),
      import("../../agents/memory-search.js"),
      import("../../gateway/embeddings-http.js"),
    ]);
    const cfg = getRuntimeConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const agentDir = resolveAgentDir(cfg, agentId);
    const memorySearch = resolveMemorySearchConfig(cfg, agentId);
    if (!memorySearch?.provider) {
      return undefined;
    }
    const provider = await createConfiguredEmbeddingProvider({
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
    // Adapt number[][] → Float32Array[] (EmbedFn's contract). cosine() in the
    // skill library accepts either, but the type demands Float32Array.
    return async (texts: string[]): Promise<Float32Array[]> => {
      const vecs = await provider.embedBatch(texts);
      return vecs.map((v) => (v instanceof Float32Array ? v : Float32Array.from(v)));
    };
  } catch {
    return undefined; // no provider in this environment → keyword fallback
  }
}
