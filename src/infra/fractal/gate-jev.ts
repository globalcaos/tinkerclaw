/**
 * FORK 2026-10-09: the Fractal gate's Jev half and the one entry point the gateway method calls (charter C1, M1).
 *
 * WHY JEV. The rules in `gate.ts` only see phrases and counts. Jev reads the turn and adds what they cannot: whether a
 * long turn delivered something that deserves a check, a correction worded in a way no pattern lists, and how likely a
 * reflection is to leave a durable improvement at all (`worth`). It is optional and paid: no token means dormant, and
 * the rules alone decide (the ship path for a clone).
 *
 * WHAT LEAVES THE MACHINE. Only the prompt (head, ≤4000 chars), the reply tail (≤4000 chars), both through the shared Jev
 * text redaction, and the trail's counts and tool names. Never the session key, the run id, a tool's arguments or output.
 *
 * BUDGET. 1500 ms for the whole Jev read, enforced here as well as by the transport, so an injected or stuck transport
 * cannot hold the gate. Any failure reads as "Jev unavailable"; nothing throws to the caller.
 */
import { homedir } from "node:os";
import { jevToken, noteJevBreaker, reportJevResult } from "../jev/availability.js";
import { JevClient, type JevTransport } from "../jev/jev.js";
import { redactText } from "../jev/redact.js";
import type { JevQuestion, JevVerdict } from "../jev/types.js";
import {
  decideFractalGate,
  FRACTAL_GATE_MAX_TEXT,
  fractalGateFailOpen,
  fractalGateRules,
  isAgentPrompt,
  normalizeFractalGateParams,
  ownerWords,
  WORTH_LEVELS,
  type FractalGateParams,
  type FractalGateResult,
  type FractalJevRead,
  type FractalRulesRead,
  type FractalTrail,
  type WorthLevel,
} from "./gate.js";

export const FRACTAL_GATE_JEV_BASE_URL = "https://api.typesafe.ai";
export const FRACTAL_GATE_JEV_MODEL = "jev-latest";
// FORK 2026-10-09 — 6 s, not 1.5 s. Jev answers in 0.31-0.36 s, but under a fan-out the gateway's event loop lags
// (p99 delay 5.3 s and 8.6 s at 21:48 and 21:50 that day), so every live gate call ran out its 1.5 s and fell back to
// rules alone. Nobody waits on the gate (the Fractal runs in the background), so a longer wait costs nothing.
export const FRACTAL_GATE_BUDGET_MS = 6000;

/** What Jev is shown. Field names match the questions' `fields`, so the client's cache keys on exactly these values. */
export type FractalGateSituation = {
  id: string;
  prompt: { value: string };
  reply: { value: string };
  trail: { value: FractalTrail };
};

export const FRACTAL_GATE_QUESTIONS: readonly JevQuestion[] = [
  {
    id: "correction",
    version: 1,
    type: "noul",
    criteria: {},
    instructions:
      "Read the owner's prompt to his assistant. Does it correct, question or complain about the assistant's earlier " +
      "work: something done wrong, forgotten, left unfinished, not what he asked, or asked for again?",
    fields: ["prompt"],
  },
  {
    id: "friction",
    version: 1,
    type: "noul",
    criteria: {},
    instructions:
      "Read the trail of tool calls of the assistant's turn and the end of its reply. Did the turn fight its tools: " +
      "errors, retries, the same tool called over and over, a workaround, or a step that failed before it worked?",
    fields: ["trail", "reply"],
  },
  {
    id: "delivery",
    version: 1,
    type: "noul",
    criteria: {},
    instructions:
      "Read the owner's prompt, the end of the assistant's reply and its trail of tool calls. Was this a long or heavy " +
      "piece of work whose delivery deserves a second look: many steps, files or commits, or a claim that something " +
      "was built, fixed, deployed or sent?",
    fields: ["prompt", "reply", "trail"],
  },
  {
    id: "channel",
    version: 1,
    type: "noul",
    criteria: {},
    instructions:
      "Read the owner's prompt. Does he say he did not see, receive or get something the assistant produced, or that " +
      "it did not show, render, load or arrive?",
    fields: ["prompt"],
  },
  {
    id: "worth",
    version: 1,
    type: "score",
    criteria: [...WORTH_LEVELS],
    instructions:
      "Read the owner's prompt, the end of the assistant's reply and its trail of tool calls. How likely is it that " +
      "reflecting on this turn leaves a durable improvement: a fixed procedure, a fixed bug, a corrected record?",
    fields: ["prompt", "reply", "trail"],
  },
];

/** The state the client sends: the three fields only, redacted and cut. */
export function buildFractalGateState(
  s: FractalGateSituation,
  home: string = homedir(),
): Record<string, unknown> {
  const opts = { homeDir: home };
  const labels = new Map<string, string>();
  const cut = (text: string, tail: boolean): string => {
    const r = redactText(text, opts, labels);
    if (r.length <= FRACTAL_GATE_MAX_TEXT) {
      return r;
    }
    return tail ? r.slice(-FRACTAL_GATE_MAX_TEXT) : r.slice(0, FRACTAL_GATE_MAX_TEXT);
  };
  const t = s.trail.value;
  const trail: Record<string, unknown> = {
    calls: t.calls,
    toolCalls: t.toolCalls,
    toolErrors: t.toolErrors,
    repeated: t.repeated.slice(0, 20),
    tools: t.tools.slice(0, 30).map((x) => ({ name: x.name, n: x.n, err: x.err })),
  };
  if (t.durationMs !== undefined) {
    trail.durationMs = t.durationMs;
  }
  return {
    prompt: cut(s.prompt.value, false),
    reply: cut(s.reply.value, true),
    trail,
  };
}

export function fractalGateSituation(p: FractalGateParams): FractalGateSituation {
  // An agent's prompt is shown as written (Jev should see it is not the owner); the owner's is stripped of its wrapper.
  const prompt = isAgentPrompt(p.prompt) ? p.prompt : ownerWords(p.prompt);
  return {
    id: p.parentRunId || "fractal-gate",
    prompt: { value: prompt },
    reply: { value: p.reply },
    trail: { value: p.trail },
  };
}

/** Read Jev's verdicts into the decision's shape. Nothing answered = `undefined` (the rules decide). */
export function readFractalJevVerdicts(
  verdicts: readonly JevVerdict[],
): FractalJevRead | undefined {
  const probs: Record<string, number> = {};
  let worth: WorthLevel | undefined;
  for (const v of verdicts) {
    if (v.skipped) {
      continue;
    }
    if (v.type === "noul" && typeof v.answer === "number") {
      probs[v.questionId] = v.prob;
    } else if (v.questionId === "worth" && v.type === "score" && typeof v.answer === "number") {
      const i = Math.round(v.answer);
      if (i >= 0 && i < WORTH_LEVELS.length) {
        worth = WORTH_LEVELS[i];
        probs.worth = v.prob;
      }
    }
  }
  if (Object.keys(probs).length === 0) {
    return undefined;
  }
  return worth === undefined ? { probs } : { probs, worth };
}

export type FractalGateAsk = (
  s: FractalGateSituation,
  qs: JevQuestion[],
  o: { budgetMs: number },
) => Promise<JevVerdict[]>;

/** Jev's part in one decision: it answered, it was asked and did not answer, or it was not asked. */
export type FractalGateJevState = "answered" | "unavailable" | "off";

/** Everything one gate decision was made from, for the gate's log (2026-10-25). */
export type FractalGateDecision = {
  params: FractalGateParams;
  rules: FractalRulesRead;
  jev: FractalGateJevState;
  result: FractalGateResult;
};

export type FractalGateDeps = {
  /** The Jev call. Absent = rules only. */
  ask?: FractalGateAsk;
  /** True when a token exists and Jev has not refused it. Read per call. */
  jevOn?: () => boolean;
  budgetMs?: number;
  /** Told of every decision after it is made; a throw here never reaches the caller. */
  onDecision?: (d: FractalGateDecision) => void;
};

async function withinBudget<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** C1 end to end. Never throws: an internal error answers fail-open. */
export async function runFractalGate(
  raw: unknown,
  deps: FractalGateDeps = {},
): Promise<FractalGateResult> {
  try {
    const p = normalizeFractalGateParams(raw);
    const rules = fractalGateRules(p);
    let jev: FractalJevRead | undefined;
    let jevState: FractalGateJevState = "off";
    if (deps.ask && (deps.jevOn?.() ?? true)) {
      const budgetMs = deps.budgetMs ?? FRACTAL_GATE_BUDGET_MS;
      try {
        const verdicts = await withinBudget(
          deps.ask(fractalGateSituation(p), [...FRACTAL_GATE_QUESTIONS], { budgetMs }),
          budgetMs,
        );
        jev = verdicts ? readFractalJevVerdicts(verdicts) : undefined;
      } catch {
        jev = undefined;
      }
      jevState = jev ? "answered" : "unavailable";
    }
    const result = decideFractalGate(rules, jev);
    try {
      deps.onDecision?.({ params: p, rules, jev: jevState, result });
    } catch (err) {
      console.error("[fractal] gate decision hook failed", err);
    }
    return result;
  } catch (err) {
    return fractalGateFailOpen(err);
  }
}

/** The gateway's Jev call: one client per process, built on first use; the token is read per call, never kept. */
export function createFractalGateAsk(o: { transport?: JevTransport } = {}): FractalGateAsk {
  let client: JevClient<FractalGateSituation> | undefined;
  return (s, qs, opt) => {
    client ??= new JevClient<FractalGateSituation>({
      ...(o.transport ? { transport: o.transport } : {}),
      apiKey: jevToken,
      baseUrl: FRACTAL_GATE_JEV_BASE_URL,
      model: FRACTAL_GATE_JEV_MODEL,
      buildState: (sit) => buildFractalGateState(sit),
      report: reportJevResult,
      onBreaker: (open, until) => noteJevBreaker("fractal-gate", open, until),
    });
    return client.ask(s, qs, opt);
  };
}
