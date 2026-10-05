// FORK 2026-08-16 (the architect, on a live tab: "answering twice every turn") — a PURE,
// DOM-free module in the style of stream-reslice.ts / msg-order.ts, so the rule below is
// unit-testable without app.ts's 12k lines of DOM.
//
// ════════════════════ THE GATEWAY SENDS `final` TWICE. IT ALWAYS HAS. ════════════════════
// One agent-started run produces TWO `state:"final"` chat frames with the SAME runId and two
// differently-built bodies:
//
//   #1  agent-runtime lifecycle  — `emitChatFinal`, src/gateway/server-chat.ts
//       body = `resolveBufferedChatTextState(...)`, i.e. the STREAMED display buffer.
//   #2  backstop                 — `broadcastChatFinal`, src/gateway/server-methods/chat.ts
//       body = `deliveredReplies.filter(kind==="final").map(p=>p.text).join("\n\n")`.
//
// Measured live on a single tool-using turn (one runId, one generation, one `model.completed`):
//       FINAL seq=16 textLen=105   <- #1, the streamed narration
//       FINAL seq=3  textLen=187   <- #2, narration + the answer that never streamed
//
// chat.ts states the contract it relies on in a comment: "if the lifecycle event already fired
// the client de-dupes by runId+state". No client ever did. #1 promoted the streaming temps into
// permanent bubbles; #2 then arrived with no temps left and was pushed WHOLE, so the narration
// rendered a second time — on EVERY tool-using turn, deterministically.
//
// WHY THE OBVIOUS FIX IS WRONG: you cannot simply ignore the second final. claude-cli emits no
// stream during tool work (see extensions/tinkerclaw-tinker-bridge), so for a tool-using turn the
// post-tool ANSWER exists only in #2's body — #1 carries the narration and nothing else. Dropping
// #2 would truncate every tool-using answer, trading a visible duplicate for silent data loss.
//
// THE RULE: a second final for a runId SUPERSEDES the first. Reconcile it against what that run
// already put on screen and append only the part of the new body that no bubble shows; since
// 2026-10-03 it changes no bubble the first final settled (`planFinalWrite`). Nothing rendered is
// ever deleted — "carta a terra va a la guerra", the same law stream-reslice.ts enforces.
// ═════════════════════════════════════════════════════════════════════════════════════════

import { resliceSegments } from "./stream-reslice.js";

/** The subset of a chat message this module needs. `_runId` is stamped by app.ts on every bubble a
 *  run puts on screen; it is deliberately NOT in msg-order's CLIENT_ONLY_FLAGS, because an answer
 *  bubble SHOULD be replaced by server history on reload. */
export type RunBubble = {
  role?: unknown;
  content?: unknown;
  _runId?: unknown;
  _segmentStart?: unknown;
  _isReasoning?: unknown;
};

// ════════════════ TWO COORDINATE SPACES — WHY A THOUGHT IS NEVER A TEXT BUBBLE ════════════════
// FORK 2026-10-03 (bug-log [final-mixed-coordinates]; the architect: "still duplicating some
// messages … if I refresh the page, the duplicate answer goes away"). The thinking writer stamps
// its bubbles with `_runId` and a text block, like the text writer does, and since 2026-09-23 with
// a `_segmentStart` too — but that offset counts characters of the run's THINKING buffer (the
// trimmed cumulative reasoning when the thought opened), while every text bubble's counts
// characters of the run's TEXT. A final's body is text. Reconciling it against a thought made
// `resliceSegments` end the narration bubble before the thought at the thought's thinking offset
// (the narration grew over the head of the answer, inside a folded row), and the tail rule's
// cursor then stopped there and pushed `final.slice(thinkingOffset)`: a second bubble holding the
// answer from a mid-word point to its end. Measured on two live tabs (cuts at 1364 and 2508, the
// thinking lengths), served once, gone on reload. So the predicate below excludes reasoning
// bubbles, and app.ts selects through `finalTextBubbles` for BOTH finals, never by run stamp alone.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** True for a bubble the thinking writer opened: its `_segmentStart` is a THINKING offset. */
export function isReasoningBubble(m: RunBubble): boolean {
  return m._isReasoning === true;
}

function hasTextBlock(m: RunBubble): boolean {
  return (
    m.role === "assistant" &&
    Array.isArray(m.content) &&
    (m.content as Array<{ type?: unknown }>).some((b) => b?.type === "text")
  );
}

/** True when this message is an assistant TEXT bubble of `runId` (never a reasoning bubble). */
export function isRunTextBubble(m: RunBubble, runId: string): boolean {
  if (!runId || m._runId !== runId || isReasoningBubble(m)) {
    return false;
  }
  return hasTextBlock(m);
}

/** The bubbles a SUPERSEDING final must reconcile against: everything the first final already
 *  promoted for this run, in render order. Empty when the run has nothing on screen — in which
 *  case the final is a FIRST final and the caller pushes it whole, exactly as before. */
export function runTextBubbles<T extends RunBubble>(messages: readonly T[], runId: string): T[] {
  if (!runId) {
    return [];
  }
  return messages.filter((m) => isRunTextBubble(m, runId));
}

/** Extract the text a bubble currently shows (its first text block), for reslicing. */
export function bubbleText(m: RunBubble): string {
  if (!Array.isArray(m.content)) {
    return "";
  }
  const blk = (m.content as Array<{ type?: unknown; text?: unknown }>).find(
    (b) => b?.type === "text",
  );
  return typeof blk?.text === "string" ? blk.text : "";
}

/** The segment start a bubble was sliced at, defaulting to 0. */
export function bubbleSegStart(m: RunBubble): number {
  return typeof m._segmentStart === "number" ? m._segmentStart : 0;
}

/**
 * The bubbles a `final` reconciles its body against, in render order. One selection for both
 * finals: the first final takes the run's live TEXT temps (`ownsTemp`, which app.ts scopes to the
 * run), a superseding final the text bubbles the first one promoted. Reasoning bubbles never: their
 * offsets live in another buffer (see the note above `isReasoningBubble`).
 */
export function finalTextBubbles<T extends RunBubble>(
  messages: readonly T[],
  runId: string,
  firstFinal: boolean,
  ownsTemp: (m: T) => boolean,
): T[] {
  return messages.filter((m) =>
    firstFinal
      ? !isReasoningBubble(m) && ownsTemp(m) && hasTextBlock(m)
      : isRunTextBubble(m, runId),
  );
}

/**
 * What a final writes onto the bubbles `finalTextBubbles` chose: each one's text and the part of
 * the body none of them shows (`appendTail`, "" for none), to push as ONE new bubble.
 *
 * A first final reslices its temps (`resliceSegments`: verbatim or grown, never shorter or
 * different) and appends what the stream did not show. A superseding final changes no bubble: the
 * first final already settled them against its own body, so anything the second body adds is a
 * block the stream never carried (a post-tool answer, in 20 of 649 two-final runs measured
 * 2026-09-23..10-03) and gets its own bubble, as a reload draws it. Growing the last settled bubble
 * instead glued that answer onto the narration before it (review round 1, 2026-10-03).
 */
export function planFinalWrite(
  bubbles: readonly RunBubble[],
  finalText: string,
  supersedes: boolean,
): { texts: string[]; appendTail: string } {
  if (supersedes) {
    const texts = bubbles.map(bubbleText);
    return { texts, appendTail: supersedingAppendTail(texts, finalText) };
  }
  const resliced = resliceSegments(
    bubbles.map((m) => ({ text: bubbleText(m), segStart: bubbleSegStart(m) })),
    finalText,
  );
  return { texts: resliced.texts, appendTail: resliced.appendTail ?? "" };
}

// ════════════════ WHY A SUPERSEDING FINAL NEEDS ITS OWN TAIL RULE ════════════════
// FORK 2026-08-30 (the architect, live tab `agent:main:tinker:mtfp4w3a`: the last two answers
// rendered TWICE, while `chat.history` held exactly one copy and a freshly opened tab was clean).
//
// The supersede path above correctly identified final #2 and correctly declined to push it whole —
// and then asked `resliceSegments` the wrong question. That module answers "what part of this
// final did the STREAM not show?", and its credit rule is per-bubble: the longest SINGLE kept
// bubble that is a PREFIX of the body. That is exactly right for stream-vs-final, where the
// bubbles are slices of the very string being resliced.
//
// The two finals are NOT that. They are two independent CONSTRUCTIONS of one run's output:
//   #1 `emitChatFinal` (server-chat.ts)  = the streamed display buffer, verbatim.
//   #2 `broadcastChatFinal` (server-methods/chat.ts) = `deliveredReplies.filter(kind==="final")`
//      `.map(p => p.text.trim()).filter(Boolean).join("\n\n")` — every part TRIMMED, rejoined with
//      a fixed "\n\n".
// So #2 differs from #1 in exactly the whitespace at the edges and at the joins — and every test
// in `resliceSegments` is a strict `startsWith`/`endsWith`. Both geometries below were reproduced
// against the real module before this was written:
//   • a leading newline on the streamed buffer  → nothing is a prefix, `shownPrefix` stays 0, and
//     the WHOLE body is returned as "unrepresented tail". Two byte-identical bubbles — the
//     "two identical DOM copies under one nearest data-tid" from the report.
//   • parts streamed "\n"-joined but rebuilt "\n\n"-joined → only bubble #0 is credited and
//     everything after it is appended again.
// Neither is exotic: they are the DEFAULT shape of a multi-part answer, which is why it reproduced
// on consecutive turns and why a reload cured it (history replaces the array wholesale).
//
// THE RULE, and why it is not a text dedupe: the two bodies belong to ONE runId, and the only
// bubbles consulted are the ones THAT run put on screen (`runTextBubbles`). Two genuinely distinct
// messages that happen to share text are never compared — the deleted `dedupeAssistantAnswers()`
// scanned the whole session and is not being reintroduced. Whitespace is normalised for the
// COMPARISON only; whatever is appended is sliced out of the raw body, unmodified. And a body the
// run has not shown is still appended in full, so the reason #2 cannot simply be dropped — the
// post-tool answer that never streamed lives only in #2 — is preserved intact.
// ═════════════════════════════════════════════════════════════════════════════════

// ════════════════ THE VOICE SPAN — THE DIFFERENCE THAT DOUBLED EVERY ANSWER ════════════════
// FORK 2026-09-24 (the architect, work tab `agent:main:tinker:mue2cvin`: "every time he
// answers I see the response double"). Final #2's body went through the gateway's
// `applyJarvisVoiceMarkup`, which rewrote every `**Jarvis:** x` into `**Jarvis:** <span
// class="jarvis-voice">x</span>` — trimming `x`, so the whitespace before the NEXT label vanished
// too. Final #1 is the raw streamed text. Nearly every answer opens with a voice line, so no shown
// bubble was ever found inside #2, `cursor` stayed 0, and the WHOLE reply was appended again —
// measured on 8 of 8 real runs of that tab (the replay reproduced every live `[chat-deliver]` length).
// The gateway no longer writes the span (agent-runner-payloads.ts, same date); this keeps a gateway
// that still does — or any replayed body — from doubling the answer.
//
// Why the comparison now ignores whitespace ENTIRELY rather than collapsing it: the same tab showed
// both geometries a "tag = one space" rule cannot serve at once. The wrapper's trim() ate the blank
// line before a label (`x*</span>**Jarvis:**` vs `x*\n\n**Jarvis:**`), and the stream GLUES a
// pre-tool narration straight onto the post-tool answer with no whitespace at all
// (`…have run.**Jarvis:** *…`) where the wrapper put `</span>`. Two constructions of one
// reply agree on their non-whitespace characters and on nothing finer; that is what is compared.
// ═════════════════════════════════════════════════════════════════════════════════
const VOICE_SPAN_TAG = /<span\s+class=["']jarvis-voice["']\s*>|<\/span>/iy;

/** Length of a voice-span tag starting at `raw[i]`, or 0. */
function voiceTagLengthAt(raw: string, i: number): number {
  if (raw[i] !== "<") {
    return 0;
  }
  VOICE_SPAN_TAG.lastIndex = i;
  const m = VOICE_SPAN_TAG.exec(raw);
  return m ? m[0].length : 0;
}

/**
 * `raw` with every whitespace character and every voice-span tag removed, plus `map[i]` = the raw
 * index that normalised character `i` came from (and `map[norm.length]` = `raw.length`), so a
 * cursor measured in normalised space can be turned back into a slice of the ORIGINAL string.
 * Whitespace carries no content here and is exactly where the two finals disagree — at the edges,
 * at the joins, and around the voice span (see above).
 */
function normalizeWithMap(raw: string): { norm: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let i = 0;
  while (i < raw.length) {
    const tag = voiceTagLengthAt(raw, i);
    if (tag > 0) {
      i += tag;
      continue;
    }
    if (/\s/.test(raw[i])) {
      i++;
      continue;
    }
    chars.push(raw[i]);
    map.push(i);
    i++;
  }
  map.push(raw.length);
  return { norm: chars.join(""), map };
}

/**
 * The part of a SUPERSEDING final's body that the run does not already show, as a slice of the raw
 * body — or "" when the run already shows all of it.
 *
 * `shown` is the run's on-screen bubble texts IN RENDER ORDER (after `resliceSegments` has had its
 * say, so a bubble it legally grew is credited at its new length). Each is matched forward from a
 * cursor, so order is respected and a bubble that appears nowhere in the body is simply skipped
 * rather than truncating the credit — client-only content next to the answer must not make the
 * answer look unseen.
 *
 * Never returns whitespace-only text: appending a bubble that renders as nothing is the empty-bubble
 * pathology `resliceSegments` was written to make unrepresentable.
 */
export function supersedingAppendTail(shown: readonly string[], finalText: string): string {
  if (typeof finalText !== "string" || finalText.trim() === "") {
    return "";
  }
  const { norm, map } = normalizeWithMap(finalText);
  if (norm === "") {
    return "";
  }
  let cursor = 0;
  for (const raw of shown) {
    const piece = normalizeWithMap(typeof raw === "string" ? raw : "").norm;
    if (piece === "") {
      continue;
    }
    const at = norm.indexOf(piece, cursor);
    if (at < 0) {
      continue;
    }
    cursor = at + piece.length;
  }
  if (cursor >= norm.length) {
    return "";
  }
  const tail = finalText.slice(map[cursor] ?? finalText.length);
  return tail.trim() === "" ? "" : tail;
}

// ════════════════ PROVENANCE (FORK 2026-08-30) — WHY THE NEXT REPRODUCTION MUST NAME ITS CALLER ══
// The supersede rule above is scoped to ONE runId and reads only bubbles stamped `_runId`. That
// stamp is client-only and lives nowhere on the server, so `loadChat`'s `messages = incoming`
// erases every one of them (it is deliberately NOT in msg-order's CLIENT_ONLY_FLAGS). A superseding
// final that lands AFTER a history reload therefore finds zero run bubbles, the supersede path is
// skipped, and the insert falls through to a guard that compares the WHOLE body against ONE bubble
// — which by construction cannot match a multi-bubble turn.
//
// That is a mechanism, not a measurement: nothing observed so far says it is the one firing on the
// architect's tab. So instead of another dedupe patch aimed at a guess, every assistant insertion
// site logs WHO inserted, under WHICH run, and whether the text was already on screen. These two
// helpers are the content-free half of that record, kept here (pure, DOM-free) so they are unit
// tested rather than trusted.
// ═════════════════════════════════════════════════════════════════════════════════

/**
 * A stable, CONTENT-FREE identity for a message body: FNV-1a over the whitespace-normalised text.
 *
 * Whitespace-normalised because that is exactly how the two finals differ (see the header above), so
 * the two constructions of one answer must fingerprint EQUAL or the log would not show them as the
 * same message. Never returns the text itself and is not reversible — a duplicate is diagnosed by
 * two log lines sharing a fingerprint, so the transcript never has to be printed to the console.
 */
export function fingerprintText(raw: unknown): string {
  const norm = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (norm === "") {
    return "empty";
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    // FNV-1a's 32-bit prime, via Math.imul so the multiply stays 32-bit rather than drifting into
    // float territory and collapsing distinct texts onto one value.
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * How many of `texts` are the same message as `candidate`, compared whitespace-insensitively.
 *
 * The question a duplicate report actually poses is "is this already on screen?", and the answer has
 * to survive the whitespace difference between the two finals. Empty candidates match nothing: a
 * blank body is not evidence of anything.
 */
export function sameTextCount(texts: readonly unknown[], candidate: unknown): number {
  const want = fingerprintText(candidate);
  if (want === "empty") {
    return 0;
  }
  let n = 0;
  for (const t of texts) {
    if (fingerprintText(t) === want) {
      n++;
    }
  }
  return n;
}
