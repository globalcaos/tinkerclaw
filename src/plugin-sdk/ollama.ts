/**
 * FORK 2026-04-28: Re-export facade for the upstream ollama API surface.
 *
 * Upstream deleted src/plugin-sdk/ollama.ts when extensions/ollama/ became
 * the canonical home for ollama runtime helpers. The fork still imports
 * from "src/plugin-sdk/ollama" via src/memory/embeddings-ollama.ts (which
 * upstream also deleted, but the fork keeps for direct ollama embedding
 * access without going through the extension's compat shim).
 *
 * This file is a thin re-export: it doesn't add behaviour, it just keeps
 * the fork's import path stable so the wiring script doesn't have to
 * patch every caller after every merge.
 */
export {
  buildOllamaBaseUrlSsrFPolicy,
  resolveOllamaApiBase,
} from "../../extensions/ollama/src/provider-models.js";
export type {
  OllamaModelWithContext,
  OllamaTagModel,
  OllamaTagsResponse,
} from "../../extensions/ollama/src/provider-models.js";
