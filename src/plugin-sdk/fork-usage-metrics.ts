/**
 * FORK: usage and rate-limit snapshots, as a declared plugin-SDK surface.
 *
 * WHY THIS EXISTS
 * ---------------
 * `tinkerclaw-budget-panel` renders spend and rate-limit headroom. It publishes a usage
 * snapshot for the UI to read, and reads the Anthropic rate-limit snapshot the provider
 * layer maintains. Both were relative imports into core.
 *
 * Deliberately narrow. `setUsageSnapshot` writes the snapshot the panel itself renders,
 * and `getRateLimitSnapshot` is a read of headroom the host already exposes in its own
 * UI — neither carries credentials, and neither is a way to spend anything. The
 * surrounding stores are NOT exported: an extension gets the snapshot, not the store.
 */

export { setUsageSnapshot } from "../infra/usage-snapshot-store.js";
export { getRateLimitSnapshot } from "../agents/anthropic-ratelimit-store.js";
