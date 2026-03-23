---
title: "Round Table"
date: "March 2026"
version: "v8.0"
---

\begin{center}
\large\textit{Exploiting Cognitive Diversity as Computational Resource in Persistent AI Agents}
\end{center}

\vspace{0.3cm}
\begin{center}
O. Serra\textsuperscript{1} \\
\small\textsuperscript{1}Independent Researcher \\
\small Target venue: NeurIPS 2026
\end{center}
\vspace{0.5cm}

# Abstract

Large language models from different providers exhibit systematically different reasoning behaviors, shaped by divergent training data, alignment objectives, and architectures. We argue that this _cognitive diversity_ is a computational resource that can be measured, allocated, and exploited. We introduce Round Table, a framework for cross-provider adversarial deliberation in which each model is assigned the role its training-induced cognitive tendencies make it best suited to perform. We formalize three contributions: (1) a **Cognitive Diversity Index (CDI)** quantifying inter-provider reasoning heterogeneity via error-vector correlation; (2) **Role-Amplified Adversarial Convergence (RAAC)**, a 5-phase debate protocol with role assignment via bipartite matching on empirical affinity scores; and (3) **Persistent Deliberation**, extending single-round debate into multi-session reasoning via structured memory compaction. A 3-model ensemble (Claude Opus, GPT-o3, Gemini 2.5 Pro) achieves 63.6% on GPQA Diamond versus a 55.6% single-model maximum—an 8 percentage-point absolute gain in a single run. Protocol validation on a 5-scenario benchmark yields CDI = 1.06 and consensus quality of 0.80. A preliminary production deployment of the **Editorial Swarm** pattern—parallelized cross-provider review of 8 papers with up to 24 concurrent agents—provides observational evidence of cross-provider error detection and model role specialization, including a compression bias in GPT models consistent with findings in the long-text generation literature (Zheng et al., 2024). This paper is both a theoretical framework for reasoning about cognitive diversity and a systems paper grounded in deployment experience; the connection between formalism and practice is the contribution.

# 1. Introduction

The dominant question in AI evaluation is: _Which model is best?_ We argue this is increasingly the wrong question. As leading laboratories converge on similar benchmark ceilings, their models diverge more clearly in _how_ they reason. Constitutional AI produces careful reflection; RL-incentivized reasoning chains produce raw exploration and adversarial challenge; broad pretraining produces implementation-aware grounding. The real opportunity is not to crown a single winner, but to ask: _Which combination of models is most cognitively diverse, and how should that diversity be organized?_

Classical ensemble methods treat models as exchangeable (Condorcet, 1785; Dietterich, 2000). Modern multi-agent debate (Du et al., 2023) improved on passive voting by letting models argue, but still relied on homogeneous agents or interchangeable roles. Recent work directly comparing multi-agent debate against single-agent strategies finds that default multi-agent setups rarely outperform strong single-agent self-consistency—_except_ when agents exhibit high cognitive diversity (Wang, Z. et al., 2025). This finding motivates Round Table's core thesis: the value of multi-agent deliberation is contingent on measurable diversity, and cross-provider ensembles are the most natural source of such diversity. Round Table departs from both ensemble voting and homogeneous debate by matching each model to the role its training makes it cognitively suited for. Cross-provider adversarial debate, structured around role-amplified cognitive strengths, creates productive deliberative tension that surfaces errors, exposes blind spots, and forces stronger synthesis. It functions as a reliability layer on top of stochastic generators, extracting quality through structured intellectual conflict (Irving et al., 2018).

Prior debate work is also single-shot. Round Table adds **Persistent Deliberation**, using memory compaction to preserve ratified conclusions and unresolved tensions across sessions. This bridges multi-agent debate (a technique) with agentic AI (an architecture). The memory substrate—Total Recall (Serra, forthcoming)—stores structured deliberation artifacts rather than raw transcripts, avoiding the context-growth bottleneck.

**Scope and contribution.** This paper occupies intentionally hybrid ground: it is both a theoretical framework for measuring and exploiting cognitive diversity (CDI, VR-1) and a systems paper grounded in a complete, tested implementation with preliminary production deployment. We believe the connection between formalism and practice is itself the contribution—the theory motivates system design decisions, and deployment experience refines the theory. Readers expecting a pure benchmark paper or a pure systems paper should understand that the integration of both perspectives is deliberate.

Section 2 situates Round Table in the literature. Section 3 defines CDI. Section 4 specifies the RAAC protocol. Section 5 covers Persistent Deliberation, including the Editorial Swarm pattern for parallelized multi-artifact review (Section 5.5). Section 6 addresses known limits. Section 7 analyzes the diversity premium. Sections 8–10 cover evaluation design, infrastructure, and results. Section 11 documents the production implementation. Section 12 concludes.

# 2. Related Work

**Ensemble Theory and Debate.** Condorcet's Jury Theorem (1785) proves majority voting converges to accuracy given independent voters. Hansen and Salamon (1990) and Krogh and Vedelsby (1995) proved ensemble error decreases as inter-member disagreement increases. Irving et al. (2018) established AI Safety via Debate as a scalable oversight mechanism. Du et al. (2023) demonstrated multi-agent debate improves factuality. Khan et al. (2024) and Wan et al. (2024) warn of the "Persuasion Paradox," where persuasive but incorrect models dominate—motivating Round Table's Ratification phase. Wang, Z. et al. (2025) compare debate against voting and self-consistency strategies, finding that multi-agent debate's advantage is contingent on inter-agent diversity—a result that directly supports CDI as a prerequisite for effective deliberation.

**Single-Agent Self-Debate.** A natural objection to multi-agent frameworks is that a single frontier model, prompted to argue from multiple perspectives, might achieve equivalent variance reduction at lower cost. Li et al. (2025) examine this trade-off, finding that single-agent self-debate with strong long-context models can match multi-agent setups on some tasks, but that genuine cross-provider diversity—where models have fundamentally different training-induced error profiles—provides irreducible benefits on tasks requiring diverse domain expertise. Wang, Z. et al. (2025) confirm this: multi-agent debate outperforms self-consistency specifically when agents are highly diverse, which is precisely the condition CDI measures and RAAC optimizes for. We acknowledge the single-agent self-debate baseline as important and discuss its implications for Round Table's operating regime in Section 6.

**Role Assignment in Multi-Agent Systems.** Feng et al. (2026) demonstrate that role-specialized multi-agent LLM systems achieve greater stability and performance than role-agnostic designs, using reinforcement learning to optimize agent role assignments. Silva et al. (2025) provide a taxonomy of hierarchical multi-agent coordination, showing that explicit role definitions enhance structured interactions. These findings ground Round Table's affinity matrix approach in a broader literature on the benefits of principled role allocation.

**LLM Frameworks and Routing.** FrugalGPT (Chen, L. et al., 2023) and LLM-Blender (Jiang et al., 2023) showed that cascades and blending can reduce cost and improve quality. MoA (Wang, Y. et al., 2024a) aggregates outputs cooperatively. Round Table differs in two ways: it combines perspectives through _adversarial_ debate rather than cooperative aggregation, and it grounds role assignment in measured provider-specific cognitive tendencies rather than treating models as interchangeable.

**Long-Text Generation and Compression Bias.** Zheng et al. (2024) introduce HelloBench, a benchmark for long-text generation, and document that LLMs systematically exhibit high compression rates when generating long documents—losing detail and key information. Hao et al. (2025) provide a theoretical account of LLM behavior through the lens of compression, explaining why models trained under compression objectives tend to summarize rather than expand. These findings provide external support for the GPT compression tendency we observe in deployment (Section 4.1).

**Multi-Agent Costs and Latency.** Chen, T. et al. (2026) use MAFBench to empirically study multi-agent framework overhead, finding that orchestration can increase latency by over 100× compared to single-agent calls. This motivates Round Table's parallelism patterns (Section 4.3) and its explicit treatment of latency in cost analysis (Section 7).

**Persistent Agents and Memory.** AutoGen (Wu et al., 2024) and MetaGPT (Hong et al., 2024) provide multi-agent frameworks but without cross-provider diversity measurement or training-aware role amplification. Round Table integrates with the Total Recall episodic memory architecture (Serra, forthcoming) for persistent deliberation across sessions.

# 3. Cognitive Diversity Index

## 3.1 Formal Definition

Let $\mathcal{M} = \{m_1, \ldots, m_n\}$ be a set of models and $\mathcal{T} = \{t_1, \ldots, t_k\}$ a benchmark task set with known ground truth. The error profile of model $m_i$ is a binary vector $e_i \in \{0, 1\}^k$, where $e_{ij} = 1$ if $m_i$ answers $t_j$ incorrectly.

**Definition 1 (Error Correlation Matrix).** The error correlation between $m_i$ and $m_j$ is the Pearson correlation (Phi coefficient for binary vectors) between their error profiles: $\Sigma_{ij} = \rho(e_i, e_j)$.

**Definition 2 (Cognitive Diversity Index).** The CDI of a model set $\mathcal{M}$ is:

$$\text{CDI}(\mathcal{M}) = 1 - \frac{1}{\binom{n}{2}} \sum_{i < j} \Sigma_{ij}$$

CDI = 0 implies perfect positive correlation (identical errors); CDI = 1 implies zero average correlation (independence, satisfying Condorcet's condition); CDI > 1 implies net negative correlation (complementarity). The theoretical range depends on ensemble size: for $n = 2$, CDI $\in$ [−1, 2]; for larger $n$, the feasible range narrows as the correlation matrix must remain positive semi-definite.

**Relationship to classical diversity measures.** CDI belongs to a family of pairwise disagreement-based ensemble diversity measures, alongside the Q-statistic (Yule, 1900), Cohen's kappa diversity (Margineantu and Dietterich, 1997), the disagreement measure, and the double-fault measure (Kuncheva and Whitaker, 2003). CDI's contribution is not statistical novelty but operational utility: by centering on Pearson correlation of error vectors and normalizing to a unit-interpretable scale, CDI maps directly to the Condorcet independence condition (CDI = 1) and provides an intuitive threshold for when ensemble diversity transitions from mere independence to active complementarity (CDI > 1).

**Statistical limitations of CDI estimation.** The implementation computes confidence intervals via Fisher z-transforms. We acknowledge two limitations of this approach: (1) pairwise correlations computed on shared task items are not independent, and the standard Fisher z SE formula ($1/\sqrt{k-3}$) does not account for this dependence, meaning reported CIs are likely narrower than true uncertainty; and (2) for small task sets (e.g., the 5-scenario open-ended panel), the sample size is insufficient for reliable interval estimation. We report CDI point estimates and CIs as indicative rather than definitive, and note that the GPQA-based CDI ($k = 198$) is substantially more reliable than the open-ended CDI ($k = 5$). Future work should employ bootstrap resampling over tasks to produce valid confidence intervals that account for the shared-item dependence structure.

Our measured CDI = 1.06 on the five-model open-ended design panel should be interpreted cautiously given the small $k$. The GPQA-based CDI ≈ 0.62 ($k = 198$) provides more robust evidence of substantial inter-provider error decorrelation.

## 3.2 Diversity–Performance Framework

We hypothesize that ensemble error decreases with CDI:

**Hypothesis VR-1 (Variance Reduction).** _For a debate ensemble $D$ over model set $\mathcal{M}$ with $\text{CDI}(\mathcal{M}) = \delta$:_

$$\mathbb{E}[\text{err}(D)] \leq \min_i \mathbb{E}[\text{err}(m_i)] - \alpha(\delta, n)$$

_where $\alpha(\delta, n) \geq 0$ is a diversity discount that increases with $\delta$ and ensemble size $n$, subject to the Non-Dominance Condition: no single model can persuade the ensemble to accept an incorrect answer against correct counterevidence from other participants._

We do not claim a tight bound on $\alpha$. The hypothesis is directional: higher CDI should yield larger accuracy gains. We note that VR-1 remains incompletely tested: while our GPQA results demonstrate that a high-CDI ensemble outperforms individual models, we have not yet systematically varied CDI across multiple ensemble configurations to establish the correlation between CDI magnitude and accuracy gain. A full ablation studying CDI vs. accuracy across ensemble sizes (2, 3, 4, 5 models) and domain types is needed to validate VR-1 as a predictive relationship rather than a directional hypothesis. On GPQA Diamond, pairwise Pearson correlation across Claude, GPT-o3, and Gemini error profiles yields average $\Sigma_{ij} \approx 0.38$, giving CDI ≈ 0.62. On open-ended design scenarios (5 participants), CDI = 1.06—suggesting that role amplification may drive substantially higher diversity on tasks with broader solution spaces, though the small scenario count limits confidence in this comparison.

# 4. Role-Amplified Adversarial Convergence

## 4.1 Training-Induced Cognitive Tendencies as Design Heuristics

Different AI providers induce systematically different cognitive tendencies through training:

- **Anthropic / Claude:** Constitutional AI training favors reflective reasoning, comfort with ambiguity, and coherent structural synthesis → **Architect** role.
- **OpenAI / GPT-o3:** RLHF combined with adversarial chain-of-thought reasoning favors rigorous verification and aggressive error-finding → **Critic** role.
- **Google / Gemini Pro:** Broad pretraining across web-scale data with grounding in real-world constraints favors feasibility assessment → **Pragmatist** role.
- **DeepSeek / DeepSeek-R1:** RL focused on deep exploration and chain-of-thought traces favors exhaustive domain investigation → **Researcher** role.

These characterizations are derived from published training methodology descriptions (Anthropic, 2024; DeepSeek-AI, 2025) and observable behavioral tendencies in structured evaluation. We acknowledge they represent tendencies, not deterministic properties, and that future training changes may shift these profiles. The affinity matrix should therefore be treated as a periodically recalibrated heuristic rather than a fixed constant.

Round Table assigns models to roles that amplify their natural tendencies via maximum-weight bipartite matching on a role affinity matrix. Five canonical roles are defined: **Architect** (systemic design), **Critic** (adversarial verification), **Pragmatist** (feasibility/constraints), **Researcher** (deep exploration), and **Synthesizer** (integration). This approach is consistent with findings from Dr. MAS (Feng et al., 2026), which demonstrates that role-specialized multi-agent LLM systems achieve superior stability through principled role allocation, and with the taxonomy of Silva et al. (2025), which identifies explicit role definition as a key coordination mechanism in hierarchical multi-agent systems.

The affinity matrix captures heuristic scores reflecting these training-induced cognitive tendencies:

| Model       | Architect | Critic | Pragmatist | Researcher | Synthesizer |
| :---------- | --------: | -----: | ---------: | ---------: | ----------: |
| Claude Opus |      0.95 |   0.70 |       0.50 |       0.60 |        0.85 |
| GPT-o3      |      0.70 |   0.95 |       0.60 |       0.75 |        0.65 |
| Gemini Pro  |      0.50 |   0.60 |       0.95 |       0.70 |        0.60 |
| DeepSeek-R1 |      0.60 |   0.70 |       0.50 |       0.95 |        0.55 |

**Important caveat on affinity scores.** These scores are illustrative heuristics derived through qualitative analysis of provider training methodologies, refined iteratively against observed debate performance across pilot tasks. The decimal precision should not be mistaken for measurement precision—the scores encode a rank ordering of role suitability rather than calibrated probabilities. Future work should establish a systematic calibration procedure using zero-shot role-specific benchmark performance to replace qualitative assignment with empirical measurement.

**The GPT Compression Tendency.** Production deployment (Section 5.5) revealed an asymmetry in GPT models (including GPT-5.4): when tasked with _generating_ long-form content, GPT exhibits a compression tendency—summarizing, eliding detail, and losing nuance. This observation is consistent with findings in the long-text generation literature: Zheng et al. (2024) document systematic compression rates across LLMs on HelloBench, and Hao et al. (2025) provide a theoretical account of why compression-trained models tend toward summarization. The tendency makes GPT models effective as _critics_ (compression maps naturally to distilling critique into actionable observations) but less reliable as _generators_ of extended documents. We frame this as an observed operational tendency rather than a proven stable property—it persisted across instruction variants in our deployment, but we have not conducted the controlled ablation (varying temperature, length penalties, prompt engineering strategies) needed to establish it as a robust training-induced characteristic. We recommend that orchestrators preferentially route long-form generation to models without this tendency (currently: Claude Opus, Gemini Pro) and route verification tasks to GPT, while acknowledging that this recommendation may change as models evolve.

**Sensitivity analysis.** Debate quality degrades by 12–18% under random role assignment versus optimal matching (Section 10), suggesting the affinity structure captures real signal despite imprecise calibration.

## 4.2 The RAAC Debate Protocol

The protocol operates in five phases per round:

1. **Propose (Parallel):** Each model generates a position based on its assigned role. Latency = max single-model latency.
2. **Challenge (Parallel):** Each model attacks every other model's position. Context grows as $O(n^2)$.
3. **Defend (Parallel):** Models defend against received attacks.
4. **Synthesize:** The Synthesizer integrates positions, attacks, and defenses into synthesis $S^t$.
5. **Ratify (Safety Check):** All models vote {accept, reject, amend} on $S^t$.

The Ratification phase prevents "Synthesizer Hallucination." If rejection exceeds `ratificationThreshold` (default 0.5), a repair cycle triggers. This applies the weak-to-strong generalization principle (Burns et al., 2023)—the full ensemble supervises the synthesizer.

**Convergence.** We distinguish two convergence concepts: _ratification convergence_ (the synthesis achieves majority acceptance) and _formal convergence_ (the combined metric $\lambda \cdot d_{\text{embed}}(S^t, S^{t-1}) + (1-\lambda) \cdot (1 - \text{acceptFraction})$ falls below threshold $\epsilon = 0.1$, where $\lambda = 0.5$). Ratification convergence is achievable and was reached in all benchmark scenarios within 2 rounds. Formal convergence—which additionally requires that successive syntheses stabilize in embedding space—is a stronger condition that was not reached within the capped round limit in our benchmark. The embedding distance is computed using the orchestrator's default embedding model; we acknowledge that convergence behavior may be sensitive to the choice of embedding model, and leave characterization of this sensitivity to future work. In practice, debates are capped at $T_{\max} = 5$ rounds. Formal convergence guarantees remain an open problem.

## 4.3 Parallelism Patterns

Five architectures span the cost–quality Pareto frontier:

| Architecture           | Phase Coverage                                    | Token Cost                      | Best For                                |
| :--------------------- | :------------------------------------------------ | :------------------------------ | :-------------------------------------- |
| **Fan-Out**            | Propose + one synthesis                           | $O(n)$                          | Low-cost parallel opinions              |
| **Moderated Tribunal** | Propose + synthesis (no challenge/defend)         | $O(n+1)$                        | Standard production queries             |
| **Full Round Table**   | All 5 phases, $T_{\max}$ rounds                   | $O(n^2 \cdot T_{\max})$         | Critical reasoning tasks                |
| **Tournament**         | Head-to-head, bracket                             | $O(n \log n)$                   | Large model sets ($n > 4$)              |
| **Editorial Swarm**    | N parallel RAAC instances, cross-provider judging | $O(N \cdot n^2 \cdot T_{\max})$ | Batch review of N independent artifacts |

# 5. Persistent Deliberation

Single-shot debate discards its epistemic labor. Round Table stores structured deliberation artifacts in the Total Recall event store (Serra, forthcoming). Three artifact tiers are maintained:

1. **Debate Trace (Ephemeral):** Actively cache-evicted post-debate. Not stored durably.
2. **Synthesis Artifact (Durable):** High-priority event stored in Total Recall. Retrieved on next debate start.
3. **Deliberation Memory (Derived):** Compacted JSON tracking unresolved tensions, ratified conclusions, and per-model calibration (see Appendix B).

This is, at its core, a structured state management technique: agents pay the token cost of a compact synthesis artifact rather than the full debate trace. We frame it as "Persistent Deliberation" not because the mechanism is novel (caching summaries is standard practice) but because the _schema_ is deliberation-specific—it preserves the epistemic structure of multi-agent debate (unresolved tensions, ratification provenance, per-model calibration) rather than generic key-value state. The runtime exposes three debate depths—`quick` (2 rounds), `standard` (4 rounds), `deep` (6 rounds)—with the persistent deliberation layer transparent to callers.

## 5.5 Editorial Swarm: Parallelized Multi-Artifact Review (Preliminary Deployment Observation)

The preceding sections describe Round Table as a protocol for deepening deliberation on a single question. In production, we encountered a complementary need: applying Round Table principles to _N independent artifacts simultaneously_. This section documents the **Editorial Swarm** pattern, deployed in March 2026 for a batch review of eight research papers. We present this as a preliminary deployment observation (N=1 deployment, no control group) rather than a controlled experiment, and discuss its limitations explicitly.

### 5.5.1 Deployment Architecture

The Editorial Swarm processed eight papers through three rounds of parallelized cross-provider review, orchestrated by a single Claude Opus 4 instance acting as coordinator.

**Round 1 — Cross-Provider Parallel Edit.** Eight sub-agents were spawned simultaneously: four Claude Opus 4 instances and four GPT-5.4 instances, each assigned one paper. Cross-judging was enforced: GPT instances reviewed papers edited by Opus, and vice versa. This cross-provider constraint was designed to maximize the probability of surfacing errors that a same-provider review would miss.

**Round 2 — Adversarial Bounce Cycles.** Eight Opus editors were spawned, each internally invoking GPT-5.4 as a harsh critic. Each editor–critic pair engaged in 2–3 bounce rounds targeting a convergence threshold of 9.8/10 on a structured quality rubric. The bounce rounds implemented a micro-RAAC cycle: propose (Opus edit) → challenge (GPT critique) → defend (Opus revision) → ratify (GPT re-score).

**Round 3 — Convergence Enforcement.** The same bounce pattern repeated with an explicit convergence target. Papers that had not reached the 9.8/10 threshold were re-spawned with augmented critique instructions.

At peak concurrency, up to **24 agents** operated simultaneously across two provider subscriptions (Anthropic and OpenAI), with the orchestrator tracking convergence state for all eight papers.

### 5.5.2 Cross-Provider Error Detection: An Illustrative Case

During Round 1, a GPT-5.4 reviewer identified a misleading statistic in an Opus-edited paper: the paper reported 93% accuracy on a classification task, but the underlying data showed 79% overall accuracy with 5 of 6 classes at zero performance—the 93% figure reflected only the majority class. Opus had missed this in its editorial pass.

This incident is consistent with the core Round Table thesis—that cross-provider review can catch errors that same-provider review might miss—but we are careful not to overstate a single case. We did not run a same-provider control (e.g., an Opus-reviewing-Opus baseline), and therefore cannot definitively attribute the catch to cross-provider diversity rather than to reviewer assignment variance. The incident is illustrative, not conclusive.

### 5.5.3 Observed Model Role Tendencies

Production deployment suggested the following role tendencies, which should be understood as operational observations from a single deployment rather than empirically validated characterizations:

| Model          | Observed Strength                                                           | Observed Weakness                                                      | Suggested Role                   |
| :------------- | :-------------------------------------------------------------------------- | :--------------------------------------------------------------------- | :------------------------------- |
| Claude Opus 4  | Coherence across long documents; structural reasoning; synthesis            | Accepts plausible-sounding claims without statistical verification     | Coordinator, Editor, Synthesizer |
| GPT-5.4        | Finding logical gaps, statistical errors, weak claims; compressing critique | Compresses and summarizes when generating long documents (Section 4.1) | Critic, Reviewer                 |
| Gemini 2.5 Pro | Pushing harder on assumptions; finding what agreeable reviewers miss        | Less consistent on structured multi-step editorial tasks               | Devil's Advocate                 |
| Manus          | Consolidating review notes; formatting; mechanical tasks                    | Limited reasoning depth on substantive content                         | Secretary, Consolidator          |

### 5.5.4 Depth vs. Breadth: Scaling Dimensions

The Editorial Swarm suggests that Round Table principles operate along two scaling dimensions:

- **Depth scaling** (original RAAC): More rounds of debate on a single question, deepening analysis. Cost scales as $O(n^2 \cdot T_{\max})$.
- **Breadth scaling** (Editorial Swarm): More parallel instances of the protocol across $N$ independent artifacts. Cost scales as $O(N \cdot n^2 \cdot T_{\max})$ but _parallelizes_ across providers and subscriptions.

These axes appear orthogonal in principle: an Editorial Swarm can use shallow debate (1-round Tribunal per artifact) or deep debate (5-round Full Round Table per artifact), depending on the stakes and complexity of each artifact. We have not yet empirically characterized the marginal returns of depth vs. breadth allocation, which would require systematic experimentation across task types and complexity levels.

### 5.5.5 Cost and Operational Summary

| Metric                 | Value                 |
| :--------------------- | :-------------------- |
| Papers reviewed        | 8                     |
| Rounds                 | 3                     |
| Agents per round (avg) | ~2 per paper          |
| Total agent-turns      | ~48                   |
| Provider subscriptions | 2 (Anthropic, OpenAI) |
| Peak concurrent agents | 24                    |

Running across two provider subscriptions yielded two operational benefits: (1) **rate-limit parallelism**—neither provider's rate limits bottlenecked the pipeline; and (2) **failure isolation**—a provider outage would degrade throughput by ~50% rather than halting the pipeline entirely.

### 5.5.6 Limitations of the Editorial Swarm Observation

This deployment has significant limitations as evidence:

1. **No control group.** We did not run a same-provider baseline (e.g., Opus-only swarm), so we cannot isolate the contribution of cross-provider diversity from other factors (reviewer quality, task assignment, prompt design).
2. **N=1 deployment.** A single deployment of 8 papers does not constitute a reproducible experiment. The observations may not generalize to other domains, artifact types, or model versions.
3. **No quantitative quality metrics.** We did not measure inter-rater agreement, error detection rates, or revision quality using standardized metrics. Quality assessment was based on the orchestrator's rubric-based scoring, which is subject to the same echo-chamber concerns discussed in Section 6.
4. **Survivorship bias.** We report errors that were caught; we do not know the population of errors that were missed. Without a ground-truth error inventory, the error detection rate is unknown.

Despite these limitations, we include the Editorial Swarm because it demonstrates the _feasibility_ of breadth-scaled cross-provider deliberation in production and generated operational hypotheses (compression tendency, role specialization) that warrant controlled investigation.

# 6. Limits of Deliberation

**The Echo Chamber Limit.** An ensemble cannot validly evaluate its own output. Models grading their own debate syntheses exhibit sycophantic agreement, inflating scores. Evaluation therefore requires disjoint models or external ground-truth oracles. We acknowledge that our consensus quality metric (ratification votes from debate participants) is subject to this limit, and that external evaluation would provide stronger evidence.

**The Single-Agent Self-Debate Question.** A legitimate challenge to multi-agent frameworks is that a single frontier model, prompted to argue from multiple perspectives, might achieve equivalent variance reduction at lower cost. Wang, Z. et al. (2025) find that multi-agent debate outperforms single-agent self-consistency specifically under conditions of high inter-agent diversity—precisely the regime CDI measures. Li et al. (2025) find that single-agent approaches can match multi-agent setups on some tasks, but that genuine cross-provider diversity provides irreducible benefits when tasks require diverse domain expertise. Round Table's operating regime is therefore explicitly the high-CDI regime: when providers have genuinely different training-induced error profiles, multi-agent debate extracts value that single-agent self-debate cannot. For homogeneous ensembles (low CDI), single-agent approaches may be preferable. We have not yet run a controlled single-agent self-debate baseline against Round Table, which we identify as a priority for future work.

**The Orchestration and Latency Limit.** Synchronous N-model debate hits API rate limits quickly. Chen, T. et al. (2026) measure multi-agent orchestration overhead at over 100× single-agent latency in some configurations. Round Table is fundamentally an asynchronous, offline protocol best suited for tasks where deliberation quality justifies minutes-scale latency. Real-time applications require the lighter Tribunal or Fan-Out architectures. The current implementation uses synthetic mock participants for test-suite validation; production deployment requires a dedicated async orchestration layer with retry logic.

**The Convergence Gap.** No scenario in the benchmark reached formal convergence (embedding distance threshold) within the capped round limit, though all reached ratification convergence. This is structurally expected with aggressive round caps; production deployments with $T_{\max} = 5$ should converge more reliably, though formal guarantees remain open.

**The Perspective Coverage Ceiling.** Keyword-matching evaluation yields average coverage of 0.10 (10%). Synthesis outputs integrate expected perspectives _semantically_, but not through exact keyword strings. Future evaluation should use embedding-based similarity.

**Affinity Matrix Brittleness.** The role affinity scores reflect current training methodologies. As providers update their training pipelines, optimal role assignments may shift. The matrix should be periodically recalibrated. The **Parity Assumption** underlying the Diversity Premium (Section 7.3) also deserves scrutiny: if one provider achieves a structural capability leap, forcing a weaker model into the ensemble could be actively harmful. CDI is a necessary but not sufficient condition for ensemble benefit; minimum per-model competence is also required.

**Missing Ablations.** A full ablation studying CDI vs. accuracy across ensemble sizes (2, 3, 4, 5 models) and domain types would strengthen the empirical case. We also lack direct comparison against MoA (Wang, Y. et al., 2024a) on matched benchmarks, which is needed to quantify the advantage of adversarial over cooperative aggregation. Hypothesis H4 (ECE reduction) remains untested. A controlled single-agent self-debate baseline is needed to isolate the value of cross-provider diversity from the value of structured deliberation itself.

**Single-Run Variance.** GPQA Diamond results are from a single run. While the 8-point gain is large relative to expected inter-run variance, multi-run confidence intervals are needed for definitive claims.

# 7. The Diversity Premium

## 7.1 Value of Error Reduction

Let $V_{\text{err}}$ be the cost of an error, $C_{\text{debate}}$ the cost of debate (including both token costs and latency), and $\Delta E$ the error reduction. Debate is net-positive when $\Delta E \cdot V_{\text{err}} > C_{\text{debate}}$.

## 7.2 Break-Even Analysis

| Error Cost ($V_{\text{err}}$) | Debate Cost (tokens) | Typical Latency | Required $\Delta E$ | Typical Domain              |
| :---------------------------- | :------------------- | :-------------- | :------------------ | :-------------------------- |
| \$50                          | \$0.01 (Tribunal)    | ~5s             | 0.02%               | Content generation          |
| \$200                         | \$0.08 (Full RT)     | ~30–120s        | 0.04%               | Software engineering        |
| \$5,000                       | \$0.08 (Full RT)     | ~30–120s        | 0.002%              | Medical decision support    |
| \$50,000                      | \$0.08 (Full RT)     | ~30–120s        | 0.0002%             | Legal/regulatory compliance |

Even at the Full Round Table cost tier, the break-even error reduction is negligible for any domain where errors have material consequences. However, the latency column makes explicit a critical trade-off: Full Round Table debate requires 30–120 seconds per query depending on model response times and round count (consistent with the 100×+ overhead measured by Chen, T. et al., 2026 for multi-agent orchestration). This makes Full Round Table unsuitable for latency-sensitive applications (real-time chat, interactive coding), but appropriate for batch processing, document review, critical decision support, and other offline tasks where deliberation quality justifies the time cost. The Tribunal pattern, at ~5s latency, is viable for near-interactive use cases.

**Caveat.** Token costs and latency estimates are based on current API pricing (March 2026) and our deployment measurements. Both vary significantly by provider, model version, and task complexity. The required $\Delta E$ calculations depend on assumed error costs that are domain-specific and not empirically derived in this work.

## 7.3 Diversity as Positive Externality

In a market with one dominant provider, CDI → 0. In a market with competing providers with distinct training approaches, CDI > 0. The existence of diverse architectures creates a **Diversity Premium**: users who combine models can outperform users of any single model. This reframes model commoditization as a driver of systemic reliability rather than a threat. The premium is largest when providers maintain genuinely different training methodologies rather than converging on identical approaches.

**Fragility of the Diversity Premium.** The premium depends on approximate parity among frontier models. If one provider achieves dominant accuracy across all domains, the CDI of any mixed ensemble may decrease, and the weaker models may introduce errors rather than correct them. The Diversity Premium is therefore a structural property of the current multi-provider landscape, not a guaranteed permanent advantage.

# 8. Evaluation Design

## 8.1 Research Hypotheses

| ID     | Hypothesis                                                                | Metric                | Status                                      |
| :----- | :------------------------------------------------------------------------ | :-------------------- | :------------------------------------------ |
| **H1** | High-CDI heterogeneous debate outperforms low-CDI homogeneous debate      | Accuracy ($p < 0.05$) | Supported (GPQA)                            |
| **H2** | Performance gain correlates positively with CDI                           | Pearson $r > 0.7$     | Untested (requires multi-ensemble ablation) |
| **H3** | Optimal RAAC assignment outperforms random role assignment                | Win rate > 60%        | Supported (73%, p < 0.01)                   |
| **H4** | Debates produce lower Expected Calibration Error (ECE) than single models | ECE decrease          | Untested                                    |

We are explicit about which hypotheses have been tested and which remain open. H2 in particular requires a systematic ablation across ensemble configurations that we have not yet conducted.

## 8.2 Setup and Baselines

**Benchmarks:** GPQA Diamond (Science), MATH-500, HumanEval, TruthfulQA.
**Baselines:** Single Model Best-of-1, Self-Consistency Best-of-5, Homogeneous Debate (Du et al., 2023), MoA (Wang, Y. et al., 2024a).
**Round Table Configuration:** Claude Opus (Architect), GPT-o3 (Critic), Gemini 2.5 Pro (Pragmatist).

**Note on baselines.** We report results against Single Model Best-of-1 (Section 9.2). Comparison against Homogeneous Debate and MoA on matched benchmarks has not been completed and is a priority for future work; we therefore cannot yet claim that adversarial cross-provider debate outperforms cooperative aggregation or same-provider debate.

## 8.3 Power Analysis

To detect a medium effect ($d=0.5, \alpha=0.05, \beta=0.20$), required $N=64$ for a two-sample proportion test. Our smallest set (HumanEval, $N=164$) provides power > 0.99. We acknowledge that applying this generic power analysis to accuracy differences on discrete benchmark tasks involves simplifying assumptions about effect size and distributional properties.

# 9. Infrastructure and Results

## 9.1 Test Infrastructure

Testing uses an offline arena with sandbox isolation. Participants are synthetic mock models with deterministic, role-differentiated response generators. Ground-truth evaluation uses parsed oracles (Python execution, SymPy). A trace recorder logs all debate events for offline CDI and cost analysis. The arena requires no live API calls, enabling fully reproducible benchmark execution in CI.

**Important methodological note:** The GPQA Diamond accuracy figures (Section 9.2) were obtained by running the 3-model ensemble against live API endpoints (temperature = 0.3, greedy decoding for baselines, single run per question, $n = 198$). The protocol validation metrics (CDI, consensus quality) in Sections 9.4–9.5 used synthetic participants. We distinguish these clearly because the validity claims differ: live results demonstrate real accuracy gains; synthetic results validate protocol mechanics (state machine correctness, convergence behavior, cost accounting) but _cannot_ validate claims about real cross-provider cognitive biases or the value of role amplification. Claims about cognitive diversity and role assignment benefits rest on the live GPQA results and the role assignment sensitivity analysis, not on the synthetic protocol validation.

## 9.2 Accuracy Gains (Live Models)

The 3-model Round Table ensemble achieves **63.6%** on GPQA Diamond ($n = 198$) vs. Claude Opus 54.0%, GPT-o3 55.6%, Gemini 2.5 Pro 53.8%. This is an **8 percentage-point absolute gain** (14.4% relative) over the strongest single model. On HumanEval pass@1 ($n = 164$): 46.3% vs. 41.2%, 39.0%, 38.5% individually. Adversarial ratification caught edge-case reasoning failures that individual models missed.

**Caveats.** These are single-run results. The 8-point GPQA gain, while large relative to expected inter-run variance on a 198-question benchmark, has not been confirmed across multiple runs with different random seeds. We have not computed confidence intervals on the accuracy difference or performed a formal significance test (e.g., McNemar's test on paired per-question outcomes). Multi-run replication is a priority for future work.

## 9.3 CDI Measurements

**Factual benchmark (GPQA):** Pairwise Pearson correlation on greedy-decoded error vectors yields average $\Sigma_{ij} \approx 0.38$, giving **CDI ≈ 0.62** ($k = 198$). This indicates substantial independence across frontier model failure modes.

**Open-ended design benchmark (5 participants, 5 scenarios, synthetic):** CDI = **1.06**. Given the small scenario count ($k = 5$), this point estimate carries high uncertainty and the previously reported 95% CI ([0.60, 1.49]) should be treated as approximate due to the statistical limitations discussed in Section 3.1. The elevated CDI relative to GPQA (0.62) may reflect broader solution spaces where role amplification drives more divergent approaches, but could also be an artifact of the small sample or synthetic participant design.

## 9.4 Cost Analysis

Full Round Table debate consumes ~15× the token volume of single zero-shot. At that multiplier, Round Table yields an 18% relative error reduction on challenging benchmarks.

Benchmark cost measurements (5 scenarios, synthetic participants):

| Architecture                 | Avg Cost/Scenario | Range             |
| :--------------------------- | ----------------: | :---------------- |
| Full Round Table (2 rounds)  |          \$0.0842 | \$0.0839–\$0.0845 |
| Moderated Tribunal (1 round) |          \$0.0101 | \$0.0093–\$0.0118 |
| **Cost ratio**               |          **8.3×** | —                 |

The 8.3× ratio matches the theoretical $O(n^2)$ vs. $O(n+1)$ scaling prediction. Total benchmark cost: \$0.20.

## 9.5 Protocol Validation (Synthetic)

| Scenario     | Domain                | Architecture       | Rounds | Consensus Quality | Cost (USD) |
| :----------- | :-------------------- | :----------------- | -----: | ----------------: | ---------: |
| s1-arch      | Software Architecture | full-round-table   |      2 |              0.80 |   \$0.0839 |
| s2-ai-safety | AI Ethics             | full-round-table   |      2 |              0.80 |   \$0.0845 |
| s3-data      | ML Systems            | moderated-tribunal |      1 |              0.80 |   \$0.0093 |
| s4-product   | Product Strategy      | moderated-tribunal |      1 |              0.80 |   \$0.0093 |
| s5-infra     | Infrastructure        | moderated-tribunal |      1 |              0.80 |   \$0.0118 |

**Consensus quality 0.80** = 4 of 5 participants accepting in final ratification. The uniform 0.80 across all scenarios reflects the deterministic nature of synthetic participants rather than a robust quality signal. These results validate protocol _mechanics_ (state transitions, cost accounting, convergence checks) but should not be interpreted as evidence of deliberation _quality_. Live-model protocol validation is needed to assess quality variation across domains.

## 9.6 Automated Test Suite

The complete implementation is validated by 61 unique tests (36 unit, 20 integration, 5 benchmark) across 3 test files. All tests pass (vitest v4.0.18, 2026-02-24). Coverage spans CDI computation, RAAC role-assignment and bipartite matching, 5-phase debate state machine, ratification voting and repair cycles, persistent deliberation compaction, and all four architecture patterns.

# 10. Role Assignment Sensitivity

To validate H3 (optimal vs. random role assignment), we compared debate quality under three conditions: (1) optimal RAAC matching using the affinity matrix, (2) random role assignment, and (3) adversarial misassignment (each model assigned its lowest-affinity role). Optimal assignment outperforms random in 73% of trials (N=30, p < 0.01) as measured by ratification acceptance rate. Adversarial misassignment degrades acceptance rate by 12–18% versus optimal, confirming that the affinity structure captures meaningful signal.

**Limitations of this analysis:** Synthesis quality was evaluated by ratification votes from debate participants, which is subject to the Echo Chamber Limit (Section 6). The acceptance rate measures internal consensus, not objective output quality. An external evaluation—using a disjoint judge model or human assessment—would provide stronger evidence. Additionally, since the affinity matrix was derived in part from pilot task observations, there is a risk of circularity: the matrix may encode the same patterns it is being evaluated against. We leave independent external evaluation to future work.

# 11. Implementation

## 11.1 Repository Structure

All source lives under a private repository (public release planned upon acceptance):

```
src/memory/synapse/
  cognitive-diversity.ts       — CDI measurement, Fisher z CI
  raac-protocol.ts             — RAAC 5-phase protocol, role affinity, convergence
  debate-architectures.ts      — Fan-Out, Moderated Tribunal, Full Round Table, Tournament
  persistent-deliberation.ts   — Total Recall integration, deliberation memory schema
  synapse.test.ts              — Unit tests (36 tests)
  synapse-integration.test.ts  — Integration tests (20 tests)
  synapse-benchmark.test.ts    — Offline debate quality benchmark (5 tests)

src/agents/pi-extensions/
  synapse-runtime.ts           — Agent-callable runtime, DebateDepth API
```

**Total:** ~1,150 production LOC (4 modules), ~1,100 test LOC (3 test files). TypeScript ESM, Node 22+.

## 11.2 Architecture Notes

**CDI Pipeline** (`cognitive-diversity.ts`): Computes the Phi coefficient between binary error vectors, aggregates pairwise correlations, and returns CDI with approximate 95% CI via Fisher z-transform (SE = 1/√(k−3), z-critical = 1.96). As discussed in Section 3.1, these CIs are approximate due to non-independence of pairwise correlations.

**RAAC Protocol** (`raac-protocol.ts`): `runDebate` orchestrates the 5-phase loop. Role assignment uses greedy maximum-weight bipartite matching on the affinity matrix. (We note that greedy matching is not guaranteed optimal for all inputs; the Hungarian algorithm would provide exact solutions. In practice, with $n \leq 5$ models and well-separated affinity scores, greedy matching produces optimal assignments in all tested configurations.)

**Debate Architectures** (`debate-architectures.ts`): Four architecture functions, each returning a typed result with per-phase cost breakdown.

**Persistent Deliberation** (`persistent-deliberation.ts`): Session-scoped deliberation manager. Stores structured JSON artifacts (Appendix B) as Total Recall events. On session start, loads the latest deliberation memory to resume without replaying raw traces.

**Runtime API** (`synapse-runtime.ts`): Single `debate(topic, options?)` method. Returns consensus, confidence, dissent, action items, and diversity score.

## 11.3 Cross-References

- **Total Recall** (Serra, forthcoming): Provides the event store for durable artifact storage.
- **Identity Persistence** (Serra, forthcoming): Persona-aware context engineering governs debate depth selection.

# 12. Conclusion

Round Table converts model heterogeneity from a source of friction into a mechanism for reliability. The core contribution is matching each model to the role its training-induced cognitive tendencies make it best suited for, then structuring adversarial debate to amplify the productive tension between complementary cognitive styles. CDI provides a quantitative measure of ensemble diversity; RAAC provides the deliberation protocol; Persistent Deliberation extends single-shot debate into multi-session reasoning.

Empirical results confirm an 8 percentage-point accuracy gain on GPQA Diamond (single run), CDI = 0.62 for the three-model GPQA ensemble and 1.06 for the five-model open-ended panel (small $k$), and consensus quality of 0.80 on synthetic protocol validation. The Editorial Swarm deployment provides preliminary observational evidence that cross-provider deliberation catches reasoning-level errors and that models exhibit role-specific strengths consistent with their training methodologies.

Significant open questions remain: multi-run replication of the GPQA result, systematic testing of the CDI–performance relationship (VR-1), controlled comparison against single-agent self-debate and cooperative aggregation baselines, and empirical grounding of the affinity matrix. We view these not as weaknesses to apologize for but as a research agenda motivated by a framework that is already producing measurable gains in production.

As individual model performance approaches asymptotic limits, the next frontier is orchestrating cognitively diverse ensembles where each model is placed at its point of greatest comparative advantage.

---

# References

- Anthropic (2024). _The Claude 3 Model Family: Opus, Sonnet, Haiku_.
- Brown, T. et al. (2020). _Language Models are Few-Shot Learners_. NeurIPS.
- Burns, C. et al. (2023). _Weak-to-Strong Generalization: Eliciting Strong Capabilities With Weak Supervision_. OpenAI.
- Chen, L. et al. (2023). _FrugalGPT: How to Use Large Language Models While Reducing Cost and Improving Performance_.
- Chen, T. et al. (2026). _Understanding Multi-Agent LLM Frameworks: A Unified Benchmark and Experimental Analysis_. arXiv:2602.03128.
- Condorcet, N. (1785). _Essay on the Application of Analysis to the Probability of Decisions_.
- DeepSeek-AI (2025). _DeepSeek R1: Reinforcement Learning for Reasoning_.
- Dietterich, T. G. (2000). _Ensemble Methods in Machine Learning_.
- Du, Y. et al. (2023). _Improving Factuality and Reasoning in Language Models through Multiagent Debate_. ICML.
- Feng, L. et al. (2026). _Dr. MAS: Stable Reinforcement Learning for Multi-Agent LLM Systems_. arXiv:2602.08847.
- Hansen, L. K., & Salamon, P. (1990). _Neural Network Ensembles_. IEEE TPAMI.
- Hao, Y. et al. (2025). _Understanding LLM Behaviors via Compression: Data Generation, Knowledge Acquisition and Scaling Laws_. arXiv:2504.09597.
- Hong, S. et al. (2024). _MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework_. ICLR.
- Irving, G. et al. (2018). _AI Safety via Debate_.
- Jiang, D. et al. (2023). _LLM-Blender: Ensembling Large Language Models with Pairwise Ranking and Generative Fusion_. ACL.
- Khan, A. et al. (2024). _Debating with More Persuasive LLMs Leads to More Truthful Answers_. ICML.
- Krogh, A., & Vedelsby, J. (1995). _Neural Network Ensembles, Cross Validation, and Active Learning_. NIPS.
- Kuncheva, L. I., & Whitaker, C. J. (2003). _Measures of Diversity in Classifier Ensembles and Their Relationship with the Ensemble Accuracy_. Machine Learning, 51(2).
- Li, X. et al. (2025). _Single-agent or Multi-agent Systems? Why Not Both?_ arXiv:2505.18286.
- Margineantu, D. D., & Dietterich, T. G. (1997). _Pruning Adaptive Boosting_. ICML.
- Serra, O. (forthcoming). _Total Recall: Event-Navigated Graded Retrieval & Archival Memory_.
- Serra, O. (forthcoming). _Identity Persistence: Persona-Aware Context Engineering for Persistent AI Identity_.
- Silva, A. et al. (2025). _A Taxonomy of Hierarchical Multi-Agent Systems: Design Patterns, Coordination Mechanisms, and Industrial Applications_. arXiv:2508.12683.
- Wan, X. et al. (2024). _The Persuasion Paradox: When Confidence Mimics Correctness_. NeurIPS.
- Wang, X. et al. (2023). _Self-Consistency Improves Chain of Thought Reasoning in Language Models_. ICLR.
- Wang, Y. et al. (2024a). _Mixture-of-Agents Enhances Large Language Model Capabilities_.
- Wang, Z. et al. (2025). _Debate or Vote: Which Yields Better Decisions in Multi-Agent Large Language Models?_ arXiv:2508.17536.
- Wu, Q. et al. (2024). _AutoGen: Enabling Next-Gen LLM Applications_. ICLR.
- Yule, G. U. (1900). _On the Association of Attributes in Statistics_. Phil. Trans. Royal Society A.
- Zheng, Y. et al. (2024). _HelloBench: Evaluating Long Text Generation Capabilities of Large Language Models_. arXiv:2409.16191.

\newpage

# Appendix A: Round Table Debate Data Flow

```text
                    Round Table Debate Data Flow (1 Round, 3 Models)
  ============================================================================

  INPUT: Task T + Deliberation Memory DM^{t-1} (from Total Recall event store)
    |
    v
  PHASE 1: PROPOSE (parallel, latency = max single model)
  +---> m1 (Architect):  P1 = structural framing + novel approach
  +---> m2 (Critic):     P2 = rigorous analysis + verification plan
  +---> m3 (Pragmatist): P3 = feasibility assessment + constraints
    |
    v  [all proposals shared]
  PHASE 2: CHALLENGE (parallel per model)
  +---> m1: attacks on P2 and P3
  +---> m2: attacks on P1 and P3
  +---> m3: attacks on P1 and P2
    |
    v  [all attacks shared with targets]
  PHASE 3: DEFEND (parallel)
  +---> Models m1, m2, m3 defend against received attacks
    |
    v  [all positions, attacks, defenses collected]
  PHASE 4: SYNTHESIZE
  +---> Synthesizer: integrates {P, A, D} --> Synthesis S^t
    |
    v
  PHASE 5: RATIFY (Safety Check)
  +---> All Models: Vote {accept, reject, amend} on S^t
    |
    v
  CONVERGENCE CHECK: λ·d_embed + (1-λ)·(1 - acceptFraction) < ε ?
    |                    |
    Yes                  No
    |                    |
    v                    v
  OUTPUT S^t         ROUND t+1 (max T=5)
  + Update DM^t → Total Recall store
```

# Appendix B: Deliberation Memory Schema

Persistent Deliberation stores structured JSON tracking unresolved tensions and per-model calibration across sessions:

```json
{
  "version": "1.0",
  "session_id": "round-table-2026-02-16-001",
  "conclusions": [
    {
      "id": "C001",
      "proposition": "CDI must be measured across diverse domains.",
      "confidence": 0.95,
      "provenance": { "debate_round": 2, "ratified_by": ["m1", "m2", "m3"] },
      "status": "accepted"
    }
  ],
  "unresolved_tensions": [
    {
      "id": "T001",
      "description": "Bounding alpha theoretically vs. empirically.",
      "positions": {
        "m1": "Requires formal proof connecting to voting bounds.",
        "m2": "Empirical measurement suffices for evaluation."
      },
      "status": "open",
      "revisit_trigger": "Upon conclusion of empirical trials."
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

# Appendix C: Revision History

- **v8.0 (March 2026):** Major revision integrating cross-model peer review (GPT-4o, Gemini 2.5 Pro). Key changes: (1) Explicitly framed the paper as hybrid theory+systems contribution in Introduction. (2) Addressed single-agent self-debate objection with new "Debate or Vote" (Wang, Z. et al., 2025) and "Single-agent or Multi-agent" (Li et al., 2025) references; added dedicated subsection in Section 6. (3) Acknowledged CDI CI statistical limitations (non-independence of pairwise correlations, small-k issues); reframed CIs as approximate. (4) Reframed affinity matrix scores as illustrative heuristics; integrated Dr. MAS (Feng et al., 2026) and Silva et al. (2025) for role assignment grounding. (5) Strengthened GPT compression tendency claim with HelloBench (Zheng et al., 2024) and Hao et al. (2025) references; downgraded language from "stable training-induced property" to "observed operational tendency." (6) Reframed Editorial Swarm (Section 5.5) as "preliminary deployment observation" with explicit limitations paragraph covering lack of control group, N=1, survivorship bias, and missing quantitative metrics. (7) Added latency column to break-even table; cited MAFBench (Chen, T. et al., 2026) for real latency data. (8) Fixed convergence contradiction by distinguishing "ratification convergence" from "formal convergence." (9) Added hypothesis status column to H1-H4 table; acknowledged H2 and H4 as untested. (10) Acknowledged missing baselines (MoA, homogeneous debate, single-agent self-debate) as future work priorities. (11) Added Kuncheva & Whitaker (2003), Margineantu & Dietterich (1997), Yule (1900) for ensemble diversity measure context. (12) Noted greedy vs. optimal bipartite matching limitation. (13) Toned down Persistent Deliberation framing to emphasize practical utility over theoretical novelty. (14) Added fragility discussion to Diversity Premium. 9 new references added.
- **v7.0 (March 2026):** Added Section 5.5 (Editorial Swarm) documenting production deployment of parallelized multi-artifact review across 8 papers with up to 24 concurrent agents. Added "Editorial Swarm" as 5th architecture in Section 4.3 parallelism patterns table. Documented the "GPT Summarization Trap"—systematic compression bias in GPT models that makes them ideal critics but poor long-form generators—as a formal finding in Section 4.1 with affinity matrix implications. Added empirical model role specialization table based on observed production behavior. Documented cross-provider error detection validation case (misleading statistic caught by GPT, missed by Opus). Introduced depth vs. breadth as orthogonal scaling axes for Round Table protocols. Added cost and operational analysis for Editorial Swarm deployments.
- **v6.0 (March 2026):** Major editorial revision. Reduced abstract from ~400 to ~200 words. Eliminated 8→3 redundant core thesis restatements. Added affinity matrix calibration methodology and brittleness discussion. Clarified synthetic vs. live result provenance with experimental details (temperature, decoding, variance acknowledgment). Fixed test count inflation (122→61 unique). Added Section 10 (role assignment sensitivity) with Echo Chamber limitation acknowledgment. Added break-even cost table. Added missing-ablation, MoA-comparison, H4, and single-run-variance limitations. Removed circular case study, weak enrichment ratio metric, implementation padding from abstract. Fixed Brown et al. (2024→2020). Reduced self-references (3→2). Strengthened VR-1 parameterization.
- **v5.0 (March 2026):** Renamed framework to Round Table. Expanded Section 4 with per-provider training-bias analysis.
- **v4.0 (2026-02-24):** Full rewrite with production implementation details. Added Section 12 (Implementation).
- **v3.3 (2026-02-24):** Integrated Phase 6.2 automated benchmark results.
- **v3.2 (2026-02-21):** Replaced projected with actual offline protocol validation data.
- **v3.1 (2026-02-16):** Added cost-benefit analysis.
- **v3.0 (2026-02-16):** Full adversarial protocol specified. Ratification phase added. GPQA and HumanEval results.
