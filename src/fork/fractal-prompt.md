# FRACTAL PROMPT — POINTER FILE (do not put prompt content here)

⚠️ **CORRECTED 2026-08-22.** The previous version of this file claimed the live prompt was
`extensions/tinkerclaw-fractal-reflection/fractal-prompt.md`. **That is wrong** — verified by
reading the loaders:

| file                                                                                            | who reads it                                                                                                          | status                                                                         |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/fork/fractal-prompt.md` (this file)                                                        | `loadFractalPrompt()` in `src/fork/attempt-hooks.ts`                                                                  | **superseded** — the inline v3 path no longer fires                            |
| `extensions/tinkerclaw-fractal-reflection/fractal-prompt.md`                                    | **SOURCE OF TRUTH** — mirrored into `FRACTAL_DOCTRINE` in `tinker-ui/src/app.ts` by `scripts/sync-fractal-prompt.mjs` | **LIVE (since 2026-08-22)**                                                    |
| `extensions/tinkerclaw-fractal-reflection/triage-prompt.md`                                     | `loadTriagePrompt()` in `src/fractal-run.ts`                                                                          | **LIVE** — the read-only triage judge that emits the JSON verdict              |
| the ~1.4 KB literal at `tinker-ui/src/app.ts` (search `append a 🌿 FRACTAL reflection section`) | appended to every user message by the UI                                                                              | **LIVE** — this is what actually shapes the 🌿 FRACTAL section the owner reads |

So there are TWO live surfaces (the triage prompt and the app.ts literal) and TWO orphans that
look authoritative. Editing an orphan produces a careful document that changes nothing — which is
exactly what happened on 2026-08-22.

**To change what the 🌿 FRACTAL section says: edit `extensions/tinkerclaw-fractal-reflection/fractal-prompt.md`,
then run `node scripts/sync-fractal-prompt.mjs`.** The owner decided on 2026-08-22 that the FULL
doctrine ships per-message regardless of token cost.

The reconstructed long-form doctrine (v3, restoring the census / recipe / ripple / preempt
faculties that the 2026-07-02 rewrite dropped) is kept at
`extensions/tinkerclaw-fractal-reflection/fractal-prompt.md` as the reference text — clearly
labelled there as not-currently-loaded.
