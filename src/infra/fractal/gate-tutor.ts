/**
 * FORK 2026-10-25: the Fractal gate's tutor, one of the missing Grok tutors wired in (the after-the-fact
 * usefulness reviewers), after the Jev audit found the gate's skips invisible.
 *
 * WHAT IT DOES. A few of the turns the gate skipped (at most `dailyCap` a day, each skip taken with probability
 * `sampleRate` so the day's quota is not spent on its first hour) go to a second model AFTER the decision, which says
 * whether a reflection should have fired and on which trigger. The answer goes to `gate-reviews.jsonl` beside the gate's
 * log. It acts on nothing: the rows are evidence for changing the gate's questions or bars, the same way the amygdala's
 * reviews are (`extensions/tinkerclaw-amygdala/src/review.ts`, whose ladder and pattern this follows).
 *
 * BOUNDS. One review at a time, in the background; each rung has a hard time limit and a rung that fails, times out or
 * answers something unreadable moves to the next. The gate never waits on it. Jev is not used: the reviewer is a model
 * on the owner's subscription, through the gateway's embedded runner. The prompt and reply are redacted before they go.
 * Off with `fork.cognitive.fractalGateReview: "disabled"`.
 */
import { homedir } from "node:os";
import { redactText } from "../jev/redact.js";
import type { FractalGateRow } from "./gate-log.js";
import { FRACTAL_TRIGGERS, type FractalTrigger } from "./gate.js";

/** Same ladder as the amygdala's reviewer (its DEFAULT_REVIEW_LADDER, 2026-10-15). */
export const FRACTAL_GATE_REVIEW_LADDER: readonly string[] = [
  "claude-code/claude-sonnet-5-5",
  "claude-code/claude-haiku-4-5",
];
export const FRACTAL_GATE_REVIEW_DAILY_CAP = 5;
export const FRACTAL_GATE_REVIEW_SAMPLE_RATE = 0.3;
/** Per rung. The amygdala's reviewer measured 75 s to over 4 min on Grok; Sonnet answers well inside this. */
export const FRACTAL_GATE_REVIEW_TIMEOUT_MS = 180_000;

export type FractalGateReview = {
  verdict: "should-fire" | "right-to-skip";
  /** The trigger a reflection should have fired on (should-fire only). */
  trigger?: FractalTrigger;
  reason: string;
  confidence: "low" | "medium" | "high";
};

export type FractalGateReviewRow = {
  v: 1;
  ts: number;
  /** The gate row this judges (its `ts`), and the turn. */
  gateTs: number;
  sessionKey: string;
  parentRunId: string;
  status: "done" | "failed";
  model?: string;
  review?: FractalGateReview;
  error?: string;
};

/** One model call: the text it answered, or null. The signal aborts it at the rung's time limit. */
export type FractalGateReviewRun = (
  prompt: string,
  rung: string,
  signal: AbortSignal,
) => Promise<string | null>;

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const INSTRUCTIONS = `You audit a gate, after the fact, so its owner can see what it lets slip.
After each turn of an AI assistant (Jarvis) working for the architect, the gate decides whether a background "reflection" runs: a second pass that looks back at the turn and fixes what it taught (a procedure, a bug, a wrong record). It fires on four triggers: "correction" (the architect corrects, questions or complains about earlier work), "friction" (the turn fought its tools: errors, retries, workarounds), "delivery" (a long or heavy piece of work, or a claim that something was built, fixed, deployed or sent), "channel" (the architect says he did not see or get something). It also fires when its judge Jev rates a durable improvement likely.
The turn below was SKIPPED. You get the architect's prompt (start), the end of the reply, the counts of tool calls and errors, what the gate's rules found, and Jev's probabilities (absent when Jev did not answer).

Should a reflection have fired?
- "should-fire": the turn shows a real reason: a correction, a fight with the tools, a delivery worth a second look, a channel failure, or a lesson that should be written down. Name the trigger.
- "right-to-skip": a routine turn; a reflection would most likely change nothing.
Be strict: most skips are right. A long reply is not a delivery by itself; one failed grep is not friction.

Return ONLY one JSON object, no prose, no code fence:
{"verdict": "should-fire|right-to-skip", "trigger": "correction|friction|delivery|channel|none", "reason": "<=30 words, plain words", "confidence": "low|medium|high"}

THE SKIPPED TURN:
`;

/** The tutor's prompt for one skipped row; every free text redacted (the shared Jev redaction). */
export function buildFractalGateReviewPrompt(
  row: FractalGateRow,
  home: string = homedir(),
): string {
  const labels = new Map<string, string>();
  const r = (t: string | undefined, n: number): string =>
    cut(redactText(t ?? "", { homeDir: home }, labels), n);
  const input = {
    prompt: r(row.prompt, 1500),
    replyEnd: r(row.reply, 1500),
    trail: row.trail,
    rulesFound: row.rules,
    gateReasons: row.reasons.slice(0, 8).map((x) => r(x, 160)),
    ...(row.probs ? { jev: row.probs } : { jev: "did not answer" }),
  };
  return INSTRUCTIONS + JSON.stringify(input, null, 1);
}

export function parseFractalGateReview(text: string | null | undefined): FractalGateReview | null {
  if (!text) {
    return null;
  }
  const from = text.indexOf("{");
  const to = text.lastIndexOf("}");
  if (from < 0 || to <= from) {
    return null;
  }
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text.slice(from, to + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const verdict =
    o.verdict === "should-fire" || o.verdict === "right-to-skip" ? o.verdict : undefined;
  const reason = typeof o.reason === "string" ? o.reason.trim() : "";
  if (!verdict || !reason) {
    return null;
  }
  const trigger = FRACTAL_TRIGGERS.find((t) => t === o.trigger);
  const confidence = o.confidence === "low" || o.confidence === "high" ? o.confidence : "medium";
  return {
    verdict,
    ...(verdict === "should-fire" && trigger ? { trigger } : {}),
    reason: cut(reason, 300),
    confidence,
  };
}

/** Each rung in order under its own time limit; the first readable answer wins. */
export async function runFractalGateReviewLadder(
  prompt: string,
  ladder: readonly string[],
  run: FractalGateReviewRun,
  timeoutMs: number,
): Promise<{ review: FractalGateReview; model: string } | { error: string }> {
  const misses: string[] = [];
  for (const rung of ladder) {
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"timeout">((resolve) => {
      // Settle as a timeout before aborting, so a run that resolves on abort does not win the race.
      timer = setTimeout(() => {
        resolve("timeout");
        ac.abort(new Error("timeout"));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      const got = await Promise.race([run(prompt, rung, ac.signal), late]);
      if (got === "timeout") {
        misses.push(`${rung}: timeout`);
        continue;
      }
      const review = parseFractalGateReview(got);
      if (review) {
        return { review, model: rung };
      }
      misses.push(`${rung}: ${got ? "not an answer" : "empty"}`);
    } catch (err) {
      misses.push(`${rung}: ${String(err).slice(0, 120)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: misses.join("; ") || "no rung" };
}

export type FractalGateTutorDeps = {
  save: (row: FractalGateReviewRow) => Promise<void> | void;
  ladder?: readonly string[];
  timeoutMs?: number;
  dailyCap?: number;
  sampleRate?: number;
  now?: () => number;
  random?: () => number;
  homeDir?: string;
};

export type FractalGateTutor = {
  /** Offer a gate row with the call to judge it by; true when it was queued. Fired rows are never taken. */
  observe(row: FractalGateRow, run: FractalGateReviewRun): boolean;
  idle(): Promise<void>;
};

export function createFractalGateTutor(d: FractalGateTutorDeps): FractalGateTutor {
  const ladder = d.ladder ?? FRACTAL_GATE_REVIEW_LADDER;
  const timeoutMs = d.timeoutMs ?? FRACTAL_GATE_REVIEW_TIMEOUT_MS;
  const cap = d.dailyCap ?? FRACTAL_GATE_REVIEW_DAILY_CAP;
  const rate = d.sampleRate ?? FRACTAL_GATE_REVIEW_SAMPLE_RATE;
  const now = d.now ?? Date.now;
  const random = d.random ?? Math.random;
  const queue: { row: FractalGateRow; run: FractalGateReviewRun }[] = [];
  let running = false;
  let waiters: (() => void)[] = [];
  let day = "";
  let taken = 0;

  const work = async (row: FractalGateRow, run: FractalGateReviewRun): Promise<void> => {
    const base = {
      v: 1 as const,
      gateTs: row.ts,
      sessionKey: row.sessionKey,
      parentRunId: row.parentRunId,
    };
    try {
      const out = await runFractalGateReviewLadder(
        buildFractalGateReviewPrompt(row, d.homeDir),
        ladder,
        run,
        timeoutMs,
      );
      await d.save(
        "review" in out
          ? { ...base, ts: now(), status: "done", model: out.model, review: out.review }
          : { ...base, ts: now(), status: "failed", error: out.error },
      );
    } catch (err) {
      console.error("[fractal] gate review failed", err);
    }
  };

  const pump = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    while (queue.length > 0) {
      const job = queue.shift();
      if (job) {
        await work(job.row, job.run);
      }
    }
    running = false;
    const w = waiters;
    waiters = [];
    for (const f of w) {
      f();
    }
  };

  return {
    observe(row, run) {
      if (row.fire || cap <= 0) {
        return false;
      }
      const today = new Date(now()).toDateString();
      if (today !== day) {
        day = today;
        taken = 0;
      }
      if (taken >= cap || random() >= rate) {
        return false;
      }
      taken++;
      queue.push({ row, run });
      void pump();
      return true;
    },
    idle() {
      if (!running && queue.length === 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}
