/**
 * Redaction for anything that leaves the machine toward Jev (design doc §1 C9, paper §7.3).
 *
 * `redactForSend` is the single door: it refuses real situations unless explicitly allowed and
 * returns only the fields the asked questions read, each redacted. Synthetic situations take the
 * same code path so what we test is what we ship.
 */

import { redactText, redactValue, type TextOpts } from "openclaw/plugin-sdk/fork-jev";
import type { Question, Situation } from "./types.js";

// The text and value redaction live in core since THALAMUS v4 (phase H2); this file keeps the old import path.
export { redactText };

export class SendBlocked extends Error {
  constructor(msg = "sending a real situation is not allowed") {
    super(msg);
    this.name = "SendBlocked";
  }
}

export interface RedactOptions {
  allowReal: boolean;
  contactNames?: string[];
  homeDir?: string;
}

export function redactForSend(
  s: Situation,
  qs: Question[],
  o: RedactOptions,
): Record<string, unknown> {
  if (s.originKind === "real" && !o.allowReal) {
    throw new SendBlocked();
  }
  const labels = new Map<string, string>();
  const opts: TextOpts = { contactNames: o.contactNames, homeDir: o.homeDir };
  const names = new Set<string>();
  for (const q of qs) {
    for (const f of q.fields) {
      names.add(f);
    }
  }
  const state: Record<string, unknown> = {};
  for (const name of names) {
    const f = s[name as keyof Situation] as { value?: unknown } | undefined;
    if (!f || f.value === null || f.value === undefined) {
      continue;
    }
    state[name] = redactValue(f.value, opts, labels, name);
  }
  return state;
}
