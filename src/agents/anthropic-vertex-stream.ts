import type { StreamFn } from "@mariozechner/pi-agent-core";
import { loadBundledPluginPublicSurfaceModuleSync } from "../plugin-sdk/facade-loader.js";
// FORK: rate-limit snapshot capture used by anthropic header inspection.
import { updateRateLimitSnapshot } from "./anthropic-ratelimit-store.js";

type AnthropicVertexStreamFacade = {
  createAnthropicVertexStreamFn: (
    projectId: string | undefined,
    region: string,
    baseURL?: string,
  ) => StreamFn;
  createAnthropicVertexStreamFnForModel: (
    model: { baseUrl?: string },
    env?: NodeJS.ProcessEnv,
  ) => StreamFn;
};

function loadAnthropicVertexStreamFacade(): AnthropicVertexStreamFacade {
  return loadBundledPluginPublicSurfaceModuleSync<AnthropicVertexStreamFacade>({
    dirName: "anthropic-vertex",
    artifactBasename: "api.js",
  });
}

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

export function createAnthropicVertexStreamFn(
  projectId: string | undefined,
  region: string,
  baseURL?: string,
): StreamFn {
  return loadAnthropicVertexStreamFacade().createAnthropicVertexStreamFn(
    projectId,
    region,
    baseURL,
  );
}

export function createAnthropicVertexStreamFnForModel(
  model: { baseUrl?: string },
  env: NodeJS.ProcessEnv = process.env,
): StreamFn {
  return loadAnthropicVertexStreamFacade().createAnthropicVertexStreamFnForModel(model, env);
}
