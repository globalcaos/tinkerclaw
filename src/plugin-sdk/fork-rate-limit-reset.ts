/**
 * FORK 2026-10-09: the provider reset-time parser and the usage-window classifier, as a declared
 * plugin-SDK surface.
 *
 * `tinkerclaw-tinker-bridge` needs both to wake a Tinker chat when the Claude usage limit that cut
 * its turn has reset (extensions/tinkerclaw-tinker-bridge/src/limit-resume.ts). The parser already
 * lives in core with its tests; re-exporting it here keeps one parser instead of a fourth copy, and
 * declares the dependency for a plugin that is published on its own (FOUNDATION #9).
 *
 * Narrow on purpose: the two pure readers, nothing that schedules or reaches the gateway.
 *
 * FORK 2026-11-13: plus the one writer a limit needs. The CLI's Fable-limit line names a cap of one model;
 * the bridge records it in Thalamus's cooling store so the next auto turn goes to the best model still open.
 */

export { parseRateLimitReset } from "../auto-reply/reply/rate-limit-retry.js";
export { isLongUsageWindow, usageWindowOf } from "../shared/usage-window.js";
export { modelLimitFamily } from "../shared/thalamus-supply.js";
export { recordModelLimit } from "../infra/thalamus-cooling.js";
