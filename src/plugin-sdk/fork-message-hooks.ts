/**
 * FORK: inbound-message hooks for channel extensions, as a declared plugin-SDK surface.
 *
 * `annotateOfflineRecovery` and `createThinkingReaction` are fork behaviours the
 * WhatsApp channel needs (offline-recovery annotation on replayed messages; the
 * thinking reaction the architect reads as "Jarvis has the message").
 *
 * `tinkerclaw-whatsapp` reached them through a re-export shim that imported
 * `../../../src/fork/process-message-hooks.js`. It is published to BOTH npm and
 * ClawHub — the widest distribution of any fork extension — so under FOUNDATION #9
 * this is the one where an unbounded artefact would bite real installs first.
 *
 * Worth recording: the old `no-extension-src-imports` allowlist had `whatsapp` and
 * `tinkerclaw-whatsapp` on it, so this violation was EXEMPTED and therefore
 * invisible for months. An allowlist silences a linter; it cannot make a path
 * resolve inside a tarball. That is why #9 tests boundedness rather than lint
 * compliance.
 */

// ONLY `annotateOfflineRecovery`. `createThinkingReaction` is deliberately NOT here.
//
// It looked like a sibling — `src/fork/process-message-hooks.ts` re-exports both — but that module
// gets it by importing FROM the extension:
//     src/fork/process-message-hooks.ts:7
//     import { createThinkingReaction } from
//       "../../extensions/tinkerclaw-whatsapp/src/auto-reply/monitor/thinking-reaction.js";
//
// So publishing it here would make the crossing a ROUND TRIP — extension -> plugin-sdk -> src/fork
// -> back into that same extension — and it would drag the whole WhatsApp graph into the
// `tsconfig.plugin-sdk.dts.json` project, whose `include` is only `src/plugin-sdk/**`. That is not
// hypothetical: it broke `pnpm build` at the `build:plugin-sdk:dts` step with a TS2339 in
// `extensions/tinkerclaw-whatsapp/src/accounts.ts:162` — a file that had never been type-checked
// under that project before (deploy rc=12, 2026-08-04; the gateway was left untouched).
//
// FOUNDATION #9 asks whether the artefact is BOUNDED, not whether the import is fashionable.
// `createThinkingReaction` already lives inside the WhatsApp extension and therefore already ships
// in its tarball — it is bounded exactly where it is. Routing it through a host surface adds a
// dependency instead of declaring one. The extension imports it from its own module.
export { annotateOfflineRecovery } from "../fork/process-message-hooks.js";
