---
file: observability.md
purpose: What this fork can PROVE it is doing — the derived capability registry, the measured coverage, and the instrument-placement rules that came from features dying silently
audience: AI + maintainer
last_verified: 2026-08-04
last_verified_commit: HEAD
single_owner: yes — capability coverage policy, the OBSERVED/DECLARED/BLIND vocabulary, and the instrument-placement rules live here. probes.md owns inspection PRIMITIVES (how to look); slos.md owns objectives (how good is good enough); this file owns WHAT IS WATCHED AT ALL.
see_also: probes.md (the primitives you inspect with), failures.md (how a failure propagates once you can see it), slos.md (the three cron-scoped objectives), canonical-derivations.md (the sibling ratchet, same discipline), design-principles.md#20 (a measurement carries its provenance), bug-log.md (every rule below cost a real incident)
note: |
  Everything countable in this file is DERIVED on every run, never hand-maintained — FOUNDATION.md
  #2. A frozen inventory of "what the system does" is a lie with a timestamp on it, and this fork
  has already been burned by exactly that (topology.md once asserted two plugins failed to load;
  both had been live for weeks, and topology.md:82 still asserts a hook that does not exist). If
  you want to know what exists, RUN THE QUERY in §5c; if a query and this prose disagree, the QUERY
  is right and the prose is the bug. Every measured table below carries a date for that reason.
verify:
  - name: capability coverage — the BLIND count never rises (ratchet; a new capability arrives instrumented or not at all)
    cmd: cd ~/src/tinkerclaw && node scripts/bible/capability-coverage.mjs
---

# Observability — what we can prove is working

## 1. The principle

> **A capability that cannot prove it ran is indistinguishable from one that is dead.**

Not "hard to tell apart". Indistinguishable — there is no observation you can make, short of
suspecting the failure first and going to look, that separates the two. This is not a
philosophical point. On **2026-08-04** four separate headline features were found dead, each
having been dead for weeks or months, and every one looked healthy right up until someone went
looking for an unrelated reason.

| Feature                    | Dead since | What it looked like                                                                                                      |
| -------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Fractal Reflection**     | 2026-06-11 | 2,466 result rows written, **0 carrying a success status** in 8 weeks. Two prompt assets never staged into `dist`.       |
| **Semantic memory search** | (never)    | 5,258 chunks indexed, **0 vectors**. A table declared `FLOAT[3072]` against a 1024-dim embedder. Surfaced as `log.warn`. |
| **Overseer nudges**        | (never)    | 188 scope refusals, **0 nudges**. 19 `fork.*` RPCs unclassified — and unclassified means default-deny.                   |
| **ENGRAM ingestion**       | 2026-07-28 | Read `payload.text` from a hook that passes `assistantTexts`. Bailed silently on **every** turn.                         |

**None of them threw.** That is the entire finding. The common shape is not a crash, it is a
**plausible non-error**: an empty result set, a healthy-looking no-op, a `warn` nobody reads, a
`status: ok` on a run that produced nothing. Every one of those is also exactly what a correctly
working, currently-idle feature produces.

Note what the four share and what they do not. They were not badly written — ENGRAM's bug was two
field names, and both fields were typed optional, so it type-checked perfectly, forever. They were
not unlogged — fractal wrote a detailed row for **every** failure, and those rows are how the root
cause was eventually found in about twenty minutes. Fractal was not hidden by subtlety. It was
hidden because it wrote its evidence **to a file nobody reads**, and it had **zero instruments**,
so the one report that _is_ read had never heard of it. **Absence from a report that only lists
what registered itself is indistinguishable from health.**

> Observability is not "the information exists somewhere". It is **"the information reaches a
> surface that is actually looked at, without anyone having to suspect the failure first."**

The contrast between two hunts on the same day is the whole argument for this file. Fractal: eight
weeks to notice, twenty minutes to fix. ENGRAM: found in **one cycle**, after hours of wrong
hypotheses, because a deliberate instrument PAIR had just been added and immediately reported
_called and bailed_ rather than _never called_. Same class of bug. The difference was entirely in
what was watching.

## 2. The three states

Every capability is in exactly one of three states. The vocabulary is owned here and used by
`scripts/bible/capability-coverage.mjs`, by `probes.md`, and by anything else scoring this surface.

| State        | Definition                                                                                                                          | If it breaks                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **OBSERVED** | A signal exists **and has fired** in its window — an artefact written, a counter incremented, a receipt on disk, a success line.    | a report says so               |
| **DECLARED** | The signal mechanism exists — an instrument, a success-path log, an expected artefact path — and has **never produced a positive**. | the report says `pending`      |
| **BLIND**    | Nothing anywhere would change if this stopped working.                                                                              | indistinguishable from success |

**OBSERVED says it RAN. It does not say it ran CORRECTLY.** Fractal was OBSERVED by this
definition for eight weeks — it wrote 2,466 rows. Coverage is a floor, not a proof (see §9).

**DECLARED is the dangerous one, and it is worse than BLIND.** A declared-but-never-fired
instrument is **a feature that may be dead right now**, reported in a word that reads as
reassurance. `pending` means _"wired up, just hasn't happened yet"_ — a comforting sentence for a
code path that can never execute. BLIND at least tells you honestly that you do not know. **A gap
you know about beats a gap that reports something soothing.**

Two live examples, both verified 2026-08-04:

- `engram:retrieval-pack-inject` sat in `pending` for four months because the instrument was
  welded to the **dead half of a twinned module** — core `injectRetrievalPack` has 0 callers, while
  the plugin path at `extensions/tinkerclaw-total-recall/index.ts:356` is what actually runs. The
  registry reported the exact inverse of the truth.
- `compression:headroom-mcp` is declared at `src/agents/pi-tool-definition-adapter.ts:42` and has
  **zero `noteInstrumentFired` sites anywhere in the tree**. It can never fire, whatever the config
  says, and it will sit in `pending` forever saying nothing is wrong.

## 3. The mechanisms, and which shape of capability each is for

Five exist. They are not interchangeable; picking the wrong one is how evidence ends up in a file
nobody reads.

| Mechanism                                       | Where                              | Right for                                                                                                                                                                                                                              | Wrong for                                                                                                   |
| ----------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **`declareInstrument` / `noteInstrumentFired`** | `src/infra/instrument-liveness.ts` | **Did this code path execute at all?** Per-turn or per-event work: hook bodies, injection points, gates, dispatch seams. The registry answers _live / pending / never / stale / idle_ on a cadence.                                    | Anything you need a NUMBER from. It counts fires; it does not measure.                                      |
| **`recordAlgorithmOutcome`**                    | `src/infra/algorithm-metrics.ts`   | **Is the algorithm any good?** Anything with a variant, an outcome and metrics worth comparing over time — routing decisions, compaction strategies, cache splits. Append-only JSONL you can group by `(algorithm, variant, outcome)`. | Liveness — see the caveat in §7. Families auto-register **by firing**, so `fireCount === 0` is unreachable. |
| **Cron report artefacts**                       | `~/.openclaw/cron/reports/<job>/`  | **Scheduled work.** The only per-feature receipt store in the tree, and the one that has actually caught things.                                                                                                                       | Anything not on a schedule.                                                                                 |
| **`probes.md`**                                 | the optic                          | **Inspection primitives** — "how do I look at X right now". A registry of ways to look.                                                                                                                                                | Automated detection. A probe only helps someone who already suspects.                                       |
| **`post-deploy-smoke.mjs`**                     | `scripts/`                         | **Assertions at deploy time.** Turns a fact on disk into PASS/FAIL. This is where a threshold belongs.                                                                                                                                 | Continuous watching between deploys.                                                                        |

**Rule of thumb.** _"Did it run?"_ → an instrument. _"Was it any good?"_ → the algorithm ledger.
_"Did the scheduled thing produce something?"_ → an artefact. _"Would the build catch it?"_ → a
smoke check. Most capabilities that died in §1 needed the first and had none of the above — only a
log line.

## 4. The rules, each bought with an incident

**1. An instrument goes where the WORK happens — never behind the same condition that decides
whether it is registered.** If registration and firing share a predicate, the instrument can only
ever report _"the predicate was true"_, which you already knew. The failure mode has a sharper
variant: `engram:retrieval-pack-inject` was welded to the **dead twin** of a duplicated module, so
it reported the inverse of reality for four months. When a concept has two implementations
(`canonical-derivations.md`), instrument the one with callers — and verify which that is.

**2. Fire an ENTRY instrument before any early return, AND a SUCCESS instrument after the work.**
The rule that turned the ENGRAM hunt from days into one cycle. The pair splits three states that a
single instrument collapses into one:

| entry | success | means                                                | the fix lives             |
| ----- | ------- | ---------------------------------------------------- | ------------------------- |
| ✗     | ✗       | we are never called — a registration or dispatch bug | elsewhere                 |
| ✓     | ✗       | **we are called and we bail**                        | **between the two lines** |
| ✓     | ✓       | working                                              | —                         |

The middle row is the one that matters and no single instrument can express it. `engram:ingest-entry`
firing while `engram:ingest-assistant` stayed silent reduced _"ingestion is broken somewhere"_ to
two candidate lines and killed two hypotheses that had already eaten hours. **"Never called" and
"called and bailed" need different fixes, so they need different signals.**

**3. A catch-only log is not observability.** `total-recall`'s ingestion hook logged only on throw.
It never threw — it returned early. Silence from a catch block means _"no exception"_, which is
also exactly what a permanently-skipped function produces. This shape is still live in
`memory-core`: three hooks, all logging only in `catch`.

**4. A green status line is not evidence; the artefact is.** The strongest proof in the whole
audit: cron report directories exist for 07-27…07-30 and 08-03…08-04. **07-31 through 08-02 have
no directory at all** — while `jobs-state.json` reports `lastRunStatus: ok` straight across the
gap. Check the store, the file, the row count. Three jobs currently report `enabled: true` with
`lastStatus: "skipped"`, `lastError: "disabled"`, in 11–14 ms, with `consecutiveErrors: 0`.

**5. Declare lazily, at the call site — not at module scope.** Declaring at import time registers
the instrument whenever _anything_ imports the file, including a test, which converts a real "never
fired" into a permanent false `pending`. Declare from inside the function that does the work,
guarded by a module-level `let declared = false`.

**6. Never explain a bad number away before re-running the check that produced it.** Two
independent saves on 2026-08-04, both while writing this file:

- The RPC surface scores **0/185**. An innocent explanation was available — that the methods are
  observed _centrally_ on the dispatch path, which a per-file scorer would report as zero either
  way. Checked: there is no per-method log, counter or timing anywhere in `src/gateway/`; the only
  `metrics` object (`server.impl.ts:454`) is startup timings, and `diagnostics-prometheus` matches
  `req.method` — the HTTP verb, not the gateway method. **The zero is real.**
- The inverse, same day: a grep for declared ids with no literal firing site returned **9**
  candidates. Eight fire through indirection — a ternary variable (`cache-telemetry.ts:103`), a
  template literal (`compaction-diagnostics.ts:107`), a multi-line call. **Only
  `compression:headroom-mcp` is genuinely unfireable.** A grep that does not resolve indirection
  manufactures eight false accusations, and a false accusation costs the registry its credibility
  faster than a missed one does.

**7. Instrument the deployed artefact, not the source.** An instrument that exists in `src/` and
not in `dist/` is worth nothing, and the fork has the scar — fractal's own instruments were
source-only for part of 2026-08-04. `grep -rl '<id>' dist/` is the check and it takes one second.

## 5. Measured coverage — dated snapshot, 2026-08-04

**These numbers are a reading, not the source of truth.** The live figure comes from the command,
and it moved twice during the writing of this file. If prose and command disagree, **the command
is right and the prose is the bug.**

### 5a. The derived registry

`node scripts/bible/capability-coverage.mjs`

```
575 capabilities derived — OBSERVED 152 (26%) · DECLARED 78 (14%) · BLIND 345 (60%)
RATCHET  structural BLIND 377 / cap 377
```

| Subsystem           |   Total | OBSERVED | DECLARED |   BLIND |
| ------------------- | ------: | -------: | -------: | ------: |
| gateway-core        |     186 |       24 |        0 |     162 |
| gateway-plugin      |     129 |        8 |        0 |     121 |
| stores              |      78 |       40 |       38 |       0 |
| OBS (the machinery) |      66 |       51 |       15 |       0 |
| plugins             |      33 |       14 |       18 |       1 |
| tinker-ui           |      31 |        3 |        0 |      28 |
| hooks               |      26 |        2 |        1 |      23 |
| crons               |      18 |       10 |        5 |       3 |
| tools               |       8 |        0 |        1 |       7 |
| **total**           | **575** |  **152** |   **78** | **345** |

**Two numbers, on purpose.** `BLIND 345` is the sharper, **journal-informed** figure — it knows
which methods actually saw traffic. `structural BLIND 377` is measured with **the journal ignored**,
so the gate is identical on CI and on a fresh clone. The ratchet runs on the structural number
because a merge gate that depends on this host's log history is not a gate.

**26% observed — and that is the generous reading.** The number to look at is not the 26%, it is
the shape:

- **The 315-method gateway RPC surface scores 32 observed.** Every capability the UI, the CLI and
  every plugin reaches the gateway through is essentially unwatched, and **0 of them have a
  purpose-built signal** — the 32 are inferred from WS `res` lines that were never designed as
  evidence. This is the single highest-value hour of instrumentation work available, and it is
  **one chokepoint rather than 315 edits** (§6 #1).
- **`tinker-ui` scores 3 of 31, and cannot do better.** `grep -rn 'declareInstrument(' tinker-ui/src`
  → **0**. The liveness census is _structurally incapable_ of seeing any UI feature.
- **`tools` scores 0 of 9.** All 1,726 tool-invocation lines in three days exist only because the
  prefrontal plugin happens to log them in a hook. Disable that one plugin and the entire agent-tool
  surface goes dark, because the core seam's own line is at DEBUG and produced zero lines.
- **`stores` is 41 OBSERVED / 41 DECLARED — the single largest pile of actionable bugs in the
  table.** Half the runtime stores have an expected artefact path that has never received one.
- **`crons` is the best-covered non-meta surface (10/18)** because it is the only one with a
  **per-feature receipt store**. That is not a coincidence; it is the argument for artefacts (§3).

**`OBS` scores 51/66 — the machinery watches itself better than it watches anything else.** Worth
naming, because it is the classic shape of a monitoring system that has become its own customer.

Where a surface is _better_ covered, it is because it hurt before: hooks and ENGRAM got their
instruments the week each one broke. **Coverage follows scar tissue** — which means it maps past
pain, not present risk, and the BLIND column is where the _next_ eight-week outage is.

### 5b. Reading the RPC numbers honestly

**Two facts gate the whole RPC section.** (U1) The `http server listening (N plugins: …)` line is
**not** the complete loaded set — `tinkerclaw-tinker-bridge` has 8,635 journal hits in three days
and is absent from it. (U2) `⇄ res ✓/✗` is emitted **only on the `[ws]` transport**; in-process
`callGatewayLeastPrivilege` emits nothing, proven when `fork.curiosity.topGaps` succeeded six times
with zero `res` lines.

So **"never on the wire" ≠ "never invoked"**, and the 283 BLIND RPC rows are an **upper bound on
death, not a proof of it**. The script prints that caveat on every run rather than silently
narrowing the number — a real gap must not get to hide behind a caveat nobody re-reads.

The inverse error is live too, and it is the more dangerous one: **a method can be OBSERVED and
badly broken.** `rpc:forensic.getResponseLive` runs 35✓/40✗ and `rpc:sessions.patch` runs 52✓/41✗
— 53% and 44% failure rates, both firing today, both indistinguishable from healthy **because they
do return successes**. Coverage would score them green. See §9.

### 5c. How every row is regenerated

Nothing above is hand-listed — FOUNDATION.md #2. The script **prints its own derivation legend**,
which is the single owner of that fact:

```
node scripts/bible/capability-coverage.mjs --queries
```

It also prints its **judgement calls** — the only hand-written content in the report, each with its
reason (why allow-gated plugins collapse to one rollup; why tests are excluded; why an
algorithm-metrics family can never be scored `never`; why `byConfig` is DECLARED rather than
OBSERVED; why wire evidence understates). Read those before disputing a number.

Three derivations are used by this optic and **not** by the script, so they are owned here:

| id  | Surface             | Query                                                                                                                                   |
| --- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| R8  | unclassified scopes | `Object.keys(coreGatewayHandlers).filter(m => !isGatewayMethodClassified(m))` — the 82 that feed §6 #11                                 |
| R15 | J-mechanisms        | the J-series implementation registry ∩ the live tree — cognitive mechanisms J1–J19 sit _below_ the plugin granularity the script scores |
| R19 | smoke + SLO         | `node scripts/post-deploy-smoke.mjs --json \| jq '.checks[].id'`; `grep 'id: "' slo-burn-rate.ts`                                       |

**The one trap every scorer of this surface must handle: ids can be const-indirected**, so an
`id:`-literal grep is wrong in **both** directions — undercounting declarations _and_
manufacturing false "never fires" (rule 6). Two exist today, `CRON_WAKE_INSTRUMENT_ID`
(`src/cron/service/timer.ts:89`) and `EFFORT_ROUTE_INSTRUMENT_ID`
(`extensions/tinkerclaw-prefrontal/effort-router.ts:36`); the identical trap was found
independently in the UI persistence registry. The script resolves them and says so on every run.

> **A note on this section's own history, because it is the point of the file.** The table in §5a
> was rewritten **three times in under an hour** while this optic was being authored: a
> hand-reconciliation of five inventories at 665 rows, then `230 / 21 / 9%`, then `576 / 141 / 24%`,
> then `575 / 152 / 26%` — each superseded by the next as the script learned to derive more of what
> had been hand-counted, and as a concurrent session began instrumenting the RPC surface out from
> under it.
>
> The hand numbers were not _wrong_ so much as **unrepeatable**, which is precisely the property
> FOUNDATION #2 forbids. Treat every count in this file as a reading with a timestamp on it. If you
> need a number, **run the command**; if you need to know what the number means, read the prose. A
> table that disagrees with `capability-coverage.mjs` is a stale table, not a finding — and the
> right fix is to re-run and re-paste, not to argue with it.

## 6. The highest-value gaps

Ranked by (how much it matters) × (how broken it already is). Every proposed signal is a **counter
or an artefact, never a log line** — §1 is what log lines are worth.

| #   | Gap                                                                                                                                                                                                                  | Cheapest signal that settles it                                                                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **RPC dispatch has no purpose-built signal at all** — 315 methods, 283 BLIND, and in-process calls emit nothing whatsoever (U2). _Being implemented as of 2026-08-04, see below._                                    | Count at the single dispatch chokepoint (`handleGatewayRequest`), never per method — so it **cannot drift out of sync with the method list, because it does not have one**. The measure worth having is not call counts but **NEVER-CALLED-since-boot**: a registered method nobody calls is either dead code or a broken caller. Makes #12 free. |
| 2   | **Agent-tool observability is an accident of one plugin** — all 1,726 `tool=` lines in 3 days are `[prefrontal] HOOK …`                                                                                              | A `tool-invoke` family in `algorithm-metrics` at the tool seam: one `recordAlgorithmOutcome({tool, outcome})` per call. Ledger, not log.                                                                                                                                                                                                          |
| 3   | **Optional tools are silently stripped** — `recall`, `synapse_debate`, `budget_check` are registered and then removed by the empty-allowlist gate. Three papers' worth of mechanism unreachable, and nothing says so | At agent start, write the RESOLVED tool-name list into the anatomy row and assert expected-vs-resolved. One field on a table that already gets a row per turn.                                                                                                                                                                                    |
| 4   | **Silent prompt mutation** — persona injection, humor calibration, prefrontal rules and the ENGRAM pack all mutate the prompt and return nothing observable. A flag flipped off is identical to working              | `eeg:anatomy-write` already writes a per-turn row. Add `contributors: {id: injectedChars}`. A zero-char contributor for N turns is the alarm. **One field covers J1, J4, J7, J13 and J18 at once.**                                                                                                                                               |
| 5   | **The UI is structurally invisible** — `grep -rn 'declareInstrument(' tinker-ui/src` → **0**. The report cannot see any UI feature, ever                                                                             | A `fork.ui.note({id,count})` RPC calling `noteInstrumentFired`, plus one declaration per UI capability. Rides the existing report unchanged.                                                                                                                                                                                                      |
| 6   | **Crons that report success and prove nothing** — 5 of 18                                                                                                                                                            | Two asserts over data that already exists: alarm when `enabled && lastError === "disabled"`; require an artefact per `ok` run. Both are `jq` over `jobs-state.json` ⋈ `ls reports/`.                                                                                                                                                              |
| 7   | **Semantic memory integrity** — 5,258 chunks, 0 vectors, every freshness proxy green                                                                                                                                 | `SELECT count(*) FROM chunks WHERE vector IS NOT NULL` vs `count(*)`; assert equality. The same query shape settles 0 backlinks and 0 anchors.                                                                                                                                                                                                    |
| 8   | **An instrument on a dead path** — `engram:retrieval-pack-inject` (rule 1)                                                                                                                                           | Move the `noteInstrumentFired` call to the path that has callers. One line; turns a false `pending` into a true signal.                                                                                                                                                                                                                           |
| 9   | **Fractal: 2,466 rows, 0 successes, 8 weeks** — and the ledger proving it is read by nobody                                                                                                                          | A success-rate floor in `post-deploy-smoke`: `successes/rows < 0.05 → FAIL`. The data is already on disk; only the assert is missing.                                                                                                                                                                                                             |
| 10  | **The hook-payload contract class** — `payload.text` vs `assistantTexts` killed ENGRAM for a week, and **the identical bug is still live in CORTEX** (`~/.openclaw/cortex/` empty, dir mtime 2026-03-30)             | At the hook dispatcher, declare each hook's expected payload keys and count reads that miss. A generic detector for a bug class that has now bitten **twice in two extensions**.                                                                                                                                                                  |
| 11  | **82 live methods are unclassified** — default-deny client-side, silently ADMIN server-side; the exact two-sided trap that killed `fork.*` and produced 188 refusals / 0 nudges                                      | Persist the unclassified set once per boot as an artefact, and put the existing (currently RED) `method-scopes` test into the merge gate.                                                                                                                                                                                                         |
| 12  | **High-error-rate RPCs with no alarm** — `forensic.getResponseLive` 35✓/40✗ and `sessions.patch` 52✓/41✗ (53% and 44% failing), both firing today. Indistinguishable from healthy because they _do_ return successes | Per-method success ratio on the registry from #1, with a threshold. Free once #1 exists.                                                                                                                                                                                                                                                          |

> **#1 is in flight.** A concurrent session is adding `src/gateway/rpc-observability.ts` — one
> chokepoint in `handleGatewayRequest`, counters in a single Map bounded by the handler table,
> summarised into the journal _next to_ `[instrument-liveness]` rather than into a new surface
> nobody reads. It classifies refusals (`auth` / `unavailable` / `rate-limit` / `unknown-method`)
> because each is a different failure with a different fix — the §4 rule 2 shape applied to
> dispatch. **It is uncommitted working-tree code at the time of writing: do not treat it as
> landed, and do not build or deploy it on its author's behalf.** Re-run the coverage script to
> see whether it has taken effect; a fix that exists only in `src/` is not a fix (rule 7).

## 7. The machinery, and its one missing change

`src/infra/instrument-liveness.ts` is the **right mechanism** and it has already earned its keep.
`amygdala:nudge-injection` was caught `NEVER` on 08-02 and reports live today.
`engram:ingest-entry` / `-assistant` dropped out of the never-list between the 20:18 and 21:00
censuses, which is **how we know the ENGRAM fix actually landed**. The `stale` axis is real. Keep
all of it. **The gap is coverage, not machinery** — 24 declared ids against 576 capabilities.

Six defects, in severity order, all measured 2026-08-04:

1. **The registry is in-memory only, so `never` is not durable and therefore not trustworthy.**
   There is no `writeFile` in the module. Every restart resets `declaredAtMs` and `fireCount`.
   Measured on identical code, inside 43 minutes: `never=3` at 20:17:46 → `never=11` at 20:18:47 →
   `never=6` at 21:00:47. Three verdicts, driven purely by restart timing and module-load order. A
   six-hour-cadence instrument is re-accused as a defect 30 minutes after every boot.
2. **`live` / `pending` / `idle` are structurally unnameable.** The enumeration block names only
   `never` / `stale` / `byConfig`. Every _healthy_ row is unidentifiable from the log — you cannot
   answer "is `engram:embedding-cache` alive?" without a debugger.
3. **The head line names nothing.** `declared=25 live=11 pending=4 never=6 …` is the WARN headline;
   ids appear only in a separate block. The pre-2026-08-03 format carried `BROKEN=[…]`.
4. **One tolerance for all instruments.** `expectFireWithinMs` exists in `InstrumentDeclaration`
   and is largely unset, so the default mislabels every legitimately-rare producer. Compaction is a
   matter of days; `eeg:anatomy-write` is per turn. Same threshold for both.
5. **`byConfig` is order-dependent.** `compaction:safeguard-extension` and `amygdala:nudge-write`
   are each declared twice with different `conditional` values, and `declareInstrument` does
   `Object.assign(existing, decl)` — so **last writer wins** decides whether silence reads "broken"
   or "expected".
6. **A declared instrument with no firing site is invisible** (`compression:headroom-mcp`), and the
   id grep is wrong in both directions (§5c, rule 6).

### The watcher of the watchers is broken, and green

`scripts/post-deploy-smoke.mjs:155` parses:

```
/\[instrument-liveness\]\s+declared=(\d+)\s+healthy=(\d+)\s+silent=(\d+)\s+silentByConfig=(\d+)/
```

`src/infra/instrument-liveness.ts:508` has emitted `declared=… live=… pending=… never=… stale=…
idle=… byConfig=…` since the 2026-08-03 rewrite. The check's **`--self-test` fixture encodes the
OLD format**, so the self-test is green; `probes.md`'s merge gates assert only check-IDs and
evidence-presence, never verdicts, so the merge gate is green too. Live result: _"matched 3
line(s); newest did not parse"_ → **WARN**, and the NEVER-fired instruments went unreported.

**This is the disease inside the tool built to detect the disease**, and the sharpest possible
argument for the change below: **a regex over a log line is not an interface.**

### The one change

> **Expose `reportInstrumentLiveness()` rows verbatim through `gateway.observability.snapshot`,
> and persist `{id, lastFiredAtMs, fireCount}` to disk on the same 60s tick.**

That single change fixes defects 1, 2 and 3 together and unblocks the rest.
`reportInstrumentLiveness` currently has **exactly one consumer** — the logger, which says so in
its own header. The change makes every bucket nameable at a glance; makes `never` mean _never_
rather than _never since 17:47_; and gives `post-deploy-smoke` a **structured input instead of a
regex over a log line**, which is precisely the failure documented above.

**Second-cheapest, same pass:** a build-time gate asserting every `declareInstrument` id has ≥1
`noteInstrumentFired` — **resolving const and template indirection**, per rule 6. Both greps
already exist as R11/R12. A handful of lines, zero runtime cost, and it would have caught
`compression:headroom-mcp` on the day it was written.

### A caveat on the algorithm ledger

`recordAlgorithmOutcome` families auto-register **by firing** (7 families, 5,319 rows on
2026-08-04). This makes `fireCount === 0` unreachable: a family that stops recording does not go
`never` — its row simply **vanishes** at the next restart, and **no line is emitted**. The ledger
is excellent for _"how good"_ and structurally incapable of _"is it alive"_. Pair it with an
instrument; never substitute it for one.

## 8. The ratchet

`BLIND_CAP` in `scripts/bible/capability-coverage.mjs` is the measured status quo — **377**, equal
to the current structural measurement — and it may only ever be edited **downward**, in the same
commit that instruments something. A new capability that arrives with nothing watching it fails the
build.

The cap is deliberately **not zero and not a target**. Several hundred blind capabilities is not a
session's work, and a gate demanding zero on day one is a gate that gets switched off by Friday —
which is precisely how a codebase arrives here. Same shape and same reasoning as the ledger in
[`canonical-derivations.md`](canonical-derivations.md). **The number only moves one way.**

**Keep the cap equal to the measurement.** A cap above the measured value has stopped being a
ratchet — it is headroom for regressions to hide in, and every unit of slack is a capability that
can quietly go dark before anything complains. Lowering it is free whenever the two agree; do it in
the same commit.

**The cap is measured with the journal ignored, and that is deliberate.** Gating on the
journal-informed number would make the build depend on whether this host happened to receive
traffic for a method this week — a gate that passes or fails on log history is not a gate, and it
would go green on a fresh clone that has no journal at all.

**Raising the cap is not a fix.** If a genuinely unobservable capability arrives, leave the cap
alone and say why here — the exception belongs in prose where a human reads it, not in a number
that silently buys slack for everything else.

## 9. What this measure deliberately is not

**Coverage is scored per owning module, not per code path.** An extension with one instrument
counts as observed even if nine of its ten paths are unwatched. That is coarse on purpose: a
path-level score needs a call graph, and a metric nobody can reproduce by hand is a metric nobody
trusts. Read it as _"is anyone watching this component at all"_ — exactly the question fractal
failed, in silence, for eight weeks.

**Coverage is not correctness.** OBSERVED means a signal fired, not that the output was right.
Several capabilities are **broken in the open** right now — signals firing, values wrong: a domain
classifier labelling ordinary prose `math` on 24 of 57 units; a gap extractor writing the topic
`"tue 2026-08-04"` (a date) on 5 of 6 rows; plan auto-seeding logging 434/434 _"skipped — plan
already in_progress"_ for two months. Every one is fully OBSERVED. Catching _those_ needs an
assertion on the value, which is §6's job and `slos.md`'s — not this score's.

**The scope excludes the 145 upstream provider extensions** — not ours to instrument, and they
would drown the number. The script prints that exclusion on every run rather than letting the total
read as "everything". Nothing is dropped silently; that would be the same sin the file is about.
