/**
 * FORK: auth-store and credential-file LOCATIONS, as a declared plugin-SDK surface.
 *
 * ⚠️  READ THIS BEFORE ADDING TO IT.
 * This is the widest surface in the fork's SDK additions, and it is the one to reconsider
 * first if the plugin trust boundary is ever tightened. Everything else the fork publishes
 * is a type, a metric, or a recipe primitive. This one tells a plugin where credentials
 * live and lets it write one.
 *
 * WHY IT EXISTS
 * -------------
 * `tinkerclaw-auth-reload` watches credential files and re-arms auth profiles when they
 * change on disk; `tinkerclaw-budget-panel` resolves the same paths to attribute spend.
 * Both reached in by relative path, which does not resolve once a plugin is installed
 * outside this tree.
 *
 * WHAT PUBLISHING THIS ACTUALLY COSTS
 * -----------------------------------
 * `src/plugin-sdk/**` is the PUBLISHED contract: every subpath here is importable by any
 * plugin on any vanilla OpenClaw install, not only by the two extensions that asked. So
 * this widens what an arbitrary plugin can locate and write — and neither consumer is
 * published today (no `publishToNpm`), so the benefit is prospective while the exposure
 * is immediate.
 *
 * It is published anyway because the alternative is worse: the extensions would each
 * re-derive the auth-store path locally, which puts two definitions of one location in
 * the tree and guarantees they drift — and a credential path that drifts fails silently,
 * reading or writing the wrong file.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * No credential READS, no secret material, no profile mutation. `resolveApiKeyForProfile`
 * and the store mutators stay behind `openclaw/plugin-sdk/provider-auth`, which is
 * upstream-governed. This surface is locations plus one write, and nothing else. If a
 * future extension needs more, that is a decision to take explicitly — not by widening
 * this file because it is already open.
 */

export {
  resolveCredentialFilePath,
  writeCredentialFile,
} from "../agents/auth-profiles/credential-file.js";
export { resolveAuthStorePath } from "../agents/auth-profiles/paths.js";
