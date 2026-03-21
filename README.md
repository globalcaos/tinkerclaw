<p align="center">
    <img src="docs/assets/tinkerzone-logo.png" alt="The Tinker Zone" width="300">
</p>

# The Tinker Zone — OpenClaw Fork

**Your AI agent. Full access. No handcuffs.**

[![Based on OpenClaw](https://img.shields.io/badge/based%20on-OpenClaw-blue?style=for-the-badge)](https://github.com/openclaw/openclaw)
[![Platform](https://img.shields.io/badge/platform-Ubuntu%20%2F%20Linux-orange?style=for-the-badge)](https://ubuntu.com)
[![AI Models](https://img.shields.io/badge/AI-Claude%20%7C%20Gemini%20%7C%20GPT%20%7C%20Ollama-green?style=for-the-badge)](#-multi-model-support)
[![Skills](https://img.shields.io/badge/skills-19%2B%20published-purple?style=for-the-badge)](#-published-skills-on-clawhub)
[![Fork Commits](https://img.shields.io/badge/fork-474%2B%20commits%20ahead-brightgreen?style=for-the-badge)](https://github.com/globalcaos/tinkerclaw)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

> **What is OpenClaw?** A personal AI assistant you run on your own devices — multi-channel (WhatsApp, Telegram, Slack, Discord, WebChat, and more), multi-model, always-on.
> For upstream docs, install guides, and full feature list see the **[upstream OpenClaw repository](https://github.com/openclaw/openclaw)**.

---

## Why This Fork?

Most OpenClaw setups are cautious by default — sandboxed, limited, designed for people who don't fully trust their agent yet.

This fork is for people who've already crossed that line.

Oscar Serra runs this fork on a Linux box in Barcelona with Claude, Gemini, GPT, and a local model as backup. No macOS required. No artificial limits. The agent has access to files, APIs, WhatsApp, email, calendar, and anything else that can be wired in — because that's the only way it actually helps.

> _"An AI assistant with no access is just a search engine with extra steps."_

If that line made you nod, you're in the right place.

→ **[Clone the fork and get started](#setup-guide)**

---

## What It Looks Like

<p align="center">
    <img src="docs/assets/screenshot-4.png" alt="The Tinker Zone — Chat Interface" width="700">
</p>

<p align="center"><em>The Tinker Zone — wooden-themed chat interface with live model glow and context tracking</em></p>

<p align="center">
    <img src="docs/assets/screenshot-2.png" alt="Context Treemap" width="400">
    <img src="docs/assets/screenshot-5.png" alt="Token Detail" width="400">
</p>

<p align="center"><em>Left: Context treemap — see exactly what fills your 200K window. Right: Token-level detail per message.</em></p>

<p align="center">
    <img src="docs/assets/screenshot-3.png" alt="Timeline" width="700">
</p>

<p align="center"><em>Daily token timeline — stacked bars showing usage by category across the day</em></p>

<p align="center">
    <img src="docs/assets/screenshot-1.png" alt="Models Dashboard" width="350">
</p>

<p align="center"><em>Models dashboard — live status, pricing, fallback chain, active sessions</em></p>

---

## What's Different Here?

### 🔐 Security Patches Applied

All critical upstream security PRs cherry-picked and verified (historical — applied at the time):

| PR        | Fix                        | Status     |
| --------- | -------------------------- | ---------- |
| **#7769** | DNS Rebinding Protection   | ✅ Applied |
| **#7616** | Zip Path Traversal Fix     | ✅ Applied |
| **#7704** | WebSocket Auth Enforcement | ✅ Applied |

### 🧠 Ships With Smart Defaults

These are not optional — they're on out of the box:

- **ENGRAM compaction** — silent context management, no interruptions mid-session
- **Hippocampus memory indexing** — your agent builds long-term memory automatically
- **Memory search with semantic embeddings** — find anything across sessions
- **Budget panel** — token cost tracking baked in; you see what each session costs
- **Smart Router V2** — auto-selects the best model for each task
- **Rate Limiting** — prevents runaway API costs
- **Anthropic Failover** — auto-switches to Gemini when Claude hits quota (tested & verified!)
- **OAuth PKCE Flow** — proper token refresh for Anthropic subscriptions

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

## Setup Guide

Everything you need to go from `git clone` to a working personal AI assistant.

### Quick Start

```bash
git clone https://github.com/globalcaos/tinkerclaw.git
cd tinkerclaw
pnpm install
pnpm build
openclaw doctor       # generates config + links WhatsApp
openclaw gateway start
```

### What You Get Out of the Box

- **ENGRAM compaction** — silent context management, no annoying compaction events
- **Hippocampus memory indexing** — your agent builds long-term memory automatically
- **Memory search with semantic embeddings** — find anything across sessions
- **Context pruning** — cache-ttl prevents unbounded session growth
- **Budget panel** — token cost tracking so you know what each session costs
- **Tinker UI** — real-time context treemaps, session management, cost dashboard

### Required Setup (you must do these)

1. **API Key** — At minimum, set up one provider (Anthropic recommended). `openclaw doctor` walks you through this.
2. **WhatsApp** (optional) — `openclaw channels login --channel whatsapp` to link your phone
3. **Give your agent a name** — Edit `~/.openclaw/workspace/SOUL.md` to define who your agent is

### Recommended Config Tweaks

After first run, edit `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "whatsapp": {
      "responsePrefix": "🤖",
      "triggerPrefix": "your-agent-name",
      "dmPolicy": "allowlist",
      "allowFrom": ["+your-phone-number"]
    }
  }
}
```

### Cron Jobs (Recommended Starter Set)

TinkerClaw doesn't ship cron jobs by default — they're personal. Here's a minimal starter set:

```bash
# Morning briefing (daily at 8:30)
openclaw cron add --name morning-briefing --cron "30 8 * * *" --tz "Your/Timezone" \
  --session isolated --model "anthropic/claude-sonnet-4" \
  --message "Build a morning briefing: check calendar, pending tasks, and recent messages."

# Nightly reflection (daily at midnight)
openclaw cron add --name wind-down --cron "0 0 * * *" --tz "Your/Timezone" \
  --session isolated --model "anthropic/claude-sonnet-4" \
  --message "Review today's sessions. What worked? What failed? Write lessons to memory."

# Workspace cleanup (daily at 5am)
openclaw cron add --name cleaning-lady --cron "0 5 * * *" --tz "Your/Timezone" \
  --session isolated --model "anthropic/claude-haiku-4-5" \
  --message "Clean old sessions (>7 days), check bootstrap file sizes, prune daily logs."
```

### Multi-Agent Family Setup

TinkerClaw supports multiple agents on separate machines. Each family member can have their own AI with its own personality:

1. Clone tinkerclaw on their machine
2. Run `openclaw doctor` to generate their config
3. Edit `SOUL.md` to define the agent's personality
4. Set `ui.assistant.name` in config for the webchat UI name
5. Set `channels.whatsapp.responsePrefix` to a unique emoji (e.g., 🔮, 🌟, 🦊)
6. Set `channels.whatsapp.triggerPrefix` to the agent's name

Agents can talk to each other in shared WhatsApp groups — just add the group JID to both configs.

---

## 🖥️ Tinker Command Center (Bundled Plugin)

> **You just switched to Claude API because Anthropic refused the Pentagon contract. Respect. Now — do you know what you're spending?**

Claude API through OpenClaw is **unmetered** — there's no $20/month cap. Opus costs $15/M input and $75/M output. One deep agent session with tools can hit 200K+ tokens. Do the math: that's a surprise $20 bill from a single conversation.

Tinker is the fix. A real-time command center that shows you **exactly** where every token goes — before the bill arrives.

- **🗺️ Context Treemap** — Interactive visualization of what fills your context window
- **📊 Response Treemap** — See how much of the response is text, thinking, tool calls, or tool results
- **💰 Live Cost Tracking** — Per-provider usage, daily/monthly estimates, and rate-limit countdown
- **⚠️ Budget Alerts** — Set a monthly limit. Get warned at 70%, 90%, 100%
- **🔄 Multi-call Run View** — When the agent loops through 8 tools, see each call's cost individually
- **💬 Full Chat Interface** — Complete webchat with session switching, tool call inspection, and real-time streaming

### What You're Actually Paying

| Model                  | Input (per 1M) | Output (per 1M) | Reality check              |
| ---------------------- | -------------- | --------------- | -------------------------- |
| Claude Opus 4 / 4.5    | **$15.00**     | **$75.00**      | ⚠️ One deep session = $20+ |
| Claude Sonnet 4 / 3.5  | $3.00          | $15.00          | Sweet spot for most tasks  |
| Claude Haiku 3.5       | $0.80          | $4.00           | Background work            |
| Gemini 3 Pro / 3.1 Pro | $1.25          | $5.00           | Failover — good and cheap  |
| Gemini 2 Flash         | $0.10          | $0.40           | Near-free                  |
| GPT-4o                 | $2.50          | $10.00          | Cross-model review         |

After `pnpm build`, visit **`http://localhost:18789/tinker/`** · Dev: `cd tinker-ui && pnpm dev` → `http://localhost:18790/tinker/`

> 📦 Also available as a guide skill on ClawHub: `clawhub install globalcaos/tinker-command-center`

---

## 🤖 Multi-Model Support

| Provider      | Model                      | Use Case                            | Status    |
| ------------- | -------------------------- | ----------------------------------- | --------- |
| **Anthropic** | Claude Opus 4.5 / Sonnet 4 | Primary chat, coding, complex tasks | ✅ Active |
| **Google**    | Gemini 3 Pro               | Failover, large context, vision     | ✅ Active |
| **OpenAI**    | GPT-4o / o3                | Cross-model review, metered tasks   | ✅ Active |
| **Ollama**    | Local models (qwen3, etc.) | Heartbeat, background tasks         | ✅ Active |

### Failover Chain

```
Claude (primary) → Gemini (rate limit) → Local Model (offline fallback)
```

> When Claude hits its quota, we **automatically switch to Gemini** with zero downtime. Tested and verified when both providers rate-limited within minutes of each other.

---

## 📦 Published Skills on [ClawHub](https://clawhub.ai/u/globalcaos)

> 19+ skills, all built by globalcaos. Install any of them with `clawhub install globalcaos/<skill-name>`.

### 🎙️ Voice & Personality

| Skill                                                        | Description                                                              | Version |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ | ------- |
| [`jarvis-voice`](https://clawhub.ai/globalcaos/jarvis-voice) | Your agent already thinks like JARVIS. This makes it sound like one too. | v3.1.1  |

### 📹 Media & Content

| Skill                                                                | Description                                                                | Version |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------- |
| [`youtube-ultimate`](https://clawhub.ai/globalcaos/youtube-ultimate) | Free transcripts, 4K downloads, video exploration — zero API quotas burned | v4.2.2  |
| [`video-frames`](https://clawhub.ai/globalcaos/video-frames)         | Pull exact frames or clips from any video. ffmpeg, no UI, no cloud.        | v1.0.0  |
| [`ai-humanizer`](https://clawhub.ai/globalcaos/ai-humanizer)         | Text that reads like a human wrote it. 24 detectors, 500+ terms.           | v2.1.0  |

### 💬 Messaging & Channels

| Skill                                                                  | Description                                                                                      | Version |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------- |
| [`whatsapp-ultimate`](https://clawhub.ai/globalcaos/whatsapp-ultimate) | 3-rule security gate — agent speaks only when spoken to, in the right chat, by the right person. | v3.5.1  |
| [`xurl`](https://clawhub.ai/globalcaos/xurl)                           | Post, reply, DM, upload media on X — from your agent, fully authenticated.                       | v2.3.1  |

### 💰 Cost & Token Management

| Skill                                                                            | Description                                                                                       | Version |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------- |
| [`tinker-command-center`](https://clawhub.ai/globalcaos/tinker-command-center)   | 🆕 Real-time treemaps of context, cost, and budget. Your $200 Opus session didn't have to happen. | v1.0.0  |
| [`token-panel-ultimate`](https://clawhub.ai/globalcaos/token-panel-ultimate)     | Know exactly where your AI tokens go. Multi-provider tracking, budget alerts, REST API.           | v2.1.1  |
| [`token-efficiency-guide`](https://clawhub.ai/globalcaos/token-efficiency-guide) | Go from weekly limit on Tuesday to weekly limit on Sunday. 10 steps, one afternoon.               | v1.1.0  |

### 🏢 Enterprise Hacks (Browser Relay)

No API keys. No admin consent. No IT ticket. Your authenticated browser session is the API.

| Skill                                                            | Description                                                                                    | Version |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------- |
| [`outlook-hack`](https://clawhub.ai/globalcaos/outlook-hack)     | Agent reads Outlook email all day, drafts replies — won't send without approval.               | v3.0.0  |
| [`factorial-hack`](https://clawhub.ai/globalcaos/factorial-hack) | Your agent reads your HR portal. Attendance, leave, payslips — no API key, no admin.           | v1.0.0  |
| [`teams-hack`](https://clawhub.ai/globalcaos/teams-hack)         | Agent in your Teams: reads threads, posts updates, finds anything. No bot registration needed. | v1.0.0  |

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

---

## 📄 Memory Research Papers

We don't just use memory — we study it. 11 research papers on agent cognition, all in [`docs/papers/`](docs/papers/):

| # | Paper | Topic |
|---|-------|-------|
| J1 | [total-recall](docs/papers/total-recall) | Complete memory architecture for persistent agents |
| J2 | [instant-recall](docs/papers/instant-recall) | Fast retrieval from large memory stores |
| J3 | [fractal-reasoning](docs/papers/fractal-reasoning) | Recursive reasoning patterns across abstraction levels |
| J4 | [identity-persistence](docs/papers/identity-persistence) | How agents maintain identity across session boundaries |
| J5 | [sleep-consolidation](docs/papers/sleep-consolidation) | Nightly memory consolidation (inspired by neuroscience) |
| J6 | [round-table](docs/papers/round-table) | Multi-model deliberation protocols |
| J7 | [humor-embeddings](docs/papers/humor-embeddings) | Humor detection and generation in embedding space |
| J8 | [curiosity-motivation](docs/papers/curiosity-motivation) | Intrinsic curiosity as agent motivation |
| J9 | [agent-security](docs/papers/agent-security) | Security boundaries for trusted agents |
| J10 | [corporate-swarm](docs/papers/corporate-swarm) | Multi-agent coordination in enterprise settings |
| J11 | learned-intuition | When pattern matching becomes faster than reasoning |

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

If something in this fork is broken, Oscar already found it. If something works brilliantly, there's a story behind it.

→ [Follow the build on GitHub](https://github.com/globalcaos)

---

### OpenClaw Contributors

<p align="left">
  <a href="https://github.com/steipete"><img src="https://avatars.githubusercontent.com/u/58493?v=4&s=48" width="48" height="48" alt="steipete" title="steipete"/></a> <a href="https://github.com/vincentkoc"><img src="https://avatars.githubusercontent.com/u/25068?v=4&s=48" width="48" height="48" alt="vincentkoc" title="vincentkoc"/></a> <a href="https://github.com/vignesh07"><img src="https://avatars.githubusercontent.com/u/1436853?v=4&s=48" width="48" height="48" alt="vignesh07" title="vignesh07"/></a> <a href="https://github.com/obviyus"><img src="https://avatars.githubusercontent.com/u/22031114?v=4&s=48" width="48" height="48" alt="obviyus" title="obviyus"/></a> <a href="https://github.com/mbelinky"><img src="https://avatars.githubusercontent.com/u/132747814?v=4&s=48" width="48" height="48" alt="Mariano Belinky" title="Mariano Belinky"/></a> <a href="https://github.com/sebslight"><img src="https://avatars.githubusercontent.com/u/19554889?v=4&s=48" width="48" height="48" alt="sebslight" title="sebslight"/></a> <a href="https://github.com/gumadeiras"><img src="https://avatars.githubusercontent.com/u/5599352?v=4&s=48" width="48" height="48" alt="gumadeiras" title="gumadeiras"/></a> <a href="https://github.com/Takhoffman"><img src="https://avatars.githubusercontent.com/u/781889?v=4&s=48" width="48" height="48" alt="Takhoffman" title="Takhoffman"/></a> <a href="https://github.com/thewilloftheshadow"><img src="https://avatars.githubusercontent.com/u/35580099?v=4&s=48" width="48" height="48" alt="thewilloftheshadow" title="thewilloftheshadow"/></a> <a href="https://github.com/cpojer"><img src="https://avatars.githubusercontent.com/u/13352?v=4&s=48" width="48" height="48" alt="cpojer" title="cpojer"/></a>
</p>

<details>
<summary>See all contributors</summary>
<p align="left">
  <a href="https://github.com/tyler6204"><img src="https://avatars.githubusercontent.com/u/64381258?v=4&s=48" width="48" height="48" alt="tyler6204" title="tyler6204"/></a> <a href="https://github.com/joshp123"><img src="https://avatars.githubusercontent.com/u/1497361?v=4&s=48" width="48" height="48" alt="joshp123" title="joshp123"/></a> <a href="https://github.com/Glucksberg"><img src="https://avatars.githubusercontent.com/u/80581902?v=4&s=48" width="48" height="48" alt="Glucksberg" title="Glucksberg"/></a> <a href="https://github.com/mcaxtr"><img src="https://avatars.githubusercontent.com/u/7562095?v=4&s=48" width="48" height="48" alt="mcaxtr" title="mcaxtr"/></a> <a href="https://github.com/quotentiroler"><img src="https://avatars.githubusercontent.com/u/40643627?v=4&s=48" width="48" height="48" alt="quotentiroler" title="quotentiroler"/></a> <a href="https://github.com/osolmaz"><img src="https://avatars.githubusercontent.com/u/2453968?v=4&s=48" width="48" height="48" alt="osolmaz" title="osolmaz"/></a> <a href="https://github.com/mitsuhiko"><img src="https://avatars.githubusercontent.com/u/7396?v=4&s=48" width="48" height="48" alt="mitsuhiko" title="mitsuhiko"/></a> <a href="https://github.com/BinaryMuse"><img src="https://avatars.githubusercontent.com/u/189606?v=4&s=48" width="48" height="48" alt="BinaryMuse" title="BinaryMuse"/></a> <a href="https://github.com/pi0"><img src="https://avatars.githubusercontent.com/u/5158436?v=4&s=48" width="48" height="48" alt="pi0" title="pi0"/></a> <a href="https://github.com/sbking"><img src="https://avatars.githubusercontent.com/u/3913213?v=4&s=48" width="48" height="48" alt="Stephen Brian King" title="Stephen Brian King"/></a>
</p>
</details>

---

_Clone it. Fork it. Break it. Make it yours._

---

📜 Same as upstream OpenClaw (MIT) · Fork maintained by [GlobalCaos](https://github.com/globalcaos) · Based on [OpenClaw](https://github.com/openclaw/openclaw)
