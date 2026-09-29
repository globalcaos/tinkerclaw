---
name: smart-model-router
version: 2.0.2
description: "Stop sending 'format this JSON' to Opus. Stop sending 'cron job' to GPT. Billing-aware routing guide for choosing among the models already configured in your OpenClaw setup when assigning an agent, sub-agent or cron task — flat-rate first, metered only when justified, budget pressure respected. Not for picking models outside your configuration, and not a runtime proxy."
metadata:
  openclaw:
    emoji: "🧭"
    notes:
      security: "Instructions only, no scripts. Routing is decided in the current agent context from the tables below and outputs a model name; by default no task text is sent anywhere for classification. The optional classifier is off unless MODEL_ROUTER_CLASSIFIER=local is set, and then sends only a short abstract task summary to a local model on loopback. The model you route to receives the task when your agent spawns it, as with any spawn."
---

> One of dozens of skills and plugins in **[TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — a self-improving OpenClaw fork that's been running 24/7 for months.

Stop sending "format this JSON" to Opus. Stop paying frontier prices for a cron job that any cheap brain handles in its sleep.

Most agents send every task to the smartest model they have — and quietly torch a metered budget on work a flat-rate model does just as well. This router knows which of your models are flat-rate (effectively free until your quota runs out) and which charge real money per token. It spends the flat-rate quota first, reaches for the metered model only when the task actually earns it, and eases off the moment your budget gets tight — so no surprise invoice at the end of the week.

**Part of [TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — real-time token tracking, self-improving crons, persistent cognitive memory. This is one piece of that stack; the repo has dozens more.

👉 **https://github.com/globalcaos/tinkerclaw**

_Clone it. Fork it. Break it. Make it yours._

# Model Router

<role>
You are a billing-aware model router. Your job is to pick, from the models configured in this OpenClaw setup, the right one for an agent, sub-agent or cron task: flat-rate first, metered only when justified, budget pressure respected at all times.
</role>

<why_this_matters>
Flat-rate Anthropic quotas are effectively free until exhausted; metered GPT/o3 costs real dollars per token. Routing every task to the smartest model burns the metered budget on tasks that flat-rate handles equally well, and sends the operator a surprise invoice.
</why_this_matters>

## Billing Tier System

Before routing, understand the cost structure:

| Billing tier | What it means                                                                      | Examples                                                    |
| ------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `flat`       | Subscription / flat-rate. Zero marginal cost per token. Spend freely within quota. | Anthropic Claude via Max subscription (opus, sonnet, haiku) |
| `metered`    | Pay-per-use. Real money per token. Every call has a dollar cost.                   | OpenAI (GPT, o3), Google Gemini (API)                       |
| `free`       | Local inference. Literally zero cost.                                              | Ollama (qwen3, llama, etc.)                                 |

<default_policy>
Route to `flat` or `free` by default. `metered` requires explicit justification from the scenarios below — assume flat-rate has headroom unless the budget data says otherwise.
</default_policy>

---

## Quick Decision: Can You Route Without a Classifier?

Most tasks fit obvious categories. Check the **Fast Route Table** first, and decide the tier yourself, in the current context. No task text leaves this context to make that decision.

### Fast Route Table

All tiers default to flat-rate models. Metered alternatives are only used when justified AND budget allows.

| Signal in task                                 | Route to      | Why                                       |
| ---------------------------------------------- | ------------- | ----------------------------------------- |
| "what time" / "what date" / simple lookup      | **flash**     | Zero reasoning needed                     |
| Format conversion, CSV→JSON, extract fields    | **flash**     | Mechanical transformation                 |
| Summarize text, list bullet points             | **fast**      | Pattern matching, not reasoning           |
| Translate text                                 | **fast**      | Well-trained capability across all models |
| Write code, implement feature, refactor        | **mid**       | Needs structured thinking                 |
| Review code, find bugs, security audit         | **mid**       | Analysis without deep creativity          |
| Draft email, write content                     | **mid**       | Needs tone + context awareness            |
| Research + synthesize from multiple sources    | **mid**       | Needs breadth, not max depth              |
| Debug complex system, multi-file investigation | **strong**    | Needs deep reasoning chains               |
| Reflect on failures, self-improvement          | **strong**    | Requires genuine metacognition            |
| Creative writing with nuance                   | **strong**    | Judgment + style + originality            |
| Math proofs, formal logic, complex reasoning   | **reasoning** | Chain-of-thought specialist               |
| Architectural decisions, tradeoff analysis     | **strong**    | Needs weighing multiple factors           |

---

## Tier → Model Mapping (Billing-Aware)

| Tier          | Default model (flat-rate)   | Metered alternative | When metered is allowed                               |
| ------------- | --------------------------- | ------------------- | ----------------------------------------------------- |
| **flash**     | `qwen3` (local/free)        | —                   | Never                                                 |
| **fast**      | `haiku` (flat)              | —                   | Never                                                 |
| **mid**       | `sonnet` (flat)             | —                   | Never                                                 |
| **strong**    | `opus` (flat)               | `gpt-5.2-pro`       | Cross-model review, second opinion on critical output |
| **reasoning** | `opus` with thinking (flat) | `o3`                | Complex formal logic where o3 measurably outperforms  |

<rule>
Tiers `flash`, `fast`, and `mid` always use flat-rate or free models. Metered alternatives are only relevant at `strong` and `reasoning`, and only with justification.
</rule>

---

## The "Good Enough" Principle

**Not every task needs the smartest model. Most tasks need a fast, flat-rate, correct one.**

### Definitely Does NOT Need Big Brains (flash/fast tier)

These tasks have a single correct answer or a mechanical transformation. No model does them "better" — they all get it right. Use the cheapest:

- Date/time queries, timezone conversions
- Regex generation, string formatting
- JSON/CSV/XML transformations
- Template filling (mail merge, form letters)
- Data extraction from structured text
- Simple Q&A with context provided
- Spell checking, grammar fixes
- File listing, directory scanning summaries
- Status checks, health report formatting
- Translating short text

### Needs Real Intelligence (mid tier)

These tasks benefit from a good model but don't need the frontier. The gap between mid and strong is <5% quality for 5x the cost:

- Code generation (functions, classes, modules)
- Code review and bug finding
- Content writing (blog posts, documentation)
- Email drafting with tone awareness
- Data analysis with narrative
- API integration code
- Test generation
- Summarizing long documents
- Morning briefings, daily reports

### Actually Needs Top Tier (strong)

Only route here when the task genuinely requires deep reasoning or creativity that cheaper models measurably fail at:

- Multi-step debugging across files
- Architectural refactoring decisions
- Self-reflection and failure analysis (wind-down)
- Nuanced judgment calls (should we do X or Y?)
- Creative writing with specific voice/style
- Complex negotiation drafting
- Synthesizing contradictory information
- Tasks where being wrong has high cost

---

<metered_justification>
The exhaustive list. Use a metered model (`gpt-5.2-pro`, `o3`) only when the scenario matches one of these:

1. **High-stakes cross-model review** — reviewing own output for a paper, proposal, or important external communication where a different model's perspective genuinely adds value.
2. **Cross-model validation under uncertainty** — you're genuinely unsure about correctness and a second opinion from a different architecture would catch errors.
3. **User-expressed preference** — the user has explicitly stated they want GPT or o3 for this task type.
4. **Creative structured feedback** — feedback on creative writing where a different model's "voice" and aesthetic sensibility adds measurable value beyond what flat-rate models provide.

If the scenario doesn't fit one of these four, route to flat-rate.
</metered_justification>

---

<metered_blocked>
These use cases never justify a metered model, regardless of task complexity:

- All cron jobs (for example self-evolution, cleanup, briefing, engagement reports, fork-sync, heartbeat)
- All automated/background tasks running without active user involvement
- Email checking, WhatsApp summarization, data extraction
- Code generation, debugging, tool use
- Any task that doesn't directly produce user-facing output requiring cross-model perspective
- Sub-agents spawned by cron jobs (inherits the parent's flat-rate restriction)
- Tier classification (done in context by default; opt-in local classifier only)
  </metered_blocked>

---

## Budget Pressure Tables

Check utilization before routing. Do not assume headroom. Read it from wherever your setup exposes it (the provider's usage page or API, or your gateway's usage panel). If you cannot read it, apply the missing-data rule below.

### Seven-Day Window (flat-rate provider quota)

| seven_day utilization | Routing guidance                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| < 70%                 | **Normal** — best model for the task tier                                                                                    |
| 70–85%                | **Conservative** — prefer sonnet over opus; haiku for flash/fast tiers                                                       |
| 85–95%                | **Austerity** — sonnet max for everything except active user conversation with explicit escalation. No opus for crons.       |
| > 95%                 | **Emergency** — haiku + local only. Opus only for active user conversation with explicit ask. No automated work above haiku. |

### Five-Hour Window (burst protection)

| five_hour utilization | Override                                          |
| --------------------- | ------------------------------------------------- |
| > 80%                 | Downshift one tier regardless of seven_day status |
| > 95%                 | Local models only for all automated/cron work     |

<missing_data_rule>
If utilization data is unavailable, treat seven_day = 75% (conservative mode).

Missing data isn't permission to use opus — it's a signal to be cautious. Assume only the headroom you can prove.
</missing_data_rule>

---

## Ambiguous Cases

A task is **ambiguous** when it matches rows in two or more tiers of the Fast Route Table (e.g. "write code" and "debug complex system"), or matches no row at all. A task that matches one row is not ambiguous — route it; do not classify it.

**Default (no configuration):** decide the tier yourself using the tier definitions below and the Generosity Rule. Nothing is sent to another model for this.

**Optional local classifier — off by default.** Only when the operator has set `MODEL_ROUTER_CLASSIFIER=local`, you may ask a local model (e.g. Ollama `qwen3` on `127.0.0.1`) to pick the tier. Never send the raw task: send a one-line abstract summary (task type, expected output, complexity signals) with no code, credentials, names, URLs, customer or personal data. If the variable is unset, has any other value, or no local model is reachable, skip this and use the default. This skill never sends classification requests to a remote provider.

Tier definitions (used by you, or by the opt-in local classifier):

```
Classify this task into exactly one tier. Reply with ONLY the tier name.

Tiers:
- flash: mechanical lookup, formatting, simple extraction
- fast: summarization, translation, template work
- mid: code generation, content writing, analysis, drafting
- strong: complex debugging, self-reflection, creative writing, architectural decisions
- reasoning: math proofs, formal logic, multi-step deduction

Task summary: {ABSTRACT_ONE_LINE_SUMMARY}

Tier:
```

The tier names are fixed internal labels the router matches on; they do not affect the language of anything shown to the user.

### Generosity Rule (When in Doubt, Go Up — Within Flat-Rate)

If you (or the opt-in local classifier) chose a tier but you're unsure:

- **Non-critical task** → keep that tier
- **User-facing output** → go one tier up (flat-rate only)
- **Irreversible action** → always use strong (flat-rate)
- **Ambiguous between two tiers** → pick the higher flat-rate tier

Generosity applies within flat-rate tiers. Going up never means jumping to metered without justification.

---

## Integration with OpenClaw

### Sub-agent spawning

```javascript
// Before (manual, billing-unaware):
sessions_spawn({ task: "Review this PR", model: "gpt-5.2-pro" });

// After (billing-aware):
// 1. Check Fast Route Table → "Review code" → mid → sonnet (flat)
sessions_spawn({ task: "Review this PR", model: "sonnet" });

// Cross-model review (metered justified):
// 1. High-stakes deliverable + cross-model perspective needed
// 2. Check budget: seven_day < 85%
// 3. Use gpt-5.2-pro only then
sessions_spawn({
  task: "Review my architecture proposal for external publication",
  model: "gpt-5.2-pro",
});
```

### Cron job model assignment

```
heartbeat:        flash/local  → qwen3 (free, NEVER metered)
cleanup:          fast         → haiku (flat, NEVER metered)
morning-briefing: mid          → sonnet (flat, NEVER metered)
code review:      mid          → sonnet (flat, NEVER metered)
wind-down:        strong       → opus (flat, NEVER metered)
self-evolution:   strong       → opus (flat, NEVER metered)
research reports: mid          → sonnet (flat, NEVER metered)
```

### Agent-level rule (add to AGENTS.md)

```markdown
## Model Routing

- All automated/cron work: flat-rate models only (opus/sonnet/haiku/local)
- Metered models (GPT, o3): only for cross-model review or user-initiated request
- Budget pressure: check utilization before spawning. >85% seven_day → sonnet max. >95% → haiku/local only.
- Missing data → assume conservative (75%). Never assume headroom you can't prove.
- If your gateway enforces billing caps, it may reroute a metered request once over budget — check its logs.
```

---

## Provider Strengths (2026 Benchmarks)

For detailed model comparisons, see `references/model-strengths.md`.

Quick reference for tier selection when multiple flat-rate models are available at the same tier:

| Strength                   | Best provider        | Why                                                     |
| -------------------------- | -------------------- | ------------------------------------------------------- |
| Coding (Terminal-Bench)    | Claude (Opus/Sonnet) | 65.4 score, leads benchmarks                            |
| Large context (>200K)      | Gemini               | 1M window, native long-doc                              |
| Multimodal (images/video)  | Gemini               | Full video processing                                   |
| Structured feedback        | GPT                  | Calibrated, consistent format (metered — justify first) |
| Chain-of-thought reasoning | o3                   | Purpose-built for deduction (metered — justify first)   |
| Speed + cost efficiency    | Haiku / qwen3        | Fastest flat-rate and free options                      |
| Creative/nuanced writing   | Opus                 | Best subjective quality (flat-rate)                     |

---

## Cron & Sub-Agent Routing

The router applies to ALL model selections, including:

- Sub-agents spawned by cron jobs (not just interactive)
- Sub-agents spawned by other sub-agents (recursive routing)
- Cron job model assignment at creation time
- Tier classification itself (in context by default; opt-in local model only, never remote)

<cron_restriction>
All cron-originated work inherits the metered-blocked restriction. The user isn't there to authorise spend, so the policy treats it as flat-rate-only across the board.
</cron_restriction>

### Sub-Agent Spawning Rule

When a cron job spawns sub-agents, EACH sub-agent gets its own tier — and ALL inherit the flat-rate restriction:

```
Cron: morning-briefing (sonnet, flat)
  └── Sub-agent: check emails        → fast  (haiku, flat)
  └── Sub-agent: calendar summary    → flash (qwen3, free)
  └── Sub-agent: draft briefing text → mid   (sonnet, flat)
```

---

## Big Task Orchestration

For complex multi-step tasks, see `references/task-orchestration.md`:

- Hierarchical supervisor → workers pattern
- Pipeline pattern (gather → analyze → synthesize)
- Parallel fan-out with merge
- Context isolation to prevent collapse
- Claude Code architecture lessons (reverse-engineered)

---

## Chain-of-Thought Optimization

Match CoT technique to tier for maximum ROI. See `references/chain-of-thought.md`:

- flash/fast: no CoT (tasks too simple)
- mid: structured CoT for complex sub-tasks
- strong: full CoT, Tree of Thought
- reasoning (opus+thinking): native CoT extended thinking mode; o3 only when metered is justified

---

## What to Keep in Bootstrap vs Auxiliary Files

**In AGENTS.md (every prompt):** Only the billing-aware routing rule:

```
## Model Routing
- All automated/cron work: flat-rate models only (opus/sonnet/haiku/local)
- Metered models (GPT, o3): only for cross-model review or user-initiated request
- Budget pressure: check utilization before spawning. >85% seven_day → sonnet max. >95% → haiku/local only.
- Missing data → assume conservative (75%). Never assume headroom you can't prove.
- If your gateway enforces billing caps, it may reroute a metered request once over budget — check its logs.
```

**In this skill (loaded on demand):** The full routing table, tier definitions, ambiguous-case rules, budget pressure tables, justification scenarios.

**In reference files (loaded only when needed):**

- `references/model-strengths.md` — detailed benchmarks and per-provider analysis
- `references/task-orchestration.md` — big task decomposition, Claude Code architecture
- `references/chain-of-thought.md` — CoT techniques matched to tiers

This follows the progressive disclosure principle: 5 lines always loaded, full skill on demand (~6KB), deep references only when the task requires them.

---

<anti_patterns>

- Using Opus for "what time is it" — flash task, 40x overspend within flat-rate
- Using Flash for debugging a race condition — flash misses subtle reasoning errors
- Always defaulting to one model — defeats the routing purpose
- Routing user-facing content to the cheapest model — quality matters when the user reads it
- Classifying every task — most fit the Fast Route Table obviously
- Sending a raw task description to another model just to pick a tier — decide in context
- Putting the full routing table in bootstrap files — wastes tokens every prompt
- Skipping the router on cron sub-agents — they spend tokens too
- Self-reviewing output with the same model — use a different model for review to catch blind spots
- Routing a cron job to a metered model — no automated task justifies pay-per-use
- Using GPT when flat-rate has headroom — flat-rate is literally free within quota
- Ignoring budget pressure signals — check utilization before every spawn
- Assuming budget data is available — missing data = conservative mode, 75%
  </anti_patterns>

---

## Changelog

- 2.0.2 — Removed the ambiguous-case step that sent the task description to another model; ambiguous tasks are now tiered in context, with an optional loopback-only classifier behind `MODEL_ROUTER_CLASSIFIER=local` that receives only an abstract summary. Corrected the security note to match, defined "ambiguous", and scoped the description to models you have configured.

## Pairs Well With

- [model-prompt-adapter](https://github.com/globalcaos/tinkerclaw/tree/main/skills/model-prompt-adapter) — once Router picks the model, Adapter fixes its quirks
- [subagent-overseer](https://github.com/globalcaos/tinkerclaw/tree/main/skills/subagent-overseer) — monitor the sub-agents you're routing models for
- [agent-superpowers](https://github.com/globalcaos/tinkerclaw/tree/main/skills/agent-superpowers) — the full engineering pipeline these routed agents should follow

👉 **https://github.com/globalcaos/tinkerclaw**

_Clone it. Fork it. Break it. Make it yours._
