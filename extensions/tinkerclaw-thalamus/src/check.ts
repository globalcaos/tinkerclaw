// The check by another family (design doc unit D4; paper J19 v4.1 §5.4 rule 4, §8 step 8).
//
// WHAT THIS IS FOR. Work that commits to something outside the conversation, or states a fact others will rely on, is
// checked by a model of a different family from the builder's, fed the work and its claim and not the thread. A checker
// that shares the builder's model shares its blind spots.
//   - RECORD, always (shadow and enforce): at the end of a run that committed or claimed, write down who would check it
//     and why, or why nobody could (`observeEnd`). Nothing is called and nothing changes.
//   - ACT, only in enforce with `enforce.check` (`finalize`, on the runner's `before_agent_finalize` hook): ask the
//     checker; if it says PROBLEMS, ask the agent for one more pass with the finding as the reason. One round at most:
//     a second finalize in the same stop is left alone.
//
// SAFE BY CONSTRUCTION. A hand-picked model is never second-guessed. With no other family available nothing is called and
// the record says so; a same-family check is never passed off as a check. Every failure means "let the run finish".

import {
  approxTokens,
  checkBrief,
  freshPointDecision,
  needsCheck,
  parseCheckVerdict,
  pickChecker,
  type CheckerPick,
} from "openclaw/plugin-sdk/fork-thalamus";
import type { ThalamusConfig } from "./config.js";
import type { FreshRecorder } from "./fresh-record.js";
import type { ModelCaller } from "./model-caller.js";
import type { RunState, RunStates } from "./run-state.js";

export type CheckPlan = {
  check: boolean;
  why: string;
  pick?: CheckerPick;
  callIndex?: number;
  briefTokens?: number;
  price?: number;
  builder?: string;
};

export type CheckServiceDeps = {
  cfg: () => ThalamusConfig;
  runs: RunStates;
  record: FreshRecorder;
  caller: () => ModelCaller | undefined;
  onError?: (err: unknown) => void;
};

/** The work, as the checker reads it: each step's tool, arguments and outcome, newest last. */
function workText(run: RunState): string {
  return run.work
    .map(
      (w) =>
        `${w.commits ? "[changes something] " : ""}${w.name} ${w.args}\n-> ${w.isError ? "ERROR: " : ""}${w.result}`,
    )
    .join("\n\n");
}

export function createCheckService(d: CheckServiceDeps) {
  const acts = (): boolean => {
    const c = d.cfg();
    return c.mode === "enforce" && c.enforce.check;
  };

  function plan(runId: string, claim: string): CheckPlan {
    const run = d.runs.get(runId);
    const base = run?.base;
    if (!run || !base) return { check: false, why: "no-context" };
    if (base.handPicked) return { check: false, why: "hand-picked", callIndex: base.callIndex };
    const need = needsCheck({ step: base.step });
    const changed = run.work.some((w) => w.commits && !w.isError);
    if (!need.check && !changed) return { check: false, why: need.why, callIndex: base.callIndex };
    const work = workText(run);
    const briefTokens = Math.min(
      approxTokens(work) + approxTokens(claim) + 300,
      Math.ceil(d.cfg().check.maxChars / 4) + 300,
    );
    const fp = freshPointDecision(base, "check", briefTokens);
    if (!fp)
      return {
        check: true,
        why: need.check ? need.why : "changed-something",
        callIndex: base.callIndex,
        briefTokens,
        builder: base.incumbentKey,
        pick: { builderFamily: "", reason: "no-brief-option" },
      };
    const builderQuality = fp.options.find((o) => o.rung.key === base.incumbentKey)?.quality;
    const pick = pickChecker({
      builderKey: base.incumbentKey,
      options: fp.options,
      minQuality: builderQuality,
    });
    return {
      check: true,
      why: need.check ? need.why : "changed-something",
      pick,
      callIndex: base.callIndex,
      briefTokens,
      ...(pick.option ? { price: pick.option.price } : {}),
      builder: base.incumbentKey,
    };
  }

  function record(
    runId: string,
    p: CheckPlan,
    acted: boolean,
    reason: string,
    extra: Record<string, unknown> = {},
  ): void {
    const session = d.runs.get(runId)?.sessionKey;
    d.record({
      id: `${runId}:check`,
      ...(session ? { session } : {}),
      runId,
      ...(p.callIndex !== undefined ? { callIndex: p.callIndex } : {}),
      kind: "check",
      acted,
      reason,
      ...(p.pick?.option ? { model: p.pick.option.rung.key } : {}),
      ...(p.pick?.family ? { family: p.pick.family } : {}),
      detail: {
        why: p.why,
        ...(p.builder ? { builder: p.builder } : {}),
        ...(p.pick?.builderFamily ? { builderFamily: p.pick.builderFamily } : {}),
        ...(p.briefTokens !== undefined ? { briefTokens: p.briefTokens } : {}),
        ...(p.price !== undefined ? { price: p.price } : {}),
        ...extra,
      },
    });
  }

  return {
    plan,

    /** A run ended: write down whether it would have been checked, and by whom. Calls nothing. */
    observeEnd(runId: string): void {
      try {
        const p = plan(runId, "");
        if (!p.check) return;
        record(
          runId,
          p,
          false,
          p.pick?.reason === "picked" ? "would-check" : (p.pick?.reason ?? "no-checker"),
        );
      } catch (err) {
        d.onError?.(err);
      }
    },

    /** `before_agent_finalize`: the hook's answer, or undefined to let the run finish as it is. */
    async finalize(e: {
      runId?: string;
      lastAssistantMessage?: string;
      stopHookActive?: boolean;
    }): Promise<{ action: "revise"; reason: string } | undefined> {
      try {
        if (!acts() || !e.runId || e.stopHookActive) return undefined;
        const claim = (e.lastAssistantMessage ?? "").trim();
        if (claim.length === 0) return undefined;
        const p = plan(e.runId, claim);
        if (!p.check) return undefined;
        if (!p.pick?.option) {
          record(e.runId, p, false, p.pick?.reason ?? "no-checker");
          return undefined;
        }
        const call = d.caller();
        const run = d.runs.get(e.runId);
        if (!call || !run) {
          record(e.runId, p, false, "no-caller");
          return undefined;
        }
        const c = d.cfg().check;
        const reply = await call({
          modelKey: p.pick.option.rung.key,
          effort: p.pick.option.rung.effort,
          prompt: checkBrief({ work: workText(run), claim, maxChars: c.maxChars }),
          maxTokens: 700,
          timeoutMs: c.timeoutMs,
        });
        if (!reply) {
          record(e.runId, p, false, "checker-failed");
          return undefined;
        }
        const v = parseCheckVerdict(reply.text);
        d.runs.noteOther(e.runId);
        record(e.runId, p, true, v.verdict, {
          ...(reply.input !== undefined ? { checkerInput: reply.input } : {}),
          ...(reply.output !== undefined ? { checkerOutput: reply.output } : {}),
          ...(v.verdict === "problems" ? { findingChars: v.detail.length } : {}),
        });
        if (v.verdict !== "problems" || v.detail.length === 0) return undefined;
        return {
          action: "revise",
          reason: `A model of another family checked this work against what you claimed and found: ${v.detail}\nFix what is wrong, or say plainly why it is right.`,
        };
      } catch (err) {
        d.onError?.(err);
        return undefined;
      }
    },
    acts,
  };
}

export type CheckService = ReturnType<typeof createCheckService>;
