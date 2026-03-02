<p align="center">
    <img src="docs/assets/tinkerzone-logo.png" alt="The Tinker Zone" width="300">
</p>

# 🦎 GlobalCaos OpenClaw Fork

**A trust-first, Ubuntu-optimized fork of OpenClaw with enhanced AI capabilities.**

[![Based on OpenClaw](https://img.shields.io/badge/based%20on-OpenClaw-blue?style=for-the-badge)](https://github.com/openclaw/openclaw)
[![Platform](https://img.shields.io/badge/platform-Ubuntu%20%2F%20Linux-orange?style=for-the-badge)](https://ubuntu.com)
[![AI Models](https://img.shields.io/badge/AI-Claude%20%7C%20Gemini%20%7C%20Ollama-green?style=for-the-badge)](#-multi-model-support)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

> **What is OpenClaw?** A personal AI assistant you run on your own devices — multi-channel (WhatsApp, Telegram, Slack, Discord, WebChat, and more), multi-model, always-on.
> For upstream docs, install guides, and full feature list see the **[upstream OpenClaw repository](https://github.com/openclaw/openclaw)**.

---

## 🎯 Why This Fork?

This fork is built by **Oscar Serra**, an inventor and AI enthusiast who believes in giving AI assistants **full access** to be truly helpful. We take a **trust-first approach** — no sandboxing, no artificial restrictions, just a capable AI partner.

> _"An AI assistant with no access is just a search engine with extra steps."_

We believe:

- **Trust first, restrict later** (if ever needed)
- **Multi-model resilience** — never be stuck when one provider rate-limits you
- **Cost awareness** — see every token, every dollar, in real time
- **Linux-native** — optimized for Ubuntu, not an afterthought
- **Community-driven** — we document everything for newcomers

---

## ✨ What's Different Here?

### 🔐 Security Patches Applied

All critical upstream security PRs cherry-picked and verified:

| PR        | Fix                        | Status     |
| --------- | -------------------------- | ---------- |
| **#7769** | DNS Rebinding Protection   | ✅ Applied |
| **#7616** | Zip Path Traversal Fix     | ✅ Applied |
| **#7704** | WebSocket Auth Enforcement | ✅ Applied |

### 🧠 Smart Model Management

- **Smart Router V2** (#7770) — Auto-selects the best model for each task
- **Rate Limiting** (#7644) — Prevents runaway API costs
- **Anthropic Failover** — Auto-switches to Gemini when Claude hits quota (tested & verified!)
- **OAuth PKCE Flow** — Proper token refresh for Anthropic subscriptions (no more expired tokens)

### 📦 Enhanced Skills

| Skill              | Description                                       | Status       |
| ------------------ | ------------------------------------------------- | ------------ |
| `youtube-ultimate` | FREE transcripts (no API cost!) + video downloads | ✅ v2.0      |
| `google-sheets`    | Content calendars, spreadsheet automation         | ✅ Installed |
| `healthcheck`      | System security auditing                          | ✅ Installed |

### 🔧 Fork Fixes

| Fix                   | Description                                           | Status        |
| --------------------- | ----------------------------------------------------- | ------------- |
| Anthropic failover    | Auto-switch to Gemini on rate limit                   | ✅ Verified   |
| Anthropic OAuth       | PKCE flow with refresh token                          | ✅ Fixed      |
| Heartbeat isolation   | Runs in separate session — no webchat pollution       | ✅ Fixed      |
| Config schema merge   | Re-adds fork Zod keys wiped by upstream merges        | ✅ Fixed      |
| Prompt queue deadlock | Workaround for upstream session lane deadlock (#7630) | ✅ Workaround |

### 🐧 Ubuntu-Native

- Tested on Ubuntu 22.04 / 24.04
- Systemd service examples included
- Works with `deja-dup` for backups
- No macOS-only skills (we removed Bear Notes)

---

## 🖥️ Tinker Command Center (Bundled Plugin)

> **Know exactly what you're spending before the bill arrives.**

If you've used Opus or other premium models through the API, you know the feeling: a single long conversation can burn through **$20+ in tokens** without any warning. Tinker is a **bundled OpenClaw plugin** that gives you a real-time command center so every token is visible and you stay in control.

### What it does

- **🗺️ Context Treemap** — Interactive squarified treemap showing exactly what fills your context window: system prompt sections, conversation history, tool results, and their relative sizes. Drill down from categories to individual messages to raw text.
- **📊 Response Treemap** — Same visualization for model output: see how much of the response is text, thinking, tool calls, or tool results, per LLM call within a run.
- **💰 Live Cost Tracking** — Per-provider token usage, daily/monthly cost estimates, and the 5-hour Claude rate-limit window with countdown timer.
- **⚠️ Budget Alerts** — Set spending limits and get warnings before you blow through them.
- **🔄 Multi-call Run View** — When the agent makes multiple LLM calls in a single run (tool loops, retries), see each call's context and cost individually.
- **💬 Chat + Session Management** — Full webchat interface with session switching, tool call inspection, and real-time streaming.

### 💸 Supported Models & Pricing

> These are the API costs you're actually paying. Tinker tracks them in real time.

| Model                  | Input (per 1M tokens) | Output (per 1M tokens) | Notes                          |
| ---------------------- | --------------------- | ---------------------- | ------------------------------ |
| Claude Opus 4 / 4.5    | **$15.00**            | **$75.00**             | ⚠️ Premium — watch your usage! |
| Claude Sonnet 4 / 3.5  | $3.00                 | $15.00                 | Best price/performance ratio   |
| Claude Haiku 3.5       | $0.80                 | $4.00                  | Fast, cheap tasks              |
| Gemini 3 Pro / 3.1 Pro | $1.25                 | $5.00                  | Great failover option          |
| Gemini 2 Flash         | $0.10                 | $0.40                  | Budget-friendly                |
| Gemini 2 Flash Lite    | $0.02                 | $0.08                  | Near-free for simple tasks     |

> Other models use Sonnet-tier pricing as a conservative default.

### Access

After `pnpm build`, visit **`http://localhost:18789/tinker/`**

For development: `cd tinker-ui && pnpm dev` → **`http://localhost:18790/tinker/`**

---

## 🤖 Multi-Model Support

We run **multiple AI providers** for resilience and capability:

| Provider      | Model                      | Use Case                            | Status    |
| ------------- | -------------------------- | ----------------------------------- | --------- |
| **Anthropic** | Claude Opus 4.5 / Sonnet 4 | Primary chat, coding, complex tasks | ✅ Active |
| **Google**    | Gemini 3 Pro               | Failover, large context, vision     | ✅ Active |
| **Ollama**    | Local models (qwen3, etc.) | Heartbeat, background tasks         | ✅ Active |

### Failover Chain

```
Claude (primary) → Gemini (rate limit) → Local Model (offline fallback)
```

> When Claude hits its quota, we **automatically switch to Gemini** with zero downtime. This was tested and verified on 2026-02-03 when both providers rate-limited within minutes of each other!

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

> This builds everything including the Tinker UI plugin.

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

Then visit **`http://localhost:18789/tinker/`** for the command center, or connect via WhatsApp/Telegram/Discord.

### 6. Let the AI Guide You

Once connected, ask your AI:

> _"Read FORK.md and help me configure the remaining features."_

The AI will walk you through enabling WhatsApp, skills, and optimizations.

---

## 📋 Configuration Highlights

### Trust-First WhatsApp Access

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+YOUR_NUMBER"],
      "syncFullHistory": true,
      "groups": { "*": { "requireMention": false } }
    }
  }
}
```

### Budget Awareness

```json
{
  "budget": {
    "monthlyLimitUsd": 200,
    "warningThresholdPercent": 70
  }
}
```

---

## 🛠️ What We're Working On

- [ ] WhatsApp full history sync (PR in progress)
- [ ] YouTube Ultimate v2.0 with yt-dlp downloads
- [ ] LanceDB hybrid memory (#7695 + #7636)
- [ ] Browser cookies action (#7635)
- [ ] "The Tinker Zone" YouTube channel tutorials

---

## 📱 WhatsApp Full History (Coming Soon)

We're enabling Baileys' full history sync — your AI will have access to all your WhatsApp messages, not just new ones. **Opt-in via config.**

---

## 📚 Upstream Documentation

For everything not fork-specific — install methods, architecture, security model, channel setup, skills development, and more:

> **[OpenClaw upstream repository & docs](https://github.com/openclaw/openclaw)** · [Website](https://openclaw.ai) · [Docs](https://docs.openclaw.ai) · [Getting Started](https://docs.openclaw.ai/start/getting-started) · [FAQ](https://docs.openclaw.ai/help/faq)

---

## 🤝 Contributing

We welcome contributions! This fork is about:

1. **Documenting everything** — Help newcomers get started
2. **Testing on Linux** — Ubuntu is our primary platform
3. **Trust-first features** — Expanding AI capabilities, not restricting them
4. **Cost transparency** — Making AI spending visible and controllable

> We **upstream security fixes** (and cherry-pick them quickly), **experiment freely** with features that might be too aggressive for upstream, and **document our journey** so others can learn.

---

## 👤 About the Maintainer

**Oscar Serra** — Telecom engineer, inventor, and AI enthusiast based in Barcelona. Building "The Tinker Zone" to document the journey of creating truly helpful AI assistants.

- 🧠 Philosophy: Trust first, Bashar-inspired (follow your highest excitement)
- 🐧 Setup: Ubuntu on MSI Creator laptop, Claude + Gemini + Ollama
- 🎯 Goal: AI that knows you, helps you, and grows with you

---

## 📜 License

Same as upstream OpenClaw (MIT).

---

_Fork maintained by [GlobalCaos](https://github.com/globalcaos) · Based on [OpenClaw](https://github.com/openclaw/openclaw)_
