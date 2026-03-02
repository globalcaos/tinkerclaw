<p align="center">
    <img src="docs/assets/tinkerzone-logo.png" alt="The Tinker Zone" width="300">
</p>

# The Tinker Zone — OpenClaw Fork

**Your AI agent. Full access. No handcuffs.**

[![Based on OpenClaw](https://img.shields.io/badge/based%20on-OpenClaw-blue?style=for-the-badge)](https://github.com/openclaw/openclaw)
[![Platform](https://img.shields.io/badge/platform-Ubuntu%20%2F%20Linux-orange?style=for-the-badge)](https://ubuntu.com)
[![AI Models](https://img.shields.io/badge/AI-Claude%20%7C%20Gemini%20%7C%20Ollama-green?style=for-the-badge)](#-multi-model-support)
[![Skills](https://img.shields.io/badge/skills-18%20published-purple?style=for-the-badge)](#-published-skills-on-clawhub)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

> **What is OpenClaw?** A personal AI assistant you run on your own devices — multi-channel (WhatsApp, Telegram, Slack, Discord, WebChat, and more), multi-model, always-on.
> For upstream docs, install guides, and full feature list see the **[upstream OpenClaw repository](https://github.com/openclaw/openclaw)**.

---

## Why This Fork?

Most OpenClaw setups are cautious by default — sandboxed, limited, designed for people who don't fully trust their agent yet.

This fork is for people who've already crossed that line.

Oscar Serra runs this fork on a Linux box in Barcelona with Claude, Gemini, and a local model as backup. No macOS required. No artificial limits. The agent has access to files, APIs, WhatsApp, email, calendar, and anything else that can be wired in — because that's the only way it actually helps.

> _"An AI assistant with no access is just a search engine with extra steps."_

If that line made you nod, you're in the right place.

→ **[Clone the fork and get started](#-quick-start)**

---

## What's Different Here?

### 🔐 Security Patches Applied

All critical upstream security PRs cherry-picked and verified:

| PR        | Fix                        | Status     |
| --------- | -------------------------- | ---------- |
| **#7769** | DNS Rebinding Protection   | ✅ Applied |
| **#7616** | Zip Path Traversal Fix     | ✅ Applied |
| **#7704** | WebSocket Auth Enforcement | ✅ Applied |

### 🧠 Smart Model Management

- **Smart Router V2** — Auto-selects the best model for each task
- **Rate Limiting** — Prevents runaway API costs
- **Anthropic Failover** — Auto-switches to Gemini when Claude hits quota (tested & verified!)
- **OAuth PKCE Flow** — Proper token refresh for Anthropic subscriptions

### 🔧 Fork Fixes

| Fix                   | What happened                                   | Status        |
| --------------------- | ----------------------------------------------- | ------------- |
| Anthropic failover    | Auto-switch to Gemini on rate limit             | ✅ Verified   |
| Anthropic OAuth       | PKCE flow with refresh token                    | ✅ Fixed      |
| Heartbeat isolation   | Runs in separate session — no webchat pollution | ✅ Fixed      |
| Config schema merge   | Re-adds fork Zod keys wiped by upstream merges  | ✅ Fixed      |
| Prompt queue deadlock | Workaround for upstream session lane deadlock   | ✅ Workaround |

### 🐧 Ubuntu-Native

- Tested on Ubuntu 22.04 / 24.04
- Systemd service examples included
- Works with `deja-dup` for backups
- No macOS-only dependencies

---

## 📦 Published Skills on [ClawHub](https://clawhub.ai/u/globalcaos)

> 18 skills, all built by globalcaos. Install any of them with `clawhub install globalcaos/<skill-name>`.

### 🎙️ Voice & Personality

| Skill                                                        | Description                                                              | Version |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ | ------- |
| [`jarvis-voice`](https://clawhub.ai/globalcaos/jarvis-voice) | Your agent already thinks like JARVIS. This makes it sound like one too. | v3.1.1  |

### 📹 Media & Content

| Skill                                                                | Description                                                                                         | Version |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------- |
| [`youtube-ultimate`](https://clawhub.ai/globalcaos/youtube-ultimate) | Free transcripts, 4K downloads, video exploration — zero API quotas burned                          | v4.2.2  |
| [`video-frames`](https://clawhub.ai/globalcaos/video-frames)         | Pull exact frames or clips from any video. ffmpeg, no UI, no cloud.                                 | v1.0.0  |
| [`ai-humanizer`](https://clawhub.ai/globalcaos/ai-humanizer)         | Text that reads like a human wrote it — because the AI patterns are gone. 24 detectors, 500+ terms. | v2.1.0  |

### 💬 Messaging & Channels

| Skill                                                                  | Description                                                                                                               | Version |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------- |
| [`whatsapp-ultimate`](https://clawhub.ai/globalcaos/whatsapp-ultimate) | 3-rule security gate — agent speaks only when spoken to, in the right chat, by the right person. Won't reply to your mom. | v3.5.1  |
| [`xurl`](https://clawhub.ai/globalcaos/xurl)                           | Post, reply, DM, upload media on X — from your agent, fully authenticated.                                                | v2.3.1  |

### 💰 Cost & Token Management

| Skill                                                                            | Description                                                                             | Version |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------- |
| [`token-panel-ultimate`](https://clawhub.ai/globalcaos/token-panel-ultimate)     | Know exactly where your AI tokens go. Multi-provider tracking, budget alerts, REST API. | v2.1.1  |
| [`token-efficiency-guide`](https://clawhub.ai/globalcaos/token-efficiency-guide) | Go from weekly limit on Tuesday to weekly limit on Sunday. 10 steps, one afternoon.     | v1.1.0  |

### 🏢 Enterprise Hacks (Browser Relay)

No API keys. No admin consent. No IT ticket. Your authenticated browser session is the API — and your agent already knows how to use it.

| Skill                                                            | Description                                                                                                                                                                             | Version |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| [`outlook-hack`](https://clawhub.ai/globalcaos/outlook-hack)     | Agent reads Outlook email all day, drafts replies — won't send without approval. One handshake in the morning, autonomous all day. It writes drafts — you pull the trigger. Sleep well. | v3.0.0  |
| [`factorial-hack`](https://clawhub.ai/globalcaos/factorial-hack) | Your agent reads your HR portal. Attendance, leave, payslips — no API key, no admin.                                                                                                    | v1.0.0  |
| [`teams-hack`](https://clawhub.ai/globalcaos/teams-hack)         | Agent in your Teams: reads threads, posts updates, finds anything. No bot registration needed.                                                                                          | v1.0.0  |

### 🤖 Agent & DevOps

| Skill                                                                                              | Description                                                                                      | Version |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------- |
| [`coding-agent`](https://clawhub.ai/globalcaos/coding-agent)                                       | Hand off a coding task and come back to a diff. Codex, Claude Code, or Pi — your call.           | v1.0.0  |
| [`subagent-overseer`](https://clawhub.ai/globalcaos/subagent-overseer)                             | Sub-agents that go silent don't go unnoticed. Health checks, staleness alerts, zero babysitting. | v1.0.0  |
| [`fork-and-skill-scanner-ultimate`](https://clawhub.ai/globalcaos/fork-and-skill-scanner-ultimate) | Scan 1,000 GitHub forks per run. Surface the gold, skip the clones — fully automated.            | v1.1.1  |
| [`memory-pioneer`](https://clawhub.ai/globalcaos/memory-pioneer)                                   | Find out how much your agent actually remembers. Spoiler: it's less than you think.              | v1.0.2  |

### 🛡️ Security & Governance

| Skill                                                                                  | Description                                                                                             | Version |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------- |
| [`agent-boundaries-ultimate`](https://clawhub.ai/globalcaos/agent-boundaries-ultimate) | Draw the line between helpful and reckless. Configurable safety gates that don't lobotomize your agent. | v1.2.2  |
| [`agent-memory-ultimate`](https://clawhub.ai/globalcaos/agent-memory-ultimate)         | Your agent's long-term memory, done right. Semantic search, daily consolidation, cross-session recall.  | v2.0.3  |

### 📋 Data & Migration

| Skill                                                                                  | Description                                                                                     | Version |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------- |
| [`chatgpt-exporter-ultimate`](https://clawhub.ai/globalcaos/chatgpt-exporter-ultimate) | Leaving ChatGPT? Take your conversations with you. Full export, clean format, ready for import. | v1.0.2  |

---

## 🖥️ Tinker Command Center (Bundled Plugin)

> **Know exactly what you're spending before the bill arrives.**

A single long Opus conversation can burn through **$20+ in tokens** without warning. Tinker gives you a real-time command center so every token is visible.

- **🗺️ Context Treemap** — Interactive visualization of what fills your context window. Drill down from categories to individual messages to raw text.
- **📊 Response Treemap** — See how much of the response is text, thinking, tool calls, or tool results.
- **💰 Live Cost Tracking** — Per-provider usage, daily/monthly estimates, and the 5-hour Claude rate-limit countdown.
- **⚠️ Budget Alerts** — Set limits and get warnings before you blow through them.
- **🔄 Multi-call Run View** — When the agent loops through tools, see each call's context and cost individually.
- **💬 Chat + Session Management** — Full webchat with session switching, tool call inspection, real-time streaming.

### Supported Models & Pricing

| Model                  | Input (per 1M) | Output (per 1M) | Notes                          |
| ---------------------- | -------------- | --------------- | ------------------------------ |
| Claude Opus 4 / 4.5    | **$15.00**     | **$75.00**      | ⚠️ Premium — watch your usage! |
| Claude Sonnet 4 / 3.5  | $3.00          | $15.00          | Best price/performance ratio   |
| Claude Haiku 3.5       | $0.80          | $4.00           | Fast, cheap tasks              |
| Gemini 3 Pro / 3.1 Pro | $1.25          | $5.00           | Great failover option          |
| Gemini 2 Flash         | $0.10          | $0.40           | Budget-friendly                |
| Gemini 2 Flash Lite    | $0.02          | $0.08           | Near-free for simple tasks     |

After `pnpm build`, visit **`http://localhost:18789/tinker/`** · Dev: `cd tinker-ui && pnpm dev` → `http://localhost:18790/tinker/`

---

## 🤖 Multi-Model Support

| Provider      | Model                      | Use Case                            | Status    |
| ------------- | -------------------------- | ----------------------------------- | --------- |
| **Anthropic** | Claude Opus 4.5 / Sonnet 4 | Primary chat, coding, complex tasks | ✅ Active |
| **Google**    | Gemini 3 Pro               | Failover, large context, vision     | ✅ Active |
| **Ollama**    | Local models (qwen3, etc.) | Heartbeat, background tasks         | ✅ Active |

### Failover Chain

```
Claude (primary) → Gemini (rate limit) → Local Model (offline fallback)
```

> When Claude hits its quota, we **automatically switch to Gemini** with zero downtime. Tested and verified when both providers rate-limited within minutes of each other.

---

## 🚀 Quick Start

### 1. Clone This Fork

```bash
git clone https://github.com/globalcaos/clawdbot-moltbot-openclaw.git openclaw
cd openclaw
```

### 2. Install & Build

```bash
pnpm install
pnpm build
```

### 3. Run the Wizard

```bash
pnpm openclaw onboard --install-daemon
```

### 4. Configure Your AI Keys

Edit `~/.openclaw/openclaw.json`:

```json
{
  "providers": {
    "anthropic": { "apiKey": "sk-ant-..." },
    "google": { "apiKey": "AIza..." }
  }
}
```

### 5. Start & Connect

```bash
pnpm openclaw gateway start
```

Visit **`http://localhost:18789/tinker/`** for the command center, or connect via WhatsApp/Telegram/Discord.

### 6. Let the AI Guide You

> _"Read FORK.md and help me configure the remaining features."_

The AI will walk you through enabling WhatsApp, skills, and optimizations.

---

## What's Next

- **WhatsApp full history sync** — your agent will have context going back years, not just this week
- **LanceDB hybrid memory** — persistent, searchable, cross-session
- **The Tinker Zone YouTube tutorials** — because docs only get you so far

---

## 📚 Upstream Documentation

> **[OpenClaw upstream repository & docs](https://github.com/openclaw/openclaw)** · [Website](https://openclaw.ai) · [Docs](https://docs.openclaw.ai) · [Getting Started](https://docs.openclaw.ai/start/getting-started) · [FAQ](https://docs.openclaw.ai/help/faq)

---

## 🤝 Contributing

1. **Document everything** — help newcomers get started
2. **Test on Linux** — Ubuntu is our primary platform
3. **Trust-first features** — expand AI capabilities, not restrict them
4. **Cost transparency** — make AI spending visible and controllable

> We upstream security fixes quickly, experiment freely with features that might be too aggressive for upstream, and document the journey so others can learn.

---

## About the Maintainer

Oscar Serra is a telecom engineer in Barcelona who got tired of AI assistants that apologize before doing anything useful.

He built this fork because he wanted an agent that actually knows him — his calendar, his emails, his WhatsApp, his code — and acts on it without asking permission for every step. Everything documented here is running in production on his daily driver.

If something in this fork is broken, the user already found it. If something works brilliantly, there's a story behind it.

→ [Follow the build on GitHub](https://github.com/globalcaos)

---

_Clone it. Fork it. Break it. Make it yours._

---

📜 Same as upstream OpenClaw (MIT) · Fork maintained by [GlobalCaos](https://github.com/globalcaos) · Based on [OpenClaw](https://github.com/openclaw/openclaw)
