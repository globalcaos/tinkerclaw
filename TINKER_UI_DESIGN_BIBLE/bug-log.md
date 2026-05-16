---
file: bug-log.md
purpose: Historical bug-fix log — root causes, fixes, lessons. Reads like a forensic timeline.
audience: AI
last_verified: 2026-05-11
last_verified_commit: HEAD
single_owner: yes — past-bug forensics live here. Migrated from bible.md §7 on 2026-05-11.
see_also: failures.md (current failure-mode map by category — what to look for going forward), flows.md (pipelines whose disruption produced many of these bugs)
note: this is the original prose from bible.md §7, relocated verbatim. New bug fixes are appended here, not added to bible.md.
verify:
  - name: bug-log.md grows monotonically (or stays equal) — never shrinks unexpectedly
    cmd: python3 -c 'import os; n = sum(1 for _ in open(os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/bug-log.md"))); assert n >= 280, f"bug-log.md only {n} lines, did someone delete entries?"'
  - name: every FIXED entry has a root-cause line
    cmd: python3 -c 'import os,re; t = open(os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/bug-log.md")).read(); fixes = re.findall(r"^### (?:FIXED(?:\s*\[[^\]]*\])?|~~FIXED): ", t, re.M); rcs = re.findall(r"^- \*\*Root cause", t, re.M); assert len(rcs) >= len(fixes) - 5, f"{len(fixes)} FIXED entries but only {len(rcs)} root-cause lines"'
  - name: failure-class taxonomy header is present
    cmd: python3 -c 'import os; t = open(os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/bug-log.md")).read(); assert "## Failure-class taxonomy" in t, "taxonomy header missing"'
  - name: most FIXED entries are tagged with at least one failure class
    cmd: python3 -c 'import os,re; t = open(os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/bug-log.md")).read(); total = len(re.findall(r"^### FIXED", t, re.M)); tagged = len(re.findall(r"^### FIXED \[[^\]]+\]:", t, re.M)); assert tagged >= total - 2, f"only {tagged}/{total} entries tagged — obsolete ones may be excluded but new entries should always be tagged"'
---

# Bug Fix Log

## 7. Bug Fix Log

## Failure-class taxonomy (added 2026-05-11)

Every entry below now carries one or more `[tag+tag]` chips after `FIXED`.
Tags let an AI scan for recurring patterns ("how many `auth-token` bugs
have we seen?") without re-reading each prose entry. When adding a new
fix, pick from this list — extend it only if no tag fits.

| Tag                   | Meaning                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| `auth-token`          | OAuth tokens — refresh, content-type, scope-downgrade, refresh-failed             |
| `auth-scope`          | Scope/permission gate dropped legitimate clients                                  |
| `bridge-leak`         | Cross-channel state bleed (real or suspected)                                     |
| `bundler-trap`        | tsdown/onlyBuiltDependencies/\_\_filename/native-deps wiped or misconfigured      |
| `cache-staleness`     | TTL not invalidated after dependent change                                        |
| `cleanup-race`        | Drain deadlock, orphan processes, stuck resurrection across restarts              |
| `config-dead-code`    | Config key looked live but didn't actually apply                                  |
| `crash-on-startup`    | Bad SDK call / missing artifact prevented plugin or gateway boot                  |
| `detection-pattern`   | Substring/regex/startsWith assumption broke under prefix change                   |
| `display-misclassify` | UI rendered system as user, error as raw object, etc.                             |
| `event-ordering`      | text_end before tail-recover, lifecycle dropped, race on stream state             |
| `lid-routing`         | WhatsApp LID rescue / sister-DM trigger class                                     |
| `merge-wipe`          | Upstream merge dropped fork code/config/scope (often combined with another)       |
| `outbound-drop`       | Outbound message lost / queued without delivery                                   |
| `plugin-load`         | Plugin failed to register — manifest missing field, wrong SDK call, name mismatch |
| `timeout-tuning`      | Idle watchdog / request timeout fired prematurely or wrongly                      |
| `ui-state-clear`      | File-watcher / event handler cleared UI state too aggressively                    |
| `workspace-shadow`    | workspace/ override of bundled/ with stale content                                |

**Recurring patterns visible from the chips:**

- `merge-wipe` shows up across `auth-scope`, `bundler-trap`, and standalone — the highest-leverage discipline gap.
- `ui-state-clear` repeats 7 times — clearing state on file-watch events without preserving error chips is a known anti-pattern.
- `event-ordering` repeats 7 times — async race conditions around stream lifecycle / button-state / session-resume.
- `auth-token` repeats 5 times — OAuth machinery is the largest single class of fragility.

### FIXED [merge-wipe+type-gap]: Full build red — CompactionEntry.tokensAfter not in upstream type (2026-05-16)

- **Symptom:** `pnpm build` (and the pre-push hook chain) failed at `build:plugin-sdk:dts` with `src/gateway/session-utils.fs.ts(152): error TS2339: Property 'tokensAfter' does not exist on type 'CompactionEntry<unknown>'`. The gateway runtime was unaffected, so it went unnoticed until the full build was exercised.
- **Root cause:** Commit `962b1622fd` (2026-04-29, compaction-visibility / Bible §5.80) made compaction a visible event — `session-utils.fs.ts` reads `entry.summary` / `entry.tokensBefore` / `entry.tokensAfter` off the JSONL `type:"compaction"` entry to render the UI banner's "before → after tok" diff. The fork's compaction writer (`src/agents/pi-embedded-runner/compaction-hooks.ts:274`) genuinely persists `tokensAfter`, but upstream `@mariozechner/pi-coding-agent`'s `CompactionEntry<T>` (`core/session-manager.d.ts:36`) only declares `summary` + `tokensBefore` — not `tokensAfter`. esbuild/tsdown skips typecheck (runtime fine); only the strict `tsgo` dts build caught the gap. Only `tokensAfter` errored because `summary`/`tokensBefore` ARE in the upstream type.
- **Fix:** Declaration-merge `interface CompactionEntry<T = unknown> { tokensAfter?: number }` into `src/types/pi-coding-agent.d.ts` — the fork's existing augmentation home for that module (same pattern as the `Skill.source` augmentation already there; the dts tsconfig includes `src/types/**/*.d.ts`). Optional because pre-962b1622fd JSONL entries lack the field and the read site already guards with `typeof === "number" && Number.isFinite(...)`.
- **Files:** `src/types/pi-coding-agent.d.ts`
- **Prevention:** the compiler + the `build:plugin-sdk:dts` step in the pre-push gate IS the regression guard — a redundant grep-verify would be gold-plating. If the augmentation is ever removed the same TS2339 returns and blocks the build/push.
- **Rule:** After an upstream merge, fork code that reads fork-written-but-upstream-unmodeled fields off shared types belongs in `src/types/*.d.ts` declaration merges, not silent `as` casts. Runtime-green ≠ build-green: esbuild doesn't typecheck; always exercise the full `pnpm build` (or trust the pre-push dts step) before calling a type-touching change done.

### FIXED [cache-staleness]: Usage Bars Showing Stale Data from Disabled OAuth Endpoint (2026-04-03)

- **Symptom:** Anthropic 5h/7d usage bars showed stale or zeroed data regardless of actual usage. The bars hadn't updated since January 2026.
- **Root cause:** The `api.anthropic.com/api/oauth/usage` endpoint was disabled by Anthropic in January 2026. The budget-panel extension was silently failing to fetch usage data — returning null, which rendered as disconnected bars. No alternative data source existed.
- **Fix:** Rate limit headers (`anthropic-ratelimit-unified-5h-utilization`, `anthropic-ratelimit-unified-7d-utilization`) piggybacked on every API call via custom fetch wrapper in `anthropic-vertex-stream.ts`. Bars now update live on every LLM response with no additional API calls. See §5.53.
- **Files:** `anthropic-vertex-stream.ts`, `ratelimit-store.ts`, `attempt-hooks.ts`, `app.ts`

### FIXED [auth-scope+merge-wipe]: Tinker UI Missing Operator Scopes After Upstream Merge (2026-04-03)

- **Symptom:** Usage graphs not loading, session list empty, chat send failing, provider health unavailable — all silently after the 2026-03-30 upstream merge.
- **Root cause:** Upstream's stricter scope gate in `isOperatorUiClient()` didn't include `webchat-ui` (Tinker's client identity). WS connections downgraded to unprivileged scope.
- **Fix:** Added `webchat-ui` to `isOperatorUiClient()`. See §5.54.
- **Files:** `src/gateway/server-ws.ts`, `merge-guardian.sh`

### FIXED [display-misclassify+detection-pattern]: Fractal Prompts Appearing as User Messages in Chat (2026-04-03)

- **Symptom:** FRACTAL REFLECTION system prompts appeared as blue user chat bubbles in Tinker UI, making it look like the user had sent a multi-paragraph system message.
- **Root cause:** `startsWith("# FRACTAL REFLECTION")` detection failed when the WhatsApp gateway-connected system event was prepended to the same message string. The reflection header was no longer the first character.
- **Fix:** Changed to `includes("# FRACTAL REFLECTION")`. See §5.55.
- **Files:** `app.ts`, `extensions/tinkerclaw-fractal-reflection/src/fractal-inject.ts`

### FIXED [crash-on-startup]: Gateway Crash Loop — Missing dist/index.js (2026-03-26)

- **Symptom:** Gateway systemd service in crash loop (85+ restarts, ~5s interval). Jarvis fully offline — no WhatsApp, no webchat, no LLM sessions. Tinker UI disconnected.
- **Root cause:** `dist/index.js` (gateway entry point) was missing — the entire `dist/` directory was empty. Node threw `MODULE_NOT_FOUND` on every startup attempt. Likely caused by an interrupted build or merge that cleared `dist/` without completing the write.
- **Fix:** Cleared stale caches (`dist/.cache`, `node_modules/.cache`) and rebuilt with `pnpm build`. Restarted gateway with `openclaw-restart` (SIGUSR1, 1s recovery).
- **Rule:** After any build failure or upstream merge, verify `dist/index.js` exists before restarting. Consider adding a pre-start guard to the systemd unit and a `dist/index.js` check to `merge-guardian.sh`.

### FIXED [workspace-shadow+plugin-load]: WhatsApp Plugin Runtime Unavailable — Two Layered Failures (2026-03-21)

- **Symptom:** Every message in Tinker UI returns `WhatsApp plugin runtime is unavailable`. Two distinct errors surfaced sequentially.
- **Root cause 1 — stale workspace shadow:** `~/.openclaw/workspace/extensions/whatsapp/` was a 15-day-old copy (from 2026-03-06 workspace sync) that overrode the freshly-merged bundled version. It lacked `light-runtime-api.ts` and `runtime-api.ts` introduced by upstream commit `30a94dfd3`. Workspace extensions (rank 1) override bundled (rank 3) by design.
- **Root cause 2 — boundary discovery gap:** After removing the workspace copy, the runtime boundary's independent `loadPluginManifestRegistry()` call (no `workspaceDir`, different cache key than startup) only found 46/85 plugins. WhatsApp is an optional bundled cluster excluded from tsdown build — no `dist/extensions/whatsapp/` entry exists. The boundary's discovery silently dropped it.
- **Fix 1:** Removed stale `~/.openclaw/workspace/extensions/whatsapp/`.
- **Fix 2:** Added `OPENCLAW_BUNDLED_PLUGINS_DIR=~/src/tinkerclaw/extensions` to `~/.config/systemd/user/openclaw-gateway.service`. This upstream-supported env var bypasses auto-detection and ensures the boundary discovers all source extensions including optional clusters.

### FIXED [ui-state-clear]: Auth Error Badge Not Seeded for Dead OAuth Tokens (2026-03-21)

- **Symptom:** When an OAuth profile (cli-sv, cli-gm) had a dead/expired token, the models panel showed disconnected dashed bars but no clickable error badge. Users couldn't trigger re-auth because there was nothing to click.
- **Root cause:** `loadBudget()` only seeded error badges from `config.models` `disabledReason` (billing/cooldown). Dead tokens returned null from the usage API, but null was treated as "disconnected" (dashed bars) without also setting a `providerErrors` entry.
- **Fix:** `loadBudget()` now seeds a clickable `AUTH ERROR` badge in `providerErrors` for any OAuth profile (`cli-*`) where the budget API returns null usage data. The badge gets the `auth-clickable` class, enabling the reload/re-auth popover.
- **File:** `tinker-ui/src/app.ts` (`loadBudget`)

### FIXED [auth-token]: OAuth Re-Auth Token Exchange Wrong Content-Type (2026-03-21)

- **Symptom:** In-UI re-authentication flow completed (popup captured code) but token exchange returned an error from Anthropic's token endpoint.
- **Root cause:** `exchangeCodeForTokens()` in `extensions/auth-reload/reauth.ts` sent `Content-Type: application/json` with a JSON body, but Anthropic's `/v1/oauth/token` endpoint requires `application/x-www-form-urlencoded`. Also missing `state` parameter in the exchange request.
- **Fix:** Changed Content-Type to `application/x-www-form-urlencoded` with `URLSearchParams` body encoding. Added `state` parameter. Improved code parsing to accept three formats: `code#state` (auto-capture redirect fragment), bare authorization code, or full callback URL with `?code=` query param.
- **File:** `extensions/auth-reload/reauth.ts` (`exchangeCodeForTokens`)

### FIXED [display-misclassify]: Auth Flow Errors Showing [object Object] (2026-03-21)

- **Symptom:** When auth reload, re-auth start, or token exchange failed, the toast notification showed `[object Object]` instead of a human-readable error message.
- **Root cause:** Catch blocks in all three auth flow handlers string-coerced the raw gateway error object (which is `{ error: "message" }`) instead of extracting the message field.
- **Fix:** All auth flow catch blocks now extract `err.message || err.error` before displaying in toast.
- **File:** `tinker-ui/src/app.ts` (3 catch blocks: `auth.reload`, `auth.reauth.start`, `auth.reauth.exchange`)

### FIXED [crash-on-startup+plugin-load]: Budget Panel Extension Crash on Startup (2026-03-21)

- **Symptom:** Budget panel extension failed to register ANY gateway methods (`budget.usage`, `budget.status`, `config.models`), causing all model panel data to be unavailable.
- **Root cause:** `extensions/budget-panel/index.ts` called `registerPluginHttpRoute()` which doesn't exist in the plugin SDK. The crash on this call prevented all subsequent `registerMethod()` calls from executing.
- **Fix:** Changed to `api.registerHttpRoute()` (the correct plugin SDK method, same as used in the tinker extension).
- **File:** `extensions/budget-panel/index.ts`

### FIXED [ui-state-clear]: Billing Error Badges Cleared by File Watcher (2026-03-21)

- **Symptom:** When a model hit a billing cap, the error badge appeared briefly then disappeared. Re-sending a message hit the same billing cap again.
- **Root cause:** The `auth.profiles.updated` handler (triggered by file watcher on credential changes) unconditionally cleared all `providerErrors` entries before refreshing the budget panel. A billing cap error would trigger a credential file write (cooldown update), which triggered the file watcher, which cleared the billing error badge.
- **Fix:** The handler now preserves `billing` and `auth_permanent` errors in `providerErrors` during the clearing phase. Only transient errors (rate limits, overloaded, auth) are cleared on profile updates.
- **File:** `tinker-ui/src/app.ts` (`auth.profiles.updated` handler)

### FIXED [cache-staleness]: Stale Usage Cache After Re-Auth (2026-03-21)

- **Symptom:** After successfully re-authenticating via the in-UI OAuth flow, the models panel still showed dashed bars (disconnected) for up to 30 minutes.
- **Root cause:** The budget panel cached null usage results with 2min TTL and real data with 30min TTL. After re-auth, the `auth.profiles.updated` handler called `loadBudget()` which hit the backend cache — still serving the pre-re-auth null data until the 30min TTL expired.
- **Fix:** `loadBudget()` now accepts `{ forceRefresh: true }` which passes `forceRefresh` to the `budget.usage` RPC call. The backend `usageCache` is busted when this flag is set, forcing a fresh fetch with the new token. The `auth.profiles.updated` handler always passes this flag.
- **Files:** `tinker-ui/src/app.ts` (`loadBudget`), `extensions/budget-panel/index.ts` (`budget.usage` handler)
- **Scope:** 46 of 49 workspace extensions were stale duplicates of bundled extensions — all potential shadow failures. Only 3 are genuinely workspace-specific (`google-gemini-cli-auth`, `minimax-portal-auth`, `test-utils`).
- **Files:** systemd service file, `~/.openclaw/workspace/extensions/whatsapp/` (deleted)
- **Full report:** `memory/knowledge/whatsapp-light-runtime-api-incident-2026-03-21.md`

### FIXED [auth-token]: Cloudflare Blocks OAuth Refresh — Root Cause of Sleep Recovery Failure (2026-03-18)

- **Root cause:** pi-ai's `refreshAnthropicToken()` calls `fetch()` without a `User-Agent` header. Cloudflare blocks these with error 1010. Token refresh silently fails → access token stays expired → all Anthropic requests fail → falls to qwen3.
- **Why Claude Code works:** Claude Code's SDK includes proper headers. Same OAuth tokens, same API, different HTTP client behavior.
- **Fix:** `refreshAnthropicOAuthToken()` in `credential-file.ts` sends `User-Agent: openclaw-gateway/1.0`. Used by both `oauth.ts` and `proactive-refresh.ts` for Anthropic refreshes. pi-ai's function kept for other providers.
- **Files:** `credential-file.ts`, `oauth.ts`, `proactive-refresh.ts`
- **Note:** `proactive-refresh.ts` removed 2026-04-06 (upstream native `claude-cli` auth). User-Agent fix in `credential-file.ts` and `oauth.ts` remains relevant.

### FIXED [timeout-tuning]: Overloaded (529) Retry Storm (2026-03-18)

- **Root cause:** On 529, gateway retried 4+ times per profile with backoff, then rotated to next profile, retried again. 3+ minutes wasted hammering an overloaded API — made the overload worse.
- **Fix:** On `reason === "overloaded"`, skip `advanceAuthProfile()` entirely. Throw `FailoverError` immediately so model fallback picks qwen3 in seconds. 529 = provider is stressed, not per-key issue.
- **Files:** `run.ts` (prompt path + assistant path)

### FIXED [event-ordering]: Partial Streamed Text Wiped on Error (2026-03-18)

- **Root cause:** `messages.filter(!_temporary)` cleared all streaming messages on error. Partial Opus response (thinking + text) disappeared.
- **Fix:** Convert temporary messages with content to permanent `_partial` messages before filtering.
- **Files:** `app.ts`

### FIXED [event-ordering]: Session Resume Silent Failure (2026-03-18)

- **Root cause:** `requestHeartbeatNow({ reason: "session-resume" })` routed through 5 heartbeat gates that silently blocked it — "session-resume" was classified as "other" by the reason classifier, causing HEARTBEAT.md content check, quiet hours, disabled heartbeat, and wrong-prompt failures
- **Fix:** Replaced heartbeat-based resume with direct `agentCommand()` call (same pattern as `boot.ts`). Added "session-resume" → "wake" in `heartbeat-reason.ts` as defense in depth. Added guardian check.
- **Files:** `server-startup.ts` (main), `heartbeat-reason.ts` (defense), `merge-guardian.sh` (guard)

### FIXED [ui-state-clear]: Send Button Never Enabled (2026-03-03)

- **Root cause:** `updateBtn()` never called after `connected = true`
- **Fix:** Added `updateBtn()` calls after gateway handshake and in `ws.onclose`
- **Verification:** Enter key always worked (bypassed button state)

### FIXED [plugin-load]: Plugin API Wrong Method (2026-03-04)

- **Root cause:** Used `api.registerHttpHandler()` which doesn't exist in the plugin SDK
- **Fix:** Rewrote to `api.registerHttpRoute({ path: "/tinker", auth: "gateway", match: "prefix", handler })`

### FIXED [bundler-trap]: \_\_filename ESM Crash (2026-03-03)

- **Root cause:** `tsdown` bundled `bindings` inline into ESM where `__filename` is undefined
- **Symptom:** Gateway crashed every ~8 min when WhatsApp history DB accessed
- **Fix:** `external: ["better-sqlite3", "bindings"]` in ALL 8 `tsdown.config.ts` entries
- **Rule:** After every build: `grep -r '__filename' dist/ --include='*.js' | grep -v node_modules` should return nothing

### FIXED [crash-on-startup]: Missing Import Broke Model Glow (2026-03-03)

- **Root cause:** `getSessionResetPrompt` used but never imported in `get-reply-run.ts`
- **Symptom:** ReferenceError killed reply handler → no lifecycle events → no model glow
- **Fix:** Added import, added to wiring script + guardian checks

### FIXED [ui-state-clear]: Error Badges Bleeding Across Models (2026-03-05)

- **Root cause:** `fallback-error` handler stored errors keyed by bare provider name (e.g., `"anthropic"`). Rendering fell back to `providerErrors.get(provider)`, so ALL models from that provider showed the same error badge (opus, sonnet, haiku × 3 keys = 6 rows all showing "billing cap").
- **Fix:** 4 changes in `app.ts`:
  1. `fallback-error` handler: key by `failedProfileId || failedModel || failedProvider` (not bare provider)
  2. Rendering: fall back to `providerErrors.get(modelId)` instead of `providerErrors.get(provider)`
  3. Start-phase clearing: also delete model-keyed entries
  4. Health poll + retryProvider: also clear `provider/*` pattern entries
- **Rule:** `providerErrors` keys must never be bare provider names — always use profileId, modelId, or at minimum `provider/model`

### FIXED [event-ordering]: Fallback Errors Never Emitted to UI (2026-03-05)

- **Root cause:** `agent-runner-execution.ts` and `followup-runner.ts` had no `onError` callback → `fallback-error` lifecycle events never reached Tinker UI. Also `run.ts` only had 4 of 6 `fallback-profile-error` emission paths wired.
- **Fix:** Added `onError` callbacks in both runners emitting `fallback-error`. Extended `run.ts` to emit on all 6 failure paths with provider/model fields. Added `onError` in `model-fallback.ts` for provider-level cooldown skips.
- **Commit:** `29ff272d4`

### FIXED [bundler-trap+merge-wipe]: onlyBuiltDependencies Wiped by Merge (2026-03-05)

- **Root cause:** Upstream merge wiped `pnpm.onlyBuiltDependencies` → `better-sqlite3` native addon never built → crash on WhatsApp DB access
- **Fix:** Restored `better-sqlite3`, `@discordjs/opus`, `opusscript` to `onlyBuiltDependencies`
- **Commit:** `033526256`

### FIXED [plugin-load]: configSchema Mandatory (2026-03-05)

- **Root cause:** Upstream made `configSchema` mandatory in plugin manifests
- **Fix:** Added field to `openclaw.plugin.json`
- **Commit:** `033526256`

### FIXED [event-ordering]: Stop Button Not Working During Streaming (2026-03-06)

- **Root cause:** Two issues: (1) Click listener attached directly to `.thinking-run` elements inside `updateChat()` — during streaming, `innerHTML` replacement between mousedown and mouseup detached the element before the click event fired. (2) `abort()` didn't clear `activeRuns`, so even successful aborts showed no visual feedback until server events arrived.
- **Fix:** (1) Moved click handler to delegated listener on `#messages` container, registered once in `init()` — survives innerHTML wipes. (2) Added `activeRuns.clear()` in `abort()` for immediate UI response.
- **Rule:** Never attach per-element click listeners on DOM that gets replaced by innerHTML during streaming. Use event delegation.

### FIXED [bridge-leak]: WhatsApp Lifecycle Events Contaminating Main Session (2026-03-03)

- **Root cause:** `enqueueSystemEvent()` for WA connect/disconnect/relink routed to main because `resolveAgentRoute()` with no `peer` → `peerId=""` → all `dmScope` branches fall through to `buildAgentMainSessionKey()` → `agent:main:main`
- **Fix:** Removed 4 `enqueueSystemEvent` calls in `src/web/auto-reply/monitor.ts` (journal still logs these)
- **Rule:** `enqueueSystemEvent` without a peer WILL go to main session. Don't use for channel lifecycle.
- **Commit:** `1ba87b077`

### FIXED [ui-state-clear]: Usage Bar Fills Invisible (2026-03-07)

- **Root cause:** `.usage-bar` and `.usage-bar-fill` were `<span>` elements (inline by default). CSS `height` and `width` percentages are ignored on inline elements — bars rendered as 3px background tracks but fills had 0 effective width.
- **Fix:** Added `display:block` to both `.usage-bar` and `.usage-bar-fill` in `base.css`
- **Rule:** When using `<span>` for visual elements with dimensional properties, always set `display:block` or `display:inline-block`

### FIXED [auth-token]: Budget Panel Token Rotation Breaking Agent Auth (2026-03-09)

- **Root cause:** On usage API 429, budget-panel called `forceRefreshToken()` which rotated the OAuth token via Anthropic strict rotation — immediately invalidating the agent runner's in-memory token. Both cli-sv AND cli-gm got 401 errors simultaneously.
- **Fix:** On 429, return cached data instead of refreshing tokens. `usageCache[label]` updated with current timestamp to prevent re-fetching during the rate limit window.
- **Rule:** Budget panel must NEVER call `forceRefreshToken()` — it's a read-only consumer of OAuth tokens, not a token lifecycle participant.
- **Commit:** `f7e552f44`

### FIXED [ui-state-clear]: Error Clearing Too Aggressive (2026-03-09)

- **Root cause:** Lifecycle `start` handler cleared ALL `providerErrors` entries matching the starting model's provider. When cli-gm succeeded after cli-sv hit rate limit, cli-sv's error badge was wiped.
- **Fix:** Only clear the specific `authProfileId` from the start event + the `startModel` key. Other profiles' errors persist until they individually succeed or health poll clears them.
- **Commit:** `9d1162aa8`

### FIXED [event-ordering]: Session Resume Not Working After Gateway Restart (2026-03-08)

- **Root cause:** Two bugs: (1) `clearSessionResume` in `get-reply.ts` fired _before_ `runPreparedReply`, so the resume file was deleted before the crash-prone LLM streaming phase. (2) `enqueueSystemEvent` in `server-startup.ts` is passive — it only prepends text to the next LLM call's context but never triggers one, so the resumed prompt sat idle until the user manually sent a new message.
- **Fix:** (1) Moved `clearSessionResume` to after `runPreparedReply` completes. (2) Added `requestHeartbeatNow({ reason: "session-resume", sessionKey })` to actively trigger an LLM run on the interrupted session (same pattern as `/hooks/wake` with `mode=now`).
- **Files:** `src/auto-reply/reply/get-reply.ts`, `src/gateway/server-startup.ts`
- **Commit:** `11c7dfa5e`
- **Rule:** Resume files must persist through the entire LLM streaming phase. Passive system events need `requestHeartbeatNow` to trigger active processing.

### FIXED [plugin-load]: Hippocampus Plugin Not Found Warning (2026-03-10)

- **Root cause:** Hippocampus was configured as enabled in `openclaw.json` (`plugins.entries.hippocampus`) but had no extension directory with `openclaw.plugin.json`. The config validator scans `extensions/` for manifests to build `knownIds` — missing manifest = "plugin not found" warning on every gateway start.
- **Fix:** Created `extensions/hippocampus/` with manifest + no-op `index.ts` stub. The actual hippocampus code (importance scoring, dedup, episodic buffer) lives in `src/memory/engram/` and is wired at build time — the extension exists solely for plugin discovery.
- **Commit:** `92580a562`
- **Rule:** Any fork-only subsystem referenced in `openclaw.json` plugin entries must have a corresponding `extensions/<id>/openclaw.plugin.json` manifest, even if the code is wired elsewhere.

### FIXED [cleanup-race]: Gateway Draining Deadlock — Orphan Processes (2026-03-11)

- **Root cause:** `KillMode=process` in `openclaw-gateway.service` meant systemd only killed the main gateway PID on restart. Child processes (agent runs, channel workers, cron tasks) survived as orphans in the cgroup, accumulating across restarts (200 tasks, 10.8GB memory). When Jarvis used the gateway restart tool mid-task, the drain couldn't complete because orphaned tasks held the "draining" state — all new LLM requests rejected with "Gateway is draining for restart; new tasks are not accepted".
- **Fix:** Changed `KillMode=control-group` in `~/.config/systemd/user/openclaw-gateway.service` + `systemctl --user daemon-reload`. Now systemd kills the entire cgroup on restart — no orphans survive.
- **Rule:** After `openclaw gateway install --force`, verify `KillMode=control-group` is preserved (upstream default is `process`). If draining errors recur, check `systemctl --user status openclaw-gateway` for orphan child processes with old PIDs.
- **Symptom path:** UI shows "sending" → no response → all 4 fallback models fail with same drain error → `Agent failed before reply: Gateway is draining for restart`

### FIXED [cleanup-race]: Stuck Cron Session Resurrecting Across Restarts (2026-03-11)

- **Root cause:** Cron task `fdc72836` got stuck during the drain deadlock above. The gateway persists incomplete cron runs as `.jsonl` files in `~/.openclaw/cron/runs/`. On every boot, the gateway restores them from disk and re-runs them — immediately re-entering the stuck state. Cleaning `overseer-state.json` alone was insufficient; the cron run file kept resurrecting the session.
- **Fix:** Deleted `~/.openclaw/cron/runs/fdc72836-*.jsonl` + purged 15 accumulated cron entries from `overseer-state.json`.
- **Rule:** If a cron task is stuck and survives gateway restarts, check `~/.openclaw/cron/runs/` for its `.jsonl` file. Delete it to break the resurrection loop. Also: Jarvis should never use the gateway restart tool while his own tasks are active — the SIGUSR1 drain will deadlock if the draining task is the one being drained.

### FIXED [bridge-leak]: Heartbeat Contaminating Webchat (2026-02-21, config)

- **Root cause:** Heartbeat ran in main session, its prompt+response persisted to transcript, webchat loaded from history
- **Fix:** Config-only: `heartbeat.session: "heartbeat"`, `heartbeat.target: "none"`
- **Lesson:** When suppression patches don't work, check the PERSISTENCE layer

### FIXED [event-ordering]: Mute Button Not Toggling (2026-03-19)

- **Root cause:** All dev-mode API calls (`jarvis-mute`, `context-anatomy`) hardcoded `http://localhost:18789` as base URL, bypassing Vite proxy. Cross-origin POST with `Content-Type: application/json` triggered CORS preflight (OPTIONS) which gateway auth middleware rejected with 401. `.catch(() => {})` silently swallowed all errors — button appeared functional but never toggled.
- **Fix:** Changed all API base URLs to `""` (routes through Vite proxy at `/tinker/api` which injects `Authorization: Bearer` header). Removed `Content-Type: application/json` from mute POST. Added `/tinker/api` proxy route to `vite.config.ts`. Added defensive OPTIONS handler to mute endpoint.
- **Lesson:** Never bypass Vite proxy for gateway API calls in dev mode — the proxy handles auth injection. Silent `.catch(() => {})` hides real failures; at minimum log the error during development.

### FIXED [event-ordering]: Context-Anatomy 400 "Absolute path required" (2026-03-19)

- **Root cause:** Gateway loaded the tinker extension 3 times (source repo + workspace + gateway reload). Source version had a broad `pathname.startsWith("/tinker/api/")` catch-all for the file-read API that matched ALL `/tinker/api/` routes — including context-anatomy and mute — returning 400 before specialized handlers ran.
- **Fix:** Synced source extension from workspace version (mute → context-anatomy → file-read API ordering). Replaced `~/.openclaw/workspace/extensions/tinker/` with a symlink to `~/src/tinkerclaw/extensions/tinker/` to prevent future desync.
- **Lesson:** The gateway loads extensions from both source and workspace dirs. Keep them in sync via symlink. Specific routes must come before catch-all routes.

### FIXED [ui-state-clear]: "Overloaded" Label Persisting Indefinitely (2026-03-19)

- **Root cause:** Three clearing mechanisms all broken: (1) health poll called `provider.health` which doesn't exist on gateway; (2) `loadBudget` clearing skipped profiles with null usage data (cli-gm always null due to 403 scope error); (3) 2h TTL never expired because each new error re-set the timestamp.
- **Fix:** Clear provider errors for `authProfileId` and `provider/model` on successful run completion (`phase=end`). `loadBudget` clearing no longer requires usage data — clears transient errors for any profile in the response (preserves `billing`/`auth_permanent`).
- **Files:** `app.ts` (onEvent `phase=end` handler + `loadBudget` clearing)

### ~~FIXED: Proactive Refresh Failing Silently (2026-03-19)~~ [OBSOLETE — extension removed 2026-04-06]

- **Root cause:** When credential file had expired tokens and the refresh API returned null (stale refresh token), no log was emitted — just "token expired" then silence. Made it impossible to diagnose dead OAuth profiles from logs.
- **Fix:** Added 3 log lines in `proactive-refresh.ts`: credential file expired (with minutes ago), credential file unreadable, refresh returned null (with actionable `anthropic-oauth-login.mjs` command).
- **Note:** This fix is now obsolete — the `tinkerclaw-proactive-auth` extension was removed on 2026-04-06. Upstream handles auth natively.

### FIXED [cache-staleness]: Usage Cache 30min Lockout After Boot (2026-03-19)

- **Root cause:** Budget-panel cached failed usage fetches (`null`) with same 30min TTL as successful ones. On boot, if token wasn't ready yet (proactive refresh still running), null was cached for 30 minutes → dashed lines even after token refreshed seconds later.
- **Fix:** `CACHE_TTL_FAILED_MS = 2min` for null results, `CACHE_TTL_MS = 30min` for real data. Boot-time token races self-heal in 2 minutes.
- **File:** `extensions/budget-panel/index.ts`

### FIXED [auth-token]: OAuth Refresh Downscoping All Tokens (2026-03-20)

- **Root cause:** `refreshAnthropicOAuthToken()` in `credential-file.ts` passed `scope: "user:inference"` in the refresh request body. OAuth 2.0 `scope` in a refresh request is a **downscope** — it restricts the new token to only the listed scopes. Every refreshed token lost `user:profile`, `user:file_upload`, `user:mcp_servers`, etc. The `/api/oauth/usage` endpoint requires `user:profile` → 403 on all budget-panel usage fetches → dashed lines on all opus model rows.
- **Cascade:** Downscoped tokens were written back to BOTH `auth-profiles.json` AND credential files (`.credentials-sv.json`, `.credentials-gm.json`), corrupting the credential files that were supposed to be source of truth. cli-sv's refresh token was also invalidated by Anthropic strict rotation after 2 days, making it unrecoverable without re-login.
- **Fix:** Removed `scope: "user:inference"` from `refreshAnthropicOAuthToken()`. Omitting `scope` preserves the original grant's full scope set per OAuth 2.0 spec. Manually re-synced tokens from Claude Code's `.credentials.json` (full scopes) and re-logged cli-sv via `anthropic-oauth-login.mjs --profile sv`.
- **File:** `src/agents/auth-profiles/credential-file.ts`
- **Commit:** `b11812feb`
- **Rule:** Never pass `scope` in OAuth refresh requests unless intentionally downscoping. The refresh grant inherits all scopes from the original authorization.

### FIXED [restart-recovery]: Architect re-prompt required after gateway restart (2026-05-13)

- **Symptom:** After `openclaw-restart --full`, Jarvis's session resumed via the openclaw-sessionId fallback (FORK 2026-05-10) but he did not autonomously continue mid-task; the user had to type "keep going".
- **Root cause:** cc-bridge resume only re-attaches the claude-cli session; no `[System] continue` is injected. The 2026-04-20 generic continue had been bypassed by the 2026-05-10 fallback. No persisted plan meant the agent had nothing concrete to resume from.
- **Fix:** new `prefrontal.plan.*` RPCs + boot-time `runRestartContinue` that dispatches a plan-aware `[System] continue` via `chat.send {deliver:false, dispatchAgent:true}`. The grey `__SYS_PLAN_RESUME__` chip surfaces the action in TUI.
- **Spec:** `docs/superpowers/specs/2026-05-12-prefrontal-plan-board-design.md` (commit `131f26d`).
- **Plan:** `docs/superpowers/plans/2026-05-13-prefrontal-plan-board-implementation.md` (commit `f991621`).
- **Commits:** Phase 1 `25552c1b40`, Phase 2 `9e444add28`, Phase 3 `9a36d25c59`+`a092050166`, Phase 4 `1b806a92af`, Phase 5 `340fd1ae23`, Phase 6 `8e665c925f`+`7febf58974`, Phase 7 `02f92f7f18`.

### FIXED [config-dead-code]: WhatsApp QR Pairing 515 Restart Dead Code (2026-03-20)

- **Root cause:** Fork inlined `getStatusCode()` from upstream's `session-errors.ts` but missed the `err.error?.output?.statusCode` fallback added in upstream PR #27910. Baileys wraps errors as `{ error: { output: { statusCode: 515 } } }` — without the fallback, `login.errorStatus` was always `undefined` and the entire 515 restart path in `waitForWebLogin` was dead code. QR scan succeeded but the phone showed "cannot log in" because the restart socket was never created.
- **Cascade:** Two additional issues compounded: (1) single global creds save queue instead of per-authDir queues meant creds weren't reliably flushed before restart, (2) even with proper detection, the restart socket connected too fast (368ms) — WhatsApp servers need ~3s to finalize device registration after `pair-device-sign`.
- **Fix:** Added `err.error?.output?.statusCode` to `getStatusCode()`, ported per-authDir `credsSaveQueues` Map + `waitForCredsSaveQueueWithTimeout()`, added 3s delay before restart socket creation.
- **Files:** `extensions/whatsapp/src/session.ts`, `extensions/whatsapp/src/login-qr.ts`, `extensions/whatsapp/src/login.ts`
- **Commit:** `cd30d97cb`
- **Rule:** After upstream merges, verify fork's inlined `getStatusCode` matches upstream's `session-errors.ts`. The error unwrapping depth is critical for Baileys disconnect handling.

---
