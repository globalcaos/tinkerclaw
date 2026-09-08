# Model Strengths Reference (2026)

Last updated: 2026-03-05

## Frontier Models (Strong/Reasoning Tier)

### Claude Opus 4.6

- **Best at:** Complex coding (Terminal-Bench 65.4, #1), nuanced writing, self-reflection
- **Weakness:** Expensive ($15/M in, $75/M out), no native video, smaller context (200K)
- **Use for:** Wind-down, architectural decisions, creative content, multi-file debugging
- **Skip for:** Mechanical tasks, summarization, anything a mid-tier handles

### GPT-5.2 Pro

- **Best at:** Structured feedback, calibrated reviews, general reasoning
- **Weakness:** Slightly behind Opus on code benchmarks
- **Use for:** PR reviews, second opinions, report critique (Step 3.5 professor pattern)
- **Skip for:** Tasks requiring Anthropic-specific features (tool use patterns)

### Gemini 3.1 Pro

- **Best at:** Largest context (1M tokens), multimodal (images + video), synthesis
- **Weakness:** Slightly behind on code generation benchmarks
- **Use for:** Long document analysis, video processing, research synthesis, vision tasks
- **Skip for:** When context window isn't needed and code quality matters most

### o3 (OpenAI)

- **Best at:** Formal reasoning, math, logic puzzles, chain-of-thought
- **Weakness:** Slower, specialized (not great at creative writing)
- **Use for:** Mathematical proofs, logical deduction, algorithm design
- **Skip for:** Creative writing, general conversation, drafting

## Mid-Tier Models

### Claude Sonnet 4.6

- **Best at:** Coding (close to Opus quality), structured tasks, analysis
- **Key advantage:** Separate rate limit from Opus on Max subscriptions
- **Cost:** ~1/5 of Opus
- **Use for:** Sub-agents (coding, review, drafting), cron jobs, briefings
- **The workhorse:** Default choice for most non-trivial tasks

### GPT-5.2

- **Best at:** General-purpose, good all-rounder, fast
- **Use for:** Fallback when Anthropic is ratelimited, structured data tasks
- **Cost:** Mid-range

### Gemini 3 Pro

- **Best at:** Large context tasks at lower cost than 3.1
- **Use for:** Research, doc generation when 1M context helps

## Fast/Flash Tier

### Claude Haiku 4.5

- **Best at:** Fast responses, good quality for size, tool use
- **Cost:** ~$0.25/M in, $1.25/M out
- **Use for:** Summarization, translation, classification, light analysis

### Gemini Flash

- **Best at:** Fastest inference, cheapest, good enough for mechanical tasks
- **Cost:** ~$0.075/M in, $0.30/M out (cheapest of all)
- **Use for:** Data extraction, formatting, template filling, the classifier itself

### GPT-5.4 mini (NEW — Mar 17, 2026)

- **Best at:** Sub-agent delegation, coding (54.4% SWE-bench Pro), tool use (57.7% MCP Atlas), computer use (72.1% OSWorld)
- **Cost:** $0.75/M in, $4.50/M out — 1/3 of GPT-5.4
- **Context:** 400K tokens
- **Use for:** Sub-agent coding tasks, codebase search, file review, parallel workers
- **Skip for:** Tasks requiring >400K context or frontier-level reasoning

### GPT-5.4 nano (NEW — Mar 17, 2026)

- **Best at:** Classification, extraction, ranking, simple coding sub-tasks
- **Cost:** $0.20/M in, $1.25/M out — cheapest capable cloud model
- **Use for:** Data extraction, formatting, heartbeat-level tasks with cloud reliability
- **Skip for:** Complex reasoning, long context (limited window)

### GPT-4o-mini

- **Best at:** Fast, structured output, JSON mode
- **Use for:** Formatting, extraction, light classification

## Local Models (Free Tier)

### Qwen3 14B (Ollama)

- **Best at:** Free, private, no API costs, decent reasoning for size
- **Use for:** Heartbeats, status checks, mechanical monitoring
- **Limitation:** Quality ceiling lower than cloud models

## Cost Comparison (per 100-token query)

| Model        | Cost     | Relative to Opus |
| ------------ | -------- | ---------------- |
| Gemini Flash | $0.00007 | 1/43x            |
| Haiku        | $0.0003  | 1/10x            |
| Sonnet       | $0.001   | 1/3x             |
| GPT-5.2      | $0.0016  | 1/2x             |
| Opus         | $0.003   | 1x (baseline)    |
| o3           | $0.002   | 2/3x             |

## Multi-Model Orchestration Patterns

### Cross-Model Review (Step 3.5 Pattern)

```
Draft (Sonnet) → Review (GPT-5.2) → Final (incorporate feedback)
```

Different models catch different errors. Using GPT to review Claude output (or vice versa) finds blind spots.

### Research Pipeline

```
Gather (Gemini, large context) → Analyze (Sonnet) → Synthesize (Opus if complex, Sonnet if straightforward)
```

### Cost-Optimized Coding

```
Generate (Sonnet) → Test (exec) → Fix if needed (Sonnet) → Complex debug only (Opus)
```

Only escalate to Opus when Sonnet demonstrably fails.

## Decision Tree Summary

```
Is the task mechanical/lookup?
  YES → flash (Gemini Flash)
  NO ↓
Is it summarization/translation/formatting?
  YES → fast (Haiku)
  NO ↓
Is it coding/drafting/analysis?
  YES → mid (Sonnet)
  NO ↓
Does it need deep reasoning/creativity/self-reflection?
  YES → strong (Opus)
  NO ↓
Does it need formal logic/math?
  YES → reasoning (o3)
  NO → mid (Sonnet) — safe default
```
