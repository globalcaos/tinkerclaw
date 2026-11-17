---
file: turn-latency.md
purpose: The turn latency budget — where the seconds between a user pressing Send and the model producing a token actually go, and the speed/intelligence/cost tradeoff each mechanism sits on
audience: AI (Claude, etc). Human readability is incidental.
last_verified: 2026-08-19
last_verified_commit: d356577293c
correction: "§7 (2026-08-19) supersedes §6's ranking. §1's causal claim about right-rail
  polling is REVERSED — the panels were the victim of a synchronous pack build, not the
  cause. Read §7 before acting on anything above it. The current per-stage budget is §10
  (2026-10-29)."
single_owner: yes — the per-stage latency budget and the three-axis tradeoff table live here. Per-mechanism behaviour is owned elsewhere (tool-loop.md for the bridge spawn, panels.md for the right-rail panels, memory-layout.md for engram/total-recall storage, slos.md for objectives). This file owns only WHERE THE TIME GOES and WHAT IT BUYS.
see_also: slos.md (objectives, once these budgets become targets), observability.md (what the fork can prove it is doing), failures.md (the M-modes a slow pre-prompt produces), tool-loop.md (the per-turn claude CLI spawn), done-signals.md (the thinking indicator this budget is rendered into), logging.md (the `turn.span` row the `pre:*` labels of §9.2 ride), embedder-fit.md (the J13 lane's budget and trial, §10), topology.md (the gateway plugin snapshot memo, §10), lifecycles.md (L2, the one-shot worker CPU weight)
verify:
  - name: the compaction gate is still a threshold comparison, so the "never fires at current fill" measurement stays checkable
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/src/agents/embedded-agent-subscribe.handlers.compaction.ts")).read(); assert "compaction-diag" in t or "logCompactionDecision" in t, "compaction diagnostics gone — re-derive this file"'
  - name: the total-recall pack reuse policy is still event-delta + max-age (the rebuild-rate claim depends on both constants)
    cmd: python3 -c 'import os,re; t=open(os.path.expanduser("~/src/tinkerclaw/extensions/tinkerclaw-total-recall/index.ts")).read(); assert re.search(r"PACK_REBUILD_EVENT_DELTA\s*=\s*\d+", t) and re.search(r"PACK_REBUILD_MAX_AGE_MS\s*=", t), "pack reuse policy changed — re-measure the rebuild rate"'
  - name: the turn-phase telemetry contract is intact end to end (emitters + UI consumer)
    cmd: python3 -c 'import os; p=os.path.expanduser; a=open(p("~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/index.ts")).read(); b=open(p("~/src/tinkerclaw/extensions/tinkerclaw-total-recall/index.ts")).read(); c=open(p("~/src/tinkerclaw/tinker-ui/src/turn-phase.ts")).read(); assert "turn-phase" in a and "turn-phase" in b and "turn-phase" in c, "phase telemetry broken — the indicator will silently fall back"'
  - name: the holder-C window (§9) is still marked — chat.send sets the accepted-prompt mark right after its ack, and the pending-prompt derivation reads it (paths resolve against BIBLE_DIR's checkout, else the shared one)
    cmd: cd "${BIBLE_DIR:-$HOME/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE}/.." && grep -qF 'releaseAcceptedChatSend = trackAcceptedChatSend(' src/gateway/server-methods/chat.ts && grep -qF 'export function trackAcceptedChatSend' src/gateway/session-utils.ts && grep -qF 'of acceptedChatSends' src/gateway/session-utils.ts
  - name: the pre-reply window is spanned (§9.2) — chat.send's ack, each get-reply step and the reply operation close one pre:* turn.span each, keyed by the prompt's run id, and the reply's end closes nothing (2026-10-29)
    cmd: cd "${BIBLE_DIR:-$HOME/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE}/.." && grep -qF 'notePreReplyAck(clientRunId, sessionKey);' src/gateway/server-methods/chat.ts && grep -qF 'notePreReplyPlaced(opts?.runId);' src/auto-reply/reply/agent-runner.ts && grep -qF 'notePreReplyStage(ctx.SessionKey, name, Date.now(), opts?.runId)' src/auto-reply/reply/get-reply.ts && grep -qF 'clearPreReplyStage(ctx.SessionKey, opts?.runId);' src/auto-reply/reply/get-reply.ts && grep -qF 'emitEvent("turn.span", { runId, sessionKey, label' src/auto-reply/reply/pre-reply-stage.ts && grep -qF '"pre:placement", began - prompt.since' src/auto-reply/reply/pre-reply-stage.ts && test -f src/auto-reply/reply/pre-reply-stage.spans.test.ts
  - name: the amygdala stop seam's turn queries are index seeks — the store builds s_turn and d_sit in place on open (§10, 2026-10-29; before them every stop walked the whole decision history on the gateway's main thread)
    cmd: cd "${BIBLE_DIR:-$HOME/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE}/.." && grep -qF 'CREATE INDEX IF NOT EXISTS s_turn ON situations(turn_id, ts)' extensions/tinkerclaw-amygdala/src/store.ts && grep -qF 'CREATE INDEX IF NOT EXISTS d_sit ON decisions(situation_id)' extensions/tinkerclaw-amygdala/src/store.ts && test -f extensions/tinkerclaw-amygdala/src/store.turn-index.test.ts
  - name: the J13 semantic lane's wait on a turn is bounded (§10) — the client times out at the per-turn budget plus 1 s, the gateway clamps an asked budget to its ceiling, and recipe vectors fill only through the background lane (2026-10-29; before, the default 10 s gateway timeout held weak-lexical turns)
    cmd: cd "${BIBLE_DIR:-$HOME/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE}/.." && grep -qF 'timeoutMs: budgetMs + SEMANTIC_LANE_ROUND_TRIP_MS,' extensions/tinkerclaw-prefrontal/index.ts && grep -qF 'Math.min(askedBudgetMs, EMBED_CEILINGS.laneBudgetMs)' src/fork/prefrontal-state-rpc.ts && grep -qF 'embedBatch(todo, { priority: "background" })' src/fork/prefrontal-state-rpc.ts
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

Both reported on 2026-08-24: a fresh window showed only 'sending', and an older session showed
more stages but still did not itemize Total Recall. Neither was a measurement failure — both were delivery failures, and they are worth
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

**The rule:** a stage that averages more than 1 second is decomposed further. Encoded in `tinker-ui/src/phase-group.ts` as `needsDecomposition`, so a childless row
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

## 9. The holder-C window — `chat.send` ack → `runReplyAgent` (2026-09-25)

**What it is.** The span between `chat.send` answering `{status: "started"}` and the reply pipeline
PLACING the prompt. In it `get-reply.ts` runs media understanding (`applyMediaUnderstandingIfNeeded`),
link understanding (`applyLinkUnderstandingIfNeeded`) and the prepared-reply setup; then
`get-reply-run.ts` calls `runReplyAgent`, and only inside that does `createReplyOperation`
(`agent-runner.ts`) exist — the steer, the backlog and the reply operation all happen there. Until
then the only thing holding the prompt is its chat abort controller (`prompt-queue.md` §4, holder C).

**Measured once, and never on its own.** §1's worked example is the only reading on record:
`res chat.send` at 02:54:35.976 → `compaction gate preflight` at 02:54:51.097, **15.1 s** (n=1, a
congested gateway, 2026-08-12). That span CONTAINS this window plus `runReplyAgent`'s own prelude up
to the preflight gate, so it bounds this window from above for one turn; it does not measure it. Until
2026-10-29 no `turn.span` row covered the window: `[turn-span]` stages were emitted only from
`attempt.ts` and `pi-tools.ts` (§7.4), after the operation already exists, and a `hook.span` row
times one plugin handler, not the span around it. Since `6b6aea7c80cd` the `pre:*` rows of §9.2
cover it.

**What changed on 2026-09-25 is the display, not the seconds.** Before it, a `sessions.list` row built
inside the window listed the session's other prompts and not this one, so the UI could not tell
"about to run" from LOST and kept page-liveness vetoes for it (`tinker-ui/src/prompt-state.ts`
`gatewayHolderFacts`). `44f2ae2d1dc` marks the span on the gateway: `session-utils.ts`
`trackAcceptedChatSend`, set right after the ack and released on placement (`onAgentRunStart`,
`onPromptDisposition`), on abort, and when the dispatch settles or throws; `deriveSessionPendingPrompts`
reports a marked key PREPARING. The seconds are the same; they now read as "preparing context"
instead of as a gap.

**The one instrument.** A `turn.span` pair at `chat.send`'s ack and at `createReplyOperation`, keyed by
the prompt key (the `chat.send` idempotencyKey, PQ-1) and emitted unconditionally like the runner's
`[turn-span]` lines, would turn the upper bound into a distribution.
~~Until it exists, quote no p50 for this window. **RUN: unmeasured.**~~ Built on 2026-10-29 as the
`pre:*` rows (§9.2), which also time every step between the two marks and the stretch from the reply
operation to the run's first runner span. **RUN (2026-10-29):** the window has a first distribution
(§9.2); its per-step split waits for a gateway running the build.

### 9.1 What held the window on 2026-10-15, and the step markers (bug-log `stale-plugin-registry-rebuild-storm`, `pre-reply-stall-invisible`)

**Measured.** Tabs sat in "preparing context" for minutes. A 20 s `diagnostic.cpuProfile` of the gateway (pid 327459, 13:47) put 43.6% of the main thread under `runEmbeddedAttempt`, 38.9% of it in `loadPluginRegistrySnapshot` → `loadInstalledPluginIndex` → `buildInstalledPluginIndex`: every embedded run (chat turns, `jev-explain`, title suggestions, Fractals, subagents) rebuilt the plugin index from ~146 manifests while building its tools (`createPdfTool` → provider-auth checks). The persisted registry (`~/.openclaw/plugins/installs.json`) dated from 2026-09-23 and was `stale` (`policy-changed, source-changed, stale-manifest, stale-package`), and the derived fallback was cached for 1 s, so the rebuild ran on nearly every run. Event loop: ELU 1.0, p99 4.6-5.7 s (24 s at 12:58). After `openclaw plugins registry --refresh` (13:50) the same profile no longer showed the rebuild, and the loop read p99 234 ms, ELU 0.38, with 4 runs active.

**Changed.** The gateway refreshes a stale persisted registry once at start (`plugin-registry-startup-refresh.ts`, the CLI's own call, and logs why). The derived fallback is cached 60 s, keyed as before by policy hash, roots and load paths. A fallback logs its reason once per process. Jev calls fail after 1 s (`JEV_MAX_WAIT_MS`, the owner's rule), and `jev-explain` runs no longer take `sessions`-lane slots from chat turns.

**The step markers.** Inside this window, `getReplyFromConfig` now records the step a prompt is in (`config`, `workspace`, `media-understanding`, `link-understanding`, `session-init`, `reset-model`, `directives`, `inline-actions`, `before-agent-reply-hooks`, `sandbox-media`, `prepare-run`), and the stuck-session line reads `phase=pre:<step>:<seconds>s` until the reply operation exists, where it used to read `phase=none`. This names the step a stalled prompt is in. It was not the `turn.span` pair above, so on 2026-10-15 the window still had no distribution (~~**RUN: still unmeasured as a p50.**~~). **RUN (2026-10-29):** each step now also ends as a `pre:<step>` row with its duration, and §9.2 has the window's first p50.

### 9.2 The `pre:*` rows: the instrument for the ack-to-runner window (2026-10-29, `6b6aea7c80cd`)

**WANT.** One duration per step for the seconds between `chat.send`'s ack and the run's first runner span, keyed per prompt and written unconditionally, so the fix for this window is chosen from data (§7.10: no fix before the parts report). Measurement only; no reply behaviour changes.

**The labels.** `src/infra/events/catalog.ts` leaves the `turn.span` label set to this optic. Each step ends as one `[turn-span] runId=… stage=pre:… ms=…` journal line and one `turn.span` row (`runId`, `sessionKey`, `label`, `durMs`), the runner's own shape, so one parser reads both.

| label           | from                                                                       | to                                                                                                                 |
| --------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pre:ack`       | `chat.send`'s ack (`notePreReplyAck`, right after `trackAcceptedChatSend`) | the prompt's first step                                                                                            |
| `pre:<step>`    | one `getReplyFromConfig` step                                              | the next step; the last one ends at the reply operation (`notePreReplyPlaced`, right after `createReplyOperation`) |
| `pre:placement` | the reply operation                                                        | the start of the run's first runner span: its first `turn-stage` event (`sandbox` today) minus that span's own ms  |

The steps, in order: `config`, `workspace`, `media-understanding`, `link-understanding`, `session-init`, `reset-model`, `directives`, `inline-actions`, `before-agent-reply-hooks`, `sandbox-media`, `prepare-run`; the fast directive path goes from `reset-model` straight to `prepare-run`. Each boundary is one clock read that ends one span and starts the next, so the rows of one run id add up to the whole window, with no gap and no overlap.

**Invariants.** Rows are keyed by the prompt's run id (for `chat.send` its idempotencyKey, which the runner then uses as its run id) and its session key. A prompt with no run id writes no row; its step still shows in the stuck-session line (§9.1). Nothing closes at the reply's end. A prompt that ends with no reply operation (steered, backlogged, answered by a command), a run that emits no runner span (a CLI-backend run, a failure before the attempt), an evicted entry and a clock that stepped back each log one `[pre-reply-span] DROPPED runId=… stage=… reason=…` line (`no-reply-operation`, `no-runner-span`, `evicted`, `unknown-duration`) in place of a row, so a missing row is never silent (#12). Every entry point catches its own errors, so nothing throws into the reply path. The prompt map holds at most 256 entries (`MAX_TRACKED_PROMPTS`), a ceiling against a leak with the same value and reason as `turn-span.ts` `MAX_TRACKED_RUNS`, never a working bound (#19).

**Rejected.** Closing the last step in `clearPreReplyStage`: it runs after the whole reply, model run included, so that step would carry the model's seconds. Keying by session alone: two prompts of one session would close each other's steps, and a wrong row is worse than a missing one. Calling `recordTurnSpan` (`turn-events.ts`): it reads the session from the run context, which the run registers only after placement, so `emitPreSpan` writes the same record field for field and `pre-reply-stage.spans.test.ts` holds it to the catalog (an optional session key on `recordTurnSpan`, with these rows routed through it, is the open follow-up). The UI's turn-stage stream: it has no run context before placement.

**What the rows cannot say.** A stalled event loop makes whichever step is running look longer, so the rows do not separate a step's own work from loop wait; that needs a `gw.health.sample` or ELU overlap per span. Mechanism: code, because `stage()` in `get-reply.ts` is the structural producer and every prompt should get the same rows.

**RUN (2026-10-29):** in source, with no live row yet; a gateway writes them after its next full rebuild. The whole window already has a first distribution, from before the split: the 2026-10-29 analysis run joined the first `ui.outbox.state` `acked` row of each run id (client clock) to that run's first `sandbox` `turn.span` (server clock; the span lasts 0-1 ms), events DB rows 2026-09-25 → 2026-10-29.

| window             | n   | p10      | p50      | p90       | max        |
| ------------------ | --- | -------- | -------- | --------- | ---------- |
| all                | 663 | 1,017 ms | 2,377 ms | 11,065 ms | 905,764 ms |
| 2026-10-27 → 10-29 | 100 | —        | 2,610 ms | 17,228 ms | —          |

That is 27% (per-turn median) to 41% (sum-weighted) of pre-model time, counted from the queued time to the end of the last runner span. Only 663 of 2,035 acked prompts had runner spans; the other two thirds could not be measured, and the `pre:*` rows reach them up to placement. 15 gaps came out negative (client clock skew). Session-lane `lane.wait` rows already explain 11.9% of the summed gap. Splitting the 644 non-negative gaps that had a health sample into a slow and a fast half, the loop's p99 maximum averaged 3,411 ms in the slow half and 354 ms in the fast one. A first per-label reading under 20 runs is thin, and says so (§7.6, §7.7).

## 10. The budget on 2026-10-29, and what the perf run cut

**Derived.** A 2026-10-29 analysis run on the 4-core reference Pi measured each stage from the gateway logs of 10-28 and 10-29 (turn-span lines 10-28 00:56 → 10-29 06:15, 29.3 h), the events DB, the amygdala store and its hook spool, and isolated A/B runs of the built code. Every number below is the run's re-measured figure; where it disagreed with a finder's first estimate, the re-measurement stands. A saving stays **expected** until a gateway running the build has been read with the instrument named beside it. Record that reading here as a dated line, and never turn an expected figure into a measured one by editing it.

| stage, and where it sits                                           | measured cost                                                                                                                                                        | n, source                                                        |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `chat.send` ack → first runner span (§9.2)                         | p50 2,377 ms · p90 11,065 ms; the last three days p50 2,610 ms · p90 17,228 ms                                                                                       | 663 and 100 runs, events DB join                                 |
| prefrontal `before_prompt_build`, where the J13 semantic lane runs | 518 of 576 under 100 ms; 31 at 9.5 s or more (360 s together), 27 of them ending on the lane's 10 s embed timeout                                                    | 576 hook spans over 1.22 days                                    |
| `wrap-openclaw-tools`, inside `tools-build`                        | p50 2,472 ms · p90 3,099 ms · minimum 1,736 ms; 94% of `tools-build` (p50 2,615 ms)                                                                                  | 289 embedded runs                                                |
| claude worker, prompt → first stream line                          | p50 3,898 ms on a spawned worker, 1,290 ms on a warm one                                                                                                             | 31 and 27 Tinker turns                                           |
| amygdala stop seam, at the turn's end, on the gateway main thread  | about 1.84 s warm per stop (1.55 s with no unjudged passes, 2.15 s with); the first query of a turn 2.3-6.7 s cold; 56 of 172 stop hooks at the 5 s fail-open        | the live store (273k decisions); the hook spool, 10-28 and 10-29 |
| a worker's plan call through `openclaw gateway call`               | 7.9-9.2 s wall, 10.8-11.9 CPU-s and about 500 MB per call; about 23 plan calls a day                                                                                 | per-call runs; log counts                                        |
| an RPC-only CLI start (`nodes`, `cron`, `message`, …)              | the import-time context warmup adds 11.1 s wall, 17.1 CPU-s and 122 MB to `cron list`, and 14.3 s, 15.7 CPU-s and 125 MB to `nodes status`; 168 such starts on 10-28 | A/B on the built CLI, n=3 and n=2                                |

**What the run cut.** Each item names its commit, the expected saving and the instrument that will confirm it.

1. **The stop seam's full-history scans (`c7c32827ebe2`).** `flaggedDecisionsForTurn`, `unjudgedPassesForTurn` and `turnStartTs` filter on `situations.turn_id`, but no index led with it and `decisions` had none on `situation_id`, so each query walked every stored decision through `d_ts`, synchronously, before the stop hook got its answer. The store now builds `s_turn ON situations(turn_id, ts)` and `d_sit ON decisions(situation_id)` in place on open. The queries return the same rows in the same order, in under 1 ms each on a copy of the live key columns, and `turnStartTs` reads `MIN(ts)` from the index alone. The tab feed's query says `CROSS JOIN`, because `d_sit` would otherwise re-plan it from 16-30 ms to 285-289 ms (tinker-ui.md §5.8AH owns the feed). **Expected:** about 1,200 s a day (870-1,310) less turn-end wait and gateway main-thread block at the 10-28 rate of 669 stops, and fewer stop hooks failing open at 5 s; some of the 10-28 timeouts came from that day's embedding overload, so not all of them go. **Cost:** the first open of an existing store builds both indexes once, on the gateway thread: 0.64 s on the copy, unmeasured on the live 4.1 GB file. **Read it with:** the stop latency in the hook spool, and the loop p99 in `gw.health.sample`.
2. **The J13 semantic lane's 10 s waits (`2e85277ed952`).** With the opt-in switch on (`PREFRONTAL_SEMANTIC_MATCH_ENABLED`), each weak-lexical turn sent the prompt and every recipe text (up to 123 texts) as one foreground batch, under the client's default 10 s gateway timeout. A 123-text batch took 140 s on the Pi, so every call timed out on the turn, and nothing cancelled the batch: the gateway's own durations for those calls ran 148-1,550 s, and the one-slot embedder stayed busy for every other caller. Now the gateway keeps the recipe vectors, filled once through the background lane, and answers `warming` at once while they fill; it embeds only the prompt, within a budget of at most 1 s (2 × the endpoint's live query p95), and the client gives up at that budget plus 1 s. A words-only machine answers at once, and a trial retires a lane that rescues nothing. **Expected:** a weak-lexical turn waits at most about 2 s where it waited 10 s, so the measured 221 s a day (22.1 timeouts a day) falls to at most about 45 s, and to nothing where the lane is off or retired. **Read it with:** the prefrontal hook spans and the `[semantic-matcher] lane … -> …` state lines. The lane's design, its budget formula and the open decision to re-enable it belong to embedder-fit.md.
3. **Plugin snapshot memos that expired after 1 s (`51cdd9edeb49`, `1790104d7227`).** Inside the gateway the web-provider snapshot and the capability plugin-id cache now stay valid until the active plugin registry changes or `bumpPluginSnapshotGeneration()` runs. Embedded runs came a median 108 s apart and never under 1 s, so every run used to miss. `resolveBundledPluginsDir` is memoized per process (an idle gateway spent 22-323 ms of every 30 s in it, across four CPU profiles). **Expected:** about 0.3 s off `wrap-openclaw-tools` per embedded run (an isolated A/B of `createOpenClawTools`, 7 warm calls: mean 2,388 ms with the 1 s TTL, 2,069 ms with the cache warm). That is about 70 s a day of main-thread time at 237 runs a day, and about 38 s a day of wait in the 128 chat and cron runs among them. A single CPU profile had pointed to 1.7-2 s; the A/B did not bear that out. Most of the 2.4 s is still there, outside the TTL: in a profile of the A/B harness, the auth-profile overlay rebuilding the plugin registry snapshot took 540-660 ms of CPU per call, capability model-config resolution for the pdf, image and video tools about 450 ms, and realpath checks on the persisted bundled-plugin root about 340 ms. That is the next target, and only a profile should name its fix. **Read it with:** the daily p50 of the `wrap-openclaw-tools` `turn.span`. The validity rule belongs to topology.md.
4. **The lean plan-call client, dormant (`d074a3e637a5`).** A worker's plan calls try `bin/tc-rpc.mjs` before the CLI line (tool-loop.md). The bridge exports the client only when the worker's environment carries the gateway URL and token, and on the reference install neither reaches the worker, so every plan call still takes the CLI line. **Measured** against the live gateway: `health` through the client 0.34 s wall, 0.11 CPU-s and 54 MB; through the CLI 7.87 s, 10.71 CPU-s and 496 MB. **Expected once armed:** about 7.5 s per plan call, about 170 s a day at 23 plan calls. **Today:** nothing.
5. **The CLI context warmup for commands that never read it (`890fe8b527a3`).** `approvals`, `channels`, `cron`, `devices`, `message`, `node`, `nodes`, `qr` and `system` no longer start the import-time context-window warmup; an import walk from each one's registrar reaches no context-token reader. **Expected:** about 12.5 s wall and 16.5 CPU-s per start, about 2,100 s of background wall time and 2,770 CPU-s a day at the 10-28 rate, most of it a 15-minute timer that runs `nodes`. A turn waits on this only when its agent runs one of these commands, and that count is not measured. **Read it with:** the wall time of `openclaw nodes status` and `openclaw cron list`.

Not in this budget, though the same run changed them: the one-shot worker CPU weight (lifecycles.md L2; the chat latency it buys is unmeasured) and the jarvis MCP bridge's start path (tool-loop.md; whether a worker's first turn waits on the MCP connect is unmeasured).

**Refuted on the same data.** Moving `TOOLS.md` below the prompt-cache boundary to keep workers warm: the worker key changed on 6 of 16 close turn pairs (under 15 min apart) with a `TOOLS.md` edit and on 6 of 15 without one, 31 Tinker pairs in all, so `TOOLS.md` edits do not drive the key churn of §7.5. A spawned worker's first stream line still costs about 2.6 s more than a warm one's, and the churn source is unknown. The next step is a per-turn hash of each prefix slab (each context file, each plugin's prepended block, skills, tool rules) logged beside the worker key.

**Already realized before the run.** The amygdala reviewer's one-shot Claude workers, about 470 a day at about 18 CPU-s and 0.6 GB each, fell to about 14 a day when its ladder moved to Grok on 2026-10-28 at 22:45Z (a config change). Its embedded-runner prelude stays: p50 874 ms a run, about 3,300 s a day of gateway time at about 1,470 runs a day. Readings across that date compare different loads.

**RUN (2026-10-29):** all five cuts are in source, and none has been read on a gateway running them. The `pre:*` rows (§9.2) are the instrument for the ack-to-runner window. The savings above are expected, and none is a measurement yet.
