---
title: "TRACE: Task-Conditioned Retrieval and Pointer-Based Compaction for Persistent LLM Agents"
author: "Oscar Serra (with AI assistance)"
date: "2026-02-16"
---

## Abstract

Persistent LLM agents operate under a hard constraint: a bounded context window that simultaneously functions as working memory *and*, in many deployed stacks, the only cognitively accessible copy of high-resolution state. Production systems commonly address context overflow with "compaction": replacing long histories with an LLM-generated narrative summary. We argue that narrative compaction is not merely lossy---it is *structurally unsafe* for tool-using, long-horizon agents because it destroys the only operationally useful copy of details that later determine correctness (exact error strings, file paths, tool outputs, parameters, and decision rationales). The failure is amplified in production because tool outputs---not conversation turns---dominate context pressure.

We present **TRACE**, a lossless, event-sourced memory architecture that treats the context window as a **managed cache** over a durable store. TRACE replaces narrative compaction with **pointer-based compaction**: when evicting history from the context cache, the system inserts a small, structured manifest of pointers (event IDs, artifact references, and task-state references) rather than a narrative summary. Per turn, TRACE assembles a bounded **retrieval pack** from a lossless event store and derived indexes; crucially, retrieval is **task-conditioned**: what the system injects depends on the active task, the premises under which memories were produced, and the agent's expected future needs.

TRACE is organized as a three-layer pipeline: **(1) Continuous event ingestion and indexing**, **(2) per-turn retrieval + bounded context assembly**, and **(3) sleep consolidation** that builds multi-granularity derived views (episodes, topic summaries, RAPTOR-style trees) while preserving the lossless store as ground truth. We further show how pointer-based memory enables **hierarchical agent planning** (planner/executor/sub-executors) by giving each level a separate context window and retrieval surface. We provide semi-formal boundedness invariants: per-turn injected memory never exceeds a configurable hard cap, and total stored memory grows linearly with interaction length. Finally, we quantify token and information-retention outcomes using production data from a personal AI agent deployment, showing that pointer compaction prevents irreversible loss across repeated compactions while maintaining similar context utilization to baseline practices.

---

## 1. Introduction --- The Compaction Catastrophe

### 1.1 Persistent agents are not chats

As LLMs move from session-scoped chatbots to **persistent agents**---systems expected to operate across hours, days, and months---the memory problem becomes qualitatively different. The agent must preserve:

- **High-resolution task state**: what was attempted, what failed, what succeeded, and why.
- **Long-horizon commitments**: decisions, constraints, follow-ups, and external dependencies.
- **Tool-grounded evidence**: tool outputs, logs, stack traces, code diffs, API responses.
- **Continuity under context resets**: the ability to resume without re-deriving or re-asking.

Transformer-based models impose a hard upper bound on tokens. Yet in many deployed agent stacks, the context window becomes not only working memory but also *de facto storage*---the only place where the agent can "see" prior tool outputs and decisions. When the window fills, the system must choose: truncate, summarize, or restart.

### 1.2 Why narrative compaction is structurally unsafe

A prevailing production technique is **narrative compaction**: summarize a large prefix of the conversation/tool trace into a short textual recap, then restart with the recap. This is attractive because it is simple and model-native.

For persistent tool-using agents, it is structurally unsafe for two reasons:

1. **Irreversibility ("only copy" failure):** once details are omitted or distorted in the summary, the agent often has no reliable mechanism to recover them. The summary becomes the *only cognitively accessible copy*.
2. **Compression at maximum cognitive load:** compaction typically occurs near context saturation, precisely when long-context failure modes (distraction, confusion, "lost in the middle") are most severe and when summarization faithfulness is hardest to guarantee.

### 1.3 Production reality: tool results dominate context pressure

In production agents, context pressure is frequently driven not by dialogue length but by **tool output volume**. Tool outputs are large, high-entropy, repetitive, and often contain one critical line embedded in thousands. This matters because those outputs are exactly the evidence the agent must later cite, re-check, or operationalize.

In production deployments of a personal AI agent, long-running sessions routinely accumulate many tool results totaling tens to hundreds of thousands of characters, consuming most of a 200K-token window and repeatedly triggering compaction. The result is a failure mode that looks like "forgetfulness" but is actually **cache eviction without storage**.

### 1.4 Thesis and contributions

**Thesis:** The context window must be treated as a **cache**, not canonical memory. "Compaction" should be implemented as **cache eviction with pointers**, not narrative consolidation.

**TRACE** operationalizes this thesis by combining:

- A **lossless append-only event store** as ground truth (events + artifacts).
- **Pointer-based compaction**: evict from the context cache, but retain structured pointers.
- A per-turn **retrieval pack** assembled under strict budgets.
- **Task-conditioned retrieval priority** so retrieval changes with task goals, premises, and expected future needs.
- **Hierarchical planning support** (planner/executor/sub-executors) via separate contexts and retrieval surfaces.
- **Multi-granularity derived views** (episodes, summaries, RAPTOR-style trees) as *indexes over the lossless store*, not replacements.

---

## 2. Background & Related Work

We organize related work around a shared question: *What is the context window relative to memory, and who manages the boundary?*

### 2.1 OS-inspired paging and "virtual context" (MemGPT / Letta)

MemGPT frames the context window as RAM and external stores as disk-like tiers, with the model managing paging via tools. This aligns with TRACE's cache/storage separation, but differs in locus of control: TRACE defaults to **system-managed** retrieval and eviction to avoid spending the main agent's attention budget on memory management.

### 2.2 Typed memory and governance (MaRS)

MaRS motivates typed memory objects, retention budgets, and provenance-driven governance. TRACE adopts the provenance requirement: derived objects (task state, decisions, summaries) should reference source events, enabling audits and policy-driven deletion without "mystery memory."

### 2.3 Learned memory managers (AgeMem; Memory-R1)

RL-trained memory managers and memory/action separation suggest a future direction: memory policies can be learned rather than hand-tuned. TRACE is compatible with this: task-conditioned retrieval can be implemented via heuristics today and replaced (partially) by learned policies as data and infrastructure mature.

### 2.4 Cognitive-architecture framing (CoALA) and consolidation

CoALA motivates separating working memory (context) from episodic storage (event streams) and semantic consolidation (derived structures). TRACE's three-layer pipeline (ingest -> retrieve -> consolidate) is directly aligned with this framing.

### 2.5 Context engineering and compaction practices (Anthropic; Weaviate)

Practitioner guidance emphasizes token budgets, tool design, just-in-time retrieval, and compaction to maintain long-horizon performance. TRACE agrees with the "context engineering" worldview but diverges on compaction: it replaces narrative summary as canonical memory with pointer-based eviction over a lossless store.

### 2.6 Hierarchical abstraction for retrieval (RAPTOR) and long-context limitations

RAPTOR demonstrates that hierarchical summaries can improve retrieval across large corpora. TRACE adopts RAPTOR-style hierarchies as *optional derived indexes*; critically, these hierarchies must not replace lossless storage. Long-context limitations (e.g., "lost in the middle") strengthen the case for retrieval packs and structured caches rather than unbounded raw context.

### 2.7 Event sourcing as a storage primitive

Event sourcing captures state changes as an append-only log enabling reconstruction, audit, and retroactive correction. TRACE adopts event sourcing as the ground truth storage model for agent interactions.

### 2.8 Companion paper on identity and priority-aware context engineering

This paper focuses on compaction, retrieval, boundedness, and planning under a lossless store. Several adjacent concerns---persona preservation, drift detection, observational memory, and deeper priority-aware scheduling---are treated in a companion technical report: Serra, O. (2026), *Agent Memory: Priority-Aware Context Engineering for Persistent AI Identity* (OpenClaw Technical Report). We cite it as a sibling work rather than coupling TRACE to any particular implementation surface.

---

## 3. Problem Analysis --- Why Narrative Compaction Fails

### 3.1 Compaction as a non-invertible transformation

Let an interaction produce an event sequence $E = (e_1,\dots,e_T)$. Compaction typically computes a summary $s = f(e_1,\dots,e_k)$ and continues with $(s,e_{k+1},\dots)$. This map $f$ is not invertible. In document summarization, the source text remains available; in agent compaction, the summary often becomes the only accessible representation for future reasoning.

### 3.2 The loss taxonomy that matters in production

Narrative compaction predictably loses the kinds of information that determine whether agents can actually complete tasks:

- **Precise strings** (hashes, IDs, file paths, exact error lines).
- **Causal chains** (what was tried, in what order, why).
- **Negative knowledge** ("we tried X; it failed").
- **Tool evidence** (the one decisive line in a long log).
- **Temporal anchors** (before/after deployments or migrations).
- **Open loops** (unresolved questions and next concrete steps).

A summary may preserve the *shape* of the task while destroying the operational substance.

### 3.3 Compaction happens at the worst time

Compaction is commonly triggered near window saturation, when attention is degraded and "middle" content is least accessible. Asking the model to compress history under these conditions is analogous to asking a human to take perfect notes at the moment of maximal overload.

### 3.4 Diagram: narrative compaction vs. pointer compaction

The central difference is what becomes canonical. Narrative compaction replaces the past; pointer compaction *indexes* the past.

```text
+----------------------------------------------------------------------------------+
|                Compaction comparison: Narrative vs. Pointer (TRACE)              |
+-------------------------------+--------------------------------------------------+
| Narrative compaction          | Pointer compaction (TRACE)                       |
+-------------------------------+--------------------------------------------------+
| Evict history                 | Evict history from the *cache*                   |
| Replace with a summary text   | Replace with a pointer manifest + task state     |
|                               | (event IDs, artifact refs, anchors, hints)       |
+-------------------------------+--------------------------------------------------+
| What is kept in context       | What is kept in context                          |
| - short recap                 | - Task State (small, structured)                 |
| - maybe TODOs                 | - Pointer manifest(s)                            |
|                               | - Per-turn retrieval pack (bounded)              |
+-------------------------------+--------------------------------------------------+
| What is lost                  | What is lost                                     |
| - precise strings             | - nothing permanently (lossless store persists)  |
| - tool outputs                | - only cache residency is lost                   |
| - provenance                  | - provenance preserved via event/artifact IDs    |
+-------------------------------+--------------------------------------------------+
| Failure mode                  | Failure mode                                     |
| - irreversible forgetting     | - retriever misses something (recoverable)       |
| - persistent hallucination    | - can re-query / broaden retrieval               |
+-------------------------------+--------------------------------------------------+
```

---

## 4. TRACE Architecture --- Cache Eviction over Lossless Storage

### 4.1 Design principles

TRACE is guided by six principles:

- **P1. Lossless ground truth:** persist all events (messages, tool calls/results, state updates) in an append-only store.
- **P2. Cache != storage:** the context window is a cache over durable storage.
- **P3. Pointer-based compaction:** compaction evicts from cache but inserts structured pointers instead of a narrative summary.
- **P4. Continuous indexing:** index events as they arrive, before eviction, avoiding "panic indexing."
- **P5. Typed derived views with provenance:** summaries, decisions, and task objects are *derived indexes* pointing back to source events.
- **P6. Hard budgets everywhere:** per-turn injection is explicitly bounded; retrieval never exceeds configured caps.

### 4.2 System architecture diagram (Ingest -> Retrieve -> Consolidate)

```text
                           +-----------------------------------+
                           |             TRACE                  |
                           |   Lossless Memory + Cache Control  |
                           +-----------------------------------+

   (Layer 1) Ingest & Index            (Layer 2) Retrieve & Pack           (Layer 3) Consolidate
+---------------------------+       +-----------------------------+      +---------------------------+
|  Stream of events         |       |  Task State (small)         |      |  Episode segmentation     |
|  - user msg               |       |  Retrieval policy           |      |  Decision records         |
|  - agent msg              |       |  Task-conditioned scoring   |      |  Multi-granularity views  |
|  - tool call              |       |  Pack under hard budgets    |      |  RAPTOR-style trees       |
|  - tool result            |       +-------------+---------------+      |  Forgetting / retention   |
+-------------+-------------+                     |                      +-------------+-------------+
              |                                   |                                    |
              v                                   v                                    v
+---------------------------+       +-----------------------------+      +---------------------------+
| Lossless Event Store      |<----->| Retrieval Surface / Indexes |<---->| Derived Objects / Indexes |
| - append-only events      |       | - FTS/BM25                  |      | - summaries (non-canonical)|
| - artifact blobs (large)  |       | - vectors                   |      | - links/graphs             |
| - provenance metadata     |       | - typed filters             |      | - access stats             |
+-------------+-------------+       +-----------------------------+      +---------------------------+
              |
              v
+---------------------------+
| Context Window (CACHE)    |
| - system policy           |
| - task state              |
| - retrieval pack (<= cap) |
| - recent tail             |
+-------------+-------------+
              |
              v
+---------------------------+
|  LLM inference + tools    |
+---------------------------+
```

### 4.3 Data model: events, artifacts, task state, pointer manifests

TRACE uses four first-class objects:

1. **Events (immutable, append-only):** user messages, agent messages, tool calls, tool results, decisions, and system notes.
2. **Artifacts (immutable blobs):** large tool outputs stored out-of-band, referenced by events (with hashes and metadata).
3. **Task State (small, mutable, versioned):** a compact index-card view of the *current* task: goals, constraints, open loops, next actions, and key pointers.
4. **Pointer Manifests (immutable, small):** compaction inserts these into the cache: a structured list of evicted event IDs, anchor events, referenced artifacts, and retrieval hints.

A critical rule: **Task State and derived summaries are never the only copy.** They are indexes over the lossless event store.

### 4.4 Layer 1 --- Continuous event ingestion and indexing

Layer 1 persists each event as it occurs and updates the retrieval surface immediately (full-text indexes, vector embeddings where appropriate, and metadata indexes). Large tool results are "artifactized": the event stores a pointer to an artifact rather than inlining the entire output into the cacheable text store. This ensures that, even if the context window evicts the raw evidence moments later, the system can still retrieve exact strings and provenance. The ingestion pipeline is designed to be safe under bursts (batchable) but must complete before eviction to avoid gaps in recall.

(See **Annex A.1** for the ingestion/indexing algorithm.)

### 4.5 Layer 2 --- Per-turn retrieval and context assembly

On every turn, TRACE builds a bounded **context pack** consisting of:

- a stable system/policy prefix,
- the current Task State object,
- a **retrieval pack** (bounded evidence pulled from storage),
- a short "hot tail" of recent turns,
- the user's new message.

The retrieval pack is assembled from multiple candidate sources (vector neighbors, keyword hits, pointer expansion from Task State, pinned typed objects) and then packed under a strict token budget. The key design choice is that retrieval is *mandatory* and *budgeted*---not a best-effort tool call the agent may forget to make.

(See **Annex A.2** for retrieval candidate generation, reranking, and packing.)

---

## 5. Task-Aware Retrieval Priority (Task-Conditioned Scoring)

Not all cached context is equally important; more importantly, **importance is not static**. Retrieval should be conditioned on (i) the active task, (ii) the premises under which a memory was created, and (iii) what the agent expects to need later.

### 5.1 Why "static relevance" fails

A purely similarity-driven retriever (vector/FTS) tends to over-inject:

- highly similar but **obsolete** objectives (older versions),
- low-value "debug noise" that matches keywords but is not useful now,
- "interesting" tool output fragments that are semantically close but not decision-relevant.

Conversely, it under-injects:

- the **latest** task objectives and constraints (which are often short and not keyword-rich),
- **decision rationales** that are critical but not lexically similar,
- "negative knowledge" ("we tried X and it failed") unless explicitly asked.

### 5.2 Conditioning on task, premises, and expected future needs

TRACE introduces a **task-conditioned scoring function** that modulates a base retrieval score.

- **Base score** captures generic relevance: semantic similarity, keyword match, recency, access frequency, type priors, and sensitivity penalties.
- **Task-conditioned modifier** adjusts priority according to the current task and phase (planning vs. execution vs. evaluation), and according to whether the memory was produced under premises that still hold.

A practical implementation uses metadata attached to events and derived objects:

- **Task binding:** each memory item is associated with a `task_id` (or episode cluster).
- **Premise signature:** each item references the Task State version (or premise set) active at write time (e.g., constraints, chosen approach, environment assumptions).
- **Supersession links:** items can supersede earlier versions ("objective v3 supersedes v2"), enabling retrieval to privilege the latest and demote archival variants.
- **Utility hints:** optional tags at write time (human- or model-generated) indicating expected future use (e.g., "needed for final report," "temporary debug," "decision record").

### 5.3 Examples (selective attention in agents)

- If the task is **"develop feature X"**, retrieval prioritizes: current objectives, current constraints, latest architecture decision record, and current plan. It deprioritizes: exploratory errors and dead ends (unless the user asks for a postmortem).
- If the task includes **"self-assessment at the end"**, retrieval elevates mistakes and successes throughout, because future evaluation depends on them.
- If objectives were updated multiple times, retrieval should treat **only the latest objective set as live**, while older sets become archival unless explicitly requested ("what changed since the earlier version?").

### 5.4 Outcome: retrieval that matches *need*, not just similarity

Task-aware retrieval reframes relevance as "usefulness for the current task under current premises," approximating human selective attention: you notice different things depending on what you are trying to do.

(See **Annex A.3** for a concrete task-conditioned scoring formulation and supersession handling.)

---

## 6. Pointer-Based Compaction (Compaction as Cache Eviction)

Pointer compaction is TRACE's replacement for narrative compaction.

### 6.1 What compaction does in TRACE

When the context window approaches its limit, TRACE:

1. selects eviction candidates (typically older tool results first, then older turns),
2. verifies those spans are already persisted and indexed (Layer 1 invariant),
3. evicts the spans from the cache,
4. inserts a **pointer manifest** containing:
   - evicted event ID range(s),
   - anchor events (decisions, errors, constraints),
   - referenced artifact IDs,
   - retrieval hints (entities, file paths, tool names, keywords),
   - a reference to the Task State version.

The manifest is deterministic and provenance-preserving; it is not a narrative summary and does not attempt to compress evidence into a single prose paragraph.

### 6.2 Why this is safer than narrative summaries

- **No "only copy" destruction:** the lossless store remains authoritative.
- **Reduced hallucination surface:** the manifest is structured and mostly identifier-based.
- **Recoverability:** if retrieval misses something, the system can broaden or follow pointers; the evidence still exists.

(See **Annex A.4** for eviction selection and manifest construction under hard token constraints.)

---

## 7. Hierarchical Agent Planning (Planner/Executor/Sub-Executors)

Long tasks often exceed a single agent's effective working memory. TRACE enables **hierarchical planning** where different agent levels maintain different contexts and retrieval surfaces.

### 7.1 The hierarchy

- **Level 1 (Planner):** maintains strategy, milestones, acceptance criteria, risk register, and pointers to evidence; delegates sub-tasks.
- **Level 2 (Executor):** performs a delegated sub-task; maintains detailed tool outputs and execution traces; reports results upward.
- **Level 3+ (Sub-executors):** for very large tasks, executors can delegate further.

Each level has:

- its own bounded context window (cache),
- its own Task State (appropriate abstraction),
- its own retrieval surface tuned to its role.

### 7.2 Why separation helps

The planner does not need full tool logs; it needs the *meaning* of execution results and their provenance. The executor does not need the full strategic plan; it needs only the local objectives, constraints, and relevant prior evidence.

Pointer-based memory makes this natural: the planner stores pointers to detailed evidence without paying their token cost; executors can fetch details on demand, then return compact, provenance-linked reports.

### 7.3 Hierarchical planning diagram

```text
+-----------------------------------------------------------------------------------+
|                           TRACE hierarchical planning                             |
+-----------------------------------------------------------------------------------+

          (Level 1) PLANNER context window (small, strategic)
+---------------------------------------------------------------+
| System + Policies                                              |
| Task State (strategy, milestones, acceptance criteria)         |
| Retrieval Pack:                                                |
|  - decision records, constraints, latest objective versions     |
|  - pointers to executor reports and key artifacts               |
| Recent tail                                                    |
+---------------------------+-----------------------------------+
                            |
            delegate subtask |  (pointer to plan slice + constraints)
                            v
          (Level 2) EXECUTOR context window (detailed, tactical)
+---------------------------------------------------------------+
| System + Tool protocols                                        |
| Task State (local objective, steps, checkpoints)               |
| Retrieval Pack:                                                |
|  - relevant artifacts/logs/code, local history                  |
|  - pointer to planner's plan node                               |
| Hot tail + tool outputs                                         |
+---------------------------+-----------------------------------+
                            |
                 report up  |  (compact report + provenance pointers)
                            v
          (Level 1) PLANNER updates Task State, stores pointers
```

(See **Annex A.5** for a concrete protocol: delegation messages, report schemas, and pointer propagation across levels.)

---

## 8. Hierarchical & Multi-Granularity Retrieval

TRACE's lossless store makes it possible---and often necessary---to retrieve at multiple abstraction levels.

### 8.1 Multi-granularity objects

TRACE supports retrieving different representations of the same underlying history:

- **Raw events:** exact messages, tool calls/results, error strings (highest fidelity; token-expensive).
- **Episode summaries:** summaries of contiguous work episodes (task/incident-level).
- **Topic summaries:** aggregated summaries across episodes (theme-level).
- **Strategic insights:** distilled patterns, policies, and stable decisions (highest abstraction).

These are all **derived views** with provenance pointers; none replace the lossless store.

### 8.2 RAPTOR-style trees as retrieval indexes

RAPTOR constructs bottom-up summary trees from chunks, enabling retrieval at an appropriate level for the query. In TRACE, RAPTOR-like trees apply naturally to event streams: leaf nodes are events/episodes; internal nodes are clustered topic summaries.

The key compatibility argument is: **hierarchies are indexes, not replacements.** Summaries may be lossy, but the ground truth remains available for drill-down.

### 8.3 Adaptive retrieval: choosing the right granularity

TRACE can select granularity based on:

- query specificity (exact string vs. "what did we decide?"),
- task phase (planning needs abstraction; debugging needs fidelity),
- token budget pressure (tight budgets prefer summaries),
- uncertainty (low confidence triggers drill-down to raw events).

### 8.4 Pros and cons

**Pros**
- Better token efficiency: inject one topic summary instead of twenty raw tool outputs.
- Better alignment with task needs: planning vs. execution require different abstraction.
- Improved robustness under long sessions: derived views can be stable and cacheable.

**Cons**
- Derived views introduce lossy representations (mitigated by lossless store + provenance).
- Index maintenance cost: clustering, summarization, and updates are non-zero overhead.
- Cold-start problem: hierarchies are weak until enough events accumulate.

(See **Annex A.6** for a multi-granularity retrieval policy, including drill-down triggers and provenance-linked packing.)

---

## 9. Formal Boundedness Guarantees

TRACE is explicitly engineered to keep both **per-turn context injection** and **total stored memory growth** bounded under clear invariants.

### 9.1 Per-turn context boundedness (hard caps)

Let $B_{\text{ctx}}$ be the model's maximum context window (tokens). TRACE enforces fixed budgets:

- $B_{\text{sys}}$: system/policy prefix (constant).
- $B_{\text{task}}$: Task State block (hard cap, e.g., 500--800 tokens).
- $B_{\text{tail}}$: hot tail (hard cap, e.g., last $k$ turns).
- $B_{\text{ret}}$: retrieval pack (hard cap, e.g., 4K tokens).
- $B_{\text{user}}$: user message (bounded by input limits).
- $B_{\text{headroom}}$: reserved for tool calls/structured outputs.

**Invariant (Context Pack Bound):**
\[
$B_{\text{sys}} + B_{\text{task}} + B_{\text{tail}} + B_{\text{ret}} + B_{\text{user}} + B_{\text{headroom}} \le B_{\text{ctx}}$.
\]

TRACE's packer enforces $B_{\text{ret}}$ as a strict cap by truncating, dropping, or selecting fewer items---never by exceeding the budget. Therefore, **per-turn retrieval will never exceed the maximum window size**, by construction.

### 9.2 Linear growth of total memory (no quadratic blow-up)

Assume an interaction of $T$ turns produces $O(1)$ events per turn on average (user msg, agent msg, plus a bounded number of tool calls/results under rate limits). The event store is append-only, so the number of stored events is $O(T)$.

Indexes are also linear or better:

- **Embeddings:** fixed-size vector per embedded event => $O(T)$ storage.
- **FTS indexes:** approximately linear in total stored text length => $O(T)$.
- **Derived objects:** if each episode/event produces at most a bounded number of derived records (decisions, episode summaries), derived storage is also $O(T)$.

Thus the total memory footprint grows **linearly with interaction length**, not quadratically. Quadratic growth would typically arise from repeatedly rewriting or duplicating prior content (e.g., compaction summaries that accumulate and get re-summarized), or from storing cross-products of relationships. TRACE avoids this by storing immutable events once and treating summaries/hierarchies as derived indexes.

### 9.3 Bounded total disk usage (policy, not wishful thinking)

Linear growth can still be large. TRACE therefore distinguishes:

- **Events:** small, mostly text + metadata; for personal assistants typically on the order of **~1--10 MB/day** depending on activity and logging density.
- **Artifacts:** potentially large (logs, datasets, screenshots); can dominate disk usage.
- **Indexes:** embeddings are fixed-size; FTS scales with text; both are predictable.

**Policy (practical boundedness):**
- Keep **events + indexes** indefinitely (small, high value).
- Apply **artifact lifecycle management**:
  - compress artifacts at ingestion (e.g., gzip/zstd),
  - archive artifacts older than $N$ days to cold storage,
  - optionally retain only hashes + metadata online after archival,
  - allow "rehydration" on demand when pointers are followed.

This yields bounded *hot* storage and predictable long-term growth.

(See **Annex A.7** for a concrete retention/archival policy and an accounting model.)

---

## 10. Token Savings Analysis (Production Data)

This section quantifies token dynamics using production figures from a personal AI agent deployment.

### 10.1 Baseline: narrative compaction in a 200K-token window

- **Context window:** 200K tokens.
- **Compaction trigger:** ~85% full.
- **Compaction output:** ~6K characters approximately  ~1.5K tokens.
- **Information preserved:** ~2% of the original (operationally useful detail), because most tool-output evidence and exact strings are dropped.

Two compounding effects make this worse than it appears:

1. **Token ratio is not information ratio:** tool logs are verbose but contain needles; summaries remove needles disproportionately.
2. **Loss compounds over multiple compactions:** summaries summarize summaries, and omissions become permanent.

If each compaction preserves ~2% of the operational detail from the compacted portion, then after 3 compactions the preserved fraction is roughly $0.02^3 = 8 \times 10^{-6}$ (approximately 0.0008%) of that detail---effectively total loss for long-horizon debugging tasks.

### 10.2 TRACE: pointer compaction + retrieval pack under the same window

Under TRACE in the same 200K-token setting:

- **Task State:** ~500 tokens (bounded, structured).
- **Pointers/manifests:** ~200 tokens (IDs + hints).
- **Per-turn retrieval pack:** ~4K tokens injected (bounded).
- **Information preserved:** 100% on disk (lossless store), and ~3% in-context---but it is the *right* 3% for the current turn.

TRACE adds a predictable retrieval cost (~4K tokens) that the baseline does not pay. However, the baseline pays an implicit cost in failure: lost evidence causes repeated tool calls, rework, and incorrect decisions.

### 10.3 Net effect over a 50-turn session with 3 compactions

- **Baseline:** compaction prevents overflow but permanently discards detail at each compaction; after 3 compactions, the cumulative loss is effectively ~99.99%+ of high-resolution evidence.
- **TRACE:** compaction evicts only from cache; **0% is permanently lost** (subject to explicit retention policy), and retrieval reintroduces the needed evidence on demand.

The engineering claim is not that TRACE "uses fewer tokens" per turn than baseline; it is that TRACE uses tokens to maintain *decision-critical evidence* rather than paying repeatedly for rediscovery after destructive summaries.

---

## 11. Implementation Considerations (Production-Oriented)

TRACE is deliberately implementable with standard components (relational store + FTS + vector search + blob storage) and can be deployed incrementally.

### 11.1 Minimal viable path (risk-managed)

A staged migration that yields early value:

1. **Lossless event store + artifactization (must-have):** persist all events; store large tool outputs as artifacts; record hashes and metadata.
2. **Pointer-based compaction (must-have):** replace narrative compaction at overflow with pointer manifests + preserved Task State.
3. **Mandatory per-turn retrieval (high value):** inject bounded retrieval packs every turn; log retrieval decisions for evaluation.
4. **Sleep consolidation (medium):** generate episode summaries, decision records, and multi-granularity indexes with provenance.
5. **Hierarchical planning support (optional but powerful):** planner/executor protocol and separate retrieval surfaces.

This sequence addresses the "only copy" catastrophe early: once the lossless store exists and compaction is pointer-based, overflow no longer destroys evidence.

### 11.2 Storage and indexing choices

A robust baseline architecture:

- **Event store:** SQLite/PostgreSQL for structured metadata + event text.
- **Full-text search:** FTS5 / BM25-style indexing over event text and selected artifact excerpts.
- **Vector search:** a local vector index (or a managed service) storing one embedding per event/summary object.
- **Artifact store:** filesystem/object store with compression; referenced by artifact IDs and hashes.

TRACE does not require exotic infrastructure; the core requirement is **write-once persistence + searchable indexes** before eviction.

### 11.3 Operational safeguards

- **Provenance everywhere:** derived objects reference source event IDs; retrieval packs include provenance markers to reduce "mystery memory."
- **Sensitivity labels:** events and artifacts carry privacy/security labels; retrieval can filter or redact.
- **Prompt-injection hygiene:** retrieved text is wrapped as non-executable evidence; instruction-like patterns can be sanitized or isolated.

---

## 12. Evaluation Framework

TRACE changes the failure mode from "irreversible forgetting" to "retrieval misses something," which is measurable and improvable. We recommend evaluation along four axes.

### 12.1 Information preservation under forced compactions ("needles")

Construct traces where needles (exact hashes, file paths, error lines) appear early, then flood the context with tool outputs to force multiple compactions. Measure exact-match recall after each compaction.

Compare:
- narrative compaction baseline,
- truncation baseline (drop history),
- TRACE pointer compaction + retrieval.

### 12.2 Retrieval quality and budgets

- precision@k / recall@k for injected evidence vs. labeled relevance sets,
- latency distributions (p50/p95),
- token accounting: fraction of window used by task state, retrieval, tail, and tool outputs.

### 12.3 Task continuity metrics

- number of clarifying questions after compaction,
- rate of repeated work ("we already tried that"),
- success rate on multi-hour debugging or integration tasks.

### 12.4 Hierarchical planning effectiveness

Evaluate planner/executor separation:

- does the planner remain stable and not drown in tool logs?
- do executors receive sufficient local context and constraints?
- are reports compact but provenance-linked enough for audit?

(See **Annex A.8** for a compaction stress test harness and hierarchical-planning evaluation scaffolding.)

---

## 13. Limitations (Including vs. Human Associative Memory)

TRACE is an engineering system built on explicit storage, indexes, and retrieval policies. It is not a human brain, and it should not be described as one.

### 13.1 What associations TRACE captures well

TRACE can capture and retrieve memories via a finite set of explicit pathways:

- **Explicit links:** event-to-decision, decision-to-rationale, artifact-to-event, supersession chains.
- **Semantic similarity:** embeddings over event text/excerpts.
- **Temporal proximity:** recency-biased retrieval, episode segmentation.
- **Task structure:** task IDs, task phases, constraints, and premise signatures.
- **Usage signals:** access frequency, "pinned" objects, reinforcement/decay.

These are strong, engineering-friendly association mechanisms that can be audited and tuned.

### 13.2 What associations TRACE cannot capture (and why that matters)

Humans form millions of associations across modalities and affective systems over a lifetime. TRACE will miss many connections a human would catch, including:

- **Emotional resonance and salience:** humans recall what felt important; TRACE needs explicit tags or indirect proxies.
- **Somatic markers and embodied cues:** bodily states influence recall; TRACE has no analogous signal unless instrumented.
- **Cross-modal associations:** images, sounds, spatial memory; TRACE can store artifacts but does not inherently link them as richly as humans do.
- **Serendipitous connections:** humans jump across distant concepts via dense neural associations; TRACE depends on limited relationship types and embedding geometry.

### 13.3 The "unknown unknowns" retrieval problem

Lossless storage does not guarantee recall. If no retrieval path leads to a memory, it is functionally forgotten---even if it exists on disk. This is the central residual risk TRACE introduces: correctness depends on retrieval quality and task-conditioned policies.

TRACE mitigates this by:
- storing pointer manifests at compaction boundaries,
- logging retrieval decisions for offline tuning,
- supporting drill-down from summaries to raw events via provenance,
- enabling hierarchical planning to keep each agent level's retrieval problem smaller.

But the limitation remains: **the system retrieves what it can score**, not what it "should have realized mattered."

### 13.4 Additional limitations

- **Indexing cost:** continuous embedding and indexing add compute/latency overhead; selective embedding and batching are necessary.
- **Security:** retrieval can inject adversarial text (indirect prompt injection); instruction isolation and provenance are required.
- **Privacy:** lossless stores raise retention stakes; explicit deletion/redaction policies must be implemented and audited.
- **Task State drift:** Task State is an interpretation layer; it can become stale or wrong. Versioning and provenance help but do not eliminate the risk.

---

## 14. Discussion

### 14.1 When narrative summaries still make sense

Narrative summaries remain useful as *derived views*:

- human handoffs and status updates,
- "what happened?" recaps,
- lightweight progress reports.

TRACE does not forbid summaries; it forbids treating them as canonical memory that replaces evidence.

### 14.2 Relationship to priority-aware identity preservation

TRACE focuses on lossless evidence retention, pointer compaction, and task-conditioned retrieval. Identity stability, persona drift detection, observational memory formats, and deeper priority scheduling are treated in the companion technical report (Serra, 2026). In practice, the systems are complementary: TRACE supplies the lossless substrate and bounded retrieval mechanics on which persona- and identity-aware context engineering can safely operate.

---

## 15. Conclusion

Narrative compaction is a convenient hack that becomes a structural liability in persistent, tool-using LLM agents: it destroys the only cognitively accessible copy of decision-critical evidence precisely when the system is most overloaded. TRACE replaces this failure mode by treating the context window as a cache over a lossless event store, implementing compaction as cache eviction with pointers, and injecting a bounded retrieval pack each turn.

TRACE extends the core thesis with three production-critical advances: **task-conditioned retrieval priority**, **hierarchical agent planning** with separate contexts, and explicit **boundedness guarantees** for both per-turn context and long-term storage growth. The result is a practical architecture that preserves evidence losslessly, retrieves selectively under hard budgets, and scales to long tasks without relying on irreversible summarization as "memory."

---

## References

1. Alqithami, S. (2025). *Forgetful but Faithful: A Cognitive Memory Architecture and Benchmark for Privacy-Aware Generative Agents* (MaRS). arXiv:2512.12856.
2. Anthropic Applied AI Team (2025). *Effective context engineering for AI agents*. Anthropic Engineering. `https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents`
3. Barnes, T. (2026). *Observational Memory: 95% on LongMemEval*. Mastra Research. `https://mastra.ai/research/observational-memory`
4. Fowler, M. (2005). *Event Sourcing*. `https://www.martinfowler.com/eaaDev/EventSourcing.html`
5. Kryscinski, W., McCann, B., Xiong, C., & Socher, R. (2020). *Evaluating the Factual Consistency of Abstractive Text Summarization*. EMNLP 2020.
6. Letta (2024). *MemGPT is now part of Letta*. `https://www.letta.com/blog/memgpt-and-letta`
7. Liu, N. F., Lin, K., Hewitt, J., et al. (2024). *Lost in the Middle: How Language Models Use Long Contexts*. TACL.
8. Maynez, J., Narayan, S., Bohnet, B., & McDonald, R. (2020). *On Faithfulness and Factuality in Abstractive Summarization*. ACL 2020.
9. Packer, C., Wooders, S., Lin, K., et al. (2023). *MemGPT: Towards LLMs as Operating Systems*. arXiv:2310.08560.
10. Sarthi, P., Abdullah, S., Tuli, A., Khanna, S., Goldie, A., & Manning, C. D. (2024). *RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval*. arXiv:2401.18059.
11. Serra, O. (2026). *Agent Memory: Priority-Aware Context Engineering for Persistent AI Identity*. Technical Report, OpenClaw.
12. Sumers, T. R., Yao, S., Narasimhan, K., & Griffiths, T. L. (2023). *Cognitive Architectures for Language Agents* (CoALA). arXiv:2309.02427.
13. Weaviate (2025). *Context Engineering --- LLM Memory and Retrieval for AI Agents*. `https://weaviate.io/blog/context-engineering`
14. Wu, D., Wang, H., Yu, W., et al. (2024). *LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory*. arXiv:2410.10813.
15. Xu, W., Liang, Z., Mei, K., et al. (2025). *A-MEM: Agentic Memory for LLM Agents*. arXiv:2502.12110.
16. Yan, S., Yang, X., Huang, Z., et al. (2025). *Memory-R1: Enhancing LLM Agents to Manage and Utilize Memories via Reinforcement Learning*. arXiv:2508.19828.
17. Yu, Y., Yao, L., Xie, Y., et al. (2026). *Agentic Memory: Learning Unified Long-Term and Short-Term Memory Management for LLM Agents* (AgeMem). arXiv:2601.01885.

---

# Annex A --- Algorithms (Pseudocode)

All algorithms are collected here to keep the main paper readable.

## A.1 Continuous ingestion and indexing (Layer 1)

```text
Algorithm A.1: INGEST_AND_INDEX(event)
Input: event = {kind, content, metadata, timestamp, session_id, turn_id}

1: event_id <- new_ulid()
2: if event.kind == tool_result and size(event.content) > ARTIFACT_THRESHOLD then
3:     artifact_id <- store_artifact(compress(event.content), metadata)
4:     event.content <- pointer("artifact", artifact_id)
5: end if

6: persist_event(event_id, event)                  // append-only
7: update_metadata_indexes(event_id, metadata)

8: text_for_search <- extract_text_for_search(event)  // may include excerpt for artifacts
9: update_fts_index(event_id, text_for_search)

10: if should_embed(event) then
11:     emb <- embed(extract_text_for_embedding(event))
12:     persist_embedding(event_id, emb)           // fixed-size vector
13: end if

14: return event_id
```

## A.2 Per-turn context pack builder (Layer 2)

```text
Algorithm A.2: BUILD_CONTEXT_PACK(user_msg, task_state, recent_tail, budgets)
Input:
  user_msg, task_state, recent_tail
  budgets = {B_sys, B_task, B_tail, B_ret, B_headroom}

Output: ordered context_pack

1: q <- build_query(user_msg, task_state, recent_tail)

2: C_vec <- vector_search(q.embedding, topN = N_vec, filters = task_state.filters)
3: C_fts <- fts_search(q.keywords, topN = N_fts, filters = task_state.filters)
4: C_ptr <- expand_pointers(task_state.key_events, task_state.key_artifacts)
5: C_pin <- pinned_objects(task_state.task_id, user_profile_id)

6: C <- dedupe(C_vec U C_fts U C_ptr U C_pin)

7: for item in C do
8:     base <- base_score(item, q)                         // sim, bm25, recency, type, freq
9:     mod  <- task_conditioned_modifier(item, task_state) // Algorithm A.3
10:    item.score <- base * mod
11: end for

12: S <- mmr_select(C, k = K_max, lambda = 0.7)            // relevance vs redundancy
13: R <- pack_under_budget(S, B_ret, per_type_quotas)

14: context_pack <- [
      SYSTEM_BLOCK(B_sys),
      TASK_STATE_BLOCK(task_state, cap=B_task),
      RETRIEVAL_BLOCK(R, cap=B_ret),
      RECENT_TAIL_BLOCK(recent_tail, cap=B_tail),
      USER_MESSAGE_BLOCK(user_msg)
    ]

15: assert token_estimate(context_pack) + B_headroom <= B_ctx
16: log_retrieval(task_state.task_id, R)
17: return context_pack
```

## A.3 Task-aware retrieval priority (task-conditioned modifier)

```text
Algorithm A.3: TASK_CONDITIONED_MODIFIER(item, task_state)
Inputs:
  item: memory candidate with metadata
    - kind/type (objective, decision, mistake, tool_result, etc.)
    - task_id, episode_id
    - premise_ref (task_state_version_id at write time)
    - supersedes / superseded_by links
    - utility_tags (e.g., "needed_for_final_report")
  task_state: current task state (includes phase, requirements, premises)

Output:
  modifier m >= 0

1: if item.task_id != task_state.task_id and not cross_task_allowed(item, task_state) then
2:     return 0.0
3: end if

4: m <- 1.0

5: // Supersession: prefer latest versions
6: if item.is_superseded and not task_state.request_historical_versions then
7:     m <- m * 0.1
8: end if

9: // Premise compatibility: downweight items produced under incompatible assumptions
10: compat <- premise_compatibility(item.premise_ref, task_state.current_premises)
11: m <- m * compat                                      // compat in [0,1]

12: // Phase salience: map task phase to preferred memory types
13: m <- m * phase_salience(task_state.phase, item.type) // e.g., planning favors summaries/decisions

14: // Expected future needs: if task requires postmortem/self-assessment, keep mistakes salient
15: if task_state.requires_self_assessment and item.type in {"mistake","success","lesson"} then
16:     m <- m * 2.0
17: end if

18: // Guardrails: never crowd out hard constraints
19: if item.type == "constraint" then
20:     m <- max(m, 3.0)
21: end if

22: return clamp(m, 0.0, M_MAX)
```

## A.4 Pointer-based compaction (cache eviction + manifest)

```text
Algorithm A.4: POINTER_COMPACT(cache, task_state, B_ctx, B_headroom)
Input:
  cache: ordered in-context blocks
  task_state
  B_ctx: max tokens
  B_headroom: reserved tokens

Output: compacted cache

1: while token_estimate(cache) > (B_ctx - B_headroom) do
2:     victim_span <- choose_victim(cache)
        // heuristic: oldest tool_results > oldest tool_calls > oldest dialogue
        // never evict: system block, task_state, last-k turns
3:     ensure_persisted_and_indexed(victim_span.event_ids)  // Layer 1 invariant
4:     remove(cache, victim_span)

5:     manifest <- {
         evicted_event_ids: victim_span.event_ids,
         anchor_events: select_anchors(victim_span, task_state),
         artifacts: extract_artifact_refs(victim_span),
         task_state_ref: task_state.version_id,
         hints: derive_hints(victim_span)
       }

6:     insert_manifest(cache, manifest, position=victim_span.start_position)
7: end while

8: return cache
```

## A.5 Hierarchical planning protocol (planner <-> executor)

```text
Algorithm A.5: HIERARCHICAL_PLANNING_LOOP(planner_task_state)
1: planner forms plan with subtask list S
2: for each subtask s in S do
3:     delegation_packet <- {
         subtask_id, objective, constraints, acceptance_criteria,
         pointers_to_relevant_events, pointers_to_artifacts,
         plan_node_ref
       }
4:     send_to_executor(delegation_packet)
5: end for

6: while not all subtasks complete do
7:     report <- receive_executor_report()
8:     validate(report.acceptance_evidence via provenance pointers)
9:     update planner_task_state (milestones, risks, next subtasks)
10: end while
```

## A.6 Multi-granularity retrieval with drill-down

```text
Algorithm A.6: MULTI_GRANULARITY_RETRIEVE(query, task_state, B_ret)
1: classify query specificity: {exact, local, thematic, strategic}
2: if specificity == strategic then
3:     candidates <- retrieve_strategic_insights(task_state)
4: else if specificity == thematic then
5:     candidates <- retrieve_topic_summaries(task_state)
6: else
7:     candidates <- retrieve_raw_events_and_artifacts(query, task_state)
8: end if

9: pack <- pack_under_budget(candidates, B_ret)

10: if confidence(pack) < THRESH or user asks "show exact" then
11:     drill <- retrieve_raw_supporting_events(pack.provenance, cap=B_ret/2)
12:     pack <- merge(pack, drill) under budget
13: end if

14: return pack
```

## A.7 Retention and bounded hot-storage policy (artifacts)

```text
Algorithm A.7: ARTIFACT_LIFECYCLE_POLICY(now)
Parameters:
  N_days_hot, compression, cold_storage_backend

1: for each artifact a where age(a) > N_days_hot do
2:     if not archived(a) then
3:         move_to_cold_storage(a.bytes, compress=compression)
4:         keep_online_metadata(a.id, a.sha256, a.mime_type, a.size, a.created_at)
5:         optionally delete_online_bytes(a.id)
6:     end if
7: end for
```

## A.8 Compaction stress test harness ("needles in a haystack")

```text
Algorithm A.8: COMPACTION_STRESS_TEST(policy, needles, bloat_rounds)
1: trace <- generate_base_trace()
2: inject needles early (hashes, exact error lines, file paths)

3: for i = 1..bloat_rounds do
4:     trace <- trace + generate_tool_bloat()
5:     if would_overflow(trace) then
6:         trace <- apply_policy(policy, trace)
7:     end if
8: end for

9: for each needle in needles do
10:    ask recall query requiring exact match
11:    score exact-match accuracy
12: end for

13: return aggregate scores + token accounting + retrieval logs
```
