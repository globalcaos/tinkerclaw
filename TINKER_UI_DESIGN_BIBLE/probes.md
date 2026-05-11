---
file: probes.md
purpose: Inspection primitives registry — every surface the AI can break, every probe that can inspect it
audience: AI
last_verified: 2026-05-11
last_verified_commit: HEAD
single_owner: yes — probe registry lives here. Other files reference probes by name; this file is the canonical list.
see_also: J15 paper §4.4 (Agent-Feedback Symmetry), failures.md (which probe diagnoses which failure)
---

# Probes — inspection primitives registry

The discipline (J15 §6 _Agent-Feedback Symmetry Principle_): for every action the AI can take that affects observable system state, there must exist an AI-callable inspection that returns that state, deterministically, in a single tool call.

A probe is **deterministic** (same input → same output, clocks masked), **bounded** (fixed max size), **single tool call** (one `Read` or one RPC), and **always-on** (no enabling flag).

## Live probes

| Probe                                                                             | Surface                                                                  | Returns                                                                                                       | Latency   | Implementation                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------- |
| `debug.dumpUiSnapshot` (RPC) + `Read(~/.openclaw/data/tinker-ui-snapshot.html)`   | Tinker UI chat DOM                                                       | rendered HTML, ~2 KB cap                                                                                      | <100ms    | `src/gateway/server-methods/debug-ui-snapshot.ts`, FORK 2026-05-09   |
| `[idle-timeout-diag]` journal log                                                 | LLM idle watchdog resolution per turn                                    | one line per turn with `idleTimeoutMs=N model.requestTimeoutMs=N params.timeoutMs=N configuredRunTimeoutMs=N` | n/a (log) | `src/agents/pi-embedded-runner/run/attempt.ts:1862`, FORK 2026-05-10 |
| `journalctl --user -u openclaw-gateway.service` grep                              | catch-all gateway event tail                                             | raw text                                                                                                      | seconds   | systemd journal                                                      |
| `Read(~/.openclaw/agents/main/sessions/sessions.json)`                            | session-store state for all sessions                                     | JSON                                                                                                          | <100ms    | direct file read                                                     |
| `Read(~/.openclaw/cc-bridge/session-map.json)`                                    | cc-bridge ↔ claude-cli sessionId mapping with openclawSessionId fallback | JSON                                                                                                          | <100ms    | direct file read                                                     |
| `Read(~/.openclaw/cron/jobs.json)`                                                | cron registry                                                            | JSON                                                                                                          | <100ms    | direct file read                                                     |
| `Read(~/.openclaw/cron/runs/<job>.jsonl)`                                         | cron last runs                                                           | JSONL                                                                                                         | <100ms    | direct file read                                                     |
| `Read(~/.claude/projects/-home-globalcaos--openclaw-jarvis-workspace/<id>.jsonl)` | claude-cli session transcript                                            | JSONL                                                                                                         | <100ms    | direct file read                                                     |
| `gateway.identity.get` (RPC)                                                      | gateway alive + deviceId                                                 | JSON                                                                                                          | <50ms     | `connect.ts`                                                         |
| `forensic.{getMode,getLive,listDumps,getDump,...}` (RPC)                          | request/response live capture + dumps                                    | JSON                                                                                                          | <100ms    | `src/gateway/server-methods/forensic.ts`                             |
| `whatsapp.history.search` (RPC)                                                   | (currently broken — known issue)                                         | n/a                                                                                                           | n/a       | re-enable in `tinkerclaw-whatsapp`                                   |
| sqlite3 read on `~/.openclaw/data/whatsapp-history.db`                            | WhatsApp message store                                                   | rows                                                                                                          | <500ms    | direct DB read                                                       |

## Proposed probes (gaps)

Each row is a surface where investigation is expensive today.

| Probe                                     | Surface                                                                   | Cost saved                                                | Priority |
| ----------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------- | -------- |
| `debug.tail.lastN({sessionKey,n,since?})` | recent agent events for one session                                       | replaces ~30 journal greps                                | **HIGH** |
| `debug.session.state({sessionKey})`       | lane state, worker liveness, idle timer remaining, queued replies, status | replaces grepping 6 files                                 | **HIGH** |
| `debug.session.config({provider})`        | effective resolved provider + model with override chain                   | catches the timeoutSeconds-dead-code regression on commit | **HIGH** |
| `wa.lastOutbound({chat,n})`               | last N WhatsApp outbound messages, including dropped/queued               | catches "Jarvis's reply never delivered" silently         | **HIGH** |
| `cron.lastRun({jobId})`                   | last run state, exit code, duration, output tail                          | replaces manual receipt-grep                              | medium   |
| `cc-bridge.workerInfo({sessionKey})`      | alive?, current cli sessionId, last turn duration, idle status            | catches stuck workers                                     | medium   |
| `wa.lastInbound({chat,n})`                | last N inbound messages for one chat                                      | symmetric companion to wa.lastOutbound                    | medium   |
| `agent.dispatch.lastN({n})`               | last N chat.send / agent invocations gateway-wide                         | catches dispatch storms                                   | low      |
| `plugin.boot.status`                      | per-plugin boot result (load ok / failed / disabled / version)            | catches M5 native-deps failures synchronously             | medium   |
| `auth.profile.status({provider,profile})` | last refresh time, last failure, billing state                            | catches OAuth refresh-token issues before they surface    | low      |

## Discipline for adding new probes

When a feature ships that affects observable state, add the probe in the same PR:

1. **Naming:** `<domain>.<noun>.<verb>` (e.g., `wa.lastOutbound`, `debug.session.state`). Use `debug.*` for development-only inspection that doesn't need policy gating.
2. **Scope:** READ_SCOPE for unprivileged inspection. ADMIN_SCOPE for anything that touches credentials or could be used for enumeration attacks.
3. **Determinism:** mask `Date.now()` outputs into bucketed timestamps. Mask `pid` and other process-specific fields unless they're the actual answer. Canonicalize UUID order.
4. **Bound:** every probe caps its return at a documented byte size (e.g., `2_000_000` for snapshot dumps).
5. **Documentation:** add a row to the Live table above. Reference from at least one failure-mode in `failures.md`.

## Verify

```yaml
verify:
  - cmd: openclaw gateway call debug.dumpUiSnapshot
    expect: ".ok == true"
  - cmd: test -f ~/.openclaw/data/tinker-ui-snapshot.html
    expect: "exit-code 0"
  - cmd: journalctl --user -u openclaw-gateway.service --since '5 minutes ago' --no-pager | grep -c '\[idle-timeout-diag\]'
    expect: "integer > 0" # at least one turn happened in the last 5 minutes
```

## Auto-generation

The Live table is auto-generatable from grep on `gateway/method-scopes.ts` (READ_SCOPE / ADMIN_SCOPE lists). The Proposed table is hand-maintained.
