/**
 * The chat transcript as KEYED UNITS — the run builder that used to live inline in app.ts
 * `updateChat` (plan task 9, `docs/superpowers/plans/2026-09-23-chat-history-incremental-rehaul.md`
 * in jarvis-icu).
 *
 * `updateChat` concatenated every row's HTML into one string and assigned it with `innerHTML` on
 * every repaint, including every streaming delta. This module builds the SAME markup, in the same
 * order, but as a list of units, each carrying a stable key: one per row, except a finished run's
 * collapsed "▸ Reasoning" group, which is one unit (its wrapper holds many rows), plus the thinking
 * indicator and the queued prompts. Joining the units' `html` gives, byte for byte, the string the
 * inline builder produced; a keyed renderer (chat-render.ts) can instead touch only the units whose
 * HTML changed.
 *
 * Everything app.ts owns (renderMsg, the stream cursors, the expanded set, the thinking indicator,
 * the queue) is injected, so the grouping rules are testable here with no browser entry point.
 */
import { railCapHtml, railSegmentHtml, type ChatRail, type RailModel } from "./chat-rail.js";
import { historyRowIdentity } from "./history-reconcile.js";
import { narrationIndices, type RunMsgKind } from "./reply-grouping.js";
import { isFractalSectionText } from "./sectioned-reply.js";

/** A transcript row as the renderer reads it: server wire JSON plus the client's `_` stamps. */
// oxlint-disable-next-line typescript-eslint/no-explicit-any
type Row = any;

export type ToolResultMap = Map<string, { content: string; isError: boolean }>;
export type ToolNameMap = Map<string, { name: string; input: unknown }>;

/** One keyed piece of the chat's markup. `html` may be empty (a row that paints nothing). */
export type ChatUnit = { key: string; html: string };

export type ChatUnitDeps = {
  renderMsg: (
    msg: unknown,
    idx: number,
    isThinking: boolean,
    globalResults: ToolResultMap,
    globalToolNames: ToolNameMap,
    hasStructuredReasoning?: boolean,
  ) => string;
  /** The real user text of a user row, or null when the row is entirely system-injected. */
  extractUserText: (msg: unknown) => string | null;
  expandedTools: ReadonlySet<string>;
  /** The live stream's run and bubble, exactly as app.ts holds them (null = nothing streaming). */
  streamRunId: string | null;
  streamMsgUid: string | null;
  esc: (s: string) => string;
  /** Span of a timing block, measured now (app.ts phaseDurationText over phaseGroupSpanMs). */
  phaseSpanText: (timingMsg: Record<string, unknown>) => string;
  skillNoticesHtmlAfter: (
    view: unknown[],
    userIdx: number,
    isBoundary: (m: unknown) => boolean,
  ) => string;
  renderThinkingIndicator: () => string;
  /** Prompts queued for the tab on screen; they are not in `messages`. */
  queuedRows: () => readonly unknown[];
  /**
   * The amygdala's window and cards for the run that just ended: `userMsg` is the prompt the run answers (null before the
   * first prompt), `nextUserMsg` the prompt that ends it (null at the end of the chat). Returns "" when nothing is drawn.
   */
  amygdalaAfterRun?: (userMsg: unknown, nextUserMsg: unknown) => string;
  /** The amygdala's cards that belong at the very end of the chat, above the thinking indicator. */
  amygdalaTail?: () => string;
  /**
   * FORK 2026-10-01 — the answering model's rail for one run (chat-rail.ts): `rows` are the run's
   * rows, `prev` the model the previous run resolved to. Null draws no rail. Absent = no rails.
   */
  runRail?: (
    rows: readonly unknown[],
    prev: RailModel | null,
  ) => { rail: ChatRail; model: RailModel } | null;
  /**
   * FORK 2026-10-02 (the architect: "when we expand anything, it should not compact automatically") — asked
   * for a finished run's Reasoning group that `expandedTools` does not already open, with the group
   * id and the markup of the rows it folds. True opens it. app.ts answers once per group, as it
   * first forms: open when the owner had opened a row inside it while the turn ran, so the turn-end
   * fold never hides what he was reading; the answer is written into `expandedTools`, so a later
   * click closes the group like any other. Absent = closed, as before.
   */
  openGroupOnForm?: (groupId: string, innerHtml: string) => boolean;
};

/** Key of the thinking-indicator unit (it is never a row). */
export const THINKING_UNIT_KEY = "~thinking";

/**
 * A row's unit key: the identity Task 8's merge uses (`oc:<transcript id>` / `ext:<cli uuid>`,
 * history-reconcile's historyRowIdentity), else the client's own stable `_uid` (msg-order
 * stampOrder), else the row's position as a last resort. The key only decides which DOM node a
 * unit may reuse; the renderer still compares the HTML, so a wrong reuse is impossible.
 */
export function chatRowKey(row: unknown, index: number): string {
  const id = historyRowIdentity(row);
  if (id) {
    return id;
  }
  const uid = (row as { _uid?: unknown } | null)?._uid;
  return typeof uid === "string" && uid.length > 0 ? `u:${uid}` : `i:${index}`;
}

export function buildChatUnits(view: Row[], deps: ChatUnitDeps): ChatUnit[] {
  const { renderMsg, extractUserText, expandedTools, streamRunId, streamMsgUid, esc } = deps;
  const units: ChatUnit[] = [];
  // Identify intermediate "thinking" assistant messages: in each run
  // (bounded by user messages), all assistant text messages except the last
  // are thinking steps. If streaming is active, ALL assistant texts in the
  // current run are thinking (the live answer is a temporary message).
  // Tool result user messages are NOT run boundaries — they're mid-run tool responses.
  const isRunBoundary = (m: Row) => {
    // FORK 2026-10-02 — a session-reset divider (history-paging.ts resetDividerRow) closes the
    // archive's last run like a prompt does; inside the run it would fold into its Reasoning group.
    if (m._resetDivider === true) {
      return true;
    }
    // FORK: Fractal reflection responses start a new run
    // (sessions.send injects them as assistant messages, so they won't have a user boundary)
    const mc = Array.isArray(m.content) ? m.content : [];
    const firstText =
      mc.find((b: Row) => b.type === "text" && b.text)?.text ??
      (typeof m.content === "string" ? m.content : "");
    // FORK 2026-08-15 — shared predicate, so `🌿 FRACTAL ACTION:` (the prefix a reflection that
    // actually changed something must use) becomes a boundary exactly like the clean `🌿 FRACTAL:`.
    // Before this the two variants produced two different run shapes and two different bugs.
    if (isFractalSectionText(firstText as string)) {
      return true;
    }

    if ((m.role ?? "").toLowerCase() !== "user") {
      return false;
    }
    const c = Array.isArray(m.content) ? m.content : [];
    // Pure tool_result messages are part of the run, not boundaries
    if (c.length > 0 && !c.some((b: Row) => b.type !== "tool_result")) {
      return false;
    }
    // System-injected user messages (runtime context, subagent results) are not boundaries
    if (extractUserText(m) === null) {
      return false;
    }
    return true;
  };
  // FORK 2026-09-08 (the architect: "any funky dedup algorithm or similar should be gone") — the
  // 2026-09-07 render-time dedup that sat here is DELETED, not disabled. It was scaffolding around
  // `messages = incoming` in loadChat, which is the defect that manufactured the duplicates and is
  // itself gone (see history-reconcile.ts). The page is paper: what was written is painted, once,
  // in the order it was written. No rule here may drop a row.
  const thinkingSet = new Set<number>();
  {
    let runStart = 0;
    for (let i = 0; i <= view.length; i++) {
      const isUserOrEnd = i === view.length || isRunBoundary(view[i]);
      if (!isUserOrEnd) {
        continue;
      }
      const assistantTextIndices: number[] = [];
      for (let j = runStart; j < i; j++) {
        const m = view[j];
        if ((m.role ?? "").toLowerCase() !== "assistant") {
          continue;
        }
        const c = Array.isArray(m.content) ? m.content : [];
        const hasText = c.some((b: Row) => b.type === "text" && (b.text ?? "").trim());
        const plainText = typeof m.content === "string" && (m.content as string).trim();
        if (!hasText && !plainText) {
          continue;
        }
        // FORK: Fractal responses are NOT real assistant text — they render as
        // their own collapsed block. Exclude them so the real answer before
        // a fractal isn't demoted to "thinking".
        // FORK 2026-08-15 — the test used to be a literal `startsWith("🌿 FRACTAL:")`, which missed
        // `🌿 FRACTAL ACTION:` (the prefix the injection mandates whenever the reflection actually
        // changed something). Shared predicate now, so this and sectioned-reply's splitter cannot
        // drift. This exclusion is load-bearing for reply-grouping's cutoff: a 🌿 bubble counted as
        // answer text would push the cutoff past the reflection's own tool calls and demote the
        // real answer all over again.
        const firstTextBlock =
          c.find((b: Row) => b.type === "text" && b.text)?.text ?? (plainText || "");
        if (isFractalSectionText(firstTextBlock as string)) {
          continue;
        }
        // FORK: Fractal prompts are hidden entirely — don't count them
        if ((firstTextBlock as string).includes("# FRACTAL REFLECTION")) {
          continue;
        }
        // FORK: System messages (warnings, errors, retries, prefrontal) must NEVER
        // collapse into reasoning groups — they are user-facing status updates.
        // FORK 2026-08-24 — the timing block joins that list. It is an assistant message with
        // non-empty text, so it counted as an answer bubble here: it inflated `textLen` for the
        // dominant-answer guard and could be classified as narration, and downstream it made the
        // run look like it already had an answer. It is chrome about the turn, not the turn.
        if (
          m._isWarning ||
          m._isError ||
          m._isOverloadRetry ||
          m._isPrefrontal ||
          (m as any)._isPhaseTiming ||
          (m as any)._isReasoning
        ) {
          continue;
        }
        assistantTextIndices.push(j);
      }
      // FORK 2026-06-19 (bug A — STRUCTURAL, replaces position-only slice(0,-1)): an assistant text
      // bubble is genuine between-tool NARRATION (→ collapse into Reasoning) IFF a tool call/result
      // occurs LATER in the same run; text with no tool after it is part of the ANSWER and stays
      // visible. This stops a multi-bubble answer (block-break / >5s gap split / the old 💬 ANSWER-
      // marked structured reply) from having all-but-the-last bubble hidden whenever the model dropped
      // the marker — the actual Bug A. With NO tools in the run, nothing collapses (genuine
      // chain-of-thought already lives in the separate thinking channel). Decision is the pure,
      // unit-tested narrationIndices(); see reply-grouping.ts + bible §5.8h.
      // DO NOT re-add an `isCurrentRun`/`streamMsgUid`-style guard here: it makes ALL prior bubbles
      // flash to final-answer style on each delta and snap back on each tool call (the "blinking chat
      // text" bug). Removed 2026-03-26 in 69693d3f61, again 2026-05-29. See bible §5.8.
      const textIdxSet = new Set(assistantTextIndices);
      const runKinds: RunMsgKind[] = [];
      for (let j = runStart; j < i; j++) {
        const c = Array.isArray(view[j].content) ? view[j].content : [];
        runKinds.push({
          isAssistantText: textIdxSet.has(j),
          hasTool: c.some((b: Row) => b.type === "tool_use" || b.type === "tool_result"),
          // FORK 2026-08-16 — feeds the dominant-answer guard: the run's largest text bubble is
          // never collapsed. Measured necessity: a 4,898-char answer was being hidden behind the
          // reflection's 58-char "Memory written and indexed" receipt. See reply-grouping.ts.
          textLen: c
            .filter((b: Row) => b.type === "text")
            .reduce((n: number, b: Row) => n + String(b.text ?? "").trim().length, 0),
        });
      }
      // FORK 2026-08-05 (the architect: "old messages get rewritten") — FREEZE THE CLASSIFICATION. It used
      // to be recomputed from scratch on EVERY repaint, and `narrationIndices` demotes an assistant
      // text bubble as soon as a tool appears LATER in the run — so as `lastToolIdx` grew, text the
      // user was already reading as the ANSWER was retro-demoted into the collapsed group under
      // their eyes, and a bubble appended to the run later (an `appendTail`, a flushed queued
      // prompt) could re-shuffle a run that had been settled for an hour. Classify ONCE, at the
      // first repaint after the run has no `_temporary` members left, stamp `_narration` on every
      // member, and read the stamp from then on. What was shown as an answer stays an answer.
      // (The LIVE path below is unchanged on purpose: adding an `isCurrentRun` guard here is the
      // "blinking chat text" bug, removed twice already — see bible §5.8.)
      // FORK 2026-08-16 — an earlier cut of this fix looked at the run's BOUNDARY message to decide
      // whether a 🌿 reflection followed. That could never work: the stamp below is frozen at
      // main-turn end, when this run is still the LAST one in the view and the reflection has not
      // been appended yet. narrationIndices now decides from the run alone, with no lookahead.
      const runMsgs = view.slice(runStart, i) as Record<string, unknown>[];
      // FORK 2026-09-02 — same staleness question as the `isStreaming` gate below, and it has to be
      // asked here too or the fix is half a fix: `!some(_temporary)` is this freeze's "the turn has
      // ended" test, so a stranded temp ALSO blocks classification forever and the run never gets a
      // `_narration` stamp to read back. "No temps left" and "nothing is streaming" are both valid
      // proofs that the turn is over; accept either.
      const runSettled =
        !runMsgs.some((m) => m._temporary) || !(streamRunId !== null || streamMsgUid !== null);
      // FORK 2026-09-02 (the architect: "a bunch of thinking messages as final answers … all the tool calls
      // in one single section … hints towards not having respected the time of arrival") — THE
      // FREEZE MUST BE ALL-OR-NOTHING PER RUN.
      //
      // Both gates used to ask `some(...)`, and that is the bug: ONE stamped message put the whole
      // run into read-back mode forever, while the read-back below only adds `_narration === true`
      // to `thinkingSet`. A member that arrived AFTER the stamp carries `undefined`, which is
      // neither true nor false — so it is never classified, falls through to the answer branch, and
      // renders as a final answer for the rest of the session. The run is then split by CLASS
      // rather than by time (all intermediates emitted first, all "answers" after), which is
      // exactly the destroyed chronology the architect diagnosed from the outside.
      //
      // Measured on this session's own transcript, run 68→278 (`agent:main:tinker:mtievarb`):
      // 210 messages — 86 tool, 63 thinking, 61 text — and the SERVED history is perfectly
      // interleaved (h T C h T C …). Running the real `narrationIndices` over it returns
      // **60 narration + exactly 1 answer**, and that one answer is the bubble opening `**Jarvis:**`
      // and closing with the html summary. The screen showed 61 answers and no narration, so the
      // data was right, the classifier was right, and only the stamp was wrong.
      //
      // So: stamp only when EVERY member can be stamped together, and treat a partially-stamped run
      // as stale — recompute rather than read half a verdict. This keeps the 2026-08-05 guarantee
      // (a run that was fully classified is never re-shuffled) while removing the state that made
      // "classified" and "unclassified" coexist inside one run.
      const stampedCount = runMsgs.filter((m) => m._narration !== undefined).length;
      const fullyStamped = runMsgs.length > 0 && stampedCount === runMsgs.length;
      if (!fullyStamped && runSettled) {
        const narration = new Set(narrationIndices(runKinds));
        for (let k = 0; k < runMsgs.length; k++) {
          runMsgs[k]._narration = narration.has(k);
        }
      }
      // Re-read: the block above may have just completed the stamp. Anything short of a COMPLETE
      // stamp falls back to classifying this repaint from the run itself, so no member is ever left
      // unclassified — the failure mode above cannot recur even if a new growth path appears.
      if (runMsgs.length > 0 && runMsgs.every((m) => m._narration !== undefined)) {
        for (let k = 0; k < runMsgs.length; k++) {
          if (runMsgs[k]._narration === true) {
            thinkingSet.add(runStart + k);
          }
        }
      } else {
        for (const rel of narrationIndices(runKinds)) {
          thinkingSet.add(runStart + rel);
        }
      }
      runStart = i + 1;
    }
  }
  // Build a global tool result map: tool_use_id → { content, isError, name }
  // so tool_use blocks can find their paired results even across messages.
  const globalResultMap: ToolResultMap = new Map();
  const globalToolNames: ToolNameMap = new Map();
  for (const m of view) {
    const c = Array.isArray(m.content) ? m.content : [];
    for (const b of c) {
      if (b.type === "tool_result") {
        const rt = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        globalResultMap.set(b.tool_use_id ?? "", { content: rt, isError: b.is_error === true });
      }
      if (b.type === "tool_use") {
        globalToolNames.set(b.id ?? "", { name: b.name, input: b.input ?? {} });
      }
    }
  }
  // Render messages grouped by run. In completed runs, intermediate messages
  // (thinking + tool calls + system) collapse into an expandable reasoning group.
  {
    let runStart = 0;
    /** The model the previous run's rail resolved to (chat-rail.ts answeringModel, step 3). */
    let prevRailModel: RailModel | null = null;
    for (let i = 0; i <= view.length; i++) {
      const isUserOrEnd = i === view.length || isRunBoundary(view[i]);
      if (!isUserOrEnd) {
        continue;
      }

      // Collect intermediate (collapsed) vs answer (visible) bubbles in this run.
      // FORK 2026-06-19 (bug A): the run can now have MULTIPLE answer bubbles — every assistant text
      // bubble NOT classified as between-tool narration (thinkingSet) is part of the answer and is
      // rendered visibly, in order. Previously only a single `finalIdx` survived and earlier answer
      // bubbles were demoted into the collapsed group, which hid real answer content.
      const runEnd = i; // exclusive
      const intermediateIndices: number[] = [];
      const answerIndices: number[] = [];

      for (let j = runStart; j < runEnd; j++) {
        const m = view[j];
        if (thinkingSet.has(j)) {
          intermediateIndices.push(j);
          continue;
        }
        // FORK 2026-07-26 (thinking never collapsed): reasoning bubbles are BY
        // DEFINITION intermediate. They are force-excluded from thinkingSet (the
        // narration classifier) to keep them out of the §5.8 flicker path — but
        // that exclusion left them falling through to the hasText test below, and
        // normalizeHistoryRenderBlocks rewrites a persisted `thinking` block into a
        // `text` block, so every reloaded thinking message classified as ANSWER and
        // rendered as a full visible bubble that no "▸ Reasoning" group ever folded.
        // Classify here (NOT via thinkingSet) so the flicker guard stays intact.
        if ((m as any)._isReasoning) {
          intermediateIndices.push(j);
          continue;
        }
        // FORK 2026-08-24 (the architect: "The timing list should also fold into the reasoning whenever
        // the turn ends, same as the tool calls and intermediate thinking/reasoning"). The block
        // is an assistant message with text, so it classified as ANSWER and stayed permanently
        // expanded in the transcript. Classified HERE rather than via thinkingSet, for the same
        // reason `_isReasoning` is: thinkingSet feeds the §5.8 flicker guard, and this is not a
        // narration judgement — a timing block is intermediate by definition.
        if ((m as any)._isPhaseTiming) {
          intermediateIndices.push(j);
          continue;
        }
        const role = (m.role ?? "").toLowerCase();
        if (role === "assistant") {
          // A tool-only assistant message (no text) is intermediate; a text bubble is answer.
          const c = Array.isArray(m.content) ? m.content : [];
          const hasText = c.some((b: Row) => b.type === "text" && (b.text ?? "").trim());
          const plainText = typeof m.content === "string" && (m.content as string).trim();
          if (!hasText && !plainText) {
            intermediateIndices.push(j);
          } else {
            answerIndices.push(j);
          }
        } else {
          // user tool_result messages, system messages — intermediate
          intermediateIndices.push(j);
        }
      }

      // Count tool_use blocks only in intermediates (not the final answer)
      let toolCount = 0;
      for (const j of intermediateIndices) {
        const tc = Array.isArray(view[j].content) ? view[j].content : [];
        for (const b of tc) {
          if (b.type === "tool_use") {
            toolCount++;
          }
        }
      }

      // Determine if this run is still streaming (has temporary messages)
      // FORK 2026-09-02 (the architect: "a lot of reasoning that did not collapse correctly") — A
      // `_temporary` FLAG MUST NOT OUTLIVE THE STREAM THAT SET IT. This test used to read the flag
      // alone, so ONE stale temp pinned a long-settled run to `isStreaming` FOREVER and the flat
      // branch below rendered every narration bubble as an answer, permanently. Nothing ever
      // re-collapsed it: the `_narration` freeze is gated on the same flag, so the run could not
      // even be classified. Measured on this session's own transcript (`agent:main:tinker:mtievarb`,
      // the run ending in the 3,941-char answer): replaying narrationIndices over the served history
      // classifies 229 intermediates / 2 answers — a clean collapse — while the rendered DOM shows
      // ~30 loose `msg assistant` bubbles and NO `reasoning-group`. `isStreaming` is the only gate
      // between those two facts.
      //
      // Two ways a temp gets stranded, both of which end at a runId that will never come back:
      // `ownsTempMsg` only promotes a temp whose `_runId` matches the FINAL's run, and the frozen-
      // reasoning loop only clears one whose `_reasoningRunId` matches. A history reload assigns
      // `messages = incoming` and destroys every `_runId` stamp, while `_isReasoning` IS in
      // msg-order's CLIENT_ONLY_FLAGS and `_temporary` is NOT — so a live reasoning bubble is
      // preserved verbatim, `_temporary` and all, and no later run can ever claim it.
      //
      // The honest question is not "does this run hold a temp" but "is anything actually streaming
      // right now". When no run is live, a leftover temp is stale by construction. During a live
      // turn `streamRunId`/`streamMsgUid` are set, so the live path is bit-for-bit unchanged — this
      // is NOT the `isCurrentRun` guard that caused the blinking-chat-text bug twice (that one sat
      // in the narration CLASSIFIER; this one only answers "has the turn ended").
      const liveStreamActive = streamRunId !== null || streamMsgUid !== null;
      const hasTemporaries =
        liveStreamActive && intermediateIndices.some((j) => view[j]._temporary);
      const isStreaming = hasTemporaries || (i === view.length && streamMsgUid !== null);

      // FORK 2026-08-24 (the architect: "The timings of the fractal pass should show only when expanding
      // Fractal") — IS THIS RUN THE REFLECTION PASS?
      //
      // The reflection is a separate run on the SAME session key, and `isRunBoundary` makes its
      // 🌿 bubble the boundary that closes this run. So a run whose boundary is a fractal section
      // IS the reflection, and everything in it — in practice, only its timing block — belongs to
      // the reflection rather than to the conversation. Before this it rendered as loose rows at
      // the very bottom of the chat, under the answer, which is the "crawl to the end" report.
      //
      // Structural, not a runId join: answer bubbles carry no runId in the DOM (see the fractal
      // anchor note), so position is the only signal that survives a reload.
      const boundaryMsg = i < view.length ? (view[i] as Record<string, unknown>) : null;
      const boundaryContent = Array.isArray(boundaryMsg?.content)
        ? (boundaryMsg?.content as Array<Record<string, unknown>>)
        : [];
      const boundaryText = String(
        boundaryContent.find((b) => b?.type === "text" && b?.text)?.text ??
          (typeof boundaryMsg?.content === "string" ? boundaryMsg.content : ""),
      );
      const fractalGraftUid =
        boundaryMsg && isFractalSectionText(boundaryText) ? String(boundaryMsg._uid ?? "") : "";
      // Renders one message, wrapping a REFLECTION's timing block in a marker the post-render
      // pass moves into the 🌿 section's body. A wrapper rather than a render-time nesting
      // because the section is emitted AFTER this run, as its boundary — there is no string to
      // nest into yet. Same graft discipline as the level-3 expander.
      const renderRunMsg = (j: number, thinking: boolean, structured = false): string => {
        const out = renderMsg(view[j], j, thinking, globalResultMap, globalToolNames, structured);
        const m = view[j] as Record<string, unknown>;
        if (!m?._isPhaseTiming) {
          return out;
        }
        // Two independent ways to know this block is a reflection's, because the two events
        // arrive in either order: `_fractalPass` is stamped by runId the moment the lane's text
        // identifies it (which can be AFTER the block was built, and can put the block in the
        // main run), and the boundary test catches the case where the 🌿 section is already the
        // run's terminator. An empty uid means "the next section, wherever it is".
        if (m._fractalPass === true) {
          return `<div class="mpg-graft" data-phase-graft-into="${esc(fractalGraftUid)}">${out}</div>`;
        }
        return fractalGraftUid
          ? `<div class="mpg-graft" data-phase-graft-into="${esc(fractalGraftUid)}">${out}</div>`
          : out;
      };

      // Render the run
      const runFirstUnit = units.length;
      if (intermediateIndices.length > 0 && answerIndices.length > 0 && !isStreaming) {
        // Completed run with intermediates — wrap in collapsible group
        // FORK 2026-08-05 — the group id used to be the ARRAY ORDINAL of its first intermediate
        // (`rg-${index}`), so any push, splice or removal RENAMED the group and silently handed the
        // user's open/closed state to a DIFFERENT group. Key it on the anchor's stable `_uid`.
        const groupAnchor = view[intermediateIndices[0]] as Record<string, unknown>;
        const groupId = `rg-${(groupAnchor._uid as string | undefined) ?? intermediateIndices[0]}`;
        // The members are rendered BEFORE the open/closed decision: the hook reads what they show,
        // and rendering a timing block is what retires its automatic disclosure at turn end
        // (app.ts applyAutoDisclosure), so only rows the owner opened are still open here.
        let inner = "";
        for (const j of intermediateIndices) {
          inner += renderRunMsg(j, thinkingSet.has(j));
        }
        const expanded =
          expandedTools.has(groupId) || (deps.openGroupOnForm?.(groupId, inner) ?? false);
        // FORK 2026-07-26: count reasoning bubbles too — they are intermediates via
        // the _isReasoning branch above, not via thinkingSet, so a thinking-only run
        // used to render a bare, countless "▸ Reasoning" header.
        const stepCount = intermediateIndices.filter(
          (j) => thinkingSet.has(j) || (view[j] as any)._isReasoning,
        ).length;
        const chevron = expanded ? "▾" : "▸";
        const stepLabel = stepCount > 0 ? `${stepCount} step${stepCount !== 1 ? "s" : ""}` : "";
        const toolLabel =
          toolCount > 0 ? `${toolCount} tool call${toolCount !== 1 ? "s" : ""}` : "";
        // FORK 2026-08-24 — surface the turn's span ON the collapsed header. Folding the timing
        // block would otherwise hide the one number the block exists to report, and a header that
        // reads "Reasoning" with nothing after it (the shape a timing-only run produces) says
        // less than the rows it replaced.
        const timingMsg = intermediateIndices
          .map((j) => view[j] as Record<string, unknown>)
          .find((m) => m?._isPhaseTiming);
        const timingLabel = timingMsg ? `⏱ ${deps.phaseSpanText(timingMsg)}` : "";
        const parts = [stepLabel, toolLabel, timingLabel].filter(Boolean).join(", ");
        const summary = parts ? `Reasoning (${parts})` : "Reasoning";

        // The group is ONE keyed unit: its wrapper holds many rows, so no row inside it can be
        // a unit of its own.
        let g = `<div class="reasoning-group">`;
        g += `<div class="reasoning-header" data-tid="${groupId}">${chevron} ${summary}</div>`;
        // FORK 2026-08-05 — THE SINGLE MOST IMPORTANT LINE OF THIS FIX. The collapsed branch used to
        // emit its intermediates ONLY when the group was expanded (`if (expanded)`), so the instant
        // a turn ended, every narration bubble and every tool row the user had already read was
        // GENUINELY GONE FROM THE DOCUMENT: Ctrl-F could not find it, a screen reader could not
        // reach it, "select all + copy" did not copy it. That is a DELETION, not a compaction, and
        // it is the mechanism behind "others disappear". Emit them ALWAYS and hide the container
        // with the `hidden` attribute (see `.reasoning-content[hidden]` in base.css) — the change of
        // APPEARANCE the architect explicitly allowed, with nothing removed from the page.
        g += `<div class="reasoning-content"${expanded ? "" : " hidden"}>`;
        g += inner;
        g += `</div>`;
        g += `</div>`;
        units.push({ key: `g:${chatRowKey(groupAnchor, intermediateIndices[0])}`, html: g });
        // FORK 2026-06-19 (bug A): render EVERY answer bubble (all visible text after the last tool),
        // in order — not just a single final bubble.
        // FORK 2026-08-09: this run just emitted a structural "▸ Reasoning" group above, so its
        // intermediates are already folded and these bubbles are the answer itself. Pass
        // hasStructuredReasoning=true so the text-heuristic splitter does NOT re-cut them —
        // compaction happens once, at turn end, over CLASSIFIED steps, never over the reply.
        for (const j of answerIndices) {
          units.push({ key: chatRowKey(view[j], j), html: renderRunMsg(j, false, true) });
        }
      } else {
        // Streaming run or no intermediates — render flat
        for (let j = runStart; j < runEnd; j++) {
          units.push({ key: chatRowKey(view[j], j), html: renderRunMsg(j, thinkingSet.has(j)) });
        }
      }

      // FORK 2026-10-01 (the architect) — the answering model's rail: each of the run's units carries its
      // own stretch of the line, and the logos are units of their own before and after the run, so
      // no unit's markup depends on what follows it (chat-rail.ts). It closes before the amygdala's
      // cards and never reaches the prompt below: those are not the model's answer.
      const runPainted = units.slice(runFirstUnit).some((u) => u.html.trim() !== "");
      const railed: { rail: ChatRail; model: RailModel } | null =
        deps.runRail && runPainted
          ? deps.runRail(view.slice(runStart, runEnd), prevRailModel)
          : null;
      if (railed) {
        prevRailModel = railed.model;
        for (let u = runFirstUnit; u < units.length; u++) {
          units[u] = { key: units[u].key, html: railSegmentHtml(units[u].html, railed.rail) };
        }
        const anchor = chatRowKey(view[runStart], runStart);
        units.splice(runFirstUnit, 0, {
          key: `rail-start:${anchor}`,
          html: railCapHtml(railed.rail, "start"),
        });
        units.push({ key: `rail-end:${anchor}`, html: railCapHtml(railed.rail, "end") });
      }

      // The amygdala's Jev window and cards close the run they judged (design doc §9); "" draws nothing.
      if (deps.amygdalaAfterRun) {
        const amy = deps.amygdalaAfterRun(
          runStart > 0 ? view[runStart - 1] : null,
          i < view.length ? view[i] : null,
        );
        if (amy) {
          units.push({
            key: `amy:${runStart > 0 ? chatRowKey(view[runStart - 1], runStart - 1) : "start"}`,
            html: amy,
          });
        }
      }

      // Render the user message that ends this run (if not end-of-array)
      if (i < view.length) {
        let b = renderMsg(view[i], i, false, globalResultMap, globalToolNames);
        // FORK 2026-09-02: skill chips ride under the prompt that used them, same as the recipe
        // chip. Producer is a tool_use `read` of …/skills/<name>/SKILL.md in the following run.
        b += deps.skillNoticesHtmlAfter(view, i, isRunBoundary);
        units.push({ key: chatRowKey(view[i], i), html: b });
      }
      runStart = i + 1;
    }
  }

  // FORK 2026-06-07 — bug task-mq3gn32d (Prompt hopping): the running turn's thinking/tool
  // indicator must render ABOVE the queued bubble. So emit the thinking indicator FIRST, then the
  // queued-but-not-yet-committed prompts as the very last (bottom-most) bubbles, pinned to the
  // bottom in "queuing mode" exactly like Claude Code. The still-streaming turn's
  // continuation/tool output therefore always appears above the queued prompt, never below it.
  // PLACEMENT ONLY (prompt-queue.md PQ-8): this decides WHERE a deferred bubble goes. How it LOOKS
  // comes from its own `_promptState` through prompt-state.ts. This said "grayed" until step U2
  // retired the grey `queued` lane: a deferred prompt now wears the badge of the state the gateway
  // reported for it (BEHIND, dimmed, or STEERED), none while that report is outstanding, and amber
  // when its send was rejected.
  // Queued prompts are deliberately NOT in messages[] (see send()); they are flushed into
  // messages[] at turn-final, which splices them into their correct chronological position (in the
  // middle, within the thinking/tool stream) once the turn that was reading them completes.
  // FORK 2026-08-15 — the gate here used to be `activeRuns.size > 0 || sending`, which made
  // the SERVER lane of renderThinkingIndicator() unreachable. That branch exists precisely
  // for the case where this browser holds NO client run and is not sending — a turn started
  // from another tab, a cron, WhatsApp, or an orchestrator leg — so the one condition it was
  // written for was the one condition that skipped the call entirely. (Companion defect to
  // the missing repaint trigger analysed in docs/2026-08-15-chat-thinking-indicator-missing-
  // while-tab-glows.md, which found the trigger gap but not this gate.)
  //
  // renderThinkingIndicator() already owns the whole decision and returns "" when no branch
  // applies, so the gate was duplicated — and drifted, as duplicated predicates do.
  const amyTail = deps.amygdalaTail?.() ?? "";
  if (amyTail) units.push({ key: "amy:tail", html: amyTail });
  units.push({ key: THINKING_UNIT_KEY, html: deps.renderThinkingIndicator() });
  // FORK 2026-06-08: render ONLY the queued prompts that belong to the tab on screen. The queue is
  // one global array shared by all tabs; without this filter a prompt queued in one tab showed as a
  // "queued" bubble in EVERY tab.
  const visibleQueued = deps.queuedRows();
  for (let k = 0; k < visibleQueued.length; k++) {
    units.push({
      key: `q:${chatRowKey(visibleQueued[k], view.length + k)}`,
      html: renderMsg(visibleQueued[k], view.length + k, false, globalResultMap, globalToolNames),
    });
  }
  return units;
}
