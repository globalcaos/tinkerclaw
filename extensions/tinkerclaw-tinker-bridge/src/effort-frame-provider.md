# Handoff: the tinker-bridge `effort` frame omits `provider`

STATUS OPEN — one-line fix, NOT applied here: `stream.ts` was owned by the sibling ORCA unit `sigterm-envelope-cause` in the run that found this.

WHERE `extensions/tinkerclaw-tinker-bridge/src/stream.ts:531-549` — the
`emitAgentEvent({ stream: "effort", … })` in `emitEffort()`. Its `data` is `{phase, model:
model.id, thinkLevel, configuredBudget, thinkingChars, hadRealThinking, redacted}` — no
`provider`, though the contract `src/infra/effort-telemetry.ts:47-48` declares `provider?:
string` ("the EEG colors by this") and the embedded producer already fills it
(`src/agents/embedded-agent-subscribe.handlers.lifecycle.ts:47-54`). Only this pipe is silent.

FIX — beside `model: model.id`, BEFORE the trailing `...(extra ?? {})` spread, add:

    provider: model.provider,

Bare — no `|| PROVIDER_ID` fallback (`effort-telemetry.ts:33`: a producer that does not know
a value must OMIT it); it is always `"claude-code"` here anyway (`defaults.ts:11` →
`catalog.ts:20`, the streamFn being provider-scoped). `model` is the arg bound at
`stream.ts:466`; `stream.ts:745-746` already reads it bare for the lifecycle frame.

WHY `tinker-ui/src/app.ts:8109-8118` CREATES the `ActiveRunInfo` from this frame when a tab is
entered mid-turn (its `lifecycle:start` was never seen), so `provider` lands `""`. Only the
GLYPH breaks: `getRoutedLogoSvg` (`tinker-ui/src/panels/provider-logos.ts:184-193`) tests
provider LAST, with no model-name arm for a bare `claude-*` id → `UNKNOWN_MARK_SVG`, the
neutral routed glyph read as "OpenRouter". Trace and glow are already right
(`eeg-trace.ts:158-163` keys on provider+model). This NARROWS the window rather than closing
it: `stream.ts:512` throttles live frames to 1/1500 ms, `stream.ts:509` emits none without a `runId`.

VERIFY `pnpm exec vitest run extensions/tinkerclaw-tinker-bridge` — nothing pins this frame's shape today; a shape assertion on `emitEffort` is the prevention half.
