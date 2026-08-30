/**
 * FORK: in-flight steer registration, as a declared plugin-SDK surface.
 *
 * This one is a genuine BIDIRECTIONAL seam and deserves its own note. The core
 * embedded-agent-runner needs to hand a steer request to whichever provider owns
 * the live worker; `registerInflightSteerHook` is how that owner announces itself.
 * `src/agents/embedded-agent-runner/inflight-steer-hook.ts:41` exists solely to be
 * called from the plugin side — the dependency points core -> plugin, and the
 * import points plugin -> core.
 *
 * The instinct is to keep such a seam private, because publishing it advertises
 * "any plugin may intercept the core steer dispatch." But `tinkerclaw-tinker-bridge`
 * is `publishToClawHub: true`, and FOUNDATION #9 is not satisfied by keeping a
 * dependency undeclared — an undeclared dependency is precisely what makes an
 * artefact unbounded. Declaring it narrowly (one registrar, nothing else) is both
 * honest and smaller than the relative reach it replaces.
 *
 * If the fork later decides no third party should register a steer hook, that is a
 * POLICY question — enforce it with a gate on who may call this, not by hiding the
 * import behind a lint exemption that a tarball cannot honour anyway.
 */

export { registerInflightSteerHook } from "../agents/embedded-agent-runner/inflight-steer-hook.js";
