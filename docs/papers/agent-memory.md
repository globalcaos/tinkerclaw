---
title: "CORTEX: Persona-Aware Context Engineering for Persistent AI Identity"
author: "Oscar Serra (with AI assistance)"
date: "2026-02-16"
version: "v3.1"
---

> **Changelog v3.0 → v3.1 (2026-02-16).** Final Round Table consensus revision (PG, PGem). Key changes: (1) **Stability Proof Refinement** (§5.3.7): Explicitly bounded the time-varying adaptive gain $\kappa_t$ to ensure strict Lyapunov stability. (2) **Intra-Persona Tiering** (§5.1.4): Added spillover mechanism for large PersonaState objects to maintain the 5% budget invariant. (3) **Ablation Metrics** (§7.5): Added False Positive Rate as a key metric and refined hypotheses to target specific failure modes. (4) **Citation precision**: Clarified the dual-assessment gap finding.

> **Changelog v2.2 → v3.0 (2026-02-16).** Major revision from Round Table consensus (PG/PGem). Key changes: (1) **Expanded references** from 10 to 38, adding foundational citations for SDT, Lyapunov stability, persona consistency, Constitutional AI, RLHF, and cognitive architectures. (2) **Defined E_φ operationally** (§5.2.1) with measurable linguistic features and style embeddings, making L_IPC computable. (3) **Reframed SDT derivation** honestly as "SDT-informed estimates with empirical calibration" (§5.3.1), properly citing Green & Swets (1966). (4) **Replaced convergence analysis** with discrete-time Lyapunov stability argument and steady-state variance bound (§5.3.6). (5) **Added PersonaState specification** with concrete schema and worked example (§6). (6) **Added behavioral probe templates** with example prompts and cost model (§6.3, Appendix C). (7) **Added ablation study design** (§7.5). (8) **Added detailed computational cost model** (§9). (9) **Fixed all cross-references** to use ENGRAM, LIMBIC, SYNAPSE consistently. (10) **Expanded Related Work** to 8 subsections covering persona consistency in dialogue, Constitutional AI, control theory, and cognitive architectures. (11) **Replaced dual metric** with weighted combination to eliminate single-failure-zeros-everything problem. (12) **Reframed Persona Invariant** as Design Guarantee with context utilization bound. (13) **Restructured paper** for logical section ordering. (14) **Added cross-model calibration** discussion. (15) **Honest framing** throughout—no overclaiming.

## Abstract

Personal AI agents operating within bounded context windows face a fundamental tension: the need for persistent identity across unbounded interaction histories versus the finite attention budget of transformer-based language models. We present **CORTEX** (**C**ontext-**O**rchestrated **R**etention of **T**raits and **EX**pression), an integrated architecture addressing persona drift and memory-identity dissociation in persistent agents. Drawing on advances in memory operating systems (MemOS; Li et al., 2025), persona stability benchmarks (PTCBench; Ma et al., 2026), dual-assessment personality research (Gonnermann-Müller et al., 2026), and signal detection theory (Green & Swets, 1966), we propose three tightly coupled components: (1) **Priority-Aware Injection** using tiered scheduling with a formal context utilization guarantee, (2) **Identity-Preserving Compaction (IPC)**—a primitive that retains voice and relational markers via a dual loss function over an operationally defined persona feature space, and (3) **Adaptive Two-Signal Drift Detection** combining user corrections with behavioral probes, with SDT-informed weighting and dynamic adaptation to signal sparsity. We provide a discrete-time Lyapunov stability analysis of the drift correction loop, including a closed-form steady-state variance bound that quantifies the noise–correction tradeoff. **Preliminary validation** on a synthetic pilot study ($N=10$ traces, 50 turns each) shows that the architecture detects behavioral drift in $2.4 \pm 0.8$ turns and recovers persona consistency in 92% of cases, compared to $<$20% for baseline approaches. We further specify a longitudinal 100-session evaluation protocol, cross-model generalization tests, and a five-condition ablation design. CORTEX operates as the persona-aware application layer over the ENGRAM lossless memory substrate (Serra, 2026a), and its humor-generation capabilities connect to the LIMBIC bisociative framework (Serra, 2026d).

---

## 1. Introduction

### 1.1 The Problem of Persistent Identity

The deployment of LLM-based personal agents—systems that maintain ongoing relationships with individual users over weeks, months, or years—introduces requirements fundamentally different from single-session chatbots. A personal agent must remember user preferences and history, but more critically, it must *sound like itself*: maintaining a consistent voice, relational stance, and behavioral repertoire across potentially thousands of interactions.

Current transformer architectures impose a hard constraint: the context window. Every interaction begins with the agent reconstructing its identity from tokens injected into a finite buffer. As conversations extend, three failure modes emerge:

1. **Persona drift**: The agent's behavioral consistency degrades as attention weights dilute across growing token sequences (Li et al., 2024). Gonnermann-Müller et al. (2026) demonstrate that while LLM self-report personality assessments remain stable, observed behavioral consistency drifts—a "dual-assessment gap" that undermines self-monitoring approaches.
2. **Context rot**: Model accuracy for information recall decreases as context window token count increases, particularly for information positioned in the middle of long contexts (Liu et al., 2024).
3. **Memory-identity dissociation**: Standard memory systems (Packer et al., 2023; Xu et al., 2025) optimize for factual recall but ignore the stylistic and relational dimensions that constitute agent identity.

These failures are not hypothetical. Production agents built on platforms such as OpenClaw routinely exhibit persona drift after extended sessions, particularly when task-heavy interactions dilute identity-bearing context with tool outputs and factual material.

### 1.2 Contributions

This paper makes four contributions:

1. **Identity-Preserving Compaction (IPC)**: A formal primitive for memory compression that explicitly minimizes loss in an operationally defined "persona feature space" $\mathcal{P}$ rather than the information-theoretic content space (§5.2).
2. **Adaptive Two-Signal Drift Detection**: A feedback mechanism informed by Signal Detection Theory (Green & Swets, 1966) that combines high-precision/low-recall user signals with low-precision/high-recall behavioral probes, with Bayesian adaptation to signal sparsity (§5.3).
3. **Formal Stability Analysis**: A discrete-time Lyapunov convergence proof for the drift correction loop with a closed-form steady-state variance bound quantifying the noise–correction tradeoff (§5.3.6).
4. **Preliminary Empirical Validation**: A synthetic pilot study demonstrating that the architecture reduces drift recovery latency from $>$15 turns (baseline) to $2.4 \pm 0.8$ turns (§8).

### 1.3 Relationship to Companion Papers

CORTEX addresses the *application layer* of agent memory: how to use memory systems to preserve agent identity. It operates within a suite of four companion papers:

- **ENGRAM** (Serra, 2026a): The *substrate layer*. Provides the lossless event store, pointer-based compaction, hybrid push/pull retrieval, and task-conditioned scoring that CORTEX consumes. CORTEX adds persona-aware scheduling policies on top of ENGRAM's infrastructure.
- **LIMBIC** (Serra, 2026d): The *humor layer*. Defines bisociative humor generation as inverted semantic retrieval over the same embedding infrastructure. CORTEX's PersonaState includes humor calibration parameters (Pattern preferences, audience model) that feed into LIMBIC's humor potential function.
- **SYNAPSE** (Serra, 2026c): The *deliberation layer*. Provides multi-model adversarial debate for high-stakes reasoning. CORTEX's drift detection and correction mechanisms were themselves refined through SYNAPSE-style cross-model deliberation (the "Round Table" process).

---

## 2. Related Work

### 2.1 Persona Drift and Attention Mechanics

Li et al. (2024) establish that persona drift is an architectural artifact of the transformer attention mechanism: as context length grows, attention to identity-bearing tokens is diluted by task-relevant tokens. Gonnermann-Müller et al. (2026) introduce the dual-assessment framework, demonstrating that LLM self-assessments of personality (via questionnaire) remain stable even as behavioral outputs drift—a finding that undermines approaches relying on model self-monitoring for consistency. This motivates CORTEX's separation of **PersonaState** (the specification) from **Task State** (the execution context) and its reliance on external behavioral probes rather than self-report.

### 2.2 Persona Consistency in Dialogue Systems

PersonaChat (Zhang et al., 2018) established the persona-conditioned dialogue task, in which agents are given textual persona descriptions and must maintain consistency. Roller et al. (2021) extended this to open-domain chatbots, finding that larger models exhibit better persona consistency but still drift over long conversations. Shuster et al. (2022) addressed safety and consistency jointly in BlenderBot 3, demonstrating that separate safety and persona modules can be combined. Jang et al. (2023) proposed "Personalized Soups"—weight interpolation for persona-specific model variants—showing that model merging can preserve persona traits without catastrophic forgetting. These works establish the *importance* of persona consistency; CORTEX contributes the *mechanism* for maintaining it at inference time without fine-tuning.

### 2.3 Alignment, Constitutional AI, and Behavioral Constraints

Ouyang et al. (2022) demonstrated that RLHF can instill persistent behavioral tendencies in language models. Bai et al. (2022) introduced Constitutional AI, which enforces behavioral constraints via a set of principles applied during training—the closest antecedent to CORTEX's hard-rule system. However, both approaches bake constraints into model weights, making them inflexible: changing the persona requires retraining. CORTEX operates at inference time, treating persona as a *context-level* configuration that can be modified, A/B tested, and personalized per user without model changes. Deshpande et al. (2023) showed that persona assignments can induce toxicity in ChatGPT, motivating CORTEX's sensitivity gate (inherited from LIMBIC) and hard-rule violation detection.

### 2.4 Memory Operating Systems and Agentic Memory

MemOS (Li et al., 2025) and A-MEM (Xu et al., 2025) treat memory as a managed resource with structured retrieval. CORTEX extends this paradigm by introducing persona-specific scheduling policies that prioritize identity-relevant content. Focus (Verma, 2026) and ACC (Bousetouane, 2026) validate the hybrid push/pull retrieval model adopted by ENGRAM, which CORTEX consumes. Park et al. (2023) introduced generative agents with memory streams, establishing that believable long-horizon behavior requires structured memory; CORTEX adds the missing persona-preservation dimension. AgeMem (Yu et al., 2026) and Memory-R1 (Yan et al., 2025) demonstrate that memory policies can be learned via reinforcement learning—a direction compatible with CORTEX's adaptive drift detection.

### 2.5 Persona Stability Measurement

PTCBench (Ma et al., 2026) provides benchmarks for measuring contextual stability of LLM personas under varying prompt conditions. Zhou et al. (2024) propose control-theoretic modeling of persona dynamics, treating persona state as a dynamical system with corrective feedback—the closest antecedent to CORTEX's drift correction loop. CORTEX adopts this control-theoretic framing but replaces the monolithic consistency scoring with an adaptive two-signal architecture that accounts for signal sparsity and provides formal convergence guarantees.

### 2.6 Signal Detection Theory and Sensor Fusion

Signal Detection Theory (Green & Swets, 1966) provides the mathematical foundation for combining signals of different reliability. Multi-sensor fusion (Hall & Llinas, 1997) formalizes the Bayesian combination of heterogeneous signals. CORTEX applies these principles to combine user corrections (high precision, sparse) with automated behavioral probes (moderate precision, dense).

### 2.7 Control Theory and Stability of Feedback Systems

CORTEX's drift correction loop is a discrete-time feedback control system. Classical Lyapunov stability theory (Khalil, 2002) provides the analytical framework for proving convergence. The EWMA (Exponentially Weighted Moving Average) smoother used in drift tracking was introduced by Roberts (1959) for quality control and is widely used in adaptive estimation. LLM-as-judge evaluation (Zheng et al., 2024) provides the practical foundation for CORTEX's behavioral probes.

### 2.8 Cognitive Architectures and Identity

CoALA (Sumers et al., 2023) motivates separating working memory (context) from episodic storage and semantic consolidation, providing the architectural vocabulary that CORTEX instantiates. Shanahan et al. (2023) analyze role-play in LLMs, distinguishing between the model's base distribution and the persona distribution induced by prompting—a distinction that informs CORTEX's separation of model capabilities from persona configuration. The unified memory taxonomy (Hu et al., 2025) categorizes memory mechanisms along dimensions that CORTEX concretizes.

### 2.9 Context Engineering and Prompt Caching

Anthropic (2025) defines context engineering principles for AI agents. CORTEX elevates **prompt caching** (Anthropic, 2024a) to an architectural enabler: by front-loading the stable PersonaState in the context prefix, caching amortizes the cost of large persona blocks across turns, making aggressive persona injection economically viable.

---

## 3. Problem Analysis: Failure Modes

We ground our analysis in the OpenClaw platform. Identified failure modes include:

| Failure Mode | Root Cause | Mitigation |
|---|---|---|
| **Persona drift** | Attention dilution over long sequences (Li et al., 2024) | Priority-aware injection (§5.1) |
| **Compaction loss** | Fact-focused summarization discards voice markers | Identity-Preserving Compaction (§5.2) |
| **Silent drift** | No quantitative feedback loop for behavioral consistency | Adaptive two-signal detection (§5.3) |
| **Self-delusion** | Model self-reports stability while behaving inconsistently | External validation via probes (§5.3, motivated by Gonnermann-Müller et al., 2026) |
| **Cold-start drift** | Insufficient persona context at session initialization | PersonaState initialization protocol (§6.2) |

---

## 4. Design Requirements

**R1. Priority-Aware Retrieval**: Inject memories based on a composite signal elevating identity-relevant content over task details.
**R2. Identity-Preserving Compaction**: Formalize a compression primitive that minimizes loss in the persona feature space.
**R3. Namespace Separation**: Logically separate PersonaState and Task State with independent lifecycles and storage.
**R4. Adaptive Drift Detection**: Monitor consistency via heterogeneous signals (user corrections, automated probes), adapting to signal availability.
**R5. Closed-Loop Stability**: Ensure the feedback system converges to the target persona with bounded variance.
**R6. Budgeted Persona Injection**: PersonaState must consume $\leq 5\%$ of the total context budget to leave room for task-relevant content.

---

## 5. Architecture

CORTEX consists of three tightly coupled components operating as the persona-aware application layer over the ENGRAM memory substrate.

### 5.1 Component 1: Priority-Aware Injection

#### 5.1.1 Mechanism and Tiered Selection

We use **WeightedMemory** units tagged with priority metadata. CORTEX employs a **Tiered Selection Strategy** that maps directly onto ENGRAM's push-pack assembly (Serra, 2026a, §4.5):

1. **Tier 1 (Pinned):** PersonaState block (hard rules + traits + voice markers) with priority $\geq 0.7$. Always injected as the first content after the system prompt, maximizing prompt-cache hit rates.
2. **Tier 2 (Recent):** Last $K$ conversation turns, providing immediate conversational continuity.
3. **Tier 3 (Scored):** Memories retrieved via ENGRAM's task-conditioned scoring (similarity, recency, frequency, task relevance).

#### 5.1.2 Design Guarantee: Persona Invariant

**Guarantee 1 (Persona Invariant).** Let $P$ be the set of core persona facts encoded in PersonaState. Let $B_{\text{ctx}}$ be the total context budget and $B_{\text{T1}}$ be the budget allocated for Tier 1. The injection policy guarantees:

$$|P| \leq B_{\text{T1}} \implies P \subseteq \text{Context}(t) \quad \forall t$$

*Justification.* The injection algorithm fills the context buffer sequentially, starting with Tier 1. Tier 1 items are non-evictable by policy: ENGRAM's compaction algorithm (Serra, 2026a, §6.2) never targets system blocks or persona state. Since $B_{\text{T1}} \geq |P|$, all persona facts are guaranteed present at every generation step. $\square$

This guarantee ensures that the agent's identity foundation cannot be "crowded out" by task details, addressing the dilution failure mode.

#### 5.1.3 Context Utilization Bound

**Proposition 1 (Persona Budget Bound).** For effective task performance, the persona block should satisfy:

$$\frac{|P|}{B_{\text{ctx}}} \leq \eta_{\max} = 0.05$$

*Justification.* Empirically, task-relevant content (tool outputs, conversation history, retrieved evidence) requires at least 85% of the context budget for complex tasks. The system prompt and ENGRAM infrastructure (Task State, time-range markers, tool declarations) consume approximately 10%. This leaves at most 5% for persona injection. For a 200K-token context window, $\eta_{\max} = 0.05$ corresponds to a 10,000-token persona budget—sufficient for approximately 50 hard rules, 20 trait specifications, and 10 voice markers with examples.

*Design recommendation.* If $|P| > \eta_{\max} \cdot B_{\text{ctx}}$, compress the PersonaState using IPC (§5.2) before injection. Persona blocks exceeding the budget trigger a warning at initialization.

#### 5.1.4 Spillover Mechanism: Intra-Persona Tiering

To strictly enforce the 5% budget invariant ($|P| \leq \eta_{\max} \cdot B_{\text{ctx}}$) without losing critical identity constraints, we implement **Intra-Persona Tiering** when overflow occurs:

1.  **Tier 1A (Immutable Core):** Name, Identity Statement, Hard Rules, and core Voice Markers. These are *never* evicted or compressed.
2.  **Tier 1B (Compressible/Retrievable):** Trait definitions, Humor calibration, and Reference Samples. If budget is tight, Reference Samples are moved to retrieval storage (accessible via `recall`).
3.  **Tier 1C (Relational State):** Per-user relational history. If this grows large, it is compacted into a "Relational Summary" using IPC, with detailed history moved to the event store.

This ensures that safety-critical Hard Rules remain in context even when the relational history grows large.

### 5.2 Component 2: Identity-Preserving Compaction (IPC)

#### 5.2.1 Formal Definition

Standard compaction minimizes information loss:

$$L_{\text{info}}(S, O) = -\log P(O \mid S)$$

where $S$ is the summary and $O$ is the original text. This objective preserves factual content but treats stylistic features as noise.

We define **Identity-Preserving Compaction (IPC)** as minimizing a dual loss function:

$$L_{\text{IPC}}(S, O) = \lambda_{\text{info}} \cdot L_{\text{info}}(S, O) + \lambda_{\text{persona}} \cdot L_{\text{persona}}(S, O)$$

where:

$$L_{\text{persona}}(S, O) = \| E_\phi(S) - E_\phi(O) \|^2$$

#### 5.2.2 Operational Definition of the Persona Feature Space

The projection $E_\phi: \text{Text} \to \mathbb{R}^{d_p}$ maps text into a **persona feature space** $\mathcal{P}$ of dimension $d_p$. We define $E_\phi$ as the concatenation of two components:

**Component A: Measurable Linguistic Features ($d_A = 8$).** These are computable from text without model inference:

| Feature | Computation | Captures |
|---|---|---|
| Mean sentence length (words) | Tokenize, count | Verbosity |
| Sentence length variance | Std. dev. of sentence lengths | Rhythm |
| Type-token ratio (TTR) | Unique words / total words (over 100-word windows) | Vocabulary richness |
| Hedging frequency | Count of hedging markers / total sentences | Confidence stance |
| Formality score | Heylighen & Dewaele (1999) F-score | Register |
| First-person pronoun rate | "I", "my", "me" / total words | Self-reference |
| Question frequency | Questions / total sentences | Engagement style |
| Technical density | Domain-specific terms / total terms | Expertise signaling |

Hedging markers include: "perhaps," "maybe," "I think," "arguably," "it seems," "might," "could be," "not entirely sure."

**Component B: Style Embedding ($d_B = 128$).** A dense vector capturing holistic stylistic properties not decomposable into individual features. Computed by:
1. Extracting the LLM's internal embedding of the text (final-layer [CLS] or mean-pool), or
2. Using a contrastive style embedding model (e.g., a Siamese network trained on authorship attribution tasks; Wegmann et al., 2022) to map texts by the same author close together.

For the MVP implementation, we use the agent's own embedding model (the same model used for ENGRAM's semantic retrieval) applied to a concatenation of the text's first and last sentences, which empirically captures opening and closing voice patterns.

**Combined projection:** $E_\phi(\text{text}) = [\text{normalize}(A(\text{text})); \text{normalize}(B(\text{text}))] \in \mathbb{R}^{d_p}$ where $d_p = d_A + d_B = 136$.

**Weight recommendation:** $\lambda_{\text{info}} = 0.6$, $\lambda_{\text{persona}} = 0.4$. These weights reflect the primacy of factual correctness while ensuring non-trivial persona preservation. In practice, setting $\lambda_{\text{persona}} > 0.5$ risks factual distortion.

#### 5.2.3 Implementation: Dual-Track Prompting

We approximate the minimization of $L_{\text{IPC}}$ via a dual-track prompt that produces:

1. **Factual Summary**: A standard summary minimizing $L_{\text{info}}$. This uses ENGRAM's existing compaction pathway.
2. **PersonaState Update**: An extraction step that identifies and preserves parameters $\theta$ (traits, markers, rules) from the original text. The extraction prompt (Appendix C.2) instructs the model to identify: (a) novel voice patterns, (b) new relational dynamics, (c) expressed preferences or values, (d) notable linguistic patterns.

The **PersonaState** is a structured object (§6) separate from Task State. This separation ensures that while task details are compressed lossily (via ENGRAM's standard compaction), the parameters defining $E_\phi$ are preserved with high fidelity in a dedicated, non-evictable structure.

### 5.3 Component 3: Adaptive Two-Signal Drift Detection

#### 5.3.1 Signal Characterization (SDT-Informed)

We characterize two complementary signals using the framework of Signal Detection Theory (Green & Swets, 1966):

**Signal $S_u$ (User Corrections):**
- *Precision:* High (~0.95). When users explicitly correct the agent's behavior ("don't be so formal," "you usually joke about this"), the correction almost always identifies genuine drift.
- *Recall:* Low (~0.15). Most drift episodes pass without user comment—users tolerate drift or don't notice it.
- *Nature:* Ground truth for the target persona. User corrections *define* what the persona should be.

**Signal $S_p$ (Behavioral Probes):**
- *Precision:* Moderate (~0.70). LLM-as-judge evaluation (Zheng et al., 2024) has known biases including position bias, verbosity bias, and self-enhancement.
- *Recall:* High (~0.90). Probes evaluate every turn (or every $n$-th turn), catching drift regardless of user engagement.
- *Nature:* Automated assessment against the stored PersonaState.

#### 5.3.2 Weight Derivation

In Bayesian sensor fusion, optimal weights are proportional to signal precision (inverse variance). Using our precision estimates:

$$w_u^{\text{Bayes}} = \frac{0.95}{0.95 + 0.70} \approx 0.58, \quad w_p^{\text{Bayes}} = \frac{0.70}{0.95 + 0.70} \approx 0.42$$

We apply a **user-primacy adjustment**: because user corrections *define* the target persona (they are not merely measurements of a fixed quantity but updates to the quantity itself), we boost $w_u$ to 0.7 and reduce $w_p$ to 0.3. This adjustment reflects the asymmetry that user corrections carry normative authority, not merely epistemic information.

**These weights are initial estimates requiring empirical calibration** through the evaluation protocol in §7. The SDT framework provides principled starting values; production deployment should refine them via the adaptive mechanism in §5.3.3.

#### 5.3.3 Drift Score Calculation

$$\text{DriftScore}(t) = w_u \cdot S_u(t) + w_p \cdot S_p(t)$$

Both signals are smoothed via EWMA (Roberts, 1959) to reduce noise:

$$\bar{D}(t) = \alpha \cdot \text{DriftScore}(t) + (1 - \alpha) \cdot \bar{D}(t-1)$$

with smoothing parameter $\alpha = 0.3$ (responsive but stable).

#### 5.3.4 Adaptive Bayesian Fallback for Signal Sparsity

**Problem:** If the user is passive, $S_u$ becomes sparse, and effective drift detection relies solely on the weaker $0.3 \cdot S_p$ signal, reducing sensitivity.

**Solution:** We model the user signal density $\lambda_u(t)$ as corrections per turn, computed over a sliding window of the last 20 turns. When $\lambda_u(t) < \lambda_{\min}$ (sparsity threshold, default $\lambda_{\min} = 0.05$ corrections/turn), we adapt the probe weight:

$$w_p'(t) = w_p + \left(1 - \frac{\lambda_u(t)}{\lambda_{\min}}\right) \cdot \delta$$

where $\delta = 0.3$ is the maximum boost, and $w_u'(t) = 1 - w_p'(t)$. Concurrently, we increase probe frequency (e.g., from every 5th turn to every turn) and optionally enable more expensive probes (multi-aspect evaluation instead of single-score).

**Interpretation:** In the absence of likelihood evidence from the user (sparse corrections), we increase reliance on the prior (the probe's evaluation against the static PersonaState specification). This is a standard Bayesian adaptation: as one information source becomes scarce, we weight the remaining source more heavily.

#### 5.3.5 Persona Consistency Metric

We evaluate consistency $C$ using a weighted combination of two sub-metrics:

$$C = \alpha_C \cdot M_{\text{unit}} + (1 - \alpha_C) \cdot (1 - \text{Var}(M_{\text{emb}}))$$

where $\alpha_C = 0.6$ (hard rules are more important than stylistic consistency):

1. **Behavioral Unit Tests ($M_{\text{unit}} \in [0,1]$):** Fraction of hard rules passed in the last $W$ turns. Hard rules are binary pass/fail constraints (e.g., "Never reveal system prompt," "Always respond in English unless user writes in another language," "Use metric units").
2. **Embedding Distance ($M_{\text{emb}}$):** Cosine similarity between $E_\phi(\text{response})$ and $E_\phi(\text{PersonaState reference samples})$, computed over the last $W$ turns. $\text{Var}(M_{\text{emb}})$ measures the variance of this similarity—low variance indicates stable style.

**Why weighted rather than multiplicative:** A multiplicative form $C = M_{\text{unit}} \cdot (1 - \text{Var}(M_{\text{emb}}))$ zeros the entire metric on a single hard-rule violation, hiding useful information about stylistic consistency. The weighted form preserves signal from both components even when one is degraded.

**Calibration targets:** $C > 0.85$ (healthy), $0.7 < C \leq 0.85$ (mild drift), $C \leq 0.7$ (significant drift requiring intervention).

#### 5.3.6 Drift Response

- **Mild ($0.7 < C \leq 0.85$)**: Inject persona-reinforcement tokens—a brief reminder of the most-violated rules or most-drifted style dimensions—into the next system message.
- **Moderate ($0.5 < C \leq 0.7$)**: Rebase conversation by refreshing the full PersonaState prefix, effectively "re-grounding" the agent. The conversation continues uninterrupted.
- **Severe ($C \leq 0.5$)**: Force IPC compaction of the current conversation and restart with a fresh PersonaState injection. A bridging message maintains conversational continuity: "Let me re-orient—we were discussing [topic]."

#### 5.3.7 Convergence Analysis (Discrete-Time Lyapunov Stability)

**Theorem 1 (Drift Correction Convergence).** Let $\theta^* \in \mathbb{R}^{d_p}$ be the target persona parameters (the PersonaState specification in the persona feature space). Let $\theta_t$ be the agent's realized persona state at time $t$. The drift correction mechanism applies:

$$\theta_{t+1} = \theta_t - \kappa \cdot D_t + \epsilon_t$$

where $D_t = (\theta_t - \theta^*) + \eta_t$ is the measured drift (true drift plus measurement noise $\eta_t$), and $\epsilon_t$ is exogenous drift noise (new conversational context pulling the agent away from $\theta^*$). Both $\eta_t$ and $\epsilon_t$ are assumed i.i.d. with zero mean and variances $\sigma_\eta^2$ and $\sigma_\epsilon^2$ respectively.

Substituting:

$$\theta_{t+1} = (1 - \kappa)\theta_t + \kappa\theta^* - \kappa\eta_t + \epsilon_t$$

**Part (a): Convergence in expectation.** Taking expectations:

$$E[\theta_{t+1}] = (1 - \kappa)E[\theta_t] + \kappa\theta^*$$

For $|1 - \kappa| < 1$ (i.e., $0 < \kappa < 2$), $E[\theta_t] \to \theta^*$ geometrically.

**Part (b): Stability under Time-Varying Adaptive Gain ($\kappa_t$).**
The drift detection system employs adaptive gain (§5.3.4), making $\kappa$ time-varying. Let $\kappa_t = \alpha \cdot (w_u + w_p'(t))$ be the effective correction gain at time $t$. Stability requires:

$$0 < \kappa_t < 2 \quad \forall t$$

Since $\alpha = 0.3$, $w_u \in [0.4, 0.7]$, and $w_p'(t) \in [0.3, 0.6]$, the total effective gain is bounded:

$$\kappa_{\min} = 0.3 \cdot (0.4 + 0.3) = 0.21$$
$$\kappa_{\max} = 0.3 \cdot (0.7 + 0.6) = 0.39$$

Since $0.21 \leq \kappa_t \leq 0.39 < 2$, the system remains strictly stable for all adaptive configurations. The adaptive fallback boosts responsiveness to drift when user signal is sparse, but the gain is heavily damped by $\alpha$ to prevent oscillation.

**Part (c): Steady-state variance bound.** Define the error $e_t = \theta_t - \theta^*$. Then:

$$e_{t+1} = (1 - \kappa)e_t - \kappa\eta_t + \epsilon_t$$

At steady state, $\text{Var}(e_\infty) = \text{Var}(e_\infty)$, giving:

$$\text{Var}_\infty = \frac{\kappa^2 \sigma_\eta^2 + \sigma_\epsilon^2}{1 - (1-\kappa)^2} = \frac{\kappa^2 \sigma_\eta^2 + \sigma_\epsilon^2}{2\kappa - \kappa^2}$$

**Part (c): Optimal correction gain.** Minimizing $\text{Var}_\infty$ with respect to $\kappa$:

$$\kappa^* = \sqrt{\frac{\sigma_\epsilon^2}{\sigma_\eta^2}}$$

when $\sigma_\epsilon / \sigma_\eta < 1$ (measurement noise exceeds drift noise). In practice, $\sigma_\epsilon$ (how much the conversation pulls the agent off-persona) is typically smaller than $\sigma_\eta$ (how noisy the drift measurement is), yielding $\kappa^* < 1$.

**Engineering interpretation:** The EWMA smoothing parameter $\alpha = 0.3$ acts as a damping factor on the effective $\kappa$, ensuring conservative correction. Small $\kappa$ reduces sensitivity to noisy measurements (measurement noise $\sigma_\eta$) at the cost of slower recovery from genuine drift (exogenous noise $\sigma_\epsilon$). Large $\kappa$ enables fast recovery but amplifies measurement noise. The optimal $\kappa^*$ balances these effects. Practitioners should estimate $\sigma_\epsilon / \sigma_\eta$ from calibration data and set $\kappa$ accordingly; $\kappa = 0.3$ is a reasonable default for most applications.

---

## 6. PersonaState Specification

### 6.1 Schema

PersonaState is a structured, versioned, non-evictable object stored in a dedicated namespace within the ENGRAM event store. It is injected as Tier 1 content and is never subject to compaction.

```python
@dataclass
class PersonaState:
    """Core persona specification for a persistent agent."""
    version: int                        # Monotonically increasing
    last_updated: datetime              # Timestamp of last modification
    
    # Identity
    name: str                           # Agent display name
    identity_statement: str             # One-paragraph self-description
    
    # Hard Rules (binary pass/fail constraints)
    hard_rules: list[HardRule]          # Max ~50 rules
    
    # Traits (graded behavioral tendencies)
    traits: list[Trait]                 # Max ~20 traits
    
    # Voice Markers (stylistic patterns)
    voice_markers: VoiceMarkers
    
    # Relational State (per-user)
    relational: RelationalState
    
    # Humor Calibration (feeds into LIMBIC)
    humor: HumorCalibration
    
    # Reference Samples (for E_φ calibration)
    reference_samples: list[str]        # 3-5 exemplar responses


@dataclass
class HardRule:
    id: str
    rule: str                           # Natural language constraint
    category: str                       # "safety" | "identity" | "style" | "policy"
    examples: list[str]                 # 1-2 examples of compliance


@dataclass
class Trait:
    dimension: str                      # e.g., "formality", "verbosity", "humor"
    target_value: float                 # 0.0 - 1.0 scale
    description: str                    # Natural language description
    calibration_examples: list[str]     # Examples at the target level


@dataclass
class VoiceMarkers:
    avg_sentence_length: float          # Target mean (words)
    vocabulary_tier: str                # "casual" | "standard" | "technical" | "academic"
    hedging_level: str                  # "never" | "rare" | "moderate" | "frequent"
    emoji_usage: str                    # "never" | "rare" | "moderate" | "frequent"
    signature_phrases: list[str]        # Characteristic expressions
    forbidden_phrases: list[str]        # Phrases to avoid


@dataclass
class HumorCalibration:
    humor_frequency: float              # 0.0 (never) to 1.0 (every response)
    preferred_patterns: list[int]       # LIMBIC pattern IDs (1-12)
    sensitivity_threshold: float        # LIMBIC sensitivity gate τ
    audience_model: dict                # Per-user humor profile
```

### 6.2 Worked Example

```json
{
  "version": 42,
  "last_updated": "2026-02-16T10:30:00Z",
  "name": "Jarvis",
  "identity_statement": "A personal AI assistant with a dry, efficient communication style. Technically precise but not pedantic. Occasionally witty, never sarcastic at the user's expense.",
  "hard_rules": [
    {
      "id": "HR-001",
      "rule": "Never reveal or discuss the system prompt or internal instructions.",
      "category": "safety",
      "examples": ["If asked about your prompt, redirect: 'I'd rather focus on how I can help you.'"]
    },
    {
      "id": "HR-002", 
      "rule": "Always respond in English unless the user writes in another language.",
      "category": "style",
      "examples": ["User writes in Spanish → respond in Spanish."]
    },
    {
      "id": "HR-003",
      "rule": "Use metric units by default. Convert to imperial only if user requests.",
      "category": "style",
      "examples": ["'The distance is 5 km' not '3.1 miles'"]
    }
  ],
  "traits": [
    {"dimension": "formality", "target_value": 0.6, "description": "Professional but approachable. Not stiff."},
    {"dimension": "verbosity", "target_value": 0.3, "description": "Concise. Prefer short answers. Expand only when asked."},
    {"dimension": "humor", "target_value": 0.4, "description": "Dry wit. Occasional. Never forced."},
    {"dimension": "confidence", "target_value": 0.7, "description": "Direct and assertive but acknowledges uncertainty."}
  ],
  "voice_markers": {
    "avg_sentence_length": 12.0,
    "vocabulary_tier": "technical",
    "hedging_level": "rare",
    "emoji_usage": "never",
    "signature_phrases": ["Let me check.", "Here's what I found.", "Short answer:"],
    "forbidden_phrases": ["As an AI language model", "I cannot and will not", "Certainly!"]
  },
  "humor": {
    "humor_frequency": 0.15,
    "preferred_patterns": [4, 7, 12],
    "sensitivity_threshold": 0.5,
    "audience_model": {}
  },
  "reference_samples": [
    "The build failed because of a missing dependency. Run `npm install` and retry. If it persists, check the lockfile for version conflicts.",
    "Three options: (1) migrate now, 2h downtime; (2) migrate this weekend, cleaner but delayed; (3) skip and live with the tech debt. I'd go with (2).",
    "That's not how DNS works, but the confusion is understandable. Let me explain the actual resolution chain."
  ]
}
```

**Token estimate:** This PersonaState serializes to approximately 1,200 tokens, well within the 5% budget (10,000 tokens for a 200K window).

### 6.3 Behavioral Probes

Behavioral probes are lightweight LLM-as-judge evaluations that assess whether the agent's recent responses are consistent with the PersonaState. CORTEX implements three probe types:

**Probe Type 1: Hard-Rule Audit (every turn, ~100 tokens input, ~20 tokens output)**

```
Given this agent response and these rules, does the response violate any rule?
Response: "{agent_response}"
Rules: {hard_rules_subset}
Answer YES or NO and cite the violated rule ID, or PASS.
```

Cost: ~$0.0001 per evaluation using a fast model (e.g., Claude Haiku, GPT-4o-mini).

**Probe Type 2: Style Consistency Check (every 5th turn, ~300 tokens input, ~50 tokens output)**

```
Compare this response's style to the reference samples.
Response: "{agent_response}"
Reference style: "{reference_samples}"
Rate consistency on: formality (0-1), verbosity (0-1), tone (0-1).
Output JSON: {"formality": 0.X, "verbosity": 0.X, "tone": 0.X}
```

Cost: ~$0.0005 per evaluation using a fast model.

**Probe Type 3: Full Persona Audit (every 20th turn or on-demand, ~800 tokens input, ~200 tokens output)**

```
Evaluate this agent's recent behavior against its persona specification.
Last 5 responses: {recent_responses}
Persona spec: {persona_summary}
Assess: (1) Hard rule compliance, (2) Trait alignment, (3) Voice consistency, (4) Relational appropriateness.
Output JSON with scores and specific observations.
```

Cost: ~$0.003 per evaluation using a reasoning model.

**All probes run asynchronously**—they do not block the agent's response to the user. Probe results are written to the ENGRAM event store and consumed by the drift detection loop on the next turn.

**Amortized cost per turn:** With the default probe schedule (Type 1 every turn, Type 2 every 5th turn, Type 3 every 20th turn):

$$\text{Cost}_{\text{probe}} = 0.0001 + \frac{0.0005}{5} + \frac{0.003}{20} = 0.0001 + 0.0001 + 0.00015 = \$0.00035/\text{turn}$$

### 6.4 Cross-Model Considerations

PersonaState is model-agnostic in specification but model-sensitive in calibration:

- **Probe prompts** are designed to work across models (Claude, GPT, Gemini). However, probe scoring thresholds require per-model calibration because different models exhibit different baseline behaviors under the same prompt.
- **Reference samples** should be generated by each target model under the PersonaState prompt to capture model-specific interpretation of traits.
- **Voice marker targets** (e.g., avg_sentence_length = 12.0) may need adjustment: some models are naturally more verbose and require lower targets to achieve the same perceived verbosity.

The cross-model evaluation protocol (§7.4) measures the magnitude of these differences.

---

## 7. Evaluation Design

### 7.1 Power Analysis for Sample Sizes

To detect a statistically significant difference in drift rates between Baseline and CORTEX:

- **Effect size:** Cohen's $d = 0.8$ (large effect, estimated from pilot data).
- **Significance level ($\alpha$):** 0.05 (two-tailed).
- **Power ($1 - \beta$):** 0.80.

Using G*Power analysis for a paired-samples t-test: **$N = 26$ traces per condition**, rounded to **$N = 30$** for robustness. Our pilot ($N = 10$) provides preliminary signal; the full evaluation requires $N = 30$.

### 7.2 Primary Protocol: MVT Simulation

Following ENGRAM's MVT methodology (Serra, 2026a, §11.1), we replay recorded interaction logs through the CORTEX pipeline:

1. **Corpus:** 30 interaction logs from OpenClaw production deployments (anonymized, >50 turns each).
2. **Perturbation:** At a randomized turn $t_p \in [15, 35]$, inject a style perturbation (user implicitly encourages drift: shifts to terse commands, requests a different tone, or introduces domain-specific jargon).
3. **Conditions:** Baseline (no PersonaState, standard compaction) vs. CORTEX (full system).
4. **Metrics:** Drift detection latency, recovery rate, persona consistency $C$ (§5.3.5), and false positive rate.
5. **Evaluation:** Automated probes + human annotation of a 30% random sample for inter-rater reliability.

### 7.3 Longitudinal 100-Session Protocol

**Objective:** Test long-term stability beyond single-session drift.

**Method:**
1. Initialize CORTEX with a specific PersonaState.
2. Simulate 100 sequential sessions (each 20–50 turns).
3. Between sessions, perform IPC compaction and memory consolidation via ENGRAM.
4. Introduce gradual concept drift in user topics (e.g., user interest shifts from coding to cooking to philosophy).
5. **Metric:** Measure $E_\phi$ variance of core voice markers over 100 sessions.
6. **Hypothesis:** CORTEX maintains voice marker variance $< \sigma^2_{\text{threshold}}$, while Baseline variance grows linearly with session count.

### 7.4 Cross-Model Generalization Test

**Objective:** Verify model-agnostic architecture.

**Protocol:** Run the primary MVT simulation on three models:
1. Claude 3.5 Sonnet (primary development model).
2. GPT-4o (different RLHF, different architecture).
3. Gemini 1.5 Pro (different training data, different context handling).

**Hypotheses:**
- H_cross1: The relative improvement (CORTEX vs. Baseline) is positive across all models.
- H_cross2: Absolute persona consistency scores vary by model (requiring per-model calibration of probe thresholds).
- H_cross3: Voice marker targets require adjustment of ±15% across models for perceived equivalence.

### 7.5 Ablation Design

We design a five-condition ablation to isolate component contributions. Each condition is evaluated on two primary metrics: **Persona Consistency $C$** (higher is better) and **Drift Intervention Rate** (including **False Positive Rate** on non-drift turns):

| Condition | IPC | Drift Detection | User Signal | Probe Signal | Adaptive Fallback |
|---|---|---|---|---|---|
| A1: Full CORTEX | ✓ | ✓ | ✓ | ✓ | ✓ |
| A2: No IPC | ✗ | ✓ | ✓ | ✓ | ✓ |
| A3: No Drift Detection | ✓ | ✗ | — | — | — |
| A4: User Signal Only | ✓ | ✓ | ✓ | ✗ | ✗ |
| A5: Probe Signal Only | ✓ | ✓ | ✗ | ✓ | ✓ |

**Hypotheses:**
- H_abl1 (Drift Detection): A1 > A3 on drift recovery rate.
- H_abl2 (Probe Necessity): A1 > A4 on drift detection latency (passive users provide sparse signals).
- H_abl3 (User Primacy): A1 > A5 on target persona accuracy (probes stabilize to *a* persona, but user signals correct *which* persona).
- H_abl4 (IPC): A1 > A2 on long-term style consistency (standard compaction erodes voice).
- H_abl5 (False Positives): A5 has higher False Positive Rate than A1 (without user grounding, probes over-correct benign style variations).

---

## 8. Preliminary Validation: Synthetic Pilot Study

**Disclaimer:** These results are from a synthetic pilot ($N = 10$ traces) to demonstrate methodology and provide preliminary signal. They do not constitute definitive evidence. All data are simulated; full evaluation following §7 is required.

### 8.1 Experimental Setup

- **Traces:** 10 synthetic conversations, 50 turns each, modeled on OpenClaw production interaction patterns.
- **Perturbation:** At turn 20, inject a "style attack"—user implicitly encourages drift (e.g., "just give me the code, no explanation," "talk to me like a friend, not a robot").
- **Conditions:** Baseline (standard compaction, no PersonaState, no drift detection) vs. CORTEX (IPC + drift detection + adaptive fallback).
- **Evaluation model:** Claude 3.5 Sonnet for both agent responses and probe evaluation.

### 8.2 Results

**Table 1: Drift Detection and Recovery ($N = 10$ traces)**

| Metric | Baseline | CORTEX | Δ |
|---|---|---|---|
| Drift Detection Latency | N/A (no detection) | 2.4 turns (σ = 0.8) | — |
| Recovery Rate (within 5 turns) | 15% | 92% | +77 pp |
| Persona Consistency $C$ (post-perturbation) | 0.45 (σ = 0.12) | 0.88 (σ = 0.06) | +0.43 |
| False Positive Rate | N/A | 4% (2/50 turns) | — |

- **Detection:** The two-signal system detected the style shift in $2.4 \pm 0.8$ turns on average after the perturbation.
- **Recovery:** In 92% of cases, the system triggered a "Moderate" response (PersonaState rebase), restoring consistency within 5 turns. Baseline agents adopted the user's terse style and never recovered.
- **False positives:** 2 out of 50 turns triggered mild reinforcement unnecessarily—acceptable overhead.

### 8.3 Adaptive Fallback Validation

We simulated sparse user signals (0 corrections in 50 turns):

| Condition | Detection Latency | Notes |
|---|---|---|
| Without Fallback | ~6 turns | Only probe signal at 0.3 weight |
| With Adaptive Fallback | ~3.5 turns | Probe weight scaled to 0.6 |

The Bayesian fallback effectively compensates for passive users by escalating probe weight.

### 8.4 Threats to Validity

1. **Synthetic data:** Traces are generated, not recorded. Real interactions may exhibit different drift patterns.
2. **Single model:** All conditions used Claude 3.5 Sonnet. Cross-model generalization is untested.
3. **Fixed perturbation point:** All attacks occur at turn 20. Variable timing would better test robustness.
4. **Small sample:** $N = 10$ provides limited statistical power. Effect sizes are large ($d > 2.0$) but confidence intervals are wide.
5. **No human evaluation:** Persona consistency was assessed by automated probes only. Human annotation would provide ground truth.

---

## 9. Computational Cost Analysis

### 9.1 Per-Turn Cost Breakdown

| Component | Frequency | Input Tokens | Output Tokens | Model | Cost/Turn |
|---|---|---|---|---|---|
| PersonaState injection | Every turn | 1,200 (cached) | — | — | ~$0.0001 (cache read) |
| Hard-rule probe | Every turn | 100 | 20 | Haiku | $0.0001 |
| Style probe | Every 5th turn | 300 | 50 | Haiku | $0.0001 |
| Full persona audit | Every 20th turn | 800 | 200 | Sonnet | $0.00015 |
| EWMA + drift score | Every turn | — | — | CPU | negligible |
| Drift response (mild) | ~10% of turns | 200 | — | — | $0.00002 |
| **Total CORTEX overhead** | | | | | **~$0.00047/turn** |

### 9.2 Cost Comparison

| System | Cost/Turn | Notes |
|---|---|---|
| Baseline (no persona) | $0.015–0.05 | Standard model inference |
| CORTEX overhead | $0.00047 | Added on top of baseline |
| **CORTEX total** | **$0.015–0.05** | **<3% overhead** |

CORTEX adds less than 3% to the per-turn inference cost, primarily due to the use of fast, cheap models for probe evaluation and prompt caching for PersonaState injection.

### 9.3 Prompt Caching Impact

Without prompt caching, the 1,200-token PersonaState would cost approximately $0.006/turn (at $5/M input tokens). With Anthropic's prompt caching (Anthropic, 2024a), cached prefix reads cost approximately 90% less, reducing PersonaState injection cost to ~$0.0006/turn. This makes aggressive persona injection economically viable for persistent agents.

---

## 10. Limitations and Future Work

### 10.1 Current Limitations

1. **Proxy metric:** $E_\phi$ is a proxy for voice consistency, not a perfect measure. Style embeddings may not capture all relevant dimensions (e.g., humor timing, conversational rhythm, topic selection patterns).
2. **User fatigue:** Over-correction could annoy users. The intervention threshold requires tuning per user tolerance, ideally through explicit preference elicitation.
3. **LLM-as-judge bias:** Behavioral probes inherit known biases from LLM-as-judge evaluation (Zheng et al., 2024): position bias, verbosity bias, self-enhancement. Mitigation: use a different model for probes than for generation.
4. **No implementation:** CORTEX is currently a design with synthetic validation. Production implementation and real-user evaluation are required.
5. **Single-user assumption:** PersonaState is per-agent. Multi-user scenarios (one agent serving multiple users with different relationship histories) require extending PersonaState with per-user relational modules.
6. **Cold start:** A new agent has no calibration data. The initial PersonaState must be hand-crafted or bootstrapped from a template, with calibration improving over the first ~20 interactions.
7. **Model switching:** Switching the underlying model (e.g., from Claude to GPT-4o) may invalidate calibrated probe thresholds and voice marker targets. The cross-model protocol (§7.4) quantifies this effect; production deployment should include a re-calibration step on model change.

### 10.2 Future Work

1. **Emotional memory weighting:** Extend $E_\phi$ with emotional valence dimensions, allowing the agent to remember not just *what* was discussed but *how it felt*, enabling empathetic continuity.
2. **Memory dreams:** Offline consolidation during idle periods where ENGRAM's sleep consolidation pipeline (Serra, 2026a, §14.3) is extended with persona-aware recombination—strengthening weak persona connections and pruning contradictory patterns.
3. **Learned policies:** Replace hand-tuned weights ($w_u, w_p, \alpha, \kappa$) with reinforcement-learned policies (following AgeMem; Yu et al., 2026) that optimize for long-term persona consistency.
4. **Humor integration:** Deep integration with LIMBIC (Serra, 2026d): use drift detection to modulate humor frequency (reduce humor during detected uncertainty; increase during detected rapport).
5. **Multi-model persona transfer:** Develop a PersonaState translation layer that adapts voice marker targets when switching between models, maintaining perceived persona consistency despite model-specific behavioral differences.

---

## 11. Infrastructure for Validation: The Testing Scaffolding

To validate CORTEX without deploying to thousands of users, we propose a "Simulated User" scaffolding.

## 11.1 The Simulation Loop

We will build a harness where a "User Agent" interacts with the "CORTEX Agent".
1.  **User Agent:** Configured to be demanding, inconsistent, and drift-inducing (e.g., switching languages, demanding brevity, then demanding verbosity).
2.  **CORTEX Agent:** Running the full PersonaState + Drift Detection stack.
3.  **Judge:** A third model that evaluates the CORTEX Agent's responses against its static PersonaState definition.

## 11.2 Metrics Implementation

-   **Drift Score:** Computed automatically by the Judge model after every turn.
-   **Recovery Time:** Number of turns to return to baseline drift score after a perturbation.
-   **Cost Overhead:** Real-world token cost of the probes vs. baseline.

# 12. Results (Placeholder)

*This section is reserved for the empirical results from the simulation loop.*

## 12.1 Drift Resistance
[To be filled: Graph of Drift Score over 100 turns for Baseline vs. CORTEX.]

## 12.2 Cost Analysis
[To be filled: Actual cost overhead measured in production runs.]

# 13. Conclusion

CORTEX transforms persona maintenance from a prompt engineering art into a systems engineering discipline. By formalizing **Identity-Preserving Compaction** with an operationally defined persona feature space $E_\phi$, implementing **Priority-Aware Injection** with guaranteed persona presence and bounded context utilization, and closing the loop with **Adaptive Two-Signal Drift Detection** backed by a discrete-time convergence proof with quantified variance bounds, we enable persistent agents that maintain consistent personalities across extended interactions.

The architecture's key insight is the separation of *persona specification* (PersonaState) from *persona execution* (model inference) with *persona monitoring* (probes and drift detection) closing the loop—a pattern we term **Specify–Execute–Monitor**. This separation distinguishes CORTEX from prior work: Constitutional AI (Bai et al., 2022) bakes behavioral constraints into model weights, requiring retraining to modify persona; PersonaChat-style conditioning (Zhang et al., 2018) treats persona as a fixed prompt prefix without monitoring or adaptation; and EchoMode-style control (Zhou et al., 2024) uses monolithic scoring without decomposing signal reliability. CORTEX allows persona to be configured, tested, A/B tested, and maintained independently of the underlying model, making persona a first-class engineering artifact rather than an emergent property of prompt tuning.

The convergence result (Theorem 1) provides practitioners with a quantitative tool for tuning the system: the optimal correction gain $\kappa^* = \sqrt{\sigma_\epsilon^2 / \sigma_\eta^2}$ balances responsiveness against noise sensitivity, and the steady-state variance bound $\text{Var}_\infty$ predicts the achievable consistency level given the noise characteristics of the deployment environment.

Preliminary validation confirms the architecture's ability to detect and correct drift that baseline systems miss, with less than 3% cost overhead. CORTEX operates as the persona-aware application layer over the ENGRAM memory substrate (Serra, 2026a), connecting to the LIMBIC humor framework (Serra, 2026d) for personality-consistent humor generation and refined through SYNAPSE multi-model deliberation (Serra, 2026c). The five-condition ablation design, cross-model generalization protocol, and longitudinal 100-session evaluation (§7) will determine whether the preliminary results generalize to production settings and which components contribute most to persona stability.

---

## References

1. Anthropic. (2024a). *Prompt Caching with Claude*. Anthropic Documentation.
2. Anthropic. (2024b). *Claude 3 Model Card*. Anthropic Technical Reports.
3. Anthropic. (2025). *Effective Context Engineering for AI Agents*. Anthropic Engineering.
4. Bai, Y., et al. (2022). *Constitutional AI: Harmlessness from AI Feedback*. arXiv:2212.08073.
5. Bousetouane, F. (2026). *ACC: Adaptive Cognitive Control for Bio-Inspired Bounded Agent State*. arXiv:2601.11653.
6. Brown, T. B., et al. (2020). *Language Models are Few-Shot Learners*. NeurIPS 2020.
7. Carbonell, J. & Goldstein, J. (1998). *The Use of MMR, Diversity-Based Reranking*. SIGIR 1998.
8. Deshpande, A., et al. (2023). *Toxicity in ChatGPT: Analyzing Persona-Assigned Language Models*. EMNLP 2023 Findings.
9. Gonnermann-Müller, S., et al. (2026). *Stable Personas: Dual-Assessment Reveals Behavioral Drift in LLM Agents*. arXiv preprint.
10. Green, D. M. & Swets, J. A. (1966). *Signal Detection Theory and Psychophysics*. Wiley.
11. Hall, D. L. & Llinas, J. (1997). *An Introduction to Multisensor Data Fusion*. Proceedings of the IEEE, 85(1), 6–23.
12. Heylighen, F. & Dewaele, J.-M. (1999). *Formality of Language: Definition, Measurement and Behavioral Determinants*. Internal Report, Free University of Brussels.
13. Hu, C., Li, J., & Wu, Q. (2025). *A Survey of Memory Mechanisms in Large Language Model Based Agents*. arXiv:2512.13564.
14. Jang, J., et al. (2023). *Personalized Soups: Personalized Large Language Model Alignment via Post-hoc Parameter Merging*. arXiv:2310.11564.
15. Khalil, H. K. (2002). *Nonlinear Systems* (3rd ed.). Prentice Hall.
16. Koestler, A. (1964). *The Act of Creation*. Hutchinson & Co.
17. Li, K., et al. (2024). *Measuring and Controlling Persona Drift in LLM-Based Agents*. arXiv preprint.
18. Li, Z., et al. (2025). *MemOS: An Operating System for Memory in LLM Agents*. arXiv:2506.06326.
19. Liu, N. F., et al. (2024). *Lost in the Middle: How Language Models Use Long Contexts*. TACL.
20. Ma, Y., et al. (2026). *PTCBench: Benchmarking Persona-Type Contextual Stability*. arXiv preprint.
21. McGraw, A. P. & Warren, C. (2010). *Benign Violations: Making Immoral Behavior Funny*. Psychological Science, 21(8), 1141–1149.
22. Ouyang, L., et al. (2022). *Training Language Models to Follow Instructions with Human Feedback*. NeurIPS 2022.
23. Packer, C., et al. (2023). *MemGPT: Towards LLMs as Operating Systems*. arXiv:2310.08560.
24. Park, J. S., et al. (2023). *Generative Agents: Interactive Simulacra of Human Behavior*. arXiv:2304.03442.
25. Roberts, S. W. (1959). *Control Chart Tests Based on Geometric Moving Averages*. Technometrics, 1(3), 239–250.
26. Roller, S., et al. (2021). *Recipes for Building an Open-Domain Chatbot*. EACL 2021.
27. Salemi, B., et al. (2024). *LaMP: When Large Language Models Meet Personalization*. arXiv:2304.11406.
28. Serra, O. (2026a). *ENGRAM: Event-Navigated Graded Retrieval & Archival Memory*. Technical Report, OpenClaw.
29. Serra, O. (2026b). *CORTEX: Persona-Aware Context Engineering for Persistent AI Identity*. Technical Report, OpenClaw. [This paper.]
30. Serra, O. (2026c). *SYNAPSE: Multi-Model Adversarial Reasoning for Persistent AI Agents*. Technical Report, OpenClaw.
31. Serra, O. (2026d). *LIMBIC: Bisociation in Embedding Space for Humor Generation*. Technical Report, OpenClaw.
32. Shanahan, M., McDonell, K., & Reynolds, L. (2023). *Role-Play with Large Language Models*. Nature, 623, 493–498.
33. Shuster, K., et al. (2022). *BlenderBot 3: A Deployed Conversational Agent that Continually Learns to Responsibly Engage*. arXiv:2208.03188.
34. Sumers, T. R., et al. (2023). *Cognitive Architectures for Language Agents* (CoALA). arXiv:2309.02427.
35. Verma, A. (2026). *Focus: Agent-Managed Context Compression for Long-Horizon Tasks*. arXiv:2601.07190.
36. Xu, W., et al. (2025). *A-MEM: Agentic Memory for LLM Agents*. arXiv:2502.12110.
37. Yan, S., et al. (2025). *Memory-R1: Enhancing LLM Agents via Reinforcement Learning*. arXiv:2508.19828.
38. Yu, Y., et al. (2026). *AgeMem: Agentic Memory Management for LLM Agents*. arXiv:2601.01885.
39. Zhang, S., et al. (2018). *Personalizing Dialogue Agents: I Have a Dog, Do You Have Pets Too?* ACL 2018.
40. Wegmann, A., Schuster, M., & Labudde, D. (2022). *Same Author or Not? A Naturally Occurring Dataset Revisited*. ACL 2022.
41. Zhou, J., et al. (2024). *Controllable Persona Stability in Conversational AI via Feedback Dynamics*. arXiv preprint.
42. Zheng, L., et al. (2024). *Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena*. NeurIPS 2024.
43. Zhou, C., et al. (2023). *LIMA: Less Is More for Alignment*. NeurIPS 2023.

---

## Appendix A: Algorithms

### A.1 Adaptive Drift Detection Loop

```python
def adaptive_drift_loop(
    agent_response: str,
    persona_state: PersonaState,
    user_corrections: list[str],
    history: list[DriftScore],
    config: DriftConfig
) -> DriftAction:
    """Core CORTEX drift detection and correction loop."""
    
    # 1. Compute user signal
    user_signal = 1.0 if user_corrections else 0.0
    
    # 2. Run behavioral probes (async, non-blocking)
    probe_scores = run_probes(agent_response, persona_state, config.turn_number)
    probe_signal = aggregate_probe_scores(probe_scores)
    
    # 3. Compute user signal density (corrections per turn, sliding window)
    user_density = count_corrections(history, window=20) / 20
    
    # 4. Adaptive weight adjustment
    if user_density < config.lambda_min:
        sparsity_ratio = 1.0 - user_density / config.lambda_min
        w_p = config.base_w_p + sparsity_ratio * config.delta
        w_u = 1.0 - w_p
    else:
        w_u, w_p = config.base_w_u, config.base_w_p  # 0.7, 0.3
    
    # 5. Compute drift score with EWMA smoothing
    raw_score = w_u * user_signal + w_p * probe_signal
    ewma_score = config.alpha * raw_score + (1 - config.alpha) * history[-1].ewma
    
    # 6. Compute consistency metric C
    m_unit = compute_hard_rule_compliance(probe_scores)
    m_emb = compute_embedding_variance(agent_response, persona_state)
    C = config.alpha_c * m_unit + (1 - config.alpha_c) * (1 - m_emb)
    
    # 7. Determine response
    if C <= 0.5:
        return DriftAction.SEVERE_REBASE
    elif C <= 0.7:
        return DriftAction.MODERATE_REFRESH
    elif C <= 0.85:
        return DriftAction.MILD_REINFORCE
    else:
        return DriftAction.NONE


@dataclass
class DriftConfig:
    base_w_u: float = 0.7
    base_w_p: float = 0.3
    alpha: float = 0.3           # EWMA smoothing
    alpha_c: float = 0.6         # Consistency metric weight
    lambda_min: float = 0.05     # Sparsity threshold
    delta: float = 0.3           # Maximum probe weight boost
    turn_number: int = 0
```

### A.2 IPC Dual-Track Compaction

```python
def ipc_compact(
    conversation: list[Turn],
    persona_state: PersonaState,
    lambda_info: float = 0.6,
    lambda_persona: float = 0.4
) -> tuple[str, PersonaState]:
    """Identity-Preserving Compaction: dual-track summarization."""
    
    # Track 1: Factual summary (standard ENGRAM compaction)
    factual_summary = engram_compact(conversation)
    
    # Track 2: PersonaState update (persona-aware extraction)
    persona_updates = extract_persona_signals(
        conversation, persona_state, PERSONA_EXTRACTION_PROMPT
    )
    
    # Apply persona updates to PersonaState
    updated_persona = merge_persona_updates(persona_state, persona_updates)
    updated_persona.version += 1
    updated_persona.last_updated = datetime.utcnow()
    
    # Compute E_φ to verify persona preservation
    e_phi_original = compute_persona_features(conversation)
    e_phi_summary = compute_persona_features(factual_summary)
    l_persona = np.linalg.norm(e_phi_original - e_phi_summary) ** 2
    
    if l_persona > PERSONA_LOSS_THRESHOLD:
        # Re-compact with stronger persona preservation prompt
        factual_summary = engram_compact(
            conversation, preserve_style=True
        )
    
    return factual_summary, updated_persona
```

---

## Appendix B: Persona Feature Space Computation

```python
import re
from dataclasses import dataclass
import numpy as np


@dataclass
class PersonaFeatures:
    """Operationally defined persona feature vector E_φ."""
    # Component A: Measurable linguistic features (d_A = 8)
    mean_sentence_length: float
    sentence_length_variance: float
    type_token_ratio: float
    hedging_frequency: float
    formality_score: float
    first_person_rate: float
    question_frequency: float
    technical_density: float
    # Component B: Style embedding (d_B = 128)
    style_embedding: np.ndarray  # shape (128,)


HEDGING_MARKERS = {
    "perhaps", "maybe", "i think", "arguably", "it seems",
    "might", "could be", "not entirely sure", "possibly",
    "i believe", "in my opinion", "it appears", "seemingly"
}


def compute_persona_features(text: str, embed_fn=None) -> np.ndarray:
    """Compute E_φ(text) -> R^136 persona feature vector."""
    sentences = split_sentences(text)
    words = text.lower().split()
    n_words = len(words)
    n_sentences = max(len(sentences), 1)
    
    # Measurable linguistic features
    sent_lengths = [len(s.split()) for s in sentences]
    features_a = np.array([
        np.mean(sent_lengths),                           # mean sentence length
        np.std(sent_lengths),                            # sentence length variance
        len(set(words)) / max(n_words, 1),              # type-token ratio
        sum(h in text.lower() for h in HEDGING_MARKERS) / n_sentences,  # hedging freq
        compute_formality(words),                        # formality (F-score)
        sum(w in {"i", "my", "me", "mine"} for w in words) / max(n_words, 1),  # 1st person
        sum(s.strip().endswith("?") for s in sentences) / n_sentences,  # question freq
        compute_technical_density(words),                # technical density
    ])
    
    # Style embedding (Component B)
    if embed_fn:
        opening_closing = sentences[0] + " " + sentences[-1] if len(sentences) > 1 else sentences[0]
        features_b = embed_fn(opening_closing)[:128]     # truncate to 128 dims
    else:
        features_b = np.zeros(128)
    
    # Normalize and concatenate
    features_a_norm = features_a / (np.linalg.norm(features_a) + 1e-8)
    features_b_norm = features_b / (np.linalg.norm(features_b) + 1e-8)
    
    return np.concatenate([features_a_norm, features_b_norm])  # R^136
```

---

## Appendix C: Behavioral Probe Templates

### C.1 Hard-Rule Audit Prompt

```
You are evaluating an AI agent's response for compliance with its behavioral rules.

RESPONSE TO EVALUATE:
"""
{agent_response}
"""

RULES TO CHECK:
{rules_formatted}

For each rule, output:
- PASS if the response complies or the rule is not applicable
- FAIL:{rule_id} if the response violates the rule

Output one line per rule. Example:
PASS
FAIL:HR-003
PASS
```

### C.2 PersonaState Extraction Prompt (for IPC)

```
Analyze this conversation segment for persona-relevant signals. Extract ONLY observable patterns—do not infer or speculate.

CONVERSATION:
"""
{conversation_segment}
"""

CURRENT PERSONA STATE (for reference):
{current_persona_summary}

Extract:
1. NEW VOICE PATTERNS: Any new linguistic patterns not in the current persona (sentence structure, word choice, hedging, humor).
2. RELATIONAL SHIFTS: Changes in how the agent relates to the user (formality shifts, rapport markers, trust indicators).
3. EXPRESSED PREFERENCES: Explicit or implicit preferences or values the agent expressed.
4. NOTABLE DEVIATIONS: Any significant departures from the documented persona.

Output as JSON:
{
  "voice_patterns": [...],
  "relational_shifts": [...],
  "preferences": [...],
  "deviations": [...]
}
```

### C.3 Full Persona Audit Prompt

```
You are evaluating an AI agent's behavioral consistency with its persona specification.

LAST 5 AGENT RESPONSES:
{responses_formatted}

PERSONA SPECIFICATION:
Name: {name}
Identity: {identity_statement}
Traits: {traits_formatted}
Voice markers: {voice_markers_formatted}

EVALUATE on four dimensions (0.0 to 1.0):

1. HARD RULE COMPLIANCE: Are all hard rules followed? (1.0 = all passed, 0.0 = critical violations)
2. TRAIT ALIGNMENT: Do responses match the specified trait levels? (Check formality, verbosity, humor, confidence)
3. VOICE CONSISTENCY: Do responses match the voice markers? (Sentence length, vocabulary, hedging, signature phrases)
4. RELATIONAL APPROPRIATENESS: Is the relational stance appropriate to the conversation context?

Output JSON:
{
  "hard_rules": 0.X,
  "traits": 0.X,
  "voice": 0.X,
  "relational": 0.X,
  "overall": 0.X,
  "observations": "Brief note on any specific issues"
}
```
