/**
 * Small pure helpers shared by the amygdala HTML builders (Jev window, cards, panel). Every dynamic string that reaches
 * markup goes through `esc`; builders never use inline event handlers, only `data-amy-act` attributes that
 * app.ts handles by delegation.
 */
import type { CodeDid, JevDecision } from "./amygdala-types.js";

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "HH:MM" in the browser's time zone. */
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "HH:MM:SS" in the browser's time zone. */
export function fmtClockS(ts: number): string {
  const d = new Date(ts);
  return `${fmtClock(ts)}:${String(d.getSeconds()).padStart(2, "0")}`;
}

/** "380 ms", "4.2 s", "14 min", "2 min 5 s", "1 h 3 min". */
export function fmtDuration(ms: number): string {
  const v = Math.max(0, Number.isFinite(ms) ? ms : 0);
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)} s`;
  const s = Math.round(v / 1000);
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
  const m = Math.round(s / 60);
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
}

/** "€0.003" (three decimals under a euro, two above). */
export function fmtEur(n: number): string {
  return `€${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
}

/** "4 s ago", "2 min ago", "3 h ago", "never". */
export function fmtAgo(now: number, ts: number | null | undefined): string {
  if (ts === null || ts === undefined || ts <= 0) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** The symbol of what code did with an answer (design block 5b legend). */
export const GLYPH: Record<CodeDid, string> = {
  ok: "▪",
  held: "■",
  proof: "▲",
  note: "▲",
  ask: "?",
  "sent-back": "◀",
  refusal: "◆",
};

/** The word on the pill: what code did with the answer. */
export const DID_WORD: Record<CodeDid, string> = {
  ok: "ok",
  held: "held",
  proof: "proof",
  note: "note",
  ask: "ask",
  "sent-back": "sent back",
  refusal: "refusal",
};

/** An answer as plain text: a probability, a level or the chosen option. Never a question's wording. */
export function fmtAnswer(d: Pick<JevDecision, "answer" | "prob">): string {
  if (typeof d.answer === "number")
    return Number.isInteger(d.answer) ? String(d.answer) : d.answer.toFixed(2);
  if (typeof d.answer === "boolean") return d.answer ? "yes" : "no";
  return String(d.answer);
}
