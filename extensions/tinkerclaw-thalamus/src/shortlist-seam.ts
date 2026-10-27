// The short-list seam (charter phase D1; design doc section 13A.5; paper P§7.1).
//
// WHAT THIS IS FOR. At the start of a task, work out which enhancements may fit and, only when the operator has set
// the mode to `enforce`, hand the agent a short note listing them. In `shadow` the list is computed and RECORDED
// (so the loop can see what would have been offered) and NOTHING is added to the agent's context: `prepare()`
// returns no text. That is the whole difference between the two modes here, and the tests pin it.
//
// THE LIST IS ADVICE (charter, line not to cross). Nothing forces, loads or runs an enhancement, and the note says
// "none of these may fit". A list that is not shown gives no text at all.
//
// NEVER LATE. The prompt waits at most `budgetMs` for the list. Jev off (the default) means local matching, which is
// instant; if Jev is on and slow, the local list is used instead of holding the prompt.
//
// MEMORY POINTERS (2026-10-25). The same note may carry one line each to a note file or a past chat that may already
// hold what the task needs (`pointer-sources.ts`), so round 1 knows where to look. Only for the owner's own prompt (the
// gate the shared ranking uses), never for a private source, matched locally and in memory: nothing is sent anywhere.
// `anticipate.mode` `watch` records them and shows nothing; `inject` shows them, again only in `enforce`.
//
// THE WAKE (2026-10-25). A past chat that matches strongly may be asked by the harness itself (`session-wake.ts`,
// `anticipate.wake`): the wake starts in the background, the note gets one line with the command that prints its
// answer, and an answer the agent never read is handed over at the start of that chat's next turn, once. In `watch`
// the decision is only recorded on the pointer's ledger row.

import {
  classifyTaskDomain,
  isInteractiveSession,
  isRuntimeNotice,
  localShortlist,
  notAsked,
  rankTextFor,
  recommendable,
  shortlistContext,
  shortlistFromResult,
  type EnhancementCard,
  type MemoryPointer,
  type PointerHit,
  type Shortlist,
  shouldShuffle,
  shuffleList,
  type TaskRankInput,
  type TaskRanking,
} from "openclaw/plugin-sdk/fork-thalamus";
import type { AnticipateMode, ThalamusMode } from "./config.js";
import type { PointerFind } from "./pointer-sources.js";
import type { ReadInput, RoutingReader } from "./reads/routing-reader.js";
import type { SessionWaker, WakeConsider } from "./session-wake.js";
import type { UseTracker } from "./use-tracker.js";

export type Prepared = {
  list: Shortlist;
  /** The note for the agent. Present only when the mode is `enforce` and the list is shown or a pointer fits. */
  text?: string;
  injected: boolean;
  usedJev: boolean;
  /** The note and past-chat pointers found for this prompt, shown to the agent or not. */
  pointers?: readonly PointerHit[];
  /** What the wake leg did with the best past-chat match; absent when no match cleared its bar. */
  wake?: WakeConsider;
};

/** The note with `line` put before its closing "None of these may fit" line. */
function beforeLastLine(note: string, line: string): string {
  const lines = note.split("\n");
  lines.splice(Math.max(0, lines.length - 1), 0, line);
  return lines.join("\n");
}

const timeout = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(undefined);
      },
    );
  });

/**
 * A note the gateway, a skill or another agent put into the chat is not a task from the user, so it gets no list
 * (2026-10-02 18:20: the restart resume reached the agent behind this advice and the architect saw a prompt he never wrote).
 * The markers are the ones tinker-ui's injected-prompt.ts names: `[System]`, `[System · who]`, `[injected: who]`,
 * another agent's `<cross-session-message>`, the loop's `⟦AGENT:label⟧` and the Overseer's `⟦OVERSEER⟧`, after an
 * optional delivery stamp.
 */
const INJECTED_PROMPT =
  /^\s*(?:\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} [^\]]*\]\s*)?(?:\[System\b|\[inject(?:ed)?\b|<cross-session-message\b|⟦(?:AGENT|OVERSEER)\b)/i;

/** What the seam needs to know of a prompt beyond `ReadInput`, for the shared ranking (Broca retrieval v2, phase E). */
export type PrepareInput = ReadInput & {
  runId: string;
  /** `inputProvenance.kind` of the run, when the gateway recorded one. */
  provenanceKind?: string;
  /** The user turn before this one, for a request with no subject of its own. */
  previousUserText?: string;
};

export function createShortlistSeam(d: {
  reader: RoutingReader;
  cards: () => readonly EnhancementCard[];
  mode: () => ThalamusMode;
  /** `enforce.shortlist`: with it off, enforce records the list and injects nothing. Absent: on. */
  inject?: () => boolean;
  budgetMs: () => number;
  tracker: UseTracker;
  /**
   * Broca retrieval v2: the ranked result both this seam and Broca's matcher read, started by whichever hook asks first. Absent,
   * or an answer of undefined (no ranker registered), or a session that is not interactive: the old flat read, as before.
   */
  ranking?: (input: TaskRankInput) => Promise<TaskRanking> | undefined;
  /** Learning switches and the draw. Absent: no shuffle and no replay capture, exactly as before phase F. */
  learning?: {
    shuffle: () => boolean;
    rand: () => number;
    /** May this task's redacted text enter the replay set? Only a source Jev is approved for. */
    replayAllowed: (input: ReadInput) => boolean;
    recordReplay: (taskId: string, text: string) => void;
  };
  /** Phase 1.3: reads the owner's words for a correction and records it. Absent: nothing is read. Never awaited. */
  corrections?: { observe: (input: PrepareInput) => unknown };
  /** The note and past-chat legs. Absent, or `mode()` off: no pointers, and the note is what it was before them. */
  pointers?: { mode: () => AnticipateMode; find: (text: string) => PointerFind };
  /** The harness wake of a matching past chat. Absent: pointers only, exactly as before. */
  wake?: SessionWaker;
}) {
  /**
   * The pointers for this prompt, or why there are none, and the prompt's own words when the match was made on them
   * (not on the previous turn's). Synchronous: the indexes are in memory.
   */
  const findPointers = (
    input: PrepareInput,
    priv: boolean,
  ): { hits: PointerHit[]; skip?: string; own?: string } => {
    const gate = recommendable({
      text: input.text,
      sessionKey: input.sessionKey,
      trigger: input.trigger,
      provenanceKind: input.provenanceKind,
    });
    if (!gate.ok) {
      return { hits: [], skip: gate.why };
    }
    if (priv) {
      return { hits: [], skip: "private-source" };
    }
    const text = rankTextFor(input.text, input.previousUserText, () => false);
    if ("skip" in text) {
      return { hits: [], skip: text.skip };
    }
    const found = d.pointers?.find(text.text);
    if (!found) {
      return { hits: [] };
    }
    if ("skip" in found) {
      return { hits: [], skip: found.skip };
    }
    return {
      hits: [...found.notes, ...found.chats],
      ...(text.basis === "own" ? { own: text.text } : {}),
    };
  };

  return {
    async prepare(input: PrepareInput): Promise<Prepared> {
      const mode = d.mode();
      if (mode === "off") return { list: notAsked("local"), injected: false, usedJev: false };
      if (INJECTED_PROMPT.test(input.text) || isRuntimeNotice(input.text))
        return { list: notAsked("local"), injected: false, usedJev: false };
      try {
        d.corrections?.observe(input);
      } catch {
        /* a label is a convenience; it never breaks a prompt */
      }
      const cards = d.cards();
      const byId = new Map(cards.map((c) => [c.id, c]));

      let list: Shortlist;
      let usedJev = false;
      let questionVersion = 0;
      // Why the list is local, for the ledger row (the 2026-10-05 review could not count it).
      let skip: string | undefined;
      let skipDetail: string | undefined;
      // The Jev call's own time is kept even when the prompt does not wait for it. The run is known to the tracker only
      // after `noteShown`, so the time is passed on then if the call has finished, or when it finishes if it has not.
      let jevMs: number | undefined;
      let shownNoted = false;
      const t0 = performance.now();
      const done = (ms: number) => {
        jevMs = ms;
        if (shownNoted) d.tracker.noteJevMs(input.runId, ms);
      };
      // The shared ranking, for a task typed in a Tinker tab or the main chat. Anything else keeps the flat read.
      const shared = isInteractiveSession(input.sessionKey)
        ? d.ranking?.({
            runId: input.runId,
            sessionKey: input.sessionKey,
            text: input.text,
            ...(input.trigger ? { trigger: input.trigger } : {}),
            ...(input.provenanceKind ? { provenanceKind: input.provenanceKind } : {}),
            ...(input.previousUserText ? { previousUserText: input.previousUserText } : {}),
          })
        : undefined;
      try {
        if (shared) {
          shared.then(
            (r) => {
              done(
                r.ranked && r.result.jevMs !== undefined
                  ? r.result.jevMs
                  : Math.round(performance.now() - t0),
              );
            },
            () => undefined,
          );
          const got = await timeout(shared, d.budgetMs());
          if (got?.ranked) {
            list = shortlistFromResult(got.result);
            usedJev = got.result.source !== "local";
            skip = got.result.skip;
            skipDetail = got.result.skipDetail;
          } else if (got) {
            // Not owed a list, or nothing to say: nothing is shown and the ledger says which.
            list = notAsked("local");
            skipDetail = got.why;
          } else {
            list = cards.length > 0 ? localShortlist(input.text, cards) : notAsked("local");
            skip = "timeout";
          }
        } else {
          const reading = d.reader.readTask(input);
          reading.then(
            () => done(Math.round(performance.now() - t0)),
            () => undefined,
          );
          const read = await timeout(
            reading.catch(() => "error" as const),
            d.budgetMs(),
          );
          if (read && read !== "error") {
            list = read.shortlist;
            usedJev = read.usedJev;
            questionVersion = read.enhancementVersion;
            skip = read.skip;
            skipDetail = read.skipDetail;
          } else {
            // Late or failed: the prompt goes on with the instant local list.
            list = cards.length > 0 ? localShortlist(input.text, cards) : notAsked("local");
            skip = read === "error" ? "error" : "timeout";
          }
        }
      } catch {
        list = notAsked("local");
        skip = "error";
      }

      const priv = d.reader.isPrivate(input);
      // Overnight lists, in enforce only (shadow shows the agent nothing), are now and then shown in a shuffled order so
      // the loop can measure how much the agent follows position (paper 7.3). The list Jev made is kept for the ledger.
      let shuffled = false;
      if (
        d.learning &&
        mode === "enforce" &&
        list.shown &&
        shouldShuffle({
          enabled: d.learning.shuffle(),
          overnight: input.trigger === "cron",
          private: priv,
          entries: list.entries.length,
          rand: d.learning.rand(),
        })
      ) {
        list = shuffleList(list, d.learning.rand);
        shuffled = true;
      }

      // ONLY `enforce` hands the agent anything; memory pointers also need `anticipate.mode` inject.
      const inject = mode === "enforce" && (d.inject?.() ?? true);
      const pointerMode = d.pointers?.mode() ?? "off";
      // A wake this chat started on an earlier prompt that finished unread: handed over once, before this turn's own.
      let handover: string | undefined;
      try {
        handover = d.wake?.collect(input.sessionKey);
      } catch {
        handover = undefined;
      }
      let pointers: { hits: PointerHit[]; skip?: string; own?: string } | undefined;
      if (pointerMode !== "off") {
        try {
          pointers = findPointers(input, priv);
        } catch {
          pointers = { hits: [], skip: "error" };
        }
      }
      const showPointers = inject && pointerMode === "inject" && (pointers?.hits.length ?? 0) > 0;
      let wake: WakeConsider = {};
      if (d.wake && pointers && pointers.hits.length > 0) {
        try {
          wake = d.wake.consider({
            sessionKey: input.sessionKey,
            hits: pointers.hits,
            ownText: pointers.own,
            canStart: showPointers,
          });
        } catch {
          wake = {};
        }
      }

      d.tracker.noteShown(input.runId, {
        sessionKey: input.sessionKey,
        source: input.source,
        private: priv,
        list,
        questionVersion,
        ...(shuffled ? { shuffled } : {}),
        ...(d.learning ? { taskKind: classifyTaskDomain(input.text) } : {}),
        ...(skip ? { skip } : {}),
        ...(skipDetail ? { skipDetail } : {}),
        ...(pointers
          ? {
              pointers: pointers.hits.map((h) => ({
                kind: h.kind,
                id: h.id,
                cover: h.cover,
                terms: h.terms,
                injected: showPointers,
                ...(wake.outcome && wake.id === h.id ? { wake: wake.outcome } : {}),
              })),
              ...(pointers.skip ? { pointerSkip: pointers.skip } : {}),
            }
          : {}),
      });
      shownNoted = true;
      if (jevMs !== undefined) d.tracker.noteJevMs(input.runId, jevMs);
      if (d.learning?.replayAllowed(input)) {
        try {
          d.learning.recordReplay(input.runId, input.text);
        } catch {
          /* the replay set is a convenience; it never breaks a prompt */
        }
      }

      const shown: MemoryPointer[] = showPointers
        ? (pointers?.hits ?? []).map((h) => {
            const p: MemoryPointer = { kind: h.kind, label: h.label, where: h.id };
            if (h.date) {
              p.date = h.date;
            }
            return p;
          })
        : [];
      let note = shortlistContext(list, byId, shown);
      if (note && wake.line) {
        note = beforeLastLine(note, wake.line);
      }
      const parts = [inject ? handover : undefined, note].filter((p): p is string => Boolean(p));
      const text = parts.length > 0 ? parts.join("\n\n") : undefined;
      // In shadow the list and the pointers are recorded and the context stays untouched.
      const injected = inject && text !== undefined;
      return {
        list,
        ...(injected ? { text } : {}),
        injected,
        usedJev,
        ...(pointers?.hits.length ? { pointers: pointers.hits } : {}),
        ...(wake.outcome ? { wake } : {}),
      };
    },
  };
}

export type ShortlistSeam = ReturnType<typeof createShortlistSeam>;
