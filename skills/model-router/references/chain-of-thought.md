# Chain-of-Thought Reasoning Techniques

When and how to use CoT to get better results from any tier.

## Core Principle

CoT prompting makes the model show its work — intermediate steps before the final answer. A study showed GPT-3.5 with agentic looping achieved 95.1% accuracy, surpassing GPT-4's 67% zero-shot. The technique matters more than the model.

## Techniques (By Complexity)

### 1. Zero-Shot CoT (Free, Always Works)

Just add "Think step by step" or "Let's work through this."

- Works on: All models, all tiers
- Best for: Quick boost on any reasoning task
- Cost: ~5 extra tokens in prompt

### 2. Structured CoT (Mid Tier+)

Give the model a reasoning template:

```
First, identify the key constraints.
Then, evaluate each option against those constraints.
Finally, choose the best option and explain why.
```

- Works best on: mid/strong tiers
- Best for: Decision-making, analysis, comparisons

### 3. Self-Consistency (Multiple Samples)

Run the same prompt 3-5 times, take the majority answer.

- Cost: 3-5x per query
- Worth it for: High-stakes decisions, math, logic
- Implementation: Spawn 3 sub-agents with same prompt, compare

### 4. Tree of Thought (Strong Tier Only)

Model explores multiple reasoning branches, evaluates each, backtracks:

```
Consider 3 different approaches to this problem.
For each, work through the first 2 steps.
Evaluate which approach is most promising.
Continue only with the best one.
```

- Cost: 3-5x token usage
- Worth it for: Complex planning, architectural decisions

### 5. ReAct (Reasoning + Acting)

Interleave thinking and tool use:

```
Thought: I need to check if the API endpoint exists.
Action: Read the routes file.
Observation: The endpoint is defined at line 42.
Thought: Now I need to check the middleware chain...
```

- This is what Claude Code's TAOR loop IS
- Best for: Any task involving tool use + reasoning

## When CoT Actually Helps vs Wastes Tokens

### Helps (Use It)

- Math and arithmetic (huge improvement)
- Multi-step logic problems
- Code debugging (trace the execution path)
- Decision-making with tradeoffs
- Anything where "showing work" catches errors

### Doesn't Help (Skip It)

- Simple lookups (what time is it?)
- Direct extraction (pull the email from this text)
- Translation (models already do this well)
- Formatting (mechanical, not reasoning)
- Tasks where the answer is obvious

### Rule: Match CoT to Tier

| Tier      | CoT Strategy                                | Why                                     |
| --------- | ------------------------------------------- | --------------------------------------- |
| flash     | None                                        | Tasks are too simple, CoT wastes tokens |
| fast      | Zero-shot CoT only if reasoning is involved | Light touch                             |
| mid       | Structured CoT for complex sub-tasks        | Good balance                            |
| strong    | Full CoT, Tree of Thought for hard problems | Maximize capability                     |
| reasoning | Native CoT (o3 does this internally)        | Don't prompt for it — it's built in     |

## Prompt Patterns That Improve Any Model

### The Constraint-First Pattern

```
Given these constraints: [list]
And this goal: [goal]
What is the best approach?
```

Giving constraints BEFORE the question focuses reasoning.

### The Verify-Your-Answer Pattern

```
[task]
After answering, verify your answer by checking it against the original requirements.
```

Cheap self-check that catches obvious errors.

### The Expert-Persona Pattern

```
You are a senior [domain] engineer with 15 years of experience.
```

Activates domain-specific reasoning patterns. Measurably improves quality in specialized tasks.

## 6. Adaptive Reasoning Effort (Ares Pattern, arXiv 2603.07915)

Route reasoning effort dynamically per step. Reserve high effort for complex decisions; use low/none for mechanical steps (URL opens, file reads, formatting).

- GPT-5.4 mini/nano and Mistral Small 4 support `reasoning_effort` natively
- Ares achieved 52.7% reasoning token reduction with minimal accuracy loss
- Implementation: classify each agent step as simple/medium/complex, set reasoning_effort accordingly
- Best for: Multi-step agent tasks with mixed difficulty (web browsing, coding, research)

## CoT Budget Rule

If CoT adds >20% to your token cost and the task is non-critical, skip it. The model-router's tier system already puts hard tasks on capable models — CoT is the cherry on top, not the cake.
