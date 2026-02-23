/**
 * COGNITIVE ARCHITECTURE HOOKS — FORK-ISOLATED
 *
 * Registers before_agent_start and agent_end hooks that wire
 * the ENGRAM/CORTEX/LIMBIC/SYNAPSE subsystems into the live agent.
 *
 * Activated when `agents.defaults.compaction.mode === "engram"`.
 *
 * Integration strategy (per Professor GPT review):
 * - before_agent_start → CORTEX PersonaState injection
 * - agent_end → ENGRAM event storage + CORTEX probes (async)
 * - compaction → already handled by compaction-engram extension
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginRegistry } from "./registry.js";
import type {
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookBeforeAgentStartEvent,
  PluginHookBeforeAgentStartResult,
} from "./types.js";

// Lazy-loaded to avoid import cost when not enabled
let _engramLoaded = false;
let _createEventStore: typeof import("../memory/engram/event-store.js").createEventStore;
let _personaModule: typeof import("../memory/cortex/persona-state.js");
let _injectionModule: typeof import("../memory/cortex/priority-injection.js");

function getEngramBaseDir(): string {
  const dir = join(process.env.HOME ?? "~", ".openclaw", "engram");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function ensureModules(): Promise<void> {
  if (_engramLoaded) {
    return;
  }
  const [eventStoreModule, persona, injection] = await Promise.all([
    import("../memory/engram/event-store.js"),
    import("../memory/cortex/persona-state.js"),
    import("../memory/cortex/priority-injection.js"),
  ]);
  _createEventStore = eventStoreModule.createEventStore;
  _personaModule = persona;
  _injectionModule = injection;
  _engramLoaded = true;
}

/** Load or create default PersonaState. */
function loadPersonaState(): import("../memory/cortex/persona-state.js").PersonaState {
  const stateFile = join(getEngramBaseDir(), "persona-state.json");
  if (existsSync(stateFile)) {
    try {
      return JSON.parse(readFileSync(stateFile, "utf-8"));
    } catch {
      return _personaModule.createDefaultPersonaState(
        "JarvisOne",
        "AI assistant and extension of Oscar",
      );
    }
  }
  const state = _personaModule.createDefaultPersonaState(
    "JarvisOne",
    "AI assistant and extension of Oscar",
  );
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return state;
}

/** Store a turn's messages to the ENGRAM event store. */
function storeAgentTurn(
  sessionKey: string,
  messages: Array<{ role: string; content: unknown }>,
): void {
  const baseDir = getEngramBaseDir();
  const store = _createEventStore({
    baseDir,
    sessionKey: sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_"),
  });

  // Find last user + assistant messages
  let lastUser: string | undefined;
  let lastAssistant: string | undefined;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const content =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? (msg.content as Array<{ type?: string; text?: string }>)
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("\n")
          : JSON.stringify(msg.content);

    if (!lastAssistant && msg.role === "assistant" && content) {
      lastAssistant = content;
    }
    if (!lastUser && msg.role === "user" && content) {
      lastUser = content;
    }
    if (lastUser && lastAssistant) {
      break;
    }
  }

  if (lastUser) {
    store.append({
      kind: "user_message",
      content: lastUser,
      tokens: Math.ceil(lastUser.length / 4),
      turnId: store.count(),
      sessionKey,
      metadata: {},
    });
  }

  if (lastAssistant) {
    store.append({
      kind: "agent_message",
      content: lastAssistant,
      tokens: Math.ceil(lastAssistant.length / 4),
      turnId: store.count(),
      sessionKey,
      metadata: {},
    });
  }
}

/**
 * Register cognitive architecture hooks into the plugin registry.
 * Only call this when compaction.mode === "engram".
 */
export function registerCognitiveHooks(
  registry: PluginRegistry,
  _config: OpenClawConfig | undefined,
): void {
  // Register HIPPOCAMPUS hook (fork-isolated, dynamic import to avoid polluting tsc graph)
  import("./hippocampus-hook.js")
    .then((mod) => mod.registerHippocampusHook(registry))
    .catch((err) => console.error("[cognitive-hooks] failed to register hippocampus:", err));

  // Create a synthetic plugin record for hook registration
  const pluginId = "cognitive-arch";

  registry.typedHooks.push({
    pluginId,
    hookName: "before_agent_start",
    handler: async (
      _event: PluginHookBeforeAgentStartEvent,
      _ctx: PluginHookAgentContext,
    ): Promise<PluginHookBeforeAgentStartResult | undefined> => {
      try {
        await ensureModules();
        const personaState = loadPersonaState();
        // Skip identity/voice injection when SOUL.md is present (already in workspace context)
        const hasSoulFile = _ctx.workspaceDir
          ? existsSync(join(_ctx.workspaceDir, "SOUL.md"))
          : false;
        const injectionResult = _injectionModule.injectPersonaState(personaState, 1500, {
          hasSoulFile,
        });
        if (injectionResult.blocks.length > 0) {
          const prependContext = injectionResult.blocks
            .map((b: { content: string }) => b.content)
            .join("\n\n");
          return { prependContext };
        }
      } catch (err) {
        // Graceful degradation — never block the agent
        console.error("[cognitive-hooks] before_agent_start error:", err);
      }
      return undefined;
    },
    priority: 50,
    source: "bundled:cognitive-arch",
  } as (typeof registry.typedHooks)[0]);

  registry.typedHooks.push({
    pluginId,
    hookName: "agent_end",
    handler: async (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext): Promise<void> => {
      try {
        await ensureModules();
        const sessionKey = ctx.sessionKey ?? "default";
        const messages = (event as { messages?: Array<{ role: string; content: unknown }> })
          .messages;
        if (messages && messages.length > 0) {
          storeAgentTurn(sessionKey, messages);
        }
      } catch (err) {
        // Graceful degradation
        console.error("[cognitive-hooks] agent_end error:", err);
      }
    },
    priority: 50,
    source: "bundled:cognitive-arch",
  } as (typeof registry.typedHooks)[0]);
}
