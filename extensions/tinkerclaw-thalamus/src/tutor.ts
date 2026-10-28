// The tutors (2026-10-25): after-the-fact reviews of Thalamus's two choices, routing and the enhancement list.
//
// WHAT THIS IS FOR. The owner asked to "wire in all the missing Grok tutors" after the Jev audit: every routing outcome
// row says `done` (21,131 decisions), so a model that was too weak or too strong for a task could not be told apart, and
// the enhancement list hit 8.4 % precision with 987 used tools never suggested, with nothing saying which shown card did
// not fit or which used tool should have been on the list. A second model now judges a sample of finished runs:
//   - routing: was the model (and effort) that ran too weak (it failed, retried, refused, or the owner corrected it in
//     his next prompt), too strong (a trivial task on a top model), or right? Rows go to `routing_reviews`.
//   - enhancements: which shown card did not fit the task (a false positive), and which tool the agent used off the
//     list should have been on it (a false negative)? Rows go to `enh_reviews`.
//
// RECORDS ONLY. Thalamus does not learn online (2026-10-09 decision: it improves by iterations, offline); these rows
// are the evidence for those iterations and change no route, card or list. Same pattern and ladder as the amygdala's
// reviewer (`extensions/tinkerclaw-amygdala/src/review.ts`): one call at a time in the background, a hard time limit per
// rung, a daily cap per kind, every free text redacted, Jev not used. A run from a private source is never sent.
// Off with `tutor.enabled: false`.

import { redactText } from "openclaw/plugin-sdk/fork-jev";
import { ownerWords } from "openclaw/plugin-sdk/fork-prompt-envelope";

/** The amygdala reviewer's ladder (its DEFAULT_REVIEW_LADDER, 2026-10-15). */
export const DEFAULT_TUTOR_LADDER: readonly string[] = [
  "claude-code/claude-sonnet-5-5",
  "claude-code/claude-haiku-4-5",
];

export type TutorRun = (
  prompt: string,
  rung: string,
  signal: AbortSignal,
) => Promise<string | null>;
export type TutorConfidence = "low" | "medium" | "high";

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function jsonIn(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) {
    return null;
  }
  const from = text.indexOf("{");
  const to = text.lastIndexOf("}");
  if (from < 0 || to <= from) {
    return null;
  }
  try {
    const o: unknown = JSON.parse(text.slice(from, to + 1));
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const confidenceOf = (v: unknown): TutorConfidence => (v === "low" || v === "high" ? v : "medium");

/** Each rung in order under its own time limit; the first answer `parse` accepts wins. */
export async function runTutorLadder<T>(
  prompt: string,
  ladder: readonly string[],
  run: TutorRun,
  timeoutMs: number,
  parse: (text: string | null) => T | null,
): Promise<{ value: T; model: string } | { error: string }> {
  const misses: string[] = [];
  for (const rung of ladder) {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"timeout">((resolve) => {
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
      const value = parse(got);
      if (value !== null) {
        return { value, model: rung };
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

// ─── routing ──────────────────────────────────────────────────────────────────────────────────────

/** What a finished run shows about its routing, gathered when it ends (no bodies beyond clipped excerpts). */
export type RoutingSnapshot = {
  runId: string;
  sessionKey: string;
  ts: number;
  /** The owner's words that started the run, clipped. */
  aim?: string;
  /** The models that answered, from the outcome rows (or the incumbent when none came back). */
  ran: string[];
  /** The effort the router read for the run's first call. */
  effort?: string;
  /** What the router would have picked for the first call, and whether it acted. */
  pick?: { model: string; effort?: string; applied: boolean };
  calls: number;
  toolCalls: number;
  toolErrors: number;
  ended: "end" | "error";
  stopReasons: string[];
  outputTokens: number;
  refused: boolean;
  /** The owner's next prompt in the same chat, when it came before the review ran: a correction shows here. */
  ownerNext?: string;
};

export type RoutingReview = {
  verdict: "too-weak" | "too-strong" | "right";
  reason: string;
  confidence: TutorConfidence;
};

const ROUTING_INSTRUCTIONS = `You review, after the fact, which model ran one task of an AI assistant (Jarvis) working for the architect, so the router that picks models can be improved offline.
You get what the architect asked (start), the model(s) that answered and the effort, what the router would have picked, how many model calls and tool calls the run took and how many tools failed, how it ended (stop reasons, a run error, a refusal), and the architect's next message in the same chat when there was one.

Judge the model that RAN:
- "too-weak": it failed, retried, refused, looped on errors, or the architect's next message corrects or complains about the work; a stronger model would likely have done it right.
- "too-strong": a trivial task (a lookup, a short reply, one simple command) ran on a top model or at high effort; a small fast model would have done the same.
- "right": the model fit the task.
Be strict: most runs are right. A tool error the agent recovered from is not a weak model; a long task is not a strong-model task by itself.

Return ONLY one JSON object, no prose, no code fence:
{"verdict": "too-weak|too-strong|right", "reason": "<=30 words, plain words", "confidence": "low|medium|high"}

THE RUN:
`;

export function buildRoutingReviewPrompt(s: RoutingSnapshot, homeDir: string): string {
  const labels = new Map<string, string>();
  const r = (t: string, n: number): string => cut(redactText(t, { homeDir }, labels), n);
  const input = {
    ...(s.aim ? { ownerAsked: r(s.aim, 700) } : {}),
    ran: s.ran,
    ...(s.effort ? { effort: s.effort } : {}),
    ...(s.pick ? { routerWouldPick: s.pick } : {}),
    modelCalls: s.calls,
    toolCalls: s.toolCalls,
    toolErrors: s.toolErrors,
    ended: s.ended,
    stopReasons: s.stopReasons.slice(0, 6),
    outputTokens: s.outputTokens,
    refused: s.refused,
    ...(s.ownerNext ? { ownerNext: r(s.ownerNext, 500) } : { ownerNext: "none yet" }),
  };
  return ROUTING_INSTRUCTIONS + JSON.stringify(input, null, 1);
}

export function parseRoutingReview(text: string | null): RoutingReview | null {
  const o = jsonIn(text);
  if (!o) {
    return null;
  }
  const verdict =
    o.verdict === "too-weak" || o.verdict === "too-strong" || o.verdict === "right"
      ? o.verdict
      : undefined;
  const reason = typeof o.reason === "string" ? o.reason.trim() : "";
  if (!verdict || !reason) {
    return null;
  }
  return { verdict, reason: cut(reason, 300), confidence: confidenceOf(o.confidence) };
}

// ─── enhancements ─────────────────────────────────────────────────────────────────────────────────

export type EnhCardBrief = { cardId: string; name: string; purpose: string };

/** One finished task's list: what was shown and what the agent used, on the list or off it. */
export type EnhSnapshot = {
  taskId: string;
  sessionKey: string;
  ts: number;
  aim?: string;
  shown: EnhCardBrief[];
  used: (EnhCardBrief & { onList: boolean })[];
  outcome: string;
};

export type EnhReview = {
  /** Shown cards that did not fit the task (false positives). */
  notFit: string[];
  /** Tools used off the list that should have been on it (false negatives). */
  shouldSuggest: string[];
  reason: string;
  confidence: TutorConfidence;
};

const ENH_INSTRUCTIONS = `You review, after the fact, the short list of skills, recipes and plugins ("cards") an AI assistant (Jarvis) was shown for one task from the architect, so the list can be improved offline.
You get what the architect asked (start), the cards the list showed (id, name, purpose), and the cards the agent actually used, each marked onList true or false.

Judge two things:
- "notFit": the ids of SHOWN cards that do not fit this task at all (a reader would not open them for it). A shown card the agent did not use can still fit.
- "shouldSuggest": the ids of USED cards with onList false that clearly belonged on the list for this task. Leave out an incidental use.
Be strict both ways. Empty lists are a normal answer.

Return ONLY one JSON object, no prose, no code fence:
{"notFit": ["<id>", ...], "shouldSuggest": ["<id>", ...], "reason": "<=30 words, plain words", "confidence": "low|medium|high"}

THE TASK:
`;

export function buildEnhReviewPrompt(s: EnhSnapshot, homeDir: string): string {
  const labels = new Map<string, string>();
  const r = (t: string, n: number): string => cut(redactText(t, { homeDir }, labels), n);
  const brief = (c: EnhCardBrief) => ({ id: c.cardId, name: c.name, purpose: cut(c.purpose, 160) });
  const input = {
    ...(s.aim ? { ownerAsked: r(s.aim, 700) } : {}),
    shown: s.shown.slice(0, 12).map(brief),
    used: s.used.slice(0, 12).map((c) => ({
      id: c.cardId,
      name: c.name,
      purpose: cut(c.purpose, 160),
      onList: c.onList,
    })),
    taskEnded: s.outcome,
  };
  return ENH_INSTRUCTIONS + JSON.stringify(input, null, 1);
}

export function parseEnhReview(text: string | null, s: EnhSnapshot): EnhReview | null {
  const o = jsonIn(text);
  if (!o) {
    return null;
  }
  const reason = typeof o.reason === "string" ? o.reason.trim() : "";
  if (!reason || !Array.isArray(o.notFit) || !Array.isArray(o.shouldSuggest)) {
    return null;
  }
  // Only ids it was shown count: a made-up id is dropped, not stored.
  const shown = new Set(s.shown.map((c) => c.cardId));
  const offList = new Set(s.used.filter((c) => !c.onList).map((c) => c.cardId));
  const ids = (v: unknown[], allowed: Set<string>) => [
    ...new Set(v.filter((x): x is string => typeof x === "string" && allowed.has(x))),
  ];
  return {
    notFit: ids(o.notFit, shown),
    shouldSuggest: ids(o.shouldSuggest, offList),
    reason: cut(reason, 300),
    confidence: confidenceOf(o.confidence),
  };
}

// ─── the queue ────────────────────────────────────────────────────────────────────────────────────

export type RoutingReviewRow = {
  runId: string;
  ts: number;
  session: string;
  ran: string;
  effort?: string;
  pick?: string;
  hadNext: boolean;
  status: "done" | "failed";
  reviewer?: string;
  review?: RoutingReview;
  error?: string;
};

export type EnhReviewRow = {
  taskId: string;
  ts: number;
  session: string;
  shown: string[];
  usedOffList: string[];
  status: "done" | "failed";
  reviewer?: string;
  review?: EnhReview;
  error?: string;
};

export type TutorDeps = {
  run: TutorRun;
  ladder?: readonly string[];
  timeoutMs: number;
  /** Reviews a day, per kind. */
  dailyCap: { routing: number; enh: number };
  /** Each eligible run is taken with this probability, so the cap is not spent on the morning. */
  sampleRate: number;
  /** How long a routing review waits for the owner's next prompt before it runs without one. */
  followUpMs: number;
  save: { routing(r: RoutingReviewRow): void; enh(r: EnhReviewRow): void };
  now: () => number;
  random?: () => number;
  homeDir: string;
  /** Test seam for the follow-up wait. */
  schedule?: (fn: () => void, ms: number) => void;
  logger?: { warn(message: string): void };
};

type Job = { kind: "routing"; snap: RoutingSnapshot } | { kind: "enh"; snap: EnhSnapshot };

export function createTutor(d: TutorDeps) {
  const ladder = d.ladder ?? DEFAULT_TUTOR_LADDER;
  const random = d.random ?? Math.random;
  const schedule =
    d.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
    });
  const queue: Job[] = [];
  /** Routing snapshots waiting for the owner's next prompt, by chat. */
  const waiting = new Map<string, RoutingSnapshot>();
  let running = false;
  let waiters: (() => void)[] = [];
  let day = "";
  const taken = { routing: 0, enh: 0 };
  /** The slot just taken, given back when the run has nothing to judge. */
  const lastSlot = { routing: false, enh: false };

  const slot = (kind: "routing" | "enh"): boolean => {
    const today = new Date(d.now()).toDateString();
    if (today !== day) {
      day = today;
      taken.routing = taken.enh = 0;
    }
    if (taken[kind] >= d.dailyCap[kind] || random() >= d.sampleRate) {
      return false;
    }
    taken[kind]++;
    lastSlot[kind] = true;
    return true;
  };

  const work = async (j: Job): Promise<void> => {
    try {
      if (j.kind === "routing") {
        const s = j.snap;
        const out = await runTutorLadder(
          buildRoutingReviewPrompt(s, d.homeDir),
          ladder,
          d.run,
          d.timeoutMs,
          parseRoutingReview,
        );
        const base = {
          runId: s.runId,
          ts: d.now(),
          session: s.sessionKey,
          ran: s.ran.join(","),
          ...(s.effort ? { effort: s.effort } : {}),
          ...(s.pick ? { pick: `${s.pick.model}${s.pick.effort ? `/${s.pick.effort}` : ""}` } : {}),
          hadNext: s.ownerNext !== undefined,
        };
        d.save.routing(
          "value" in out
            ? { ...base, status: "done", reviewer: out.model, review: out.value }
            : { ...base, status: "failed", error: out.error },
        );
      } else {
        const s = j.snap;
        const out = await runTutorLadder(
          buildEnhReviewPrompt(s, d.homeDir),
          ladder,
          d.run,
          d.timeoutMs,
          (t) => parseEnhReview(t, s),
        );
        const base = {
          taskId: s.taskId,
          ts: d.now(),
          session: s.sessionKey,
          shown: s.shown.map((c) => c.cardId),
          usedOffList: s.used.filter((c) => !c.onList).map((c) => c.cardId),
        };
        d.save.enh(
          "value" in out
            ? { ...base, status: "done", reviewer: out.model, review: out.value }
            : { ...base, status: "failed", error: out.error },
        );
      }
    } catch (err) {
      d.logger?.warn(`[thalamus] tutor review failed: ${String(err)}`);
    }
  };

  const pump = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    while (queue.length > 0) {
      const j = queue.shift();
      if (j) {
        await work(j);
      }
    }
    running = false;
    const w = waiters;
    waiters = [];
    for (const f of w) {
      f();
    }
  };
  const enqueue = (j: Job): void => {
    queue.push(j);
    void pump();
  };
  const release = (sessionKey: string): void => {
    const s = waiting.get(sessionKey);
    if (!s) {
      return;
    }
    waiting.delete(sessionKey);
    enqueue({ kind: "routing", snap: s });
  };

  return {
    /**
     * A run ended: its routing waits for the owner's next prompt (or `followUpMs`); its list is judged now. The
     * snapshots are built only for a run the sample takes, so an untaken run costs no store read.
     */
    afterRun(
      routingOf: () => RoutingSnapshot | undefined,
      enhOf: () => EnhSnapshot | undefined,
    ): void {
      const routing = slot("routing") ? routingOf() : undefined;
      if (routing === undefined && lastSlot.routing) {
        taken.routing--;
      }
      lastSlot.routing = false;
      if (routing) {
        // A newer run in the same chat replaces an older one still waiting: that one is judged without a next prompt.
        release(routing.sessionKey);
        waiting.set(routing.sessionKey, routing);
        const key = routing.sessionKey;
        const runId = routing.runId;
        schedule(() => {
          if (waiting.get(key)?.runId === runId) {
            release(key);
          }
        }, d.followUpMs);
      }
      const enh = slot("enh") ? enhOf() : undefined;
      if (enh && (enh.shown.length > 0 || enh.used.some((c) => !c.onList))) {
        enqueue({ kind: "enh", snap: enh });
      } else if (lastSlot.enh) {
        taken.enh--;
      }
      lastSlot.enh = false;
    },
    /** A refusal was read for this chat's latest turn: the waiting routing review says so. */
    noteRefusal(sessionKey: string): void {
      const s = waiting.get(sessionKey);
      if (s) {
        s.refused = true;
      }
    },
    /** The owner's next prompt in a chat: the waiting routing review reads it, then runs. */
    notePrompt(sessionKey: string, prompt: string): void {
      const s = waiting.get(sessionKey);
      if (!s) {
        return;
      }
      const words = ownerWords(prompt);
      if (words) {
        s.ownerNext = words.slice(0, 1000);
      }
      release(sessionKey);
    },
    idle(): Promise<void> {
      if (!running && queue.length === 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    waiting: (): number => waiting.size,
  };
}

export type Tutor = ReturnType<typeof createTutor>;
