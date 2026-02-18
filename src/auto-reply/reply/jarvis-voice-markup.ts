/**
 * Auto-wraps "**Jarvis:**" transcript text in <span class="jarvis-voice"> tags.
 *
 * This enforces the purple italic styling programmatically so it doesn't
 * depend on the LLM remembering to include the span tags.
 *
 * Patterns handled:
 *   **Jarvis:** some text           → **Jarvis:** <span class="jarvis-voice">some text</span>
 *   **Jarvis:** <span ...>text</span> → left unchanged (already wrapped)
 */

const JARVIS_LABEL = /(\*\*Jarvis:\*\*)\s+/gi;
const ALREADY_WRAPPED = /<span\s+class=["']jarvis-voice["']/i;

export function applyJarvisVoiceMarkup(text: string): string {
  if (!text || !JARVIS_LABEL.test(text)) {
    return text;
  }
  // Reset lastIndex after test()
  JARVIS_LABEL.lastIndex = 0;

  // Split on each **Jarvis:** occurrence and wrap the following text
  // until the next **Jarvis:** or end of string.
  return text.replace(
    /(\*\*Jarvis:\*\*)\s+([\s\S]*?)(?=\*\*Jarvis:\*\*|$)/gi,
    (_match, label: string, content: string) => {
      const trimmed = content.trim();
      if (!trimmed) {
        return `${label} `;
      }
      // Already wrapped — leave it alone
      if (ALREADY_WRAPPED.test(trimmed)) {
        return `${label} ${trimmed}`;
      }
      return `${label} <span class="jarvis-voice">${trimmed}</span>`;
    },
  );
}
