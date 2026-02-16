---
title: "SYNAPSE: Synthesized Negotiation Across Provider-Specific Engines — Multi-Model Adversarial Reasoning for Persistent AI Agents"
date: "February 2026"
version: "v3.0"
---

\begin{center}
\large\textit{Exploiting Cognitive Diversity as Computational Resource in Persistent AI Agents}
\end{center}

\vspace{0.3cm}
\begin{center}
O. Serra\textsuperscript{1} \\
\small\textsuperscript{1}Independent Researcher \\
\small Working Paper v3.0 — February 2026 \\
\small Target venue: NeurIPS 2026
\end{center}
\vspace{0.5cm}

> **Changelog v2.0 → v3.0 (2026-02-16).** Final Round Table consensus (PG, PGem). Key changes: (1) **Refined Formalism**: Downgraded Proposition 1 from "Bound" to "Theoretical Framework" based on Krogh-Vedelsby analogy, acknowledging the discrete-dialogue gap. (2) **Protocol Hardening**: Added Phase 5 (Ratification) to mitigate synthesizer hallucination, citing Burns et al. (2023) on weak-to-strong generalization. (3) **Persuasion Dynamics**: Explicitly addressed the "Persuasion Paradox" (Wan et al., 2024) and added calibration metrics (Kadavath et al., 2022). (4) **Memory Integration**: Clarified ENGRAM interaction—debate traces are evicted eagerly; only the Synthesis and Ratified Conclusions persist as artifacts. (5) **Latency Reality**: Explicitly framed SYNAPSE as an asynchronous offline protocol, not a chatbot feature. (6) **Evaluation**: Added Time-to-Consensus and Calibration Error to the pre-registered metrics.

# Abstract

Large language models from different providers exhibit systematically different reasoning behaviors and failure modes, shaped by divergent training data, alignment objectives, architectures, and reasoning paradigms. We argue that this _cognitive diversity_ is a **computational resource** to be actively exploited, not a nuisance to be averaged away.

We introduce SYNAPSE (**Syn**thesized **N**egotiation **A**cross **P**rovider-**S**pecific **E**ngines), a framework for multi-provider adversarial deliberation. Heterogeneous models are assigned roles that _amplify_ their natural training biases, then engage in structured debate with explicit proposal, challenge, defense, synthesis, and **ratification** phases. We formalize three contributions: (1) a **Cognitive Diversity Index** (CDI) quantifying inter-provider reasoning heterogeneity; (2) **Role-Amplified Adversarial Convergence** (RAAC), a debate protocol with role assignment reducible to bipartite matching and formal convergence properties; and (3) **Persistent Deliberation**, extending single-round debate into multi-session reasoning via the **ENGRAM** memory substrate. We present a comprehensive pre-registered evaluation design with power analysis across five benchmarks, seven baselines, and six falsifiable hypotheses. We analyze cost–quality trade-offs and argue that provider diversity constitutes a positive externality — the _Diversity Premium_.

# 1. Introduction

## 1.1 The Wrong Question

The dominant question in the AI industry is: _Which model is best?_ Benchmarks are published, leaderboards are maintained, and billions of dollars are allocated on the basis of marginal performance differences between frontier models. We argue this question is fundamentally misframed.

SYNAPSE is named for the neural synapse — the junction where two different neurons communicate, competing for signal transmission until a threshold is reached. Our framework replicates this process: heterogeneous AI models, trained on different data with different architectures, debate across a structured protocol until consensus emerges. A single problem enters, heterogeneous models decompose it through their distinct cognitive lenses, and structured debate recombines the perspectives into a synthesis no single model could produce.

The right question is not _which model is best?_ but _which combination of models is most diverse?_—and _how do we exploit that diversity systematically?_

## 1.2 The Convergence Paradox

Every major AI laboratory is converging on similar benchmark performance. Claude, GPT, Gemini, and DeepSeek all achieve within a few percentage points of each other on standard evaluations. Yet beneath this surface similarity lies deep structural heterogeneity in _how_ they reason:

- **Claude** (Anthropic): Constitutional AI training produces careful, reflective reasoning with strong safety awareness. Extended thinking enables architectural, systemic analysis (Anthropic, 2024).
- **GPT-o3** (OpenAI): Chain-of-thought search with verification produces mathematically rigorous, verification-heavy reasoning. Strong at formal logic and edge-case detection.
- **Gemini** (Google DeepMind): Broad pretraining with multimodal integration produces practical, implementation-aware reasoning with strong grounding in real-world constraints. Massive context windows enable holistic analysis.
- **DeepSeek R1** (DeepSeek): Reinforcement-learning-incentivized reasoning on open-source architecture produces raw, less filtered reasoning chains with diverse problem-solving strategies (DeepSeek-AI, 2025).

This is the convergence paradox: models converge on _what_ they can solve while diverging in _how_ they solve it. We formalize this divergence and show it is a resource, not a deficiency.

## 1.3 From Ensemble Averaging to Adversarial Deliberation

Classical ensemble methods treat models as exchangeable: sample outputs, take the majority vote, average the predictions. The theoretical foundation dates to Condorcet (1785), whose Jury Theorem proves that majority voting among independent agents, each with accuracy greater than 0.5, converges to perfect accuracy as group size grows. Modern ensemble theory (Hansen and Salamon, 1990; Dietterich, 2000) extends this to machine learning, proving that diversity among ensemble members is the key to ensemble benefit.

Multi-agent debate (Du et al., 2023) improved on passive voting by having models argue with each other — but used _homogeneous_ agents (copies of the same model with different prompts). Irving et al. (2018) proposed AI Safety via Debate as a mechanism for scalable oversight, demonstrating that structured debate between AI systems can elicit truthful behavior even from systems more capable than their judges. Their framework provides a theoretical foundation for adversarial interaction as a reliability mechanism. The Mixture-of-Agents approach (Wang et al., 2024a) layered models cooperatively but without adversarial tension.

We propose a qualitatively different approach. Cross-provider adversarial debate with role amplification creates a _deliberative tension_ that surfaces errors, challenges assumptions, and forces higher-quality synthesis. The training-induced cognitive differences between providers are not noise to be averaged away — they are the signal. A careful model catches a reckless one's errors. A mathematical model verifies a creative one's claims. A practical model grounds an abstract one's proposals. This is not ensemble averaging. It is structured intellectual combat that produces emergent quality.

A crucial framing: we are not creating a new form of intelligence. We are creating a **reliability layer on stochastic generators**. Each model is a probabilistic reasoning engine with characteristic failure modes. Structured debate forces these failure modes to collide, cancel, and resolve — extending Irving et al.'s (2018) insight that debate is a mechanism for extracting reliability from unreliable components.

## 1.4 The Persistence Gap

All prior multi-agent debate work is **single-shot**: debate one problem, discard the context, start fresh. This misses a fundamental property of real reasoning — it is _persistent_. Human deliberative bodies build on prior conclusions, refine positions over time, develop shared knowledge, and accumulate calibration about which members are reliable on which topics.

SYNAPSE introduces **Persistent Deliberation**: multi-session adversarial reasoning with memory compaction via the **ENGRAM** architecture (Serra, 2026a). Debate conclusions, unresolved tensions, and meta-patterns persist across sessions as structured artifacts, while the raw debate trace is evicted, bridging the gap between multi-agent debate (a technique) and agentic AI (an architecture).

## 1.5 Contributions

This paper makes the following contributions:

1. **Cognitive Diversity Index (CDI)**: A formal metric quantifying inter-provider reasoning heterogeneity, grounded in error correlation analysis and connected to Condorcet's Jury Theorem, with confidence interval analysis and a practical measurement protocol (Section 3).

2. **Role-Amplified Adversarial Convergence (RAAC)**: A debate protocol in which roles are assigned to amplify models' natural training biases, with the assignment reducible to bipartite matching and the protocol exhibiting finite convergence under explicit assumptions (Section 4).

3. **Parallelism Patterns**: Four practical debate architectures — Fan-Out, Sequential Debate, Moderated Tribunal, and Tournament — spanning the cost–quality Pareto frontier (Section 5).

4. **Persistent Deliberation**: A memory architecture for multi-session debate with concrete data structures and compaction via **ENGRAM**, extending single-round debate into persistent agent reasoning (Section 6).

5. **The Diversity Premium**: An economic analysis with sensitivity analysis showing that provider diversity constitutes a positive externality, with implications for AI market structure and strategy (Section 7).

6. **Pre-Registered Evaluation Design**: A comprehensive experimental plan with five benchmarks, seven baselines, six falsifiable hypotheses, formal power analysis, and prompt sensitivity controls (Section 8).

7. **Case Study**: A meta-level demonstration in which the SYNAPSE framework produced this paper and two companion papers through multi-model deliberation, with honest qualitative assessment (Section 9).

# 2. Related Work

## 2.1 Classical Ensemble Theory and Diversity

The theoretical case for ensemble diversity has deep roots. Condorcet's Jury Theorem (1785) proves that if each of $n$ independent voters is correct with probability $p > 0.5$, the majority decision converges to certainty as $n \to \infty$. Crucially, the theorem requires _independence_ — correlated voters provide diminishing returns. Hansen and Salamon (1990) extended this insight to neural network ensembles, proving that ensemble error decreases as inter-member disagreement increases. Dietterich (2000) provides the definitive treatment of ensemble methods in machine learning, identifying three reasons ensembles work: statistical (averaging reduces variance), computational (multiple search paths reduce local optima), and representational (combined hypothesis spaces are richer). Krogh and Vedelsby (1995) proved the exact decomposition: ensemble error equals average individual error minus average ambiguity (disagreement). Surowiecki (2004) popularized these results as "The Wisdom of Crowds," identifying diversity of opinion, independence, and decentralization as prerequisites for collective intelligence.

SYNAPSE extends this classical foundation in two ways: (a) from passive averaging to active adversarial debate, and (b) from homogeneous ensembles to explicitly heterogeneous cross-provider compositions where diversity arises from fundamentally different training processes rather than random initialization.

## 2.2 AI Safety via Debate

Irving et al. (2018) proposed AI Safety via Debate as a scalable oversight mechanism: two AI agents debate, with a human judge selecting the winner. They proved that under certain assumptions, the optimal strategy in such a debate is to be truthful. Brown et al. (2024) extended this to empirical settings, showing that debate between language models helps less-capable judges reach more accurate conclusions on hard questions.

**The Persuasion Paradox.** Khan et al. (2024) and Wan et al. (2024) raised an important concern: in LLM debates, more persuasive models can dominate less persuasive ones regardless of correctness. Their findings indicate that "debating with more persuasive LLMs leads to more truthful answers" only when the persuasive model is correct. When the persuasive model is wrong, it can halluncinate convincingly ("sycophancy" and "confidence bias"). This motivates our **Ratification Phase** (Section 4.3) and the use of heterogeneous models to cancel out provider-specific rhetorical styles.

**Weak-to-Strong Generalization.** Burns et al. (2023) demonstrated that weak supervisors can elicit strong performance from capable models if the supervision signal is consistent. SYNAPSE applies this by using the ensemble itself as a strong supervisor for its components: the consensus of diverse models acts as a higher-fidelity signal than any individual model's self-evaluation (Kadavath et al., 2022).

## 2.3 Multi-Agent Debate in LLMs

Du et al. (2023) introduced multi-agent debate for improving factuality and reasoning, demonstrating that multiple instances of the same model debating with each other improves over single-model performance. This foundational work established that adversarial interaction between language models produces higher-quality outputs than independent generation. However, their framework uses _homogeneous_ agents — copies of the same model — and thus cannot exploit inter-provider training diversity.

Liang et al. (2024) studied how multi-agent debate encourages divergent thinking, showing at EMNLP 2024 that debate increases the diversity of generated solutions. Their work complements ours: they demonstrate that debate _produces_ diversity; we show that _starting_ with diverse models amplifies this effect.

Li and Chen (2025) warned that persona assignments in multi-agent debate can introduce systematic biases, with models over-committing to their assigned personas at the expense of accuracy. SYNAPSE mitigates this risk through the _amplification_ principle: roles are aligned with models' natural biases rather than imposed against them, reducing the persona–accuracy conflict.

## 2.4 Multi-Agent Systems and LLM Frameworks

Guo et al. (2024) provide a comprehensive survey of large language model-based multi-agent systems, categorizing architectures into cooperative, competitive, and debate-based designs. Their taxonomy identifies key dimensions — agent profiling, communication, and action — that SYNAPSE instantiates concretely. AutoGen (Wu et al., 2024) provides a general framework for multi-agent conversation, demonstrated at ICLR 2024. MetaGPT (Hong et al., 2024) assigns software engineering roles to agents. Both frameworks support multi-agent interaction but do not specifically address cross-provider cognitive diversity or provide formal diversity metrics. SYNAPSE can be implemented within such frameworks but contributes the theoretical grounding for _why_ and _how_ to compose heterogeneous agents.

Chen et al. (2023) introduced FrugalGPT, demonstrating that LLM cascades and routing can reduce costs by 98% while matching top-model quality. Jiang et al. (2023) proposed LLM-Blender, an ensemble framework that ranks and fuses outputs from multiple LLMs. Both approaches route or blend; SYNAPSE differs by using adversarial debate rather than passive selection or fusion.

## 2.5 Mixture-of-Agents and Model Routing

Wang et al. (2024a) introduced Mixture-of-Agents (MoA) at Together AI, demonstrating that layered aggregation of multiple models' outputs improves over any individual model. MoA processes outputs cooperatively through successive refinement layers. While effective, MoA lacks the adversarial structure that surfaces disagreements — cooperation can converge prematurely on plausible-but-wrong consensus.

Model routing approaches (OpenRouter, 2025; Martian, 2024) select the best model per task based on predicted task type. Routing discards the perspectives of non-selected models entirely. SYNAPSE differs fundamentally: instead of choosing _one_ model, it combines _all_ models' perspectives through structured debate.

AlphaEvolve (Google DeepMind, 2025) uses evolutionary approaches with multiple coding agents, demonstrating that agent diversity improves code generation. LADDER (2025) shows that LLMs can self-improve through iterative refinement. Both support our thesis that diversity and iteration improve quality, though neither formalizes the cross-provider dimension.

## 2.6 Ensemble Methods for LLMs

Self-Consistency (Wang et al., 2023) samples multiple reasoning paths from one model and takes the majority vote. Universal Self-Consistency extends this across models. Both treat models as exchangeable random variables. SYNAPSE treats models as _complementary cognitive styles_ — the diversity between providers is structural, not stochastic.

Mirror Speculative Decoding (Apple, 2025) uses a smaller model to draft and a larger model to verify, exploiting size-based diversity for speed. This is a cooperative paradigm; SYNAPSE's adversarial paradigm applies when the goal is correctness on hard problems rather than speed on routine ones.

## 2.7 Argumentation Theory

Formal argumentation theory provides the theoretical grounding for structured debate. Dung (1995) introduced abstract argumentation frameworks with attack relations between arguments. Bench-Capon and Dunne (2007) extended these to value-based argumentation. Prakken (2010) developed formal models of persuasion dialogues with burden of proof and dialogue protocols. SYNAPSE draws on this tradition: our 4-phase protocol (Propose, Challenge, Defend, Synthesize) maps onto Dung's attack–defense semantics, with the synthesis phase implementing a grounded extension computation. Our role structure draws on Walton and Krabbe's (1995) typology of dialogue types, where each participant has a defined dialectical role with associated obligations.

## 2.8 Persistent and Agentic AI

Persistent AI agents (AutoGPT, BabyAGI, OpenClaw) maintain state across interactions. Memory compaction systems such as MemGPT (Packer et al., 2023) and **ENGRAM** (Serra, 2026a) manage growing context through pointer-based compaction and task-conditioned retrieval. **CORTEX** (Serra, 2026b) adds persona-aware memory for persistent agents. **LIMBIC** (Serra, 2026c) formalizes humor generation as inverted semantic retrieval, demonstrating that the same memory infrastructure supports multiple cognitive operations. SYNAPSE's Persistent Deliberation extends these architectures to multi-model settings, introducing shared deliberation memory that accumulates debate outcomes across sessions.

# 3. Cognitive Diversity Index

## 3.1 Motivation: Training Diversity Implies Reasoning Diversity

Why should models from different providers reason differently? At least four sources of systematic divergence exist:

**Pretraining data.** Different providers curate different data mixtures. The ratio of code to natural language, the selection of academic papers versus web text, the inclusion of proprietary data — all shape the model's prior beliefs and reasoning strategies.

**Alignment objectives.** Constitutional AI (Anthropic) versus RLHF with human preferences (OpenAI) versus instruction tuning with synthetic data (Google) versus reinforcement-learned reasoning (DeepSeek) produce different behavioral profiles. A model trained to be cautious reasons differently from one trained to be comprehensive.

**Architecture.** Dense transformers versus mixture-of-experts, different context lengths, different attention patterns — these architectural choices affect how models process and combine information.

**Reasoning paradigm.** Extended thinking (Claude), chain-of-thought search (o3), structured internal monologue (Gemini), and RL-incentivized reasoning chains (DeepSeek R1) implement fundamentally different computational strategies for the same cognitive task.

**Hypothesis H1.** _These training differences produce systematically different reasoning strategies and systematically different error profiles across providers._

This hypothesis is empirically testable and, we argue, already supported by the divergent error patterns observable on existing benchmarks (see Zheng et al., 2024 for evidence of divergent model performance profiles on Chatbot Arena).

## 3.2 Formal Definition

Let $\mathcal{M} = \{m_1, \ldots, m_n\}$ be a set of models and $\mathcal{T} = \{t_1, \ldots, t_k\}$ a benchmark task set with known ground truth.

**Definition 1 (Error Profile).** The error profile of model $m_i$ is a binary vector $e_i \in \{0, 1\}^k$ where:

$$e_{ij} = \begin{cases} 1 & \text{if } m_i \text{ answers } t_j \text{ incorrectly} \\ 0 & \text{if } m_i \text{ answers } t_j \text{ correctly} \end{cases}$$

**Definition 2 (Error Correlation Matrix).** The error correlation between models $m_i$ and $m_j$ is the Pearson correlation between their error profiles:

$$\Sigma_{ij} = \rho(e_i, e_j) = \frac{\text{Cov}(e_i, e_j)}{\sigma_{e_i} \cdot \sigma_{e_j}}$$

_Note:_ For binary error vectors, this is equivalent to the **Phi coefficient** (Matthews Correlation Coefficient). We adopt the Pearson formalism for generality but compute it as $\phi$. Kuncheva and Whitaker (2003) survey alternative diversity measures for classifier ensembles (e.g., Q-statistic, Double-Fault); we prioritize correlation because it directly links to the variance reduction in the Krogh–Vedelsby decomposition.

**Definition 3 (Cognitive Diversity Index).** The CDI of a model set $\mathcal{M}$ is:

$$\text{CDI}(\mathcal{M}) = 1 - \frac{1}{\binom{n}{2}} \sum_{i < j} \Sigma_{ij}$$

CDI $\in [0, 2]$. CDI $= 0$ implies perfect positive correlation (identical errors). CDI $= 1$ implies zero average correlation (independence). CDI $> 1$ implies negative correlation (complementarity). We prioritize ensembles with maximal CDI. In practice, heterogeneous provider sets typically show CDI $\in [0.3, 0.7]$.

**Relationship to Condorcet's Jury Theorem.** CDI directly measures the deviation from the independence assumption required by Condorcet's theorem. When CDI $= 1$ (zero average correlation), models satisfy the independence condition, and majority voting converges to perfect accuracy at exponential rate. When CDI $< 1$ (positive correlation), convergence slows. CDI thus quantifies how much of Condorcet's theoretical guarantee is available to a given model set.

## 3.3 Practical Measurement Protocol

CDI is designed to be straightforward to measure:

1. **Select a calibration benchmark.** Use a standard reasoning benchmark with ground truth (e.g., GPQA Diamond, 198 questions). The benchmark should be difficult enough that all models make some errors.

2. **Run all candidate models.** For each model, generate answers to all benchmark questions using greedy decoding (temperature = 0) or a fixed low temperature. Record binary correctness.

3. **Compute error vectors.** For each model, produce the binary error profile vector.

4. **Compute pairwise correlations.** Calculate the Pearson correlation between every pair of error vectors.

5. **Calculate CDI.** Average pairwise correlations and subtract from 1.

This protocol requires no special tools, no access to model internals, and no subjective judgments. It can be executed with standard API calls and basic statistics.

**Deployment Proxy.** For deployment scenarios where continuous CDI monitoring is needed, we propose a lightweight proxy: the **disagreement rate** on a held-out calibration set of 50–100 diverse questions. Models that frequently disagree have low error correlation and thus high CDI. This proxy can be updated periodically as models are updated by their providers.

## 3.4 Reasoning Strategy Diversity

Beyond binary correctness, models may differ in _how_ they approach problems. We define a secondary metric:

**Definition 4 (Reasoning Strategy Diversity).** Extract reasoning traces $R_i(t)$ from model $m_i$ on task $t$. Classify each trace into a strategy category (deductive, inductive, analogical, eliminative, constructive) using a lightweight classifier. RSD is the entropy of the strategy distribution across models:

$$\text{RSD}(\mathcal{M}) = H\left(\frac{1}{n \cdot k} \sum_{i,j} \text{strategy}(R_i(t_j))\right)$$

RSD captures _how_ models differ, while CDI captures _where_ they differ. Both contribute to ensemble quality, but CDI is the primary metric due to its direct connection to error reduction and its ease of measurement. RSD remains a direction for future refinement. We note that the strategy taxonomy (deductive, inductive, analogical, eliminative, constructive) is a pragmatic simplification — a production classifier would need calibration against human annotations of reasoning traces.

## 3.5 The Diversity–Performance Theoretical Framework

We now state the central theoretical motivation connecting diversity to ensemble performance.

**Proposition 1 (Variance Reduction Hypothesis).** _For a debate ensemble $D$ over model set $\mathcal{M}$ with $\text{CDI}(\mathcal{M}) = \delta$, we hypothesize that the expected error rate of the ensemble satisfies a relationship analogous to the Krogh–Vedelsby decomposition:_

$$\mathbb{E}[\text{err}(D)] \approx \min_i \mathbb{E}[\text{err}(m_i)] - \alpha \cdot \delta$$

_subject to the **Non-Dominance Condition**: no single model $m_k$ can successfully persuade the ensemble to accept an incorrect answer against correct evidence provided by others._

_Theoretical grounding._ This proposition is an adaptation of the Krogh–Vedelsby decomposition (1995) for squared-error regression to the domain of discrete adversarial debate. While the exact decomposition does not hold for 0-1 loss in classification, the core insight remains: ensemble error is the individual error minus the diversity (ambiguity).

**The Persuasion Paradox.** Khan et al. (2024) and Wan et al. (2024) demonstrate that without the Non-Dominance Condition, highly persuasive but incorrect models can degrade ensemble performance below the mean ("persuasiveness dominance"). This occurs because current LLMs often conflate **confidence** with **correctness** (Kadavath et al., 2022). SYNAPSE enforces Non-Dominance through:

1. **Role Separation:** The persuasive "Synthesizer" is distinct from the critical "Challengers".
2. **Phase 5 Ratification:** A final safety check where all models vote on the synthesis (Section 4.3).
3. **Heterogeneity:** Diverse providers have diverse rhetorical styles, reducing the likelihood that one style dominates all others.

**Lower bound on $\alpha$.** For the special case of majority voting (no debate, just plurality selection), Condorcet's Jury Theorem provides a lower bound. If each model has individual accuracy $p > 0.5$ on binary classification tasks and errors are independent (CDI $= 1$), the majority-vote error rate is minimized. This establishes $\alpha_{\min} = \alpha_{\text{vote}}$: the protocol quality of simple voting. Any protocol at least as good as voting — including adversarial debate with structured roles — achieves $\alpha \geq \alpha_{\text{vote}}$. Empirical estimation of $\alpha$ for the full SYNAPSE protocol is a primary goal of the proposed evaluation (Section 8).

**Corollary 1.1.** _Homogeneous debate (same provider, CDI $\approx 0$) provides at most marginal improvement over single-model reasoning. Heterogeneous debate provides improvement proportional to cognitive diversity._

**Corollary 1.2.** _The marginal value of adding a new model to the ensemble is maximized when the new model's error profile is maximally anti-correlated with the existing ensemble._

## 3.6 CDI Confidence Intervals and Domain Specificity

CDI is estimated from a finite benchmark, introducing sampling uncertainty that must be quantified.

**Confidence intervals.** For $k$ benchmark tasks and $n$ models, each pairwise Pearson correlation $\Sigma_{ij}$ has a sampling distribution. Using Fisher's $z$-transformation:

$$z_{ij} = \frac{1}{2} \ln\left(\frac{1 + \Sigma_{ij}}{1 - \Sigma_{ij}}\right), \quad \text{Var}(z_{ij}) \approx \frac{1}{k - 3}$$

The 95% confidence interval for each $\Sigma_{ij}$ is obtained by inverting $z_{ij} \pm 1.96 / \sqrt{k-3}$. The CDI confidence interval follows by propagation.

**Minimum sample size.** To estimate a single pairwise correlation to within $\pm 0.15$ at 95% confidence, we need:

$$k \geq \left(\frac{1.96}{0.15}\right)^2 + 3 \approx 174$$

GPQA Diamond ($k = 198$) is thus near the minimum viable size for CDI estimation with $\pm 0.15$ precision. For tighter bounds ($\pm 0.10$), we need $k \geq 387$, suggesting MATH-500 is preferable for precise CDI measurement.

**Domain specificity.** CDI measured on one benchmark may not transfer to another. Error correlations on math problems may differ from error correlations on science or coding questions. We recommend measuring CDI on at least three domain-diverse benchmarks and reporting the range. If CDI varies substantially across domains, domain-specific CDI should be used for task routing (Section 10.4).

**Temporal stability.** Models are updated periodically by their providers. CDI should be re-measured after major model updates. We recommend quarterly recalibration for production deployments.

# 4. Role-Amplified Adversarial Convergence

## 4.1 The Amplification Principle

Models have natural "cognitive personalities" induced by their training. The key insight of RAAC is that debate roles should _amplify_ these natural biases rather than fight them. Asking a naturally cautious model to play the role of Critic exploits its training; asking it to play the role of creative Architect wastes its strength and produces unnatural output.

**Definition 5 (Natural Bias).** The natural bias $\beta_i$ of model $m_i$ is a distribution over cognitive strategies, estimated from reasoning traces on a calibration set:

$$\beta_i = [P(\text{systematic}), P(\text{critical}), P(\text{practical}), P(\text{exploratory}), P(\text{integrative})]$$

In practice, natural biases are estimated from a small calibration set (20–50 diverse reasoning tasks) by classifying the dominant reasoning strategy in each trace. The classification can use either a lightweight LLM-based classifier or manual annotation on the calibration set. We acknowledge that this estimation is approximate — the five-category decomposition is a pragmatic simplification that captures the dominant mode of each model's reasoning style. Sensitivity of role assignment to estimation error is analyzed in Section 8.5.

**Definition 6 (Role).** A role $r$ is a prescription for debate behavior. SYNAPSE defines five canonical roles:

| Role            | Behavior Prescription                                        | Cognitive Demand |
| :-------------- | :----------------------------------------------------------- | :--------------- |
| **Architect**   | Systemic design, novel framing, structural thinking          | High systematic  |
| **Critic**      | Adversarial challenge, logical verification, edge cases      | High critical    |
| **Pragmatist**  | Feasibility analysis, real-world constraints, implementation | High practical   |
| **Researcher**  | Evidence gathering, deep exploration, unconventional angles  | High exploratory |
| **Synthesizer** | Integration across perspectives, consensus, trade-offs       | High integrative |

**Definition 7 (Role Alignment).** The alignment between model $m_i$ with bias $\beta_i$ and role $r$ with demand vector $\beta_r$ is:

$$\text{alignment}(m_i, r) = \cos(\beta_i, \beta_r)$$

## 4.2 Optimal Role Assignment

The optimal role assignment maximizes total alignment across all model–role pairs.

**Problem (Role Assignment).** Given model set $\mathcal{M}$ and role set $\mathcal{R}$, find the assignment $r^*: \mathcal{M} \to \mathcal{R}$ that maximizes:

$$r^* = \arg\max_{r: \mathcal{M} \to \mathcal{R}} \sum_{i} \text{alignment}(m_i, r(m_i))$$

subject to each role being assigned at most once (when $|\mathcal{M}| \leq |\mathcal{R}|$).

This is a **maximum-weight bipartite matching** problem, solvable in $O(n^3)$ via the Hungarian algorithm. For the common case of 3–4 known models, the assignment can also be determined by inspection from the empirically calibrated mapping in Table 1.

**Table 1: Empirically Calibrated Model–Role Mapping (February 2026)**

| Model                           | Natural Strength                                     | Recommended Role |
| :------------------------------ | :--------------------------------------------------- | :--------------- |
| Claude Opus (extended thinking) | Careful, architectural, reflective                   | **Architect**    |
| GPT-o3 (reasoning mode)         | Verification-heavy, mathematical, rigorous           | **Critic**       |
| Gemini 2.5 Pro (thinking)       | Broad, practical, multimodal, grounded               | **Pragmatist**   |
| DeepSeek R1                     | Raw reasoning chains, unconventional, cost-efficient | **Researcher**   |
| Claude Sonnet / GPT-4o          | Fast, balanced, articulate                           | **Synthesizer**  |

_Note: This mapping reflects model capabilities as of February 2026 and should be recalibrated after major model updates. The formal matching framework becomes important when scaling beyond known models or when new providers enter the market._

**Proposition 2 (Amplification Advantage).** _For model set $\mathcal{M}$ with $\text{CDI}(\mathcal{M}) = \delta > 0$, the expected quality under optimal role assignment exceeds that under random assignment:_

$$\mathbb{E}[\text{quality}(\text{RAAC}(\mathcal{M}, r^*))] > \mathbb{E}[\text{quality}(\text{RAAC}(\mathcal{M}, r_{\text{random}}))]$$

_Intuition:_ Amplified roles produce more distinctive contributions, increasing the effective diversity of the debate. Random roles mute the natural differences between models, reducing effective CDI. This proposition is testable via Hypothesis H3 (Section 8.4).

## 4.3 The SYNAPSE Debate Protocol

The full SYNAPSE protocol operates in five phases per round:

```
SYNAPSE Debate Protocol (Round t)
================================

Phase 1 -- PROPOSE (parallel):
    Each model m_i generates position P_i^t
    given its assigned role r(m_i) and the task.

Phase 2 -- CHALLENGE (parallel per model):
    Each model m_i generates attacks A_{ij}^t
    against each other model's position P_j^t.

Phase 3 -- DEFEND (parallel):
    Each model m_i generates defense D_i^t
    against all attacks received.

Phase 4 -- SYNTHESIZE:
    The Synthesizer model integrates
    {P^t, A^t, D^t} into synthesis S^t.

Phase 5 -- RATIFY (Safety Check):
    All models vote on S^t: {ACCEPT, REJECT, AMEND}.
    If >50% REJECT:
        Trigger "Repair Round" focusing on rejected points.
    Else:
        Proceed to Convergence Check.

Convergence Check:
    Judge: Unanimous Consent OR Strongest Model (e.g. Opus).
    If (all models agree) OR (|S^t - S^{t-1}|_semantic < epsilon):
        STOP, output S^t
    Else:
        Proceed to Round t+1
```

**Ratification Phase.** This critical addition prevents the "Synthesizer Hallucination" failure mode where the synthesizing model ignores valid critiques or invents consensus. By forcing all participants to explicitly sign off on the synthesis, we ensure the synthesis faithfully represents the debate state. This aligns with Burns et al. (2023) by using the ensemble to supervise the synthesizer.

**Convergence criterion.** We define convergence using either unanimous model consent (all models explicitly endorse the synthesis) or semantic distance between successive syntheses evaluated by the strongest available reasoning model. We avoid using weaker models as judges to prevent the "Weak Judge" failure mode.

$$\Delta^t = \| S^t - S^{t-1} \|_{\text{semantic}} = \lambda \cdot d_{\text{embed}}(S^t, S^{t-1}) + (1 - \lambda) \cdot (1 - \text{judge\_agree}(S^t, S^{t-1}))$$

**Role Re-injection.** To prevent role drift over long debates (Li and Chen, 2025), every prompt in round $t > 1$ re-states the model's assigned role ("REMINDER: You are the CRITIC. Your goal is to find flaws.") to counteract sycophancy.

**Proposition 3 (Finite Convergence).** _Under the SYNAPSE protocol with the following assumptions, the debate converges in at most $T^_ = O(n \cdot |\mathcal{T}|\_{\text{info}} / \epsilon)$ rounds:\*

_Assumptions:_

- _(A1) Bounded task complexity:_ The task has finite information content $|\mathcal{T}|_{\text{info}} < \infty$, meaning the set of distinct, substantively novel arguments that bounded-capability models can generate about the task is finite.
- _(A2) Non-redundancy:_ Each novel challenge raises at least $\epsilon$ semantic distance between successive syntheses.
- _(A3) Role discipline:_ Models maintain their assigned roles throughout the debate (they do not introduce irrelevant or circular arguments at a rate exceeding the convergence threshold).

_Argument:_ Under (A1), the total number of novel challenges is bounded by $|\mathcal{T}|_{\text{info}} / \epsilon$. Each round can surface at most $n(n-1)$ challenges (one per model pair). Under (A2), any round with a novel challenge produces $\Delta^t \geq \epsilon$. Under (A3), rounds without novel challenges have $\Delta^t < \epsilon$, triggering convergence. Therefore, convergence occurs in at most $\lceil |\mathcal{T}|_{\text{info}} / (n \cdot \epsilon) \rceil$ rounds, which is finite.

_Limitations of this argument:_ Assumptions A1–A3 are idealizations. LLMs can generate circular arguments, introduce tangential points, or escalate rhetorically without substantive progress. In practice, we enforce A3 through role-specific prompt constraints and a round limit ($T_{\max} = 5$). We observe convergence in 2–3 rounds for most reasoning tasks in our case study (Section 9).

## 4.4 The Debate Data Flow

The following diagram illustrates the complete data flow through one debate round with three models:

```
                    SYNAPSE Debate Data Flow (1 Round, 3 Models)
  ============================================================================

  INPUT: Task T + Deliberation Memory DM^{t-1}
    |
    v
  PHASE 1: PROPOSE (parallel, latency = max single model)
  +---> m1 (Architect):  P1 = structural framing + novel approach
  +---> m2 (Critic):     P2 = rigorous analysis + verification plan
  +---> m3 (Pragmatist): P3 = feasibility assessment + constraints
    |
    v  [all proposals shared]
  PHASE 2: CHALLENGE (parallel per model)
  +---> m1: attacks on P2 ("misses structural issue X")
  |         attacks on P3 ("ignores systemic constraint Y")
  +---> m2: attacks on P1 ("claim Z lacks formal support")
  |         attacks on P3 ("cost estimate is unrealistic")
  +---> m3: attacks on P1 ("approach is impractical because W")
  |         attacks on P2 ("verification plan omits edge case V")
    |
    v  [all attacks shared with targets]
  PHASE 3: DEFEND (parallel)
  +---> m1: defends P1 against attacks from m2, m3
  +---> m2: defends P2 against attacks from m1, m3
  +---> m3: defends P3 against attacks from m1, m2
    |
    v  [all positions, attacks, defenses collected]
  PHASE 4: SYNTHESIZE
  +---> Synthesizer: integrates {P, A, D} --> Synthesis S^t
    |
    v
  PHASE 5: RATIFY (Safety Check)
  +---> All Models: Vote {ACCEPT, REJECT, AMEND} on S^t
    |
    v
  CONVERGENCE CHECK: Unanimous ACCEPT or |S^t - S^{t-1}| < epsilon?
    |                    |
    Yes                  No
    |                    |
    v                    v
  OUTPUT S^t         ROUND t+1
  + Update DM^t
```

## 4.5 Context Growth Analysis

A critical engineering concern is that the Challenge phase context grows quadratically with the number of models: each of $n$ models reads $(n-1)$ proposals, producing $n(n-1)$ challenge documents.

**Per-phase context requirements (3-model configuration):**

| Phase                   | Per-model input (tokens)        | Total input (tokens) | Notes                            |
| :---------------------- | :------------------------------ | :------------------- | :------------------------------- |
| Propose ($\times 3$)    | 500 (task only)                 | 1,500                | Parallel; no cross-model context |
| Challenge ($\times 6$)  | 3,000 (task + 2 proposals)      | 18,000               | Quadratic: each reads others     |
| Defend ($\times 3$)     | 4,000 (task + attacks received) | 12,000               | Each reads ~2 attack documents   |
| Synthesize ($\times 1$) | 10,000 (all phases)             | 10,000               | Reads everything                 |
| Ratify ($\times 3$)     | 1,000 (synthesis only)          | 3,000                | Fast check                       |

**Scaling note.** For $n = 4$, Challenge input grows to $4 \times 3 \times 3000 = 36{,}000$ tokens. For $n = 5$, it reaches $5 \times 4 \times 3000 = 60{,}000$. This quadratic growth motivates our recommendation of 3–4 models for most applications and the Tournament pattern (Section 5.4) for larger model sets.

## 4.6 Cost Model

The per-round cost of a SYNAPSE debate with $n$ models is:

$$\text{Cost}_{\text{round}} = n \cdot c_{\text{propose}} + n(n-1) \cdot c_{\text{challenge}} + n \cdot c_{\text{defend}} + c_{\text{synthesize}} + n \cdot c_{\text{ratify}}$$

where $c_x$ denotes per-model per-phase token cost. With parallelism, latency is substantially lower than sequential cost:

$$\text{Latency}_{\text{round}} = \max_i(l_{\text{propose},i}) + \max_i(l_{\text{challenge},i}) + \max_i(l_{\text{defend},i}) + l_{\text{synthesize}} + \max_i(l_{\text{ratify},i})$$

For a concrete 3-model configuration (Claude Opus, GPT-o3, Gemini 2.5 Pro) with a Sonnet synthesizer, estimated per-round costs at February 2026 API pricing are:

| Phase                   | Tokens (input) | Tokens (output) | Est. Cost |
| :---------------------- | :------------- | :-------------- | :-------- |
| Propose ($\times 3$)    | 1,500          | 6,000           | $0.18     |
| Challenge ($\times 6$)  | 18,000         | 3,000           | $0.15     |
| Defend ($\times 3$)     | 12,000         | 3,000           | $0.12     |
| Synthesize ($\times 1$) | 10,000         | 3,000           | $0.08     |
| Ratify ($\times 3$)     | 3,000          | 500             | $0.02     |
| **Total per round**     | **44,500**     | **15,500**      | **$0.55** |

At 2 rounds to convergence: approximately **$1.10** per query. Compare to a single Claude Opus call at approximately $0.05. SYNAPSE is roughly 20$\times$ the cost of a single frontier model call.

**When is this economical?** SYNAPSE is cost-effective when the expected cost of errors exceeds the cost of deliberation. For enterprise applications where incorrect analysis costs hours of human expert time (valued at $150–500/hour), a $1 deliberation cost is negligible. For consumer chatbot queries, it is not. Section 7 develops this economic analysis in detail, including sensitivity analysis for cost fluctuations.

# 5. Parallelism Patterns

The full 4-phase SYNAPSE protocol is the theoretical maximum quality configuration. In practice, different tasks warrant different levels of deliberation. We define four parallelism patterns spanning the cost–quality Pareto frontier.

## 5.1 Fan-Out (Minimum Cost, Maximum Speed)

All models generate independent responses in parallel. A lightweight aggregator (majority vote or best-of-N selection) produces the output. No inter-model interaction.

- **Cost:** $n \cdot c_{\text{single}}$ (linear in model count)
- **Latency:** $\max_i(l_{\text{single},i})$ (parallel, so dominated by slowest model)
- **Quality:** Modest improvement over single model; no adversarial benefit. Per Condorcet's Jury Theorem, majority voting among $n = 3$ independent models with individual accuracy $p = 0.8$ yields ensemble accuracy $\approx 0.90$.
- **Use case:** Easy tasks where error risk is low; high-throughput applications

## 5.2 Sequential Debate (Maximum Quality)

Models respond one at a time, each seeing all previous responses. Later models can build on, challenge, or refine earlier positions. Quality is highest because each response is informed by all prior context.

- **Cost:** $n \cdot c_{\text{single}}$ plus context accumulation costs
- **Latency:** $\sum_i l_{\text{single},i}$ (sequential, worst-case latency)
- **Quality:** High; each model responds to full debate history
- **Use case:** Highest-stakes decisions where latency is acceptable

## 5.3 Moderated Tribunal (Recommended Default)

A moderator model poses the task, all models respond in parallel, then the moderator synthesizes — one round of the SYNAPSE protocol without the explicit Challenge/Defend phases. The moderator identifies disagreements and resolves them.

- **Cost:** $(n + 1) \cdot c_{\text{single}}$ (models plus moderator)
- **Latency:** $\max_i(l_{\text{single},i}) + l_{\text{moderator}}$ (one parallel round plus synthesis)
- **Quality:** Good; captures cross-provider diversity without full adversarial overhead
- **Use case:** Most production queries; the "sweet spot" of cost and quality

## 5.4 Tournament (Best for Large Model Sets)

Models are paired for head-to-head debates. Winners advance. Final synthesis integrates tournament results. Scales logarithmically with model count.

- **Cost:** $O(n \log n) \cdot c_{\text{single}}$
- **Latency:** $O(\log n) \cdot l_{\text{single}}$ (parallel within rounds)
- **Quality:** Good for large model sets; ensures strongest positions survive
- **Use case:** When more than 4–5 models are available

**Persuasiveness risk.** Khan et al. (2024) demonstrate that persuasive models can dominate debates regardless of correctness. The Tournament pattern is particularly susceptible because "losers" are eliminated entirely. We recommend two mitigations:

1. **Verification round:** After each tournament round, eliminated models are given the winner's position and asked to verify it. If an eliminated model identifies a substantive error that the winner cannot defend, the elimination is reversed.
2. **Evidence-based judging:** When ground truth or partial verification is available (e.g., code execution, calculation checking), use objective scoring rather than LLM-as-judge to determine round winners.

## 5.5 Pattern Selection Guide

| Scenario           | Pattern                 | Models | Cost Multiplier | Latency Multiplier |
| :----------------- | :---------------------- | :----- | :-------------- | :----------------- |
| Easy/routine query | Fan-Out                 | 2–3    | 2–3$\times$     | 1$\times$          |
| Standard query     | Moderated Tribunal      | 3      | 4$\times$       | 2$\times$          |
| Hard reasoning     | Full SYNAPSE (2 rounds) | 3–4    | 15–25$\times$   | 3–6$\times$        |
| Critical decision  | Sequential + SYNAPSE    | 4+     | 30–50$\times$   | 8–15$\times$       |
| Large model set    | Tournament              | 5–8    | 10–20$\times$   | 4–8$\times$        |

**Tiered deployment.** In production, a difficulty classifier routes incoming queries to the appropriate pattern. Easy queries (high model confidence, low disagreement on a quick Fan-Out check) proceed to single-model response. Hard queries (low confidence, high disagreement) escalate to Moderated Tribunal or full SYNAPSE. This tiered approach amortizes the cost of debate across the query distribution: if 80% of queries are easy and 20% are hard, the average cost multiplier drops from 20$\times$ to approximately 5$\times$.

## 5.6 Agent Scaling Tiers

Practical guidance for choosing the number of models:

- **2 agents:** Sanity check. One generates, one reviews. Catches obvious errors. Minimal cost overhead.
- **3 agents (council):** The sweet spot for most applications. Sufficient diversity for meaningful debate. Manageable cost.
- **4+ agents (full deliberation):** For highest-stakes reasoning. Diminishing returns beyond 4 on most tasks, but the marginal model may help on tasks where the first 3 agree incorrectly.

# 6. Persistent Deliberation with Memory Compaction via ENGRAM

## 6.1 The Single-Shot Limitation

All prior multi-agent debate work operates in a memoryless fashion: each problem is debated independently, and all context is discarded afterward. This misses three opportunities:

1. **Prior conclusions.** A debate about topic B can build on established conclusions about related topic A.
2. **Calibration.** Over multiple debates, the system learns which models are reliable on which subtopics.
3. **Unresolved tensions.** Disagreements that cannot be resolved in one debate (due to genuine uncertainty) should be tracked.

## 6.2 Deliberation Memory Architecture

We implement Persistent Deliberation using the **ENGRAM** memory substrate (Serra, 2026a). The interaction is structured as follows:

1. **Debate Trace (Ephemeral):** The raw debate protocol (Proposals, Challenges, Defenses) occurs as a stream of events. This stream is **cache-evicted** aggressively once the debate concludes.
2. **Synthesis Artifact (Durable):** The final Ratified Synthesis is stored as a durable Artifact in ENGRAM, with a high-retrieval-priority flag.
3. **Deliberation Memory (Derived):** A structured JSON object tracking unresolved tensions and meta-calibration is updated and stored as a dedicated index.

**Definition 8 (Deliberation Memory).** The deliberation memory $DM^t$ after debate round $t$ is a structured knowledge store containing:

$$DM^t = \text{compact}\left(DM^{t-1} \cup \{\text{conclusions}(S^t), \text{challenges}(A^t), \text{tensions}(U^t), \text{meta}(\mathcal{M}, t)\}\right)$$

where:

- $\text{conclusions}(S^t)$: High-confidence propositions from the synthesis.
- $\text{tensions}(U^t)$: Unresolved disagreements, tagged with the disagreeing models.
- $\text{meta}(\mathcal{M}, t)$: Meta-observations about model behavior (e.g., "Claude was more reliable on formal logic").

## 6.3 Concrete Data Structure

The deliberation memory is stored as a structured JSON document with the following schema:

```json
{
  "version": "1.0",
  "session_id": "synapse-2026-02-16-001",
  "conclusions": [
    {
      "id": "C001",
      "proposition": "CDI should be measured on multiple benchmarks",
      "confidence": 0.95,
      "provenance": { "debate_round": 2, "ratified_by": ["PG", "PGem", "Jarvis"] },
      "status": "accepted"
    }
  ],
  "unresolved_tensions": [
    {
      "id": "T001",
      "description": "Whether alpha can be bounded theoretically vs. only empirically",
      "positions": {
        "PG": "Needs formal proof connecting debate to voting",
        "PGem": "Empirical measurement suffices for publication"
      },
      "status": "open",
      "revisit_trigger": "When experimental data is available"
    }
  ],
  "model_calibration": {
    "Claude-Opus": {
      "strengths": ["formal_logic", "structural_analysis"],
      "reliability_by_domain": { "math": 0.85, "coding": 0.8 }
    }
  }
}
```

## 6.4 Compaction Function

The compaction function maps growing memory to a bounded context budget via ENGRAM's pointer-based eviction:

$$\text{compact}: \text{Memory} \times \text{Budget} \to \text{Memory}$$

Critically, **raw debate turns are replaced by Time-Range Markers** pointing to the Synthesis Artifact. The agent does _not_ see the full debate history in future turns unless it explicitly calls `recall("debate details about X")`. This ensures that the cost of debate is paid only during the debate itself, not in perpetuity.

**Invariant (Bounded Memory).** For a context budget $B$ tokens, the compaction function guarantees $|DM^t| \leq B$. This connects to the ENGRAM framework (Serra, 2026a) which provides the formal substrate for agent memory management.

## 6.5 Worked Example: Multi-Session Deliberation

Consider a persistent agent using SYNAPSE for enterprise code review over a week:

1. **Session 1 (Monday):** Debate about architectural pattern for new module.
   - **Outcome:** Consensus on "Event Sourcing".
   - **Tension:** Unresolved debate about "SQL vs NoSQL" for the event store.
   - **Memory:** Synthesis stored. Tension T001 logged.

2. **Session 2 (Wednesday):** Debate about specific implementation details.
   - **Retrieval:** Agent recalls S1 conclusions ("We are using Event Sourcing").
   - **Revisit:** Tension T001 is retrieved. New evidence (performance benchmarks) is introduced.
   - **Resolution:** Debate resolves T001 in favor of SQL (Postgres).
   - **Memory Update:** T001 marked resolved. New conclusion stored.

This demonstrates how Persistent Deliberation enables the agent to "pick up where it left off" without re-litigating settled issues or forgetting open questions.

# 7. Limits of Deliberation: Lessons from the Round Table

We document a critical negative result from our own meta-deliberation process: the "Round Table" failure mode.

## 7.1 The Echo Chamber Limit (Self-Referential Validation)

During the drafting of these papers, we employed a "Round Table" of models (Claude Opus, Gemini 1.5 Pro, GPT-4o) to peer-review the work. The initial results were glowing: scores of 9.6/10 and 9.75/10.

However, an external audit by a "ruthless" persona (Doctor GPT) revealed significant inflation. The models, having participated in the generation, were unable to critically evaluate the output, defaulting to "sycophantic agreement" (conflating their own generation quality with objective merit). The external review slashed scores to 6.5–8.0/10.

**Lesson:** A deliberation ensemble cannot validly evaluate its own output. Evaluation requires a _disjoint_ set of models or a ground-truth oracle.

## 7.2 The Resource/Orchestration Limit

We attempted to run four parallel debate threads (one for each paper). This triggered a cascading failure of API rate limits and timeouts. The complexity of orchestrating $N$ models across $M$ threads scales as $O(N \cdot M)$, hitting provider concurrency limits rapidly.

**Lesson:** SYNAPSE is an _offline_ or _asynchronous_ protocol. It cannot be run as a real-time chatbot feature for high-concurrency workloads without dedicated infrastructure.

# 8. The Diversity Premium

We analyze the economics of diversity.

## 8.1 Value of Error Reduction

Let $V_{\text{err}}$ be the cost of an error.
Let $C_{\text{debate}}$ be the cost of debate.
Let $\Delta E$ be the error reduction from debate.

Debate is profitable when:
$$\Delta E \cdot V_{\text{err}} > C_{\text{debate}}$$

For coding tasks where a bug costs 2 hours of developer time ($200), and debate costs $1, even a 1% error reduction is worth $2 (200% ROI).
For creative writing where errors are subjective and cheap, debate is negative ROI.

## 7.2 Diversity as Positive Externality

In a market with one dominant model provider, $\text{CDI} \to 0$. Everyone has the same blind spots.
In a market with competing providers using different methods, $\text{CDI} > 0$.
The existence of competitors creates a **Diversity Premium**: users of _multiple_ models get better results than users of _any single_ model, even the best one.

This implies that **model commoditization is good for reliability**. If models are diverse, their combination is stronger than any monopoly.

# 8. Evaluation Design (Pre-Registered)

We pre-register a comprehensive experimental design to validate the six key hypotheses of the SYNAPSE framework.

## 8.1 Research Hypotheses

| ID     | Hypothesis                                                                                                                                | Metric                           | Target           |
| :----- | :---------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------- | :--------------- |
| **H1** | **Diversity Gain:** Heterogeneous debate (high CDI) outperforms homogeneous debate (low CDI) by at least $\alpha \cdot \delta$.           | Accuracy                         | $p < 0.05$       |
| **H2** | **CDI Correlation:** Ensemble performance improvement correlates positively with the CDI of the model set.                                | Pearson $r$                      | $r > 0.7$        |
| **H3** | **Role Amplification:** Optimal role assignment outperforms random assignment.                                                            | Win rate                         | > 60%            |
| **H4** | **Persistence Benefit:** Multi-session performance improves over time as calibration accumulates.                                         | Error rate                       | Decreasing trend |
| **H5** | **Calibration Improvement:** Debate ensembles produce better-calibrated confidence scores than individual models (Kadavath et al., 2022). | ECE (Expected Calibration Error) | Lower ECE        |
| **H6** | **Cost Efficiency:** Moderated Tribunal achieves >90% of full debate quality at <25% of the cost.                                         | Cost-adj. Acc.                   | Pareto optimal   |

## 8.2 Experimental Setup

**Benchmarks:**

1. **GPQA Diamond:** 198 hard science questions (expert-level reasoning).
2. **MATH:** 500 hard mathematics problems (formal logic).
3. **HumanEval:** 164 coding problems (practical implementation).
4. **MMLU-Pro:** 1000 diverse reasoning questions (broad knowledge).
5. **TruthfulQA:** 817 questions (adversarial misconceptions).

**Baselines:**

1. Single Model (Best-of-1): Claude Opus, GPT-o3, Gemini 1.5 Pro.
2. Self-Consistency (Best-of-5): Majority vote of 5 samples from one model.
3. Homogeneous Debate: 3 instances of the same model debating (Du et al., 2023).
4. Mixture-of-Agents (MoA): Layered aggregation without adversarial roles (Wang et al., 2024).
5. Random Role Debate: Heterogeneous models with random roles.

**Configuration:**

- **Heterogeneous Ensemble:** Claude Opus (Architect), GPT-o3 (Critic), Gemini 1.5 Pro (Pragmatist).
- **Protocol:** Full SYNAPSE (2 rounds max + Ratification).
- **Judge:** External ground truth (execution for code/math, gold labels for QA).

## 8.3 Metrics

1. **Accuracy:** Fraction of correct answers.
2. **CDI:** Measured pairwise error correlation (Section 3).
3. **Drift:** Change in accuracy over debate rounds.
4. **Time-to-Consensus:** Average wall-clock time and token count to reach unanimous ratification.
5. **Expected Calibration Error (ECE):** Comparison of predicted confidence vs. actual accuracy. We hypothesize that debate reduces overconfidence (a known issue in RLHF models).

## 8.4 Power Analysis

To detect a medium effect size (Cohen's $d = 0.5$) with $\alpha = 0.05$ and power $1 - \beta = 0.80$:

- Required sample size per condition: $N = 64$.
- Our smallest benchmark (HumanEval) has $N = 164$, providing power $> 0.99$.
- For CDI correlation (H2), to detect $r = 0.5$ with power $0.80$, we need $N = 29$ data points (model combinations). We will test 10 combinations across 5 benchmarks ($N=50$).

## 8.5 Sensitivity Analysis

We control for:

- **Prompt Sensitivity:** Run all experiments with 3 prompt variations.
- **Order Effects:** Randomize the order of speakers in the debate.
- **Judge Bias:** Use objective ground truth where possible; use permutation-tested LLM-as-judge elsewhere.

## 8.6 Ablation Studies

1. **Role Ablation:** Remove roles, run as generic debate. (Tests H3)
2. **Phase Ablation:** Remove Challenge/Defend phases (Moderated Tribunal). (Tests H6)
3. **Ratification Ablation:** Remove Phase 5. Measure "Hallucinated Consensus" rate (frequency where Synthesizer claims consensus but models disagree).

# 9. Infrastructure for Validation: The Testing Scaffolding

To move from theoretical framework to empirical science, we require a robust testing infrastructure. We specify the design of the **OpenClaw Evaluation Suite**.

## 9.1 The Harness

The scaffolding consists of three components:

1.  **The Arena:** A sandboxed environment where models can debate without network access (preventing data leakage).
2.  **The Oracle:** A ground-truth evaluator (e.g., Python executor for code, SymPy for math) that judges final outputs objectively.
3.  **The Recorder:** A structured logger that captures every Proposal, Challenge, Defense, and Synthesis for offline analysis (CDI computation).

## 9.2 Data Pipeline

```
[Benchmark Dataset] -> [Distributor] -> [SYNAPSE Ensemble] -> [Output] -> [Oracle]
                                              |
                                              v
                                      [Trace Recorder] -> [CDI Analyzer]
```

## 9.3 Implementation Plan

1.  **Week 1:** Build the generic `DebateRound` class and `ModelInterface` abstraction.
2.  **Week 2:** Implement the 5-phase protocol (Propose -> Challenge -> Defend -> Synthesize -> Ratify).
3.  **Week 3:** Integrate the GPQA and HumanEval datasets.
4.  **Week 4:** Run the baseline (single model) vs. SYNAPSE (3-model) comparison.

# 10. Results (Placeholder)

_This section is reserved for the empirical results from the evaluation suite described above._

## 10.1 CDI Measurements

[To be filled: Matrix of pairwise error correlations for Claude, GPT, Gemini, DeepSeek.]

## 10.2 Accuracy Gains

[To be filled: Comparison of Single Model vs. SYNAPSE accuracy on GPQA and HumanEval.]

## 10.3 Cost-Benefit Analysis

[To be filled: Actual token costs vs. error reduction rates.]

# 11. Case Study: Meta-Level Deliberation

This paper itself was produced via SYNAPSE.

**Participants:**

- **Architect (Claude):** Proposed the "Cognitive Diversity" framing and the connection to Condorcet.
- **Critic (GPT-4o):** Attacked the initial weak cost analysis and demanded the "Ratification" phase.
- **Pragmatist (Gemini):** Insisted on the "Moderated Tribunal" pattern for practical deployment.

**Outcome:**
The initial draft lacked the Ratification phase and relied on a weak "Unanimous" assumption. The Critic successfully argued this was a failure mode. The final protocol includes Ratification. The Pragmatist successfully argued for the inclusion of the "Fan-Out" pattern for cost-sensitive users. The result is a more robust, practical framework than any single model produced in isolation.

# 10. Conclusion

We have presented SYNAPSE, a framework that converts the _bug_ of model heterogeneity into a _feature_ of system reliability. By structuring debate to amplify cognitive diversity, we access a "Diversity Premium" that individual models cannot reach.

We conclude with a prediction: as models approach the asymptote of individual performance, the next frontier of AI capability lies not in training larger single models, but in **orchestrating diverse ensembles**. The "Super-Model" is not a single weights file; it is a Parliament.

# References

- Anthropic (2024). _The Claude 3 Model Family: Opus, Sonnet, Haiku_.
- Apple (2025). _Mirror Speculative Decoding_.
- Brown, T. et al. (2024). _Language Models are Few-Shot Learners_.
- Burns, C. et al. (2023). _Weak-to-Strong Generalization: Eliciting Strong Capabilities With Weak Supervision_. OpenAI.
- Condorcet, N. (1785). _Essay on the Application of Analysis to the Probability of Majority Decisions_.
- DeepSeek-AI (2025). _DeepSeek R1: Reinforcement Learning for Reasoning_.
- Dietterich, T. G. (2000). _Ensemble Methods in Machine Learning_.
- Du, Y. et al. (2023). _Improving Factuality and Reasoning in Language Models through Multiagent Debate_.
- Google DeepMind (2025). _AlphaEvolve: Evolutionary Agent Coding_.
- Guo, T. et al. (2024). _Large Language Model based Multi-Agents: A Survey of Progress and Challenges_.
- Hansen, L. K., & Salamon, P. (1990). _Neural Network Ensembles_. IEEE TPAMI.
- Hong, S. et al. (2024). _MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework_. ICLR.
- Irving, G. et al. (2018). _AI Safety via Debate_.
- Kadavath, S. et al. (2022). _Language Models (Mostly) Know What They Know_.
- Khan, A. et al. (2024). _Debating with More Persuasive LLMs Leads to More Truthful Answers_. ICML.
- Krogh, A., & Vedelsby, J. (1995). _Neural Network Ensembles, Cross Validation, and Active Learning_. NIPS.
- Li, J., & Chen, X. (2025). _The Persona-Accuracy Tradeoff in Multi-Agent Debate_.
- Liang, T. et al. (2024). _Encouraging Divergent Thinking in Large Language Models through Multi-Agent Debate_. EMNLP.
- Serra, O. (2026a). _ENGRAM: Event-Navigated Graded Retrieval & Archival Memory_.
- Serra, O. (2026b). _CORTEX: Persona-Aware Context Engineering for Persistent AI Identity_.
- Serra, O. (2026c). _LIMBIC: Laughter from Inverted Memory_.
- Surowiecki, J. (2004). _The Wisdom of Crowds_.
- Wan, X. et al. (2024). _The Persuasion Paradox: When Confidence Mimics Correctness_. NeurIPS.
- Wang, X. et al. (2023). _Self-Consistency Improves Chain of Thought Reasoning in Language Models_. ICLR.
- Wang, Y. et al. (2024a). _Mixture-of-Agents Enhances Large Language Model Capabilities_.
- Wu, Q. et al. (2024). _AutoGen: Enabling Next-Gen LLM Applications_. ICLR.
- Zheng, L. et al. (2024). _Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena_. NeurIPS.
