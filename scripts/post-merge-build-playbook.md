# Post-Merge Build Playbook

Error pattern → root cause → fix mapping for known build failure categories.
Use after `pnpm build` fails following an upstream merge.

---

## 1. `ReferenceError: __filename is not defined`

**Root cause:** Native addon packages (`better-sqlite3`, `bindings`) bundled inline by tsdown. ESM has no `__filename`.
**Fix:** Add `external: ["better-sqlite3", "bindings"]` to all entry blocks in `tsdown.config.ts`.
**Auto-fix:** `node scripts/apply-fork-wiring.mjs` → `patchTsdownConfig()`
**Guard:** `grep 'external.*better-sqlite3' tsdown.config.ts`

## 2. `Cannot find module '../../../fork/...'` or `'../../../../fork/...'`

**Root cause:** Wrong import depth in `process-message.ts`. Path from `src/web/auto-reply/monitor/` to `src/fork/` is 3 levels (`../../../`), not 4.
**Fix:** Replace `../../../../fork/` with `../../../fork/` in the import.
**Auto-fix:** `node scripts/apply-fork-wiring.mjs` → `patchProcessMessage()` (uses correct 3-level path)
**Guard:** `grep '../../../../fork' src/web/auto-reply/monitor/process-message.ts` → should return nothing

## 3. `Module '"./active-listener.js"' has no exported member 'MessageKey'`

**Root cause:** Upstream changed `MessageKey` export. Outbound wrappers import it.
**Fix:** Ensure `MessageKey` is in the import from `./active-listener.js` in `outbound.ts`.
**Auto-fix:** `node scripts/apply-fork-wiring.mjs` → `patchOutbound()`
**Guard:** `grep 'MessageKey' src/web/outbound.ts`

## 4. `Property 'syncFullHistory' does not exist on type ...`

**Root cause:** Upstream removed `syncFullHistory` from the account type but monitor.ts still references it directly.
**Fix:** Use conditional spread: `...(account.syncFullHistory != null ? { syncFullHistory: account.syncFullHistory } : {})`
**Auto-fix:** `node scripts/apply-fork-wiring.mjs` → `patchMonitor()`
**Guard:** `grep 'syncFullHistory != null' src/web/auto-reply/monitor.ts`

## 5. `Type 'WebListener' is not assignable to type 'ActiveWebListener'`

**Root cause:** Upstream narrowed the `ActiveWebListener` type. Fork's listener doesn't match exactly.
**Fix:** Cast via `listener as unknown as import("../active-listener.js").ActiveWebListener`
**Auto-fix:** `node scripts/apply-fork-wiring.mjs` → `patchMonitor()`
**Guard:** `grep 'unknown as.*ActiveWebListener' src/web/auto-reply/monitor.ts`

## 6. `Property 'authProfileId' does not exist on type 'SubscribeEmbeddedPiSessionParams'`

**Root cause:** Upstream rewrote the type definition, dropping the fork's `authProfileId` field.
**Fix:** Add `authProfileId?: string;` to `SubscribeEmbeddedPiSessionParams`.
**Auto-fix:** `node scripts/apply-fork-wiring.mjs` → `patchSubscribeTypes()`
**Guard:** `grep 'authProfileId' src/agents/pi-embedded-subscribe.types.ts`

## 7. `Cannot find name 'forkAttemptHooks'` / missing fork imports in attempt.ts

**Root cause:** Upstream merge overwrites `attempt.ts`, removing fork hook imports.
**Fix:** Re-add `import * as forkAttemptHooks from "../../../fork/attempt-hooks.js"` and retrieval runtime import.
**Auto-fix:** `node scripts/apply-fork-wiring.mjs` → `patchAttempt()`
**Guard:** `grep 'fork/attempt-hooks' src/agents/pi-embedded-runner/run/attempt.ts`

## 8. `Cannot find module 'better-sqlite3'` / missing dependencies

**Root cause:** Upstream's `package.json` doesn't include fork-only deps. After accepting `--theirs`, they're gone.
**Fix:** Re-add `better-sqlite3`, `bindings` to dependencies; `@types/better-sqlite3` to devDependencies.
**Auto-fix:** `node scripts/apply-fork-wiring.mjs` → `patchDevDeps()` + `merge-upstream.sh` post-merge restoration
**Guard:** `grep 'better-sqlite3' package.json`

---

## Quick Recovery

After any failed build post-merge:

```bash
# 1. Run the auto-wiring script (fixes categories 1-8)
node scripts/apply-fork-wiring.mjs

# 2. Run the guardian to verify
bash scripts/merge-guardian.sh --fix

# 3. Rebuild
pnpm build

# 4. If still failing, check the build log for new patterns
grep -E "error TS|Cannot find|Module not found" /tmp/merge-guardian-build.log | head -20
```
