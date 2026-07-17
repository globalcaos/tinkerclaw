---
file: slos.md
purpose: Service-level objectives for the fork's high-leverage flows + burn-rate computation
audience: AI + maintainer
last_verified: 2026-05-12
last_verified_commit: HEAD
single_owner: yes — SLO definitions live here. burn-rate computation lives in `src/gateway/server-methods/slo-burn-rate.ts`; this file declares the contracts that file evaluates.
see_also: probes.md (gateway.slo.burnRate registry entry), failures.md (M-modes that exhaust budgets), crons.md (the runs that drive cron-* SLOs), design-principles.md (#9 observability is a design property)
verify:
  - name: gateway.slo.burnRate probe is live
    cmd: python3 -c 'import subprocess; r=subprocess.run(["openclaw","gateway","call","gateway.slo.burnRate"],capture_output=True,text=True,timeout=25); assert "slos" in r.stdout and "anyBurning" in r.stdout, f"missing fields (exit={r.returncode})\nstderr: {r.stderr[-400:]}\nstdout: {r.stdout[-400:]}"'
  - name: every declared SLO in this file has a corresponding evaluator in slo-burn-rate.ts
    cmd: python3 -c 'import os,re; bible = open(os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/slos.md")).read(); declared = re.findall(r"^### SLO-\d+ \(([a-z-]+)\)", bible, re.M); code = open(os.path.expanduser("~/src/tinkerclaw/src/gateway/server-methods/slo-burn-rate.ts")).read(); missing = [s for s in declared if f"\"{s}\"" not in code]; assert not missing, f"declared SLOs without evaluator: {missing}"'
---

# SLOs — service-level objectives for the fork

An SLO declares "≥X% of operations of class Y meet condition Z over window W." The error budget is `100% − X%`. When the budget is half-spent, that's a yellow signal; when it's exhausted, a red signal. Per SRE practice (Google's, Nobl9's), alerting on burn rate beats alerting on raw thresholds — a brief spike that doesn't burn the budget is noise; a sustained drift that consumes the budget is signal.

This file declares the SLOs the fork tracks. The evaluator lives at `src/gateway/server-methods/slo-burn-rate.ts` and is reachable via `openclaw gateway call gateway.slo.burnRate`. Each SLO's `id` matches the evaluator's branch identifier; the meta-verify above asserts the symmetry.

## Starter SLOs (2026-05-12)

We launch with three. Each was chosen by the leverage test: the SLO either (a) names a failure mode we already have in `failures.md`, or (b) names a class of regression we've seen recur in `bug-log.md`. Speculative SLOs are not added.

### SLO-1 (cron-success-7d)

**≥95% of cron runs succeed over the rolling 7-day window.**

- Why this is the SLO: cron failures are the highest-frequency operational class. M9 (auto-merge silently breaking fork behavior) and M5 (plugin native-deps missing) both manifest as cron-run failures first. Tracking the 7-day success rate gives the architect a single number for "is the operational layer healthy?"
- Window: rolling 7 days, all jobs combined.
- Burn rate semantics: target 95% → budget is 5% failures. If observed failure rate is 5%, burnRate=1.0 (exhausted). If observed is 2.5%, burnRate=0.5 (half-burned).
- Recommended action when burning: read the `failingJobs` field in the probe response; cross-reference each top failer against `failures.md`.

### SLO-2 (cron-freshness)

**Every cron job has a successful run within the last 24 hours.**

- Why this is the SLO: a cron that hasn't run since two days ago is silently broken. The morning briefing rotting because the scheduler stopped firing is a real incident class (B007 in workspace bug log). Freshness catches it.
- Window: current state. Each job is either fresh (a successful run within the last 24h) or stale.
- Target: 100% — anything <100% is burning; 0% is fully exhausted. There's no graceful degradation here; either the cron ran or it didn't.
- Recommended action when burning: read `staleJobs`; each one needs investigation — the cron daemon may be down, the job's command may be throwing, or the job may have been intentionally disabled (in which case mark it explicitly in `jobs.json` rather than letting it surface as a freshness failure).

### SLO-3 (morning-briefing-latency)

**≥95% of successful morning-briefing runs complete within 300 seconds.**

- Why this is the SLO: morning-briefing is the user-facing flagship. When it takes 10 minutes instead of 1, the user notices, and the lag is usually a precursor to a fail. Tracking p95 latency catches the slow-creep regressions before they tip over into outright failures.
- Window: rolling 7 days, successful runs only (failed runs have their own SLO).
- Burn rate: target 95% within budget → budget is 5% slow runs. Observed via `durationMs` field in each receipt.
- Recommended action when burning: read `details.p50Ms`, `details.p95Ms`, `details.maxMs`. If p95 is creeping toward 300s, investigate `failures.md` M1 (tinker-bridge SIGTERM) — slow briefings often precede outright timeouts.

## How the probe surfaces this

```
$ openclaw gateway call gateway.slo.burnRate
{
  "capturedAt": "2026-05-12T08:34:00Z",
  "anyBurning": false,
  "slos": [
    {
      "id": "cron-success-7d",
      "targetPct": 95,
      "observedPct": 98.7,
      "budgetRemainingPct": 3.7,
      "burnRate": 0.26,
      "status": "healthy",
      "sampleCount": 156,
      "details": { "failingJobs": [...] }
    },
    ...
  ]
}
```

A burning or exhausted SLO sets `anyBurning: true` — useful as the single field a dashboard or alert hook polls.

## Adding a new SLO

Per design-principles.md #15 (don't over-do it) and #11 (probes paired with write surfaces): only add an SLO when

1. there's a failure mode in `failures.md` or a recurring class in `bug-log.md` that the SLO would catch, AND
2. the data source is already produced by something (cron receipts, journal events, an existing probe) — no SLO requires building a new metrics pipeline.

The implementation cost is one function in `slo-burn-rate.ts` plus one section in this file. The meta-verify enforces the symmetry: every SLO declared here must have an evaluator named in the code, and vice versa.

## Why not external SLO tools

We are aware of Datadog, Nobl9, Honeycomb, SigNoz, and the OpenTelemetry stack. They are appropriate for production services with mid-five-figure event volumes per day. The fork's event volume (a few hundred cron runs per week, a few hundred WA messages per day) does not justify the integration cost today. The on-disk receipts already carry every field these tools would compute over, and `gateway.slo.burnRate` reads them directly. When event volume grows past the point where reading 30 days of receipts is slow (>500ms), we revisit.

## Don't regress

- **Don't track SLOs that aren't tied to a documented failure mode or recurring bug class.** Vanity SLOs ("99.99% uptime!" without a defined operation) are alarm noise; they erode trust in the dashboard.
- **Don't alarm on burnRate > 0.** Alarm on burnRate ≥ 1 (budget exhausted) or sustained burnRate ≥ 2 (consuming budget faster than it refills). Single-spike yellows are normal operational noise.
- **Don't add an SLO without the matching evaluator.** The meta-verify will catch the mismatch on the next push, but ship them together for clarity.
