/**
 * FORK 2026-08-29 — the DURABLE model pin of a session row, derived exactly ONCE.
 *
 * WHY A SEPARATE MODULE. Nothing type-checks app.ts meaningfully, and this derivation is needed at
 * TWO call sites — renderModelForceSlider and routingSignals — which the invariant at app.ts
 * ~:18519-18521 requires to compute the IDENTICAL answer, because the index they produce maps to
 * the chip drawn under it. Those two sites have already drifted apart once. A pure module is the
 * only place that invariant can be stated in one expression and TESTED.
 *
 * THE BUG THIS FIXES. Both sites derived the pin as `pinnedModel ?? row.model`. `row.model` is the
 * LAST-SERVED model: the gateway populates it on every turn, Auto turns included, and it SURVIVES
 * the Auto reset that deletes the override pair. So a session with no pin at all reported itself
 * pinned to whatever it happened to run last, and the picker lit a chip nobody pressed — "when the
 * model is set to auto, it uses either opus or the last one chosed for that chat" (2026-08-28,
 * quoted at app.ts:19651).
 */

/** The only session-row fields this derivation may see (mirrors `SessionUsageEntry`,
 *  src/shared/usage-types.ts:13-37). */
export type PinRow = {
  /** LAST-SERVED model, published BARE. ANNOTATION ONLY — never a pin. */
  model?: string;
  /** Provider that served `model`. Annotation only. */
  modelProvider?: string;
  /** The DURABLE pin (persisted as `modelOverrideSource:"user"`); DELETED by the Auto reset. */
  modelOverride?: string;
  /** Provider half of the durable pin — `applyModelOverrideToSessionEntry` writes the pair. */
  providerOverride?: string;
};

/** Absent, non-string and whitespace-only all collapse to "" — a blank pin is not a pin. */
function nonBlank(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Attach `provider` to `id` unless `id` already carries it.
 *
 * NOT `id.includes("/")`. The model half of a ref is not a single segment: `parseModelRef`
 * (src/agents/model-selection-normalize.ts:90-99) splits at the FIRST slash only, so the catalog id
 * `openrouter/qwen/qwen3.8-max` is stored by `applyModelOverrideToSessionEntry` as providerOverride
 * `openrouter` + modelOverride `qwen/qwen3.8-max` — a BARE model name that itself CONTAINS a slash.
 * An `includes("/")` short-circuit would hand `qwen/qwen3.8-max` to the matcher, no stop would ever
 * light, and the picker would read Auto on a live pin: the SAME defect this module exists to fix,
 * landing on the tab app.ts:19651 names ("a tab stuck at openrouter/qwen"). Identical rule to
 * `modelCountKey` (run-state.ts:189-209), kept identical on purpose — two qualification rules over
 * one namespace is the drift this file is here to end. The ONE deliberate divergence is the
 * provider-LESS case: `modelCountKey` falls back to the bare tail because it is building a count
 * bucket, whereas here the raw id is handed through untouched and the matcher's own bare-tail
 * fallback (serverModelStopIndex, app.ts:18565-18569) does that job.
 *
 * IDEMPOTENT with `serverModelStopIndex` (app.ts:18556), which re-qualifies whatever it is handed:
 * an already-qualified id passes through both unchanged.
 */
function qualify(id: string, provider: string): string {
  if (!id || !provider) {
    return id;
  }
  const alreadyQualified = id === provider || id.startsWith(`${provider}/`);
  return alreadyQualified ? id : `${provider}/${id}`;
}

/**
 * The DURABLE pin on this row, provider-qualified — or the Auto answer, `{ id: "" }`.
 *
 * IT MUST NEVER READ `row.model` — that field is the LAST-SERVED model, and reading it as a pin is
 * the entire bug being fixed. There is deliberately no `?? row.model` fallback below; adding one
 * puts the defect straight back.
 *
 * `autoAsserted` is the OPTIMISTIC CLEAR. Pressing Auto drops the client pin and fires
 * `sessions.patch { model: null }` fire-and-forget (app.ts:19640-19663); until that lands the row
 * still carries the stale override, so the user's assertion has to win or the picker springs back
 * to the old chip for a frame.
 *
 * `provider` rides along so a caller can hand both straight to `serverModelStopIndex(stops, id,
 * provider)` without re-deriving anything.
 */
export function serverPinOf(
  row: PinRow | undefined,
  autoAsserted: boolean,
): { id: string; provider?: string } {
  const pin = nonBlank(row?.modelOverride);
  if (autoAsserted || !pin) {
    return { id: "", provider: undefined };
  }
  const provider = nonBlank(row?.providerOverride);
  return { id: qualify(pin, provider), provider: provider || undefined };
}

/**
 * What actually SERVED, provider-qualified — for an ANNOTATION only.
 *
 * The honest answer to "which model wrote the last turn", and it must NEVER feed selection: under a
 * fallback the model that served is one the architect did not choose, and letting it pick the chip
 * is `serverPinOf`'s bug wearing a different hat.
 */
export function servedLabelIdOf(row: PinRow | undefined): string {
  const model = nonBlank(row?.model);
  if (!model) {
    return "";
  }
  return qualify(model, nonBlank(row?.modelProvider));
}
