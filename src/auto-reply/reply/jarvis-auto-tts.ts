/**
 * Auto-TTS: extracts spoken text from **Jarvis:** lines and plays via local jarvis command.
 * Fire-and-forget — never blocks or fails the reply pipeline.
 *
 * Only triggers for "final" dispatch kind to avoid speaking partial streaming chunks.
 */

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

/** Regex to find **Jarvis:** at line start, followed by spoken text (with optional jarvis-voice span). */
const JARVIS_SPOKEN_RE = /^\*\*Jarvis:\*\*\s*(?:<span class="jarvis-voice">)?\s*(.+?)(?:<\/span>)?$/gm;

/** Deduplicate: track recent spoken texts to avoid re-speaking on retry/resend. */
const recentSpoken = new Map<string, number>();
const DEDUP_TTL_MS = 30_000;

function cleanDedup() {
  const now = Date.now();
  for (const [key, ts] of recentSpoken) {
    if (now - ts > DEDUP_TTL_MS) {
      recentSpoken.delete(key);
    }
  }
}

/**
 * Extract spoken text from a reply payload and play it via the jarvis command.
 * Call this fire-and-forget on final payloads only.
 */
export function triggerJarvisAutoTts(text: string | undefined): void {
  if (!text) return;

  try { appendFileSync("/tmp/jarvis-tts-debug.log", `[${new Date().toISOString()}] INPUT: ${JSON.stringify(text.slice(0, 500))}\n`); } catch {};

  const matches: string[] = [];
  let m: RegExpExecArray | null;

  // Reset lastIndex for global regex
  JARVIS_SPOKEN_RE.lastIndex = 0;
  while ((m = JARVIS_SPOKEN_RE.exec(text)) !== null) {
    const spoken = m[1]?.trim();
    if (spoken) {
      // Strip HTML tags (jarvis-voice spans etc.) for clean speech
      const clean = spoken.replace(/<[^>]+>/g, "").trim();
      if (clean) matches.push(clean);
    }
  }

  try { appendFileSync("/tmp/jarvis-tts-debug.log", `[${new Date().toISOString()}] MATCHES: ${JSON.stringify(matches)}\n`); } catch {};
  if (matches.length === 0) return;

  const combined = matches.join(". ");

  // Dedup check
  cleanDedup();
  const key = combined.slice(0, 200);
  if (recentSpoken.has(key)) return;
  recentSpoken.set(key, Date.now());

  // Fire and forget — detached subprocess so it survives reply completion
  const escaped = combined.replace(/'/g, "'\\''");
  const child = spawn("bash", ["-c", `jarvis '${escaped}'`], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
