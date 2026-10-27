/**
 * FORK 2026-10-10 (J7 gap #4, plan Phase 1.4): was a recorded purple line a joke attempt or a plain summary?
 *
 * The store logged every line, joke or summary, so "no reaction" mostly measured summaries and the band (about one
 * line in three) could not be counted. Code cannot tell them apart (a joke is usually a quip after a factual summary),
 * so Jev judges it, as the harness allows for judgement. One yes/no question, one field: the line, redacted. Nothing
 * else of the chat is sent.
 *
 * Asked only when Jev is armed AND the owner already lets real text go to Jev (Thalamus `jev.sendRealSituations`).
 * Otherwise the judge answers `undefined` and the row stays "not judged"; it never guesses.
 */

import { homedir } from "node:os";
import {
  JevClient,
  jevOn,
  jevToken,
  noteJevBreaker,
  redactText,
  reportJevResult,
  type JevQuestion,
  type JevTransport,
  type JevVerdict,
} from "openclaw/plugin-sdk/fork-jev";

export const JOKE_QUESTION: JevQuestion = {
  id: "limbic-line-is-joke",
  version: 1,
  type: "noul",
  criteria: { true: "yes", false: "no" },
  instructions:
    "This is the one-sentence spoken line an assistant put at the top of its reply. Is it a joke attempt " +
    "(deadpan understatement, a remark on being a machine, a dry field note, absurd precision, a literal idiom, " +
    "software spoken of as a person), rather than a plain summary of what was done?",
  fields: ["line"],
};

type LineSituation = { id: string; line: { value: string } };
export type JokeAsk = (s: LineSituation, qs: JevQuestion[]) => Promise<JevVerdict[]>;

/** A `noul` answer at or above this is a joke attempt. */
export const JOKE_AT = 0.5;

/**
 * The verdict as a boolean, or undefined when Jev skipped or gave no answer. Jev answers a yes/no (`noul`) question with
 * its probability, a number (src/infra/jev/jev.ts reads `answers[id].noul`). Until 2026-10-25 only `true`/`false` were
 * read, so every live verdict came back undefined and no spoken line was ever marked (20 of 20 rows unjudged).
 */
export function verdictIsJoke(v: JevVerdict | undefined): boolean | undefined {
  if (!v || v.skipped) {
    return undefined;
  }
  if (typeof v.answer === "number") {
    return Number.isFinite(v.answer) ? v.answer >= JOKE_AT : undefined;
  }
  if (v.answer === true || v.answer === "true") {
    return true;
  }
  if (v.answer === false || v.answer === "false") {
    return false;
  }
  return undefined;
}

export function createJokeJudge(o: {
  /** Live consent: may real text go to Jev? Read per call, so a config change applies without a restart. */
  allowed: () => boolean;
  baseUrl: string;
  model: string;
  /** Test seam; production asks through the shared Jev client. */
  ask?: JokeAsk;
  armed?: () => boolean;
  /** Test seams for the real client: its transport and token. */
  transport?: JevTransport;
  apiKey?: () => string | undefined;
}): (line: string) => Promise<boolean | undefined> {
  const armed = o.armed ?? jevOn;
  let ask = o.ask;
  if (!ask) {
    const client = new JevClient<LineSituation>({
      ...(o.transport ? { transport: o.transport } : {}),
      apiKey: o.apiKey ?? jevToken,
      baseUrl: o.baseUrl,
      model: o.model,
      buildState: (s) => ({ line: redactText(s.line.value, { homeDir: homedir() }, new Map()) }),
      report: reportJevResult,
      onBreaker: (open, until) => noteJevBreaker("computational-humor", open, until),
    });
    ask = (s, qs) => client.ask(s, qs);
  }
  return async (line) => {
    if (!o.allowed() || !armed()) {
      return undefined;
    }
    try {
      const [v] = await ask({ id: `line-${Date.now()}`, line: { value: line } }, [JOKE_QUESTION]);
      return verdictIsJoke(v);
    } catch {
      return undefined;
    }
  };
}
