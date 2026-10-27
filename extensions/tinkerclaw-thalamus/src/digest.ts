// The digest service (design doc unit D3; paper J19 v4.1 §5.2, switch rule 2).
//
// WHAT THIS IS FOR. A long text tool result is worth condensing when a reader can hand back a much shorter one for less
// than carrying the raw text costs (the pure arithmetic is `decideDigest`). This service applies that per tool result:
//   - it RECORDS the decision, always, in shadow and enforce (`observe`, called from the tool-result event, so no tool
//     path is touched);
//   - it ACTS only when the mode is enforce and `enforce.digest` is on (`digest`, registered on the runner's async
//     tool-result seam and used by the Claude Code PostToolUse route): keep the raw on disk first, ask the reader
//     (through an injected model caller), and hand back the note that replaces the result.
//
// SAFE BY CONSTRUCTION. Every failure path returns "keep the result as it was". The raw copy is written BEFORE the
// reader is asked, so a digest never exists without its raw; a result that cannot be kept is not digested. A hand-picked
// model is never touched (the decision says so). Private sources only reach the providers the router already approved
// for them, because the reader is chosen from the router's own options.

import {
  approxTokens,
  DEFAULT_LATER_STEPS,
  DEFAULT_RUN_LENGTH_N,
  decideDigest,
  digestBrief,
  digestNote,
  freshPointDecision,
  vendorFamilyOf,
  type DigestDecision,
  type ToolResultDigestInput,
} from "openclaw/plugin-sdk/fork-thalamus";
import type { ThalamusConfig } from "./config.js";
import type { ModelCaller } from "./model-caller.js";
import type { RawStore } from "./raw-store.js";
import type { RunStates } from "./run-state.js";
import type { ThalamusStore } from "./store.js";

/** A digest that is not clearly shorter than the result is not worth the note around it. */
export const MAX_DIGEST_SHARE = 0.6;

export type DigestPlan = {
  decision: DigestDecision;
  readerKey?: string;
  readerEffort?: string;
  family?: string;
  callIndex?: number;
  /** Why there is no reader, when there is none. */
  noReader?: "hand-picked" | "no-option";
};

export type DigestServiceDeps = {
  cfg: () => ThalamusConfig;
  runs: RunStates;
  store: () => ThalamusStore | undefined;
  raw: RawStore;
  caller: () => ModelCaller | undefined;
  now: () => number;
  defer: (fn: () => void) => void;
  onError?: (err: unknown) => void;
};

export function createDigestService(d: DigestServiceDeps) {
  const acts = (): boolean => {
    const c = d.cfg();
    return c.mode === "enforce" && c.enforce.digest;
  };

  /** Would condensing this result pay, and with which reader? Synchronous, local, no I/O. */
  function plan(runId: string, text: string): DigestPlan | undefined {
    const c = d.cfg();
    const tokens = approxTokens(text);
    if (tokens < c.digest.minResultTokens) return undefined;
    const base = d.runs.get(runId)?.base;
    if (!base) return undefined;
    if (base.handPicked) {
      return {
        decision: decideDigest({
          resultTokens: tokens,
          incumbentKey: base.incumbentKey,
          readerKey: base.incumbentKey,
          handPicked: true,
        }),
        noReader: "hand-picked",
        callIndex: base.callIndex,
      };
    }
    const fp = freshPointDecision(base, "read", tokens + 500);
    if (!fp) {
      return {
        decision: { digest: false, reason: "unpriced", resultTokens: tokens },
        noReader: "no-option",
        callIndex: base.callIndex,
      };
    }
    const readerKey = fp.chosen.rung.key;
    const level = base.step.runLength;
    const laterSteps =
      level.source === "jev" && level.conf >= (base.confidenceFloor ?? 0.6)
        ? Math.max(DEFAULT_LATER_STEPS, DEFAULT_RUN_LENGTH_N[level.value] ?? 0)
        : DEFAULT_LATER_STEPS;
    return {
      decision: decideDigest({
        resultTokens: tokens,
        incumbentKey: base.incumbentKey,
        readerKey,
        laterSteps,
        digestTokens: c.digest.digestTokens,
        minResultTokens: c.digest.minResultTokens,
      }),
      readerKey,
      readerEffort: fp.chosen.rung.effort,
      family: vendorFamilyOf(readerKey),
      callIndex: base.callIndex,
    };
  }

  function record(
    input: { runId: string; toolCallId: string; toolName: string },
    p: DigestPlan,
    acted: boolean,
    reason: string,
    extra: Record<string, unknown> = {},
  ): void {
    const at = d.now();
    const session = d.runs.get(input.runId)?.sessionKey;
    const mode = d.cfg().mode;
    d.defer(() => {
      try {
        d.store()?.insertFreshPoint({
          id: `${input.runId}:digest:${input.toolCallId}`,
          ts: at,
          ...(session ? { session } : {}),
          runId: input.runId,
          ...(p.callIndex !== undefined ? { callIndex: p.callIndex } : {}),
          kind: "digest",
          mode,
          acted,
          reason,
          ...(p.readerKey ? { model: p.readerKey } : {}),
          ...(p.family ? { family: p.family } : {}),
          detail: {
            tool: input.toolName,
            resultTokens: p.decision.resultTokens,
            ...(p.decision.digestTokens !== undefined
              ? { digestTokens: p.decision.digestTokens }
              : {}),
            ...(p.decision.dOverS !== undefined ? { dOverS: p.decision.dOverS } : {}),
            ...(p.decision.margin !== undefined ? { margin: p.decision.margin } : {}),
            ...(p.decision.q !== undefined ? { q: p.decision.q } : {}),
            ...(p.decision.laterSteps !== undefined ? { laterSteps: p.decision.laterSteps } : {}),
            ...(p.readerEffort ? { readerEffort: p.readerEffort } : {}),
            ...extra,
          },
        });
      } catch (err) {
        d.onError?.(err);
      }
    });
  }

  return {
    plan,

    /** Shadow and enforce: write down what would be done to this result. Changes nothing, touches no tool. */
    observe(input: { runId: string; toolCallId: string; toolName: string; text: string }): void {
      try {
        const p = plan(input.runId, input.text);
        if (p) record(input, p, false, p.noReader ?? p.decision.reason);
      } catch (err) {
        d.onError?.(err);
      }
    },

    /** Enforce with `enforce.digest`: the replacement text for this result, or undefined to keep it. */
    async digest(input: ToolResultDigestInput): Promise<string | undefined> {
      try {
        if (!acts()) return undefined;
        const runId = input.meta.runId;
        const rec = { runId, toolCallId: input.toolCallId, toolName: input.toolName };
        const p = plan(runId, input.text);
        if (!p) return undefined;
        if (!p.decision.digest || !p.readerKey) {
          record(rec, p, false, p.noReader ?? p.decision.reason);
          return undefined;
        }
        const call = d.caller();
        if (!call) {
          record(rec, p, false, "no-reader");
          return undefined;
        }
        const run = d.runs.get(runId);
        const kept = d.raw.put({
          session: run?.sessionKey ?? input.meta.sessionKey ?? runId,
          tool: input.toolName,
          text: input.text,
          tokens: p.decision.resultTokens,
          digestTokens: p.decision.digestTokens,
        });
        if (!kept) {
          record(rec, p, false, "raw-not-kept");
          return undefined;
        }
        const budget = p.decision.digestTokens ?? d.cfg().digest.digestTokens;
        const reply = await call({
          modelKey: p.readerKey,
          effort: p.readerEffort,
          prompt: `${digestBrief({ aim: run?.aim ?? "", toolName: input.toolName, digestTokens: budget })}\n\nRESULT:\n${input.text}`,
          maxTokens: Math.ceil(budget * 2),
          timeoutMs: d.cfg().digest.timeoutMs,
        });
        if (!reply || reply.text.trim().length === 0) {
          record(rec, p, false, "reader-failed", { rawName: kept.name });
          return undefined;
        }
        const got = approxTokens(reply.text);
        if (got >= p.decision.resultTokens * MAX_DIGEST_SHARE) {
          record(rec, p, false, "not-shorter", { rawName: kept.name, gotTokens: got });
          return undefined;
        }
        d.runs.noteOther(runId);
        record(rec, p, true, "digested", {
          rawName: kept.name,
          gotTokens: got,
          ...(reply.input !== undefined ? { readerInput: reply.input } : {}),
          ...(reply.output !== undefined ? { readerOutput: reply.output } : {}),
        });
        return digestNote({
          toolName: input.toolName,
          rawTokens: p.decision.resultTokens,
          rawName: kept.name,
          rawPath: kept.path,
          digest: reply.text,
        });
      } catch (err) {
        d.onError?.(err);
        return undefined;
      }
    },

    recall: (name: string): string | undefined => d.raw.recall(name),
    acts,
  };
}

export type DigestService = ReturnType<typeof createDigestService>;
