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
  /**
   * The step is in a subagent's session, where nobody can answer a hold: refuse it now, the five-minute wait helps nobody.
   * Only its last message reaches the agent that started it, so a send-back there asks for the whole reply again.
   */
  subagent?: boolean;
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
      if (i.subagent) return { kind: "deny", reason: subagentHold(r.ruleOrQuestion) };
      return waitAction(i.interventionId, r.ruleOrQuestion);
    case "ask":
      if (seam !== "pre-tool") return { kind: "none" };
      return i.subagent ? { kind: "deny", reason: subagentHold() } : waitAction(i.interventionId);
    case "send-back": {
      if (seam !== "stop") return { kind: "none" };
      const id =
        i.subagent && r.templateId === "send-back-unchecked"
          ? "send-back-unchecked-subagent"
          : r.templateId;
      return { kind: "block", reason: renderTemplate(id, r.slots) };
    }
  }
}

const onCheck = (rule?: string): string =>
  rule === "weakens-own-check" ? ` ${renderTemplate("report-defect-how")}` : "";

function subagentHold(rule?: string): string {
  return `${renderTemplate("hold-subagent")}${onCheck(rule)}`;
}

function waitAction(interventionId: string | undefined, rule?: string): HookAction {
  const onTimeout = `${renderTemplate("hold-timeout")}${onCheck(rule)}`;
  if (!interventionId) return { kind: "deny", reason: onTimeout };
  return {
    kind: "wait",
    interventionId,
    timeoutMs: HOLD_WAIT_MS,
    onKeep: `${renderTemplate("hold-kept")}${onCheck(rule)}`,
    onTimeout,
  };
}
