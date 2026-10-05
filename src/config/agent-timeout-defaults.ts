// FORK 2026-09-03: raised 120 -> 600. Parity with the claude-code overlay's
// DEFAULT_REQUEST_TIMEOUT_MS (extensions/tinkerclaw-tinker-bridge/src/defaults.ts:96).
//
// Evidence: all 7 "LLM request timed out" failures on 2026-09-03 -- and most of the
// 37 that week -- were xai/grok-4.6 and openai-codex/gpt-5.6-sol turns, each logging
// "[idle-timeout-diag] resolved idleTimeoutMs=120000 ... model.requestTimeoutMs=undefined"
// (attempt.ts). No claude-code turn appeared in that set, because tinker-bridge
// registers a provider-config overlay (timeoutSeconds: 600, see
// plugin-provider-config-overlay.ts) that reaches params.model.requestTimeoutMs and
// wins the branch above this fallback. Providers that ship no such overlay dropped
// straight through to 120s. A 120s no-token window is normal for a long reasoning
// turn, so the kill was the bug, not the model.
//
// This is the IDLE (no-token) watchdog, not a wall-clock cap on the turn. Explicit
// values still win: models.providers.<id>.timeoutSeconds overrides it, and a cron run
// with no configured timeout still disables it entirely.
//
// Dual role -- read before changing: this is ALSO the ceiling clampImplicitTimeoutMs
// applies to implicit bounds (llm-idle-timeout.ts), so raising it widens that ceiling
// too. An operator's agents.defaults.timeoutSeconds of 300s now resolves to 300s
// rather than being clamped to 120s. That is intended -- it is a value the operator
// already asked for, which the old cap was silently overriding.
export const DEFAULT_LLM_IDLE_TIMEOUT_SECONDS = 600;
