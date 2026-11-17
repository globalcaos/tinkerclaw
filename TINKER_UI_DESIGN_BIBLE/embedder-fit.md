---
file: embedder-fit.md
purpose: The per-machine embedding decision, its thresholds and the runtime governor. Whether the vector half of memory search runs on this machine, with which model and within which bounds, decided from measurements taken on the machine, and the one queue every core and fork embedding call goes through
audience: AI (Claude Code, Jarvis) + maintainer. Read before touching memorySearch.provider or model, an embedding provider, the memory index's batching or deadlines, or any code that embeds text.
status: live on the reference host since 2026-10-29 (develop 7749b4053bf6); the 2026-10-30 governor review fixes come in the same change as this edit
last_verified: 2026-10-30
last_verified_commit: b21a6a91d34b
single_owner: yes — the per-machine embedding decision (decideEmbedderFit, EMBEDDER_LADDER, the record), every threshold that bounds embedding work (objective, formula, live value, what moves it) and the governor (src/fork/embedder-governor.ts) live here. Config keys and their readers belong to config-shape.md, the index's storage and the vector-store contract to memory-layout.md, failure propagation to failures.md, duplicate counts to canonical-derivations.md, and the central-mechanism claim to architecture.md.
see_also: memory-layout.md (the index and the vector-store contract), config-shape.md (agents.defaults.memorySearch, traps T12-T14), canonical-derivations.md (decideEmbedderFit = 1, the declared twins), architecture.md (the embedder rate + latency control row), failures.md (the embedding backlog loop), turn-latency.md (per-turn embedding waits), design-principles.md#19, design-principles.md#25
verify:
  # Pointers, not programs (FOUNDATION.md, Three different jobs, three different homes). The
  # checks live in scripts/bible/embedder-fit-single-owner.mjs, one per rule in Don't regress.
  - name: the embedding decision keeps one owner, the 2026-10-28 loop's code paths keep their fixed shape, and the governor keeps its 2026-10-30 review fixes (checks a-m)
    cmd: cd "${BIBLE_DIR:-$HOME/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE}/.." && node scripts/bible/embedder-fit-single-owner.mjs
  - name: each of those checks can go red — every mutant of the code it guards fails it
    cmd: cd "${BIBLE_DIR:-$HOME/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE}/.." && node scripts/bible/embedder-fit-single-owner.mjs --self-test
---

# Embedder fit — which embedding model runs here, and the one governor

Embeddings exist to put the right memory in front of an agent when its question and the note
share few words. Without them the agent spends another model step searching again, or goes
without. This optic owns three things: whether that is worth doing on a given machine and with
which model, the thresholds behind that decision, and the governor every embedding call then runs
through.

## What this file is FOR, how it was DERIVED, and what would CHANGE it

**FOR.** Deciding, per machine and from measurements taken on it, whether the vector half of
memory search runs at all, with which model and within which bounds, and keeping every embedding
call on that machine inside those bounds. Word search answers either way.

**DERIVED.** From the reference host on 2026-10-29: a Raspberry Pi 5 (4 cores, 16 GB) running
Ollama 0.40.11 in a container capped at 2 CPUs and 3 GiB. The evidence is a paired retrieval eval
over one private corpus of 100 files, with 40 queries frozen before any model ran (30 English, 10
Spanish or Catalan); the throughput, latency, cold load and RSS of seven embedding models; 48 h of
Ollama logs; and the 2026-10-28 backlog loop. Every number below says where it came from:
measured, derived from measured inputs, a labelled prior, or an estimate.

**WHAT WOULD CHANGE IT.** A new machine, a model that beats the top preferred model on the eval
with p < 0.05, real memory searches by agents, a measured contention factor, or a different
language mix. The values below are the reference host's. They show the formulas at work; they are
not working values. Every install derives its own, and derives them again when its machine
changes.

## WANT

1. **One measured decision per machine.** `decideEmbedderFit` maps measurements to one outcome:
   off (word search, still indexing), memory with the small model, memory with the larger model,
   or memory plus sessions. It is made at install (`scripts/setup.sh` step 4d), checked again by
   `openclaw doctor` (`doctor --fix` re-measures) and at gateway start, and kept in the git-ignored
   record `<stateDir>/memory/embedder-fit.json`. It is never written into `openclaw.json`.
2. **Every consumer through one governor.** Each embedding endpoint (provider plus base URL) has
   one queue, shared by every consumer on the core and fork paths, with bounds derived from the
   record (`src/fork/embedder-governor.ts`).
3. **Remote only with consent.** A keyed remote provider is used only after an explicit, recorded
   yes that says memory text leaves the machine (#17). `auto` never picks one by itself.
4. **Explicit config untouched.** An explicit `memorySearch.provider` comes back as set, with its
   model. The fit proposes; the governor protects a pin and never makes it dormant. Under `auto`
   the fit's model replaces a configured `memorySearch.model`, because `auto` asks for the fit's
   choice.
5. **The fit never adds sessions.** Session transcripts are embedded only when the config lists
   them and keep-up passes with their ingest.
6. **Word search always answers.** FTS indexing and keyword search never wait on the embedder.
   Vectors run only while they repay what they cost.

## RUN (2026-10-30)

- **Code: live.** Deployed on the reference host 2026-10-29 18:02 (develop `7749b4053bf6`). The
  fixes from the 2026-10-30 review of the governor come in the same change as this edit: the slot
  held until a call settles, queued budgets that expire, caller aborts kept off the breaker, the
  mode per consumer and the state per model, fits used only at their own endpoint, a URL for every
  HTTP provider, and the abort signal forwarded by every adapter.
- **On the reference host after the deploy:** `openclaw embedder status` read
  `granite-embedding:30m for memory files, dormant until real searches reach 33.9/day`. In the
  12 h after the 2026-10-29 21:06 restart Ollama served 90 embedding requests, none through
  TinkerClaw's embedding path: 87 came from a research pilot's own script, which sends
  `mxbai-embed-large` straight to `/api/embed` (its embedding cache was written at 01:57:45, the
  end of its second burst), and 3 from nightly crons that probed the embedder by hand, which their
  prompt no longer allows (measured: `docker logs ollama`, the pilot's files, the cron prompts).
- **Observed before the code:** after the 2026-10-29 00:00 UTC restart, with sessions removed from
  the config, Ollama served 0 `/api/embeddings` and 4 `/api/embed` requests in 2.3 h. The index
  still holds the 2026-10-28 state; see _The reindex hazard_.
- **Gate:** `scripts/bible/embedder-fit-single-owner.mjs`, checks (a) to (m); `--self-test` proves
  each one goes red under every mutant of the code it guards.

## Where the decision lives, and the one seam

- **One owner (#18).** `src/fork/embedder-fit.ts` holds the ladder of measured models
  (`EMBEDDER_LADDER`, the only home of embedding model names on the fork paths), today's constants
  kept as ceilings and labelled priors (`EMBED_CEILINGS`), every threshold formula,
  `decideEmbedderFit`, the record IO, the cheap fingerprint and `applyEmbedderFit`. It is pure
  functions plus synchronous record IO, with no network, because the plugin SDK bundles the
  resolver that imports it.
- **The seam.** `resolveMemorySearchConfig` (`src/agents/memory-search.ts`) returns
  `applyEmbedderFit(resolved)`. Only an unset or `auto` provider is replaced: with the record's
  provider and model when the record was measured on this machine (cheap fingerprint unchanged)
  and its decision is not off, and otherwise with `none` and an empty model. An explicit provider
  comes back as set. It never throws; on an error it returns its input. One edit in an
  upstream-shaped file (#8) routes the core index, memory-core (through
  `openclaw/plugin-sdk/memory-core-host-engine-foundation`), the prefrontal RPC, skill search, the
  LIMBIC upgrade and `/v1/embeddings`.
- **`none` means the word index only.** The core factory answers it before it builds any client,
  with the reason `memorySearch.provider is none: the word index answers, no embedding calls`
  (`src/memory/embeddings.ts`). memory-core answers it with no adapter and no fallback, with the
  reason `memorySearch.provider is none: word index only`
  (`extensions/memory-core/src/memory/embeddings.ts`). Doctor returns early for it; the fit's own
  doctor note explains the choice. A consumer that builds its own provider asks
  `isEmbeddingOff(memorySearch)` first and embeds nothing when it is true.
- **The record and its neighbours.** `embedderFitPaths()` names three files under
  `<stateDir>/memory/`, none of them config. `embedder-fit.json` is the record: written atomically
  (tmp file, fsync, rename) with mode 0600, keeping the newest 20 fits as history, and re-read only
  when its inode, size or mtime changes (one `statSync` per call). `embedder-governor.json` is the
  governor's snapshot. `embedder-fit.lock` is held while a fit measures.

## The time account

Every threshold below comes from one daily account (#19, #20, #25):

- saving per day = real searches per day × recall gain over word search × the cost of one miss;
- cost per day = the query embed on the caller's path + c × background embedder seconds per day,
  with c the seconds of live work lost per second of background embedding, read from the rise in
  CPU pressure during batches (Linux only; where it is not measured, c = 1, the worst case).

Vectors run only while the saving exceeds the cost and indexing drains new memory faster than it
arrives. Otherwise the install runs word search, which keeps indexing.

## The thresholds

One row per threshold. The value column is the reference host on 2026-10-29: _measured_ was read
on that host, _derived_ was computed from measured inputs, and priors and estimates say so. Today's
constants survive only as ceilings (`EMBED_CEILINGS`): a derived bound may come out lower, never
higher. Symbols: θ is throughput in tokens/s, I the tokens per day to embed, B the burst factor
(peak day over mean day), `t_miss` the cost of one missed recall, L the non-English share of typed
prompts, c the contention factor.

| Threshold                                                 | Objective                                                                                                                                                 | Formula and break-even                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Reference host, 2026-10-29                                                                                                                                                                                                                                                                                                                                                             | Changes when                                                                                                                                                             |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. Keep-up K** (`keepUpRatio`)                          | Background embedding drains new memory faster than it arrives, using idle CPU only. Below break-even the backlog grows without end: the 2026-10-28 class. | `K = θ × D × 86,400 / I`, with D the idle share and I counting chunk overlap (× 1.25 for 400-token chunks with 80 overlap). Break-even `K = 1`. The fit's gate is `K(D = 1) ≥ B`, and it records `B / K`, the least idle share the governor must give.                                                                                                                                                                                                                                                                                           | I = 332,743 tokens/day: 266,194 memory tokens/day from 14 days of file mtimes, an upper bound, × 1.25 (measured). B = 6.12 (measured). 30m at 338.2 tokens/s: K 87.8, D ≥ 0.07, first backlog 10.4 h. 278m at 167.1: K 43.4, D ≥ 0.14, 21.1 h. mxbai at 95.6: K 24.8, D ≥ 0.25, 36.8 h (derived). D itself: not measured.                                                              | A new machine or CPU cap (θ), a model change, more writing or bulk rewrites (I, B), a busier host (D), sessions added (I = 778k tokens/day, so 30m would need D ≥ 0.16). |
| **2. Requests in flight** (`fitBudgetFor`)                | Never queue more work at an embedder than it can serve at once. The queue lives in the governor, where it can be ordered, timed and aborted.              | 1 per machine-local endpoint; 2 only when the measured gain of 2 in flight over 1 beats 2σ of per-batch θ, measured at that same endpoint (a record taken elsewhere counts as none, `fitEndpointKeyFor`); ceiling 4 (`EMBED_CEILINGS.indexConcurrency`), which is what a remote endpoint gets. One queue per endpoint, shared by every consumer.                                                                                                                                                                                                 | Ollama `n_slots` = 1 (runner log, measured). On 2026-10-28 about 20 requests were in flight: 4 files × about 5 per batch (code and logs). Now 1.                                                                                                                                                                                                                                       | `OLLAMA_NUM_PARALLEL`, a GPU endpoint with several slots, another server.                                                                                                |
| **3. Query budget** (`queryBreakEvenMs`, `recallGainFor`) | A query embed the caller waits for costs less than the time the vector half saves on that query. Past that point the search answers from words.           | `B_q = ΔR × t_miss`, with `ΔR = (1 − L) × (R@5en − 0.7) + L × (R@5nonEn − 0.4)`: the model's hybrid recall gain over word search on the reference eval, weighted by the language mix. Gate `t_q95 ≤ B_q`; the vector-scan time is measured at runtime, not in the gate. Per-query deadline `min(B_q, 60 s)`.                                                                                                                                                                                                                                     | `t_miss` = 21.57 s, the median gap from a tool result to the next assistant message (n = 81, measured). L = 0.022 (29 of 1,331 typed prompts, a stopword heuristic, measured). 30m: `B_q` 5.0 s against a p95 of 1.67 s, passes. 278m: 6.6 s against 0.54 s, passes. mxbai: 5.8 s against 8.61 s under load, fails (derived). On the eval's own mix (L = 0.25): 4.85, 7.55 and 5.93 s. | A faster agent model (`t_miss`), another model or language mix (ΔR), host load (`t_q95`).                                                                                |
| **4. Background batch** (`batchPlan`)                     | A batch fits inside its own deadline and never holds a one-slot embedder longer than a foreground query can wait.                                         | `batchTokens = clamp(θ × (B_q − t_q95), one chunk, 8,000)`, counted in tokens. Without a fit record for the model: the 8,000-token ceiling.                                                                                                                                                                                                                                                                                                                                                                                                      | 30m: (5.0 − 1.67 s) × 338 ≈ 1,130 tokens, 2 to 3 chunks, about 3.3 s per batch (derived). mxbai: no slack, so one chunk. Before: up to 8,000 bytes per batch × 4 files under a fixed 120 s race.                                                                                                                                                                                       | θ, `B_q`, `t_q95`.                                                                                                                                                       |
| **5. Request deadline** (`requestDeadlineMs`)             | Give up on a request exactly when it can no longer be healthy, then abort it so it stops holding the embedder.                                            | `min(ceiling, cold load + overhead + tokens / θ_low95 × 1000 × dispersion)`. Dispersion: the fit's, else the live one after 20 calls, else the prior 2. The cold term applies only when the last call is older than the keep-alive. Ceilings: 600 s per batch, 60 s per query; a remote endpoint keeps a 120 s batch prior until 20 calls. The clock starts at dispatch, after the queue. An expiry always aborts and answers the caller; the slot stays held until the provider settles, at most one more deadline. The governor never retries. | 30m, a 1,130-token batch: about 6.7 s resident at dispersion 2, plus up to 7.2 s of cold load (derived; the cold load is the bench re-measure). Before: a fixed 120 s race with no abort, served latencies up to 1,560 s, 1,098 requests over 60 s in 47 h (measured).                                                                                                                 | θ, dispersion, model residency, the machine.                                                                                                                             |
| **6. Demand break-even** (`demandBreakEvenPerDay`)        | Embed in the background only while enough real searches use vectors to repay what embedding costs. With no searches, every indexing second is waste.      | `Q* = c × (C_idx + C_pend / H) / (ΔR × t_miss − t_q50)` searches/day, with `C_idx = I / θ`, `C_pend` = pending tokens / θ and H = 30 days (a labelled prior: how long a decision stands). Infinite when one search saves no more than its query embed costs. Dormant while demand Q is under `Q*` and the backlog takes longer than one fit.                                                                                                                                                                                                     | Q = 0, measured: agents here have no memory search tool, and every memory search in 48 h came from the bible probe. 30m: `Q*` ≈ 468/day at c = 1, 47 at c = 0.1. 278m: 613 and 61 (derived, eval mix). Verdict: dormant, 0 embedding requests.                                                                                                                                         | An agent gets a memory search tool or a real RPC caller appears; c is measured; quality, language mix or `t_miss` move.                                                  |
| **7. Step-up** (`stepUpBreakEvenPerDay`, `assessStepUp`)  | Pay for a bigger model only when its extra recall buys more time than its extra cost. Where that extra cost is negligible, the more precise model wins.   | `Q*_step = c × ΔC_day / (ΔΔR × t_miss − Δt_q50)`, with `ΔC_day` the dearer model's extra embedder seconds per day, backlog included. Step up when the demand reference (measured Q, else the cheaper model's own `Q*`) is at least `Q*_step`, or when `ΔC_day` is at most one fit's wall time. The second clause exists because the first is scale-free in θ: on its own it would never step up on a GPU.                                                                                                                                        | 278m over 30m: `ΔC_day` 2,287 s/day. ΔΔR 0.125 on the eval mix (5 vs 0 discordant queries, p 0.0625, not significant): `Q*_step` 880/day at c = 1, 88 at c = 0.1. Weighted to L = 0.022: 1,574 and 157. At L = 1: 359 and 36 (derived). Verdict: 30m. A GPU at 20,000 and 12,000 tokens/s: `ΔC_day` about 25 s, within one fit, so 278m.                                               | The machine's cost of the dearer model, measured c, demand, language mix, a better quality estimate.                                                                     |
| **8. RAM** (`ramFits`, `memoryFloorBytes`)                | The resident model never pushes the host into swap.                                                                                                       | Fits iff RSS + other resident models ≤ `min(MemAvailable − floor, endpoint cap)`, with floor = `max(1.5 GiB, 10% of RAM)`. A `keep_alive` longer than Ollama's 5-minute default is sent only when it fits. The fit counts other resident models as 0 today.                                                                                                                                                                                                                                                                                      | MemAvailable 5.86 GB (one read); floor 1.72 GB; about 4.1 GB spare, so the container's 3 GiB cap binds. 30m 92 MB, 278m 693 MB, mxbai 690 MB: all fit. Swap 6.0 of 6.0 GB in use (measured).                                                                                                                                                                                           | RAM size, other resident models, gateway growth, the container cap.                                                                                                      |
| **9. Breaker** (`breakerThreshold`, `breakerCooldownMs`)  | Stop paying for an endpoint that cannot answer, while a false trip stays rarer than once a day.                                                           | Open after F consecutive failures, `F = clamp(⌈ln(1/N) / ln p⌉, 2, 5)`, with p the healthy failure rate by the rule of three over clean calls (the fit's batches, else live calls) and N the calls per day. Cool-down `min(6 h, 2 × batch deadline × 2^(trips − 1))`. Half-open sends one single-input call. Machine-local endpoints only; remote providers keep today's retry policy.                                                                                                                                                           | p = 3/16 (16 clean fit batches) and N about 309/day (332,743 / 1,076) give F = 4; the cool-down starts near 13 s and doubles (derived). Against 2026-10-28: 90 timed-out batches in two hours, and 240 HTTP 500 in 47 h (measured).                                                                                                                                                    | Endpoint reliability, the call rate, the batch deadline.                                                                                                                 |
| **10. Idle gate** (`idleGateOpen`)                        | Background embedding uses idle CPU only, so live turns are not starved.                                                                                   | Open iff `load1 − s × u + s ≤ logical cores`, with s the cores the embedder keeps busy (measured by the fit; 1 when unmeasured, a labelled assumption) and u the governor's own duty over the last 60 s. Closed while a fit lock is under 10 min old. While it is closed, background calls to a local endpoint are refused as busy; foreground calls are never gated.                                                                                                                                                                            | 4 cores. load1 was 4.04 at one read (closed), 0.93 at another (open), and 2.6 to 12 during the bench; the container was throttled in 87% of its CFS periods (measured).                                                                                                                                                                                                                | Core count, the embedder's share (a GPU makes s near 0), host load.                                                                                                      |
| **11. Lane trial** (`trialInvocations`)                   | The opt-in semantic recipe lane gets a bounded trial and retires itself when it rescues nothing worth its per-turn cost (#25).                            | Break-even rescue rate `P* = mean_q / t_miss`; the trial runs `n = ⌈3 / P*⌉ = ⌈3 × t_miss / mean_q⌉` invocations (rule of three) and retires on 0 recoveries. It re-arms when the model or the recipe catalog changes. Per-turn wait at most `min(1,000 ms, 2 × measured p95)`.                                                                                                                                                                                                                                                                  | Before: 26 weak-lexical invocations in 48 h, 0 usable results, 342 s of turn wait (measured). With the catalog cache, `mean_q` is about 0.2 s, so n is about 324 invocations: about 25 days at 13 a day (estimate).                                                                                                                                                                    | Model latency, catalog changes, `t_miss`.                                                                                                                                |
| **12. Re-measure** (`fingerprintDiff`, `inventoryDiff`)   | Re-measure by itself on a new machine or when an embedder appears, and cost nothing while nothing changes.                                                | A background fit when there is no record, or when the cheap fingerprint (arch, platform, CPU model, logical cores, cgroup CPU quota, RAM in whole GiB, GPU device nodes) or the installed ladder models (by digest) differ from it. θ drift (the live p50 over at least 20 calls outside the fit's 95% band) or a step-down asks for one too. At most one automatic re-measure per 24 h. No reachable endpoint: re-probe from 10 min, doubling to 24 h.                                                                                          | arm64, 4 × Cortex-A76, 16 GB, no GPU; Ollama with 7 embedding models, 6 of them pulled by the bench. One fit takes about 2 to 3 min of the 2-CPU share (estimate).                                                                                                                                                                                                                     | A host move, a GPU added, models pulled or removed, the container cap changed.                                                                                           |

## Choice logic

`decideEmbedderFit` is pure and deterministic: the same measurements give the same decision.

1. **Candidates.** The ladder's preferred models, `granite-embedding:30m` and
   `granite-embedding:278m`, are the two that no measured model dominates. Its fallbacks,
   `nomic-embed-text` and `mxbai-embed-large`, are used only when already installed and no
   preferred model is; they are never pulled, and choosing one writes a proposal to pull the
   cheapest preferred model. Kept off the ladder, with the reason in code: `all-minilm` (its
   256-token context cuts the 400-token chunks), `snowflake-arctic-embed:33m` (cosine R@5 0.525,
   below word search's 0.625) and `embeddinggemma` (17.7 tokens/s here, and its eval run was
   contaminated). node-llama-cpp is recorded but is not a candidate until the eval measures a GGUF
   model. A keyed remote provider joins only with recorded consent. It has no paired eval, so the
   weakest ladder prior stands in for its recall gain, labelled estimated.
2. **Gates** for each measured candidate, each kept as a verdict with its objective, value,
   break-even and labelled inputs: context (the model's context fits a chunk), RAM, query, batch
   (one chunk fits its own deadline under the 600 s ceiling), keep-up, and gain (the paired sign
   test against word search, p < 0.05). A failed sanity check on this machine (paraphrases not
   scoring above unrelated text) fails the gain gate.
3. **Choice.** The cheapest preferred survivor by measured θ, stepped up to a dearer preferred one
   when the step-up pays or its extra cost is negligible (row 7). An installed fallback only when
   no preferred model is installed. A consented remote model only when no local model survives.
4. **Mode.** Memory files only. Memory plus sessions only when the config lists sessions, the pick
   is local, session ingest was measured and keep-up passes with it.
5. **Dormancy.** Dormant while demand is unknown or under `Q*` and the first backlog takes longer
   than one fit at full idle. Search answers from words plus whatever vectors exist meanwhile.
6. **A pin.** With an explicit provider the same decision is still computed, and a proposal names
   each gate the pinned model fails, with the command that removes the pin. The pin stays.
7. **Off.** Every failing verdict goes into the reasons, plus at most one proposal: install
   Ollama, or `openclaw embedder fit --pull`. A key without consent adds one line saying that
   remote embedding runs only after an explicit yes (`--allow-remote <provider>`).

The fit does not pull every model to choose. It measures the cheapest installed preferred model,
predicts the next one from its prior θ ratio (0.494 on the reference host), and pulls and measures
that one only when the prediction passes every gate and a download is allowed. Throughput batches
repeat until no verdict changes across θ's 95% band: at most 90 s per model and 5 min in all,
downloads excluded.

## Machine classes

What the logic gives, by class. The fit measures each install; this table is for orientation.

| Machine class                                                                                               | Choice                                                                                                                                                 | Why                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raspberry Pi or another single-board computer, CPU only, embedder in a 2-CPU container (the reference host) | Word index now. `granite-embedding:30m`, memory files only, armed when real searches per day reach `Q*`. Never sessions by itself.                     | θ 338 tokens/s keeps up at a 7% idle share (K 87.8 against a burst of 6.12); query p95 1.67 s under a 5.0 s break-even; 92 MB of RAM. The step-up to 278m pays only above 157 to 1,574 searches a day (weighted to this host's L). mxbai fails the query gate (measured and derived). |
| x86 laptop or mini-PC, 4 to 16 cores, no GPU                                                                | Memory, 30m or 278m by the step-up formula; usually 278m at moderate demand.                                                                           | θ is estimated at 4 to 10 times the Pi's share, not measured. With 278m at about 1,000 tokens/s and 30m at about 2,000, `ΔC_day` is about 380 s, so `Q*_step` is about 15 a day at c = 0.1 and 145 at c = 1 (estimated inputs; the fit measures them).                                |
| Apple silicon, Ollama on Metal                                                                              | `granite-embedding:278m`, memory only. Sessions are affordable, but only when configured.                                                              | GPU-class θ makes `ΔC_day` a few seconds, so the step-up pays at almost any demand. Unified memory goes through the same RAM gate (estimated).                                                                                                                                        |
| NVIDIA or AMD GPU desktop                                                                                   | `granite-embedding:278m`, the most precise preferred model measured. A larger model only after it beats 278m with p < 0.05 on the eval.                | The cost is in the noise (`ΔC_day` within one fit), so quality decides. The ladder grows by measurement, not by size.                                                                                                                                                                 |
| Mostly non-English user on a CPU machine                                                                    | The same gates; the step-up toward multilingual 278m pays at much lower demand.                                                                        | Non-English R@5 is 0.9 for 278m and 0.6 for 30m (n = 10, weak). At L = 1, ΔΔR is 0.30, which puts the Pi's `Q*_step` at 359 and 36 a day instead of 1,574 and 157 (derived).                                                                                                          |
| Only a cloud API key, no local embedder                                                                     | Off (word index) until consent is given; with consent, the keyed provider, memory only.                                                                | Memory text leaves the machine and costs money (#17). The silent remote pick in `auto` is gone.                                                                                                                                                                                       |
| Fresh clone with no Ollama and no key                                                                       | Off and dormant, with one info line. It arms itself when an endpoint and a ladder model appear.                                                        | #26: no requests and no error lines, only a backoff re-probe (10 min, doubling to 24 h).                                                                                                                                                                                              |
| Ollama with only a fallback model, or nothing pulled, non-interactive install                               | The installed fallback if it passes every gate, with a proposal to pull the preferred model. Nothing installed: off, with the recommendation recorded. | No download without a yes. `openclaw embedder fit --pull` or `openclaw doctor --fix` arms it.                                                                                                                                                                                         |

## The installer flow

Designed; the code comes in the same change as this optic.

1. **Setup.** `scripts/setup.sh` step 4d, after the download-daemon step, asks one question
   (default yes only on a TTY): measure this machine and set up the embedding model that fits it,
   which may download 62 to 562 MB, with nothing leaving the machine. It runs
   `node openclaw.mjs embedder fit --installer`, adding `--pull` on yes. A failure warns and setup
   goes on, as in step 4c. The summary gains a `Memory search` line from
   `openclaw embedder status`. setup.sh never writes `openclaw.json`.
2. **Probe, in under 2 s.** The fingerprint; Ollama `/api/version` and `/api/tags`; whether
   node-llama-cpp is present (recorded only); the ids of keyed remote providers, never the keys; the
   corpus and its 14-day write rate; and, in one pass over the 60 newest transcripts, the miss cost
   and the non-English share. With no history, the priors stand in and say so.
3. **Measure** the cheapest installed preferred model through `POST /api/embed` with input arrays:
   cold load, 16 queries, batches of about 400-token passages until no verdict changes inside θ's
   95% band, dispersion, overhead, 1 against 2 in flight, a `num_thread` probe on CPU endpoints,
   RSS, CPU share, contention and three sanity pairs. Then the prediction for the next preferred
   model, as in _Choice logic_.
4. **Decide and record.** `decideEmbedderFit`, `writeEmbedderFit`, one printed line. The fit holds
   its lock throughout, which pauses background embedding. Ceiling: 5 min excluding downloads;
   about 2 to 3 min on the reference host (estimate), seconds on a GPU.
5. **Cases.** Non-interactive: no prompts, no downloads, no remote. No Ollama: off, with the hint
   to install it and run `openclaw embedder fit --pull`. Only a fallback installed: used if it
   passes, with a pull proposal. A remote key: listed, and used only after a TTY yes that says what
   leaves the machine, with a list-price estimate labelled third-party, or after
   `--allow-remote <provider>`; the measurement itself sends fixture text only. An explicit pin:
   never changed, with a proposal when it fails a gate.
6. **Afterwards.** `openclaw embedder status` reads the record and the governor snapshot, with no
   gateway call. `openclaw doctor` prints every verdict with its provenance, and `doctor --fix`
   re-measures in the foreground. At gateway start the fingerprint and the ladder models are
   compared with the record. Changed or missing: one info line, then a detached, nice'd
   `openclaw embedder fit --background` once the idle gate opens (single-flight, at most once per
   24 h unless the fingerprint changes again). No reachable embedder: the backoff re-probe. A fresh
   clone that never ran setup.sh gets the same background fit, and until then `auto` resolves to
   `none`.

## The governor

**Purpose.** One runtime mechanism for the rate and latency of every core and fork embedding call
(`src/fork/embedder-governor.ts`). It measures, queues and decides with the fit core's formulas
and re-derives none of them. Its own constants are windows and clocks, each commented with its
objective, its source and what would move it: a live window of 200 calls, 20 calls before a live
estimate replaces a prior, demand averaged over 7 days, a duty window of 60 s, CPU pressure
sampled every 30 s while background work waits and every 5 min otherwise, and `keep_alive` kept
between 5 min and 24 h.

**Placement.** `governEmbeddingProvider` wraps every provider the core factory
`createEmbeddingProvider` returns (auto, primary and fallback), and each fork call site that builds
its own adapter provider (the prefrontal RPC, skill search) wraps its own. Every HTTP provider
hands the governor the base URL it calls: the core factory its client's `baseUrl`, the fork call
sites `resolveEmbeddingEndpointBaseUrl` (`src/memory/embedding-endpoint.ts`), which asks each
adapter's own client resolver, so one server is one key and a loopback server is local. The state
is one governor per endpoint key (`endpointKeyFor`: the provider id plus the lowercased URL origin)
on `globalThis[Symbol.for('openclaw.embedGovernor.v1')]`, looked up per call (`architecture.md`,
cross-bundle shared state); inside it, samples, backlog, dormancy and trials are kept per model.
`getEmbedGovernor` reaches an endpoint's governor without a provider; `governorFor` returns a
per-wrapper view that answers admission with that wrapper's own mode.

**Invariants.**

- **One queue per endpoint, shared by every consumer**, at the fit's concurrency (1 per local
  server). A fit counts only at the endpoint it was measured at; anywhere else the endpoint runs
  as unmeasured. Two models on one endpoint share its queue, slots and breaker and keep their own
  measurements.
- **Foreground first.** Two FIFO lanes. `embedQuery` is foreground; `embedBatch` is background for
  the memory index and foreground for every other consumer, unless the call names its priority. A
  foreground call with a `budgetMs` it cannot meet is refused at once (`over-budget`), and one
  that waits in the queue expires at its budget the same way, without waiting for a slot.
- **Idle CPU for background work.** A background call to a machine-local endpoint is refused
  (`busy`) while the idle gate is closed or a fit lock is under 10 min old. Foreground calls are
  never gated.
- **Every deadline aborts, and the slot outlives the caller only while the work does.** Each
  request gets an AbortController linked to the caller's signal and a deadline from
  `requestDeadlineMs`, with the cold-load term when the model has probably been unloaded. At the
  deadline it aborts and rejects `deadline`. Every core HTTP adapter (OpenAI and Mistral through the
  remote provider, Voyage, Gemini, Ollama) and the Ollama extension forward the signal to their
  request. The caller is answered then, but the slot stays held until the provider's call settles,
  at most one more of that deadline; past that it is freed, counted `abandoned` and logged. So a
  provider that ignores the abort, like the in-process `local` one, never runs more calls than the
  concurrency.
- **The breaker is only for machine-local endpoints** (`inproc`, `local-http`). F comes from
  `breakerThreshold` and the cool-down from `breakerCooldownMs`; half-open admits one single-input
  call. While open, every call fails fast, and the calls already queued fail when it opens. A
  deadline, an HTTP 5xx or a network error counts as a failure; any other error means the endpoint
  answered. A caller's own abort is neither: it is counted `aborted`, moves no streak or cool-down,
  and a cancelled half-open probe leaves the breaker half-open for the next call.
- **No retries inside the governor.** A refusal is an `EmbedderUnavailableError` with a reason
  (`breaker-open`, `deadline`, `over-budget`, `busy`, `aborted`): the caller serves words and never
  retries it. A deadline or a caller's abort always surfaces as one, with the provider's own error
  as its cause. Remote providers keep today's 5xx retry policy, which the caller applies
  (`budget().retries5xx` is 3 for a remote endpoint, 0 for a local server).
- **Admission for the core index** (`admit`): `breaker-open` and `busy` for every provider; for a
  fit-decided provider (mode `fit`) also `off`, `sessions-not-decided` and `dormant`; and
  `stepped-down` for both modes. The mode is each consumer's own, carried by its wrapper, so
  building one consumer's wrapper never changes another's admission. A remote endpoint is always
  admitted. A pinned provider (mode `pin`) is never made dormant: the breaker, the idle gate and a
  step-down can pause it, and none of them changes it.

**What it measures.** Per call: the tokens (Ollama's `prompt_eval_count` when reported), the wall
time, and Ollama's `total_duration` and `load_duration` through `onMeasure`, so θ is tokens over
service time without the load. Per query: the caller kind (`agent`, `rpc`, `probe`, `internal`;
only agent and rpc count as demand) and the scan time. Contention: CPU pressure (PSI
`some avg10`) during background calls minus outside them, divided by 100, once both sides have 20
samples; Linux only, and c = 1 elsewhere.

**Step-downs and re-measures (#25).** Two consecutive 24 h windows in which the index drained less
than arrived, with the gate open and the breaker closed, stop session embedding first and then
memory embedding. Each step-down logs one line, writes one ledger row and asks for a re-measure; a
new fit record lifts it. θ drift (the live p50 over at least 20 index calls outside the record's
95% band) asks for a re-measure too.

**Stopping rule.** No endpoint: only the backoff re-probe runs. No demand: no background work. At
most one automatic re-measure per 24 h. A per-turn lane retires itself after `trialInvocations`
zero-recovery invocations. Owed: the design also stops automatic re-measures after two fits in a
row with the same decision, until the fingerprint changes. The record keeps the history that needs
(the newest 20 fits), but neither the fit core nor the governor reads it for that (2026-10-29).

**Persistence and visibility.** Demand day-buckets (since 2026-10-30 with `aborted` and
`abandoned` counts), the breaker, the per-model state (pending and drained windows, step-down level
and trials, under the snapshot's `models`; an older snapshot restores into the model it names) and
contention samples persist in `embedderFitPaths().governor`
(`<stateDir>/memory/embedder-governor.json`), written on every transition and otherwise at most
once a minute, and reloaded at start; a half-open probe cut off by a restart probes again. Busy
intervals are pruned to the 60 s duty window as each busy period ends, and a remote endpoint keeps
none.
Transitions and one daily account go to `recordAlgorithmOutcome` (algorithm `embedder`, variant
`<provider>/<model>`, parts not ratios). One log line per transition and none per call, on the
`memory/embedder` subsystem: `embedder breaker open (<key>)`, `embedder breaker half-open (<key>)`,
`embedder breaker closed (<key>)`, `embedder dormant (<key>)`, `embedder armed (<key>)`,
`embedder step-down (<key>)`, `embedder step-down lifted (<key>)`,
`embedder re-measure requested (<key>, <reason>)`, `embedder model added (<key>)` and, at most
once per endpoint a day, `embedder slot abandoned (<key>)`. A refused
call's error text starts `embedding <reason>: `, for example
`embedding deadline: no answer within ...`. Under a test runner without `OPENCLAW_STATE_DIR` the
governor does no file IO, samples no pressure, sees no lock and reports an idle host.

**Two documented simplifications (2026-10-29).**

1. Dormancy rescales the record's `Q*` to the live contention, `Q*_live = Q*_fit × c_live / c_fit`
   (`Q*` is linear in c), because the fit core exports no account builder and the record does not
   keep the account's inputs.
2. Until the index has been admitted once under the model, the record's `dormantUntilDemand` stands
   in for the backlog: the whole corpus is still pending, but no pending tokens have been noted yet.

**Known gaps (2026-10-30).**

- A foreground deadline is the derived deadline capped by the call's own remaining budget, and an
  expiry counts as a breaker failure either way. So a lane with a tight budget on a slow but
  healthy endpoint can push the breaker toward opening for every consumer of that endpoint. The
  failures must be consecutive, and any answer resets the count.
- Plugin-only embedding adapters (lmstudio, deepinfra, bedrock, github-copilot) pass no base URL,
  so a local LM Studio server is still classed remote.
- On the skill-search and prefrontal path, the plugin providers for OpenAI, Voyage, Google and
  Mistral (`extensions/*/embedding-provider.ts`) and the plugin-SDK copies of the remote fetch
  (`src/memory-host-sdk/host/`) still drop the abort signal. The governor holds their slot until
  they settle, so the concurrency holds, but the request itself runs on.
- Scripts outside TinkerClaw that call Ollama directly share its one slot unseen: on 2026-10-30 a
  research pilot sent 87 `mxbai-embed-large` requests, loading a second model beside the fit's.
- memory-core is not governed, and neither is `/v1/embeddings`; see _Consumer routing_.

**Alternatives rejected for the governor.**

- **A queue per consumer.** The 2026-10-28 loop was two producers on one slot, and separate queues
  cannot order them.
- **Retries inside the governor.** A retry after a deadline is the loop itself, and only the caller
  knows whether words will do.
- **The deadline keyed on provider id.** That rule gave Ollama on loopback the 120 s remote race,
  because only the id `local` counted as local.
- **`withTimeout` from `src/fork/pipeline.ts`.** It only races, so the request keeps holding the
  slot. The abortable deadline is a mechanism of its own, with its own row in `architecture.md`.

**Gate.** Checks (d) and (f) of `embedder-fit-single-owner.mjs`: the Ollama provider posts one
`/api/embed` request per batch with no `Promise.all`, and the core factory wraps what it builds in
`governEmbeddingProvider`. Checks (i) to (m) hold the 2026-10-30 review fixes: a slot freed only
when its call settles, caller aborts kept off the breaker, a URL for every HTTP endpoint, fits
matched to their endpoint, and the abort signal forwarded by every adapter.

## Consumer routing

Every consumer that could embed text, and how it meets the decision.

| Consumer                                                                                                                           | Gets the decision                                                                                        | Governed                                                                                                                        | While the decision is `none`                                                                                                  | On the reference host, 2026-10-29                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core memory index (`src/memory`, behind `fork.memory.search`, the recipe memory tier and the bible probe)                          | Through the seam.                                                                                        | Yes, by construction: `createEmbeddingProvider` wraps it (consumer `memory-index`; mode `fit` when the raw provider is `auto`). | Word-only rows (`fts-only`) are indexed and searched; a failed or refused embed writes the file's words and the sync goes on. | The source of the 2026-10-28 loop. The probe sends caller `probe`: words only, no sync, not counted as demand.                                                                                                                                            |
| memory-core (`extensions/memory-core`; the `memory_search` tool wherever it holds `plugins.slots.memory`, the fresh-clone default) | Through the seam: it imports the resolver from `openclaw/plugin-sdk/memory-core-host-engine-foundation`. | No. It derives its own deadline and concurrency (`resolveEmbeddingTimeoutMs`, `resolveMemoryIndexConcurrency`).                 | No adapter is built; its FTS-only mode indexes and searches.                                                                  | Dormant: the memory slot is `tinkerclaw-total-recall`. With its 600 s Ollama batch deadline, concurrency 1 and memory-only default sources, the 2026-10-28 pattern would need a slowdown of more than 25×.                                                |
| Prefrontal semantic recipe lane (`fork.prefrontal.embed`; opt-in through `PREFRONTAL_SEMANTIC_MATCH_ENABLED`)                      | Through the resolver; `isEmbeddingOff` answers `armed: false` at once.                                   | Yes: it wraps its adapter (consumer `prefrontal`).                                                                              | Lexical recipe match only.                                                                                                    | Before: 26 weak-lexical calls in 48 h, 0 usable results, 342 s of turn wait. Designed: catalog vectors cached per model and filled once in the background lane, one prompt embed per weak turn within 1 s, and a trial that retires the lane.             |
| Skill search (`fork.skill.search`, the engram-consolidate cron)                                                                    | Through the resolver.                                                                                    | Yes (consumer `skill-search`, foreground).                                                                                      | Keyword ranking; an embed failure falls back to it too.                                                                       | The skill library holds 0 skills (measured).                                                                                                                                                                                                              |
| LIMBIC semantic upgrade (embedded runner, inline limbic)                                                                           | Through the resolver, then `createEmbeddingProvider` (consumer `limbic`).                                | Yes, by construction.                                                                                                           | Hash vectors (FNV-1a), no embedding call.                                                                                     | Limbic runs as an extension here, so nothing runs inline.                                                                                                                                                                                                 |
| ENGRAM inline embedding lane (embedded runner)                                                                                     | Removed 2026-10-29.                                                                                      | —                                                                                                                               | —                                                                                                                             | It hard-coded `mxbai-embed-large`, its vectors had no reader (`injectRetrievalPack` has no caller), it wrote no vector file after 2026-10-13, and its 907 `Hybrid retrieval active` log lines were false. The WANT stays in `memory-layout.md`. Gate (c). |
| total-recall pack and recall tool                                                                                                  | No embeddings: word FTS in a worker thread.                                                              | —                                                                                                                               | —                                                                                                                             | Hook median 10 ms. Its `embeddingProvider` and `embeddingModel` keys are dead (`config-shape.md`, trap T12).                                                                                                                                              |
| Computational humor                                                                                                                | No embeddings: hash vectors.                                                                             | —                                                                                                                               | —                                                                                                                             | Its `embeddingProvider` key is dead (trap T13).                                                                                                                                                                                                           |
| learned-intuition ONNX MiniLM (amygdala novelty)                                                                                   | Kept apart: not a retrieval embedding.                                                                   | No.                                                                                                                             | —                                                                                                                             | It feeds the amygdala gate on every tool call. The whole evaluate step is median 431 ms and p95 6.8 s over 3,704 calls; the embedding's share is unmeasured (the gateway-CPU track holds the profiles).                                                   |
| `/v1/embeddings` (gateway HTTP route)                                                                                              | Through the resolver.                                                                                    | No.                                                                                                                             | It answers with an error.                                                                                                     | Unused: no traffic seen.                                                                                                                                                                                                                                  |

memory-lancedb is dormant here, and active-memory made no memory search calls; neither embeds.

## The 2026-10-28 incident

**What happened.** On the reference host the memory index's session-delta syncs fed about 20
embedding requests at once into an Ollama server with one slot (`n_slots` = 1, 2 CPUs, 3 GiB).
Served latencies reached 1,560 s. In 47 h the legacy `/api/embeddings` endpoint served 9,036
requests, 240 of them HTTP 500, with a median of 8.98 s and 1,098 over 60 s; 90 batches timed out
in two hours, and the gateway logged 123 session-delta sync failures in one evening. Host load
reached about 21 on 4 cores. Nothing in the loop was a slow model: it was queueing collapse at a
one-slot server, with deadlines that never cancelled anything.

**The six root causes, and what closed each.**

1. **Fan-out into one slot.** About 5 requests per 8,000-byte batch (a `Promise.all` of one
   `/api/embeddings` request per chunk) times 4 files in parallel. Closed by one `POST /api/embed`
   per batch with an input array, one request in flight per local server shared by every
   consumer, and batches sized in tokens from measured θ.
2. **The wrong deadline.** `isLocal = this.provider?.id === "local"` counted only in-process
   node-llama-cpp as local, so Ollama on loopback got the 120 s remote race; the config keys for it
   are read by memory-core only. Closed by deleting the provider-id rule: deadlines derive from
   tokens, θ, dispersion and residency, with 10 min and 60 s kept as ceilings.
3. **Timeouts that never cancelled.** `withTimeout` only raced, the fetch had no signal, and
   undici's stream timeout is 30 min. Closed by aborting at every deadline: the governor's abort
   signal reaches `fetchWithSsrFGuard` through `withRemoteHttpResponse`, which also takes a
   `timeoutMs` that bounds the undici dispatcher. On 2026-10-29 only the core Ollama adapter
   forwarded it; since 2026-10-30 every core HTTP adapter and the Ollama extension do (check (m)),
   and a given-up call keeps its slot until it settles (check (i)).
4. **No progress kept.** The embedding cache was written only after all of a file's batches, so
   every retry started the file again. Closed by an upsert per batch; an embed failure in the
   middle of a file writes that file's words (vectors pending) and the sync goes on.
5. **Nothing stopped the cycle.** No breaker, HTTP 500 retried 3 times, and every 5 s transcript
   delta started a new sync. Closed by the breaker; no retries on a deadline, an abort or a
   breaker refusal, and none on 5xx for a local server; admission (idle gate, demand, keep-up); and
   a bible probe that no longer starts a sync.
6. **A second producer on the same slot.** The prefrontal lane sent up to 128 texts per
   weak-lexical turn with no server deadline and no cache; its client left at 10 s while the server
   held the slot for 148 to 1,550 s. Closed by caching the catalog vectors, filling them once in
   the background lane, embedding only the prompt per turn within 1 s (refused up front when that
   cannot be met), and a trial that retires the lane.

Also fixed on the way: the keyword leg joined every token with AND and matched 0 of 40 natural
questions, so the configured 0.7/0.3 hybrid ran as vector-only; it is an OR of keywords now
(`src/memory/hybrid.ts`), and word-only R@5 went from 0.475 to 0.625. FTS-only mode indexes again.
A failed query embed serves the keyword results already computed. A word-only or dormant index no
longer rebuilds itself on every sync. A new manager no longer re-reads and re-hashes unchanged
files.

**The reindex hazard.** The index's stored meta still listed sessions after they left the config,
so the next search that was not the probe would start a full safe reindex. Its seed read the whole
embedding cache (about 171k rows, an estimated 4.3 GB of JSON) with one synchronous `.all()` on the
gateway's main thread, on a host with a few GB available. It was never run, so it is not proven to
run out of memory. The design's interim step turns the sync triggers off in config
(`sync.onSearch`, `sync.onSessionStart`, `sync.watch`) until the fix is deployed. The fix copies
only the matching provider and model rows inside SQLite (ATTACH, then INSERT ... SELECT in
rowid-bounded chunks of 1,000 with a yield between them) and never loads the cache into the heap:
gate (g). After the switch, the 11.47 GB index becomes a memory-only word index; an OR query on it
measured 276 ms p50 and 377 ms p95 over 12 read-only queries.

## Limits of the evidence

- Quality rests on one private corpus, 40 self-written queries that share on average 35% of their
  words with their targets (which favours word search), and only 10 non-English queries. Decisions
  rest on significance and expected value, and the ladder grows only by measurement.
- Contention is read from CPU pressure on Linux only. Elsewhere c = 1, which keeps more machines
  dormant.
- Whether Ollama 0.40.11 stops computing when the client disconnects is unverified. With batches
  of about 3 s and one request in flight, an orphan costs at most one batch. To check after the
  deploy: send a 512-token embed, abort it at 100 ms, then time a 1-token embed.
- A re-fit changes what `resolveMemorySearchConfig` returns, which builds a new manager and a full
  reindex in both trees. The core closes the old manager; memory-core keeps its old one until a
  restart. Re-fits are rare, because they follow fingerprint changes.
- The OR keyword query changes keyword ranking for every caller in both trees. It measured better
  on 40 queries, but precision on exact multi-word lookups may drop; BM25 still ranks the rows
  that match more terms first.

## Rejected alternatives

- **An onboarding-wizard step only.** The fork's cloner path, `scripts/setup.sh`, never runs
  onboard, so the users this is for would miss it.
- **Benchmarking inside the gateway** (in-gateway calibration and a daily adaptation loop). It
  competes with live turns, the class of the 2026-10-28 load spike. A nice'd CLI child at idle
  measures the same thing, and the step-downs and the drift trigger cover adaptation.
- **A fixed machine-class table.** A frozen threshold (#19). This 4-core Pi gives its embedder a
  2-CPU share throttled in 87% of CFS periods, and scaling by parameter count missed the measured
  throughput by 2 to 4×. Measuring takes 2 to 3 minutes.
- **Keeping `mxbai-embed-large` and raising the timeouts.** The loop was queueing collapse, not a
  short deadline. mxbai is also dominated by `granite-embedding:278m` (1.75× slower, the same RAM,
  no better) and fails the query break-even at its measured p95 (8.6 s against 5.9 s).
- **Removing embeddings everywhere** (`memorySearch.enabled = false`). That removes
  `fork.memory.search`, which the bible probe and the recipe memory tier use. The vector gain over
  word search is significant for every ladder model (+0.225 to +0.35 R@5, p ≤ 0.012), and dormancy
  already makes vectors cost nothing where nobody searches.
- **A remote API on slow machines, or keeping the silent remote pick in `auto`.** Private memory
  text leaves the machine and costs money. Privacy comes first (#17): only with explicit, recorded
  consent.
- **Writing the decision into `openclaw.json`.** Explicit config stays untouched (#26f), and the
  config can sit in a git repo. A git-ignored state file keeps a per-machine decision on its
  machine.
- **A new provider value `fit`.** `auto` already means decide for me; a second name for the same
  intent would split the semantics.
- **A per-install recall probe built from each file's own heading.** The query text sits inside
  the document it targets, so it measures self-matching, not recall. The ladder grows by an offline
  eval with frozen queries instead.
- **Governing memory-core and the Ollama extension now, through a plugin-SDK export.** memory-core
  awaits its query embed outside any catch, so a fast-failing breaker would turn slow searches into
  errors; it needs its own word fallback first (`canonical-derivations.md`, declared twins).
- **Plain-node installer modules.** setup.sh builds before step 4d, so the CLI reuses the
  TypeScript corpus listing and the decision, with no second copy.
- **A status RPC.** The CLI and doctor read the record and the snapshot file without the gateway,
  which also saves an upstream scope-table edit.
- **An automatic step-up at runtime.** A step-up needs a quality and throughput measurement, which
  belongs to the fit and to doctor.
- **The prefrontal lane embedding the whole catalog each turn, with a longer timeout.** About 10k
  tokens per weak turn cannot meet any per-turn budget on a CPU machine.
- **An ANN or KNN vector index now.** The scan cost is unmeasured, and with vectors dormant nothing
  shows it as a bottleneck.
- **Re-indexing session transcripts with a small model.** On the reference host that needs an idle
  share of at least 16% and about 35 h of backlog, and no measurement shows a recall gain from
  sessions.

## Don't regress

Each rule names the check of `scripts/bible/embedder-fit-single-owner.mjs` that holds it.

1. **No embedding model is chosen by a literal outside `EMBEDDER_LADDER`.** The fit is the only
   chooser on the fork paths. Check (c) holds the embedded runner, where a literal
   `mxbai-embed-large` started a second embedder whose vectors nothing read; it reads the ladder's
   names from the fit core, so a model added to the ladder is covered the day it is added. Provider
   defaults for an explicit pin with no model (`DEFAULT_OLLAMA_EMBEDDING_MODEL`), upstream catalogs,
   the model-limit table and tests are not choices, and they stay.
2. **No deadline keyed on provider id.** Classify an endpoint with `classifyEmbeddingEndpoint` and
   derive its deadline with `requestDeadlineMs`. Check (e) holds the core index. memory-core's
   `resolveEmbeddingTimeoutMs` still keys on `providerId === "local"`; it is a declared twin
   (`canonical-derivations.md`).
3. **No `Promise.all` over texts into a local server.** One request per batch, and one batch in
   flight per local endpoint. Check (d).
4. **Every deadline aborts.** A race is not a deadline: the losing request keeps the slot.
   Embedding calls go through the governor's dispatch, never through `withTimeout` from
   `src/fork/pipeline.ts`, which only races. Check (f) keeps the core factory governed.
5. **FTS indexing never depends on the embedder.** With no provider, a refusal, an open breaker or
   a deadline, the file's words are written, its vectors stay pending and the sync goes on. A
   word-only index must not rebuild itself on every sync, so the vectorDims reindex clause requires
   a provider. Check (g).
6. **`auto` never picks a remote provider without consent.** The seam replaces `auto` before any
   factory sees it: check (b). The factories' own `auto` branches are declared twins, and a caller
   that hands them a raw `auto` brings the silent remote pick back. Consent lives in the record
   (`consent.remote`) and is never inferred from a key.
7. **No `.all()` of the embedding cache.** The reindex seed copies the matching rows inside SQLite,
   in chunks with yields. Check (g).
8. **One decision, one seam.** `decideEmbedderFit` is the only decision (its ledger cap is 1 in
   `canonical-derivations.md`), and `applyEmbedderFit` the only way it reaches a consumer: checks
   (a) and (b). A machine whose decision is `none` makes no embedding call and builds no provider:
   check (h) holds the prefrontal RPC to that.
9. **A slot is freed when its call settles, not when the caller is answered.** A given-up call
   keeps its slot until the provider lets go, at most one more deadline. Check (i).
10. **A caller's abort is not the endpoint's failure.** It is counted apart and never moves the
    breaker. Check (j).
11. **Every governed HTTP provider names the URL it calls.** The core factory passes its client's,
    the fork consumers the resolver's, so one server is one key and a loopback server is local.
    Check (k).
12. **A fit counts only at its own endpoint.** `fitBudgetFor` takes the endpoint key, and a record
    measured elsewhere is no record. Check (l).
13. **Every HTTP adapter forwards the abort signal to its request.** Check (m).

## Open decisions

- **Remote embeddings with a key already in config.** About $0.25 once for the corpus and about
  $0.20 a month at the measured write rate (text-embedding-3-small list price; third-party, to
  verify), in exchange for every memory file leaving the machine. Default: no.
- **Clones whose `auto` used a keyed remote provider by itself.** Consent is now required (the
  default, and a tightening); an existing key could instead count as inherited consent.
- **Re-enabling the prefrontal lane** once its cache is deployed. It then runs as a self-retiring
  trial: about 324 weak-lexical turns, roughly 25 days, at most about 1 s per turn.
- **Session transcripts back in the index on a stronger host.** Only by explicit config. On the
  reference host they would need an idle share of at least 16% and about 35 h of background
  embedding, with no measured recall gain.
- **A pin of `granite-embedding:278m` on the reference host.** It buys multilingual recall
  (non-English R@5 0.9 against 0.6, n = 10) for twice the CPU and about 600 MB more RAM, on a host
  whose swap is full. It matters only once agents search memory.

## Code or prompt (#22)

Code, all of it. The want is consistency: the same measurements give the same decision on every
run, and every embedding call meets the same queue, deadline and breaker. A prompt cannot hold a
queue or abort a request. The plasticity sits in the measurements: re-measuring retunes every
bound, so no threshold needs a prompt to stay current.
