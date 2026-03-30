/**
 * FORK: Fractal Reflection — Session injection via Gateway RPC.
 *
 * After each interactive turn, injects the fractal reflection prompt
 * into the session using callGateway("sessions.send"). This is the same
 * path as the sessions_send tool / inter-session messaging — fully supported,
 * properly routed, visible in webchat.
 *
 * Self-contained: reads the prompt from the extension's own directory,
 * no upstream imports. Debounce and automated-session filtering prevent
 * infinite loops and noise.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Prompt loading
// ---------------------------------------------------------------------------

let _promptCache: string | null = null;

/** Clear cache to pick up prompt edits without restart. */
export function clearPromptCache(): void {
  _promptCache = null;
}

/**
 * Load the fractal prompt from the extension's own directory.
 * Falls back to a minimal inline prompt if the file is missing.
 */
export function loadPrompt(extensionDir: string): string {
  if (_promptCache) {
    return _promptCache;
  }
  try {
    _promptCache = readFileSync(join(extensionDir, "fractal-prompt.md"), "utf-8").trim();
    return _promptCache;
  } catch {
    // File missing — use hard fallback
  }
  _promptCache =
    "FRACTAL REFLECTION: Reflect on the previous turn. What pattern does it belong to?";
  return _promptCache;
}

// ---------------------------------------------------------------------------
// Session filtering
// ---------------------------------------------------------------------------

/** Sessions that should NOT get fractal reflection (prevents infinite loops). */
export function isAutomatedSession(sessionKey: string): boolean {
  return (
    sessionKey.includes("subagent:") ||
    sessionKey.includes("isolated:") ||
    sessionKey.includes("cron:") ||
    sessionKey.includes("heartbeat")
  );
}

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

const lastInjectionTime = new Map<string, number>();

/** Check debounce and update timestamp if allowed. Returns true if injection should proceed. */
export function checkDebounce(sessionKey: string, debounceMs: number): boolean {
  const now = Date.now();
  const last = lastInjectionTime.get(sessionKey) ?? 0;
  if (now - last < debounceMs) {
    return false;
  }
  lastInjectionTime.set(sessionKey, now);
  return true;
}

/** Reset debounce state (for testing). */
export function resetDebounce(): void {
  lastInjectionTime.clear();
}

/** Peek at last injection time (for testing). */
export function getLastInjectionTime(sessionKey: string): number {
  return lastInjectionTime.get(sessionKey) ?? 0;
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

export interface FractalInjectOptions {
  sessionKey: string;
  extensionDir: string;
  debounceMs: number;
  messages?: unknown[];
  log: { info: (msg: string) => void };
}

/**
 * Inject a fractal reflection into the session via gateway RPC.
 * Uses callGateway("sessions.send") — the same path as the sessions_send tool.
 *
 * Returns true if injection was dispatched, false if skipped.
 */
export async function injectFractalReflection(opts: FractalInjectOptions): Promise<boolean> {
  const { sessionKey, extensionDir, debounceMs, messages, log } = opts;

  if (!sessionKey) {
    return false;
  }

  // Skip automated sessions
  if (isAutomatedSession(sessionKey)) {
    log.info("[fractal-reflection] skipped -- automated session");
    return false;
  }

  // Extract assistant texts from messages (if provided by agent_end event)
  const assistantTexts: string[] = [];
  if (messages) {
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      const m = msg as Record<string, unknown>;
      if (m.role !== "assistant") continue;
      if (typeof m.content === "string") {
        assistantTexts.push(m.content);
      }
    }
  }
  const fullResponse = assistantTexts.join("\n").trim();

  // Skip silent replies
  if (fullResponse === "NO_REPLY" || fullResponse === "HEARTBEAT_OK") {
    log.info("[fractal-reflection] skipped -- silent reply");
    return false;
  }

  // Skip if response is already a fractal reflection (prevent infinite loop)
  if (
    fullResponse.startsWith("\u{1F33F} FRACTAL:") ||
    (fullResponse.includes("\u{1F33F}") && fullResponse.includes("Level 2"))
  ) {
    log.info("[fractal-reflection] skipped -- response contains fractal markers");
    return false;
  }

  // Debounce
  if (!checkDebounce(sessionKey, debounceMs)) {
    log.info("[fractal-reflection] skipped -- debounce (fired recently)");
    return false;
  }

  const prompt = loadPrompt(extensionDir);

  // Small delay to let the current response fully flush to the UI
  await new Promise((resolve) => setTimeout(resolve, 2000));

  try {
    // Dynamic import to avoid bundling the full gateway call module at parse time
    const { callGateway } = await import("openclaw/plugin-sdk/testing");

    log.info("[fractal-reflection] sending via sessions.send RPC");

    await callGateway<{ status: string }>({
      method: "sessions.send",
      params: {
        key: sessionKey,
        message: prompt,
      },
      timeoutMs: 120_000,
    });

    log.info("[fractal-reflection] reflection dispatched");
    return true;
  } catch (err) {
    log.info(`[fractal-reflection] failed: ${String(err)}`);
    return false;
  }
}
