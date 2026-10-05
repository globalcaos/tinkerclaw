/**
 * What a hook should do with a decision (design doc §6, §8). The gateway renders the text, so the four hook scripts
 * stay mechanical: print what this says, or long-poll `wait` and print the answer. Nothing is printed unless the
 * decision was enforced, so shadow mode changes nothing the agent sees.
 */
import { renderTemplate } from "./templates.js";
import type { Decision, Seam } from "./types.js";

export type HookAction =
  | { kind: "none" }
  | { kind: "context"; text: string }
  | { kind: "deny"; reason: string }
  | { kind: "block"; reason: string }
  | { kind: "wait"; interventionId: string; timeoutMs: number; onKeep: string; onTimeout: string };

export const HOLD_WAIT_MS = 300_000;

export interface HookActionInput {
  decision: Decision;
  interventionId?: string;
  hard?: { rule: string; explanation: string };
}

export function toHookAction(seam: Seam, i: HookActionInput): HookAction {
  const { decision: d } = i;
  if (!d.enforced) return { kind: "none" };
  const r = d.response;
  switch (r.kind) {
    case "proceed":
    case "refusal":
      return { kind: "none" };
    case "note":
      return seam === "stop"
        ? { kind: "none" }
        : { kind: "context", text: renderTemplate(r.templateId, r.slots) };
    case "proof":
      return seam === "pre-tool"
        ? { kind: "deny", reason: renderTemplate(r.templateId, r.slots) }
        : { kind: "none" };
    case "hold":
      if (seam !== "pre-tool") return { kind: "none" };
      if (i.hard) {
        return {
          kind: "deny",
          reason: renderTemplate("hard-rule", {
            rule: i.hard.rule,
            explanation: i.hard.explanation,
          }),
        };
      }
      return waitAction(i.interventionId);
    case "ask":
      return seam === "pre-tool" ? waitAction(i.interventionId) : { kind: "none" };
    case "send-back":
      return seam === "stop"
        ? { kind: "block", reason: renderTemplate(r.templateId, r.slots) }
        : { kind: "none" };
  }
}

function waitAction(interventionId: string | undefined): HookAction {
  if (!interventionId) return { kind: "deny", reason: renderTemplate("hold-timeout") };
  return {
    kind: "wait",
    interventionId,
    timeoutMs: HOLD_WAIT_MS,
    onKeep: renderTemplate("hold-kept"),
    onTimeout: renderTemplate("hold-timeout"),
  };
}
