// What leaves the machine when Jev reads a task (paper P§4 "Privacy comes first").
//
// WHAT THIS IS FOR. Jev is an outside service. Only the request text is sent, and only after the obvious
// secrets and identifiers are taken out of it. This is the routing reader's own small redaction, not a copy
// of the amygdala's: it sends one field, not a situation.
//
// It is a floor, not a promise. The privacy decision is made BEFORE this runs (`isPrivateSource`): a task from
// a private source never reaches it unless the operator approved that source for Jev.

import { homedir } from "node:os";
import { redactText, redactValue } from "openclaw/plugin-sdk/fork-jev";

const MAX_CHARS = 4000;

const RULES: ReadonlyArray<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]"],
  [/\b(sk|pk|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}\b/g, "[secret]"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "[secret]"],
  [/\b[A-Za-z0-9_-]{40,}\b/g, "[secret]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]"],
  [/\+?\d[\d\s().-]{7,}\d/g, "[number]"],
  [/\/home\/[^/\s]+\//g, "~/"],
  [/\/Users\/[^/\s]+\//g, "~/"],
];

export function redactForRouting(text: string, max = MAX_CHARS): string {
  let out = typeof text === "string" ? text : "";
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out.length > max ? out.slice(0, max) : out;
}

/** What the builder reads of a situation: the request, and for a step the tool and its arguments. */
export type RoutingStateSource = {
  request: { value: string };
  tool?: { value: unknown };
  args?: { value: unknown };
};

/**
 * The state a standalone read sends to Jev (phase H2). The request text always, through the routing redaction. The tool
 * name and its arguments only when an asked question declares them, redacted with the amygdala's own text and value
 * redaction (it lives in core now): file bodies become counts, long text becomes a length, secrets, addresses and the home
 * folder are taken out. A tool's output and the reply are NEVER sent from here, whatever the situation object carries:
 * whether they may be is the owner's decision (decisions for the architect, H2).
 */
export function buildRoutingState(
  s: RoutingStateSource,
  qs: ReadonlyArray<{ fields: readonly string[] }>,
  home: string = homedir(),
): Record<string, unknown> {
  const wanted = new Set(qs.flatMap((q) => q.fields));
  const state: Record<string, unknown> = { request: redactForRouting(s.request.value) };
  const opts = { homeDir: home };
  const labels = new Map<string, string>();
  const tool = s.tool?.value;
  if (wanted.has("tool") && typeof tool === "string" && tool.length > 0) {
    state.tool = redactText(tool, opts, labels);
  }
  const args = s.args?.value;
  if (wanted.has("args") && args !== undefined && args !== null) {
    state.args = redactValue(args, opts, labels, "args");
  }
  return state;
}
