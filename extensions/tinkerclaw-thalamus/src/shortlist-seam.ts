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

import {
  classifyTaskDomain,
  localShortlist,
  notAsked,
  shortlistContext,
  type EnhancementCard,
  type Shortlist,
  shouldShuffle,
  shuffleList,
} from "openclaw/plugin-sdk/fork-thalamus";
import type { ThalamusMode } from "./config.js";
import type { ReadInput, RoutingReader } from "./reads/routing-reader.js";
import type { UseTracker } from "./use-tracker.js";

export type Prepared = {
  list: Shortlist;
  /** The note for the agent. Present only when the mode is `enforce` and the list is shown. */
  text?: string;
  injected: boolean;
  usedJev: boolean;
};

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

export function createShortlistSeam(d: {
  reader: RoutingReader;
  cards: () => readonly EnhancementCard[];
  mode: () => ThalamusMode;
  /** `enforce.shortlist`: with it off, enforce records the list and injects nothing. Absent: on. */
  inject?: () => boolean;
  budgetMs: () => number;
  tracker: UseTracker;
  /** Learning switches and the draw. Absent: no shuffle and no replay capture, exactly as before phase F. */
  learning?: {
    shuffle: () => boolean;
    rand: () => number;
    /** May this task's redacted text enter the replay set? Only a source Jev is approved for. */
    replayAllowed: (input: ReadInput) => boolean;
    recordReplay: (taskId: string, text: string) => void;
  };
}) {
  return {
    async prepare(input: ReadInput & { runId: string }): Promise<Prepared> {
      const mode = d.mode();
      if (mode === "off") return { list: notAsked("local"), injected: false, usedJev: false };
      if (INJECTED_PROMPT.test(input.text))
        return { list: notAsked("local"), injected: false, usedJev: false };
      const cards = d.cards();
      const byId = new Map(cards.map((c) => [c.id, c]));

      let list: Shortlist;
      let usedJev = false;
      let questionVersion = 0;
      try {
        const read = await timeout(d.reader.readTask(input), d.budgetMs());
        if (read) {
          list = read.shortlist;
          usedJev = read.usedJev;
          questionVersion = read.enhancementVersion;
        } else {
          // Late or failed: the prompt goes on with the instant local list.
          list = cards.length > 0 ? localShortlist(input.text, cards) : notAsked("local");
        }
      } catch {
        list = notAsked("local");
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

      d.tracker.noteShown(input.runId, {
        sessionKey: input.sessionKey,
        source: input.source,
        private: priv,
        list,
        questionVersion,
        ...(shuffled ? { shuffled } : {}),
        ...(d.learning ? { taskKind: classifyTaskDomain(input.text) } : {}),
      });
      if (d.learning?.replayAllowed(input)) {
        try {
          d.learning.recordReplay(input.runId, input.text);
        } catch {
          /* the replay set is a convenience; it never breaks a prompt */
        }
      }

      const note = shortlistContext(list, byId);
      // ONLY `enforce` hands the agent anything. In shadow the list is recorded and the context stays untouched.
      const inject = mode === "enforce" && (d.inject?.() ?? true) && note !== undefined;
      return { list, ...(inject ? { text: note } : {}), injected: inject, usedJev };
    },
  };
}

export type ShortlistSeam = ReturnType<typeof createShortlistSeam>;
