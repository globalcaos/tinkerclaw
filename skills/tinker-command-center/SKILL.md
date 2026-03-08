---
name: tinker-command-center
description: "Stop guessing what your AI costs. Tinker shows every token, every dollar, every context byte — in real time."
metadata:
  openclaw:
    requires:
      bins: [node, pnpm]
    notes:
      security: "Read-only dashboard. Connects to your local OpenClaw gateway WebSocket. No data leaves your machine."
---

# Tinker Command Center

> **Your $200 Opus session didn't have to happen.** Tinker shows you exactly where every token goes — before the bill arrives.

## The Problem

You switched to Claude API because Anthropic did the right thing. Respect. But now you're running Opus through OpenClaw and a single deep conversation burns **$20+ in tokens** with zero warning. You check your dashboard three days later and wonder what happened.

That's not a billing problem. That's a visibility problem.

## What Tinker Does

Tinker is a **real-time command center** that sits on top of your OpenClaw gateway. It shows you what's filling your context window, what each response costs, and where your budget stands — live, as it happens.

### 🗺️ Context Treemap

Interactive squarified treemap of your context window. See exactly what takes space: system prompt sections, conversation history, tool results. Drill down from categories → messages → raw text. When you wonder "why is my context 180K tokens?" — this tells you in one glance.

### 📊 Response Treemap

Same visualization for model output. How much is text, how much is thinking, how much is tool calls? Per LLM call within a run, so you see the real cost of that 8-step tool loop.

### 💰 Live Cost Tracking

Per-provider token usage. Daily and monthly estimates. The 5-hour Claude rate-limit window with countdown timer. You'll never hit a rate limit by surprise again.

### ⚠️ Budget Alerts

Set a monthly limit. Get warned at 70%, 90%, and 100%. No more "I'll check later" — later is too late with Opus.

### 🔄 Multi-Call Run View

When your agent loops through tools (search → read → edit → test → commit), each call's context and cost is broken out individually. You'll see which tool calls are token hogs and which are cheap.

### 💬 Full Chat Interface

Not just a dashboard — it's a complete webchat with session switching, tool call inspection (expand any tool inline), and real-time streaming. Use it as your daily driver or just for monitoring.

## Pricing Reference

These are the API costs Tinker tracks:

| Model                 | Input (per 1M) | Output (per 1M) | Watch out?                      |
| --------------------- | -------------- | --------------- | ------------------------------- |
| Claude Opus 4 / 4.5   | **$15.00**     | **$75.00**      | ⚠️ Yes. One deep session = $20+ |
| Claude Sonnet 4 / 3.5 | $3.00          | $15.00          | Sweet spot                      |
| Claude Haiku 3.5      | $0.80          | $4.00           | Background tasks                |
| Gemini 3 Pro          | $1.25          | $5.00           | Great failover                  |
| Gemini 2 Flash        | $0.10          | $0.40           | Near-free                       |

## Install

Tinker is a **bundled OpenClaw plugin** in the [globalcaos fork](https://github.com/globalcaos/tinkerclaw). It ships as part of the build.

```bash
# Clone the fork
git clone https://github.com/globalcaos/tinkerclaw.git openclaw
cd openclaw

# Build (includes Tinker UI)
pnpm install
pnpm build

# Access
# Production: http://localhost:18789/tinker/
# Development: cd tinker-ui && pnpm dev → http://localhost:18790/tinker/
```

## Architecture

```
tinker-ui/                ← Standalone Vite + Lit app (zero upstream conflicts)
├── src/
│   ├── app.ts            ← Main shell: sidebar + panels + WebSocket client
│   └── panels/
│       ├── context-treemap.ts    ← What fills your context window
│       ├── response-treemap.ts   ← What each response costs
│       └── context-timeline.ts   ← Context usage over time
├── index.html
└── vite.config.ts

extensions/tinker/        ← OpenClaw plugin (serves UI from gateway)
├── index.ts
└── openclaw.plugin.json
```

- **Zero file overlap** with upstream `ui/` — no merge conflicts, ever.
- **~3,300 lines** of focused TypeScript + Lit components.
- **No external services** — connects to your local gateway WebSocket on port 18789.

## Why Now?

Anthropic refused the Pentagon contract. Respect. Claude overtook ChatGPT in the App Store this weekend. People are migrating to Claude API in droves.

But Claude API through OpenClaw is **unmetered**. There's no $20/month cap. Opus input costs $15 per million tokens, output costs $75. A single agent session with tools can easily consume 200K+ tokens. Do the math.

If you're switching to Claude API because you believe in Anthropic's mission — you should also know what you're spending. That's not about being cheap. That's about being informed.

Tinker makes you informed.

→ **[Get the fork](https://github.com/globalcaos/tinkerclaw)**

---

_Built by [globalcaos](https://github.com/globalcaos) · Part of [The Tinker Zone](https://github.com/globalcaos/tinkerclaw)_
