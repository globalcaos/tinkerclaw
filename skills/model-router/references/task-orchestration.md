# Task Orchestration Patterns

How to decompose and route big tasks across multiple agents and models.

## The TAOR Loop (Claude Code's Core)

Think → Act → Observe → Repeat. The model decides next steps, not a hard-coded script. The runtime is a "dumb loop" — all intelligence lives in the model.

**Key insight:** Control inverts. Code no longer orchestrates the model; the model orchestrates the tools. Workflows break when reality deviates from the DAG. Loops adapt.

## Task Decomposition Strategy

### When to Decompose

Decompose when:

- Task takes >5 minutes of reasoning
- Task touches >3 files or domains
- Task has independent sub-parts that could run in parallel
- Task requires different expertise (research vs coding vs writing)

Don't decompose when:

- Task is a single focused action
- Context sharing between parts is heavy (coordination cost > parallelism gain)
- Task requires tight feedback loops (visual/creative work)

### The Hierarchical Pattern (AgentOrchestra, 95.3% accuracy)

```
Supervisor (strong tier)
├── Worker A (mid tier) — research
├── Worker B (mid tier) — implementation
├── Worker C (mid tier) — testing
└── Worker D (fast tier) — formatting output
```

Supervisor decomposes, assigns, reviews. Workers execute in their domain. Each worker gets the minimum context needed — not the full conversation.

### The Pipeline Pattern

```
Gather (gemini, large context) → Analyze (sonnet) → Synthesize (opus if complex)
```

Output of stage N feeds stage N+1. Each stage uses the model best suited to its task type.

### The Parallel Fan-Out Pattern

```
Task → Classifier (flash) → Route to N workers simultaneously
                           → Collect results
                           → Merge (mid/strong)
```

Best when sub-tasks are independent. Claude Code's Agent Teams uses this: separate tmux processes coordinating via filesystem JSON files.

## Context Isolation (Critical for Big Tasks)

**The #1 mistake:** Doing research + planning + execution in one context window.

Each sub-agent should get:

- The specific sub-task description
- Relevant context only (not the full conversation)
- Output format specification
- No access to other sub-agents' work-in-progress

This prevents "Context Collapse" — when the window fills up, the model starts hallucinating because it can't find the relevant information among noise.

## Claude Code's Architecture Lessons (Reverse-Engineered)

### 5 Design Pillars

1. **Model-Driven Autonomy** — model decides next steps, not hard-coded DAG
2. **Context as Scarce Resource** — auto-compaction, sub-agents, semantic search
3. **Layered Memory** — 6 layers load at session start (org → project → personal → auto-learned)
4. **Declarative Extensibility** — skills/agents/hooks via .md and .json, not code
5. **Composable Permissions** — tool-level allow/deny/ask with glob patterns

### 8 Failure Modes to Solve

1. Runaway loops (no kill switch)
2. Context collapse (stuffs everything in one window)
3. Permission roulette (asks about everything OR trusts blindly)
4. Amnesia (forgets between sessions)
5. Monolithic context (one conversation does everything)
6. Hard-coded behavior (extending requires code changes)
7. Black box (can't audit)
8. Single-threaded (no delegation)

### Agent Teams Internals

- Each teammate = separate CLI process in tmux split
- Coordination via JSON files in `~/.claude/teams/<team>/inboxes/` with fcntl locks
- Tasks = numbered JSON files in `~/.claude/tasks/<team>/`
- No database, no daemon, no network. Just filesystem.
- Task dependencies with cycle detection, atomic config writes

### Primitive Tools > Many Integrations

Claude Code uses Read, Write, Execute, Connect — not 100 specialized plugins. Bash acts as the universal adapter. This is why it outperforms agents with hundreds of integrations.

## Applying to OpenClaw Sub-Agents

### Big Task Workflow

```
1. Receive task
2. Classify complexity (flash tier classifier)
3. If simple → single agent, appropriate tier
4. If complex → decompose:
   a. Identify independent sub-tasks
   b. Assign model tier per sub-task
   c. Spawn sub-agents (parallel where possible)
   d. Monitor via overseer (filesystem, not polling)
   e. Collect and merge results
   f. Quality check (different model than producer)
```

### Model Assignment Per Role

| Role in orchestration     | Recommended tier                  |
| ------------------------- | --------------------------------- |
| Supervisor / decomposer   | strong (needs judgment)           |
| Research / data gathering | mid + gemini (large context)      |
| Implementation / coding   | mid (sonnet)                      |
| Review / QA               | mid (gpt — different perspective) |
| Formatting / output       | fast/flash                        |
| Monitoring                | free/local (qwen3)                |

### The Cross-Model Review Pattern

Always review output with a DIFFERENT model than the one that produced it. Different models have different blind spots. GPT reviewing Claude's output (or vice versa) catches errors that self-review misses.
