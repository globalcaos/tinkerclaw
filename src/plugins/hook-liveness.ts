/**
 * FORK 2026-08-05 — per-hook liveness, registered at the one seam every plugin hook passes through.
 *
 * WHY. `scripts/bible/capability-coverage.mjs` scored the fork's hook surface at 2 of 22 observed.
 * Hooks are where this fork's cognitive features live and where two of them died silently:
 *
 *   · total-recall's `llm_output` read `payload.text` from an emitter that passes `assistantTexts`,
 *     so it returned early on EVERY turn from 2026-07-28 onward. Nothing said so.
 *   · fractal-reflection's `agent_end` ran 2,466 times without once producing a success row, and
 *     the plugin had no instruments at all, so the liveness report had never heard of it.
 *
 * Both were found by hand, weeks late. The question "was this hook even called?" had no cheap
 * answer, and answering it per-plugin means editing every plugin — which is how you end up with
 * 2 of 22. So it is answered once, here, at `registerTypedHook`: every `api.on(...)` in the process
 * funnels through that function, so a wrapper installed there cannot be forgotten by the next
 * plugin author and cannot drift out of sync with the hook list — there IS no list.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT CLAIM ────────────────────────────────────────────────────
 * ONE instrument per hook, fired on DISPATCH. There is deliberately no companion "success"
 * instrument, even though that pairing is the rule elsewhere in this codebase (observability.md,
 * rule 2) and even though it is what cracked the ENGRAM bug in one cycle.
 *
 * The reason is that a registry-level success signal would be a LIE. From out here, a handler that
 * did the work and a handler that hit an early return on line one are the same event: a function
 * that returned without throwing. Firing a "success" instrument on that would manufacture exactly
 * the reassuring green this whole effort exists to remove — total-recall's hook would have shown
 * entry AND success for eleven days while writing nothing.
 *
 * So the honest split is: the REGISTRY reports dispatch, and the PLUGIN reports work. A plugin that
 * wants the entry/success pair declares its own second instrument at the point where its write
 * actually completes, the way total-recall and fractal-reflection now do. This file makes the first
 * half free and universal; it cannot make the second half honest.
 *
 * ── SCOPE ────────────────────────────────────────────────────────────────────────────────────
 * Fork plugins only (`tinkerclaw-*`), matching capability-coverage.mjs. The ~40 upstream hook
 * registrations are not ours to instrument, and folding them in would put dozens of legitimately
 * silent rows (channels that are not configured, providers with no credentials) into the liveness
 * report's `never` bucket — drowning the rows that mean something. A report nobody can read is the
 * failure mode one level up from a report nobody has.
 */
import { declareInstrument, noteInstrumentFired } from "../infra/instrument-liveness.js";

/** Prefix identifying a fork-owned plugin. Upstream plugins are out of scope — see header. */
const FORK_PLUGIN_PREFIX = "tinkerclaw-";

/** Declared ids, so re-registration (reload, re-activation) does not re-declare. */
const declared = new Set<string>();

export function hookInstrumentId(pluginId: string, hookName: string): string {
  return `hook:${pluginId}:${hookName}`;
}

export function isForkPlugin(pluginId: string): boolean {
  return pluginId.startsWith(FORK_PLUGIN_PREFIX);
}

/**
 * Wrap a hook handler so its dispatch is visible in the liveness report.
 *
 * Transparent by construction: returns the handler's own value untouched (hooks return payload
 * mutations that the caller acts on, so swallowing or reshaping a return would break behaviour),
 * and never introduces a throw of its own. Non-fork plugins get the original function back with no
 * wrapper at all — no allocation, no indirection, nothing to debug.
 */
export function wrapHookForLiveness<T extends (...args: never[]) => unknown>(
  pluginId: string,
  hookName: string,
  handler: T,
): T {
  if (!isForkPlugin(pluginId)) {
    return handler;
  }
  const id = hookInstrumentId(pluginId, hookName);
  if (!declared.has(id)) {
    declared.add(id);
    declareInstrument({
      id,
      kind: "hook",
      description: `${pluginId} received the "${hookName}" hook (dispatch only — says the handler RAN, never that it did anything)`,
    });
  }

  const wrapped = ((...args: never[]) => {
    // Fired BEFORE the handler, so a handler that throws still records that it was reached.
    // "Never fired" therefore means the hook was never dispatched — a registration or emitter
    // problem — and can never be confused with a handler that ran and failed.
    noteInstrumentFired(id, hookName);
    return handler(...args);
  }) as T;

  return wrapped;
}

/** Test-only. Instrument declarations are process-global; tests must not leak into each other. */
export function __resetHookLivenessForTests(): void {
  declared.clear();
}
