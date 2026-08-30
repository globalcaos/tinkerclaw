# Mining upstream + OSS for patterns worth adopting — 2026-08-05

**Method.** Five independent agents mined distinct sources (upstream OpenClaw; agent-harness
capabilities; OSS multi-agent frameworks; OSS memory systems; verification/observability practice).
Each returned patterns with citations. A **second, skeptical agent per source** then checked every
pattern against this tree with two questions: _does tinkerclaw already have this under another
name?_ and _is the cited evidence real?_ 62 patterns survived. Everything below was re-verified by
hand against the code before being written down.

> **The verify pass earned its place immediately: it did not catch every false claim, and I caught
> one it passed.** See §0. That is the honest headline of this exercise — an adversarial checker
> reduces bad findings, it does not eliminate them, and the last check is still a human-or-agent
> opening the file.

---

## 0. A refuted claim, recorded first

The memory-systems agent reported, with confidence and a plausible mechanism:

> `assembleRetrievalPack` (`src/memory/engram/retrieval-integration.ts:136`) is FTS-only and has
> **ZERO production callers** — every hit is its own test. The LIVE pack is `buildDefaultAssemble`.

**False.** `assembleRetrievalPack` has live callers at
`extensions/tinkerclaw-total-recall/index.ts:404` and `:407` — the retrieval path repaired earlier
the same day. The agent's grep found the test file and stopped.

The _underlying observation_ was still valuable and survives in a corrected form: **there are two
retrieval-pack assemblers and both are live**, reached by different paths —
`assembleRetrievalPack` via the total-recall plugin, `buildDefaultAssemble`
(`src/agents/pi-extensions/retrieval-runtime.ts:156`) via `injectRetrievalPack` in
`src/fork/attempt-hooks.ts`. That is worse than one being dead, not better: two live assemblers
means the pack a reader reasons about may not be the pack a given turn received.

**Acted on.** A `retrieval-pack assembler` row now sits in the canonical-derivations ledger keyed on
_both spellings_, cap 2. The pre-existing `assembleRetrievalPack` row (cap 1) reported green the
whole time, which is the general lesson:

> **A name-keyed ratchet cannot see a concept re-derived under a new name.** The rename is the
> evasion, and it requires no intent — someone writing `buildDefaultAssemble` was not evading
> anything. Any ledger keyed on identifiers has this blind spot by construction.

---

## 1. Confirmed defects, ranked by value ÷ effort

### 1.1 Mixed-scale score fusion, then MMR over the mixture — **small effort, real defect**

`src/agents/pi-extensions/retrieval-runtime.ts` merges vector hits into the FTS candidate list by
**ID dedup only**, keeping each retriever's raw score, then adds a recency term
(`score: r.score + recencyBoost`) and runs `mmrRerank` over the combined list.

BM25 scores and cosine similarities are not on the same scale, and neither is a recency bonus.
Summing them and reranking is arithmetic on incommensurable units — the winner is decided partly by
which retriever happens to produce larger numbers.

**The fix the field already uses is Reciprocal Rank Fusion**: fuse on _rank_, not score, so
heterogeneous retrievers combine without normalisation. Graphiti ships exactly this as a selectable
search recipe alongside MMR and cross-encoder reranking
(<https://help.getzep.com/graphiti/working-with-data/searching>).

**Not applied here.** It changes live retrieval behaviour for every turn and deserves a measurement,
not a drive-by patch — see §1.3, which is the prerequisite.

### 1.2 Bi-temporal supersede cannot fire across corpora — **medium effort, blocks the memory merge**

`findSupersededChunkIds` (`src/memory/engram/supersede-writer.ts:85`) keys fact identity on:

```sql
WHERE source = ? AND path = ? AND start_line = ? AND end_line = ? AND model = ?
```

`source` is the corpus tag. So a Claude Code fact and a Jarvis fact are **by construction never the
same fact**, and neither can ever close the other's validity interval. The bi-temporal machinery is
real and ported faithfully (cf. Zep, arXiv:2501.13956), and it is inert precisely where the
CC↔Jarvis merge needs it.

This is not urgent while the corpus is effectively single-source, and it becomes correctness-critical
the moment the merge does anything more than concatenate. A corpus-agnostic identity — content hash,
or entity+predicate — is the shape of the fix.

### 1.3 Nothing measures whether retrieval helped — **small effort, unblocks everything above**

`recordAlgorithmOutcome({algorithm:"retrieval", outcome:"injected", metrics:{packChars}})`
(`src/fork/attempt-hooks.ts`) records **supply**: a pack was built, it was N characters. It records
no demand — nothing observes whether the injected context was used, cited, or ignored.

Consequence: §1.1's fusion change cannot be evaluated, because there is no metric it could improve.
This is the same shape as the day's other findings — _a green signal that measures the wrong side of
the transaction._

### 1.4 Events carry no provenance field — **small effort, cheapest of the four**

`EventMetadata` (`src/memory/engram/event-types.ts`) carries `taskId`, `premiseRef`,
`supersededBy`, `tags`, `artifactId`, `embeddingStatus`, `importance` — and **no `source` /
`corpus` / `origin`**. `sessionKey` is the only discriminator and it is not surfaced in the pack
line, which is `[ts] [kind] content`.

So after a merge you could not attribute a good or bad turn to either corpus even if §1.3 existed.
Graphiti's "episodes" pattern — every derived fact retains lineage to the ingestion that produced it
— is the reference design, and here it costs one optional field plus a label in the pack line.

---

## 2. Rejected, with reasons

A shortlist without rejections is a wish list.

| Pattern                                    | Why not                                                                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mem0 ADD/UPDATE/DELETE/NOOP reconciliation | **Already ported.** `src/memory/engram/reconciliation.ts` defines the four actions. The default is `createAlwaysAddReconciler`, so it is inert — but that is a wiring decision to revisit, not a pattern to import. |
| Letta shared memory blocks                 | Solves a different problem: one block attached to two agents, versus two corpora retrieved together with provenance. The existing dedicated-store design is a better fit and already ships.                         |
| Graph-based agent oversight                | Real, but this system's failures have not been topological. Its failures are silent no-ops, which instrumentation catches and a graph does not.                                                                     |
| Bigger orchestration frameworks            | ORCA's lease model already covers the concurrency hazard, and the frameworks surveyed mostly differ in role vocabulary rather than in coordination semantics.                                                       |

---

## 3. What did not need adopting, and why that matters

The strongest finding of the exercise is negative. ENGRAM already contains fork-local
implementations of most headline OSS memory patterns: Mem0-style reconciliation, Zep-style
bi-temporal invalidation, A-MEM-style backlinks, MMR reranking, sleep consolidation.

**The gap is not missing algorithms. It is that the merge-critical ones are single-source by
construction, provenance-blind, or wired to an inert default.**

That is the same conclusion the capability-coverage work reached from the other direction, and it is
the thesis of J20 §2: this system's deficit has not been capability for a long time. It is knowing
which of its capabilities are actually doing anything.
