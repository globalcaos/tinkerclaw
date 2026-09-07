---
file: probes.md
purpose: Inspection primitives registry — every surface the AI can break, every probe that can inspect it
audience: AI
last_verified: 2026-06-02
last_verified_commit: 06f8647fdc
single_owner: yes — probe registry lives here. Other files reference probes by name; this file is the canonical list.
see_also: J15 paper §4.4 (Agent-Feedback Symmetry), failures.md (which probe diagnoses which failure)
verify:
  - name: debug.session.config probe is live
    cmd: python3 -c 'import subprocess,json; r=subprocess.run(["openclaw","gateway","call","debug.session.config","--params",json.dumps({"provider":"claude-code"})],capture_output=True,text=True); assert "resolvedRequestTimeoutMs" in r.stdout, r.stdout[-500:]'
  - name: debug.session.state probe is live
    cmd: python3 -c 'import subprocess,json; r=subprocess.run(["openclaw","gateway","call","debug.session.state","--params",json.dumps({"sessionKey":"agent:main:main"})],capture_output=True,text=True); assert "sessionKey" in r.stdout, r.stdout[-500:]'
  - name: debug.tail.lastN probe is live
    cmd: python3 -c 'import subprocess,json; r=subprocess.run(["openclaw","gateway","call","debug.tail.lastN","--params",json.dumps({"sessionKey":"agent:main:main","n":3})],capture_output=True,text=True); assert ("events" in r.stdout) or ("error" in r.stdout), r.stdout[-500:]'
  - name: cron.lastRun probe is live
    cmd: python3 -c 'import subprocess,json; r=subprocess.run(["openclaw","gateway","call","cron.lastRun","--params",json.dumps({"jobId":"morning-briefing"})],capture_output=True,text=True); assert "receiptPath" in r.stdout, r.stdout[-500:]'
  - name: cron.listJobs probe is live (budgeted retries; reports a per-attempt trail with exit + stdout + stderr)
    cmd: |
      python3 << 'PYEOF'
      # 2026-09-07 flake fix. cron.listJobs needs ~14s end-to-end, but the CLI's
      # own RPC deadline defaults to 10000ms, so roughly half of all runs died on
      # "gateway timeout after 10000ms" -- written to STDERR, which the old assert
      # threw away (it reported r.stdout[-500:], and on that path stdout is EMPTY).
      # The push gate therefore printed a NAKED AssertionError, indistinguishable
      # from a real contract regression. Three-part fix: size the RPC deadline
      # ourselves via --timeout, retry inside a wall-clock budget that stays under
      # the runner's 30s SIGTERM (test-invariants.mjs TIMEOUT_MS), and report a
      # per-attempt trail so a flake can never again look like a broken contract.
      # Do NOT "simplify" this into 3 blind attempts: a failing attempt costs
      # ~18s of wall clock, so three of them are killed by the runner mid-flight
      # and print nothing at all -- which is the exact bug being fixed here.
      import subprocess, time
      RPC = "cron.listJobs"
      NEEDLE = "jobCount"        # the contract. Unchanged, and deliberately not broadened.
      BUDGET = 27.0              # runner SIGTERMs at 30s; keep 3s of headroom
      MIN_ATTEMPT = 12.0         # measured: connect ~5-10s + RPC ~14s. Below this a retry cannot finish, so do not burn budget pretending.
      def trim(s, n=200):
          s = (s or "").strip().replace("\n", " | ")
          return s[:n] + ("..." if len(s) > n else "")
      deadline = time.monotonic() + BUDGET
      trail, attempts, rpc_ms, ok = [], 0, 0, False
      while attempts < 3 and not ok:
          remaining = deadline - time.monotonic()
          if remaining < MIN_ATTEMPT:
              trail.append("#%d skipped: only %.1fs of budget left" % (attempts + 1, remaining))
              break
          attempts += 1
          # --timeout bounds the RPC but NOT the connect/handshake, which measured
          # 4.6s-10s here, so reserve 9s for it. Sizing the RPC deadline under the
          # remaining budget lets the CLI's OWN error ("gateway timeout after Nms")
          # fire first and reach the trail; the subprocess timeout is the backstop.
          rpc_ms = int(max(5.0, min(18.0, remaining - 9.0)) * 1000)
          t0 = time.monotonic()
          try:
              r = subprocess.run(["openclaw", "gateway", "call", RPC, "--timeout", str(rpc_ms)], capture_output=True, text=True, timeout=remaining)
              ok = NEEDLE in r.stdout
              trail.append("#%d %.1fs exit=%s stdout=%r stderr=%r" % (attempts, time.monotonic() - t0, r.returncode, trim(r.stdout), trim(r.stderr)))
          except subprocess.TimeoutExpired as ex:
              # Say "gateway timeout after Nms" literally: it is true (we waited N
              # ms and got no reply) and it is what test-invariants.mjs
              # GATEWAY_DOWN_PATTERNS matches, so a wedged gateway is filed as a
              # SKIP instead of a red contract regression. Carry any partial output.
              trail.append("#%d %.1fs KILLED -- gateway timeout after %dms (wall-clock budget, no reply) stdout=%r stderr=%r" % (attempts, time.monotonic() - t0, int((time.monotonic() - t0) * 1000), trim(ex.stdout if isinstance(ex.stdout, str) else ""), trim(ex.stderr if isinstance(ex.stderr, str) else "")))
          if not ok and deadline - time.monotonic() > 6.0:
              time.sleep(0.5)
      assert ok, "%s: %r never appeared in stdout after %d attempt(s) (rpc deadline %dms each, %.0fs total budget, runner kills at 30s):\n  %s" % (RPC, NEEDLE, attempts, rpc_ms, BUDGET, "\n  ".join(trail))
      PYEOF
  - name: debug.dumpUiSnapshot probe is wired (accepts ok:true OR ok:false with "html required" — both prove the handler is loaded)
    cmd: python3 -c 'import subprocess; r=subprocess.run(["openclaw","gateway","call","debug.dumpUiSnapshot"],capture_output=True,text=True); assert "\"ok\":" in r.stdout or "\"ok\" :" in r.stdout, r.stdout[-500:]'
  - name: wa.recentOutbound probe is live
    cmd: python3 -c 'import subprocess,json; r=subprocess.run(["openclaw","gateway","call","wa.recentOutbound","--params",json.dumps({"n":1})],capture_output=True,text=True,timeout=25); assert "\"rows\"" in r.stdout, r.stdout[-500:]'
  - name: gateway.stuckSessions probe is live
    cmd: python3 -c 'import subprocess; r=subprocess.run(["openclaw","gateway","call","gateway.stuckSessions"],capture_output=True,text=True,timeout=25); assert "stuckCount" in r.stdout, r.stdout[-500:]'
  - name: gateway.diagnosticSessionCount probe is live
    cmd: python3 -c 'import subprocess; r=subprocess.run(["openclaw","gateway","call","gateway.diagnosticSessionCount"],capture_output=True,text=True,timeout=25); assert "byState" in r.stdout, r.stdout[-500:]'
  - name: plugin.boot.status probe is live + reports at least one plugin
    cmd: python3 -c 'import subprocess; r=subprocess.run(["openclaw","gateway","call","plugin.boot.status"],capture_output=True,text=True,timeout=25); assert "byStatus" in r.stdout and "plugins" in r.stdout, r.stdout[-500:]'
  - name: gateway.observability.snapshot probe is live + has all sections
    cmd: python3 -c 'import subprocess; r=subprocess.run(["openclaw","gateway","call","gateway.observability.snapshot"],capture_output=True,text=True,timeout=25); body = r.stdout; assert "sessions" in body and "plugins" in body and "runtime" in body and "capturedAt" in body, f"missing sections in response (exit={r.returncode})\nstderr: {r.stderr[-400:]}\nstdout: {body[-800:]}"'
  - name: gateway.flow.replay probe is wired (returns shape even with no matches)
    cmd: python3 -c 'import subprocess,json; r=subprocess.run(["openclaw","gateway","call","gateway.flow.replay","--params",json.dumps({"correlationId":"NOSUCHID","sinceMinutes":1})],capture_output=True,text=True,timeout=20); assert "eventCount" in r.stdout, f"missing eventCount (exit={r.returncode})\nstderr: {r.stderr[-400:]}\nstdout: {r.stdout[-800:]}"'
  - name: gateway.slo.burnRate probe is wired (returns slos array)
    cmd: python3 -c 'import subprocess; r=subprocess.run(["openclaw","gateway","call","gateway.slo.burnRate"],capture_output=True,text=True,timeout=20); assert "slos" in r.stdout and "anyBurning" in r.stdout, f"missing fields (exit={r.returncode})\nstderr: {r.stderr[-400:]}\nstdout: {r.stdout[-400:]}"'
  - name: fork.prefrontal.embed handler is registered in core
    cmd: python3 -c 'import os; p=os.path.expanduser("~/src/tinkerclaw/src/fork/prefrontal-state-rpc.ts"); s=open(p).read(); assert "\"fork.prefrontal.embed\"" in s, "handler missing"; assert "createConfiguredEmbeddingProvider" in s, "provider import missing"'
  - name: fork.strategy.switch.list probe is live (U4)
    cmd: python3 -c 'import subprocess; r=subprocess.run(["openclaw","gateway","call","fork.strategy.switch.list"],capture_output=True,text=True); assert "\"ok\"" in r.stdout, r.stdout[-400:]'
  - name: fork.skill.search probe is live (U6, query required)
    cmd: python3 -c 'import subprocess,json; r=subprocess.run(["openclaw","gateway","call","fork.skill.search","--params",json.dumps({"query":"probe-self-test"})],capture_output=True,text=True); assert "\"ok\"" in r.stdout, r.stdout[-400:]'
  - name: fork.memory.search probe is live + echoes temporalMode (U3, query required; budgeted retries)
    cmd: |
      python3 << 'PYEOF'
      # Same 2026-09-07 flake fix as the cron.listJobs block above -- read that one
      # for the full reasoning. `query` stays REQUIRED (omitting it returns
      # INVALID_REQUEST and a non-zero exit), and the asserted contract is still
      # the echoed temporalMode, matched on exactly the same string as before.
      # READ THIS BEFORE SUSPECTING THE CONTRACT: on a loaded box this call was
      # measured at 38-44s end-to-end, which does not fit the runner's 30s
      # SIGTERM at all. A red here with a "gateway timeout after Nms" stderr in
      # the trail below is a LATENCY verdict, not a broken RPC -- check gateway
      # latency first. Raising test-invariants.mjs TIMEOUT_MS is the real fix.
      import json, subprocess, time
      RPC = "fork.memory.search"
      PARAMS = json.dumps({"query": "probe-self-test"})   # query is REQUIRED
      NEEDLE = '"temporalMode"'  # the contract. Unchanged, and deliberately not broadened.
      BUDGET = 27.0              # runner SIGTERMs at 30s; keep 3s of headroom
      MIN_ATTEMPT = 12.0         # measured: connect ~5-10s + RPC ~14s. Below this a retry cannot finish, so do not burn budget pretending.
      def trim(s, n=200):
          s = (s or "").strip().replace("\n", " | ")
          return s[:n] + ("..." if len(s) > n else "")
      deadline = time.monotonic() + BUDGET
      trail, attempts, rpc_ms, ok = [], 0, 0, False
      while attempts < 3 and not ok:
          remaining = deadline - time.monotonic()
          if remaining < MIN_ATTEMPT:
              trail.append("#%d skipped: only %.1fs of budget left" % (attempts + 1, remaining))
              break
          attempts += 1
          # This RPC is far dearer than the table's "~1s": measured 8s-44s on
          # 2026-09-07 (it runs an embedding pass). Reserve only ~7s for connect
          # and hand the rest to the RPC, since no retry can rescue a 40s call.
          rpc_ms = int(max(5.0, min(20.0, remaining - 7.0)) * 1000)
          t0 = time.monotonic()
          try:
              r = subprocess.run(["openclaw", "gateway", "call", RPC, "--params", PARAMS, "--timeout", str(rpc_ms)], capture_output=True, text=True, timeout=remaining)
              ok = NEEDLE in r.stdout
              trail.append("#%d %.1fs exit=%s stdout=%r stderr=%r" % (attempts, time.monotonic() - t0, r.returncode, trim(r.stdout), trim(r.stderr)))
          except subprocess.TimeoutExpired as ex:
              # Say "gateway timeout after Nms" literally: it is true (we waited N
              # ms and got no reply) and it is what test-invariants.mjs
              # GATEWAY_DOWN_PATTERNS matches, so a wedged gateway is filed as a
              # SKIP instead of a red contract regression. Carry any partial output.
              trail.append("#%d %.1fs KILLED -- gateway timeout after %dms (wall-clock budget, no reply) stdout=%r stderr=%r" % (attempts, time.monotonic() - t0, int((time.monotonic() - t0) * 1000), trim(ex.stdout if isinstance(ex.stdout, str) else ""), trim(ex.stderr if isinstance(ex.stderr, str) else "")))
          if not ok and deadline - time.monotonic() > 6.0:
              time.sleep(0.5)
      assert ok, "%s (params=%s): %s never appeared in stdout after %d attempt(s) (rpc deadline %dms each, %.0fs total budget, runner kills at 30s):\n  %s" % (RPC, PARAMS, NEEDLE, attempts, rpc_ms, BUDGET, "\n  ".join(trail))
      PYEOF
  - name: post-deploy smoke self-test passes (pure helpers, no live system touched)
    cmd: python3 -c 'import os,subprocess; p=os.path.expanduser("~/src/tinkerclaw/scripts/post-deploy-smoke.mjs"); r=subprocess.run(["node",p,"--self-test"],capture_output=True,text=True,timeout=60); assert r.returncode==0, r.stdout[-1200:]+r.stderr[-1200:]'
  - name: post-deploy smoke emits all six checks WITH evidence in --json (gates the probe, not the system health — verdicts are deliberately not asserted)
    cmd: python3 -c 'import os,json,subprocess; p=os.path.expanduser("~/src/tinkerclaw/scripts/post-deploy-smoke.mjs"); r=subprocess.run(["node",p,"--json"],capture_output=True,text=True,timeout=60); d=json.loads(r.stdout); ids=[c["id"] for c in d["checks"]]; assert ids==["gateway-live","deployed-build","cron-not-skipped","engram-stores","instrument-liveness","algorithm-metrics"], ids; blind=[c["id"] for c in d["checks"] if not c["evidence"]]; assert not blind, f"check(s) reported a verdict with no evidence: {blind}"'
  - name: every gateway-call probe reports stderr on failure (ratchet at 11 legacy blind probes; never add a 12th)
    cmd: |
      python3 << 'PYEOF'
      # 2026-09-07. The bug this gate exists to catch, stated as a check rather
      # than as prose: a probe that shells out to the openclaw CLI and asserts on
      # stdout ALONE. When the CLI's RPC deadline fires it explains itself on
      # STDERR and leaves stdout EMPTY, so such a probe raises a NAKED
      # AssertionError. That is not merely unhelpful -- it actively defeats the
      # runner: test-invariants.mjs classifyGatewayDown() files a failure as a
      # SKIP when it can see "Gateway call failed" / "gateway timeout after Nms",
      # and a probe that swallows stderr hides exactly those strings, so a
      # gateway outage is reported as a red contract regression. Reporting stderr
      # is the fix. RATCHET, not a wall: 11 legacy probes are still blind and are
      # grandfathered, but the count may only ever go DOWN.
      import os, re
      p = os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/probes.md")
      fm = open(p).read().split("\n---\n")[0]
      # Split across a concatenation on purpose, so this gate never counts
      # ITSELF; \s* because probes spell the argv list both ways.
      PAT = re.compile(r'"gate' + r'way"\s*,\s*"call"')
      entries = re.split(r"^  - name: ", fm, flags=re.M)[1:]
      calls = [e for e in entries if PAT.search(e)]
      assert len(calls) >= 16, f"expected >=16 gateway-call probes, found {len(calls)} -- did the frontmatter shape change?"
      blind = [e.split("\n")[0][:70] for e in calls if "stderr" not in e]
      assert len(blind) <= 11, "ratchet broken: %d gateway-call probes assert without stderr (max 11). A new probe must report exit + stdout + stderr:\n  %s" % (len(blind), "\n  ".join(blind))
      budgeted = [e for e in calls if "cron.listJobs" in e or "fork.memory.search" in e]
      assert len(budgeted) == 2, f"expected the 2 budgeted probes, found {len(budgeted)}"
      for e in budgeted:
          head = e.split("\n")[0][:70]
          for token in ("BUDGET", "--timeout", "stderr"):
              assert token in e, f"{head}: lost its {token} -- the 2026-09-07 flake fix was reverted"
      PYEOF
---

# Probes — inspection primitives registry

The discipline (J15 §6 _Agent-Feedback Symmetry Principle_): for every action the AI can take that affects observable system state, there must exist an AI-callable inspection that returns that state, deterministically, in a single tool call.

A probe is **deterministic** (same input → same output, clocks masked), **bounded** (fixed max size), **single tool call** (one `Read` or one RPC), and **always-on** (no enabling flag).

## Live probes

| Probe                                                                                                                                        | Surface                                                                                                                                                                                                                                                                                                                                                                                                | Returns                                                                                                                                                       | Latency   | Implementation                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debug.dumpUiSnapshot` (RPC) + `Read(~/.openclaw/data/tinker-ui-snapshot.html)`                                                              | Tinker UI chat DOM                                                                                                                                                                                                                                                                                                                                                                                     | rendered HTML, ~2 KB cap                                                                                                                                      | <100ms    | `src/gateway/server-methods/debug-ui-snapshot.ts`, FORK 2026-05-09                                                                                                         |
| `[idle-timeout-diag]` journal log                                                                                                            | LLM idle watchdog resolution per turn                                                                                                                                                                                                                                                                                                                                                                  | one line per turn with `idleTimeoutMs=N model.requestTimeoutMs=N params.timeoutMs=N configuredRunTimeoutMs=N`                                                 | n/a (log) | `src/agents/embedded-agent-runner/run/attempt.ts:1862`, FORK 2026-05-10                                                                                                    |
| `journalctl --user -u openclaw-gateway.service` grep                                                                                         | catch-all gateway event tail                                                                                                                                                                                                                                                                                                                                                                           | raw text                                                                                                                                                      | seconds   | systemd journal                                                                                                                                                            |
| `Read(~/.openclaw/agents/main/sessions/sessions.json)`                                                                                       | session-store state for all sessions                                                                                                                                                                                                                                                                                                                                                                   | JSON                                                                                                                                                          | <100ms    | direct file read                                                                                                                                                           |
| `Read(~/.openclaw/tinker-bridge/session-map.json)`                                                                                           | tinker-bridge ↔ claude-cli sessionId mapping with openclawSessionId fallback                                                                                                                                                                                                                                                                                                                           | JSON                                                                                                                                                          | <100ms    | direct file read                                                                                                                                                           |
| `Read(~/.openclaw/cron/jobs.json)`                                                                                                           | cron registry                                                                                                                                                                                                                                                                                                                                                                                          | JSON                                                                                                                                                          | <100ms    | direct file read                                                                                                                                                           |
| `Read(~/.openclaw/cron/runs/<job>.jsonl)`                                                                                                    | cron last runs                                                                                                                                                                                                                                                                                                                                                                                         | JSONL                                                                                                                                                         | <100ms    | direct file read                                                                                                                                                           |
| `Read(~/.claude/projects/-home-globalcaos--openclaw-jarvis-workspace/<id>.jsonl)`                                                            | claude-cli session transcript                                                                                                                                                                                                                                                                                                                                                                          | JSONL                                                                                                                                                         | <100ms    | direct file read                                                                                                                                                           |
| `gateway.identity.get` (RPC)                                                                                                                 | gateway alive + deviceId                                                                                                                                                                                                                                                                                                                                                                               | JSON                                                                                                                                                          | <50ms     | `connect.ts`                                                                                                                                                               |
| `forensic.{getMode,getLive,listDumps,getDump,...}` (RPC)                                                                                     | request/response live capture + dumps                                                                                                                                                                                                                                                                                                                                                                  | JSON                                                                                                                                                          | <100ms    | `src/gateway/server-methods/forensic.ts`                                                                                                                                   |
| `whatsapp.history.search` (RPC)                                                                                                              | (currently broken — known issue)                                                                                                                                                                                                                                                                                                                                                                       | n/a                                                                                                                                                           | n/a       | re-enable in `tinkerclaw-whatsapp`                                                                                                                                         |
| sqlite3 read on `~/.openclaw/data/whatsapp-history.db`                                                                                       | WhatsApp message store                                                                                                                                                                                                                                                                                                                                                                                 | rows                                                                                                                                                          | <500ms    | direct DB read                                                                                                                                                             |
| `gateway.stuckSessions({thresholdMs?})` (RPC)                                                                                                | live in-memory `diagnosticSessionStates` map, processing sessions only                                                                                                                                                                                                                                                                                                                                 | `{stuckCount, stuck[{sessionKey,sessionId,ageMs,queueDepth,lastToolCall}], totalSessions}`                                                                    | <50ms     | `src/gateway/server-methods/gateway-probes.ts`, FORK 2026-05-11                                                                                                            |
| `gateway.diagnosticSessionCount()` (RPC)                                                                                                     | size + state breakdown of the diagnostic session map                                                                                                                                                                                                                                                                                                                                                   | `{total, byState:{processing,idle,waiting}}`                                                                                                                  | <50ms     | `src/gateway/server-methods/gateway-probes.ts`, FORK 2026-05-11                                                                                                            |
| `plugin.boot.status({id?,status?})` (RPC)                                                                                                    | per-plugin load result from in-memory PluginRegistry                                                                                                                                                                                                                                                                                                                                                   | `{totalPlugins, byStatus:{loaded,disabled,error}, plugins:[{id,name,version,status,error,failurePhase,...}]}`                                                 | <100ms    | `src/gateway/server-methods/plugin-probes.ts`, FORK 2026-05-11                                                                                                             |
| `gateway.observability.snapshot()` (RPC)                                                                                                     | one-call aggregator over every fork-side probe                                                                                                                                                                                                                                                                                                                                                         | `{capturedAt, sessions:{...}, plugins:{...}, runtime:{pid,uptimeSec,rssMb,heapUsedMb,...}}`                                                                   | <100ms    | `src/gateway/server-methods/observability-snapshot.ts`, FORK 2026-05-12                                                                                                    |
| `gateway.flow.replay({correlationId, sinceMinutes?})` (RPC)                                                                                  | ordered journal events mentioning a correlation ID (runId/sessionKey/etc)                                                                                                                                                                                                                                                                                                                              | `{correlationId, eventCount, byLevel, events:[{ts, level, raw}]}` capped at 200 events / 2KB per line                                                         | ~1s       | `src/gateway/server-methods/debug-flow-replay.ts`, FORK 2026-05-12                                                                                                         |
| `debug.simulate.stuckSession({sessionKey?, ageMs?, action?})` (RPC, **ADMIN**)                                                               | injects/removes a fake stuck session for round-trip-testing the bible's M10 diagnose_with claim                                                                                                                                                                                                                                                                                                        | `{action, sessionKey, ageMs}` or `{action:"clear", removed:N}`                                                                                                | <10ms     | `src/gateway/server-methods/debug-simulate.ts`, FORK 2026-05-12                                                                                                            |
| `debug.simulate.pluginLoadFail({pluginId?, failurePhase?, action?})` (RPC, **ADMIN**)                                                        | injects/removes a fake plugin failure record for round-trip-testing the bible's M5 diagnose_with claim                                                                                                                                                                                                                                                                                                 | `{action, pluginId, failurePhase, error}` or `{action:"clear", removed:N}`                                                                                    | <10ms     | `src/gateway/server-methods/debug-simulate.ts`, FORK 2026-05-12                                                                                                            |
| `gateway.slo.burnRate({slo?})` (RPC)                                                                                                         | declared SLOs evaluated from cron receipts; observed vs target + burn rate per SLO                                                                                                                                                                                                                                                                                                                     | `{capturedAt, anyBurning, slos:[{id,targetPct,observedPct,burnRate,status,sampleCount,details}]}`                                                             | <300ms    | `src/gateway/server-methods/slo-burn-rate.ts`, FORK 2026-05-12                                                                                                             |
| `fork.prefrontal.setRecipe({recipeId, step?, totalSteps?, stepName?, parallelismCap?, inFlightLabels?, sessionKey?, note?, payload?})` (RPC) | orchestration-observability broadcast → `prefrontal-recipe-state` lifecycle event (RECIPES header data source; see subagents-and-recipes.md for the recipe-runner sink, panels.md for the render)                                                                                                                                                                                                      | `{ok, recipeId, step, totalSteps, stepName}`; emits only, zero persistence                                                                                    | <10ms     | `src/fork/prefrontal-state-rpc.ts`, FORK 2026-05-30 (FORK 2026-05-31: optional structured `payload` forwarded on `data.payload`)                                           |
| `fork.prefrontal.trailEvent({kind, message?, icon?, label?, payload?, …NO-MATCH fields})` (RPC)                                              | decision-trail broadcast → `prefrontal-trail-event` lifecycle event; `kind:"NO-MATCH"` (knowledge-gap only) also writes a curiosity-buffer gap                                                                                                                                                                                                                                                         | `{ok, gapId?}`; emits only                                                                                                                                    | <10ms     | `src/fork/prefrontal-state-rpc.ts`, FORK 2026-05-30 (FORK 2026-05-31: optional structured `payload` forwarded on `data.payload` — recipeId/op/applied/reason/confidence/…) |
| `fork.prefrontal.embed({texts[] \| text})` (RPC, **INTERNAL**)                                                                               | scoped in-process embeddings for the J13 semantic recipe-matcher; NO new HTTP surface (unlike the gated `/v1/embeddings`); reuses `createConfiguredEmbeddingProvider` (ollama/mxbai-embed-large, exported from `src/gateway/embeddings-http.ts`). Fails SAFE → matcher degrades to lexical.                                                                                                            | `{embeddings:number[][], model, count}`; on any error `{embeddings:[], error}` (1024-dim vectors verified live)                                               | ~1s       | `src/fork/prefrontal-state-rpc.ts` (core, not the bundled extension — keeps the provider/native-dep stack out of the ext bundle), FORK 2026-05-31                          |
| `fork.strategy.switch.list({baseDir?, now?})` (RPC)                                                                                          | U4 failure→strategy-switch read path: open switch proposals (`shouldSwitch===true`) computed live from the durable `failure-state.json` map (loaded via `failure-tracking-store.ts`). Decisions are emitted by the engram-consolidate cron; this is the cheap inspect surface. `.apply`/`.review` are the sibling write/audit RPCs (NOT probes — `.apply` mutates state).                              | `{ok:true, decisions:[{strategyId, shouldSwitch, fallbackTo, failureCount, ...}]}` (empty `[]` when no failures)                                              | <50ms     | `src/gateway/server-methods/engram-strategy.ts`, FORK 2026-06-02 (U4)                                                                                                      |
| `fork.skill.search({query, k?, excludeDeprecated?, baseDir?})` (RPC)                                                                         | U6 Voyager skill-library read path: embed-ranked (keyword-fallback) search of the versioned never-delete Skill library (`createSkillLibrary` over `~/.openclaw/engram`). `query` REQUIRED (errors INVALID_REQUEST otherwise); `k` defaults 5; `excludeDeprecated` defaults true. `.recordOutcome` is the sibling write RPC (NOT a probe).                                                              | `{ok:true, skills:[SkillRef…]}` (empty `[]` when library empty)                                                                                               | ~1s       | `src/fork/skill-rpc.ts`, FORK 2026-06-02 (U6)                                                                                                                              |
| `fork.memory.search({query, temporalMode?, asOfTime?, maxResults?, minScore?, sessionKey?})` (RPC)                                           | U3 bi-temporal point-in-time recall: "what did memory say was true at T?" Threads `temporalMode` (`current` (default) \| `valid-at` \| `all`) + optional `asOfTime` into `MemoryIndexManager.search` (manager-search.ts `temporalPredicate`). `query` REQUIRED; an unknown `temporalMode` falls back to `current` (never errors). Echoes the resolved slice back so the UI can label what it rendered. | `{ok:true, results:[…], temporalMode, asOfTime?}` (empty `[]` when no matches)                                                                                | ~1s       | `src/fork/memory-rpc.ts`, FORK 2026-06-02 (U3)                                                                                                                             |
| `node scripts/post-deploy-smoke.mjs [--expect-sha <sha>] [--json]` (script)                                                                  | six just-fixed runtime paths in one call: gateway `/health`, built-vs-running build stamp, cron receipts, ENGRAM stores, instrument liveness, algorithm-metrics freshness. Read-only; exit 0 all-clear / 1 on any FAIL. See “Post-deploy smoke” below.                                                                                                                                                 | `PASS`/`WARN`/`FAIL` per check **with the evidence each one saw**; `--json` -> `{ok, counts, deployBoundary, checks:[{id,verdict,headline,evidence[],data}]}` | ~100ms    | `scripts/post-deploy-smoke.mjs`, FORK 2026-08-03                                                                                                                           |

### NOT a probe — `fork.reasoning.search` runs a model

`fork.reasoning.search({problem|prompt, maxDepth?, branchingFactor?, beamWidth?})` (`src/fork/reasoning-runtime.ts`, FORK 2026-06-02, U10) is an RPC but **NOT an inspection primitive** — it runs a bounded Tree-of-Thoughts / LATS deliberate search that **invokes the LLM** (`runReasoningSearch`), so it is neither deterministic nor cheap nor side-effect-free (it bills tokens and stashes a reasoning trace). It returns `{answer, steps, depthReached, tokensUsed, stopReason, winningPath}`. Treat it as an action, not a probe; do NOT add it to a `verify:` block (it would spend tokens on the merge gate). The cognitive-mode read state lives in `fork.cognitive.reasoning` config + the `reasoning_tree_state` EventKind — see lifecycles.md for the J3↔J13 reasoning state machine.

### Post-deploy smoke — `scripts/post-deploy-smoke.mjs`

One command, six read-only checks, ~100 ms. Run it immediately after a deploy so a bad one is caught in seconds instead of found days later — each of the five defects fixed on 2026-08-03 had been silently broken for weeks or months precisely because nothing exercised it end to end.

```bash
node scripts/post-deploy-smoke.mjs                      # human report
node scripts/post-deploy-smoke.mjs --expect-sha <sha>   # FAIL unless that commit is the one built
node scripts/post-deploy-smoke.mjs --json               # machine-readable
node scripts/post-deploy-smoke.mjs --self-test          # pure helpers only; touches nothing
```

| #   | reads                                                             | proves                                                           | FAILs on                                                                                            |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | `GET 127.0.0.1:18789/health`                                      | the gateway answers                                              | anything but `{"ok":true}`                                                                          |
| 2   | `dist/build-info.json` + systemd `MainPID` -> `/proc/<pid>` mtime | what was BUILT, and that the RUNNING process started after it    | missing commit, `--expect-sha` mismatch (<7 hex chars is itself a FAIL), or built-but-not-restarted |
| 3   | newest receipt per `~/.openclaw/cron/runs/*.jsonl`                | no cron is skipping itself into silence                          | `disabled` (bare **or** `wake-refused:`) after the deploy boundary; WARN/UNPROVEN before it         |
| 4   | `~/.openclaw/engram/events/`                                      | real stores are discoverable and `live.jsonl` is not depended on | zero or all-empty stores (WARN if the phantom reappears)                                            |
| 5   | `[instrument-liveness] declared=…` in the journal                 | the liveness report is actually running                          | journal silent **and** the deployed bundle has no caller for `logInstrumentLivenessSummary`         |
| 6   | `~/.openclaw/data/algorithm-metrics.jsonl`                        | every algorithm still writes                                     | zero parseable records (stale producers are WARN, judged **per algorithm**)                         |

**Every check prints what it SAW, not just a verdict.** That is the point, not verbosity: all the bugs above were checks that observed nothing and reported success. So a verdict here never asserts a cause the check did not observe, and blindness (files present, none parseable) is a FAIL rather than a green.

Two things it deliberately does NOT claim:

- **Check 2 does not prove the running gateway is on that commit.** There is no runtime commit surface — `/health` returns only `{"ok":true,"status":"live"}` and there is no startup commit line. It proves what was built and that the process started _after_ the build, which is what catches `pnpm build` without a restart. Never read `openclaw --version` for this: that banner prints live git HEAD, not the build.
- **Check 5's silence is not health.** The healthy path logs at DEBUG (`instrument-liveness.ts:224`) and only the broken path at WARN (`:211`), so zero journal lines is ambiguous by construction. The check resolves it the only way available — scanning `dist/` for a caller — and FAILs only when the report has no caller in the deployed bundle, i.e. the original counter-nobody-reads regression.

The **deploy boundary** (the instant after which evidence is attributable to what is running) is the gateway PROCESS START, not `builtAt`. When it cannot be established, check 3 grants no pre-deploy grace and fails closed: an alibi the script cannot substantiate is worse than an alarm.

`--self-test` runs the pure helpers against fixtures only (no gateway, no filesystem, no clock) and is the merge gate in this file's frontmatter, alongside a `--json` gate that asserts all six checks report evidence. Both gate the PROBE, not the system's health — verdicts are deliberately not asserted, because a red system must not block a merge.

### Calling a fork RPC probe from the CLI

The three U3/U4/U6 read probes above (and the embed RPC) take their args as JSON. **Pass params via a FILE, not inline** — an inline `--params '{…}'` string gets mangled by shell quoting (nested quotes, `$`, brace expansion). The proven pattern:

```bash
echo '{"query":"caixa préstec","temporalMode":"valid-at","asOfTime":1717200000000}' > /tmp/p.json
openclaw gateway call fork.memory.search --json --params "$(cat /tmp/p.json)"
```

**Output gotcha:** the CLI prints a multi-line config-warnings banner (`- plugins.allow: …`, `- plugins.entries.telegram: …`) to stdout **before** the JSON result. When asserting in a `verify:` block, assert a _substring_ of the whole stdout (`assert "\"ok\"" in r.stdout`), do not try to `json.loads(r.stdout)` the raw output. `query` is REQUIRED for both `fork.skill.search` and `fork.memory.search` (omitting it returns `INVALID_REQUEST: 'query' required.`, exit non-zero) — every verify block below passes one.

## Proposed probes (gaps)

Each row is a surface where investigation is expensive today.

| Probe                                                              | Surface                                                                   | Cost saved                                                | Priority |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------- | -------- |
| `debug.tail.lastN({sessionKey,n,since?})`                          | recent agent events for one session                                       | replaces ~30 journal greps                                | **HIGH** |
| `debug.session.state({sessionKey})`                                | lane state, worker liveness, idle timer remaining, queued replies, status | replaces grepping 6 files                                 | **HIGH** |
| `debug.session.config({provider})`                                 | effective resolved provider + model with override chain                   | catches the timeoutSeconds-dead-code regression on commit | **HIGH** |
| `wa.lastOutbound({chat,n})`                                        | last N WhatsApp outbound messages, including dropped/queued               | catches "Jarvis's reply never delivered" silently         | **HIGH** |
| `cron.lastRun({jobId})`                                            | last run state, exit code, duration, output tail                          | replaces manual receipt-grep                              | medium   |
| `tinker-bridge.workerInfo({sessionKey})`                           | alive?, current cli sessionId, last turn duration, idle status            | catches stuck workers (needs plugin API to expose pool)   | medium   |
| `wa.lastInbound({chat,n})`                                         | last N inbound messages for one chat                                      | symmetric companion to wa.lastOutbound                    | medium   |
| `agent.dispatch.lastN({n})`                                        | last N chat.send / agent invocations gateway-wide                         | catches dispatch storms                                   | low      |
| ~~`plugin.boot.status`~~ — **LIVE 2026-05-11** (Live table above). | per-plugin boot result (load ok / failed / disabled / version)            | catches M5 native-deps failures synchronously             | shipped  |
| `auth.profile.status({provider,profile})`                          | last refresh time, last failure, billing state                            | catches OAuth refresh-token issues before they surface    | low      |

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
