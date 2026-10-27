// THALAMUS v4 — the option set (design doc section 6.1; paper J19 v4.0 P§3 "one price per option").
//
// WHAT THIS IS FOR. An option is a rung together with a way of feeding it the work: the whole
// thread, a brief written for the step, or a digest of a long result. The router prices options,
// not rungs, because the same model costs very different amounts depending on how much of the
// conversation it must read and whether that part is warm.
//
// HOW IT WAS DERIVED. The step read's `needs` answer says how much of the conversation the step
// requires (paper P§4): all of it, the recent part, or only the item in hand. That decides which
// feeds are legal. A digest is only on the table when there is a long result to condense.
//
// PURE. No clock, no I/O.

import type { FrontierRung } from "./thalamus-frontier.js";
import type { Feed, Needs, Option } from "./thalamus-v4-types.js";

/** Token counts each feed would send. A feed with no count is not offered. */
export type FeedTokens = { thread: number; brief?: number; digest?: number };

/**
 * Which feeds a step may use. `all` needs the whole thread. `recent` may use a brief of the recent
 * part. `item` works from a brief of the item in hand (or the thread, if nothing shorter exists),
 * and from a digest when a long result is waiting to be condensed.
 */
export function allowedFeeds(needs: Needs, hasLongResult: boolean): Feed[] {
  switch (needs) {
    case "all":
      return ["thread"];
    case "recent":
      return ["thread", "brief"];
    case "item":
      return hasLongResult ? ["digest", "brief", "thread"] : ["brief", "thread"];
  }
}

export type EnumerateParams = {
  rungs: readonly FrontierRung[];
  needs: Needs;
  feedTokens: FeedTokens;
  hasLongResult?: boolean;
  /** Expected output tokens for a call on this rung; the caller owns the estimate. */
  expectedOutputTokens: (rung: FrontierRung) => number;
};

/** Every (rung, feed) pair the step may use, in rung order then feed order. */
export function enumerateOptions(p: EnumerateParams): Option[] {
  const feeds = allowedFeeds(p.needs, p.hasLongResult === true).filter(
    (f) => typeof p.feedTokens[f] === "number" && (p.feedTokens[f] as number) >= 0,
  );
  const out: Option[] = [];
  for (const rung of p.rungs) {
    for (const feed of feeds) {
      out.push({
        rung,
        feed,
        inputTokens: p.feedTokens[feed] as number,
        expectedOutputTokens: p.expectedOutputTokens(rung),
      });
    }
  }
  return out;
}
