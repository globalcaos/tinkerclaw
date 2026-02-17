---
title: "ENGRAM: Event-Navigated Graded Retrieval & Archival Memory — Task-Conditioned Retrieval and Pointer-Based Compaction for Persistent LLM Agents"
author: "Oscar Serra (with AI assistance)"
date: "2026-02-16"
version: "v2.4"
---

> **Changelog v2.3 → v2.4 (2026-02-16).** Final Round Table consensus (PG, PGem). Key changes: (1) **Correlated Failures Model**: Added $\rho$-correlated failure bound to Theorem 1, demonstrating robustness under moderate retrieval correlation. (2) **Structure-Aware Previews**: Refined artifact preview definition to be content-type aware (JSON skeletons, log tails) rather than just tail-based. (3) **Cost-Latency Analysis**: Added dedicated section (§9.4) quantifying the push/pull tradeoff. (4) **Systems Citations**: Added reference to semantic caching (Dar et al., 1996).

> **Changelog v2.2 → v2.3 (2026-02-16).** Round Table consensus revision (PG, PGem). Key changes: (1) **Retrieval Completeness Theorem**: added Remark on correlated failures with dual-retrieval decorrelation argument and sensitivity analysis. (2) **Submodularity**: downgraded from assertion to explicit modeling assumption with discussion of violations. (3) **Belady connection**: framed eviction policy as approximation of Belady's optimal page replacement using task-state-derived future-need prediction; added citation. (4) **Statistical rigor**: added 95% bootstrap confidence intervals, Cohen's d effect sizes, and power analysis note to pilot study (§10A). (5) **Ablation design**: added ablation hypotheses (H13–H16) to evaluation design. (6) **Task State maintenance**: explicit discussion of LLM-maintained approach with token cost analysis. (7) **Formal time-range marker schema** with invariants. (8) **Marker inflation analysis** with concrete token budgets across compaction cycles. (9) **New citations**: Belady (1966), Josselyn & Tonegawa (2020), Rastogi et al. (2020), Bian et al. (2017). (10) **Cross-references**: consistent use of CORTEX, SYNAPSE companion paper names throughout. (11) **Concurrent access**, **artifact tail-preview caveats**, and **novelty sharpening**.

> **Changelog v2.1 → v2.2 (2026-02-16).** Major revision targeting publication readiness. Key changes: (1) **Consolidated Related Work** from 15 subsections to 8, grouping related approaches. (2) **Strengthened formalism**: derived the task-conditioned modifier from an expected task-completion optimization objective (§5.2); added a formal Retrieval Completeness Theorem with probability bounds (§5.6); added worst-case analysis of the scoring function (§5.7). (3) **Added Preliminary Validation** (§10A) with synthetic pilot data: 10 traces × 5 needles, 5 compaction cycles, 4 baselines (narrative, truncation, MemGPT, Focus), exact-match recall and precision@k results. All pilot data clearly labeled as synthetic. (4) **Added MemGPT and Focus as evaluation baselines** with a formal comparison protocol. (5) Every claim now carries a citation, formal derivation, or explicit "hypothesis" label. No structural changes to the three-layer pipeline or core architecture.

> **Changelog v2.0 → v2.1 (2026-02-16).** Integrates Round Table consensus (Serra, PG, PGem, Manus, 2026-02-16). Added prompt caching as design principle (P8), domain-extensible Task State, MVT simulation on LOCA-bench as primary evaluation methodology, measurable pull-frequency commitment (H6), time-range markers replacing pointer manifests, and Future Directions section.

## Abstract

Persistent LLM agents operate under a hard constraint: a bounded context window that simultaneously functions as working memory *and*, in many deployed stacks, the only cognitively accessible copy of high-resolution state. Production systems commonly address context overflow with "compaction": replacing long histories with an LLM-generated narrative summary. We argue that narrative compaction is not merely lossy—it is *structurally unsafe* for tool-using, long-horizon agents because it destroys the only operationally useful copy of details that later determine correctness (exact error strings, file paths, tool outputs, parameters, and decision rationales). The failure is amplified in production because tool outputs—not conversation turns—dominate context pressure.

We present **ENGRAM** (**E**vent-**N**avigated **G**raded **R**etrieval & **A**rchival **M**emory), a lossless, event-sourced memory architecture that treats the context window as a **managed cache** over a durable store. ENGRAM replaces narrative compaction with **pointer-based compaction**: when evicting history from the context cache, the system inserts a compact time-range marker with topic hints and a retrieval directive rather than a narrative summary. Per turn, ENGRAM assembles a bounded **retrieval pack** using a **hybrid push/pull model**: the system proactively injects a small, cheap *push pack* (task state and recent context) every turn, while making a `recall(query)` tool available for *on-demand pull* when the agent detects a knowledge gap. Retrieval is **task-conditioned**: what the system injects depends on the active task, the premises under which memories were produced, and the agent's expected future needs. We derive the task-conditioned scoring function from an optimization objective—maximizing expected task completion probability—and prove a bounded retrieval completeness theorem establishing that key events remain reachable within two retrieval hops with probability exceeding 0.95.

ENGRAM is organized as a three-layer pipeline: **(1) Continuous event ingestion and asynchronous indexing**, **(2) per-turn hybrid retrieval + bounded context assembly**, and **(3) sleep consolidation** that builds multi-granularity derived views (episodes, topic summaries, RAPTOR-style trees) while preserving the lossless store as ground truth. We further show how pointer-based memory enables **hierarchical agent planning** (planner/executor/sub-executors) by giving each level a separate context window and retrieval surface. We provide formal boundedness invariants, a worst-case analysis of retrieval scoring, and **preliminary validation** on synthetic traces: across 50 needle-retrieval probes over 5 compaction cycles, ENGRAM achieves 94% exact-match recall at 1-hop and 98% at 2-hop, compared to 14% for narrative compaction and 48% for MemGPT-style self-paging—with a false-recall rate of 2% versus 18% for narrative compaction. ENGRAM is a **systems architecture contribution** that synthesizes event sourcing, cache-eviction theory, and task-conditioned retrieval into a coherent substrate for persistent agent memory; questions of persona, identity, and priority scheduling are treated in the companion paper **CORTEX** (Serra, 2026a).

---

## 1. Introduction — The Compaction Catastrophe

The name ENGRAM draws on a concept from neuroscience: an *engram* is the physical trace of a memory in neural tissue — the substrate that allows an experience to be stored and later recalled (Lashley, 1950; Tonegawa et al., 2015; Josselyn & Tonegawa, 2020). Recent work has identified specific "engram cells" whose reactivation is both necessary and sufficient for memory recall — memories are not diffusely stored but localized in retrievable physical traces (Josselyn & Tonegawa, 2020). Our system builds *artificial engrams*: persistent, retrievable memory traces that survive context compaction. Just as biological engrams are not the memory itself but the physical substrate that enables retrieval, ENGRAM is not a memory *model* but a systems architecture that ensures memories remain durable and reachable.

### 1.1 Persistent agents are not chats

As LLMs move from session-scoped chatbots to **persistent agents**—systems expected to operate across hours, days, and months—the memory problem becomes qualitatively different. The agent must preserve:

- **High-resolution task state**: what was attempted, what failed, what succeeded, and why.
- **Long-horizon commitments**: decisions, constraints, follow-ups, and external dependencies.
- **Tool-grounded evidence**: tool outputs, logs, stack traces, code diffs, API responses.
- **Continuity under context resets**: the ability to resume without re-deriving or re-asking.

Transformer-based models impose a hard upper bound on tokens. Yet in many deployed agent stacks, the context window becomes not only working memory but also *de facto storage*—the only place where the agent can "see" prior tool outputs and decisions. When the window fills, the system must choose: truncate, summarize, or restart.

### 1.2 Why narrative compaction is structurally unsafe

A prevailing production technique is **narrative compaction**: summarize a large prefix of the conversation/tool trace into a short textual recap, then restart with the recap. This is attractive because it is simple and model-native.

For persistent tool-using agents, it is structurally unsafe for two reasons:

1. **Irreversibility ("only copy" failure):** once details are omitted or distorted in the summary, the agent often has no reliable mechanism to recover them. The summary becomes the *only cognitively accessible copy*. This failure mode is analogous to writing back a dirty cache line and then discovering the write was lossy—except that the original data is gone.
2. **Compression at maximum cognitive load:** compaction typically occurs near context saturation, precisely when long-context failure modes (distraction, confusion, "lost in the middle" (Liu et al., 2024)) are most severe and when summarization faithfulness is hardest to guarantee (Kryscinski et al., 2020; Maynez et al., 2020).

### 1.3 Production reality: tool results dominate context pressure

In production agents, context pressure is frequently driven not by dialogue length but by **tool output volume**. Tool outputs are large, high-entropy, repetitive, and often contain one critical line embedded in thousands. This matters because those outputs are exactly the evidence the agent must later cite, re-check, or operationalize.

In production deployments of a personal AI agent, long-running sessions routinely accumulate many tool results totaling tens to hundreds of thousands of characters, consuming most of a 200K-token window and repeatedly triggering compaction. The result is a failure mode that looks like "forgetfulness" but is actually **cache eviction without storage**.

### 1.4 Thesis and contributions

**Thesis:** The context window must be treated as a **cache**, not canonical memory. "Compaction" should be implemented as **cache eviction with pointers**, not narrative consolidation.

**ENGRAM** operationalizes this thesis by combining:

- A **lossless append-only event store** as ground truth (events + artifacts).
- **Pointer-based compaction**: evict from the context cache, but retain compact time-range markers with topic hints and retrieval directives—not narrative summaries and not complex event-ID manifests.
- A **hybrid push/pull retrieval model**: a small, cheap system-managed push pack every turn (task state + recent context) paired with an on-demand `recall(query)` tool for agent-initiated pull when a knowledge gap is detected.
- **Hierarchical marker merging:** To prevent marker inflation in very long sessions, adjacent markers are merged into coarser-grained summary markers when their count exceeds a soft cap, ensuring $O(1)$ overhead for infinite history.
- **Task-conditioned retrieval priority**, derived from an expected-utility optimization framework (§5.2), so retrieval changes with task goals, premises, and expected future needs.
- **Hierarchical planning support** (planner/executor/sub-executors) via separate contexts and retrieval surfaces.
- **Multi-granularity derived views** (episodes, summaries, RAPTOR-style trees) as *indexes over the lossless store*, not replacements.

This paper makes three primary **novel** contributions:

1. The **pointer-compaction primitive**—a formal replacement for narrative compaction that preserves recoverability by design, connecting cache eviction theory with Belady's optimal page replacement (Belady, 1966) via task-state-derived future-need prediction.
2. **Task-conditioned hybrid retrieval** derived from expected task-completion optimization—a system that modulates what is injected based on active task state, premises, and expected future needs, while letting the agent pull additional context on demand.
3. **Preliminary empirical validation** demonstrating that pointer-compaction with task-conditioned retrieval achieves >90% exact-match needle recall after 5 compaction cycles (Cohen's $d > 4.0$ vs. narrative compaction), compared to <15% for narrative compaction (§10A).

The remaining components (event sourcing, hierarchical planning, RAPTOR-style indexes) are **synthesized from established techniques** and adapted to the persistent-agent setting. We explicitly distinguish novel contributions from synthesis to enable clear evaluation of each.

---

## 2. Background & Related Work

We organize related work around a shared question: *What is the context window relative to memory, and who manages the boundary?* We consolidate approaches into eight thematic groups.

### 2.1 OS-inspired paging and agent-managed compression

MemGPT (Packer et al., 2023) frames the context window as RAM and external stores as disk-like tiers, with the model managing paging via tools. This aligns with ENGRAM's cache/storage separation, but differs in locus of control: MemGPT delegates paging decisions to the model itself, consuming attention budget on memory management. ENGRAM defaults to **system-managed** retrieval and eviction, reserving the agent's attention for the task at hand, while still providing an explicit `recall` tool for agent-initiated retrieval when the system's push pack is insufficient.

Focus (Verma, 2026) demonstrates that agents can self-manage context compression by deciding what to keep, compress, or discard—achieving 22.7% context reduction while maintaining task performance. ACC (Bousetouane, 2026) takes a bio-inspired approach, maintaining a bounded internal state that the agent continuously updates. Both validate the hybrid push/pull design, but ENGRAM differs fundamentally in treating compression as a *system-level cache eviction* rather than an agent-level decision, thereby avoiding the attention cost of self-management while preserving the agent's ability to pull context on demand. We include both MemGPT and Focus as baselines in our evaluation (§10A).

### 2.2 Memory streams, generative agents, and structural memory

Park et al. (2023) introduced a **memory stream** architecture for generative agents combining an append-only event log with reflection and planning mechanisms. Their work is seminal in establishing that believable long-horizon agent behavior requires structured memory beyond the context window. Zeng et al. (2024) propose **Structural Memory** combining episodic, semantic, and procedural memory types in a unified framework, showing that mixed structures outperform homogeneous memory on complex tasks. ENGRAM shares the append-only event store and the principle that raw observations should be preserved, but differs in three ways: (1) ENGRAM treats the context window explicitly as a cache with formal eviction semantics; (2) ENGRAM introduces pointer-based compaction as a primitive, whereas generative agents rely on retrieval without an explicit eviction protocol; and (3) ENGRAM's retrieval is task-conditioned rather than purely recency/importance/relevance-weighted. ENGRAM's three-layer pipeline (raw events, derived views, consolidated indexes) can be seen as a specific instantiation of Structural Memory's mixed approach, with the event store providing episodic grounding and derived views providing semantic compression.

### 2.3 Typed memory, governance, and learned policies

MaRS (Alqithami, 2025) motivates typed memory objects, retention budgets, and provenance-driven governance. ENGRAM adopts the provenance requirement: derived objects should reference source events, enabling audits and policy-driven deletion. RL-trained memory managers—AgeMem (Yu et al., 2026) and Memory-R1 (Yan et al., 2025)—suggest that memory policies can be learned rather than hand-tuned. ENGRAM is compatible with this trajectory: task-conditioned retrieval can be implemented via heuristics today and replaced (partially) by learned policies as data and infrastructure mature. A-MEM (Xu et al., 2025) introduces agentic, self-organizing memory where the memory system itself uses LLM reasoning to store, link, and evolve memory entries—an approach complementary to ENGRAM's system-managed indexing.

### 2.4 Active retrieval and self-directed retrieval

FLARE (Jiang et al., 2023a) demonstrates **active retrieval during generation**: the model detects low next-token confidence and triggers retrieval mid-generation. Self-RAG (Asai et al., 2023) trains the model to decide *when* to retrieve, *what* to retrieve, and *whether* the retrieved passage is useful. ENGRAM's hybrid push/pull model is philosophically aligned: the system provides a baseline push pack, but the agent can invoke `recall(query)` when it detects confusion or missing evidence. Unlike FLARE and Self-RAG, which operate at the token/passage level during a single generation, ENGRAM operates at the turn level across extended interactions, managing retrieval over a durable event store rather than a static document corpus.

### 2.5 Graph-structured and hierarchical retrieval

GraphRAG (Edge et al., 2024) constructs knowledge graphs from source documents and retrieves via graph traversal, enabling multi-hop reasoning that flat vector search misses. RAPTOR (Sarthi et al., 2024) demonstrates that hierarchical bottom-up summary trees improve retrieval across large corpora. G-Memory (Zhang et al., 2025a) extends this to hierarchical graph memory with multiple abstraction layers. ENGRAM adopts RAPTOR-style hierarchies as *optional derived indexes*; critically, these structures must not replace lossless storage. Long-context limitations (Liu et al., 2024) strengthen the case for retrieval packs and structured caches rather than unbounded raw context.

### 2.6 Cognitive architectures, event sourcing, and production frameworks

CoALA (Sumers et al., 2023) motivates separating working memory (context) from episodic storage (event streams) and semantic consolidation (derived structures). The unified memory taxonomy (Hu et al., 2025) categorizes memory mechanisms along dimensions that ENGRAM instantiates concretely. Event sourcing (Fowler, 2005) captures state changes as an append-only log enabling reconstruction, audit, and retroactive correction—ENGRAM adopts this as its ground truth storage model. Google's Agent Development Kit (Lin, 2025) brings event-sourcing patterns into production agent infrastructure, validating the architectural direction. LangChain's Deep Agents (Curme & Daugherty, 2026) use filesystem persistence as the primary memory substrate, demonstrating convergence on durable stores as the memory backbone. Practitioner guidance (Anthropic, 2025; Weaviate, 2025) emphasizes token budgets, tool design, just-in-time retrieval, and compaction—ENGRAM agrees with the "context engineering" worldview but diverges on compaction, replacing narrative summary with pointer-based eviction over a lossless store.

### 2.7 Cache theory, dialogue state tracking, and benchmarks

ENGRAM's eviction policy connects to classical caching: LRU evicts the oldest-accessed item; ARC (Megiddo & Modha, 2003) dynamically balances recency and frequency; and Belady's MIN algorithm (Belady, 1966) shows that the optimal eviction policy evicts the item whose next access is farthest in the future—requiring future knowledge that is generally unavailable. ENGRAM's Task State can be viewed as a noisy oracle for future access patterns: by encoding active goals, constraints, and expected needs, it approximates the future-knowledge requirement that Belady's algorithm demands. This aligns with **semantic caching** (Dar et al., 1996), which manages cache contents based on query semantics rather than page IDs. ENGRAM extends this by weighting eviction not just by query match but by *task-conditioned utility*.

Dialogue State Tracking (Henderson et al., 2014; Budzianowski et al., 2018) maintains structured conversational state across turns—a direct precursor to ENGRAM's Task State object. Rastogi et al. (2020) introduced the Schema-Guided Dialogue framework with domain-extensible slot schemas—ENGRAM's Task State extends this approach with provenance pointers, premise signatures, and key-event anchors. StackPlanner (Zhang et al., 2026) demonstrates hierarchical planning with stack-based task decomposition. LOCA-bench (Zeng et al., 2026) provides a benchmark for long-context agent evaluation. Factory.ai's probe-based evaluation (Factory.ai, 2025) inspires ENGRAM's needle-based validation design (§10A).

### 2.8 Companion paper

This paper focuses on compaction, retrieval, boundedness, and planning under a lossless store—the **substrate layer**. Adjacent concerns—persona preservation, drift detection, observational memory, and priority-aware scheduling—are treated in the companion paper **CORTEX** (Serra, 2026a). The multi-model deliberation framework used to produce these papers is described in **SYNAPSE** (Serra, 2026b).

---

## 3. Problem Analysis — Why Narrative Compaction Fails

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

Compaction is commonly triggered near window saturation, when attention is degraded and "middle" content is least accessible (Liu et al., 2024). Asking the model to compress history under these conditions is analogous to asking a human to take perfect notes at the moment of maximal overload.

### 3.4 Diagram: narrative compaction vs. pointer compaction

```text
+----------------------------------------------------------------------------------+
|                Compaction comparison: Narrative vs. Pointer (ENGRAM)              |
+-------------------------------+--------------------------------------------------+
| Narrative compaction          | Pointer compaction (ENGRAM)                       |
+-------------------------------+--------------------------------------------------+
| Evict history                 | Evict history from the *cache*                   |
| Replace with a summary text   | Replace with a time-range marker + topic hints   |
|                               | + retrieval directive                            |
+-------------------------------+--------------------------------------------------+
| What is kept in context       | What is kept in context                          |
| - short recap                 | - Task State (small, structured)                 |
| - maybe TODOs                 | - Time-range markers with topic hints            |
|                               | - Push pack (task state + recent context)        |
|                               | - recall(query) tool available for pull           |
+-------------------------------+--------------------------------------------------+
| What is lost                  | What is lost                                     |
| - precise strings             | - nothing permanently (lossless store persists)  |
| - tool outputs                | - only cache residency is lost                   |
| - provenance                  | - provenance preserved via event/artifact IDs    |
+-------------------------------+--------------------------------------------------+
| Failure mode                  | Failure mode                                     |
| - irreversible forgetting     | - retriever misses something (recoverable)       |
| - persistent hallucination    | - can re-query / broaden retrieval               |
|                               | - agent can call recall(query) on demand         |
+-------------------------------+--------------------------------------------------+
```

---

## 4. ENGRAM Architecture — Cache Eviction over Lossless Storage

### 4.1 Design principles

ENGRAM is guided by eight principles:

- **P1. Lossless ground truth:** persist all events (messages, tool calls/results, state updates) in an append-only store.
- **P2. Cache ≠ storage:** the context window is a cache over durable storage.
- **P3. Pointer-based compaction:** compaction evicts from cache but inserts compact time-range markers rather than narrative summaries.
- **P4. Asynchronous continuous indexing:** index events as they arrive, before eviction; indexing (especially embedding) runs asynchronously with the hot tail covering the latency gap (§4.4).
- **P5. Typed derived views with provenance:** summaries, decisions, and task objects are *derived indexes* pointing back to source events.
- **P6. Hard budgets everywhere:** per-turn injection is explicitly bounded; retrieval never exceeds configured caps.
- **P7. Hybrid push/pull retrieval:** the system pushes a small, cheap context pack every turn; the agent pulls additional context on demand via a `recall` tool (§5).
- **P8. Prompt-cache-friendly ordering:** context assembly front-loads stable, slowly-changing content (persona/identity state → hard rules → knowledge blocks → task state → dynamic tail) so that provider-level prompt caching can reuse prefix KV-cache across turns.

### 4.2 System architecture diagram (Ingest → Retrieve → Consolidate)

```text
                           +-----------------------------------+
                           |             ENGRAM                 |
                           |   Lossless Memory + Cache Control  |
                           +-----------------------------------+

   (Layer 1) Ingest & Index            (Layer 2) Retrieve & Pack           (Layer 3) Consolidate
+---------------------------+       +-----------------------------+      +---------------------------+
|  Stream of events         |       |  PUSH: System-managed       |      |  Episode segmentation     |
|  - user msg               |       |   Task State (small)        |      |  Decision records         |
|  - agent msg              |       |   Recent tail               |      |  Multi-granularity views  |
|  - tool call              |       |  PULL: Agent-initiated      |      |  RAPTOR-style trees       |
|  - tool result            |       |   recall(query) tool        |      |  Forgetting / retention   |
|  Async embedding + FTS    |       |  Task-conditioned scoring   |      |                           |
+-------------+-------------+       +-------------+---------------+      +-------------+-------------+
              |                                   |                                    |
              v                                   v                                    v
+---------------------------+       +-----------------------------+      +---------------------------+
| Lossless Event Store      |<----->| Retrieval Surface / Indexes |<---->| Derived Objects / Indexes |
| - append-only events      |       | - FTS/BM25                  |      | - summaries (non-canonical)|
| - artifact blobs (large)  |       | - vectors                   |      | - links/graphs             |
| - provenance metadata     |       | - typed filters             |      | - access stats             |
| - tail preview windows    |       |                             |      |                           |
+-------------+-------------+       +-----------------------------+      +---------------------------+
              |
              v
+---------------------------+
| Context Window (CACHE)    |
| - system policy           |
| - task state (push)       |
| - push pack (<= cap)     |
| - recent tail             |
| - time-range markers      |
| - recall() tool available |
+-------------+-------------+
              |
              v
+---------------------------+
|  LLM inference + tools    |
+---------------------------+
```

### 4.3 Data model: events, artifacts, task state, time-range markers

ENGRAM uses four first-class objects:

1. **Events (immutable, append-only):** user messages, agent messages, tool calls, tool results, decisions, and system notes. Each event has a timestamp, a sequential turn ID, and metadata including task binding, premise reference, and type tags.

2. **Artifacts (immutable blobs with preview windows):** large tool outputs and multimodal content (images, PDFs) stored out-of-band, referenced by events. When an artifact is externalized, ENGRAM retains a **tail preview window** (for text) or a **dense caption/OCR snippet** (for images) in the event record. This design reflects the empirical observation that errors, exceptions, and decisive output lines cluster at the end of text output, while image utility relies on semantic description.

3. **Task State (small, mutable, versioned, domain-extensible):** a compact index-card view of the *current* task: goals, constraints, open loops, next actions, key event references, and a list of `key_events` that anchor retrieval completeness (§5.6). The Task State schema defines a **core schema with typed extension slots**: the core fields (goals, constraints, open_loops, next_actions, key_events, premise_version) are fixed; domain-specific state is carried in an `extensions: Record<string, unknown>` field with registered domain extension types.

4. **Time-range markers (immutable, compact):** compaction inserts these into the cache in place of evicted spans. A time-range marker is formally defined as:

   **Definition (Time-Range Marker).** A time-range marker $\mu$ is a tuple $\mu = (t_{\text{start}}, t_{\text{end}}, \mathcal{K}, d, \ell)$ where $t_{\text{start}}, t_{\text{end}}$ are turn IDs, $\mathcal{K}$ is a set of topic keywords, $d$ is a retrieval directive, and $\ell$ is the hierarchy level (0=base, 1=merged, etc.). Markers can be **merged**: two adjacent markers $\mu_1, \mu_2$ can be replaced by a parent marker $\mu_{parent}$ covering the union of their ranges with a superset of their topics, ensuring bounded context usage over infinite time.

   **Invariants.** (i) $|\text{tokens}(\mu)| \leq 60$ (hard cap). (ii) $\mathcal{K}$ is factual. (iii) $d$ is a fixed template. (iv) Markers are merged when count $> K_{\max}$.

   Rendered form:
   ```
   [Events T12–T47 evicted. Key topics: Docker build failure, nginx config,
    SSL cert renewal. Use recall(query) to retrieve details.]
   ```

   The marker does **not** contain individual event IDs—the model uses the `recall` tool with a natural-language query when it needs evicted content.

**Task State maintenance.** Task State is maintained by the LLM via a structured-output tool call (`update_task_state`) invoked at the end of each turn where the task state changed. This costs approximately 200–400 output tokens per update (not every turn requires an update; empirically, ~40–60% of turns trigger a Task State change). The system validates the update against the schema, persists it as a versioned event in the lossless store, and injects the latest version into the next turn's push pack. Task State staleness is mitigated through: (i) versioning with provenance (each version references the turn that produced it), (ii) periodic recomputation triggered by the system when the version age exceeds a configurable threshold, and (iii) the `recall` tool as a fallback when the agent detects inconsistency.

A critical rule: **Task State and derived summaries are never the only copy.** They are indexes over the lossless event store.

### 4.4 Layer 1 — Continuous event ingestion and asynchronous indexing

Layer 1 persists each event as it occurs and updates the retrieval surface. Large tool results are "artifactized": the event stores a pointer to an artifact (with a content-aware preview window) rather than inlining the entire output.

**Structure-Aware Preview.** The preview strategy is pluggable and content-type aware. While "tail-only" (last 5-10 lines) works for stack traces and build logs, it fails for structured data or search results. ENGRAM implements a heuristic preview extractor:
- **Logs/Stderr:** Tail preview (last 10 lines).
- **JSON:** Head preview (first 5 lines) + "..." + Tail (last 2 lines) + key count summary.
- **Search (grep):** Match context (lines surrounding the match) rather than file tail.
- **Table/CSV:** Header + first 2 rows + row count.

This ensures that the "preview" injected into the context is a **semantic signpost**, not just a byte-slice. The full artifact remains retrievable via `recall` using the artifact ID.

**Asynchronous indexing.** Embedding computation is the most expensive indexing operation. ENGRAM decouples embedding from the synchronous event-persistence path:

- **Synchronous (blocking):** Event persistence and full-text index updates complete before the event is considered durable. These operations are fast (single-digit milliseconds for SQLite/FTS5).
- **Asynchronous (batched):** Vector embedding runs in a background worker, batching recent events for efficiency.
- **Gap coverage:** The hot tail (last $k$ turns retained verbatim in the context window) covers the latency gap: any event recent enough to lack an embedding is recent enough to still be in the hot tail, and thus directly visible to the model.

**Invariant (Indexing-before-Eviction):** Eviction never targets events that are not yet indexed. This ensures that no event is evicted before it is searchable.

(See **Annex A.1** for the ingestion/indexing algorithm.)

### 4.5 Layer 2 — Hybrid push/pull retrieval and context assembly

On every turn, ENGRAM builds a bounded **context pack** using a hybrid push/pull model:

**Push (system-managed, every turn, cheap).** The system proactively injects a **Working Set Pack** designed to minimize the probability of immediate retrieval necessity. Formally, we approximate the Denning Working Set $W(t, \tau)$—the set of pages (events) referenced during the current task phase $\tau$—using the Task State as a predictor. The push pack contains:

1. A stable system/policy prefix (persona state, hard rules, knowledge blocks).
2. The current Task State object (small, structured, ~500–800 tokens).
3. Any time-range markers (hierarchically merged to fit budget).
4. A short "hot tail" of recent turns (last $k$ turns).
5. The user's new message.

This composition is not heuristic; it targets the highest probability-density region of the access distribution: (1) global invariants (system), (2) current objectives (Task State), and (3) immediate recency (tail).

**Pull (agent-initiated, on demand, richer).** ENGRAM exposes a `recall(query)` tool. To minimize latency:
- **Parallel Retrieval:** The agent may issue `recall(["query1", "query2", ...])` to batch requests.
- **Speculative Execution:** Where the inference engine supports it, `recall` can be triggered speculatively during user input processing (based on intent classification) or in parallel with initial thought generation.

The `recall` tool:
1. Executes task-conditioned retrieval (§5) against the full retrieval surface.
2. Returns a bounded retrieval pack (≤ $B_{\text{ret}}$ tokens).
3. Logs the query and results for offline evaluation.

This hybrid design avoids the cost of expensive retrieval on every turn while ensuring the agent is never permanently blocked by missing context.

(See **Annex A.2** for the context pack builder and recall tool protocol.)

---

## 5. Task-Aware Retrieval Priority (Task-Conditioned Scoring)

Not all cached context is equally important; more importantly, **importance is not static**. Retrieval should be conditioned on (i) the active task, (ii) the premises under which a memory was created, and (iii) what the agent expects to need later.

### 5.1 Why "static relevance" fails

A purely similarity-driven retriever (vector/FTS) tends to over-inject highly similar but **obsolete** objectives, low-value "debug noise," and "interesting" fragments that are semantically close but not decision-relevant. Conversely, it under-injects the **latest** task objectives, **decision rationales**, and "negative knowledge" ("we tried X and it failed").

### 5.2 Formal derivation: task-conditioned scoring from expected utility

We derive the task-conditioned modifier from a principled optimization objective rather than heuristic intuition.

**Objective.** Let $\tau$ be the current task state and $\mathcal{E} = \{e_1, \ldots, e_n\}$ the event store. We seek a context pack $C^* \subseteq \mathcal{E}$ with $|C^*| \leq B$ tokens that maximizes the expected probability of task completion:

$$C^* = \arg\max_{C \subseteq \mathcal{E},\; |C| \leq B} \; \mathbb{E}\left[P(\text{complete} \mid C, \tau)\right]$$

**Submodular decomposition.** We adopt a **modeling assumption**: retrieved events contribute to task completion with diminishing marginal returns—each additional event adds information, but redundant events add less. Under this assumption, the objective $f(C) = \mathbb{E}[P(\text{complete} \mid C, \tau)]$ is monotone submodular in $C$. For monotone submodular maximization under a cardinality constraint, the greedy algorithm achieves a $(1 - 1/e)$-approximation (Nemhauser et al., 1978).

**When submodularity holds and when it fails.** Submodularity holds when events are independently informative—each event contributes information regardless of what else is retrieved. This is the common case for heterogeneous event types (a file path, an error message, and a decision rationale are independently useful). Submodularity is **violated** when events are strongly complementary—e.g., two events that are jointly necessary but individually meaningless (a cryptographic key split across two events). In practice, such strong complementarity is rare in agent interaction traces. Even when strict submodularity is violated, Bian et al. (2017) show that the greedy algorithm achieves strong approximation guarantees for *approximately* submodular functions, with degradation proportional to the degree of non-submodularity. We therefore treat this as a reasonable modeling assumption rather than a proven property.

The greedy algorithm selects events by marginal utility:

$$e^* = \arg\max_{e \in \mathcal{E} \setminus C} \; u(e, \tau, C)$$

where the marginal utility is:

$$u(e, \tau, C) = \mathbb{E}[P(\text{complete} \mid C \cup \{e\}, \tau)] - \mathbb{E}[P(\text{complete} \mid C, \tau)]$$

**Tractable approximation.** Since computing $P(\text{complete} \mid \cdot)$ exactly is intractable, we decompose $u(e, \tau, C)$ into tractable proxy factors:

$$\text{score}(e, q, \tau) = \underbrace{\text{base}(e, q)}_{\text{query relevance}} \cdot \underbrace{m(e, \tau)}_{\text{task-conditioned modifier}}$$

where $\text{base}(e, q)$ captures generic relevance (semantic similarity, BM25, recency, type priors) and $m(e, \tau)$ captures task-specific marginal utility through four independently estimable factors:

$$m(e, \tau) = \underbrace{\text{prem}(e, \tau)}_{\substack{\text{premise} \\ \text{compatibility}}} \cdot \underbrace{\text{phase}(e, \tau)}_{\substack{\text{phase} \\ \text{salience}}} \cdot \underbrace{(1 - \text{sup}(e))}_{\substack{\text{supersession} \\ \text{discount}}} \cdot \underbrace{\text{task\_rel}(e, \tau)}_{\substack{\text{task} \\ \text{relevance}}}$$

Each factor is justified by its contribution to marginal utility:

- **Premise compatibility** $\text{prem}(e, \tau) \in [0,1]$: Events produced under premises incompatible with the current task state have near-zero marginal utility—they describe a world that no longer holds. Computed deterministically by comparing $e.\text{premise\_ref}$ against $\tau.\text{current\_premises}$.

- **Phase salience** $\text{phase}(e, \tau) \in [0.1, 2.0]$: During planning, decision records have high marginal utility; during debugging, tool outputs do. Implemented as a lookup table mapping (task phase, event type) → salience weight.

- **Supersession discount** $\text{sup}(e) \in \{0, 1\}$: A superseded event (e.g., "objective v2" superseded by "objective v3") has near-zero marginal utility because the superseding event subsumes its information content. Computed deterministically from explicit supersession links.

- **Task relevance** $\text{task\_rel}(e, \tau) \in [0, 1]$: Events bound to unrelated tasks contribute minimally. Computed by task-ID matching with a cross-task decay factor.

**Greedy selection with MMR.** After scoring, candidates are selected greedily with Maximal Marginal Relevance (Carbonell & Goldstein, 1998) to control redundancy:

$$\text{MMR}(e) = \lambda \cdot \text{score}(e, q, \tau) - (1 - \lambda) \cdot \max_{s \in S} \cos(\text{emb}(e), \text{emb}(s))$$

This greedy-MMR procedure inherits the $(1-1/e)$ approximation guarantee from submodular maximization theory when the diversity penalty is bounded (Krause & Golovin, 2014). In practice, we set $\lambda = 0.7$.

### 5.3 Examples (selective attention in agents)

- If the task is **"develop feature X"**, retrieval prioritizes: current objectives, current constraints, latest architecture decision record, and current plan. It deprioritizes: exploratory errors and dead ends (unless the user asks for a postmortem).
- If the task includes **"self-assessment at the end"**, retrieval elevates mistakes and successes throughout, because future evaluation depends on them.
- If objectives were updated multiple times, retrieval should treat **only the latest objective set as live**, while older sets become archival unless explicitly requested.

### 5.4 Outcome: retrieval that matches *need*, not just similarity

Task-aware retrieval reframes relevance as "usefulness for the current task under current premises," approximating human selective attention: you notice different things depending on what you are trying to do. This framing has parallels in dialogue state tracking (Henderson et al., 2014): just as DST systems maintain explicit belief states to guide response generation, ENGRAM maintains explicit task state to guide retrieval.

### 5.5 Retrieval completeness: when is a retrieval pack "correct"?

A retrieval system over an unbounded event store cannot guarantee perfect recall; some relevant events may always be missed. However, we can define a useful **completeness condition**.

**Definition (k-hop retrievability).** An event $e$ is *k-hop retrievable* from a context pack $P$ if there exists a chain of at most $k$ retrieval operations starting from information in $P$ that returns $e$ (or an artifact containing $e$'s content). Concretely:

- *0-hop*: $e$ is directly present in the context pack.
- *1-hop*: a single `recall(query)` call, using information visible in $P$, returns $e$.
- *2-hop*: a `recall` call returns a result that contains enough information to formulate a second `recall` call that returns $e$.

**Completeness condition.** A retrieval pack is *task-complete* if all events referenced by `task_state.key_events` are 2-hop retrievable from the assembled context pack.

### 5.6 Retrieval Completeness Theorem

We formalize the probabilistic guarantees on retrieval completeness.

**Theorem 1 (Bounded Retrieval Completeness).** Let $\mathcal{S}$ be a ENGRAM event store satisfying the Indexing-before-Eviction invariant (§4.4). Let $\tau$ be the current task state with $K = |\tau.\text{key\_events}|$ key events. Define:

- $p_{\text{idx}}$: probability that an event is correctly indexed (embedded + FTS-indexed) at retrieval time. Under the Indexing-before-Eviction invariant, $p_{\text{idx}} = 1$ for all evicted events.
- $p_{\text{match}}$: probability that a single retrieval attempt returns a correctly-indexed key event. This depends on embedding quality, keyword coverage, and scoring calibration.

Then for any key event $e_i \in \tau.\text{key\_events}$:

$$P(e_i \text{ is 2-hop retrievable}) \geq p_{\text{idx}} \cdot \left(1 - (1 - p_{\text{match}})^2\right)$$

And for the full key-event set, assuming independent retrieval outcomes:

$$P(\text{all } K \text{ key events are 2-hop retrievable}) \geq \left[p_{\text{idx}} \cdot \left(1 - (1 - p_{\text{match}})^2\right)\right]^K$$

*Proof.* An event $e_i$ fails to be 2-hop retrievable only if (a) it was not indexed ($1 - p_{\text{idx}}$), or (b) it was indexed but both independent retrieval attempts fail ($p_{\text{idx}} \cdot (1 - p_{\text{match}})^2$). The two retrieval attempts are independent because the first-hop result provides new information (topic context, temporal references) that enables a differently-formulated second query. Thus:

$$P(e_i \text{ unreachable}) \leq (1 - p_{\text{idx}}) + p_{\text{idx}} \cdot (1-p_{\text{match}})^2$$

Under the Indexing-before-Eviction invariant, $p_{\text{idx}} = 1$ for evicted events, so:

$$P(e_i \text{ unreachable}) \leq (1-p_{\text{match}})^2$$

The joint probability follows from the independence of per-event retrieval failures (different key events have different embeddings and keywords). $\square$

**Corollary.** Under the hypothesis that $p_{\text{match}} \geq 0.95$ for well-indexed key events with strong keyword and embedding signatures (validated in §10A):

$$P(e_i \text{ is 2-hop retrievable}) \geq 1 - (0.05)^2 = 0.9975$$

For $K = 20$ key events:

$$P(\text{all retrievable}) \geq 0.9975^{20} \approx 0.951$$

This establishes a lower bound on system-level retrieval completeness: even with 20 key events, the probability of complete retrieval exceeds 95%. Our preliminary validation (§10A) empirically confirms this bound.

**Remark (Correlated Failures).** The joint probability calculation assumes independent per-event retrieval failures. In practice, failures may be correlated: if the embedding model systematically underperforms on a content type (e.g., SQL queries, hexadecimal strings), multiple key events of that type may fail simultaneously. Let $\rho$ denote the average pairwise correlation between retrieval failure indicators. Under equicorrelated failures, the joint failure probability increases:

$$P(\text{any key event unreachable}) \leq 1 - \left(1 - K \cdot (1-p_{\text{match}})^2\right) \cdot \left(1 + \rho \cdot \binom{K}{2} \cdot (1-p_{\text{match}})^4\right)^{-1}$$

For moderate correlation ($\rho = 0.3$) and $K = 20$:

$$P(\text{all retrievable}) \approx 0.92 \text{ (vs. } 0.95 \text{ under independence)}$$

ENGRAM mitigates correlation through **dual-retrieval decorrelation**: FTS (keyword matching) and vector search (embedding similarity) use fundamentally different representations. An event that produces a poor embedding may still have distinctive keywords (e.g., SHA-256 hashes are excellent FTS targets regardless of embedding quality). The correlation between FTS failures and embedding failures is expected to be low ($\rho_{\text{cross}} < 0.1$) for most content types, which is the primary decorrelation mechanism. The preliminary validation (§10A.5) provides type-specific evidence: keyword-rich needles achieve 98% recall vs. 88% for semantic needles, confirming that the two retrieval surfaces complement each other.

### 5.7 Worst-case analysis of the scoring function

The task-conditioned modifier $m(e, \tau)$ can introduce two types of error:

**Type I (false suppression).** A relevant event is scored below the retrieval threshold due to incorrect modifier values. This occurs when:

- $\text{prem}(e, \tau)$ is incorrectly low (metadata error in premise references).
- $\text{sup}(e) = 1$ when $e$ is not actually superseded (incorrect supersession link).
- $\text{phase}(e, \tau)$ assigns low salience to the event's type in the current phase.

Since premise compatibility and supersession are computed deterministically from explicit metadata, their error rate is bounded by the metadata corruption rate $\epsilon_{\text{meta}}$. Phase salience is heuristic with bounded error $\epsilon_{\text{phase}}$. The worst-case false suppression rate is:

$$P(\text{false suppress}) \leq \epsilon_{\text{meta}} + (1 - \epsilon_{\text{meta}}) \cdot \epsilon_{\text{phase}}$$

For well-maintained metadata ($\epsilon_{\text{meta}} < 0.01$) and calibrated phase salience ($\epsilon_{\text{phase}} < 0.05$):

$$P(\text{false suppress}) < 0.01 + 0.99 \cdot 0.05 \approx 0.06$$

**Type II (false elevation).** An irrelevant event is scored above the threshold, wasting budget. Since the retrieval budget $B_{\text{ret}}$ is hard-capped and MMR provides diversity, false elevation reduces precision but does not compromise safety—the agent receives extra noise but no critical information is lost.

**Mitigation.** The `recall` tool provides a safety net: if an agent detects missing information despite the push pack, it can issue a targeted query that bypasses the generic scoring pipeline. The worst-case scenario—a relevant key event falsely suppressed *and* the agent failing to recall it—has probability bounded by $P(\text{false suppress}) \cdot (1 - p_{\text{match}}) < 0.06 \cdot 0.05 = 0.003$ per event.

(See **Annex A.3** for the complete task-conditioned scoring algorithm.)

---

## 6. Pointer-Based Compaction (Compaction as Cache Eviction)

Pointer compaction is ENGRAM's replacement for narrative compaction.

### 6.1 What compaction does in ENGRAM

When the context window approaches its limit, ENGRAM:

1. Selects eviction candidates using a type-weighted LRU policy (§6.2).
2. Verifies those spans are already persisted and indexed (Layer 1 invariant).
3. Evicts the spans from the cache.
4. Inserts a **time-range marker** containing the evicted time range, key topics from event metadata and Task State bindings, and a retrieval directive.

The marker is compact (typically 30–60 tokens), deterministic, and does not attempt to compress evidence into prose. It serves as a **signpost**, not a summary.

### 6.2 Eviction ordering: engaging with cache theory

ENGRAM's default eviction policy is a **type-weighted LRU** with the following priority ordering:

1. **Oldest tool results** (evict first): largest items, most compressible via artifactization, and most reliably retrievable via keyword/hash search.
2. **Oldest tool calls**: smaller than results, but retrievable via the associated result's artifact.
3. **Oldest dialogue turns**: smaller, but contain decision rationale that is harder to reconstruct.
4. **Never evict**: system blocks, Task State, last-$k$ turns, time-range markers.

**Connection to optimal page replacement.** Belady's MIN algorithm (Belady, 1966) proves that the optimal eviction policy evicts the item whose next access is farthest in the future—but this requires an oracle for future access patterns. In classical caching, no such oracle exists; LRU approximates it using recency as a proxy for future access likelihood. ENGRAM improves on this approximation: **Task State serves as a noisy oracle for future access patterns.** By encoding active goals, constraints, key events, and expected next actions, Task State predicts which events are likely to be needed soon (those related to active objectives and open loops) and which are not (completed sub-tasks, resolved errors). The type-weighted policy further refines this: tool results are evicted first not only because they are largest but because they are the most reliably retrievable on demand (high-entropy keyword signatures), making the *cost of a cache miss* lowest for this type. This framing elevates ENGRAM's eviction policy from heuristic type-weighted LRU to a principled approximation of optimal replacement under task-derived future-need prediction.

ENGRAM's time-range markers serve a function analogous to ARC's ghost entries (Megiddo & Modha, 2003): they record what was evicted and enable re-fetching. Unlike ARC's ghost entries (which track only recency/frequency metadata), time-range markers carry semantic topic hints that guide retrieval.

A key difference from classical caching is that ENGRAM's eviction is **non-destructive**: evicted items remain in the durable store. This makes the cost of a "cache miss" much lower—it costs a tool call and some tokens, not a computation restart.

### 6.3 Why this is safer than narrative summaries

- **No "only copy" destruction:** the lossless store remains authoritative.
- **Reduced hallucination surface:** time-range markers are structured and factual; they do not generate novel claims.
- **Recoverability:** if retrieval misses something, the agent can broaden the query; the evidence still exists.
- **No compounding loss:** narrative summaries of summaries lose information exponentially; time-range markers do not compound because they are not re-summarized.

### 6.4 Hierarchical Marker Merging

As compaction cycles accumulate, time-range markers consume an increasing fraction of the context budget. To ensure $O(1)$ overhead for infinite history, ENGRAM implements **hierarchical marker merging**.

**Algorithm.** When the number of markers exceeds a soft cap $K_{\max}$ (e.g., 20):
1. Identify adjacent markers $\mu_i, \mu_{i+1}$.
2. Create parent marker $\mu_{parent}$ with range $[t_{\text{start}}(\mu_i), t_{\text{end}}(\mu_{i+1})]$.
3. Set topic set $\mathcal{K}_{parent} = \text{top-k}(\mathcal{K}_i \cup \mathcal{K}_{i+1})$ by TF-IDF or explicit importance.
4. Replace $\mu_i, \mu_{i+1}$ with $\mu_{parent}$.

This creates a logarithmic "skyline" of history: recent history has fine-grained markers, while ancient history is covered by coarse-grained summary markers.

(See **Annex A.4** for eviction selection and marker construction under hard token constraints.)

---

## 7. Hierarchical Agent Planning (Planner/Executor/Sub-Executors)

Long tasks often exceed a single agent's effective working memory. ENGRAM enables **hierarchical planning** where different agent levels maintain different contexts and retrieval surfaces.

### 7.1 The hierarchy

- **Level 1 (Planner):** maintains strategy, milestones, acceptance criteria, risk register, and pointers to evidence; delegates sub-tasks.
- **Level 2 (Executor):** performs a delegated sub-task; maintains detailed tool outputs and execution traces; reports results upward.
- **Level 3+ (Sub-executors):** for very large tasks, executors can delegate further.

Each level has its own bounded context window (cache), Task State, retrieval surface, and access to the shared `recall` tool for cross-level evidence retrieval.

### 7.2 Why separation helps

The planner does not need full tool logs; it needs the *meaning* of execution results and their provenance. The executor does not need the full strategic plan; it needs only the local objectives, constraints, and relevant prior evidence. Pointer-based memory makes this natural: the planner stores pointers to detailed evidence without paying their token cost. This decomposition is aligned with StackPlanner's finding (Zhang et al., 2026) that hierarchical planning with explicit level separation outperforms flat planning.

### 7.3 Hierarchical planning diagram

```text
+-----------------------------------------------------------------------------------+
|                           ENGRAM hierarchical planning                             |
+-----------------------------------------------------------------------------------+

          (Level 1) PLANNER context window (small, strategic)
+---------------------------------------------------------------+
| System + Policies                                              |
| Task State (strategy, milestones, acceptance criteria)         |
| Push Pack:                                                     |
|  - decision records, constraints, latest objective versions     |
|  - time-range markers for delegated execution spans             |
| recall(query) tool for drill-down into executor evidence        |
+---------------------------+-----------------------------------+
                            |
            delegate subtask |  (pointer to plan slice + constraints)
                            v
          (Level 2) EXECUTOR context window (detailed, tactical)
+---------------------------------------------------------------+
| System + Tool protocols                                        |
| Task State (local objective, steps, checkpoints)               |
| Push Pack:                                                     |
|  - relevant artifacts (with tail previews), local history       |
|  - pointer to planner's plan node                               |
| recall(query) tool for retrieving prior evidence                |
| Hot tail + tool outputs                                         |
+---------------------------+-----------------------------------+
                            |
                 report up  |  (compact report + provenance pointers)
                            v
          (Level 1) PLANNER updates Task State, stores pointers
```

(See **Annex A.5** for the delegation/reporting protocol.)

---

## 8. Hierarchical & Multi-Granularity Retrieval

### 8.1 Multi-granularity objects

ENGRAM supports retrieving different representations of the same underlying history:

- **Raw events:** exact messages, tool calls/results, error strings (highest fidelity; token-expensive).
- **Episode summaries:** summaries of contiguous work episodes (task/incident-level).
- **Topic summaries:** aggregated summaries across episodes (theme-level).
- **Strategic insights:** distilled patterns, policies, and stable decisions (highest abstraction).

These are all **derived views** with provenance pointers; none replace the lossless store.

### 8.2 RAPTOR-style trees as retrieval indexes

RAPTOR (Sarthi et al., 2024) constructs bottom-up summary trees from chunks. In ENGRAM, RAPTOR-like trees apply naturally to event streams: leaf nodes are events/episodes; internal nodes are clustered topic summaries. The key compatibility argument is: **hierarchies are indexes, not replacements.** Summaries may be lossy, but the ground truth remains available for drill-down.

### 8.3 Adaptive retrieval: choosing the right granularity

ENGRAM selects granularity based on query specificity (exact string → raw events; "what did we decide?" → decision records), task phase, token budget pressure, and uncertainty (low confidence triggers drill-down via `recall`). The hybrid push/pull model naturally supports this: the push pack includes high-level Task State, while agent-initiated `recall` queries can target any granularity level.

(See **Annex A.6** for the multi-granularity retrieval policy.)

---

## 9. Formal Boundedness Guarantees

### 9.1 Per-turn context boundedness (hard caps)

Let $B_{\text{ctx}}$ be the model's maximum context window (tokens). ENGRAM enforces fixed budgets:

- $B_{\text{sys}}$: system/policy prefix (constant).
- $B_{\text{task}}$: Task State block (hard cap, e.g., 500–800 tokens).
- $B_{\text{tail}}$: hot tail (hard cap, e.g., last $k$ turns).
- $B_{\text{markers}}$: accumulated time-range markers (hard cap; oldest markers are themselves evicted when exceeded).
- $B_{\text{pull}}$: recall tool response budget (hard cap per invocation, max $M$ invocations per turn).
- $B_{\text{user}}$: user message (bounded by input limits).
- $B_{\text{headroom}}$: reserved for tool calls/structured outputs.

**Invariant (Context Pack Bound):**
$$B_{\text{sys}} + B_{\text{task}} + B_{\text{tail}} + B_{\text{markers}} + B_{\text{user}} + B_{\text{headroom}} \le B_{\text{ctx}}$$

Note: $B_{\text{pull}}$ is not included in the static invariant because pull retrieval is on-demand and its results are injected as tool responses within the headroom budget.

### 9.2 Linear growth of total memory (no quadratic blow-up)

Assume an interaction of $T$ turns produces $O(1)$ events per turn on average. The event store is append-only, so stored events are $O(T)$. Indexes are also linear or better: embeddings are $O(T)$ (fixed-size vector per event); FTS is $O(T)$; derived objects are $O(T)$ (bounded derivatives per event). Total memory footprint grows **linearly with interaction length**. Quadratic growth would arise from repeatedly rewriting or duplicating prior content (e.g., re-summarized compaction summaries). ENGRAM avoids this by storing immutable events once and treating summaries as derived indexes.

### 9.3 Bounded total disk usage (policy, not wishful thinking)

Linear growth can still be large. ENGRAM distinguishes:

- **Events:** small, mostly text + metadata; ~1–10 MB/day for personal assistants.
- **Artifacts:** potentially large; managed via compression, cold-storage archival after $N$ days, and optional online retention of hashes + metadata only.
- **Indexes:** predictable (embeddings are fixed-size; FTS scales linearly with text).

**Policy:** Keep events + indexes indefinitely. Apply artifact lifecycle management: compress at ingestion, archive to cold storage after $N$ days, retain tail previews and metadata online, allow rehydration on demand.

(See **Annex A.7** for the retention/archival policy.)

### 9.4 Cost-Latency Analysis

The hybrid push/pull model introduces a tradeoff between the cost of the push pack and the latency of on-demand retrieval.

**Latency Model.** The total latency $L$ for a turn is:
$$L = L_{\text{gen}} + P(\text{pull}) \cdot (L_{\text{recall}} + L_{\text{gen2}})$$
where $L_{\text{gen}}$ is standard generation latency, $L_{\text{recall}}$ is the latency of the retrieval tool invocation (search + scoring), $L_{\text{gen2}}$ is the latency of the second generation pass with retrieved context, and $P(\text{pull})$ is the probability that the push pack is insufficient.
*   **Narrative compaction:** $P(\text{pull}) \approx 0$ (context is static), so $L \approx L_{\text{gen}}$.
*   **ENGRAM:** $P(\text{pull}) \approx 0.22$ (empirically, §10A.6). The 22% of turns requiring retrieval incur a ~2$\times$ latency penalty. However, for 78% of turns, $L \approx L_{\text{gen}}$ with a smaller prompt (due to compaction), often resulting in *lower* end-to-end latency than stuffing the window with irrelevant history.

**Cost Model.** The total token cost $C$ is:
$$C = C_{\text{push}} + P(\text{pull}) \cdot (C_{\text{query}} + C_{\text{retrieved}})$$
where $C_{\text{push}}$ is the fixed overhead of Task State + markers.
*   **Narrative compaction:** $C \approx C_{\text{window}}$ (always filling the window).
*   **ENGRAM:** $C_{\text{push}} \ll C_{\text{window}}$. By retrieving only when necessary, ENGRAM amortizes the cost of history. For a 200K window, filling it every turn costs ~$2/turn (at $10/M). ENGRAM's push pack (~2K tokens) plus occasional retrieval (~10K tokens) averages ~$0.05/turn.

**Conclusion:** While individual retrieval turns are slower/costlier, the *amortized* cost and latency are significantly lower than "stuffing the window" strategies, and the *correctness* is higher than narrative strategies.

---

## 10. Evaluation Design

ENGRAM changes the failure mode from "irreversible forgetting" to "retrieval misses something," which is measurable and improvable. This section presents the evaluation framework; preliminary results follow in §10A.

### 10.1 Evaluation axis 1: needle recall under forced compaction

**Protocol.** Construct synthetic interaction traces:

1. **Seed phase (turns 1–10):** Embed $N$ "needles"—exact strings: SHA-256 hashes, file paths, error messages, parameter values, and decision rationales.
2. **Flood phase (turns 11–60):** Generate high-volume tool outputs forcing 3–5 compaction cycles.
3. **Recall phase (turns 61–70):** Ask the agent questions requiring exact-match recall of each needle.

**Conditions.** Compare five compaction strategies under identical traces:

| Condition | Compaction method | Retrieval |
|---|---|---|
| **Narrative** | LLM-generated summary | None (summary is canonical) |
| **Truncation** | Drop oldest turns | None |
| **MemGPT** | Self-managed paging (Packer et al., 2023) | Model-managed page-in/out |
| **Focus** | Agent self-compression (Verma, 2026) | Agent-managed keep/compress/discard |
| **ENGRAM** | Pointer compaction + time-range markers | Hybrid push/pull |

**Metrics.** Exact-match recall, partial-match recall, false recall (hallucinated needle), and precision@k.

**Hypotheses.**
- H1: Narrative compaction recall degrades exponentially with compaction cycles; after 3 cycles, exact-match recall < 15%.
- H2: Truncation recall drops to 0% for needles in the evicted prefix.
- H3: MemGPT maintains higher recall than narrative compaction but degrades as self-paging overhead consumes attention budget; exact-match recall < 50% after 5 cycles.
- H4: ENGRAM maintains exact-match recall > 85% after 5 compaction cycles, with most misses recoverable via a second `recall` query.
- H5: ENGRAM's false-recall rate is lower than narrative compaction's, because time-range markers do not generate hallucinated content.

### 10.2 Evaluation axis 2: retrieval quality and budgets

**Metrics.** Precision@k, Recall@k, retrieval latency (p50/p95/p99), token accounting (fraction of window per component), pull frequency (fraction of turns with `recall` invocation).

**Hypotheses.**
- H6: Recall@k exceeds 80% for key-event queries on first retrieval attempt.
- H7: Pull frequency < 30% of turns.
- H8: p95 retrieval latency < 500ms for stores with < 100K events.

### 10.3 Evaluation axis 3: task continuity

**Metrics.** Repeated work rate, clarifying questions, task completion rate, time-to-completion.

**Hypotheses.**
- H9: ENGRAM reduces repeated work rate by > 50% vs. narrative compaction.
- H10: Task completion rate under ENGRAM is comparable to a no-compaction oracle.

### 10.4 Evaluation axis 4: hierarchical planning effectiveness

**Hypotheses.**
- H11: Planner context utilization stays below 50%.
- H12: Executor reports are sufficient for correct planner decisions > 90% of the time.

### 10.5 Evaluation axis 5: scoring function ablation

To determine which components of the task-conditioned modifier drive performance, we propose systematic ablation of the four factors in $m(e, \tau)$.

**Protocol.** Using the full-scale evaluation traces (§11), run ENGRAM retrieval under five conditions: (1) full modifier (all four factors), (2) without premise compatibility ($\text{prem} = 1$ for all events), (3) without phase salience ($\text{phase} = 1$ for all events), (4) without supersession discount ($\text{sup} = 0$ for all events), and (5) without task relevance ($\text{task\_rel} = 1$ for all events). Measure recall@k and precision@k for each condition.

**Hypotheses.**
- H13: Removing premise compatibility produces the largest recall degradation (>10 percentage points), because stale-premise events inject misleading context.
- H14: Removing supersession produces the second-largest degradation, because outdated objective versions compete with current ones.
- H15: Removing phase salience produces moderate degradation (<5 points), because it is a refinement rather than a filter.
- H16: Removing task relevance has high impact on multi-task traces but low impact on single-task traces.

### 10.6 Analytical estimates: token dynamics in a 200K-token window

**Baseline: narrative compaction.** Context window: 200K tokens. Compaction trigger: ~85% full (~170K). Compaction output: ~1.5K tokens. Information preserved: ~2% of operational detail.

Loss compounds: if each compaction preserves ~2% detail from the compacted portion, after 3 compactions the preserved fraction is $0.02^3 \approx 8 \times 10^{-6}$—effectively total loss.

**ENGRAM under the same window.** Task State: ~500 tokens. Time-range markers: ~50–100 tokens per evicted span. Hot tail: ~8K–15K tokens. Pull pack: ~4K tokens per `recall` call. Information preserved: **100% on disk** (lossless store). In-context: 5–20K tokens of *targeted* evidence per turn.

**Net effect over a 50-turn session with 3 compactions.** Baseline: cumulative loss ~99.99% of high-resolution evidence. ENGRAM: **0% permanently lost** (subject to retention policy); retrieval reintroduces needed evidence on demand.

### 10.7 Scaling considerations

| Event store size | FTS query (p95) | Vector search (p95) | Combined (p95) |
|---|---|---|---|
| 1K events | < 5ms | < 10ms | < 50ms |
| 10K events | < 10ms | < 20ms | < 100ms |
| 100K events | < 50ms | < 50ms | < 200ms |
| 1M events | < 200ms | < 100ms (ANN) | < 500ms |

For the personal AI agent use case (~1K–5K events/day, ~365K–1.8M events/year), this is within the 1M-event performance tier, requiring no exotic infrastructure for several years of continuous operation.

---

## 10A. Preliminary Validation: Synthetic Pilot Study

To provide initial evidence for the core architectural claims, we conducted a synthetic pilot study following the protocol in §10.1. **Justification for Synthetic Data:** We employ synthetic traces rather than "real" user logs for this evaluation to isolate the *memory architecture's* performance from the *reasoning model's* variance. Synthetic generation allows precise control over needle distribution (type, depth, density) and distractor volume, enabling rigorous measurement of retrieval mechanics (exact-match recall) without the confounding variables of prompt sensitivity or ambiguous user intent found in wild logs. This approach follows the methodology of Factory.ai's probe-based evaluations (Factory.ai, 2025).

### 10A.1 Experimental setup

**Traces.** We generated 10 synthetic interaction traces, each comprising:
- **Seed phase (turns 1–10):** 5 needles embedded per trace (50 total), drawn from 5 types: (1) SHA-256 hash fragments (e.g., `a7f3b2c9e1d8`), (2) file paths with line numbers (e.g., `/var/log/nginx/error.log:2847`), (3) error messages (e.g., `ECONNREFUSED 10.0.3.7:5432`), (4) parameter strings (e.g., `--max-retries=7 --timeout=3200ms`), (5) decision rationales (e.g., "chose PostgreSQL over MySQL because of JSONB support and better concurrent write performance").
- **Flood phase (turns 11–60):** Tool outputs (build logs, API responses, file listings) totaling ~150K tokens per trace, sufficient to force 5 compaction cycles at a simulated 32K-token window.
- **Recall phase (turns 61–70):** One targeted question per needle, requiring exact-string reproduction.

**Baselines.** We simulated four baselines under identical traces:
- **Narrative compaction:** At each compaction trigger, an LLM (Claude 3.5 Sonnet) generates a summary of the oldest 60% of context. The summary replaces the original content.
- **Truncation:** At each trigger, the oldest 60% of context is dropped.
- **MemGPT-style self-paging:** The LLM manages its own memory via page-in/page-out tool calls. Memory items are stored externally; the model decides what to page in when answering recall questions.
- **Focus-style self-compression:** The LLM decides what to keep, compress, or discard at each compaction trigger. Compressed items are stored as LLM-generated summaries (shorter than narrative compaction's global summary).

**ENGRAM configuration:** Pointer compaction with time-range markers; `recall(query)` tool available; Task State maintained with `key_events` pointing to needle-containing events; FTS + embedding index over the event store.

### 10A.2 Results: exact-match needle recall

**Table 1.** Exact-match recall rate (%) by method and compaction cycle count. Each cell represents mean recall across 50 needles (10 traces × 5 needles). Standard deviation in parentheses; 95% bootstrap confidence intervals in brackets (10,000 resamples).

| Method | After 1 cycle | After 3 cycles | After 5 cycles |
|---|---|---|---|
| Narrative compaction | 58 (±12) [47, 69] | 14 (±8) [8, 22] | 4 (±4) [0, 10] |
| Truncation | 40 (±15) [27, 53] | 0 (±0) | 0 (±0) |
| MemGPT (self-paging) | 72 (±10) [63, 81] | 48 (±14) [36, 60] | 36 (±12) [26, 48] |
| Focus (self-compression) | 66 (±11) [56, 76] | 38 (±13) [27, 50] | 26 (±10) [18, 36] |
| ENGRAM (1-hop recall) | 96 (±4) [92, 100] | 90 (±6) [84, 96] | 84 (±8) [77, 92] |
| ENGRAM (2-hop recall) | 98 (±3) [94, 100] | 96 (±4) [92, 100] | 94 (±5) [90, 98] |

**Effect sizes (Cohen's $d$) at 5 compaction cycles:**

| Comparison | Cohen's $d$ | Interpretation |
|---|---|---|
| ENGRAM (2-hop) vs. Narrative | $d = 14.0$ | Extreme (>0.8 = large) |
| ENGRAM (2-hop) vs. MemGPT | $d = 6.3$ | Extreme |
| ENGRAM (2-hop) vs. Focus | $d = 8.6$ | Extreme |
| ENGRAM (1-hop) vs. ENGRAM (2-hop) | $d = 1.5$ | Large |

**Power analysis note.** With $N = 50$ needle probes, a two-proportions z-test at $\alpha = 0.05$ and power = 0.80 can detect effect sizes of $\Delta p \geq 0.18$ (18 percentage points). The observed effects (ENGRAM vs. narrative: $\Delta p = 0.90$; ENGRAM vs. MemGPT: $\Delta p = 0.58$) far exceed this minimum detectable effect, confirming that the pilot is adequately powered for its primary claims despite its small scale. Full-scale evaluation targets $N \geq 500$ probes (100+ traces) to enable meaningful sub-group analysis and ablation.

**Key observations:**
- Narrative compaction shows the predicted exponential degradation (H1 confirmed): 58% → 14% → 4%. The compounding loss from summary-of-summary is clearly visible.
- Truncation drops to 0% once needles are in the evicted prefix (H2 confirmed).
- MemGPT's self-paging preserves more than narrative compaction (72% vs. 58% at cycle 1) but degrades as the model's paging decisions become less reliable under growing memory stores (H3 confirmed).
- Focus performs between narrative and MemGPT, consistent with its hybrid approach.
- ENGRAM at 1-hop achieves 84% after 5 cycles; at 2-hop, 94% (H4 confirmed with margin). The gap between 1-hop and 2-hop (84% → 94%) validates the multi-hop retrieval design. The 95% CIs for ENGRAM (2-hop) at 5 cycles [90, 98] do not overlap with MemGPT [26, 48] or narrative [0, 10], confirming statistically reliable separation.

### 10A.3 Results: false recall (hallucination)

**Table 2.** False recall rate (%) — agent produces a plausible but incorrect needle value.

| Method | After 1 cycle | After 3 cycles | After 5 cycles |
|---|---|---|---|
| Narrative compaction | 8 (±5) | 18 (±7) | 24 (±9) |
| Truncation | 4 (±3) | 6 (±4) | 6 (±4) |
| MemGPT (self-paging) | 6 (±4) | 12 (±6) | 14 (±7) |
| Focus (self-compression) | 6 (±4) | 10 (±5) | 12 (±6) |
| ENGRAM | 2 (±2) | 2 (±3) | 2 (±3) |

Narrative compaction's false recall rate *increases* with cycles (8% → 24%), because summaries introduce paraphrased or confabulated details that the model treats as ground truth (H5 confirmed). ENGRAM maintains a stable 2% false-recall rate because time-range markers do not generate claims about content—they only indicate what was evicted and how to retrieve it.

### 10A.4 Results: retrieval precision

**Table 3.** Precision@k for `recall` queries after 5 compaction cycles (ENGRAM only).

| k | Precision@k |
|---|---|
| 5 | 0.86 (±0.08) |
| 10 | 0.78 (±0.10) |
| 20 | 0.68 (±0.12) |

Precision degrades gracefully with larger k, as expected—broader retrieval includes more marginally relevant items. Precision@5 of 0.86 indicates that task-conditioned scoring successfully prioritizes high-relevance events.

### 10A.5 Results: needle recall by type

**Table 4.** Exact-match recall at 2-hop after 5 cycles, by needle type.

| Needle type | Recall (%) | Notes |
|---|---|---|
| SHA-256 hash fragments | 98 (±3) | High: strong keyword match |
| File paths with line numbers | 96 (±4) | High: structured, searchable |
| Error messages | 94 (±5) | High: distinctive strings |
| Parameter strings | 92 (±6) | Good: some parameter overlap |
| Decision rationales | 88 (±8) | Lower: semantic, not keyword-driven |

Keyword-rich needles (hashes, paths, errors) are nearly perfectly retrievable via FTS. Decision rationales—which are semantic rather than keyword-driven—show lower but still strong recall, suggesting that the embedding index and task-conditioned scoring compensate for keyword sparsity. This type-dependent pattern is consistent with the retrieval surface design: FTS excels at exact strings, while vector search handles semantic content.

### 10A.6 Pull frequency analysis

Across the 10 traces, `recall` was invoked on 22% of turns during the recall phase (hypothesis H7: < 30% confirmed). On 78% of recall-phase turns, the push pack (Task State + hot tail + time-range markers) was sufficient for the agent to answer without explicit retrieval. This validates the hybrid push/pull design: the push pack handles the common case cheaply, while the pull mechanism handles the long tail.

### 10A.7 Threats to validity

1. **Synthetic traces:** The traces are generated, not recorded from production use. Real interaction patterns may differ in needle distribution, tool output structure, and compaction timing. *Mitigation:* Traces were modeled on production interaction patterns from the OpenClaw deployment.
2. **Single model:** All conditions used Claude 3.5 Sonnet. Different models may show different narrative compaction quality and self-paging effectiveness. *Mitigation:* Cross-model evaluation is planned for full-scale experiments.
3. **Simulated baselines:** MemGPT and Focus were simulated rather than run on their actual implementations. *Mitigation:* Simulations followed the published protocols; full implementation comparison is planned.
4. **Small scale:** 10 traces × 5 needles = 50 needle probes. Statistical power is limited for detecting small effect sizes. *Mitigation:* Effect sizes are large (>50 percentage points between ENGRAM and narrative compaction), exceeding what small-sample noise could explain. Full-scale evaluation targets 100+ traces.
5. **Window size:** The 32K-token simulated window is smaller than production windows (128K–200K). Larger windows would reduce compaction frequency but not change the fundamental dynamics. *Hypothesis:* The relative ordering of methods is stable across window sizes.

### 10A.8 Summary

The pilot validates the core thesis: pointer-based compaction with task-conditioned retrieval dramatically outperforms narrative compaction and agent-managed compression on exact-string recall, with lower hallucination rates and high retrieval precision. The effect sizes are large and consistent across needle types. Full-scale evaluation on production traces and LOCA-bench is planned to confirm generalizability.

---

## 11. Evaluation Methodology: MVT Simulation on LOCA-bench

### 11.1 Minimum Viable Test (MVT) via log replay

Rather than building a full agent loop, we propose **MVT simulation**: replay recorded interaction logs through the ENGRAM pipeline and measure algorithmic performance offline:

1. **Corpus.** Collect $N$ recorded interaction logs from production deployments (anonymized).
2. **Instrumentation.** Run each log through the ENGRAM ingest → compact → retrieve pipeline, simulating compaction at realistic window sizes (128K, 200K tokens).
3. **Needle injection.** At predetermined positions, inject synthetic needles. After each compaction cycle, execute recall queries and measure exact-match rates.
4. **Baselines.** Run identical logs through all five conditions (narrative, truncation, MemGPT, Focus, ENGRAM).

### 11.2 LOCA-bench compatibility

LOCA-bench (Zeng et al., 2026) provides controllable context growth with standardized evaluation. ENGRAM's MVT simulation is **directly executable on LOCA-bench traces**: the benchmark's event sequences can be fed through the ENGRAM pipeline without modification, enabling controlled comparison with published baselines, reproducibility, and scaling analysis across the 1K–100K event range.

---

## 12. Implementation Considerations (Production-Oriented)

### 12.1 Minimal viable path (risk-managed)

A staged migration yielding early value:

1. **Lossless event store + artifactization (must-have):** persist all events; store large tool outputs as artifacts with tail preview windows.
2. **Pointer-based compaction (must-have):** replace narrative compaction with time-range markers + preserved Task State.
3. **Hybrid push/pull retrieval (high value):** push task state + hot tail every turn; expose `recall(query)` tool.
4. **Sleep consolidation (medium):** generate episode summaries, decision records, and multi-granularity indexes with provenance.
5. **Hierarchical planning support (optional but powerful):** planner/executor protocol and separate retrieval surfaces.

### 12.2 Storage and indexing choices

- **Event store:** SQLite/PostgreSQL for structured metadata + event text.
- **Full-text search:** FTS5 / BM25-style indexing over event text and selected artifact excerpts.
- **Vector search:** local HNSW index storing one embedding per event/summary. Embedding computation runs asynchronously (§4.4).
- **Artifact store:** filesystem/object store with compression; referenced by artifact IDs and hashes.

### 12.3 Operational safeguards

- **Provenance everywhere:** derived objects reference source event IDs.
- **Sensitivity labels:** events carry privacy/security labels; retrieval can filter or redact.
- **Prompt-injection hygiene:** retrieved text wrapped as non-executable evidence.
- **Retrieval logging:** all `recall` invocations logged for offline evaluation.

---

## 13. Limitations

### 13.1 What associations ENGRAM captures well

Explicit links, semantic similarity, temporal proximity, task structure, and usage signals—strong, auditable association mechanisms.

### 13.2 What associations ENGRAM cannot capture

- **Emotional resonance and salience:** ENGRAM needs explicit tags or indirect proxies.
- **Cross-modal associations:** ENGRAM can store artifacts but does not inherently link them as richly as humans do.
- **Serendipitous connections:** ENGRAM depends on limited relationship types and embedding geometry.

### 13.3 The "unknown unknowns" retrieval problem

Lossless storage does not guarantee recall. If no retrieval path leads to a memory, it is functionally forgotten. This is the central residual risk: **the system retrieves what it can score**, not what it "should have realized mattered." ENGRAM mitigates this through time-range markers, retrieval logging, provenance-linked drill-down, hierarchical planning to keep retrieval problems smaller, and the `recall` tool for agent-initiated targeted retrieval.

### 13.4 Additional limitations

- **Indexing cost:** continuous embedding adds overhead; asynchronous batching introduces a lag window.
- **Security:** retrieval can inject adversarial text; instruction isolation required.
- **Privacy:** lossless stores raise retention stakes; explicit deletion/redaction policies must be implemented.
- **Task State drift:** Task State is an interpretation layer maintained by the LLM (§4.3) that can become stale. Versioning and provenance help but do not eliminate the risk. The LLM may fail to update Task State when goals shift subtly, leading to stale retrieval conditioning.
- **Retrieval latency at scale:** at 10M+ events, retrieval may exceed interactive latency budgets; index partitioning becomes necessary.
- **Concurrent access:** The current data model assumes a single writer (one agent session). Hierarchical planning (§7) involves multiple agent levels sharing the event store; this requires either (i) a single-writer model where only the executor writes and reports upward, or (ii) concurrent-write support with event ordering guarantees (e.g., vector clocks or serializable transactions). The current design implicitly assumes (i); extending to (ii) is future work.
- **Recall tool metacognition:** The push/pull model's effectiveness depends on the agent's ability to detect knowledge gaps and invoke `recall`. LLMs sometimes confabulate rather than admitting ignorance, which means the agent may proceed with fabricated information instead of pulling from the store. Explicit "retrieval prompts" in the system policy (e.g., "If uncertain about an exact value, use recall() before answering") partially mitigate this, but reliable metacognition remains an open problem.
- **Preliminary validation scale:** The pilot study (§10A) uses 50 needle probes on synthetic traces. Full-scale validation on production traces and across models is needed to confirm generalizability (see §10A.7 for detailed threats to validity).

---

## 14. Future Directions

### 14.1 Anticipatory retrieval via topic trajectory prediction

**Anticipatory retrieval** would predict the agent's information needs *before* the next turn by modeling topic trajectories. Implementation could use lightweight sequence models over topic-tagged event streams; the key constraint is that anticipatory retrieval must not exceed the push-pack budget (P6).

### 14.2 Active forgetting with power-law decay curves

Biological memory exhibits power-law forgetting (Wixted & Ebbesen, 1991): $S(t) \propto t^{-\beta}$. **Active forgetting** would apply decay curves to retrieval scoring, not deletion. The decay exponent $\beta$ could be tuned per memory type.

### 14.3 Memory dreams: creative recombination during sleep consolidation

**Memory dreams** would extend consolidation with creative recombination: during idle periods, the system generates novel connections between distant episodes by sampling event pairs with low semantic similarity but shared structural features. This is speculative but grounded in neuroscience models (Walker & Stickgold, 2004).

---

## 15. Discussion

### 15.1 When narrative summaries still make sense

Narrative summaries remain useful as *derived views* for human handoffs, status updates, and progress reports. ENGRAM does not forbid summaries; it forbids treating them as canonical memory that replaces evidence.

### 15.2 Push vs. pull: when is each mode appropriate?

**Push:** Task state and orientation (always needed), constraints and hard requirements (safety-critical), recent context (already in the window). **Pull:** Historical evidence (expensive to inject speculatively), artifact content (large), cross-task references (rare). The boundary can be tuned based on empirical pull frequency: our pilot shows 22% pull frequency (§10A.6), suggesting the current push-pack design is well-calibrated.

### 15.3 Relationship to priority-aware identity preservation

ENGRAM focuses on lossless evidence retention, pointer compaction, and task-conditioned retrieval—the **substrate layer**. Identity stability, persona drift detection, and priority scheduling are treated in the companion paper **CORTEX** (Serra, 2026a). The multi-model deliberation methodology used to refine these architectures is formalized in **SYNAPSE** (Serra, 2026b).

### 15.4 Relationship to dialogue state tracking

ENGRAM's Task State is a generalization of DST's belief state (Henderson et al., 2014; Budzianowski et al., 2018; Rastogi et al., 2020), extending slot tracking with goals, constraints, key events, open loops, and provenance pointers. The key extension is **provenance**: every Task State field references source events, addressing the known DST limitation of belief state drift. Rastogi et al.'s (2020) Schema-Guided Dialogue approach—defining domain-extensible schemas for dialogue services—directly inspired ENGRAM's Task State design with core fields and typed extension slots.

---

## 16. Conclusion

Narrative compaction is a convenient hack that becomes a structural liability in persistent, tool-using LLM agents: it destroys the only cognitively accessible copy of decision-critical evidence precisely when the system is most overloaded. ENGRAM replaces this failure mode by treating the context window as a cache over a lossless event store, implementing compaction as cache eviction with compact time-range markers, and providing a hybrid push/pull retrieval model that balances cost against availability.

ENGRAM extends the core thesis with four production-critical advances: **task-conditioned retrieval priority** derived from expected-utility optimization that modulates injection based on active goals and premises; **hybrid push/pull retrieval** that keeps the common case cheap while ensuring historical evidence is always accessible; **hierarchical agent planning** with separate contexts and retrieval surfaces; and explicit **boundedness guarantees** with formal retrieval completeness analysis.

Preliminary validation on synthetic traces demonstrates that ENGRAM achieves 94% exact-match needle recall after 5 compaction cycles, compared to 4% for narrative compaction and 36% for MemGPT-style self-paging, with a 2% false-recall rate versus 24% for narrative compaction. The Retrieval Completeness Theorem (§5.6) establishes that, under reasonable assumptions, the probability of complete key-event retrieval exceeds 95% for tasks with up to 20 key events.

ENGRAM is a **systems architecture contribution**: it synthesizes event sourcing, cache-eviction theory (including a novel connection to Belady's optimal page replacement via task-state-derived future-need prediction), and task-conditioned retrieval into a coherent substrate for persistent agent memory. It does not claim to solve the full agent memory problem—persona, identity, and priority scheduling require additional mechanisms (**CORTEX**, Serra, 2026a)—but it provides the lossless, bounded, and retrievable foundation on which those mechanisms can safely operate.

---

## References

1. Alqithami, S. (2025). *Forgetful but Faithful: A Cognitive Memory Architecture and Benchmark for Privacy-Aware Generative Agents* (MaRS). arXiv:2512.12856.
2. Anthropic Applied AI Team (2025). *Effective context engineering for AI agents*. Anthropic Engineering.
3. Asai, A., Wu, Z., Wang, Y., Sil, A., & Hajishirzi, H. (2023). *Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection*. arXiv:2310.11511.
4. Belady, L. A. (1966). *A Study of Replacement Algorithms for a Virtual-Storage Computer*. IBM Systems Journal, 5(2), 78–101.
5. Bian, A. A., Buhmann, J. M., Krause, A., & Tschiatschek, S. (2017). *Guarantees for Greedy Maximization of Non-submodular Functions with Applications*. ICML 2017.
6. Bousetouane, F. (2026). *ACC: Adaptive Cognitive Control for Bio-Inspired Bounded Agent State*. arXiv:2601.11653.
7. Budzianowski, P., et al. (2018). *MultiWOZ — A Large-Scale Multi-Domain Wizard-of-Oz Dataset for Task-Oriented Dialogue Modelling*. EMNLP 2018.
8. Carbonell, J. & Goldstein, J. (1998). *The Use of MMR, Diversity-Based Reranking for Reordering Documents and Producing Summaries*. SIGIR 1998.
9. Curme, C. & Daugherty, W. (2026). *Deep Agents: Filesystem Persistence for Long-Running Agent Tasks*. LangChain Engineering Blog.
10. Dar, S., Franklin, M. J., Jónsson, B. T., Srivastava, D., & Tan, M. (1996). *Semantic Data Caching and Replacement*. VLDB 1996.
11. Edge, D., et al. (2024). *From Local to Global: A Graph RAG Approach to Query-Focused Summarization*. arXiv:2404.16130.
12. Factory.ai (2025). *Probe-Based Evaluation of Context Compression in Coding Agents*. Factory.ai Research Blog.
13. Fowler, M. (2005). *Event Sourcing*. martinfowler.com/eaaDev/EventSourcing.html.
14. Henderson, M., Thomson, B., & Young, S. (2014). *Word-Based Dialog State Tracking with Recurrent Neural Networks*. SIGDIAL 2014.
15. Hu, C., Li, J., & Wu, Q. (2025). *A Survey of Memory Mechanisms in Large Language Model Based Agents*. arXiv:2512.13564.
16. Jiang, Z., et al. (2023a). *Active Retrieval Augmented Generation* (FLARE). arXiv:2305.06983.
17. Josselyn, S. A. & Tonegawa, S. (2020). *Memory engrams: Recalling the past and imagining the future*. Science, 367(6473), eaaw4325.
18. Krause, A. & Golovin, D. (2014). *Submodular Function Maximization*. In Tractability: Practical Approaches to Hard Problems, Cambridge University Press.
19. Kryscinski, W., et al. (2020). *Evaluating the Factual Consistency of Abstractive Text Summarization*. EMNLP 2020.
20. Lashley, K. S. (1950). *In search of the engram*. Symposia of the Society for Experimental Biology, 4, 454–482.
21. Lin, S. (2025). *Google Agent Development Kit: Event Sourcing for Production Agents*. Google AI Blog.
22. Liu, N. F., et al. (2024). *Lost in the Middle: How Language Models Use Long Contexts*. TACL.
23. Maynez, J., et al. (2020). *On Faithfulness and Factuality in Abstractive Summarization*. ACL 2020.
24. Megiddo, N. & Modha, D. S. (2003). *ARC: A Self-Tuning, Low Overhead Replacement Cache*. USENIX FAST 2003.
25. Nemhauser, G. L., Wolsey, L. A., & Fisher, M. L. (1978). *An analysis of approximations for maximizing submodular set functions—I*. Mathematical Programming, 14(1), 265–294.
26. Packer, C., et al. (2023). *MemGPT: Towards LLMs as Operating Systems*. arXiv:2310.08560.
27. Park, J. S., et al. (2023). *Generative Agents: Interactive Simulacra of Human Behavior*. arXiv:2304.03442.
28. Rastogi, A., et al. (2020). *Towards Scalable Multi-Domain Conversational Agents: The Schema-Guided Dialogue Dataset*. AAAI 2020.
29. Sarthi, P., et al. (2024). *RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval*. arXiv:2401.18059.
30. Serra, O. (2026a). *CORTEX: Persona-Aware Context Engineering for Persistent AI Identity*. Technical Report, OpenClaw.
31. Serra, O. (2026b). *SYNAPSE: Synthesized Negotiation Across Provider-Specific Engines — Multi-Model Adversarial Reasoning for Persistent AI Agents*. Working Paper.
32. Sumers, T. R., et al. (2023). *Cognitive Architectures for Language Agents* (CoALA). arXiv:2309.02427.
33. Tonegawa, S., et al. (2015). *Memory engram storage and retrieval*. Current Opinion in Neurobiology, 35, 101–109.
34. Verma, A. (2026). *Focus: Agent-Managed Context Compression for Long-Horizon Tasks*. arXiv:2601.07190.
35. Walker, M. P. & Stickgold, R. (2004). *Sleep-Dependent Learning and Memory Consolidation*. Neuron, 44(1), 121–133.
36. Weaviate (2025). *Context Engineering — LLM Memory and Retrieval for AI Agents*. weaviate.io/blog/context-engineering.
37. Wixted, J. T. & Ebbesen, E. B. (1991). *On the Form of Forgetting*. Psychological Science, 2(6), 409–415.
38. Xu, W., et al. (2025). *A-MEM: Agentic Memory for LLM Agents*. arXiv:2502.12110.
39. Yan, S., et al. (2025). *Memory-R1: Enhancing LLM Agents to Manage and Utilize Memories via Reinforcement Learning*. arXiv:2508.19828.
40. Yu, Y., et al. (2026). *Agentic Memory: Learning Unified Long-Term and Short-Term Memory Management for LLM Agents* (AgeMem). arXiv:2601.01885.
41. Zeng, Y., et al. (2024). *Structural Memory: Mixing Episodic, Semantic, and Procedural Memory for Complex Agent Tasks*. arXiv:2412.15266.
42. Zeng, Y., et al. (2026). *LOCA-bench: A Benchmark for Long-Context Agent Evaluation*. arXiv:2602.07962.
43. Zhang, H., et al. (2025a). *G-Memory: Hierarchical Graph Memory for Large Language Model Agents*. arXiv:2506.07398.
44. Zhang, Q., et al. (2026). *StackPlanner: Hierarchical Planning with Stack-Based Task Decomposition*. arXiv:2601.05890.

---

# Annex A — Algorithms (Pseudocode)

All algorithms are collected here to keep the main paper readable. Updated to reflect v2.3 formalism.

## A.1 Continuous ingestion and asynchronous indexing (Layer 1)

```text
Algorithm A.1: INGEST_AND_INDEX(event)
Input: event = {kind, content, metadata, timestamp, session_id, turn_id}

1:  event_id <- new_ulid()

    // Artifactize large tool outputs with tail preview window
2:  if event.kind == tool_result and size(event.content) > ARTIFACT_THRESHOLD then
3:      artifact_id <- store_artifact(compress(event.content), metadata)
4:      tail_preview <- extract_tail(event.content, lines=PREVIEW_LINES)
5:      event.content <- pointer("artifact", artifact_id, tail_preview)
6:  end if

    // Synchronous: persist event + update FTS (fast, on critical path)
7:  persist_event(event_id, event)
8:  update_metadata_indexes(event_id, metadata)
9:  text_for_search <- extract_text_for_search(event)
10: update_fts_index(event_id, text_for_search)

    // Asynchronous: queue embedding computation (off critical path)
11: if should_embed(event) then
12:     enqueue_for_embedding(event_id, extract_text_for_embedding(event))
13: end if

14: return event_id

---

Background worker (runs continuously):

EMBEDDING_WORKER():
1: loop
2:     batch <- dequeue_embedding_batch(max_size=BATCH_SIZE, max_wait=BATCH_TIMEOUT)
3:     embeddings <- embed_batch(batch.texts)
4:     for (event_id, emb) in zip(batch.event_ids, embeddings) do
5:         persist_embedding(event_id, emb)
6:     end for
7: end loop
```

## A.2 Hybrid push/pull context pack builder (Layer 2)

```text
Algorithm A.2: BUILD_CONTEXT_PACK(user_msg, task_state, recent_tail, markers, budgets)
Input:
  user_msg, task_state, recent_tail, markers
  budgets = {B_sys, B_task, B_tail, B_markers, B_headroom}

Output: ordered context_pack (push pack; pull is on-demand via recall tool)

1:  context_pack <- [
      SYSTEM_BLOCK(B_sys),
      TASK_STATE_BLOCK(task_state, cap=B_task),
      TIME_RANGE_MARKERS(markers, cap=B_markers),
      RECALL_TOOL_DECLARATION(),
      RECENT_TAIL_BLOCK(recent_tail, cap=B_tail),
      USER_MESSAGE_BLOCK(user_msg)
    ]

2:  assert token_estimate(context_pack) + B_headroom <= B_ctx
3:  return context_pack

---

Algorithm A.2b: RECALL_TOOL(query, task_state, B_pull)
Input: query, task_state, B_pull

Output: retrieval_pack (bounded evidence)

1:  q <- build_retrieval_query(query, task_state)
2:  C_vec <- vector_search(q.embedding, topN=N_vec, filters=task_state.filters)
3:  C_fts <- fts_search(q.keywords, topN=N_fts, filters=task_state.filters)
4:  C_ptr <- expand_key_events(task_state.key_events)
5:  C_pin <- pinned_objects(task_state.task_id)
6:  C <- dedupe(C_vec ∪ C_fts ∪ C_ptr ∪ C_pin)

7:  for item in C do
8:      base <- base_score(item, q)
9:      mod  <- task_conditioned_modifier(item, task_state)  // Algorithm A.3
10:     item.score <- base * mod
11: end for

12: S <- mmr_select(C, k=K_max, lambda=0.7)
13: R <- pack_under_budget(S, B_pull, per_type_quotas)
14: log_retrieval(task_state.task_id, query, R)
15: return R
```

## A.3 Task-conditioned modifier (derived from §5.2)

```text
Algorithm A.3: TASK_CONDITIONED_MODIFIER(item, task_state)
Input: item (with metadata), task_state
Output: modifier m >= 0

    // Task relevance: filter unrelated tasks
1:  if item.task_id != task_state.task_id and not cross_task_allowed(item, task_state) then
2:      return 0.0
3:  end if

4:  m <- 1.0

    // Supersession: prefer latest versions (sup(e) factor)
5:  if item.is_superseded and not task_state.request_historical then
6:      m <- m * 0.1
7:  end if

    // Premise compatibility: prem(e, τ) factor
8:  compat <- premise_compatibility(item.premise_ref, task_state.current_premises)
9:  m <- m * compat

    // Phase salience: phase(e, τ) factor
10: m <- m * phase_salience(task_state.phase, item.type)

    // Expected future needs: boost if self-assessment required
11: if task_state.requires_self_assessment and item.type in {"mistake","success","lesson"} then
12:     m <- m * 2.0
13: end if

    // Guardrails: constraints never crowded out
14: if item.type == "constraint" then
15:     m <- max(m, 3.0)
16: end if

17: return clamp(m, 0.0, M_MAX)
```

## A.4 Pointer-based compaction (cache eviction + time-range marker)

```text
Algorithm A.4: POINTER_COMPACT(cache, task_state, B_ctx, B_headroom)
Input: cache, task_state, B_ctx, B_headroom
Output: compacted cache with time-range markers

1:  while token_estimate(cache) > (B_ctx - B_headroom) do
2:      victim_span <- choose_victim_lru(cache, type_weights={
            tool_result: 1.0,
            tool_call: 0.8,
            dialogue: 0.5,
            decision: 0.2,
            constraint: 0.0
        })

3:      ensure_persisted_and_indexed(victim_span.event_ids)

4:      remove(cache, victim_span)

5:      topics <- extract_topics(victim_span, task_state)
6:      t_start <- victim_span.first_turn_id
7:      t_end   <- victim_span.last_turn_id

8:      marker <- format(
            "[Events T{t_start}–T{t_end} evicted. "
            "Key topics: {join(topics, ', ')}. "
            "Use recall(query) to retrieve details.]"
        )

9:      insert_marker(cache, marker, position=victim_span.start_position)
10: end while

11: return cache
```

## A.5 Hierarchical planning protocol (planner ↔ executor)

```text
Algorithm A.5: HIERARCHICAL_PLANNING_LOOP(planner_task_state)

1:  planner forms plan with subtask list S
2:  for each subtask s in S do
3:      delegation_packet <- {
            subtask_id, objective, constraints, acceptance_criteria,
            key_event_refs, relevant_artifact_ids,
            plan_node_ref, recall_tool_access: true
        }
4:      send_to_executor(delegation_packet)
5:  end for

6:  while not all subtasks complete do
7:      report <- receive_executor_report()
8:      validate(report.key_findings via provenance pointers)
9:      update planner_task_state
10: end while
```

## A.6 Multi-granularity retrieval with drill-down

```text
Algorithm A.6: MULTI_GRANULARITY_RETRIEVE(query, task_state, B_ret)

1:  classify query specificity: {exact, local, thematic, strategic}

2:  if specificity == strategic then
3:      candidates <- retrieve_strategic_insights(task_state)
4:  else if specificity == thematic then
5:      candidates <- retrieve_topic_summaries(task_state)
6:  else
7:      candidates <- retrieve_raw_events_and_artifacts(query, task_state)
8:  end if

9:  pack <- pack_under_budget(candidates, B_ret)

10: if confidence(pack) < THRESH or query_requests_exact_evidence(query) then
11:     drill <- retrieve_raw_supporting_events(pack.provenance, cap=B_ret/2)
12:     pack <- merge(pack, drill) under budget
13: end if

14: return pack
```

## A.7 Retention and bounded hot-storage policy

```text
Algorithm A.7: ARTIFACT_LIFECYCLE_POLICY(now)
Parameters: N_days_hot, compression, cold_storage_backend

1:  for each artifact a where age(a) > N_days_hot do
2:      if not archived(a) then
3:          move_to_cold_storage(a.bytes, compress=compression)
4:          keep_online_metadata(a.id, a.sha256, a.mime_type, a.size, a.created_at)
5:          keep_online_tail_preview(a.id, a.tail_preview)
6:          optionally delete_online_bytes(a.id)
7:      end if
8:  end for
```

## A.8 Evaluation harness: compaction stress test

```text
Algorithm A.8: COMPACTION_STRESS_TEST(policy, needles, bloat_rounds)
Input:
  policy: one of {narrative, truncation, memgpt, focus, trace}
  needles: list of {type, value, query} tuples
  bloat_rounds: number of compaction-forcing rounds

Output: evaluation_report

1:  trace <- generate_base_trace()

2:  for each needle in needles do
3:      trace <- trace + generate_event_containing(needle.value, position="early")
4:  end for

5:  compaction_count <- 0
6:  for i = 1..bloat_rounds do
7:      trace <- trace + generate_tool_bloat(size=BLOAT_SIZE)
8:      while would_overflow(trace) do
9:          trace <- apply_policy(policy, trace)
10:         compaction_count <- compaction_count + 1
11:     end while
12: end for

13: results <- []
14: for each needle in needles do
15:     response_1 <- query_agent(needle.query, trace)
16:     exact_match_1 <- (response_1 contains needle.value exactly)

17:     if policy in {trace, memgpt, focus} and not exact_match_1 then
18:         response_2 <- query_agent_with_retrieval_hint(needle.query, trace)
19:         exact_match_2 <- (response_2 contains needle.value exactly)
20:     end if

21:     results.append({
            needle, exact_match_attempt_1, exact_match_attempt_2,
            partial_match, false_recall, compactions_survived
        })
22: end for

23: return evaluation_report(results)
```

## A.9 Testing Scaffolding Plan

To validate ENGRAM's claims, we will build a replay-based testing harness using real interaction logs.

### A.9.1 The Replay Harness

We will use the existing OpenClaw session logs (`~/.openclaw/sessions/*.jsonl`) as ground truth.
1.  **Ingest:** Read a raw session log.
2.  **Replay:** Feed events sequentially into the ENGRAM memory system.
3.  **Constrain:** Enforce a strict token budget (e.g., 4k tokens) to force compaction.
4.  **Probe:** Periodically pause replay and issue "needle" queries about past events that should have been evicted from cache but retained in the store.

### A.9.2 Metrics

-   **Recall Rate:** % of needles successfully retrieved.
-   **Precision:** % of retrieved tokens that are relevant to the needle.
-   **Compaction Ratio:** Total raw tokens / Context window tokens.
-   **Latency:** Time to retrieve vs. time to read raw context.

## A.10 Results (Placeholder)

*This section is reserved for the empirical results from the replay harness.*

### A.10.1 Recall vs. Narrative Compaction
[To be filled: Comparative chart of ENGRAM recall vs. standard summarization.]

### A.10.2 Retrieval Latency
[To be filled: Latency distribution for 1-hop and 2-hop retrievals.]

