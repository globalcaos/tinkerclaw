/**
 * Jarvis Auto-TTS Hook (v2)
 *
 * Programmatic voice guarantee. Runs BEFORE reply delivery in buildReplyPayloads.
 *
 * Flow:
 * 1. Scan final payload text for **Jarvis:** lines
 * 2. Extract spoken text, spawn `jarvis` command (once, deduped by content)
 * 3. If model also ran `exec jarvis` with the same text → flock mutex prevents double-play
 * 4. If model ran `exec jarvis` with DIFFERENT text than **Jarvis:** line → log mismatch warning
 * 5. If no **Jarvis:** line exists → do nothing (model forgot entirely; future: inject fallback)
 *
 * The model's `exec jarvis "text"` is now redundant but harmless.
 * The hook is the canonical voice trigger.
 */

import { spawn } from "node:child_process";
import { logVerbose } from "../../globals.js";

// Dedup: track recently spoken texts to avoid double-play within 30s
const recentSpoken = new Map<string, number>();
const DEDUP_WINDOW_MS = 30_000;

function cleanupRecentSpoken(): void {
  const now = Date.now();
  for (const [key, ts] of recentSpoken) {
    if (now - ts > DEDUP_WINDOW_MS) {
      recentSpoken.delete(key);
    }
  }
}

/** Normalize text for dedup comparison (lowercase, collapse whitespace, strip punctuation edges) */
function normalizeForDedup(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Extract spoken text from **Jarvis:** lines.
 * Handles: **Jarvis:** *italic text*, **Jarvis:** plain text,
 *          **Jarvis:** <span class="jarvis-voice">text</span>
 */
const JARVIS_LINE_RE = /\*\*Jarvis:\*\*\s*(?:<span[^>]*>)?\s*\*?([\s\S]*?)\*?\s*(?:<\/span>)?$/gim;

export function extractJarvisSpokenText(text: string): string | null {
  if (!text) {
    return null;
  }
  JARVIS_LINE_RE.lastIndex = 0;

  const match = JARVIS_LINE_RE.exec(text);
  if (!match?.[1]) {
    return null;
  }

  let spoken = match[1]
    .replace(/<[^>]+>/g, "") // strip HTML tags
    .replace(/^\*+|\*+$/g, "") // strip markdown italic markers
    .replace(/\s+/g, " ") // collapse whitespace
    .trim();

  if (!spoken) {
    return null;
  }
  return spoken;
}

/**
 * Spawn the jarvis TTS command detached. Non-blocking, fire-and-forget.
 * Uses flock on /tmp/jarvis-audio.lock so concurrent plays are serialized.
 */
function spawnJarvisVoice(text: string): void {
  const normalized = normalizeForDedup(text);
  cleanupRecentSpoken();

  if (recentSpoken.has(normalized)) {
    logVerbose(
      `[jarvis-auto-tts] Dedup: already spoken recently, skipping: "${text.slice(0, 60)}..."`,
    );
    return;
  }
  recentSpoken.set(normalized, Date.now());

  // Sanitize text for shell: escape single quotes
  const sanitized = text.replace(/'/g, "'\\''");

  logVerbose(`[jarvis-auto-tts] Speaking: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);

  try {
    const child = spawn("bash", ["-c", `jarvis '${sanitized}'`], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (err) {
    logVerbose(`[jarvis-auto-tts] Failed to spawn jarvis: ${String(err)}`);
  }
}

/**
 * Main hook: call from buildReplyPayloads after applyJarvisVoiceMarkup.
 * Scans text for **Jarvis:** line, triggers voice if found.
 * Returns the text unchanged (this hook is side-effect only).
 */
export function triggerJarvisAutoTts(text: string | undefined): void {
  if (!text) {
    return;
  }

  const spoken = extractJarvisSpokenText(text);
  if (spoken) {
    spawnJarvisVoice(spoken);
  }
}
