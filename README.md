<p align="center">
    <img src="docs/assets/tinkerzone-logo.png" alt="TinkerClaw" width="300">
</p>

# 🔧 TinkerClaw

**OpenClaw, obsessively optimized.** Token tracking. Self-improving agents. Memory that actually works.

[![Based on OpenClaw](https://img.shields.io/badge/based%20on-OpenClaw-blue?style=for-the-badge)](https://github.com/openclaw/openclaw)
[![Platform](https://img.shields.io/badge/platform-Ubuntu%20%2F%20Linux-orange?style=for-the-badge)](https://ubuntu.com)
[![AI Models](https://img.shields.io/badge/AI-Claude%20%7C%20GPT%20%7C%20Gemini%20%7C%20Ollama-green?style=for-the-badge)](#-multi-model-support)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

> Your $200 Opus session didn't have to happen.

A personal fork of [OpenClaw](https://github.com/openclaw/openclaw) — the multi-channel, multi-model AI assistant you run on your own devices. We take everything upstream does and add the things we kept wishing it had. Because we are that obsessive.

---

## What TinkerClaw Adds

- 🧠 **ENGRAM compaction** — silent context management, no annoying compaction events. Ships as default.
- 🔍 **Hippocampus memory indexing** — your agent builds long-term memory automatically. Enabled by default.
- 🧲 **Memory search with semantic embeddings** — find anything across sessions. Enabled by default.
- 💰 **Budget panel** — real-time token cost tracking so you know what each session costs before the bill arrives.
- 🗺️ **Tinker UI** — context treemaps, session management, cost dashboard. See exactly where your tokens go.
- 🔄 **Self-improving cron agents** — wind-down, morning briefing, cleaning-lady. Day 1 mediocre → Day 30 expert.
- 👨‍👩‍👧 **Multi-agent family support** — Jarvis, Mia, Lia running on separate machines, talking in shared groups.
- 🌙 **Nightly upstream sync** — stays current automatically. Never falls behind.

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

## Multi-Model Support

We run multiple AI providers for resilience and capability:

| Provider      | Models                     | Use Case                            |
| ------------- | -------------------------- | ----------------------------------- |
| **Anthropic** | Claude Opus 4, Sonnet 4    | Primary chat, coding, complex tasks |
| **OpenAI**    | GPT-4.1, o3                | Cross-model review, second opinions |
| **Google**    | Gemini 3 Pro, Flash        | Failover, large context, vision     |
| **Ollama**    | Local models (qwen3, etc.) | Heartbeat, background, offline      |

### Smart Routing & Fallback

```
Claude (primary) → Gemini (rate limit) → Local Model (offline fallback)
```

Flat-rate models first, metered only when justified. Budget pressure respected at all times. When Claude hits its quota, we automatically switch to Gemini with zero downtime.

---

## Fork Architecture

### How We Stay Current

- **Nightly fork-sync** — automated merge from upstream with guardian checks
- **Cleaning-lady cron** — auto-distills workspace files post-merge
- **FORK_PATCHES.md** — registry of all fork-specific changes
- **Full upstream history preserved** — we diverge in features, not in lineage

The fork never falls behind. If something breaks in a merge, the guardian catches it before it ships.

---

## Memory Research

We don't just use memory — we study it. Active research into agent memory consolidation, retrieval, and identity persistence.

Research papers are in [`docs/papers/`](docs/papers/):

| Paper                                                    | Topic                             |
| -------------------------------------------------------- | --------------------------------- |
| [agent-security](docs/papers/agent-security)             | Agent security boundaries         |
| [corporate-swarm](docs/papers/corporate-swarm)           | Corporate multi-agent swarms      |
| [curiosity-motivation](docs/papers/curiosity-motivation) | Curiosity-driven agent motivation |
| [fractal-reasoning](docs/papers/fractal-reasoning)       | Fractal reasoning patterns        |
| [humor-embeddings](docs/papers/humor-embeddings)         | Humor in embedding space          |
| [identity-persistence](docs/papers/identity-persistence) | Agent identity across sessions    |
| [instant-recall](docs/papers/instant-recall)             | Fast memory retrieval             |
| [round-table](docs/papers/round-table)                   | Multi-model deliberation          |
| [sleep-consolidation](docs/papers/sleep-consolidation)   | Sleep-cycle memory consolidation  |
| [total-recall](docs/papers/total-recall)                 | Complete memory architecture      |

---

## Upstream

TinkerClaw is built on top of [OpenClaw](https://github.com/openclaw/openclaw) — a personal AI assistant platform that supports WhatsApp, Telegram, Slack, Discord, WebChat, and more.

For full feature list, channels, platform guides, and documentation, see **[upstream OpenClaw](https://github.com/openclaw/openclaw)** · [Website](https://openclaw.ai) · [Docs](https://docs.openclaw.ai) · [Getting Started](https://docs.openclaw.ai/start/getting-started)

---

## Contributing

We welcome tinkerers. If you've got an idea for making AI assistants more capable, cost-aware, or memory-rich — open a PR or start a discussion.

- Fork-specific improvements go here
- Upstream-worthy fixes get contributed back
- We document everything for newcomers

---

## Community

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

## License

Same as upstream OpenClaw (MIT).

---

_Fork maintained by [GlobalCaos](https://github.com/globalcaos) · Based on [OpenClaw](https://github.com/openclaw/openclaw)_
