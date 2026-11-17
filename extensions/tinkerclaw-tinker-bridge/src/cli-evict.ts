/**
 * FORK 2026-11-03 — J1 eviction on the claude-code lane (context-window-panel.md A11, J1 §5).
 *
 * The claude CLI keeps its own transcript and resumes it with `--resume`, so the gateway cannot evict
 * from it (F1). This writes an EVICTED FORK of that transcript under a new session id, in the CLI's own
 * compaction layout: a `compact_boundary` entry with no parent, then an `isCompactSummary` user entry
 * that carries a J1 pointer marker instead of a model-written summary, then the newest SessionStart
 * hook delivery (the moral code and harness context are always-loaded text, never evicted, and our
 * hooks do not fire on `resume`), then copies of the kept turns, the first re-parented onto that.
 *
 * The original file is never modified: it stays the full record the marker points at, and pointing the
 * chat back at it undoes the eviction. A fork and not an append, because the bridge will not resume a
 * transcript over RESUME_MAX_TRANSCRIPT_BYTES (defaults.ts, 8 MB) and chats here reach 49 MB.
 *
 * Verified by hand on a throwaway Haiku session (CLI 2.1.314, 2026-11-03): four turns, the first two
 * evicted, resumed from the fork. The model named only the kept turns' code words, the prompt went from
 * 44,220 to 28,343 tokens, and asked for an evicted code word it grepped the record and found it.
 *
 * It cuts only at a user prompt, so no tool_use is separated from its tool_result. No model call.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ownerWords } from "openclaw/plugin-sdk/fork-prompt-envelope";

/** Same cap rewind uses (tinkerclaw-amygdala rewind.ts): past it the file is not parsed in the gateway. */
export const MAX_EVICT_BYTES = 256 * 1024 * 1024;
/** J1 §5.5's budget for the owner's words in one marker; the newest evicted prompts win. */
const OWNER_WORDS_MAX_CHARS = 6_000;
const OWNER_PROMPT_MAX_CHARS = 600;
const EXACT_STRINGS_MAX = 40;
const EXACT_STRINGS_MAX_CHARS = 3_000;

/** The ladder EVICT already uses on the embedded lane (P11): ceil(chars / 3.5), an estimate. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.5);
}

type Block = Record<string, unknown>;
type Entry = Record<string, unknown> & {
  uuid?: unknown;
  parentUuid?: unknown;
  type?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  timestamp?: unknown;
  message?: { role?: unknown; content?: unknown };
  attachment?: { type?: unknown; hookEvent?: unknown };
};

export type CliEvictResult =
  | {
      ok: true;
      forkPath: string;
      forkSessionId: string;
      evictedPrompts: number;
      keptPrompts: number;
      tokensBefore: number;
      tokensAfter: number;
      evictedTokens: number;
    }
  | { ok: false; reason: string; nothingToDo?: true };

function blocksOf(e: Entry): Block[] {
  const c = e.message?.content;
  return Array.isArray(c) ? c.filter((b): b is Block => !!b && typeof b === "object") : [];
}

/**
 * What an entry adds to the model's context, in characters: user and assistant message content only.
 * Attachments are left out: the transcript also keeps UI-only ones (a prompt snapshot measured 64k
 * characters in a four-turn session), and the CLI re-sends the listings it needs on the next turn.
 */
function sizeOf(e: Entry): number {
  const c = e.type === "user" || e.type === "assistant" ? e.message?.content : undefined;
  if (c === undefined) {
    return 0;
  }
  return typeof c === "string" ? c.length : JSON.stringify(c).length;
}

/** Where a turn starts: a user prompt, not a tool result, a meta line or a compaction summary. */
export function isPromptEntry(e: Entry): boolean {
  if (
    e.type !== "user" ||
    e.isMeta === true ||
    e.isCompactSummary === true ||
    e.isSidechain === true
  ) {
    return false;
  }
  const c = e.message?.content;
  if (typeof c === "string") {
    return c.trim() !== "";
  }
  const b = blocksOf(e);
  return b.some((x) => x.type === "text") && !b.some((x) => x.type === "tool_result");
}

function textOf(e: Entry): string {
  const c = e.message?.content;
  if (typeof c === "string") {
    return c;
  }
  return blocksOf(e)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

function isSessionStartDelivery(e: Entry): boolean {
  return (
    e.type === "attachment" &&
    e.attachment?.type === "hook_additional_context" &&
    e.attachment?.hookEvent === "SessionStart"
  );
}

/** The chain the CLI resumes: from the newest main-chain entry back through parentUuid. */
function mainChain(entries: Entry[]): Entry[] {
  const byId = new Map<string, Entry>();
  for (const e of entries) {
    if (typeof e.uuid === "string") {
      byId.set(e.uuid, e);
    }
  }
  let cur: Entry | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (typeof entries[i].uuid === "string" && entries[i].isSidechain !== true) {
      cur = entries[i];
      break;
    }
  }
  const chain: Entry[] = [];
  const seen = new Set<string>();
  while (cur && typeof cur.uuid === "string" && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    chain.push(cur);
    cur = typeof cur.parentUuid === "string" ? byId.get(cur.parentUuid) : undefined;
  }
  return chain.toReversed();
}

const EXACT_STRING_RES = [
  /https?:\/\/[^\s"'<>`)\]]+/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
  /(?<![\w-])[0-9a-f]{7,40}(?![\w-])/g,
  /(?:~|(?<![\w.])\/)(?:[\w.@+-]+\/)+[\w.@+-]+/g,
];

/** J1 §5.1 item 3: paths, URLs, ids and hashes in the evicted range, most used first. */
function exactStrings(texts: string[]): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const re of EXACT_STRING_RES) {
      for (const m of text.matchAll(re)) {
        const s = m[0].replace(/[.,;:]+$/, "");
        const hexOnly = /^[0-9a-f]+$/.test(s);
        if (s.length < 6 || (hexOnly && !(/[0-9]/.test(s) && /[a-f]/.test(s)))) {
          continue;
        }
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
    }
  }
  const out: string[] = [];
  let chars = 0;
  for (const [s] of [...counts].toSorted((a, b) => b[1] - a[1])) {
    if (out.length >= EXACT_STRINGS_MAX || chars + s.length > EXACT_STRINGS_MAX_CHARS) {
      break;
    }
    out.push(s);
    chars += s.length;
  }
  return out;
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** J1 §5.1's marker, the parts code can write: range, pointer, the owner's words, exact strings. */
export function renderEvictionMarker(o: {
  recordPath: string;
  evictedPrompts: number;
  firstAt?: string;
  lastAt?: string;
  ownerPrompts: string[];
  exact: string[];
  recallHint: boolean;
}): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = o.ownerPrompts.length - 1; i >= 0; i--) {
    const line = oneLine(o.ownerPrompts[i], OWNER_PROMPT_MAX_CHARS);
    if (used + line.length > OWNER_WORDS_MAX_CHARS) {
      break;
    }
    kept.unshift(line);
    used += line.length;
  }
  const omitted = o.ownerPrompts.length - kept.length;
  const span = o.firstAt && o.lastAt ? ` (${o.firstAt} to ${o.lastAt})` : "";
  const lines = [
    '<context_eviction source="tinker-bridge">',
    `Turns 1 to ${o.evictedPrompts} of this conversation${span} were evicted from the context to make room. They were not summarised. Every message is still on disk, word for word, in the full record:`,
    o.recordPath,
    `It is JSONL, one entry per line. When you need an exact earlier detail (a path, a command, an error, what the user said), search it, for example grep -n "<string>" "${o.recordPath}", instead of guessing.${o.recallHint ? " In a TinkerClaw chat the recall tool also searches the gateway's copy of this conversation." : ""}`,
  ];
  if (kept.length > 0) {
    lines.push(
      "",
      `The user's words in the evicted turns, verbatim, oldest first${omitted > 0 ? ` (${omitted} earlier ones are only in the record)` : ""}${kept.some((l) => l.endsWith("…")) ? "; long ones are cut" : ""}:`,
      ...kept.map((l) => `- ${l}`),
    );
  }
  if (o.exact.length > 0) {
    lines.push(
      "",
      "Exact strings from the evicted turns, most used first:",
      ...o.exact.map((s) => `- ${s}`),
    );
  }
  lines.push("</context_eviction>");
  return lines.join("\n");
}

/**
 * Write an evicted fork of the transcript at `srcPath` next to it, keeping the newest turns whose size
 * fits `keepFraction` of the conversation (at least the last turn) and evicting every older one.
 * Never modifies `srcPath`. `newId` and `now` are injectable for tests.
 */
export function forkEvictedTranscript(
  srcPath: string,
  o: { keepFraction: number; newId?: string; now?: Date; recallHint?: boolean },
): CliEvictResult {
  let size: number;
  try {
    size = fs.statSync(srcPath).size;
  } catch {
    return { ok: false, reason: "the Claude Code transcript of this chat is not on disk" };
  }
  if (size > MAX_EVICT_BYTES) {
    return { ok: false, reason: "the Claude Code transcript is too large to evict" };
  }
  const entries: Entry[] = [];
  for (const line of fs.readFileSync(srcPath, "utf-8").split("\n")) {
    if (!line) {
      continue;
    }
    try {
      const e = JSON.parse(line) as unknown;
      if (e && typeof e === "object" && !Array.isArray(e)) {
        entries.push(e as Entry);
      }
    } catch {
      // a garbled line is not part of the chain the CLI resumes
    }
  }
  const chain = mainChain(entries);
  const prompts = chain.flatMap((e, i) => (isPromptEntry(e) ? [i] : []));
  if (prompts.length < 2) {
    return {
      ok: false,
      nothingToDo: true,
      reason: "the conversation has one turn, so there is nothing older to evict",
    };
  }
  const sizes = chain.map(sizeOf);
  const suffix = Array.from({ length: chain.length + 1 }, () => 0);
  for (let i = chain.length - 1; i >= 0; i--) {
    suffix[i] = suffix[i + 1] + sizes[i];
  }
  const total = suffix[0];
  const fraction = Math.min(1, Math.max(0, o.keepFraction));
  // The oldest prompt whose turns fit the fraction keeps the most; none fits: keep only the last turn.
  const head =
    prompts.slice(1).find((p) => suffix[p] <= fraction * total) ?? prompts[prompts.length - 1];
  const evicted = chain.slice(0, head);
  const kept = chain.slice(head);
  const evictedPromptEntries = evicted.filter(isPromptEntry);

  const ownerPrompts = evictedPromptEntries.flatMap((e) => {
    const w = ownerWords(textOf(e));
    return w ? [w] : [];
  });
  const exactSources = evicted.flatMap((e) => {
    if (isPromptEntry(e)) {
      return [ownerWords(textOf(e)) ?? ""];
    }
    if (e.type === "user" && e.isCompactSummary === true) {
      return [textOf(e)];
    }
    if (e.type === "assistant") {
      return blocksOf(e).map((b) =>
        b.type === "text" && typeof b.text === "string"
          ? b.text
          : b.type === "tool_use"
            ? JSON.stringify(b.input ?? "")
            : "",
      );
    }
    return [];
  });
  const stamp = (e: Entry | undefined) =>
    typeof e?.timestamp === "string" ? e.timestamp : undefined;
  const marker = renderEvictionMarker({
    recordPath: srcPath,
    evictedPrompts: evictedPromptEntries.length,
    firstAt: stamp(evictedPromptEntries[0]),
    lastAt: stamp(evicted[evicted.length - 1]),
    ownerPrompts,
    exact: exactStrings(exactSources),
    recallHint: o.recallHint === true,
  });

  const forkId = o.newId ?? randomUUID();
  const now = (o.now ?? new Date()).toISOString();
  const leaf = chain[chain.length - 1];
  const common: Record<string, unknown> = { sessionId: forkId };
  for (const k of ["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"]) {
    if (leaf[k] !== undefined) {
      common[k] = leaf[k];
    }
  }
  const boundaryId = randomUUID();
  const markerId = randomUUID();
  const out: Entry[] = [
    {
      parentUuid: null,
      logicalParentUuid: evicted[evicted.length - 1].uuid,
      isSidechain: false,
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      isMeta: false,
      timestamp: now,
      uuid: boundaryId,
      level: "info",
      compactMetadata: { trigger: "manual", preTokens: estimateTokens(total) },
      ...common,
    },
    {
      parentUuid: boundaryId,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: marker },
      isVisibleInTranscriptOnly: true,
      isCompactSummary: true,
      uuid: markerId,
      timestamp: now,
      ...common,
    },
  ];
  let delivery: Entry | undefined;
  if (!kept.some(isSessionStartDelivery)) {
    for (let i = evicted.length - 1; i >= 0 && !delivery; i--) {
      delivery = isSessionStartDelivery(evicted[i]) ? evicted[i] : undefined;
    }
  }
  // Each kept entry already pointed at the one before it in the chain, so linking every entry to the
  // one written before it keeps the chain and moves only the first onto the marker (or the delivery).
  for (const e of [...(delivery ? [delivery] : []), ...kept]) {
    out.push({ ...e, sessionId: forkId, parentUuid: out[out.length - 1].uuid });
  }

  const forkPath = path.join(path.dirname(srcPath), `${forkId}.jsonl`);
  const tmp = `${forkPath}.tmp`;
  fs.writeFileSync(tmp, out.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
  fs.renameSync(tmp, forkPath);
  const keptChars = suffix[head] + marker.length + (delivery ? sizeOf(delivery) : 0);
  return {
    ok: true,
    forkPath,
    forkSessionId: forkId,
    evictedPrompts: evictedPromptEntries.length,
    keptPrompts: prompts.length - evictedPromptEntries.length,
    tokensBefore: estimateTokens(total),
    tokensAfter: estimateTokens(keptChars),
    evictedTokens: estimateTokens(total - suffix[head]),
  };
}
