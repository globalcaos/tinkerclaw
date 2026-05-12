---
file: failures.md
purpose: When X breaks, where does the symptom appear, and what is the resolution path
audience: AI
last_verified: 2026-05-11
last_verified_commit: HEAD
single_owner: yes — failure-mode propagation lives here. Reads like a debug runbook.
see_also: flows.md (the pipelines whose disruption causes these failures), lifecycles.md (which transitions don't fire), probes.md (what to call to diagnose)
verify:
  - name: M1 — claude-code idle timeout is 600000ms (NOT 120000)
    cmd: python3 -c 'import subprocess,json; r=subprocess.run(["openclaw","gateway","call","debug.session.config","--params",json.dumps({"provider":"claude-code"})],capture_output=True,text=True); assert "\"resolvedRequestTimeoutMs\": 600000" in r.stdout, r.stdout[-500:]'
  - name: M3 fork RPC alive — config.openExternalFile
    cmd: python3 -c 'import subprocess,json; r=subprocess.run(["openclaw","gateway","call","config.openExternalFile","--params",json.dumps({"path":"/dev/null"})],capture_output=True,text=True); assert "\"ok\"" in r.stdout, r.stdout[-500:]'
  - name: M3 fork RPC alive — files.resolveBareName
    cmd: python3 -c 'import subprocess,json; r=subprocess.run(["openclaw","gateway","call","files.resolveBareName","--params",json.dumps({"name":"BRIEFING.md"})],capture_output=True,text=True); assert "matches" in r.stdout, r.stdout[-500:]'
  - name: M3 fork RPC alive — briefing.resolve
    cmd: python3 -c 'import subprocess; r=subprocess.run(["openclaw","gateway","call","briefing.resolve"],capture_output=True,text=True); assert ("\"path\"" in r.stdout) or ("\"content\"" in r.stdout), r.stdout[-500:]'
  - name: M3 fork RPC alive — debug.dumpUiSnapshot
    cmd: python3 -c 'import subprocess; r=subprocess.run(["openclaw","gateway","call","debug.dumpUiSnapshot"],capture_output=True,text=True); assert "\"ok\"" in r.stdout, r.stdout[-500:]'
---

# Failure-mode map

Each row is one failure mode: where it originates → what envelope/symptom it produces → which channel it surfaces in → user-visible signal → resolution path.

## Error envelope categories

The `__ERR_ENV__:` envelope (bible §5.69) is the single wire-level format for surfacing failures across channels. Categories and icons:

| Category                   | Icon | Fatal? | Triggered by                                                                            |
| -------------------------- | ---- | ------ | --------------------------------------------------------------------------------------- |
| `subscription`             | 💳   | yes    | OAuth subscription exhausted                                                            |
| `billing`                  | 💸   | yes    | metered API key billing failure                                                         |
| `auth`                     | 🔐   | yes    | 401, OAuth invalid                                                                      |
| `rate_limit`               | 🚦   | no     | 429                                                                                     |
| `overload`                 | 🌊   | no     | 500 / provider overload                                                                 |
| `network`                  | 📡   | no     | DNS, ECONNRESET, etc.                                                                   |
| `timeout`                  | ⏱️   | no     | LLM idle watchdog, request timeout                                                      |
| `lane_busy`                | 🔄   | no     | previous run still shutting down (and: gateway restart chip uses this with fatal=false) |
| `reply_run_already_active` | ⏳   | no     | duplicate idempotency                                                                   |
| `incomplete_turn`          | 🫥   | no     | stream ended without final                                                              |
| `tool_error`               | 🔧   | no     | exec tool failure surfaced                                                              |
| `compaction_error`         | 🧹   | no     | compaction pipeline failure                                                             |
| `generic`                  | ⚠️   | yes    | unclassified                                                                            |

Generation: from `src/fork/error-envelope.ts`. Update this table when categories are added.

## Failure modes

### M1. cc-bridge SIGTERM (LLM idle watchdog)

- **diagnose_with:** `debug.session.config({provider:"claude-code"})` → assert `resolvedRequestTimeoutMs=600000`. `gateway.stuckSessions({thresholdMs:120000})` → if a session is past the old 120s threshold but `resolvedRequestTimeoutMs=600000`, the watchdog is correctly relaxed; otherwise the overlay broke. Journal grep `[idle-timeout-diag]` confirms per-turn resolution.
- **Origin:** `streamWithIdleTimeout` in `src/agents/pi-embedded-runner/run/llm-idle-timeout.ts`. Idle timer racing `streamIterator.next()`. cc-bridge intentionally does NOT emit `stream` events during tool work (see `tool-loop.md`), so heavy turns can starve the timer.
- **Propagation:** idle timeout rejects → `idleTimeoutTrigger(error)` → `abortRun(true, error)` aborts `runAbortController` → cc-bridge worker receives signal → `worker.kill("SIGTERM")` → claude-cli exits → `assistant-failover.ts` classifies as `surface_error reason=timeout`.
- **Envelope:** category `timeout` (icon ⏱️) or `lane_busy` if classified that way. Text: `"🤖 ⚠️ Something went wrong while processing your request."`
- **Surface:**
  - WhatsApp: envelope delivered as chunked text via `deliverWebReply`. User sees the chip.
  - Tinker UI: pre-2026-05-10 → spinner stuck on `sending...` (lifecycle event dropped). Post-fix → backstop `broadcastChatFinal` fires; chip renders, spinner clears.
- **Resolution:** ensure `timeoutSeconds` is correctly resolved (see config-shape.md M1 ↔ that file). Architectural fix LIVE 2026-05-11: cc-bridge now emits an empty-delta heartbeat every 25s during a turn so the watchdog resets without re-executing tools. The 600s overlay is now belt-and-suspenders rather than load-bearing. See `tool-loop.md`.
- **Detection probe:** journal grep `[llm-idle-timeout]` lines, plus the `[idle-timeout-diag]` log shows the resolved timeout. Heavy turns hitting 138s/279s without `[idle-timeout-diag] idleTimeoutMs=600000` means the overlay path broke.
- **Bug history:** 2026-05-05 catalog `timeoutSeconds:600` was dead code; 2026-05-10 fixed via plugin overlay (bible §11.6d, §11.6e).

### M2. Webchat surface_error spinner stuck

- **diagnose_with:** `debug.dumpUiSnapshot()` then `Read(~/.openclaw/data/tinker-ui-snapshot.html)` and grep for `thinking-pending`. Cross-check with `debug.session.state({sessionKey})` — if `activeRunIds=[]` but a `thinking-pending` chip is in the snapshot, this is M2.
- **Origin:** `chat.send`'s `.then()` previously only emitted `broadcastChatFinal` when `!agentRunStarted`. On surface_error timeouts the agent did start; the lifecycle event from `server-chat.ts:emitChatFinal` was the only path to `state="final"`. If that path dropped (e.g. `isControlUiVisible=false`), TUI received NO final event.
- **Propagation:** lifecycle event dropped → no `state="final"` broadcast → TUI's `thinking-pending` indicator never clears.
- **Surface:** Tinker UI spinner stays on `sending...` indefinitely.
- **Resolution:** backstop in `chat.ts` `.then()` agentRunStarted branch always emits `broadcastChatFinal` with `deliveredReplies` content (FORK 2026-05-10, bible §11.6e). Idempotent vs lifecycle path because `broadcastChatFinal` deletes `agentRunSeq[runId]`.
- **Detection:** read `~/.openclaw/data/tinker-ui-snapshot.html` and grep for `thinking-pending`. If a session shows pending without an active run in the journal, this is the failure.
- **Bug history:** regression C from 2026-05-10.

### M3. Upstream-merge wipe of fork RPC handler

- **diagnose_with:** each fork RPC has its own probe in this file's `verify` block — `config.openExternalFile`, `files.resolveBareName`, `briefing.resolve`, `debug.dumpUiSnapshot`. If any returns `unknown method`, M3 fired during the last merge. The full set is enumerated under "Detection probe" below.
- **Origin:** weekly merge of upstream/main rebases `src/gateway/server-methods.ts`; conflicts that look "safe" can drop fork-added imports / spreads.
- **Propagation:** handler missing from `coreGatewayHandlers` → any RPC call to it returns `unknown method: <name>` (`INVALID_REQUEST`).
- **Surface:** the call site fails. For UI features (e.g., `.fs-link` click), the click silently does nothing or shows a console error.
- **Resolution:**
  - Short-term: restore the handler import + spread.
  - Long-term: J15 merge gate — a `verify` command for each fork-added RPC fails the merge.
- **Detection probe:** for each fork-added handler, `openclaw gateway call <method> --params '{...}'`. List of fork RPCs that need verify commands:
  - `config.openExternalFile` (FORK §5.68)
  - `briefing.resolve` (FORK §11.6b)
  - `files.resolveBareName` (FORK §11.6c)
  - `debug.dumpUiSnapshot` (FORK §11.6c)
  - `fork.subagents.spawn`
  - `fork.prefrontal.state.*`
- **Bug history:** regression A from 2026-05-10 (`config.openExternalFile` wiped 2026-04-29, surfaced 2026-05-09).

### M4. cc-bridge channel context bleed (suspected but not real)

- **diagnose_with:** `Read(~/.openclaw/cc-bridge/session-map.json)` and assert each WA channel + TUI channel produces a distinct `openclawSessionId`. If two channels share an openclawSessionId, the channel-isolation invariant has actually been violated (would be a real M4, not the suspected one). The 2026-05-09 evidence: WA=`a87a4e61`, TUI=`bf76b61f` — separate.
- **Origin:** suspected when `/new` was typed in TUI and a WhatsApp reply showed unexpected content.
- **Investigation result:** NOT bleed at cc-bridge layer. The two channels have distinct `openclawSessionId` (e.g. WA=`a87a4e61`, TUI=`bf76b61f`); session-map's `getLatestResumeSessionIdByOpenclawSessionId` only resolves WITHIN one openclaw session.
- **Actual cause of the symptom:** M1 (cc-bridge SIGTERM) on the WA turn + concurrent /new turn timing; the "something went wrong" envelope on WA was timing-correlated with the /new in TUI, leading to misattribution.
- **Resolution:** none required at cc-bridge layer. Document that channel isolation is invariant: openclawSessionId is canonical, lookup priority is openclawSessionId-first.
- **Don't regress:** in `worker-pool.getOrCreate`, openclawSessionId lookup MUST come BEFORE sessionKey lookup. Reversing brings back stale-entry-wins behavior.

### M5. Plugin native-deps missing at boot

- **diagnose_with:** `plugin.boot.status({status:"error"})` returns every plugin that failed to load with `error`, `failurePhase`, and `failedAt`. The 2026-05-11 example we hit: `tinkerclaw-round-table` and `tinkerclaw-total-recall` both with `Cannot find module '@sinclair/typebox'`. Probe replaces the journal grep that used to be the only path.
- **manifest_via:** `debug.simulate.pluginLoadFail({pluginId:"__simulated-test", failurePhase:"load"})` (admin-scope) injects a fake plugin record with `status:"error"` directly into the in-memory registry; calling `plugin.boot.status --params '{"status":"error"}'` immediately after must include it. Cleanup with `debug.simulate.pluginLoadFail --params '{"action":"clear"}'`. Round-trip-tests the diagnose_with claim above.
- **Origin:** `pnpm.onlyBuiltDependencies` in `package.json` is wiped on upstream merges. After a merge, `better-sqlite3`, `opusscript`, `@discordjs/opus` are no longer pre-built.
- **Propagation:** plugin import fails with `Cannot find module '@sinclair/typebox'` or similar native-binding errors.
- **Surface:** gateway boot warning, plugin disabled, features silently missing. Today's example: `tinkerclaw-round-table` and `tinkerclaw-total-recall` fail to load.
- **Resolution:**
  - Add the deps back to `pnpm.onlyBuiltDependencies` in package.json.
  - Run `pnpm rebuild better-sqlite3 opusscript @discordjs/opus`.
  - Restart gateway with `--full`.
- **Detection probe:** parse boot journal for `failed to load plugin` lines.
- **Long-term fix:** a post-merge hook that asserts the deps are present.

### M6. plugin configSchema missing

- **diagnose_with:** `plugin.boot.status({status:"error"})` — if a plugin's `failurePhase` is `"validation"`, the manifest itself is invalid (M6 territory); `"load"` means import-time crash (M5 territory); `"register"` means the plugin loaded but its `register()` hook threw. The phase distinguishes the cascading-config-validation failure (gateway refuses to start at all) from a single-plugin native-deps issue.
- **Origin:** since 2026-03-05, upstream requires `configSchema` field in every `openclaw.plugin.json`. Forgetting it = config validation error loop blocks ALL plugins (cascading).
- **Surface:** gateway boot fails entirely.
- **Resolution:** add `configSchema: {}` (at minimum) to every fork plugin manifest. See bible's "Plugin manifests" rule.

### M7. WhatsApp self-DM trigger leak (LID rescue too permissive)

- **diagnose_with:** `wa.recentOutbound({n:20})` — scan for outbounds to LID chats that are NOT the owner's self-LID. Cross-reference with the trigger-gate unit tests (`extensions/tinkerclaw-whatsapp/src/auto-reply/monitor/decide-trigger.test.ts` covers the post-rescue gate). Also: `decide-trigger.test.ts` case (b) is a regression guard for this exact class.
- **Origin:** `inbound/monitor.ts` LID rescue used to accept ANY `@lid` chat with `fromMe=true` as self-DM. When the owner DMed a family contact via that contact's LID, rescue rewrote the chat to owner self-DM, trigger fired without prefix, reply leaked to the contact's DM.
- **Propagation:** rescue branch sets `from=lidString` and prompts pass; but the wrong recipient is computed for the outbound.
- **Surface:** unintended outbound to a non-owner chat.
- **Resolution (2026-05-04):** rescue is gated on `self.lid===remoteJid` OR (`remoteJid ∈ noPrefixChats ∧ allowFrom`). Anything looser = bug.
- **Open follow-up:** populate `self.lid` from whatsmeow auth state.

### M8. Briefing cron pass ≠ user-delivered pass

- **diagnose_with:** `cron.lastRun({jobId:"morning-briefing"})` returns the receipt path. `Read(memory/morning-briefings/<date>.md)` shows the cron pass content. If the user-pass-1 output omits items present in the cron pass receipt, M8 is firing (delta-mode against an unread audit artifact).
- **Origin:** cron runs `morning-briefing` at 07:00 and writes `memory/morning-briefings/YYYY-MM-DD.md` as an audit artifact (deliver:false). User typing `/new` later expects a USER pass, not a delta on top of the cron pass.
- **Propagation:** Jarvis reads the cron pass, treats `/new` as Pass 2, renders "delta-only" → user is confused because they never saw Pass 1.
- **Surface:** user `/new` returns sparse content with no priorities visible.
- **Resolution:** the cron pass is an audit; `/new` is always user-pass-1 → render FULL content. Always ENUMERATE preflight reds/yellows by name (counts alone are useless). See memory note 2026-05-11.

### M9. Auto-merge silently breaks fork behavior

- **diagnose_with:** `pnpm bible:invariants` is the canonical post-merge probe. Every `verify:` in the bible files is a contract; the runner is what enforces them. `cron.lastRun({jobId:"daily-fork-sync"})` confirms whether the auto-merge ran. While the cron is disabled (2026-05-09), running the runner manually after every merge is the workaround.
- **Origin:** the daily-fork-sync cron (currently DISABLED 2026-05-09) merges upstream and ships if `pnpm build` passes. Build-passing ≠ behavior-preserving.
- **Propagation:** fork RPC wiped (M3), fork patch reverted, plugin manifest field dropped, native-deps array wiped (M5), etc.
- **Resolution:** J15 merge gate (paper §5) — run `pnpm test:invariants` after build; refuse merge if any `verify` command newly fails. Today this is proposed, not implemented. The merge cron stays disabled until the gate ships.

### M10. Stuck session.status=running

- **diagnose_with:** `gateway.stuckSessions({thresholdMs:60000})` returns processing sessions older than 60s, sorted by age. `debug.session.state({sessionKey})` then returns the persisted `sessions.json` entry plus the live `activeRunIds` — if entry shows `status:running` but `activeRunIds=[]`, the session is stuck in M10. `gateway.observability.snapshot` includes the stuck-session example list as one section of the single-call dashboard.
- **manifest_via:** `debug.simulate.stuckSession({ageMs:120000})` (admin-scope) injects a fake processing session aged 2 minutes; calling `gateway.stuckSessions` immediately after must include it in the returned list. Round-trip-tests the diagnose_with claim above. Cleanup with `debug.simulate.stuckSession --params '{"action":"clear"}'`.
- **Origin:** L1 lifecycle (lifecycles.md) — on surface_error or timeout, the session.status sometimes stays `running` in `sessions.json`.
- **Propagation:** next message on the same session may behave oddly; recovery code catches it on next reboot via `markRunningMainSessionsAsInterrupted`.
- **Surface:** symptom is bounded (recovery cleans it up) but cosmetic confusion.
- **Resolution:** open follow-up — pi-agent-core should transition status synchronously on surface_error. For now, restart picks it up.

## Verify commands (proposed)

```yaml
verify:
  - cmd: openclaw gateway call config.openExternalFile --params '{"path":"/dev/null"}'
    expect: ".ok != null" # M3 probe for this specific fork RPC
  - cmd: openclaw gateway call files.resolveBareName --params '{"name":"BRIEFING.md"}'
    expect: ".matches | length >= 1"
  - cmd: openclaw gateway call briefing.resolve
    expect: ".path != null"
```

Wire every M-row's "Resolution" column to a probe + verify cmd. Today: zero of these are wired into a merge gate. Future: J15 §5.
