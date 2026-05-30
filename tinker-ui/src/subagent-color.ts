// FORK 2026-05-30: shared per-subagent identity color — the SINGLE source of
// truth so a subagent has ONE color everywhere (chat sub-bubble + RECIPES panel
// row + thinking-run row). Extracted from app.ts (where it was local and unused
// by the panel, which is why panel rows and bubbles never matched). Mirrors the
// 🟦🟢🟣🟠🔴🟡🟤 palette Jarvis uses for one-bubble-per-task narration.
export const SUBAGENT_PALETTE = [
  "#3b82f6", // 🟦 blue
  "#22c55e", // 🟢 green
  "#a855f7", // 🟣 purple
  "#f97316", // 🟠 orange
  "#ef4444", // 🔴 red
  "#eab308", // 🟡 yellow
  "#a16207", // 🟤 brown
];

const subagentColorCache = new Map<string, string>();

/** Stable color for a subagent, hashed from its id (runId or sessionKey). The
 *  same id always yields the same palette entry, so the chat bubble and the
 *  RECIPES panel row for one subagent are guaranteed to match. */
export function colorForSubagent(id: string): string {
  const cached = subagentColorCache.get(id);
  if (cached) return cached;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const color = SUBAGENT_PALETTE[h % SUBAGENT_PALETTE.length];
  subagentColorCache.set(id, color);
  return color;
}

/** Short, human-readable tail of a long runId/sessionKey for badges/labels. */
export function shortSubagentId(id: string): string {
  const tail = id.split(/[:/]/).filter(Boolean).pop() ?? id;
  return tail.length > 10 ? tail.slice(0, 10) : tail;
}
