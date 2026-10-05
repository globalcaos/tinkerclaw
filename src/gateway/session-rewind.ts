/**
 * FORK 2026-09-30: Rewind for tabs on the built-in runner (Grok, GPT, …). Claude Code tabs rewind through the
 * amygdala's copy of the Claude transcript (extensions/tinkerclaw-amygdala/src/rewind.ts); this is the same move
 * for an OpenClaw session file.
 *
 * A session file is an append-only tree. Rewinding writes a NEW session file holding the path from the root to the
 * reply before the last user prompt, and the tab is pointed at it (`sessions.rewind`). The original file is never
 * modified, so Undo points the tab back. Each prompt is preceded by its own `custom` marker entry (the prompt key),
 * so the branch point walks up past those markers to the reply before them.
 */
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";

export interface BranchResult {
  ok: boolean;
  reason?: string;
  sessionFile?: string;
  sessionId?: string;
  /** The removed prompt, cleaned for the composer. */
  restoredPrompt?: string;
}

type Entry = {
  id?: string;
  type?: string;
  parentId?: string | null;
  message?: { role?: string; content?: unknown };
};

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      c && typeof c === "object" && (c as { type?: unknown }).type === "text"
        ? String((c as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

/** Blocks the chat appends after the user's words; they never go back into the composer. */
const APPENDED_BLOCKS = [
  /\n\s*-{3,}\s*\n+\s*\*\*After your reply, append a 🌿 FRACTAL/,
  /\n\s*<!-- TINKERCLAW chat-row contract -->/,
];

/** The user's words: no `[Tue … GMT+2]` or `⟦…⟧` prefix, no appended blocks. */
export function composerText(raw: string): string {
  let s = raw;
  for (const re of APPENDED_BLOCKS) {
    const m = re.exec(s);
    if (m) s = s.slice(0, m.index);
  }
  for (;;) {
    const next = s
      .replace(/^\s*\[(?:Day\b|[A-Z][a-z]{2}\b)[^\]\n]*\]\s*/, "")
      .replace(/^\s*⟦[^⟧]*⟧\s*/, "");
    if (next === s) return s.trim();
    s = next;
  }
}

/** Write the branch that ends before the last user prompt as a new session file. The source is not modified. */
export function branchBeforeLastPrompt(sourceFile: string): BranchResult {
  const sm = SessionManager.open(sourceFile, path.dirname(sourceFile));
  const branch = sm.getBranch() as Entry[];
  let last: Entry | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e?.type === "message" && e.message?.role === "user") {
      last = e;
      break;
    }
  }
  if (!last) return { ok: false, reason: "nothing to rewind: the session has no user message" };
  let at = last.parentId ?? null;
  while (at) {
    const e = sm.getEntry(at) as Entry | undefined;
    if (!e || e.type !== "custom") break;
    at = e.parentId ?? null;
  }
  if (!at) return { ok: false, reason: "the first prompt of a session cannot be rewound" };
  const file = sm.createBranchedSession(at);
  if (!file) return { ok: false, reason: "could not write the branched session" };
  return {
    ok: true,
    sessionFile: file,
    sessionId: sm.getSessionId(),
    restoredPrompt: composerText(messageText(last.message?.content)),
  };
}
