// The one writer (design doc unit D4; paper J19 v4.1 §5.4 rule 5, §8 step 8).
//
// WHAT THIS IS FOR. The content of a run can come from anywhere; the words the user reads come from one model, the same
// one for the whole run, so a reply is not stitched from several voices.
//   - RECORD, always (shadow and enforce): at the end of a run, write down which writer the router would pick and on what
//     basis (`observeEnd`). Nothing is called and nothing changes.
//   - ACT, only in enforce with `enforce.finish` and only for a run that several models actually worked on (`rewrite`,
//     on the outgoing message hook): put the content into words through the chosen writer, and use the result only if it
//     kept every fact (`rewriteKeepsFacts`). Anything else sends the original.
//
// SAFE BY CONSTRUCTION. A hand-picked model is never replaced as the writer. When the writer is the model that already
// wrote the content there is nothing to do. A short message, or one from a run no other model touched, is left alone.

import {
  approxTokens,
  finishBrief,
  freshPointDecision,
  guessLanguage,
  pickWriter,
  rawResultName,
  rewriteKeepsFacts,
} from "openclaw/plugin-sdk/fork-thalamus";
import type { ThalamusConfig } from "./config.js";
import type { FreshRecorder } from "./fresh-record.js";
import type { ModelCaller } from "./model-caller.js";
import type { RunStates } from "./run-state.js";

/** A message shorter than this is an acknowledgement, not a piece of writing. */
export const MIN_REWRITE_CHARS = 200;

export type FinishServiceDeps = {
  cfg: () => ThalamusConfig;
  runs: RunStates;
  record: FreshRecorder;
  caller: () => ModelCaller | undefined;
  onError?: (err: unknown) => void;
};

export function createFinishService(d: FinishServiceDeps) {
  const acts = (): boolean => {
    const c = d.cfg();
    return c.mode === "enforce" && c.enforce.finish;
  };

  const preferredFor = (text: string): string[] => {
    const p = d.cfg().finish.preferred;
    const lang = guessLanguage(text);
    return lang === "unknown" ? p.default : [...p[lang], ...p.default];
  };

  function pick(runId: string, content: string) {
    const run = d.runs.get(runId);
    const base = run?.base;
    if (!run || !base) return { reason: "no-context" as const };
    if (base.handPicked) return { reason: "hand-picked" as const, run, base };
    const fp = freshPointDecision(
      base,
      "write",
      Math.min(approxTokens(content) + 200, Math.ceil(d.cfg().finish.maxChars / 4) + 200),
    );
    if (!fp) return { reason: "no-option" as const, run, base };
    const w = pickWriter({
      options: fp.options,
      already: run.writer,
      preferred: preferredFor(content),
    });
    return {
      reason: w.option ? ("picked" as const) : ("no-option" as const),
      writer: w,
      run,
      base,
    };
  }

  const record = (
    runId: string,
    callIndex: number | undefined,
    id: string,
    acted: boolean,
    reason: string,
    model?: string,
    detail: Record<string, unknown> = {},
  ): void => {
    const session = d.runs.get(runId)?.sessionKey;
    d.record({
      id,
      ...(session ? { session } : {}),
      runId,
      ...(callIndex !== undefined ? { callIndex } : {}),
      kind: "finish",
      acted,
      reason,
      ...(model ? { model } : {}),
      detail,
    });
  };

  return {
    /** A run ended: write down which writer would finish it. Calls nothing. */
    observeEnd(runId: string): void {
      try {
        const p = pick(runId, "");
        if (!p.run || !p.base) return;
        if (p.reason !== "picked" || !p.writer?.option) {
          record(runId, p.base.callIndex, `${runId}:finish`, false, p.reason);
          return;
        }
        record(
          runId,
          p.base.callIndex,
          `${runId}:finish`,
          false,
          "would-write",
          p.writer.option.rung.key,
          {
            basis: p.writer.basis,
            builder: p.base.incumbentKey,
            sameAsBuilder: p.writer.option.rung.key === p.base.incumbentKey,
          },
        );
      } catch (err) {
        d.onError?.(err);
      }
    },

    /** The outgoing message hook: the rewritten text, or undefined to send the original. */
    async rewrite(content: string, ctx: { runId?: string }): Promise<string | undefined> {
      try {
        if (!acts() || !ctx.runId) return undefined;
        const run = d.runs.get(ctx.runId);
        if (!run || run.others === 0 || content.length < MIN_REWRITE_CHARS) return undefined;
        const id = `${ctx.runId}:finish:${rawResultName(content)}`;
        const p = pick(ctx.runId, content);
        if (p.reason !== "picked" || !p.writer?.option || !p.base) {
          record(ctx.runId, p.base?.callIndex, id, false, p.reason);
          return undefined;
        }
        const key = p.writer.option.rung.key;
        if (key === p.base.incumbentKey) {
          d.runs.setWriter(ctx.runId, key);
          record(ctx.runId, p.base.callIndex, id, false, "writer-is-builder", key, {
            basis: p.writer.basis,
          });
          return undefined;
        }
        const call = d.caller();
        if (!call) {
          record(ctx.runId, p.base.callIndex, id, false, "no-caller", key);
          return undefined;
        }
        const f = d.cfg().finish;
        const reply = await call({
          modelKey: key,
          effort: p.writer.option.rung.effort,
          prompt: finishBrief({ content, language: guessLanguage(content), maxChars: f.maxChars }),
          maxTokens: Math.min(8000, Math.ceil(approxTokens(content) * 1.6) + 200),
          timeoutMs: f.timeoutMs,
        });
        if (!reply) {
          record(ctx.runId, p.base.callIndex, id, false, "writer-failed", key);
          return undefined;
        }
        const kept = rewriteKeepsFacts(content, reply.text);
        if (!kept.ok) {
          record(ctx.runId, p.base.callIndex, id, false, "rewrite-rejected", key, {
            because: kept.reason,
          });
          return undefined;
        }
        d.runs.setWriter(ctx.runId, key);
        record(ctx.runId, p.base.callIndex, id, true, "rewritten", key, {
          basis: p.writer.basis,
          ...(reply.input !== undefined ? { writerInput: reply.input } : {}),
          ...(reply.output !== undefined ? { writerOutput: reply.output } : {}),
        });
        return reply.text.trim();
      } catch (err) {
        d.onError?.(err);
        return undefined;
      }
    },
    acts,
  };
}

export type FinishService = ReturnType<typeof createFinishService>;
