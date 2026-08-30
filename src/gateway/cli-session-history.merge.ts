import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { normalizeOptionalString, readStringValue } from "../shared/string-coerce.js";

const DEDUPE_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

// FORK 2026-07-28 — PER-MESSAGE MEMOISATION. This is the single hottest path in chat.history.
//
// The merge below is `for (imported) { merged.some((existing) => isEquivalent(existing, imported)) }`
// with `merged` GROWING as imports are appended — quadratic by construction. That is tolerable;
// what was not is that every pair re-derived BOTH sides' comparable text from scratch, joining and
// whitespace-collapsing strings up to 28 KB, with no caching. Measured on a real transcript:
// 1,587,479 pair comparisons drove 1,785,742 extraction calls over 1,911 messages = 8,576 ms.
// Extracting once per message instead: 59.6 ms — a 144x reduction, and the live p90 for
// chat.history was 5,947 ms with a 20,283 ms max, which is what made tab switching feel broken.
//
// A WeakMap keyed on the message object is safe here: these are plain parsed-JSON objects that
// live only for the duration of one merge, the derivation is pure, and nothing mutates a message
// between comparisons. Memoising does NOT change any decision — identical inputs, identical
// outputs, just computed once. The quadratic shape is left alone deliberately: it is not the cost
// driver at these sizes, and changing the comparison order risks the dedup semantics that four
// separate FORK comments in this file were written to protect.
const comparableTextCache = new WeakMap<object, string | undefined>();
const comparableRoleCache = new WeakMap<object, string | undefined>();
const importedExternalIdCache = new WeakMap<object, string | undefined>();

function memoised<T>(
  cache: WeakMap<object, T | undefined>,
  message: unknown,
  compute: () => T | undefined,
): T | undefined {
  if (!message || typeof message !== "object") {
    return compute();
  }
  const key = message as object;
  if (cache.has(key)) {
    return cache.get(key);
  }
  const value = compute();
  cache.set(key, value);
  return value;
}

function extractComparableText(message: unknown): string | undefined {
  return memoised(comparableTextCache, message, () => extractComparableTextUncached(message));
}

function extractComparableTextUncached(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as { role?: unknown; text?: unknown; content?: unknown };
  const role = readStringValue(record.role);
  const parts: string[] = [];
  const text = readStringValue(record.text);
  if (text !== undefined) {
    parts.push(text);
  }
  const content = readStringValue(record.content);
  if (content !== undefined) {
    parts.push(content);
  } else if (Array.isArray(record.content)) {
    for (const block of record.content) {
      if (block && typeof block === "object" && "text" in block) {
        const blockText = readStringValue(block.text);
        if (blockText !== undefined) {
          parts.push(blockText);
        }
      }
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  const joined = parts.join("\n").trim();
  if (!joined) {
    return undefined;
  }
  let visible = role === "user" ? stripInboundMetadata(joined) : joined;
  // FORK 2026-06-20: cc-bridge appends "<!-- TINKERCLAW … -->" narration-contract
  // blocks to every user message before forwarding to claude-cli. The JSONL therefore
  // stores a longer version of each user message than the OpenClaw local session file,
  // causing the role+text dedup to always fail (different strings → no match → both
  // copies land in the merged result and the UI shows the prompt twice).
  // Truncate at the first HTML-comment boundary so both sides normalize to the same
  // user-visible text regardless of which injected suffix each store carries.
  if (role === "user") {
    const htmlInjectionStart = visible.indexOf("\n<!--");
    if (htmlInjectionStart !== -1) {
      visible = visible.slice(0, htmlInjectionStart);
    }
  }
  const normalized = visible.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function resolveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveComparableTimestamp(message: unknown): number | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  return resolveFiniteNumber((message as { timestamp?: unknown }).timestamp);
}

// FORK 2026-08-05 — SORT-ONLY timestamp resolution. Some stores keep `timestamp` as an
// ISO string rather than epoch ms. Accept that form HERE ONLY: resolveComparableTimestamp
// also feeds the dedup window (isEquivalentImportedMessage), where a missing timestamp is
// deliberately treated as "equivalent", so widening it there would silently change which
// messages collapse. Ordering is a separate question from identity.
function resolveSortTimestamp(message: unknown): number | undefined {
  const numeric = resolveComparableTimestamp(message);
  if (numeric !== undefined) {
    return numeric;
  }
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const raw = (message as { timestamp?: unknown }).timestamp;
  if (typeof raw !== "string") {
    return undefined;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

type HistoryMergeEntry = { message: unknown; order: number; sortTimestamp?: number };

// FORK 2026-08-05 — POSITIONAL FALLBACK FOR UNTIMESTAMPED MESSAGES.
// compareHistoryMessages sorts a message with no resolvable timestamp AFTER every
// timestamped one. The claude-cli importer OMITS `timestamp` entirely whenever the JSONL
// entry carries none it can parse (cli-session-history.claude.ts spreads
// `...(timestamp !== undefined ? { timestamp } : {})`), so those messages were dragged to
// the very tail of the served transcript. Live symptom: the LAST user message in a served
// history was not the prompt the user typed last.
//
// An unknown timestamp is not "infinitely late", it is UNKNOWN. The only honest information
// left is the message's POSITION in the array it arrived in. So each untimestamped entry
// inherits the timestamp of the nearest timestamped entry BEFORE it in its own source
// segment (forward carry) or, failing that, the nearest one AFTER it (backward fill).
// `order` still breaks ties, so an inherited timestamp reproduces source order exactly
// instead of jumping to the end. If a whole segment has no timestamps at all there is
// nothing to inherit, its entries keep `undefined`, and the old undefined-sorts-last rule
// applies — which for that segment is identical to plain `order`.
function assignPositionalSortTimestamps(segment: HistoryMergeEntry[]): void {
  let carried: number | undefined;
  for (const entry of segment) {
    const own = resolveSortTimestamp(entry.message);
    if (own !== undefined) {
      carried = own;
    }
    entry.sortTimestamp = own ?? carried;
  }
  let upcoming: number | undefined;
  for (let index = segment.length - 1; index >= 0; index -= 1) {
    const entry = segment[index];
    if (!entry) {
      continue;
    }
    if (entry.sortTimestamp !== undefined) {
      upcoming = entry.sortTimestamp;
      continue;
    }
    entry.sortTimestamp = upcoming;
  }
}

function resolveComparableRole(message: unknown): string | undefined {
  return memoised(comparableRoleCache, message, () => {
    if (!message || typeof message !== "object") {
      return undefined;
    }
    return readStringValue((message as { role?: unknown }).role);
  });
}

function resolveImportedExternalId(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const meta =
    "__openclaw" in message &&
    (message as { __openclaw?: unknown }).__openclaw &&
    typeof (message as { __openclaw?: unknown }).__openclaw === "object"
      ? ((message as { __openclaw?: Record<string, unknown> }).__openclaw ?? {})
      : undefined;
  return normalizeOptionalString(meta?.externalId);
}

// FORK 2026-05-26 (task-mpkw1a0b-9jsfy): long-text dedup threshold.
// Messages with text shorter than this fall back to the 5-min
// timestamp window (so legit short repeats — "yes", "ok", "done"
// — aren't collapsed). Messages at or above this length are
// considered effectively unique by content, and any same-role text
// match is taken as a re-import regardless of timestamp distance.
// Hit on the duplicate-prompt bug: cli-session jsonl + local
// sessionFile both held the same user prompts, but timestamps
// differed by hours across tinker-bridge respawns, so the 5-min window
// failed for every long historical message and chat.history
// returned the entire conversation twice.
const LONG_TEXT_DEDUP_MIN_LEN = 50;

function isEquivalentImportedMessage(existing: unknown, imported: unknown): boolean {
  const importedExternalId = resolveImportedExternalId(imported);
  if (importedExternalId && resolveImportedExternalId(existing) === importedExternalId) {
    return true;
  }

  const existingRole = resolveComparableRole(existing);
  const importedRole = resolveComparableRole(imported);
  if (!existingRole || existingRole !== importedRole) {
    return false;
  }

  const existingText = extractComparableText(existing);
  const importedText = extractComparableText(imported);
  if (!existingText || !importedText) {
    return false;
  }
  if (existingText !== importedText) {
    // FORK 2026-06-22: claude-cli records an assistant turn's LEADING text segment
    // (the narration emitted before the turn's first tool call, stop_reason:"tool_use")
    // as a standalone JSONL entry, while the local OpenClaw session coalesces the whole
    // turn into ONE assistant message that BEGINS with that same narration. The imported
    // segment is therefore a strict PREFIX of the local message — never text-equal — so it
    // slips past the equality check and renders as a duplicated, thinking-less echo of the
    // answer (the recurring "I see my answer twice" report). Dedup an imported ASSISTANT
    // message whose visible text is a strict prefix of a LONGER existing message. Direction
    // is one-way: we only drop the shorter import (local always carries the full coalesced
    // turn), never the fuller text. Min-length guard avoids collapsing legit short repeats
    // ("ok", "done"); user messages are excluded — "ok" vs "ok do it" are distinct prompts.
    if (
      importedRole === "assistant" &&
      importedText.length >= LONG_TEXT_DEDUP_MIN_LEN &&
      importedText.length < existingText.length &&
      existingText.startsWith(importedText)
    ) {
      return true;
    }
    return false;
  }

  // FORK 2026-05-26: long matched text → unconditional dedup. Short
  // matched text falls through to the original timestamp-window logic
  // below so legit short repeats survive.
  if (existingText.length >= LONG_TEXT_DEDUP_MIN_LEN) {
    return true;
  }

  const existingTimestamp = resolveComparableTimestamp(existing);
  const importedTimestamp = resolveComparableTimestamp(imported);
  if (existingTimestamp === undefined || importedTimestamp === undefined) {
    return true;
  }

  return Math.abs(existingTimestamp - importedTimestamp) <= DEDUPE_TIMESTAMP_WINDOW_MS;
}

function compareHistoryMessages(a: HistoryMergeEntry, b: HistoryMergeEntry): number {
  const aTimestamp = a.sortTimestamp;
  const bTimestamp = b.sortTimestamp;
  if (aTimestamp !== undefined && bTimestamp !== undefined && aTimestamp !== bTimestamp) {
    return aTimestamp - bTimestamp;
  }
  if (aTimestamp !== undefined && bTimestamp === undefined) {
    return -1;
  }
  if (aTimestamp === undefined && bTimestamp !== undefined) {
    return 1;
  }
  return a.order - b.order;
}

// FORK 2026-06-22: When local messages are present, the JSONL spans the entire
// cc-bridge worker's lifetime — often several compaction cycles and multiple gateway
// restarts. Each restart spawns a fresh cc-bridge instance that re-answers already-
// covered prompts, so the JSONL accumulates hundreds of assistant messages that are
// NOT text-equivalent to local (different spawn → different wording), all of which
// pass the text-dedup check and flood into the merged history.
//
// Two-layer defence:
//   1. Timestamp floor: drop any imported message whose timestamp predates the
//      local session's earliest message by more than IMPORT_PREHISTORY_GRACE_MS.
//      This excludes pre-compaction history that the local session never saw.
//   2. Assistant-slot coverage: if local already has an assistant message within
//      ASSISTANT_SLOT_COVER_MS of an imported assistant message, the import is a
//      redundant spawn response — suppress it even when the texts differ.
//      User-role messages are intentionally left to text-dedup only (we still
//      want to pull in cc-bridge gateway injections like "Continue from where you
//      left off." for context continuity).
const IMPORT_PREHISTORY_GRACE_MS = 15 * 60 * 1000; // 15 min before first local msg
const ASSISTANT_SLOT_COVER_MS = 5 * 60 * 1000; // 5 min around each local assistant

export function mergeImportedChatHistoryMessages(params: {
  localMessages: unknown[];
  importedMessages: unknown[];
}): unknown[] {
  if (params.importedMessages.length === 0) {
    return params.localMessages;
  }

  let filteredImports = params.importedMessages;
  if (params.localMessages.length > 0) {
    // --- layer 1: timestamp floor ---
    let localTsMin = Infinity;
    for (const msg of params.localMessages) {
      const ts = resolveComparableTimestamp(msg);
      if (ts !== undefined && ts < localTsMin) {
        localTsMin = ts;
      }
    }
    const importFloor = Number.isFinite(localTsMin)
      ? localTsMin - IMPORT_PREHISTORY_GRACE_MS
      : -Infinity;

    // --- layer 1 SAFETY VALVE (FORK 2026-08-05) ---
    // The floor may TRIM a transcript's head; it must never DELETE the whole transcript.
    // It fires on "older than the local store's earliest message", which is evidence of
    // already-covered pre-compaction prehistory only when the two spans OVERLAP. When the
    // local store has been rotated or reset (fresh sessionFile, gateway restart, the 4am
    // wipe) its earliest message is NEWER than every imported one, the floor matches all of
    // them, and the session's only surviving record of that period is dropped — the same
    // "config deleted my history" shape as the provider gate this path just lost. If nothing
    // survives the floor then the import is not redundant prehistory, it IS the history.
    const importOverlapsLocalSpan = params.importedMessages.some((imported) => {
      const ts = resolveComparableTimestamp(imported);
      return ts === undefined || ts >= importFloor;
    });

    // --- layer 2: local assistant timestamps for slot-coverage check ---
    const localAssistantTs: number[] = [];
    for (const msg of params.localMessages) {
      if (resolveComparableRole(msg) === "assistant") {
        const ts = resolveComparableTimestamp(msg);
        if (ts !== undefined) {
          localAssistantTs.push(ts);
        }
      }
    }

    filteredImports = params.importedMessages.filter((imported) => {
      const ts = resolveComparableTimestamp(imported);
      // layer 1: prehistory gate (messages without a timestamp always pass; skipped
      // entirely when the floor would swallow the whole import — see the valve above)
      if (importOverlapsLocalSpan && ts !== undefined && ts < importFloor) {
        return false;
      }
      // layer 2: assistant slot coverage
      if (resolveComparableRole(imported) === "assistant" && ts !== undefined) {
        if (localAssistantTs.some((localTs) => Math.abs(localTs - ts) <= ASSISTANT_SLOT_COVER_MS)) {
          return false;
        }
      }
      return true;
    });
  }

  const merged: HistoryMergeEntry[] = params.localMessages.map((message, index) => ({
    message,
    order: index,
  }));
  const localCount = merged.length;
  let nextOrder = merged.length;
  for (const imported of filteredImports) {
    if (merged.some((existing) => isEquivalentImportedMessage(existing.message, imported))) {
      continue;
    }
    merged.push({ message: imported, order: nextOrder });
    nextOrder += 1;
  }
  // Resolve the positional fallback PER SOURCE SEGMENT — the local block first, then the
  // appended imports — so an untimestamped import never inherits a local message's clock
  // (and vice versa); each segment's unknown timestamps stay anchored to their own array.
  // `slice` hands back the same entry objects, so assigning in place is visible on `merged`.
  assignPositionalSortTimestamps(merged.slice(0, localCount));
  assignPositionalSortTimestamps(merged.slice(localCount));
  merged.sort(compareHistoryMessages);
  return merged.map((entry) => entry.message);
}
