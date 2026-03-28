/**
 * FORK: Fractal Reflection v4 — Session Inject via Gateway RPC
 *
 * After each interactive turn, injects the fractal reflection prompt
 * into the session using callGateway("sessions.send"). This is the same
 * path as sessions_send tool / inter-session messaging — fully supported,
 * properly routed, visible in webchat.
 *
 * No heartbeat runner abuse. No CLI shell escaping. No custom delivery routing.
 * Just the standard sessions.send RPC with the fractal prompt as the message.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Candidate paths for the fractal prompt */
const FRACTAL_PROMPT_PATHS = [
  join(process.cwd(), "src/fork/fractal-prompt.md"),
  join(process.env.HOME ?? "/tmp", ".openclaw/workspace/src/fork/fractal-prompt.md"),
];

let _promptCache: string | null = null;

/** Clear cache to pick up prompt edits without restart */
export function clearPromptCache(): void {
  _promptCache = null;
}

function loadPrompt(): string {
  if (_promptCache) {
    return _promptCache;
  }
  for (const p of FRACTAL_PROMPT_PATHS) {
    try {
      _promptCache = readFileSync(p, "utf-8").trim();
      return _promptCache;
    } catch {
      /* try next */
    }
  }
  _promptCache =
    "FRACTAL REFLECTION: Reflect on the previous turn. What pattern does it belong to?";
  return _promptCache;
}

/** Sessions that should NOT get fractal reflection */
function isAutomatedSession(sessionKey: string): boolean {
  return (
    sessionKey.includes("subagent:") ||
    sessionKey.includes("isolated:") ||
    sessionKey.includes("cron:") ||
    sessionKey.includes("heartbeat")
  );
}

/** Debounce: track last injection time per session to prevent multiple fires */
const lastInjectionTime = new Map<string, number>();
const DEBOUNCE_MS = 30_000; // 30 seconds between fractal fires per session

export interface FractalInjectParams {
  sessionKey: string;
  assistantTexts: string[];
  log: { info: (msg: string) => void };
}

/**
 * Inject a fractal reflection into the session via gateway RPC.
 * This uses the same path as the sessions_send tool.
 */
export async function injectFractalReflection(params: FractalInjectParams): Promise<void> {
  const { sessionKey, assistantTexts, log } = params;

  if (!sessionKey) {
    return;
  }

  // Skip automated sessions
  if (isAutomatedSession(sessionKey)) {
    log.info("[fractal-inject] skipped — automated session");
    return;
  }

  // Skip silent replies
  const fullResponse = assistantTexts.join("\n").trim();
  if (fullResponse === "NO_REPLY" || fullResponse === "HEARTBEAT_OK") {
    log.info("[fractal-inject] skipped — silent reply");
    return;
  }

  // Debounce: skip if we already injected recently for this session
  const lastTime = lastInjectionTime.get(sessionKey) ?? 0;
  if (Date.now() - lastTime < DEBOUNCE_MS) {
    log.info("[fractal-inject] skipped — debounce (fired recently)");
    return;
  }

  // Skip if response is already a fractal reflection (prevent infinite loop)
  if (
    fullResponse.startsWith("🌿 FRACTAL:") ||
    (fullResponse.includes("🌿") && fullResponse.includes("Level 2"))
  ) {
    log.info("[fractal-inject] skipped — response contains fractal markers");
    return;
  }

  const prompt = loadPrompt();

  // Small delay to let the current response fully flush to the UI
  await new Promise((resolve) => setTimeout(resolve, 2000));

  try {
    // Dynamic import to avoid circular dependency
    const { callGateway } = await import("../gateway/call.js");

    log.info("[fractal-inject] sending via sessions.send RPC");
    lastInjectionTime.set(sessionKey, Date.now());

    await callGateway<{ status: string }>({
      method: "sessions.send",
      params: {
        key: sessionKey, // RPC uses 'key', not 'sessionKey'
        message: prompt,
      },
      timeoutMs: 120_000, // fractal reflection may take a while with Opus
    });

    log.info("[fractal-inject] fractal reflection dispatched");
  } catch (err) {
    log.info(`[fractal-inject] failed: ${String(err)}`);
  }
}
