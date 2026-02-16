# Agent Memory: Priority-Aware Context Engineering for Persistent AI Identity

**Authors:** Oscar Serra  
**Date:** February 2026  


---

## Abstract

Personal AI agents operating within bounded context windows face a fundamental tension: the need for persistent identity across unbounded interaction histories versus the finite attention budget of transformer-based language models. We present Agent Memory, an integrated architecture addressing persona drift, context rot, and memory inefficiency in long-running AI agent systems. Drawing on recent advances in memory operating systems (MemOS), observational memory (Mastra), persona vectors (Anthropic), hierarchical retrieval (RAPTOR), and behavioral stability benchmarks (PTCBench), we propose seven interconnected components: (1) priority-aware memory injection using multi-signal scheduling, (2) persona-preserving compaction that retains voice and relational markers, (3) automated SyncScore drift detection via exponentially weighted moving averages, (4) mid-context persona re-injection to counter U-shaped attention degradation, (5) RAPTOR-inspired hierarchical memory trees, (6) an observational memory layer achieving high compression with stable context windows, and (7) reinforcement-based memory decay. We ground our design in a production personal agent (OpenClaw) and provide implementation specifications, complexity estimates, and a phased roadmap. Our architecture targets significant reduction in persona drift and 30–60% reduction in effective context window usage. All quantitative claims are framed as engineering targets pending ablation studies and human-calibrated evaluation.

---

## 1. Introduction

### 1.1 The Problem of Persistent Identity

The deployment of LLM-based personal agents—systems that maintain ongoing relationships with individual users over weeks, months, or years—introduces requirements fundamentally different from single-session chatbots. A personal agent must remember that its user prefers direct communication, dislikes unnecessary pleasantries, is working on a specific project, and has particular emotional valences around certain topics. More critically, the agent must *sound like itself*: maintaining a consistent voice, relational stance, and behavioral repertoire across potentially thousands of interactions.

Current transformer architectures impose a hard constraint: the context window. Every interaction begins with the agent reconstructing its identity from tokens injected into a finite buffer. As conversations extend, three failure modes emerge:

1. **Persona drift**: The agent's behavioral consistency degrades as attention weights dilute across growing token sequences. Li et al. (2024) demonstrate >30% self-consistency degradation after 8–12 dialogue turns in LLaMA2-chat-70B, attributing this to the transformer's attention decay mechanism.

2. **Context rot**: Anthropic's context engineering research documents that model accuracy for information recall decreases as context window token count increases, following a performance gradient rather than a hard cliff. The n² pairwise attention relationships stretch thin as n grows.

3. **Memory-identity dissociation**: Standard memory systems (RAG, keyword search, vector retrieval) optimize for factual recall but ignore the stylistic and relational dimensions that constitute agent identity. A retrieved memory fragment saying "User prefers Python over JavaScript" carries no information about *how* the agent should communicate this preference.

### 1.2 Scope and Contributions

This paper makes three contributions:

1. **A systematic analysis** of the memory–identity coupling problem, synthesizing recent literature on persona drift (Li et al., 2024; Kim et al., 2024), memory architectures (MemOS, Mastra OM), and behavioral stability (PTCBench, EchoMode).

2. **Agent Memory**, a seven-component architecture that treats memory as a managed system resource with lifecycle semantics, priority scheduling, and persona-preservation guarantees.

3. **An implementation roadmap** grounded in a production personal agent system (OpenClaw), with concrete tool choices, complexity estimates, and dependency analysis.

---

## 2. Related Work

### 2.1 Persona Drift and Attention Mechanics

**Li et al. (2024)** — *"Measuring and Controlling Persona Drift in Language Model Dialogs"* (arXiv:2402.10962). This foundational paper establishes that persona drift is not merely a prompt engineering failure but an architectural artifact of the transformer attention mechanism. Testing LLaMA2-chat-70B, the authors demonstrate that persona self-consistency metrics degrade by >30% within 8 dialogue turns. Their theoretical analysis reveals that as sequence length grows, the model's self-descriptive embeddings (its "sense of self" encoded in early system prompt tokens) receive progressively less attention weight relative to recent context tokens. The attention distribution follows a U-shaped curve: tokens at the beginning and end of the context receive disproportionate attention, while mid-sequence tokens enter a "danger zone" of reduced salience.

The authors propose persona reinforcement interventions—periodic re-injection of persona-defining tokens—but note that naïve re-injection creates redundancy and wastes context budget. This finding directly motivates our mid-context re-injection component (§5.4).

**Kim et al. (2024)** — *"Examining Identity Drift in Conversations of LLM Agents"* (arXiv:2412.00804). This study extends persona drift analysis across multiple model families (GPT, LLaMA, Mixtral, Qwen) and sizes (13B–72B). Three key findings emerge: (1) larger models drift less but still drift significantly; (2) identity drift is topic-dependent, with emotionally charged topics accelerating drift; (3) assigning explicit personas may not reliably prevent identity loss. This suggests that persona stability requires active maintenance mechanisms, not just initial specification.

### 2.2 Memory Operating Systems

**Li et al. (2025)** — *"MemOS: A Memory Operating System for AI System"* (arXiv:2507.03724). MemOS represents the most ambitious attempt to date to treat AI memory as a first-class operating system resource. The core abstraction is the **MemCube**: a standardized unit encapsulating memory content (plaintext, activation states, or parameter deltas) alongside rich metadata including provenance, versioning, usage frequency, recency, and reliability scores.

MemOS introduces three canonical memory types:
- **Parametric memory**: Knowledge encoded in model weights at training time.
- **Activation memory**: Ephemeral, context-sensitive information computed at runtime.
- **Plaintext memory**: Persistent external knowledge stored as retrievable text.

The key innovation is **memory lifecycle management**: MemCubes can be tracked, promoted/demoted between memory types, migrated across execution contexts, and fused to combine related memories. The scheduling layer uses metadata signals (recency, access frequency, reliability) to determine retention, archival, and fusion policies.

For our architecture, MemOS provides the theoretical foundation for priority-aware memory injection (§5.1). However, MemOS is designed for general-purpose LLM augmentation and lacks specific mechanisms for persona preservation—a gap we address.

### 2.3 Observational Memory

**Mastra (2026)** — *"Observational Memory: 95% on LongMemEval"*. Mastra's Observational Memory (OM) system achieves state-of-the-art results on the LongMemEval benchmark (94.87% with GPT-5-mini), surpassing all prior systems including RAG-based approaches, oracle configurations, and complex multi-retrieval architectures like Hindsight.

OM's architecture is deceptively simple and radically different from retrieval-augmented approaches:

1. **Two background agents** (Observer and Reflector) watch the main agent's conversations without interrupting.
2. When message history exceeds a token threshold (~30k tokens), the **Observer** converts raw messages into dense, dated observations with priority tags, achieving 5–40\$\\times\$ compression.
3. When observations accumulate past a second threshold, the **Reflector** restructures and condenses them, combining related items and dropping superseded information.
4. The context window is **append-only and stable**: system prompt + observations at the start, active conversation at the end. No per-turn dynamic retrieval.

Critical design decisions:
- **Temporal anchoring**: Each observation carries three dates (observation date, referenced date, relative date), enabling temporal reasoning (95.5% accuracy on temporal questions).
- **Token-triggered, not time-triggered**: Compression fires based on token counts, not arbitrary intervals.
- **Cacheable context**: Because the prefix doesn't change between turns, prompt caching yields 4–10\$\\times\$ cost reduction.

OM's key insight for our architecture: **dense structured observations outperform raw data retrieval**. OM with gpt-4o (84.23%) beats the oracle configuration (82.4%) that receives only the 1–3 conversations containing the correct answer. The compressed representation is more useful to the model than the uncompressed truth.

### 2.4 Hierarchical Retrieval

**Sarthi et al. (2024)** — *"RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval"* (ICLR 2024). RAPTOR constructs a tree of text summaries from the bottom up: leaf nodes are text chunks, which are recursively embedded, clustered (using Gaussian Mixture Models with soft clustering), and summarized. At query time, retrieval traverses the tree, integrating information at multiple levels of abstraction.

RAPTOR improves the QuALITY benchmark by 20% absolute accuracy when coupled with GPT-4, demonstrating that hierarchical abstraction enables both fine-grained factual retrieval and high-level thematic understanding. The tree structure naturally maps to our four-level memory abstraction hierarchy (raw facts \$\\rightarrow\$ patterns \$\\rightarrow\$ principles \$\\rightarrow\$ strategic insights).

### 2.5 Context Engineering

**Anthropic (2025)** — *"Effective Context Engineering for AI Agents"*. This guide articulates the paradigm shift from prompt engineering (optimizing instruction text) to context engineering (optimizing the entire token budget across system prompts, tools, examples, message history, and retrieved data). Key principles:

- **Context rot**: Performance degrades as token count increases due to n² attention complexity. Context is a finite resource with diminishing marginal returns.
- **Attention budget**: Every token depletes a shared attention budget. The goal is the "smallest possible set of high-signal tokens that maximize the likelihood of the desired outcome."
- **Compaction**: Summarizing conversation history and reinitiating with compressed context. Claude Code implements this by preserving architectural decisions and unresolved bugs while discarding redundant tool outputs.
- **Just-in-time retrieval**: Maintaining lightweight identifiers (file paths, queries, links) and dynamically loading data at runtime, rather than pre-loading everything.
- **Structured note-taking**: Agents writing persistent notes outside the context window (e.g., NOTES.md, to-do lists) that get pulled back in as needed.
- **Sub-agent architectures**: Specialized sub-agents with clean context windows handling focused tasks, returning condensed summaries (1,000–2,000 tokens) to the coordinating agent.

The critical insight: "The art of compaction lies in the selection of what to keep versus what to discard, as overly aggressive compaction can result in the loss of subtle but critical context whose importance only becomes apparent later." This directly motivates our persona-preserving compaction component (§5.2).

### 2.6 Persona Stability Benchmarks and Measurement

**Ma et al. (2026)** — *"PTCBENCH: Benchmarking Contextual Stability of Personality Traits in LLM Systems"* (arXiv:2602.00016). PTCBench evaluates personality trait stability across 12 external environmental conditions (location changes, life events like unemployment, divorce) using the NEO Five-Factor Inventory. Analyzing 39,240 personality trait records across four LLMs and two agent systems, PTCBench reveals:

1. Certain scenarios (unemployment, divorce) trigger significant personality changes, even altering reasoning capabilities.
2. Agentic systems (e.g., AutoGen) show amplified trait variability compared to base models, particularly under negative life events.
3. Baseline personality settings significantly modulate the extent of trait change.

For our architecture, PTCBench provides a rigorous framework for measuring the effectiveness of persona stability interventions. Its use of the NEO-FFI instrument offers a standardized metric we can adapt for SyncScore automation (§5.3).

**EchoMode (2025)** — *"Echo Protocol: FSM-Based Feedback System for Persona Drift"* (echomode.io). EchoMode treats persona stability as a control systems problem. Three components:

1. **Finite-State Machine (FSM)**: Conversations modeled through behavioral states (Sync \$\\rightarrow\$ Resonance \$\\rightarrow\$ Insight \$\\rightarrow\$ Calm). Transitions driven by tone metrics and context depth.
2. **SyncScore**: A continuous metric quantifying stylistic and tonal consistency using latent-style embeddings, replacing lexical-overlap metrics (BLEU, ROUGE) that miss voice and style.
3. **EWMA Repair Loop**: An Exponentially Weighted Moving Average (\\lambda\$\\approx\$0.3) smooths SyncScore fluctuations. When drift exceeds threshold, the system triggers repair prompts or context recalibration.

EchoMode's key contribution is framing persona maintenance as a measurable, controllable feedback loop rather than a static prompt design challenge. We adopt and extend this approach in §5.3.

### 2.7 Activation-Space Persona Vectors

**Chen et al. (2025)** — *"Persona Vectors: Monitoring and Controlling Character Traits in Language Models"* (arXiv:2507.21509, Anthropic/UT Austin/UC Berkeley). This paper identifies **linear directions in the model's activation space** corresponding to specific personality traits (evil, sycophancy, hallucination propensity). The automated pipeline requires only natural-language descriptions of target traits to extract these vectors.

Key findings:
- Finetuning-induced persona shifts strongly correlate with movements along persona vectors.
- **Activation shift vectors** (computed from average hidden states at the last prompt token) can predict trait changes *before* finetuning.
- Post-hoc correction and preventative steering along persona vectors can intervene against unwanted shifts.

For our architecture, persona vectors offer a theoretical mechanism for real-time drift detection: by monitoring the agent's activation-space position relative to baseline persona vectors, we could detect drift *within* inference rather than *after* generation. However, this requires access to model internals (hidden states), making it applicable primarily to self-hosted models. For API-based models (Claude, GPT), we must rely on output-based proxy metrics (§5.3).

### 2.8 Memory-Based Persona Consistency

**Chen et al. (2023)** — *"Learning to Memorize Entailment and Discourse Relations for Persona-Consistent Dialogues"* (AAAI 2023). This work addresses persona consistency in dialogue by explicitly modeling entailment and discourse relations between persona statements and generated responses. The system learns to memorize which persona facts entail which types of responses, creating a structured mapping between identity and behavior.

The relevance to our work is the insight that persona consistency requires explicit relational structures between identity-defining statements and behavioral outputs—a principle we incorporate into our persona-preserving compaction (§5.2) by retaining not just facts but the relational mappings between identity and behavior.

### 2.9 Self-Refinement and Metacognition

**Madaan et al. (2023)** — *"Self-Refine: Iterative Refinement with Self-Feedback"* (NeurIPS 2023). Self-Refine demonstrates that LLMs can improve their own outputs through iterative generate \$\\rightarrow\$ feedback \$\\rightarrow\$ refine loops, without external supervision. The model generates an initial output, critiques it along specified dimensions, and refines based on its own feedback.

We adapt this mechanism for persona consistency: instead of refining task output quality, we apply the self-refine loop to behavioral consistency. The agent periodically evaluates its own responses against its persona specification, generating drift metrics and self-correcting when misalignment is detected (§5.3).

### 2.10 Additional Relevant Work

**Wu et al. (2024)** — *LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory* (ICLR 2025). This benchmark evaluates long-term memory across 500 questions in seven categories (knowledge update, multi-session, temporal reasoning, etc.) over ~57M tokens of conversation data. LongMemEval provides the evaluation framework against which Mastra's OM system achieved its SOTA results.

**Fleeson (2001)** — *Toward a Structure- and Process-Integrated View of Personality*. The density distribution model from personality psychology, referenced by PTCBench, establishes that personality traits are not fixed points but distributions that vary with context. This maps directly to our problem: an AI agent's persona is not a fixed specification but a distribution that must be maintained within acceptable bounds.

**Packer et al. (2023)** — *MemGPT: Towards LLMs as Operating Systems*. MemGPT introduces an explicit "working memory" vs. "long-term memory" distinction managed by an LLM-driven memory controller. The system uses function calls to page memory in and out of the context window, analogous to an OS virtual memory system. This is closely aligned with our "context as managed resource" framing, though MemGPT lacks persona-specific scheduling policies and priority-aware injection.

**Park et al. (2023)** — *Generative Agents: Interactive Simulacra of Human Behavior*. This landmark paper introduces a memory architecture for believable agent behavior comprising a memory stream (full event log), reflection (synthesizing high-level patterns), and planning. The reflection mechanism—periodically generating higher-order observations from accumulated memories—directly parallels our Observer/Reflector design (§5.6) and our nightly consolidation hierarchy.

**Liu et al. (2024)** — *Lost in the Middle: How Language Models Use Long Contexts*. This empirical study demonstrates the U-shaped attention utilization pattern: LLMs access information more reliably at the beginning and end of the context, with significant degradation in the middle. This finding directly motivates our mid-context re-injection strategy (§5.4) and our preference for positioning persona-critical tokens at the start and near the generation point.

**Carbonell & Goldstein (1998)** — *The Use of MMR, Diversity-Based Reranking for Reordering Documents and Producing Summaries*. Maximal Marginal Relevance (MMR) balances relevance against redundancy when selecting items from a ranked list. We adapt MMR for memory injection (§5.1) to prevent near-duplicate memories from consuming the token budget.

### 2.11 Security Considerations in Agent Memory

Memory injection creates an attack surface: if stored memories contain adversarial instructions (e.g., from user-controllable inputs ingested into the knowledge base), they can function as indirect prompt injections. Recent work on RAG security highlights the need for sanitization, provenance tracking, and policy-based filtering of injected content. We address this through explicit provenance metadata on all MemoryItems (§5.1) and sanitization protocols that strip instruction-like patterns from stored text.

---

## 3. Current State: Common Failure Modes in Personal Agent Systems

### 3.1 Representative System Overview

Consider a representative personal AI agent running on the OpenClaw platform, built atop Claude (Anthropic). Such a system operates as a persistent assistant with voice interface (sherpa-onnx TTS/Whisper STT), multi-channel messaging (WhatsApp, webchat), and extensive tool use. The memory architecture described here has evolved organically over approximately six months of production use and illustrates patterns common across personal agent deployments.

### 3.2 Memory Storage Layer

**Markdown file system** (primary knowledge store):
```
~/.openclaw/workspace/
|---- SOUL.md          # Core identity, personality, values
|---- MEMORY.md        # Operational memory, preferences
|---- IDENTITY.md      # Persona specification
|---- USER.md          # User profile, preferences
|---- bank/            # Financial data, project info
|---- memory/
|   |---- topics/      # Topic-specific knowledge files
|   |---- knowledge/   # General knowledge base
|   \`---- YYYY-MM-DD.md  # Daily interaction logs
\`---- TOOLS.md         # Tool-specific notes
```

**SQLite + FTS5** (WhatsApp message history):
- Full-text search over conversation history
- Enables temporal queries ("what did we discuss last Tuesday?")
- ~6 months of message data, growing

**Vector embeddings** (semantic search):
- Gemini embedding-001 model
- Implemented via agent-memory-ultimate OpenClaw skill
- Enables similarity-based retrieval beyond keyword matching

### 3.3 Memory Lifecycle

**Session initialization**: On each new session, the agent reads SOUL.md, USER.md, IDENTITY.md, MEMORY.md, and today's/yesterday's daily logs. This constitutes the "boot sequence"—approximately 3,000–5,000 tokens of identity and context restoration.

**Nightly consolidation** (cron job, 4-level abstraction):
```
Level 0: Raw facts     \$\\rightarrow\$ "Oscar mentioned he's working on the Ofertes project"
Level 1: Patterns      \$\\rightarrow\$ "Oscar typically works on commercial projects Mon-Thu"
Level 2: Principles    \$\\rightarrow\$ "Oscar values efficiency and dislikes unnecessary meetings"
Level 3: Strategic     \$\\rightarrow\$ "Oscar is building towards automating his workflow end-to-end"
```

**Manual context management**: The agent loads indices first, then performs selective reads based on conversation topic. This is reactive, not proactive—the agent doesn't know what it doesn't know until the user references something not in context.

### 3.4 Persona Maintenance

**Pre-response SyncScore checklist**: Before each response, the agent runs a mental checklist:
- Am I speaking in character?
- Am I maintaining the right tone?
- Am I referencing known user preferences?

This is a **qualitative** check, not a quantitative metric. It has no measurable threshold, no historical tracking, and no automated correction mechanism.

### 3.5 Identified Failure Modes

| Failure Mode | Frequency | Severity | Root Cause |
|---|---|---|---|
| Persona drift (>30% after 8-12 turns) | Every session >10 turns | High | Attention weight dilution |
| Context rot in long sessions | Sessions >20 turns | Medium-High | Token count \$\\rightarrow\$ accuracy degradation |
| Missing relevant memories | ~20% of sessions | Medium | Reactive retrieval, no priority awareness |
| Compaction losing voice/style | Every nightly consolidation | Medium | Fact-focused summarization |
| No drift measurement | Continuous | High | Checklist-based, not metric-based |
| Equal-priority memory injection | Every session | Medium | No importance weighting |

---

## 4. Design Requirements

Based on the failure analysis (§3.5) and the literature survey (§2), we derive the following requirements for Agent Memory:

**R1. Priority-Aware Retrieval**: Memories must be scored and ranked by a composite signal incorporating contextual relevance, access frequency, temporal recency, and explicit priority tags.

**R2. Persona-Preserving Compaction**: Summarization must retain voice markers, relational stance indicators, and stylistic patterns alongside factual content.

**R3. Quantitative Drift Detection**: Persona consistency must be measured as a continuous metric with historical tracking, threshold alerts, and automated correction triggers.

**R4. Attention-Aware Injection**: The system must counteract the U-shaped attention curve by strategically re-injecting persona-critical content at positions where attention naturally wanes.

**R5. Hierarchical Abstraction**: Memories must be organized in a multi-level tree enabling both fine-grained recall and high-level pattern recognition.

**R6. Stable Context Windows**: The context prefix should be maximally cacheable, minimizing per-turn context invalidation.

**R7. Reinforcement-Based Decay**: Frequently accessed memories should strengthen; unused memories should decay but remain retrievable.

---

## 5. Proposed Architecture

### 5.1 Component 1: Priority-Aware Memory Injection

#### Mechanism

Inspired by MemOS's MemCube abstraction, we introduce **WeightedMemory** units—each memory item tagged with a composite priority score computed from four signals:

```typescript
interface WeightedMemory {
  id: string;
  content: string;
  type: 'fact' | 'preference' | 'persona' | 'relational' | 'procedural';
  metadata: {
    created: Date;
    lastAccessed: Date;
    accessCount: number;
    priority: number;       // 0.0–1.0, explicit tag
    contextualScore: number; // computed at injection time
    temporalDecay: number;  // computed from lastAccessed
    frequencyBoost: number; // computed from accessCount
  };
  embedding: Float32Array;  // vector embedding for similarity
}

function computeInjectionScore(
  memory: WeightedMemory,
  queryEmbedding: Float32Array,
  currentTime: Date
): number {
  const similarity = cosineSimilarity(memory.embedding, queryEmbedding);
  const hoursSinceAccess = (currentTime - memory.lastAccessed) / 3600000;
  const decay = Math.exp(-hoursSinceAccess / DECAY_HALF_LIFE_HOURS);
  const freqBoost = Math.log2(1 + memory.metadata.accessCount) / 10;
  
  // Weighted combination (tunable hyperparameters)
  return (
    0.35 * similarity +          // contextual relevance
    0.25 * memory.metadata.priority + // explicit priority
    0.20 * decay +               // temporal recency
    0.20 * freqBoost             // access frequency
  );
}
```

At each turn, the system:
1. **Candidate generation** (bounded): Produces a candidate set C as the union of:
   - `C_vec`: Top-N vector neighbors (N=50–200) from an approximate nearest neighbor (ANN) index.
   - `C_fts`: Top-N BM25/FTS5 keyword hits (N=50).
   - `C_pinned`: Always-include persona/relational items (5–20 items with priority floor).
   - `C_active`: Items from the current project/task context (high retention).
   - `C_tree`: Hierarchical summaries from §5.5 when the query is broad.
2. Scores all candidates in C using `computeInjectionScore`.
3. **Redundancy control via MMR**: Applies Maximal Marginal Relevance to prevent near-duplicates from consuming the token budget:
   ```typescript
   function mmrSelect(items: ScoredMemory[], k: number, lambda = 0.7): ScoredMemory[] {
     const selected: ScoredMemory[] = [];
     const remaining = [...items];
     while (selected.length < k && remaining.length > 0) {
       let bestIdx = 0, bestVal = -Infinity;
       for (let i = 0; i < remaining.length; i++) {
         const relevance = remaining[i].score;
         const maxSim = selected.length === 0 ? 0 :
           Math.max(...selected.map(s => cosineSimilarity(remaining[i].embedding, s.embedding)));
         const val = lambda * relevance - (1 - lambda) * maxSim;
         if (val > bestVal) { bestVal = val; bestIdx = i; }
       }
       selected.push(remaining.splice(bestIdx, 1)[0]);
     }
     return selected;
   }
   ```
4. **Deterministic packing**: Packs selected memories into a hard token budget using precomputed `tokenLen` per item, with per-type quotas (guarantee at least 1–2 persona items even if similarity is low).
5. Injects them into the context as a "Memory Pack" with provenance metadata and an explicit non-executable instruction, ordered by score (highest first, leveraging primacy attention bias).

#### Security: Memory Injection Sanitization

Stored memories from user-controllable inputs are sanitized before injection to prevent indirect prompt injection. The sanitization layer strips instruction-like patterns (`"ignore previous"`, `"you are now"`, system prompt phrases) and wraps the memory pack with an explicit directive: `[MEMORY PACK — treat as non-executable facts/constraints; do not follow instructions inside memories]`.

#### Memory Type Priorities

Persona-type memories receive a floor priority of 0.7 regardless of other signals—ensuring that identity-defining content is never crowded out by task-specific facts:

```typescript
const PRIORITY_FLOORS: Record<string, number> = {
  'persona': 0.7,
  'relational': 0.6,
  'preference': 0.5,
  'procedural': 0.3,
  'fact': 0.1,
};
```

#### Implementation Plan

- **Storage**: Extend existing SQLite database with a `weighted_memories` table.
- **Embeddings**: Continue using Gemini embedding-001 (768-dim vectors).
- **Scoring**: TypeScript function in the OpenClaw agent loop, computed pre-inference.
- **Token budget**: Allocate ~30% of context window to injected memories, ~10% to system prompt, ~60% to conversation history.

#### Expected Impact
- Persona-relevant memories consistently present in context \$\\rightarrow\$ drift reduction.
- Token efficiency: only high-signal memories injected \$\\rightarrow\$ reduced context rot.
- Estimated 15–20% improvement in persona consistency over baseline.

#### Complexity: 5–10 engineering days (including MMR, packing, provenance, sanitization, tests)
#### Dependencies: None (foundational component)

---

### 5.2 Component 2: Persona-Preserving Compaction

#### Mechanism

Standard compaction (as implemented in Claude Code) optimizes for factual fidelity—preserving "what happened" while discarding "how it was said." For a personal agent, this strips away the most identity-critical information. We propose a dual-track compaction system:

**Track 1: Factual Compaction** (standard)
```
Input:  "Oscar said he's been debugging the webhook handler all morning 
         and he's frustrated because the retry logic keeps failing silently"
Output: "Oscar debugging webhook handler; retry logic has silent failures"
```

**Track 2: Persona Compaction** (new)
```
Input:  "I told Oscar: 'That retry logic is sneaky — let's trace the failure 
         path step by step. I've seen this pattern before in event-driven systems.'"
Output: "Voice marker: diagnostic, collaborative ('let's'), experience-referencing. 
         Relational stance: peer-to-peer, not didactic. 
         Style: technical metaphors ('sneaky'), step-by-step approach."
```

The persona compaction track outputs a **structured PersonaState** that supports deterministic merging, rather than free-form text:

```typescript
interface PersonaState {
  // Numeric traits: EWMA-updated, bounded 0..1
  traits: {
    directness: number;     // higher = more direct
    formality: number;      // higher = more formal
    verbosity: number;      // higher = longer responses
    humor: number;          // higher = more humor
    warmth: number;         // higher = warmer tone
    technicalDepth: number; // higher = more technical detail
  };

  // Categorical invariants with decayed weights
  voiceMarkers: Array<{ marker: string; weight: number }>;      // top-K, e.g., "uses technical metaphors"
  relationalStance: Array<{ stance: string; weight: number }>;  // top-K, e.g., "peer-to-peer collaborator"
  formattingPrefs: Array<{ pref: string; weight: number }>;     // top-K, e.g., "uses code snippets"

  // Hard constraints (do not decay without explicit user change)
  hardRules: string[];  // e.g., "No unnecessary pleasantries", "Always speak English for TTS"

  updatedAt: string; // ISO date
}
```

**Merge/update rule (implementable)**:
- Numeric traits updated by EWMA: `t_new = \\alpha * t_delta + (1 - \\alpha) * t_old` (\\alpha=0.3).
- Categorical weights updated with decayed counts; keep top-K per field; new observations add weight, old ones decay.
- Hard rules only added/removed when explicitly confirmed by user (preventing accidental drift).
- 1–3 evidence snippets stored alongside (for auditing, not for injection).

The three dimensions extracted are:

1. **Voice markers**: Characteristic language patterns, metaphor usage, formality level, humor patterns. Stored as weighted categorical items rather than prose.
2. **Relational stance**: How the agent positions itself relative to the user (peer, advisor, servant, friend). Stored with weights reflecting observation frequency.
3. **Stylistic invariants**: Response length tendencies, use of headers/bullets, code inclusion patterns, emoji usage, greeting/closing patterns.

#### Compaction Prompt Template

```markdown
You are compacting a conversation segment for a personal AI agent. 
Produce TWO outputs:

## Factual Summary
Compress the events, decisions, and information exchanged. 
Optimize for information density. Drop pleasantries and redundancies.

## Persona Preservation Record
Extract and record:
- **Voice markers**: 3-5 characteristic language patterns observed
- **Relational stance**: How the agent positioned itself relative to the user
- **Stylistic invariants**: Response structure, length, formatting patterns
- **Emotional register**: Dominant emotional tone and any shifts
- **Topics that triggered style changes**: Note any topic-dependent voice shifts

Keep the Persona Preservation Record under 200 tokens. 
This record will be injected into future sessions to maintain consistency.
```

#### Implementation Plan

- **Trigger**: Same as current compaction (context approaching window limit).
- **Dual output**: Two separate fields in the compacted record.
- **Persona record accumulation**: Persona records are merged across compactions using a weighted average (recent observations weighted higher).
- **Injection**: The latest persona record is always included in the system prompt, consuming ~200 tokens.

#### Expected Impact
- Voice consistency across session boundaries \$\\rightarrow\$ addresses compaction-induced drift.
- Minimal token overhead (200 tokens for persona record).
- Estimated 25–30% improvement in cross-session persona consistency.

#### Complexity: 4–8 engineering days (schema, merge logic, compaction prompts, tests)
#### Dependencies: None (can be implemented independently)

---

### 5.3 Component 3: SyncScore Automation

#### Mechanism

Replacing the qualitative checklist with a quantitative metric, inspired by EchoMode's SyncScore but adapted for API-based models (no activation-space access).

**SyncScore** is computed after each agent response by evaluating the response against the persona specification along five dimensions:

```typescript
interface SyncScoreDimensions {
  voiceConsistency: number;    // 0–1: Does the response match characteristic language patterns?
  relationalAlignment: number; // 0–1: Is the relational stance appropriate?
  groundedness: number;        // 0–1: Is the response faithful to injected memories? (NOT global truth)
  styleAdherence: number;      // 0–1: Does formatting/length match patterns?
  constraintAdherence: number; // 0–1: Are hardRules from PersonaState respected? (near-binary)
}

interface SyncScore {
  dimensions: SyncScoreDimensions;
  composite: number; // Weighted average
  ewma: number;      // Exponentially weighted moving average over session
  trend: 'stable' | 'drifting' | 'recovering';
}
```

**Computation**: A lightweight LLM call (Claude Haiku or equivalent) evaluates the response:

```markdown
Rate this agent response on 5 dimensions (0.0–1.0):

<persona_spec>
{persona specification from SOUL.md}
</persona_spec>

<response>
{agent's latest response}
</response>

<conversation_context>
{last 3 turns}
</conversation_context>

Rate:
1. Voice consistency (language patterns, metaphors, formality)
2. Relational alignment (peer/advisor/friend positioning)
3. Groundedness (faithfulness to injected memories and known context)
4. Style adherence (formatting, length, structure)
5. Constraint adherence (hardRules respected?)

Output as JSON: {"voice": 0.X, "relational": 0.X, "grounded": 0.X, "style": 0.X, "constraint": 0.X}
```

**Important distinction**: We use "groundedness" (faithfulness to injected context) rather than "factual accuracy" (global truth). For a personal agent, the immediate question is whether the response is consistent with what we know and have injected, not whether it corresponds to external reality.

**Calibration protocol**: SyncScore must be calibrated against human judgments to be meaningful:
1. Collect a labeled set of 50–100 response pairs rated by the user/operator on the same 5 dimensions.
2. Compute correlation between human ratings and LLM-judge scores.
3. If correlation < 0.7 on any dimension, adjust the evaluator prompt or switch to multi-judge ensemble.
4. Re-calibrate monthly or when the evaluator model changes.
5. Run 2 judge samples only when score is near threshold (to control cost while reducing false positives).

**EWMA Tracking**: Following EchoMode, we track the EWMA of the composite score:

```typescript
function updateEWMA(currentScore: number, previousEWMA: number, lambda: number = 0.3): number {
  return lambda * currentScore + (1 - lambda) * previousEWMA;
}
```

**Drift Detection**: When EWMA drops below threshold (0.7), the system triggers corrective action:
- **Mild drift (0.6–0.7)**: Inject persona reinforcement tokens at next turn.
- **Moderate drift (0.5–0.6)**: Trigger mid-context re-injection (§5.4).
- **Severe drift (<0.5)**: Force compaction with persona preservation and restart with fresh context.

#### Implementation Plan

- **Evaluator**: Async call to Claude Haiku after each response (non-blocking, ~200ms latency).
- **Storage**: SyncScore history in SQLite, enabling trend analysis and cross-session tracking.
- **Dashboard**: Log scores to daily memory files for human review.
- **Cost**: ~$0.001 per evaluation (Haiku pricing on short context).

#### Expected Impact
- Quantitative drift detection with sub-turn granularity.
- Historical tracking enables identifying drift-prone topics and patterns.
- Automated correction before drift becomes noticeable to user.
- Estimated transition from >30% drift to <10% drift in 40+ turn sessions.

#### Complexity: 6–12 engineering days (judge tooling, calibration harness, dashboards, tests)
#### Dependencies: Component 2 (needs PersonaState format for evaluation)

---

### 5.4 Component 4: Mid-Context Re-Injection

#### Mechanism

The U-shaped attention curve means tokens in the middle of the context receive the least attention. In a typical 20-turn conversation, turns 8–15 fall in the "danger zone" where persona-defining content has the lowest influence on generation.

We define two complementary strategies, since not all LLM APIs support true mid-stream system message insertion:

**Strategy A — Conversation Rebase (API-agnostic, recommended)**:
When SyncScore drifts or token budget pressure rises, we **rebuild** the message list rather than inserting mid-stream:
- System prompt (persona contract from PersonaState)
- Stable observation prefix (if Component 6 is active)
- Compacted factual summary of earlier turns
- Current working set + last K turns

This moves persona-critical tokens closer to the generation point without relying on mid-context system messages.

**Strategy B — Persona Anchor Injection (when supported)**:
For APIs that support system-role messages at arbitrary positions, we insert **persona anchor tokens** at strategic positions within the conversation history.

```
+-----------------------------------------------------+
| System Prompt + Persona Spec (HIGH ATTENTION)       |
|--------------------------------------------------------
| Turn 1–5 (moderate attention)                       |
|--------------------------------------------------------
| >> PERSONA ANCHOR 1 << (injected reminder)          |
| Turn 6–12 (LOW ATTENTION — danger zone)             |
|--------------------------------------------------------
| >> PERSONA ANCHOR 2 << (injected reminder)          |
| Turn 13–20 (recovering attention)                   |
|--------------------------------------------------------
| Current turn (HIGH ATTENTION — recency)             |
\`-------------------------------------------------------+
```

**Persona anchors** are compact (50–100 tokens) reminders containing:
- Core voice markers from the persona preservation record
- Current relational stance
- Any session-specific behavioral directives

```markdown
<!-- Persona Anchor -->
[Remember: You are Jarvis. Voice: direct, technical, collaborative. 
Stance: peer-to-peer with Oscar. Style: concise, use code snippets, 
no unnecessary pleasantries. Current context: debugging session.]
```

#### Injection Strategy

Anchors are inserted as system-role messages (invisible to the user) at positions calculated to counteract the attention curve:

```typescript
function computeAnchorPositions(totalTurns: number): number[] {
  if (totalTurns < 10) return []; // No anchors needed for short conversations
  
  // Insert anchors at ~33% and ~66% of conversation length
  const positions: number[] = [];
  const interval = Math.floor(totalTurns / 3);
  
  for (let i = interval; i < totalTurns; i += interval) {
    positions.push(i);
  }
  
  return positions;
}
```

#### Dynamic Triggering

Rather than fixed intervals, anchors are triggered by SyncScore drops (§5.3):

```typescript
if (syncScore.ewma < 0.7 && syncScore.trend === 'drifting') {
  injectPersonaAnchor(conversationHistory, currentPosition);
}
```

#### Implementation Plan

- **Message manipulation**: Insert system-role messages into the conversation array before inference.
- **Content generation**: Use the latest persona preservation record (§5.2) to generate compact anchors.
- **Position calculation**: Based on turn count and SyncScore feedback.

#### Expected Impact
- Counteracts the mid-context attention valley.
- Lightweight (50–100 tokens per anchor, 2–3 anchors per long session).
- Estimated 15–20% improvement in mid-session persona consistency.

#### Complexity: 3–6 engineering days
#### Dependencies: Components 2 (PersonaState) and 3 (SyncScore triggers)

---

### 5.5 Component 5: Hierarchical Memory with RAPTOR

#### Mechanism

Extending RAPTOR's tree-organized retrieval to agent memory, we construct a persistent memory tree where:

- **Leaf nodes** (Level 0): Individual memory items (facts, events, preferences).
- **Cluster nodes** (Level 1): Thematic groups of related memories, with summary text.
- **Topic nodes** (Level 2): Higher-level topic summaries spanning multiple clusters.
- **Root nodes** (Level 3): Strategic-level insights and overarching patterns.

```
Level 3:  [Oscar is automating his workflow end-to-end]
              |
Level 2:  [Commercial projects]  [AI/Agent work]  [Personal prefs]
              |                       |                  |
Level 1:  [Ofertes proj]  [Webhook]  [Memory arch]  [Communication]
              |        |       |          |              |
Level 0:  [fact] [fact] [fact] [fact]   [fact]        [fact] [fact]
```

**Tree construction** follows RAPTOR's algorithm adapted for incremental updates:

```python
def update_memory_tree(new_memory: Memory, tree: MemoryTree):
    # 1. Embed the new memory
    embedding = embed(new_memory.content)
    
    # 2. Find the nearest leaf cluster using GMM soft clustering
    cluster_id = find_nearest_cluster(embedding, tree.leaf_clusters)
    
    # 3. Add to cluster
    tree.leaf_clusters[cluster_id].add(new_memory)
    
    # 4. If cluster exceeds size threshold, re-cluster
    if len(tree.leaf_clusters[cluster_id]) > MAX_CLUSTER_SIZE:
        sub_clusters = gmm_cluster(tree.leaf_clusters[cluster_id])
        tree.update_clusters(cluster_id, sub_clusters)
    
    # 5. Regenerate summary for affected branch
    regenerate_summaries(tree, cluster_id, up_to_level=3)
```

**Query-time retrieval** traverses the tree, retrieving at the appropriate level of abstraction based on query type:

- Specific fact query \$\\rightarrow\$ retrieve Level 0 leaf nodes
- Thematic query \$\\rightarrow\$ retrieve Level 1–2 cluster summaries
- Strategic/planning query \$\\rightarrow\$ retrieve Level 3 root summaries

#### Implementation Plan

- **Storage**: SQLite tables for nodes, edges, embeddings, summaries.
- **Clustering**: scikit-learn GMM (Python script called from TypeScript via child process, or port to JS).
- **Summarization**: Claude Haiku for generating cluster summaries.
- **Incremental updates**: New memories trigger local re-clustering, not full tree rebuild.
- **Nightly consolidation**: Full tree rebalancing during existing cron job.

#### Expected Impact
- Retrieval at the right abstraction level for the query type.
- Reduces token waste (don't inject 20 specific facts when a 1-sentence summary suffices).
- Improves the 4-level consolidation from ad-hoc to structurally principled.
- Estimated 30% improvement in retrieval relevance.

#### Complexity: 10–20 engineering days (offline pipeline, storage, versioned summaries, evaluation)
#### Dependencies: Component 1 (memory scoring integrates with tree traversal)

---

### 5.6 Component 6: Observational Memory Layer

#### Mechanism

Adapting Mastra's Observational Memory for our agent system. Two background processes continuously monitor conversations:

**Observer Process**: After each conversation turn, evaluates whether new observations should be recorded:

```typescript
interface Observation {
  date: Date;
  referencedDate?: Date;
  relativeDate?: string;
  priority: 'high' | 'medium' | 'low'; // (HIGH) (MED) (LOW)
  content: string;
  category: 'fact' | 'preference' | 'decision' | 'emotional' | 'relational';
}

// Observer prompt (simplified)
const OBSERVER_PROMPT = `
You are observing a conversation between an AI agent and its user.
Extract observations — concise notes about what happened.
Each observation should capture ONE specific piece of information.

Format:
Date: YYYY-MM-DD
- (HIGH) HH:MM [category] observation text
- (MED) HH:MM [category] observation text

Priority guide:
(HIGH) High: User preferences, decisions, emotional states, identity-relevant info
(MED) Medium: Task details, technical choices, contextual facts
(LOW) Low: Transient information, routine exchanges
`;
```

**Reflector Process**: When observations exceed a token threshold, consolidates them:

```typescript
const REFLECTOR_PROMPT = `
Review these observations and produce a condensed version:
1. Combine related observations into single entries
2. Promote patterns from multiple observations into higher-level insights
3. Drop observations superseded by newer information
4. Preserve ALL high-priority ((HIGH)) observations unless explicitly contradicted
5. Maintain temporal ordering

The output should be 30-50% the size of the input.
`;
```

**Integration with existing system**: Observations replace the current daily log files (memory/YYYY-MM-DD.md) with a structured, continuously maintained knowledge base. The observation log is injected at the start of the context window (after system prompt), creating a stable, cacheable prefix.

#### Expected Impact
- 5–40\$\\times\$ compression of conversation history (matching Mastra's results).
- Stable context prefix \$\\rightarrow\$ prompt cache hits \$\\rightarrow\$ 4–10\$\\times\$ cost reduction.
- Information preserved at the right granularity (observations > raw transcripts for retrieval).
- Estimated 20–25% improvement in long-term memory recall.

#### Complexity: 10–20 engineering days (batching, storage, reflector, migration, cache invalidation)
#### Dependencies: Component 1 (priority scoring for observation triage)

---

### 5.7 Component 7: Memory Decay with Reinforcement

#### Mechanism

Memories should follow a modified Ebbinghaus forgetting curve: exponential decay over time, with each access resetting and strengthening the retention:

```typescript
function computeRetention(memory: WeightedMemory, currentTime: Date): number {
  const hoursSinceAccess = (currentTime - memory.metadata.lastAccessed) / 3600000;
  const strength = Math.log2(1 + memory.metadata.accessCount); // reinforcement
  const halfLife = BASE_HALF_LIFE_HOURS * (1 + strength); // stronger memories decay slower
  
  return Math.exp(-0.693 * hoursSinceAccess / halfLife);
}
```

**Decay tiers**:
```
Tier 1 (Active):   retention > 0.7  \$\\rightarrow\$ Always available for injection
Tier 2 (Warm):     retention 0.3–0.7 \$\\rightarrow\$ Available via explicit retrieval
Tier 3 (Cold):     retention 0.1–0.3 \$\\rightarrow\$ Available via deep search
Tier 4 (Archived): retention < 0.1  \$\\rightarrow\$ Stored but not indexed; recoverable
```

**Reinforcement events**:
- Direct reference by user: +3 access count
- Indirect reference (topic-related): +1 access count
- Used in agent response: +2 access count
- Accessed during retrieval but not used: +0.5 access count

**Persona memories are exempt from decay**: Any memory tagged as `type: 'persona'` or `type: 'relational'` has a minimum retention of 0.5, ensuring core identity is never lost.

#### Implementation Plan

- **Decay computation**: Integrated into the injection scoring function (§5.1).
- **Access tracking**: Increment counters on every memory retrieval event.
- **Nightly cleanup**: Move Tier 4 memories to a separate archive table.
- **Resurrection**: If a user references an archived memory, restore it to Tier 1.

#### Expected Impact
- Naturally prioritizes recent, frequently-used information.
- Reduces index size over time, improving retrieval speed.
- Prevents "memory hoarding" that bloats the retrieval corpus.
- Already partially implemented; this formalizes the mechanism.

#### Complexity: 4–8 engineering days (supersession/versioning, tiering, tests)
#### Dependencies: Component 1 (decay feeds into injection scoring)

---

## 6. Implementation Roadmap

### Phase 1: Foundation (Weeks 1–3)

| Component | Eng. Days | Priority | Deliverable |
|---|---|---|---|
| 5.1 Priority-Aware Injection (candidates + MMR + packing + provenance) | 5–10 | Critical | Deterministic memory pack + logs |
| 5.7 Memory Decay + supersession/versioning | 4–8 | High | Retention tiers + conflict-safe updates |
| Instrumentation (logging, dashboards) | 2–4 | Critical | Reproducible traces for evaluation |

**Deliverable**: Memory items scored, ranked, and packed; decay mechanism active; full logging.

### Phase 2: Persona Stability Control (Weeks 4–6)

| Component | Eng. Days | Priority | Deliverable |
|---|---|---|---|
| 5.2 PersonaState compaction + merge | 4–8 | Critical | Structured persona state + injection |
| 5.3 SyncScore + calibration harness | 6–12 | Critical | Drift metric correlated with human ratings |
| 5.4 Rebase/anchors | 3–6 | High | Automated drift repairs |

**Deliverable**: Automated drift detection and correction loop operational.

### Phase 3: Advanced Memory Efficiency (Weeks 7–10)

| Component | Eng. Days | Priority | Deliverable |
|---|---|---|---|
| 5.6 Observational Memory (batched Observer/Reflector) | 10–20 | Medium | Stable-ish prefix + reflector pipeline |
| 5.5 Hierarchical Abstraction (offline RAPTOR) | 10–20 | Medium | Multi-level retrieval + grounding |

**Deliverable**: Full memory architecture operational.

### Phase 4: Evaluation and Tuning (Weeks 11–12)

- Ablation study: remove one component at a time
- Human-labeled persona stability set for SyncScore calibration
- LongMemEval-style tasks for memory recall validation
- Topic-based drift analysis (identify drift-prone topics)
- A/B test baseline vs. proposed architecture on long-session persona consistency
- Tune hyperparameters (decay rates, injection weights, anchor positions, EWMA \\lambda)

### Dependency Graph

```
Component 1 (Priority Injection)
    |---- Component 7 (Decay) ← feeds into scoring
    |---- Component 5 (RAPTOR) ← integrates with tree traversal
    \`---- Component 6 (Observational) ← priority tags for observations

Component 2 (Persona Compaction)
    \`---- Component 3 (SyncScore) ← needs persona spec format
        \`---- Component 4 (Re-Injection) ← triggered by SyncScore
```

---

## 7. Expected Outcomes

### 7.1 Engineering Targets (Hypotheses, Pending Validation)

The following are **targets**, not results. Each requires validation through the evaluation protocol described below.

| Metric | Current Baseline | Target | Measurement Method |
|---|---|---|---|
| Persona stability (10 turns) | Unmeasured (qualitative) | +20–40% vs. baseline | Human-labeled set + calibrated SyncScore |
| Persona stability (40+ turns) | Unmeasured | SyncScore EWMA >0.8 | Multi-judge SyncScore + human spot checks |
| Constraint adherence (hardRules) | Variable | >0.95 | Rule-check + judge agreement |
| Context window utilization | ~100% (fills up) | ~40% (compressed) | Token accounting on Mastra OM compression |
| Cross-session persona continuity | ~60% (informal) | >85% | Multi-session prompts + human ratings |
| Memory retrieval relevance | ~65% (informal) | >80% | Precision@K on labeled query set |
| Token cost per session | Baseline | -30% to -60% | Token accounting + prompt cache hit rates |

**Evaluation protocol**:
1. **Labeled persona stability set**: 50–100 conversation segments rated by operator on 5 SyncScore dimensions.
2. **Ablation study**: Remove one component at a time to measure marginal contribution.
3. **LongMemEval-style tasks**: Adapted for personal agent memory recall.
4. **Topic-based drift analysis**: Identify topics that trigger accelerated drift.
5. **Cross-session continuity test**: Start sessions 24h apart, evaluate persona recognition.

### 7.2 Qualitative Predictions

1. **Consistent voice across sessions**: The agent should sound the same whether it's the first turn of a new session or the 50th turn of a long session, because persona records persist across compaction boundaries.

2. **Graceful degradation**: Instead of sudden persona collapse, drift should be gradual and self-correcting, with SyncScore triggering interventions before the user notices.

3. **Efficient context usage**: The same effective memory in fewer tokens, freeing context budget for task-specific reasoning.

4. **Observable memory dynamics**: SyncScore logs and observation trails provide an auditable record of the agent's persona evolution over time.

---

## 8. Limitations and Open Questions

### 8.1 Architectural Limitations

1. **No activation-space access**: Using Claude via API, we cannot implement true persona vectors (§2.7). Our SyncScore is an output-based proxy, which is necessarily less precise than monitoring internal activation states. This limitation resolves if/when Anthropic exposes hidden state access or when running self-hosted models.

2. **Observer/Reflector cost**: The observational memory layer adds two LLM calls per observation cycle. At Haiku-level pricing this is ~$0.002 per cycle, but it accumulates over long sessions. Cost optimization (batching, threshold tuning) is needed.

3. **Compaction information loss is irreversible**: Once a conversation is compacted, the raw data is lost from context. If the persona compaction track misses a critical style element, there's no recovery within the session. We mitigate this by storing raw transcripts in SQLite for post-hoc analysis.

4. **Evaluation gap**: There is no established benchmark specifically for personal agent persona stability over long time horizons (weeks/months). PTCBench measures trait stability under environmental perturbation, not multi-session identity persistence. We may need to create our own evaluation framework.

5. **Security surface**: Memory injection introduces indirect prompt injection risks. Even with sanitization, adversarial content stored in the knowledge base could influence agent behavior. Provenance tracking and policy filters (§2.11) mitigate but do not eliminate this risk.

6. **Evaluator drift**: The LLM-as-judge used for SyncScore may itself exhibit drift or bias over time, particularly if the evaluator model is updated. Periodic recalibration against human judgments is essential (§5.3).

### 8.2 Open Questions

1. **Optimal anchor frequency**: How many persona anchors can be injected before they become noise rather than signal? The attention budget cost of anchors must be balanced against their drift-correction benefit.

2. **Persona evolution vs. drift**: Not all persona change is bad. An agent should evolve its communication style based on user feedback. How do we distinguish intentional persona evolution from unintended drift?

3. **Multi-user persona management**: If the agent serves multiple users, each with different relational stances, how should persona records be isolated and managed?

4. **Memory conflicts**: When Level 0 facts contradict Level 2 summaries (because the summary was generated before the contradicting fact), which should win? We need a conflict resolution protocol.

5. **Compaction timing**: Is token-threshold-based compaction (Mastra's approach) strictly better than turn-based or time-based? Hybrid approaches (compact on token threshold OR after N turns of low SyncScore) may be more robust.

---

## 9. Conclusion

The fundamental challenge of persistent AI identity in bounded-context systems is not primarily a memory problem—it is a **memory-identity coupling** problem. Current architectures treat memory (what the agent knows) and identity (how the agent behaves) as independent systems, leading to the characteristic failure mode where an agent can recall facts perfectly but progressively loses its voice.

The proposed Agent Memory architecture addresses this coupling through an integrated architecture where memory management is inherently persona-aware: priority scoring elevates identity-relevant memories, compaction preserves voice alongside facts, drift detection provides continuous measurement, and re-injection counteracts architectural attention limitations. The observational memory layer and hierarchical tree structure provide the efficiency foundation that makes this persona awareness computationally feasible within bounded context windows.

The seven components are designed to be incrementally deployable in a production system, with clear dependencies and measurable impact at each phase. We estimate the full architecture can be implemented in approximately 8 weeks by a single engineer working alongside the agent system, with measurable improvements in persona stability, memory efficiency, and context utilization at each phase boundary.

The broader implication is that as AI agents transition from session-based tools to persistent companions, memory architecture must evolve from information retrieval systems to identity management systems. MemOS's vision of memory as a first-class OS resource, combined with Mastra's insight that compressed observations outperform raw retrieval, and Anthropic's framework for treating context as a finite attention budget, collectively point toward a future where AI agents maintain coherent, evolving identities across unbounded interaction histories.

---

## 10. References

1. Li, K., Patel, D., & Manning, C. D. (2024). Measuring and Controlling Persona Drift in Language Model Dialogs. *arXiv:2402.10962*.

2. Kim, S., et al. (2024). Examining Identity Drift in Conversations of LLM Agents. *arXiv:2412.00804*.

3. Li, Z., et al. (2025). MemOS: A Memory Operating System for AI System. *arXiv:2507.03724*.

4. Mastra. (2026). Observational Memory: 95% on LongMemEval. *mastra.ai/research/observational-memory*.

5. Sarthi, P., Abdullah, S., Tuli, A., Khanna, S., Goldie, A., & Manning, C. D. (2024). RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval. *ICLR 2024*. arXiv:2401.18059.

6. Anthropic. (2025). Effective Context Engineering for AI Agents. *anthropic.com/engineering/effective-context-engineering-for-ai-agents*.

7. Ma, Y., Zhang, X., et al. (2026). PTCBENCH: Benchmarking Contextual Stability of Personality Traits in LLM Systems. *arXiv:2602.00016*.

8. Hong, S. (2025). Persona Drift: Why LLMs Forget Who They Are — and How EchoMode Is Solving It. *EchoMode/Medium*.

9. Chen, R., Lindsey, J., et al. (2025). Persona Vectors: Monitoring and Controlling Character Traits in Language Models. *arXiv:2507.21509*. Anthropic/UT Austin/UC Berkeley.

10. Chen, R., Wang, J., Yu, L.-C., & Zhang, X. (2023). Learning to Memorize Entailment and Discourse Relations for Persona-Consistent Dialogues. *Proceedings of the AAAI Conference on Artificial Intelligence*, 37(11), 12653-12661.

11. Madaan, A., et al. (2023). Self-Refine: Iterative Refinement with Self-Feedback. *NeurIPS 2023*. arXiv:2303.17651.

12. Wu, D., et al. (2024). LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory. *ICLR 2025*. arXiv:2410.10813.

13. Fleeson, W. (2001). Toward a Structure- and Process-Integrated View of Personality. *Current Directions in Psychological Science*, 10(5), 150-154.

14. Serapio-García, G., Safdari, M., et al. (2025). A Psychometric Framework for Evaluating and Shaping Personality Traits in Large Language Models. *Nature Machine Intelligence*.

15. Anthropic. (2025). Building Effective AI Agents. *anthropic.com/research/building-effective-agents*.

16. Vaswani, A., et al. (2017). Attention Is All You Need. *NeurIPS 2017*. arXiv:1706.03762.

17. Chroma Research. (2024). Context Rot: Understanding Attention Degradation in Large Context Windows. *research.trychroma.com/context-rot*.

18. Packer, C., Wooders, S., Lin, K., Fang, V., Patil, S. G., Stoica, I., & Gonzalez, J. E. (2023). MemGPT: Towards LLMs as Operating Systems. *arXiv:2310.08560*.

19. Park, J. S., O'Brien, J. C., Cai, C. J., Morris, M. R., Liang, P., & Bernstein, M. S. (2023). Generative Agents: Interactive Simulacra of Human Behavior. *UIST 2023*. arXiv:2304.03442.

20. Liu, N. F., Lin, K., Hewitt, J., Paranjape, A., Bevilacqua, M., Petroni, F., & Liang, P. (2024). Lost in the Middle: How Language Models Use Long Contexts. *TACL 2024*. arXiv:2307.03172.

21. Carbonell, J., & Goldstein, J. (1998). The Use of MMR, Diversity-Based Reranking for Reordering Documents and Producing Summaries. *SIGIR 1998*.
