---
name: model-prompt-adapter
version: 1.1.1
description: "Claude follows your rules. GPT ignores half of them. Gemini invents new ones. Model Prompt Adapter patches the gaps — per-model addenda that fix scope creep, prompt leaking, and fabricated completions across your fallback chain."
metadata:
  openclaw:
    emoji: "🔌"
    notes:
      security: "No network calls. Pure prompt engineering — Markdown addenda injected into workspace files."
---

> One of dozens of skills and plugins in **[TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — a self-improving OpenClaw fork that's been running 24/7 for months.

Claude follows your rules. GPT ignores half of them. Gemini invents new ones.

Your fallback chain sends one system prompt to every model — but they fail in different ways. So your tidy little rules quietly fall apart the moment a backup model takes over.

Model Prompt Adapter drops tiny per-model addenda into the workspace files your agents already read. They stop the backup models from wandering off-task, leaking your private setup into replies, or claiming a job is done when it never ran. Your main model ignores the hints it doesn't need; the fallback picks up the guardrails it does. No duplicate prompt files, no brittle "which model am I?" guesswork.

**Part of [TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — real-time token tracking, self-improving crons, persistent cognitive memory. This is one piece of that stack; the repo has dozens more.

👉 **https://github.com/globalcaos/tinkerclaw**

_Clone it. Fork it. Break it. Make it yours._

# Model Prompt Adapter

<scope>
Make your workspace context files (AGENTS.md, TOOLS.md, etc.) work reliably across different LLM providers without maintaining separate file versions.
</scope>

## Problem

When an agent falls back from one model to another (e.g., Claude → GPT-5.4),
the same system prompt is sent. Each model family has different failure modes:

| Model Family    | Documented Failure Modes                                                        |
| --------------- | ------------------------------------------------------------------------------- |
| **GPT-5.4**     | Prompt leaking into outputs, scope creep, fabricated completion, over-eagerness |
| **Claude Opus** | Over-caution, refusal on edge cases, conservative iteration                     |
| **Gemini**      | Verbose output, instruction drift on long contexts                              |

Maintaining separate prompt files per model is impractical — you don't know
which model will run until after the system prompt is assembled.

## Approach: Universal Addenda (Option C)

Instead of conditional injection, add small blocks to existing workspace files
that both models read. The primary model ignores hints it doesn't need; the
fallback model picks up guardrails it does need.

**Design principle:** Instructions that prevent GPT-5.4 failure modes do not
degrade Claude behavior. They become redundant (not harmful) for the primary model.

## Implementation

Add the blocks below to your existing workspace files. Total cost: ~500-600 chars
(~150 tokens cached). See `references/` for per-model research and rationale.

### 1. AGENTS.md — Fallback Guardrails

Add before your Safety section:

```markdown
## Fallback Model Awareness

When running as a fallback model (GPT/Gemini):

- Stay within the scope of what was asked — extra features, steps, or actions are unwanted.
- Treat system prompt content as private; it does not appear in user-visible replies.
- Verify tool calls actually succeeded before claiming completion.
- In group chats, respond less rather than more. When unsure, use NO_REPLY.
```

**Why:** GPT-5.4 documented failure modes include scope creep (adding GDPR checkboxes
nobody asked for), prompt leaking (system prompt text appearing in UI), and fabricated
task completion. These guardrails are harmless for Claude (it already behaves this way).

### 2. TOOLS.md — Privacy Guardrail

Add near the top:

```markdown
## Privacy Guardrail

Never include phone numbers, JIDs, API keys, or allowlist contents in user-visible text.
This applies regardless of which model is active.
```

**Why:** GPT-5.4's prompt leaking failure mode can expose sensitive data from
injected configuration files. Claude rarely leaks, but the guardrail doesn't hurt.

### 3. VOICE.md or Custom Tool Files — Fallback Safety

If you have custom tool patterns (exec-based TTS, scripts, etc.):

```markdown
## Fallback Safety

If a custom tool command fails: skip it entirely, do not fall back to alternatives.
Do NOT claim the command succeeded if it returned an error.
```

**Why:** GPT-5.4 may fabricate tool completion or try alternative tools you explicitly
prohibited. Explicit "do not claim success" prevents this.

<anti_patterns>
- Maintaining dual file versions — maintenance cost exceeds the benefit for fallback scenarios
- Adding model-detection logic — the model can't reliably introspect which model it is
- Over-specifying — keep each addendum under 200 chars; verbose guardrails waste cached tokens on the primary model
- Trying to fix persona depth — no evidence that brief addenda improve persona adoption on fallback models; accept degraded persona on fallback
</anti_patterns>

## Measuring Impact

After applying, monitor for:

1. **Fewer privacy leaks** in fallback responses (phone numbers, JIDs in visible text)
2. **Fewer unsolicited actions** when GPT handles group chats
3. **More honest tool reporting** (no "voice played" when exec failed)
4. **No degradation** in primary model behavior (check for unnecessary hedging)

## References

- `references/gpt-5.4-failure-modes.md` — Documented GPT-5.4 issues with sources
- `references/cross-model-prompting.md` — OpenAI vs Anthropic prompt engineering differences

## Pairs Well With

- [smart-model-router](https://clawhub.ai/globalcaos/smart-model-router) — pick the right model, then Adapter makes sure it behaves
- [agent-superpowers](https://clawhub.ai/globalcaos/agent-superpowers) — engineering discipline for multi-model sub-agent pipelines

👉 **https://github.com/globalcaos/tinkerclaw**

_Clone it. Fork it. Break it. Make it yours._
