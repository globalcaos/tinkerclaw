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

  // Extract the LAST assistant message only (not full history — checking all
  // messages causes permanent self-detection block when any prior turn had 🌿)
  let fullResponse = "";
  if (messages) {
    for (let i = (messages as unknown[]).length - 1; i >= 0; i--) {
      const msg = (messages as unknown[])[i];
      if (!msg || typeof msg !== "object") {continue;}
      const m = msg as Record<string, unknown>;
      if (m.role !== "assistant") {continue;}
      const texts: string[] = [];
      if (typeof m.content === "string") {
        texts.push(m.content);
      } else if (Array.isArray(m.content)) {
        for (const block of m.content as Array<Record<string, unknown>>) {
          if (block.type === "text" && typeof block.text === "string") {
            texts.push(block.text);
          }
        }
      }
      if (texts.length > 0) {
        fullResponse = texts.join("\n").trim();
        break; // only the last assistant message
      }
    }
  }

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
    log.info("[fractal-reflection] skipped -- response contains fractal markers (self-detection)");
    return false;
  }

  // Skip if the run was triggered BY a fractal prompt (check user messages for the prompt)
  if (messages) {
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") {continue;}
      const m = msg as Record<string, unknown>;
      if (m.role !== "user") {continue;}
      const userText =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? (((m.content as Array<Record<string, unknown>>).find(
                (b) => b.type === "text" && typeof b.text === "string",
              )?.text as string) ?? "")
            : "";
      if (userText.trimStart().startsWith("# FRACTAL REFLECTION")) {
        log.info(
          "[fractal-reflection] skipped -- run was triggered by fractal prompt (loop prevention)",
        );
        return false;
      }
    }
  }

  // Debounce
  if (!checkDebounce(sessionKey, debounceMs)) {
    log.info("[fractal-reflection] skipped -- debounce (fired recently)");
    return false;
  }

  const prompt = loadPrompt(extensionDir);

  // Brief wait to let the main turn's final events drain. With sessions.steer
  // (below) we then interrupt any lingering active-run registry entry — this
  // is the only reliable way to avoid ReplyRunAlreadyActiveError when the
  // session-lane unwind trails the provider-side `done` event (seen with the
  // cc-bridge persistent-subprocess provider, among others).
  await new Promise((resolve) => setTimeout(resolve, 1500));

  try {
    // Dynamic import to avoid bundling the full gateway call module at parse time
    const { callGateway } = await import("openclaw/plugin-sdk/testing");

    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      log.info(
        `[fractal-reflection] sending via sessions.steer RPC (attempt ${attempt}/${maxAttempts})`,
      );
      try {
        const response = await callGateway<Record<string, unknown>>({
          method: "sessions.steer",
          params: {
            key: sessionKey,
            message: prompt,
          },
          timeoutMs: 120_000,
        });
        // sessions.steer returns the gateway's reply to the new turn. When the
        // reply-run-registry still has the main turn's just-finished operation,
        // the handler catches ReplyRunAlreadyActiveError and returns a banner
        // payload AS the reply (not as an RPC error). We detect that payload
        // and retry until the lane truly idles.
        const responseText =
          typeof (response as { text?: unknown })?.text === "string"
            ? ((response as { text: string }).text ?? "")
            : JSON.stringify(response ?? "");
        const bannerMatch =
          /Previous run is still shutting down/i.test(responseText) ||
          /Reply run already active/i.test(responseText);
        if (bannerMatch) {
          if (attempt === maxAttempts) {
            log.info(
              `[fractal-reflection] lane stayed busy across ${maxAttempts} attempts; giving up`,
            );
            return false;
          }
          const backoffMs = 2000 + attempt * 500;
          log.info(
            `[fractal-reflection] banner reply detected, retrying in ${backoffMs}ms (attempt ${attempt}/${maxAttempts})`,
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        log.info("[fractal-reflection] reflection dispatched");
        return true;
      } catch (err) {
        const msg = String(err ?? "");
        const isBusy =
          /Reply run already active/i.test(msg) ||
          /Previous run is still shutting down/i.test(msg) ||
          /reply-run-registry still active/i.test(msg) ||
          /errorCode=UNAVAILABLE/i.test(msg);
        if (!isBusy || attempt === maxAttempts) {
          log.info(`[fractal-reflection] failed: ${msg}`);
          return false;
        }
        const backoffMs = 2000 + attempt * 500;
        log.info(
          `[fractal-reflection] lane busy (RPC error), retrying in ${backoffMs}ms (attempt ${attempt}/${maxAttempts})`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
    return false;
  } catch (err) {
    log.info(`[fractal-reflection] failed: ${String(err)}`);
    return false;
  }
}
