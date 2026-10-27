// THALAMUS v4 — the card writer (design doc 13A.6 step 3; paper J19 v4.1 section 7.4).
//
// WHAT THIS IS FOR. The nightly loop asks a model for one small edit per group of similar misses. This file builds that
// request and reads the answer. The model is a routed call: the caller picks the route key, the same pricing as any other
// fresh point. Nothing here decides whether an edit is kept; the replay does (`card-loop.ts`).
//
// WHAT THE MODEL SEES. One card and up to five redacted tasks from sources Jev is approved for. The wording of the request is
// in `prompts/card-writer.md`, not in code. FAIL CLOSED: an answer that is not one well-formed edit is no edit.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CardEdit } from "openclaw/plugin-sdk/fork-thalamus";
import type { CardWriter } from "./card-loop.js";
import type { ModelCaller } from "./model-caller.js";

export const WRITER_TIMEOUT_MS = 60_000;

const KINDS = ["also-served", "structure", "purpose"] as const;

/** One edit from the model's reply, or undefined. Accepts the JSON object bare or inside a code fence or a sentence. */
export function parseEdit(reply: string, cardId: string): CardEdit | undefined {
  const m = /\{[\s\S]*?\}/.exec(reply);
  if (!m) return undefined;
  try {
    const o = JSON.parse(m[0]) as { kind?: unknown; text?: unknown };
    if (typeof o.kind !== "string" || !(KINDS as readonly string[]).includes(o.kind))
      return undefined;
    if (typeof o.text !== "string" || o.text.trim() === "") return undefined;
    return { cardId, kind: o.kind as CardEdit["kind"], text: o.text };
  } catch {
    return undefined;
  }
}

export function createModelCardWriter(d: {
  caller: () => ModelCaller | undefined;
  /** The route key of the model to ask. Undefined means none is available: no edit. */
  modelKey: () => string | undefined;
  extensionRoot: string;
  timeoutMs?: number;
  onError?: (err: unknown) => void;
}): CardWriter {
  let brief: string | undefined;
  const loadBrief = (): string => {
    brief ??= readFileSync(join(d.extensionRoot, "prompts", "card-writer.md"), "utf8");
    return brief;
  };
  return {
    async propose({ card, group, examples }) {
      try {
        const call = d.caller();
        const modelKey = d.modelKey();
        if (!call || !modelKey) return [];
        const reason =
          group.kind === "top-unused"
            ? "it was ranked first with high confidence and then not used"
            : group.kind === "absent"
              ? "the agent used it although it was not on the list"
              : "it was used but ranked low";
        const prompt = [
          loadBrief(),
          `CARD (${card.id}, version ${card.version})`,
          `purpose: ${card.purpose}`,
          `structure: ${card.structure}`,
          `also served: ${card.alsoServed.join("; ") || "(none yet)"}`,
          `WHY IT IS HERE: ${reason}, in ${group.taskIds.length} task(s).`,
          ...examples.map((t, i) => `TASK ${i + 1}: ${t}`),
        ].join("\n");
        const reply = await call({
          modelKey,
          prompt,
          maxTokens: 300,
          timeoutMs: d.timeoutMs ?? WRITER_TIMEOUT_MS,
        });
        const edit = reply ? parseEdit(reply.text, card.id) : undefined;
        return edit ? [edit] : [];
      } catch (err) {
        d.onError?.(err);
        return [];
      }
    },
  };
}
