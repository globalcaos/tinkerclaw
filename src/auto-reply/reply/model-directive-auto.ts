/**
 * FORK 2026-09-08 — `/model auto`: the picker's Auto, carried ON the send.
 *
 * Pressing Auto in the Tinker picker used to fire a fire-and-forget `sessions.patch{model:null}`
 * and then send the next turn with no `model` param. When that patch was slow (82-147 s on
 * 2026-09-08, a 12 MB sessions.json behind one lock) the turn still ran on the stored pin from an
 * earlier `/model openai-codex/gpt-5.6-sol` — an explicit selection as far as model-selection
 * could tell, so it skipped the quota veto and THALAMUS and ran an exhausted Sol with an empty
 * ladder while the picker read "Auto".
 *
 * The literal below is what the picker now sends as the per-turn `model` param. The gateway turns
 * it into `resolveModelDirective → no directive` + `createModelSelectionState({
 * resetStoredModelOverride: true })`, which clears the stored pin INSIDE the turn, before
 * choosing, and then routes as Auto. A user can type `/model auto <prompt>` to the same effect.
 *
 * Pure and dependency-free so both the parser and the tests can share the one definition.
 */
export const AUTO_MODEL_DIRECTIVE = "auto";

/** True when a raw `/model` argument is the Auto word — exactly that word, any case, trimmed. */
export function isAutoModelDirective(raw: unknown): boolean {
  return typeof raw === "string" && raw.trim().toLowerCase() === AUTO_MODEL_DIRECTIVE;
}
