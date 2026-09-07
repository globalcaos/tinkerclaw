/**
 * FORK: Re-export shim kept for import-path compatibility inside
 * extensions/tinkerclaw-whatsapp/.
 *
 * KEEP THIS FILE. The fork-wiring script's process-message.ts patch inserted a
 * relative import to "../../../fork/process-message-hooks.js", which resolves to
 * THIS path; deleting the file would break that generated wiring even though the
 * file carries no implementation of its own. (That wiring section was retired in
 * scripts/merge-drivers/apply-fork-wiring.mjs on 2026-04-12 — see its section 3
 * comment — so nothing currently imports this shim. It stays so that older or
 * regenerated wiring still resolves.)
 *
 * FOUNDATION #9 (bounded in space, 2026-08-04): the implementation is no longer
 * reached by a relative reach into the host's src/ tree. A published tarball ships
 * only its own directory, so a ../../../src/... specifier cannot resolve on the
 * user's disk — and this extension goes to BOTH npm and ClawHub, the widest
 * distribution of any fork extension, so an unresolvable relative import bites
 * real installs here first.
 * The old no-extension-src-imports allowlist exempted this path, which silenced the
 * linter without making the path resolve. It is now reached through the declared
 * plugin-SDK surface openclaw/plugin-sdk/fork-message-hooks, registered in the host
 * package.json "exports" map and in scripts/lib/plugin-sdk-entrypoints.json.
 */
// Two symbols, two DIFFERENT correct answers — because #9 asks where each one lives,
// not which import style looks tidier.
//
// `annotateOfflineRecovery` is host code (src/fork/process-message-hooks.ts:17), so it
// crosses the declared SDK surface.
export { annotateOfflineRecovery } from "openclaw/plugin-sdk/fork-message-hooks";
// `createThinkingReaction` is OUR OWN code, three directories away. Routing it through
// the host would be a round trip — extension -> plugin-sdk -> src/fork -> back here —
// which drags this whole extension into the plugin-sdk declaration project and breaks
// `pnpm build` at build:plugin-sdk:dts (TS2339 in src/accounts.ts:162; deploy rc=12,
// 2026-08-04). It already ships in our tarball, so it is already bounded. Import it
// directly.
export { createThinkingReaction } from "../src/auto-reply/monitor/thinking-reaction.js";
