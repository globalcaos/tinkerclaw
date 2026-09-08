# Cross-Model Prompting: OpenAI vs Anthropic

Differences relevant to writing universal system prompts that work for both.

## Official Guidance Comparison

### OpenAI (from developers.openai.com, March 2026)

- **Structure:** Identity → Instructions → Examples → Context
- **Formatting:** Markdown headers + XML tags both supported. "Markdown headers and lists
  can be helpful to mark distinct sections... XML tags can help delineate where one piece
  of content begins and ends."
- **Message roles:** `developer` (highest priority) → `user` → `assistant`
- **Key quote:** "GPT models are fast, cost-efficient, and highly intelligent, but benefit
  from more explicit instructions around how to accomplish tasks."
- **Prompt caching:** "Keep content you expect to use over and over at the beginning of
  your prompt" — cached input at $0.25/1M (90% discount).
- **Reasoning effort:** Adjustable via `reasoning.effort` parameter (low/medium/high).
  GPT-5.4 benchmarks were evaluated at `xhigh`.

### Anthropic (from docs.anthropic.com)

- **Structure:** Similar — system prompt with persona, then instructions, then context
- **Formatting:** Strong XML tag support, markdown also works well
- **Message roles:** `system` → `user` → `assistant`
- **Key difference:** Claude excels at inferring intent from narrative/essay-style prompts.
  GPT models prefer directive/explicit instructions.
- **Prompt caching:** Supported with `cacheRetention` parameter.

## Practical Differences for Universal Prompts

| Dimension                 | Claude (Opus/Sonnet)              | GPT (5.4)                                            |
| ------------------------- | --------------------------------- | ---------------------------------------------------- |
| **Prompt style**          | Narrative + directive both work   | Directive preferred                                  |
| **Negative instructions** | Works but positive framing better | Works well                                           |
| **XML tags**              | Excellent                         | Good (supported per official docs)                   |
| **Markdown**              | Excellent                         | Excellent (recommended by OpenAI)                    |
| **Persona adoption**      | Deep, sustained                   | Good but may "leak" persona boundaries               |
| **Implicit inference**    | Strong                            | "Assertive" — works through ambiguity without asking |
| **Over-caution**          | Can refuse valid requests         | Rare — opposite problem (over-eagerness)             |
| **Long context**          | Stable to 200K                    | Degrades after 256K despite 1M window                |

## Key Insight: Opposite Failure Modes

Claude and GPT-5.4 fail in **opposite directions**:

- Claude: too cautious → may refuse or hedge
- GPT-5.4: too eager → may add unsolicited actions or fabricate completion

A universal prompt must guard against BOTH by:

1. Encouraging action (for Claude) — already handled by task instructions
2. Constraining scope (for GPT-5.4) — the addenda blocks address this

## What Works for Both

- **Markdown-formatted workspace files** — both handle well
- **Explicit decision trees** (if X → do Y) — both follow reliably
- **Short, specific prohibitions** — both respect "never do X"
- **Tool call patterns** — abstracted by the agent framework (OpenClaw, etc.)

## What Doesn't Transfer

- **Essay-style persona instructions** (SOUL.md) — Claude embodies deeply, GPT may
  adopt partially. Not fixable via addenda; accept degraded persona on fallback.
- **Compound conditional rules** — "if A AND B AND C then D" — GPT may miss conditions.
  Rewrite as explicit decision trees.
- **"You are Claude"** identity in system prompts — GPT ignores this gracefully.
  No action needed.

## Sources

- OpenAI Prompt Engineering Guide: developers.openai.com/api/docs/guides/prompt-engineering
- OpenAI Reasoning Models Guide: developers.openai.com/api/docs/guides/reasoning
- Microsoft Foundry GPT-5.4 Announcement: "Enhanced instruction alignment to reduce prompt
  tuning and oversight"
- Apiyi.com Claude Code vs GPT-5.4 Comparison (March 6, 2026)
- The Neuron GPT-5.4 Full Breakdown (March 6, 2026)
- Every.to Livestream GPT-5.4 Testing (March 5-6, 2026)
