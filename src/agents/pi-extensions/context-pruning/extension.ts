/**
 * FORK: context-pruning/extension — Pi extension entry point for context window pruning
 *
 * Registers a "context" event handler that intercepts the message array before it is
 * sent to the LLM. When the context window fill ratio exceeds configured thresholds,
 * it delegates to the pruner to soft-trim or hard-clear old tool results. In "cache-ttl"
 * mode, pruning is skipped if the cache was touched within the configured TTL window.
 *
 * Wired in by: Pi extension loader via the context-pruning plugin config; imports
 * pruner.ts for the actual pruning logic and runtime.ts for per-session settings.
 */
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { pruneContextMessages } from "./pruner.js";
import { getContextPruningRuntime } from "./runtime.js";

export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextPruningRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined;
    }

    if (runtime.settings.mode === "cache-ttl") {
      const ttlMs = runtime.settings.ttlMs;
      const lastTouch = runtime.lastCacheTouchAt ?? null;
      if (!lastTouch || ttlMs <= 0) {
        return undefined;
      }
      if (ttlMs > 0 && Date.now() - lastTouch < ttlMs) {
        return undefined;
      }
    }

    const next = pruneContextMessages({
      messages: event.messages,
      settings: runtime.settings,
      ctx,
      isToolPrunable: runtime.isToolPrunable,
      contextWindowTokensOverride: runtime.contextWindowTokens ?? undefined,
    });

    if (next === event.messages) {
      return undefined;
    }

    if (runtime.settings.mode === "cache-ttl") {
      runtime.lastCacheTouchAt = Date.now();
    }

    return { messages: next };
  });
}
