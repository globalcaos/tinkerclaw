---
file: turn-latency.md
purpose: The turn latency budget — where the seconds between a user pressing Send and the model producing a token actually go, and the speed/intelligence/cost tradeoff each mechanism sits on
audience: AI (Claude, etc). Human readability is incidental.
last_verified: 2026-08-19
last_verified_commit: d356577293c
correction: "§7 (2026-08-19) supersedes §6's ranking. §1's causal claim about right-rail
  polling is REVERSED — the panels were the victim of a synchronous pack build, not the
  cause. Read §7 before acting on anything above it."
single_owner: yes — the per-stage latency budget and the three-axis tradeoff table live here. Per-mechanism behaviour is owned elsewhere (tool-loop.md for the bridge spawn, panels.md for the right-rail panels, memory-layout.md for engram/total-recall storage, slos.md for objectives). This file owns only WHERE THE TIME GOES and WHAT IT BUYS.
see_also: slos.md (objectives, once these budgets become targets), observability.md (what the fork can prove it is doing), failures.md (the M-modes a slow pre-prompt produces), tool-loop.md (the per-turn claude CLI spawn), done-signals.md (the thinking indicator this budget is rendered into)
verify:
  - name: the compaction gate is still a threshold comparison, so the "never fires at current fill" measurement stays checkable
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/src/agents/embedded-agent-subscribe.handlers.compaction.ts")).read(); assert "compaction-diag" in t or "logCompactionDecision" in t, "compaction diagnostics gone — re-derive this file"'
  - name: the total-recall pack reuse policy is still event-delta + max-age (the rebuild-rate claim depends on both constants)
    cmd: python3 -c 'import os,re; t=open(os.path.expanduser("~/src/tinkerclaw/extensions/tinkerclaw-total-recall/index.ts")).read(); assert re.search(r"PACK_REBUILD_EVENT_DELTA\s*=\s*\d+", t) and re.search(r"PACK_REBUILD_MAX_AGE_MS\s*=", t), "pack reuse policy changed — re-measure the rebuild rate"'
  - name: the turn-phase telemetry contract is intact end to end (emitters + UI consumer)
    cmd: python3 -c 'import os; p=os.path.expanduser; a=open(p("~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/index.ts")).read(); b=open(p("~/src/tinkerclaw/extensions/tinkerclaw-total-recall/index.ts")).read(); c=open(p("~/src/tinkerclaw/tinker-ui/src/turn-phase.ts")).read(); assert "turn-phase" in a and "turn-phase" in b and "turn-phase" in c, "phase telemetry broken — the indicator will silently fall back"'
---

# Turn latency — where the time goes and what it buys

## What this file is FOR, how it was DERIVED, and what would CHANGE it

**FOR.** Deciding which parts of a turn are worth their wall-clock. Jarvis is optimised
along three axes — **faster, smarter, cheaper** — and they cannot all be maximised at
once. This file measures each mechanism on all three so a change can be argued rather
than guessed. Its specific job is to separate the seconds that buy intelligence from the
seconds that buy nothing, because only the second kind is free to delete.

**DERIVED.** Every number below is measured on the live gateway, not modelled. Sources
and dates are named inline; the collection window is **2026-08-12 → 2026-08-13** unless
stated. Nothing here comes from reading source and reasoning about what it should do —
three separate diagnoses in `bug-log.md` were confidently wrong that way.

**WHAT WOULD CHANGE IT.** Any of: the pre-prompt pipeline gaining or losing a stage; the
right-rail panels moving off the gateway's event loop; the tinker-bridge worker pool
actually being used; the context window or compaction thresholds changing; the billing
plan changing (the cost axis below is a flat-fee artifact and inverts if usage ever
becomes metered). **Re-measure, do not re-reason.** The `verify:` blocks above fail loudly
when the constants this file depends on move.

---

## 1. The measured budget

A turn's wall-clock splits into a **pre-prompt** phase (user pressed Send, no model has
been chosen yet) and the **model** phase. Only the first is under our control.

Three fully traced turns, `journalctl --user -u openclaw-gateway`, 2026-08-12 02:48–02:56:

| turn (session) | `chat.send` → model named |
| -------------- | ------------------------- |
| `msolholm`     | **20.8 s**                |
| `msok52zc`     | **36.1 s**                |
| `msok3d30`     | **25.5 s**                |

Worked example, `msok52zc` (2026-08-12 02:54:35 → 02:55:13):

```
02:54:35.976  res chat.send 760ms                      <- the message is already delivered
02:54:48.235  res budget.usage        14,136ms          |
02:54:48.261  res debug.dumpUiSnapshot 11,021ms         |  right-rail panels, SAME event loop
02:54:50.269  res sessions.usage      16,170ms          |
02:54:51.097  compaction gate preflight  fires=FALSE
02:54:55.971  [engram] hybrid retrieval (FTS + vector via ollama)
02:55:12.077  [total-recall] pack rebuilt               <- ~16 s for engram+pack combined
02:55:12.092  [prefrontal] Main activated (claude-opus-5)
02:55:13.701  turn start  systemPrompt.len=59,950
```

Aggregates over 2026-08-12 (11.4 MB of journal, n stated per row):

| measurement                            | value                                                       |
| -------------------------------------- | ----------------------------------------------------------- |
| context fill (n=229, window 1,000,000) | p10 **2.3%** · p50 **3.0%** · p90 **27.7%** · max **28.6%** |
| compaction gate firings                | **0 / 229**                                                 |
| system prompt shipped (n=205)          | p50 **60,290 chars ≈ 15,072 tok** · max 65,868              |
| CLI spawn → first token (n=204)        | p50 **2,596 ms** · p90 **6,274 ms**                         |
| `debug.dumpUiSnapshot` (n=372)         | p50 2,231 ms · p90 **11,075 ms** · max 35,771 ms            |
| `sessions.usage` (n=278)               | p50 1,160 ms · p90 **50,951 ms** · max **366,022 ms**       |
| `budget.usage` (n=270)                 | p50 2,838 ms · p90 **37,530 ms** · max 91,346 ms            |

**The single largest contributor is the UI's own right-rail polling.** ~920 panel calls a
day share the gateway's single-threaded event loop with turn dispatch, and their tails run
to tens of seconds. A turn issued while `sessions.usage` is mid-scan simply waits.

## 2. The three axes, per mechanism

"Smarter" has no direct metric. The proxy used is **finding yield** for the reflection
lane and **contribution to the prompt** for the retrieval stages — both measure production,
not whether the output was worth acting on. Treat the column as ordinal, not cardinal.

| mechanism                   | time on critical path     | tokens                  | smarter?                      | verdict                                               |
| --------------------------- | ------------------------- | ----------------------- | ----------------------------- | ----------------------------------------------------- |
| right-rail panel RPCs       | ~0.3 s (see §7)           | 0                       | nothing                       | **NOT the problem — this row was wrong**              |
| total-recall pack rebuild   | 24 s → **1.3 s** (§7)     | **+714 in**             | recall                        | **fixed 2026-08-19 (`bcbf3d18e78`)**                  |
| claude CLI spawn (per turn) | p50 2.6 s                 | 0                       | nothing                       | **use the existing worker pool**                      |
| auto model/effort router    | ~0 ms                     | 0                       | picks model + effort          | keep — it is free                                     |
| compaction gates            | ~0                        | saves **0**             | insurance                     | keep — cheap, and the day it fires it earns its place |
| system prompt assembly      | 0 (already built)         | **15,072 tok/turn**     | identity, skills, tools       | trim later; not latency                               |
| fractal reflection          | **0 — off critical path** | **69.1%** of all tokens | 29.2% of runs yield a finding | **fix the timeouts**                                  |

## 3. What the pipeline actually saves

**It does not save tokens per prompt — it adds them.** The retrieval pack _adds_ ~715
tokens, and compaction fired **0/229**. There is no per-prompt token saving to point at.

The saving is **counterfactual and it is a TIME saving**: engram + total-recall replace raw
history with a small pack, which is why fill sits at p50 3% / p90 27.7% instead of climbing
toward the window. Prefill cost scales with context, so a session that crept to ~90% full
would re-prefill ~900,000 tokens _every turn_ — the "takes forever to respond" the architect
reports from native OpenClaw. That is the mechanism's real product.

**Assumptions, stated so they can be attacked:**

- `chars / 4 ≈ tokens`. Rough; fine for ratios, wrong for billing.
- The counterfactual 90%-fill figure is **illustrative**, not measured. Nobody has run this
  workload without the pipeline.
- Reflection token totals are **cumulative per session** from `sessions.list`
  (read 2026-08-13), while run counts come from the ledger. Dividing one by the other gives
  an order of magnitude, **not** a per-run cost.
- The €/token figure below is a **flat fee ÷ measured usage**, which is an average and not
  a marginal price. It falls as usage rises. Do not quote it as "what a token costs".

## 4. The cost axis is nearly inert — and why that matters

From the recalibrated cost table (`tinker-ui/src/panels/eeg-trace.ts`, recalibrated
2026-08-12): Anthropic Max 20× **€217.80/mo + €46.28 metered overage = €264.08**, giving
**€0.0406 per sonnet-eq Mtok** — the constant it replaced was **43× too high**.

At that rate the reflection lane's 241.7 M tokens over two months is on the order of **€10**.
Under a flat plan the marginal euro cost of a token is ≈ 0 until the next overage tier.

**Consequence: the real tradeoff is speed vs smarter.** Cost only re-enters as a constraint
through overage and rate-limit headroom. Any argument of the form "we should do less of X to
save money" is, on current billing, arguing about ~€10. Any argument of the form "we should
do less of X because the user waits" is arguing about 20–36 s per turn.

## 5. The reflection lane, correctly dated

The lifetime ledger (`~/.openclaw/data/fractal/results.jsonl`, 3,235 rows,
**2026-06-11 → 2026-08-13**) reads 87.9% error / 6.2% yield. **That number is historical and
must not be quoted.** 2,106 of those errors are `triage-prompt.md missing or unreadable`,
whose **last occurrence was 2026-08-04T14:32:42** — the file has existed since 2026-08-05.

Health since the fix (2026-08-07 → 2026-08-13, n=504):

| outcome                       | count   | share             |
| ----------------------------- | ------- | ----------------- |
| flagged (produced ≥1 finding) | 147     | **29.2%**         |
| clean                         | 13      | 2.6%              |
| skipped (superseded / budget) | 96      | 19.0%             |
| error                         | 248     | 49.2%             |
| — of which **timeout**        | **221** | 43.8% of all runs |

So the lane works, runs **off the critical path** (it never delays a reply), and costs
tokens that are nearly free. Its defect is that **~44% of runs time out**, which is spend
with no product. Fixing the timeout roughly doubles findings per token and costs the
architect no latency.

## 6. The ranked change list

Ordered by **speed gained per unit of intelligence lost**, which is the only ordering that
respects the three-axis constraint.

1. **Right-rail panels off the dispatch loop** — up to ~15 s, zero intelligence cost.
2. **Serve the stale total-recall pack, rebuild asynchronously** — ~16 s, near-zero cost:
   the pack is already up to `PACK_REBUILD_EVENT_DELTA` events stale by design, so serving
   it one turn older changes almost nothing about what the model knows.
3. **Use the tinker-bridge worker pool that already exists** — ~2.6 s, zero cost.
4. **Fix the reflection timeouts** — no latency change; ~1.8× findings per token.
5. **Leave compaction alone** — it is cheap insurance against the failure mode in §3.

1+2+3 target ~30 s of the measured 21–36 s with essentially no loss of capability. That is
the whole point of the split in §2: the overhead is separable from the intelligence.

**Known imprecision:** the per-stage split comes from three fully traced turns, while the
RPC contention figures come from a full day. Contention and retrieval interleave, so the
per-stage attribution is approximate. ~~The ordering of §6 is robust to that~~ — **it was
not. §7 replaces §6.**

---

## 7. CORRECTION (2026-08-19) — §6 ranked the victim first

Everything above §7 is preserved as written, because being wrong in a specific way is the
useful record. Three of its load-bearing claims did not survive re-measurement.

### 7.1 The pack build, not the panels, was the dominant term

`assembleRetrievalPack` is **not `async`** (`src/memory/engram/retrieval-integration.ts`,
`export function … : string`). So `void refreshPackInBackground(...)` in
`extensions/tinkerclaw-total-recall/index.ts` ran it **inline**: the single event loop was
frozen for its full duration, for every session, not just the one waiting. The label
`OFF-PATH` on its log line was false for the wall clock a user waits.

Cost, measured four independent ways — the only figure in this file with that property:

| method                                                          | n   | p50    | p90    |
| --------------------------------------------------------------- | --- | ------ | ------ |
| journal segment (engram start → `Main activated`)               | 131 | 17.0 s | 27.0 s |
| the pack's own `tookMs=` timer (off-path twin only)             | 97  | 20.2 s | 29.2 s |
| freeze gap left in the journal immediately before the pack line | 377 | 24.0 s | 34.0 s |
| offline replay of the compiled `dist` chunk the gateway loads   | 16  | 23.4 s | 32.5 s |

Corroborated by the runtime's own libuv histogram: intervals containing a pack build
measure `eventLoopDelayMaxMs` p50 **27,406 ms** / p90 **45,007 ms** (n=204), against
**4,899 / 8,904 ms** without (n=2,579).

**99.3% of it was the MMR rerank**, and the rerank was a no-op in kind: `maxItems`
defaults to `FTS_TOP_N` (50) against a candidate list already sliced to 50, so it selects
every candidate and only changes their ORDER — of which ~15 survive the token budget.
`wordJaccard` rebuilt BOTH operands' word sets on every one of the 20,825 comparisons:
**41,650 set constructions from full event text, for 50 distinct events.**

Fixed in `bcbf3d18e78` (build each set once; keep a running max instead of recomputing it):
**23,382 ms → 1,316 ms p50 (17.8×), with 32/32 packs byte-identical** on the architect's
real stores. Deployed `d356577293c`, 2026-08-19 10:52.

**CONFIRMED IN PRODUCTION, 2026-08-22** — the pack's own `tookMs` timer, the identical
instrument on both sides of the deploy:

| window | n   | min     | p50         | p90     | max     |
| ------ | --- | ------- | ----------- | ------- | ------- |
| before | 112 | 10.61 s | **19.46 s** | 29.45 s | 46.71 s |
| after  | 58  | 0.49 s  | **1.82 s**  | 3.24 s  | 6.29 s  |

**10.5× on p50 in production**, and the worst observed build fell 46.71 s → 6.29 s. Lower
than the bench's 17.8× because the live stores keep growing and the gateway carries
concurrent load; same order, and the tail collapse is the part that matters.

**SECOND PASS, `f0dfa530449` (2026-08-22).** With the rerank gone, the residue was `ftsSearch`
scanning the whole store: `event.content.toLowerCase()` ran per event per search (~21MB of
unchanged text lowercased per build) and `content.split(term).length - 1` allocated an array
of every substring between matches purely to read its length. Memoised the lowercase form in
a WeakMap keyed on the event object, and replaced the split with an indexOf stepping loop.
Bench, same real stores, both runs idle: **1,316 ms → 720 ms p50 (1.8×)** — and the corpus
GREW between the two runs (2,307 → 2,388 events), so that is a floor.

**Cumulative on the pack build: 23,382 ms → 720 ms, 32.5×**, with a same-corpus A/B proving
32/32 packs byte-identical.

End to end, `chat.send` → `Main activated` (§1's own endpoint): **p50 105.0 s (n=145) →
11.0 s (n=49)**, and stable across four days at 14 / 12 / 12 / 12 s.

**Do not use the journal-gap method to track this any more.** Pre-fix the silence before a
pack line was ~all build (24 s gap vs a 19.5 s build). Post-fix that gap still measures
11 s p50 (n=359) while the build is 1.8 s — the remaining 9 s is other work that was
always there and was simply hidden inside the freeze. The gap now measures a different
quantity than it did, which is exactly how a proxy metric outlives its validity.

### 7.2 The causal arrow in §1 points the wrong way

§1 concluded "the single largest contributor is the UI's own right-rail polling". The
correlation is real; the direction is not. A panel call **overlapping a pack build**
measures p50 **333,084 ms** (n=246); one overlapping nothing measures **1,283 ms**
(n=1,035). The panels were being frozen _by_ the turn work, then read back as its cause.

Panels' own established cost is **~0.33 s/turn** (30.5% exposure × ~1.08 s p50). The
"+8.4 s p90" that §6 item 1 was sold on concentrates entirely in high-loop-delay strata
and inverts sign in one of them. §6's item 1 is therefore **retired**; re-measure the
panels only now that the freeze is gone and their self-cost is visible for the first time.

### 7.3 §6 item 2 was already done, and item 3's premise was wrong

Stale-while-revalidate shipped in `2a50181bb7a` (2026-08-15). It did not help as much as
expected for two reasons: 88% of pack-building sessions build exactly **once** (383 keys,
434 synchronous builds) so they never reach the reuse path at all; and the "background"
refresh called a synchronous function (§7.1).

The worker pool is not unused — 89% of turns spawn **cold** (755/846). §7.3 originally
attributed that to an undocumented third clause in `packIsStillFresh`
(`ccEventCount !== cached.ccEventCount`, exact equality against a store shared by every
session and written out-of-process ~28×/day). That clause is real and was fixed in
`d356577293c`. **It was not the cause, and the fix changed nothing measurable** — see §7.5.

### 7.4 What is actually left, and the honest answer to "can it be cut further"

**Unknown**, and that is a finding rather than a hedge. Between `chat.send` and the model
being named there are **15 consecutive awaited stages in `attempt.ts` with no timing
instrumentation at all** — sandbox resolution, bootstrap reads, MCP/LSP runtime construction,
system-prompt assembly, session locking, transcript repair, history sanitising. That region
measured **7.1 s on one traced quiet turn (n=1)** and p50 **99 s** across 7 days, and not one
second of it is attributed. The two labels that bracket it (`choosing a model`,
`assembling the prompt`) both fire at the TOP of the runner, ~1,900 source lines before the
region ends.

**The one instrument:** thread the existing `runId` through `dispatchInboundMessage` →
`enqueueSession` → `attempt` and emit `[turn-span] runId=… stage=… ms=…` at each existing
await boundary; add `tookMs=` to the synchronous pack log line (its twin already has it) and
`runId=` to the command-queue lane-wait warning. Three of this investigation's four biggest
errors would have been impossible with it.

**BUILT AND DEPLOYED 2026-08-22** (`833b2753941`). 12 stages are spanned — 10 async, 2
synchronous — emitted UNCONDITIONALLY, with no duration threshold, precisely so this optic
stops accumulating counts of SLOW events masquerading as counts of events.

### 7.6 First reading of the dark region — it is NOT where the seconds are

First live spans, `n=4 runs` — **thin, and labelled so; do not quote a p90 off four runs**:

| stage                     | n   | p50     | max     |
| ------------------------- | --- | ------- | ------- |
| `mcp-tools`               | 2   | 1,015ms | 5,080ms |
| `session-lock`            | 2   | 2ms     | 2,667ms |
| `session-repair`          | 2   | 16ms    | 2,367ms |
| `session-prewarm`         | 2   | 1ms     | 1,182ms |
| `lsp-runtime`             | 2   | 135ms   | 142ms   |
| `mcp-runtime`             | 3   | 9ms     | 123ms   |
| `resource-reload`         | 2   | 18ms    | 33ms    |
| `session-open`            | 2   | 10ms    | 27ms    |
| `system-prompt-build`     | 2   | 2ms     | 5ms     |
| `sandbox`                 | 4   | 1ms     | 1ms     |
| `context-bootstrap`       | 2   | 0ms     | 0ms     |
| `session-manager-prepare` | 2   | 0ms     | 0ms     |

**Whole spanned region per run: p50 1,208ms**, max 11,626ms.

Two things follow, both of which contradict what this file assumed before it could see.

1. **The "~5s of unattributed pre-model time" is not spread across 15 stages — on a typical
   turn the entire region costs ~1.2s.** `SessionManager.open`, ranked earlier as a real
   synchronous block worth capping, measures **10ms**. `context-bootstrap` and
   `session-manager-prepare` are **0ms**. Several items previously worth "instrumenting
   first" are simply free.
2. **The cost is bimodal, not distributed.** The 11.6s run is the FIRST turn after a
   gateway restart, paying `mcp-tools` 5.1s + `session-lock` 2.7s + `session-repair` 2.4s +
   `session-prewarm` 1.2s cold. Every later run is ~1.2s. So the target here is a
   once-per-restart warm-up, not a per-turn tax — a completely different fix from the one
   this file would have recommended yesterday.

### 7.7 n=20 — point 2 above was half wrong, and the half that is wrong is the expensive half

Same instrument, 240 spans across 20 runs (supersedes §7.6's n=5 table):

| stage                     | p50         | p90         | max      | total over 20 runs |
| ------------------------- | ----------- | ----------- | -------- | ------------------ |
| **`mcp-tools`**           | **879ms**   | **3,869ms** | 5,080ms  | **23.9s**          |
| `session-lock`            | 2ms         | 167ms       | 2,667ms  | 4.0s               |
| `session-repair`          | 1ms         | 51ms        | 2,367ms  | 2.6s               |
| `lsp-runtime`             | 105ms       | 141ms       | 150ms    | 1.3s               |
| `session-prewarm`         | 0ms         | 2ms         | 1,182ms  | 1.2s               |
| `mcp-runtime`             | 8ms         | 126ms       | 150ms    | 0.7s               |
| `resource-reload`         | 16ms        | 24ms        | 33ms     | 0.3s               |
| `session-open`            | 3ms         | 16ms        | 38ms     | 0.2s               |
| `system-prompt-build`     | 2ms         | 6ms         | 10ms     | 0.1s               |
| `sandbox`                 | 0ms         | 1ms         | 1ms      | 0.0s               |
| `context-bootstrap`       | 0ms         | 1ms         | 1ms      | 0.0s               |
| `session-manager-prepare` | 0ms         | 0ms         | 0ms      | 0.0s               |
| **WHOLE REGION PER RUN**  | **1,137ms** | **3,901ms** | 11,626ms | —                  |

**The "once-per-restart warm-up" reading holds for `session-lock`, `session-repair` and
`session-prewarm` — all three are p50 ≤ 2ms and carry their whole cost in a single cold
max. It does NOT hold for `mcp-tools`, which is a genuine per-turn tax: p50 879ms is
77% of the region's p50, and its p90 of 3,869ms is nowhere near its cold max.** Five runs
could not separate those two shapes; twenty can. The correction is recorded rather than
edited in because the n=5 reading was published in `0dce3c902cf` and acted on.

`lsp-runtime` is the other steady per-turn cost at ~105ms — small, but constant.

**Next target, with the numbers to justify it:** `materializeBundleMcpToolsForRun`
(`src/agents/agent-bundle-mcp-materialize.ts:64`). Its cost is `await runtime.getCatalog()`
round-tripping every MCP server; the local sort-and-rename that follows is trivial. Caching
the catalog trades a stale tool list for ~0.9s/turn, which is a FEATURE question — a newly
added MCP tool would not appear until invalidation — and so is not a decision to take from
a latency budget alone.

### 7.8 A PHASE LABEL IS NOT A STAGE — and this optic kept reading it as one

`beginTurnPhase` wraps `runModifyingHook`, so a narrated phase's `ms` is the duration of the
WHOLE hook chain. `before_prompt_build` has **eight** registered handlers, run sequentially:
`skill-workshop`, `diffs`, `active-memory`, `memory-lancedb`, `tinkerclaw-computational-humor`,
`tinkerclaw-prefrontal` (×2), `tinkerclaw-total-recall`, `tinkerclaw-identity-persistence`.

§7.1 optimised ONE of those eight from 19.5s to ~1.1s and reported the result as the stage's.
It is not — the architect still reads "recalling memories 12.7s" in his chat, because the row
is a sum. **This is the third time this file has mistaken an aggregate for a component**
(§7.2 the panel RPCs, §7.6 the n=5 warm-up reading, and now this). The pattern is always the
same: a measurement whose NAME sounds like a part while its VALUE is a whole.

Per-plugin timing shipped in `32ec95d0b72` (`[hook-span] hook=… plugin=… ms=…`, allowlisted to
the narrated hooks, no threshold) and is surfaced in the UI in `4d204c21e43` — each phase row
now expands into its plugins, slowest first, each with a popup arguing what its milliseconds
buy. First measurement, **n=1**:

| plugin                            | ms         | share |
| --------------------------------- | ---------- | ----- |
| `tinkerclaw-total-recall`         | **14,717** | 100%  |
| `tinkerclaw-computational-humor`  | 9          | 0%    |
| `tinkerclaw-identity-persistence` | 6          | 0%    |
| `tinkerclaw-prefrontal` (×2)      | 1, 2       | 0%    |

The other four did not fire at all.

**Two hypotheses about the residual, both killed by measurement rather than argument:**

1. _"The seven plugins I did not optimise are carrying ~11s."_ **No** — together they are ~18ms.
2. _"The plugin is re-initialised mid-turn"_ — `[total-recall] ready` printed four times inside
   one traced turn. **No.** Across a full day: 23 `ready` lines against 6 gateway starts, 166
   turns and 150 distinct session keys — **3.8 per START, 0.14 per turn**, with several hours
   showing 0 `ready` against 12–28 turns. The four clustered immediately after a restart:
   lazy first-use initialisation.

So ~13.6s sits inside `total-recall`'s handler and outside the pack build it contains.
`aad261ee7d3` instruments the two steps that had no timer: `storeLoadMs` (the `count()` calls
that force `loadCache()` — readFileSync of a 15.6MB + 6.2MB pair with a JSON.parse per line)
and `tookMs` on the SYNCHRONOUS build path, which never had one while its off-path twin has
since 2026-08-15. **594 of 691 builds in a 7-day window carried no duration at all**, so every
statement in this file about "the pack build" was derived from the 14% that happened to log
one — the same censored-denominator defect as the 50ms RPC threshold and the 2s lane-wait
threshold. The warm path is now logged too (`pack served warm`), because a warm-but-slow turn
was previously indistinguishable from a fast one.

Numbers pending: the gateway has been idle since the deploy. **Do not fill this table by
reasoning.**

### 7.5 The cold-spawn fix FAILED, and the real cause is a marker nobody emits

Measured after `d356577293c`, `spawning claude` / `turn start`:

| window                         | turns | spawns | cold    |
| ------------------------------ | ----- | ------ | ------- |
| before the fix (08-12 → 08-19) | 971   | 858    | 88%     |
| after the fix (08-19 → 08-22)  | 300   | 296    | **99%** |

**It got worse, not better.** (The trend was already climbing — 72 / 79 / 91 / 95 / 94 / 96%
across 08-12→08-18 — so the fix did not cause the rise; it simply did nothing for it.)

**Why.** The worker key is `djb2(stableSystemPromptPrefix(systemPrompt) ⧵u0001 sessionId)`
(`extensions/tinkerclaw-tinker-bridge/src/stream.ts:213`). `stableSystemPromptPrefix`
(:207) slices at `SYSTEM_PROMPT_CACHE_BOUNDARY_MARKER` and, when the marker is absent,
**falls back to the WHOLE prompt**:

```ts
const idx = full.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY_MARKER);
return idx === -1 ? full : full.slice(0, idx);
```

> ⛔ **RETRACTED 2026-08-23 — the three paragraphs that stood here were WRONG.** They claimed
> "nothing ever emits that marker", "every importer of it is a test", and "the string occurs 0
> times in `dist/index.js`". All three are false. The retraction is kept in place, with the
> method error named, because this section was cited to justify a change that would have made
> things worse — see §7.9.
>
> **What is actually true:** the marker IS emitted, at `src/agents/system-prompt.ts:1069`, under
> its own deliberate comment ("Keep large stable prompt context above this seam"). It has
> **eleven production importers**. It is in the shipped bundle at
> `dist/system-prompt-cache-boundary-Ds1DPvzb.js`. And a live forensic dump of a real turn
> contains it. `stableSystemPromptPrefix` therefore takes its slicing branch, not its fallback.
>
> **How the error was made, so it is not repeated.** Two method failures, both mine:
>
> 1. The importer list came from `grep -rn … | head -10` over an alphabetically-sorted result.
>    `anthropic-payload-policy.test.ts`, `cli-runner.helpers.test.ts` and
>    `system-prompt-cache-boundary.test.ts` all sort before `system-prompt.ts`, so the truncation
>    hid every production importer and left a list that was 100% tests. **Never conclude "all X
>    are Y" from a truncated listing.**
> 2. "0 times in `dist/index.js`" grepped ONE chunk of a code-split bundle. The same mistake was
>    made twice more the same day (the FTS memoisation, the per-plugin emit) and was caught both
>    times by grepping the whole of `dist/`. **A bundler splits; grep the directory, never a file.**

**So why is the pool still cold?** Because the boundary is real but nearly useless in its current
position. Measured over **400 captured prompts** (`~/.openclaw/forensic-dumps`), every one of them
carrying the marker:

| quantity                                | value         |
| --------------------------------------- | ------------- |
| distinct WHOLE prompts                  | 330 / 400     |
| distinct PREFIXES (what the key hashes) | **276 / 400** |

The boundary collapses 330 prompt variants into 276 worker keys — a **16% reduction**. The churn
is ABOVE the seam, not below it. Splitting the prefix by markdown heading and counting distinct
bodies per heading says exactly where:

| section inside the hashed prefix                | distinct | seen |
| ----------------------------------------------- | -------- | ---- |
| **`## Retrieved Context`**                      | **254**  | 547  |
| `## ✅ 2026-07-29 … ENGRAM: the retrieval pack` | 83       | 188  |
| `# Coordination note — two CC sessions…`        | 22       | 93   |
| `## Tooling`                                    | 7        | 400  |
| `## Skills (mandatory)`                         | 3        | 400  |
| `# IDENTITY.md`                                 | 2        | 598  |

**The retrieval pack is 254 distinct values across 400 turns.** Identity is 2, tooling is 7.
The pack alone accounts for essentially the whole cold-spawn rate. The second row is the same
pack quoted back inside a RETRIEVED MEMORY — the store has notes about the pack, retrieval
injects them, and they churn the key in their own right.

**Consequence for §7.3's reasoning.** The 2026-07-29 stabilisation was aimed at exactly the right
target; it simply is not achieving stability. `PACK_REBUILD_EVENT_DELTA`/`MAX_AGE_MS` should give
a handful of pack values per session, and the measurement says 254. That gap — not the boundary,
not the delivery channel — is the whole problem.

**The pack belongs in the key, deliberately.** A warm worker keeps the system prompt it was
spawned with (`--append-system-prompt` is a spawn argument; a live worker accepts only user
messages on stdin, `worker.ts:1056`). So a changed pack MUST change the key: that respawn is the
only mechanism by which fresh memory reaches the model. Moving the pack below the seam would buy
worker reuse by serving stale memory forever.

**Also do not trust these numbers' denominators.** `src/gateway/ws-log.ts` only logs an RPC
when `durationMs >= 50` (`DEFAULT_WS_SLOW_MS`), so every `n=` in §1 is a count of SLOW calls,
not of all calls. No total call counts exist for any method. The §1 baseline
"20.8 / 36.1 / 25.5 s" is **three hand-picked turns**; the same day on the same endpoints
measures p50 34.5 s / p90 846 s (n=12).

### 7.9 The alternative that was designed, costed, and REJECTED — pack into the user message

Worth recording because it is the obvious idea, it is cheap to implement, and it is wrong.

**It would have been nearly free to build.** The hook contract already has `prependContext`
alongside `prependSystemContext`, and BOTH runner paths honour it — `attempt.ts:2481` for the
embedded runner, `cli-runner/prepare.ts:350` for the bridge. Switching total-recall's three
return sites from `prependSystemContext` to `prependContext` is a one-word change per site, and
it would have moved the pack out of the hashed prefix, stabilised the key, and simultaneously
solved the staleness problem — a live worker CAN be handed fresh text on stdin, which is the only
channel that reaches one.

**Why it is nevertheless the wrong trade: a user message PERSISTS.** The system prompt is re-sent
per turn and never accumulates. A user message enters the transcript and stays. At a measured p50
of 714 tokens per pack, a 100-turn session accumulates ~71,000 tokens of stale memory snapshots,
each one presented to the model as though it were part of the conversation. That is:

- the exact context bloat the whole ENGRAM/Total Recall architecture exists to prevent;
- worse than bloat — J1 §4's own argument is that a retriever which injects obsolete objectives is
  more damaging than one that injects nothing, and this would make every past pack permanent;
- self-reinforcing: `## ✅ … ENGRAM: the retrieval pack` in the table above shows the store
  already retrieves its own notes about packs. Persisting packs into the transcript feeds that.

The 2026-07-29 note in `extensions/tinkerclaw-total-recall/index.ts` says "the fix is not to move
the pack — it is to make it behave as the paper says." That was right, and this is the reason it
did not state. **Do not reopen this without first showing where the accumulated tokens go.**

### 7.10 The 41s was NOT bootstrap and NOT skills — it is `tools-build`, 3.4s every turn

Measured over **n=85 real runs**, 2026-08-23 22:24 → 2026-08-24 10:30, after §7.8's gap-tiling
made every millisecond either a named stage or a named gap.

| stage                  | ms p50    | ms p90    | ms max     | floor     | gap p50 |
| ---------------------- | --------- | --------- | ---------- | --------- | ------- |
| **`tools-build`**      | **3,432** | **5,124** | 7,482      | **2,610** | 2       |
| `mcp-tools`            | 839       | 1,667     | 6,948      | —         | 2       |
| `bootstrap-files-read` | 17        | 1,235     | **54,979** | —         | 2       |
| `skills-load`          | **0**     | 1         | 282        | —         | 3       |

Three things this settles, and two of them settle against what this optic previously assumed.

1. **The tiling worked.** 861s inside stages against 44s inside gaps, over the same window. The
   "over 95% not accounted for by any stage" the architect read off his own screen is gone — the
   largest surviving gap is `before:system-prompt-build`, and it is a rounding error beside the
   stages. An unnamed region no longer exists on this path.
2. **`tools-build` is the whole story now.** On the median turn it is 3,432ms of a 4,652ms total —
   74%, with `mcp-tools` taking another 19%. **93% of the pre-model path is two stages.** It has a
   hard floor of 2,610ms and NOT ONE of the 85 runs came in under a second, so this is not a tail
   to be trimmed: it is a fixed toll on every turn. It is also **synchronous**, so those seconds
   are charged to every other session sharing the event loop, not only to the turn paying them.
3. **`skills-load` was the prime suspect and measures p50 0ms.** The snapshot cache hits on 85 of
   89 runs; the 4 misses are `title-suggest-*` runs that pass no snapshot and pay 166–282ms. It
   skips 168 SKILL.md manifests when it hits. **The suspect was named from source and was wrong** —
   the fifth time on this path. It was only found out because it was instrumented instead of
   blamed, which is the entire argument of §7.4.

`tools-build` is now split three ways (`tools-run-context`, `tools-upstream-factory`,
`tools-allow`) because a single number cannot say which of them holds the 3.4s. **Do not propose a
fix for it until those three have reported** — that is the precise mistake this section documents
four instances of.

**Open, deliberately not guessed at:** `bootstrap-files-read` is strongly bimodal — 62 of 89 runs
under 100ms, but four runs at 36.5s / 40.6s / 43.6s / 55.0s. It is an async span, so its ms is wall
clock, and the 55.0s window contains a 17,049ms `debug.dumpUiSnapshot` and the only
`session-write-lock` over-hold in the entire 12-hour window (17,077ms). How much is file I/O and
how much is queueing behind those cannot be separated without a sync sub-span or a CPU-time
counter. It is the largest single number in the table and it is **not** understood.

### 7.11 Two ways a row that WAS measured never reaches the screen

Both reported by the architect on 2026-08-24: _"One with a fresh window only shows 'sending',
nothing else. The other in the NeuroCoin shows more stuff, but 'Total Recall' is still not
itemized."_ Neither was a measurement failure — both were delivery failures, and they are worth
recording because the debugging went wrong the same way twice.

**One session, two spellings of its key.** A new tab mints `tinker:<ts>` and sends under it; the
gateway answers with `agent:main:tinker:<ts>` and the tab rebinds **mid-turn**. `sessionKeyMatches`
has always tolerated both forms, but the client-row store indexed the raw string, so the `sending`
row (written the instant `chat.send` resolves) went into one bucket and every row after the rebind
into another. A reload then restored whichever side it happened to ask for. Fixed by normalising
on read as well as write, so what is already on disk migrates rather than being stranded.

**A promoted plugin row could not expand.** Total Recall emits its own two stages, but every
`turn-stage` event was buffered into the client-measured "preparing context" bracket, and promoted
plugin rows passed `undefined` as their breakdown. So the largest plugin on the path was the only
one that could not show the breakdown it was already producing. Stages now carry the plugin that
owns them, and an owned stage is rendered under its owner and excluded from the bracket — showing
it in both would make the two panels contradict each other.

**The method failure, which matters more than either bug.** Both investigations concluded that the
events "are emitted" from a log line printed _next to_ the emit — `[turn-span]` for the runner,
`pack rebuilt … tookMs=` for total-recall. Both emits sit behind a `if (!runId || !sessionKey)
return` that the log line is not behind, so both lines are fully compatible with **zero** events
reaching the wire. A `[turn-span]` line proves a stage RAN, not that it ARRIVED.

The drop paths now log and the success path still does not, so silence is the success signal: a
`[turn-span]` line with no matching `[turn-stage] DROPPED` for the same runId+stage means it went
out. That is falsifiable at zero cost on the happy path, which is the property that was missing.

**Rule, general beyond this file:** a log line adjacent to a guarded operation is evidence the
code REACHED the guard, never that it PASSED it. If the failure path is silent, the success path
is unfalsifiable — and an unfalsifiable measurement is how a fully-sourced, entirely wrong
diagnosis gets written down with confidence.

## 8. The 1s rule, and the two aggregates it immediately killed (2026-08-24)

**The rule (the architect):** _"If a task is in average more than 1 second it should be decomposed
further."_ Encoded in `tinker-ui/src/phase-group.ts` as `needsDecomposition`, so a childless row
over 1s MARKS ITSELF in the timing block rather than waiting for someone to notice.

**Which units tripped it.** Fourteen days of gateway journal, `[turn-span]` + `[hook-span]`:

| unit                      |   n |   avg |   p50 |    max | already decomposed?  |
| ------------------------- | --: | ----: | ----: | -----: | -------------------- |
| `tools-wrap`              |  16 | 6,498 | 6,902 |  8,089 | yes → eight `wrap-*` |
| `wrap-toolset`            |   9 | 5,950 | 5,763 |  7,716 | **no**               |
| `tinkerclaw-total-recall` | 268 | 5,678 | 6,544 | 21,741 | **no** (one stage)   |
| `bootstrap-context`       | 121 | 5,253 |    36 | 81,868 | yes → files-read     |
| `bootstrap-files-read`    | 121 | 5,250 |    35 | 81,866 | **no**               |
| `tools-build`             | 108 | 4,504 | 3,551 | 10,842 | yes → `tools-wrap`   |
| `mcp-tools`               | 321 | 1,311 |   878 | 12,568 | **no**               |

**Two splits, and both answers were one-sided enough to end the question.** Measured on the first
turn after the deploy (`fb3002fdeca`):

- `mcp-tools` **2,455ms** = `mcp-catalog` **2,449ms** + `mcp-tool-bind` **1ms**.
  The MCP per-turn tax is **entirely the servers**. The loop that renames, collision-suffixes,
  binds and sorts every catalog tool costs one millisecond. Any effort spent optimising our side
  of MCP is wasted; the lever is caching the catalog or removing servers.
- `bootstrap-files-read` **19,031ms** = `bootstrap-files-discover-read` **19,023ms** +
  `bootstrap-files-assemble` **4ms**.
  Entirely **discovery + disk**. Truncating and assembling the files is 4ms. Note the p50 of 35ms
  against a max of 81.9s: this is not a steady cost, it is a rare catastrophic one, and the tail
  is I/O.

**Why this is worth a section rather than a commit message.** Both aggregates had been carried for
weeks as single numbers on the "what to fix next" list, and in both cases the half that LOOKED
expensive (our code — a loop over every tool, a truncation pass over every file) turned out to be
1ms and 4ms. Ranking work off an aggregate ranks the wrong thing; that is now the fourth time this
file has recorded that error, after §6/§7, the `recalling memories` chain, and `tools-wrap`.

**Still undecomposed:** `wrap-toolset` (5,950ms). It is the tool-array literal in
`src/agents/pi-tools.ts`, which was under active edit by a parallel session on the same day
(`e9df1abe35a` named `createImageGenerateTool` at 3.4s of it). Left alone deliberately to avoid a
collision, not because it is finished.
