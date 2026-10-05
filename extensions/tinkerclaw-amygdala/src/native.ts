/**
 * The native-runner seam (design doc §3 M11): thin handlers that build the same hook-shaped payload the Claude Code hooks
 * send and call the runtime. Claude Code runs go through the hook scripts; this covers the gateway's own runner.
 *
 * Limits of this build, on purpose:
 *  - `context` notes cannot be delivered on this path yet (no channel back into the running turn); they are counted in
 *    status as `notesDropped`.
 *  - the end-of-turn handler records only; it never blocks (no send-back on the native path).
 *  - in shadow mode nothing here ever blocks.
 * Any error is logged and the tool call proceeds.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { HookAction } from "./hook-action.js";
import type { Runtime } from "./runtime.js";

type NativeRuntime = Pick<Runtime, "decide" | "waitFor" | "mode" | "noteNotesDropped">;
type Block = { block: true; blockReason: string };

interface Ctx {
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}

/** The event's session if it names one, else a stable synthetic id for the agent. */
function sessionOf(ctx: unknown): string {
  const c = (ctx ?? {}) as Ctx;
  return c.sessionKey ?? c.sessionId ?? `native:${c.agentId ?? "main"}`;
}

function lastAssistantText(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    if (!m || m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .map((p) => (p && typeof p === "object" ? (p as { text?: unknown }).text : undefined))
        .filter((t): t is string => typeof t === "string")
        .join("\n");
      return text || undefined;
    }
    return undefined;
  }
  return undefined;
}

async function toBlock(runtime: NativeRuntime, hook: HookAction): Promise<Block | undefined> {
  if (runtime.mode === "shadow") return undefined;
  switch (hook.kind) {
    case "deny":
      return { block: true, blockReason: hook.reason };
    case "wait": {
      const r = await runtime.waitFor(hook.interventionId, hook.timeoutMs);
      if (r.answer === "allow-once") return undefined;
      if (r.answer === "keep-held") return { block: true, blockReason: hook.onKeep };
      if (r.answer === "timeout") return { block: true, blockReason: hook.onTimeout };
      return { block: true, blockReason: r.text ?? hook.onKeep };
    }
    case "context":
      runtime.noteNotesDropped();
      return undefined;
    default:
      return undefined;
  }
}

export function registerNativeHandlers(api: OpenClawPluginApi, runtime: NativeRuntime): void {
  api.on("before_tool_call", async (event, ctx) => {
    try {
      const r = await runtime.decide("pre-tool", {
        session_id: sessionOf(ctx),
        tool_name: event.toolName,
        tool_input: event.params,
        tool_use_id: event.toolCallId,
      });
      return await toBlock(runtime, r.hook);
    } catch (err) {
      console.error("[amygdala] native handler failed", err);
      return undefined;
    }
  });

  api.on("after_tool_call", async (event, ctx) => {
    try {
      const r = await runtime.decide("post-tool", {
        session_id: sessionOf(ctx),
        tool_name: event.toolName,
        tool_input: event.params,
        tool_use_id: event.toolCallId,
        tool_response:
          event.error !== undefined ? { is_error: true, error: event.error } : event.result,
      });
      if (r.hook.kind === "context") runtime.noteNotesDropped();
    } catch (err) {
      console.error("[amygdala] native handler failed", err);
    }
  });

  api.on("agent_end", async (event, ctx) => {
    try {
      await runtime.decide("stop", {
        session_id: sessionOf(ctx),
        last_assistant_message: lastAssistantText(event.messages),
      });
    } catch (err) {
      console.error("[amygdala] native handler failed", err);
    }
  });
}
