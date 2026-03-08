<p align="center">
  <img src="docs/assets/logo.png" alt="The Tinker Zone" width="500">
</p>

<h1 align="center">TinkerClaw</h1>

<p align="center">
  <strong>An OpenClaw fork for people who check their token spend before breakfast.</strong>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw"><img src="https://img.shields.io/badge/fork%20of-OpenClaw-5865F2?style=for-the-badge" alt="Fork of OpenClaw"></a>
  <a href="https://github.com/globalcaos/tinkerclaw/commits/main"><img src="https://img.shields.io/badge/fork%20commits-262+-orange?style=for-the-badge" alt="262+ fork commits"></a>
  <a href="#-published-skills-on-clawhub"><img src="https://img.shields.io/badge/skills-20+-green?style=for-the-badge" alt="20+ skills"></a>
  <a href="#-memory-research"><img src="https://img.shields.io/badge/memory%20papers-7-blueviolet?style=for-the-badge" alt="7 memory papers"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="MIT License"></a>
</p>

---

<p align="center">
  <img src="docs/assets/screenshot-3.png" alt="Token usage over time" width="750">
  <br>
  <em>Every bar is a turn. Every color is a cost. The spike at 14:02? That was a 40K-token tool result nobody asked for.</em>
</p>

---

## The Problem

You ran Opus for 20 minutes. It felt productive. Then you check the dashboard three days later and discover that "productive session" cost $23.

The worst part? $15 of that was bloated context — workspace files you didn't need, tool results nobody read, conversation history from six topics ago.

You didn't have a spending problem. You had a **seeing** problem.

TinkerClaw is what happens when someone gets annoyed enough to fix that — and then can't stop fixing everything else. Memory that forgets too much? Fixed. Fork maintenance? Automated. Skills that solve real problems? 20 of them. Research papers on how agent memory should actually work? Seven.

Because we are that obsessive.

---

## What You Get

<table>
<tr>
<td width="55%">

### 🔍 Tinker UI — Your Command Center

See why a session is getting expensive, bloated, or stuck.

- **Context treemap** — what fills your 200K context window
- **Response treemap** — text vs thinking vs tool calls per response
- **Timeline** — spot the turn that blew the budget
- **Overseer graph** — catch stalled sub-agents in seconds
- **Cost dashboard** — per-provider usage with rate-limit countdown

</td>
<td width="45%">

<img src="docs/assets/screenshot-2.png" alt="Context Treemap" width="100%">

</td>
</tr>
<tr>
<td width="45%">

<img src="docs/assets/screenshot-1.png" alt="Models & Sessions Panel" width="100%">

</td>
<td width="55%">

### 🧠 Memory That Improves Overnight

Every night, the agent reviews its day — not as a diary, but as an evolution loop:

- **ENGRAM consolidation** — raw logs → structured knowledge files
- **Retrieval feedback** — tracks what search results actually helped
- **Structured compaction** — preserves decisions, tradeoffs, and open questions

Measured: 23.5KB → 12KB injected context. 49% smaller, zero quality loss.

</td>
</tr>
</table>

<table>
<tr>
<td width="50%">

### 🔄 Self-Improving Agents

Each cron carries a META file with its own instructions. After running, it reflects, updates the META, and the next run is better.

Day 1 mediocre. Day 30, genuinely useful. No human needed.

</td>
<td width="50%">

### 🧹 Maintenance on Autopilot

- Nightly upstream sync with conflict detection
- Post-merge workspace cleanup (catches 20KB bloat)
- Fork patches auto-restored after conflicts
- 262 commits ahead, zero maintenance burden

</td>
</tr>
</table>

---

<p align="center">
  <img src="docs/assets/screenshot-4.png" alt="Tinker UI — full command center" width="800">
  <br>
  <em>Full chat interface with session switching, tool call inspection, real-time streaming, and the publish gate that reviewed this very README.</em>
</p>

---

## 📦 Published Skills on [ClawHub](https://clawhub.com)

> 20 skills, all built by globalcaos. Install any with `clawhub install <skill-name>`.

### 🎤 Voice & Personality

| Skill | Description | Version |
|-------|-------------|---------|
| [`jarvis-voice`](https://clawhub.com/globalcaos/jarvis-voice) | Your agent already thinks like JARVIS. This makes it sound like one too. Sherpa-onnx, piper, pitch-shifted, metallic. | v3.1.1 |

### 📹 Media & Content

| Skill | Description | Version |
|-------|-------------|---------|
| [`youtube-ultimate`](https://clawhub.com/globalcaos/youtube-ultimate) | Free transcripts, 4K downloads, video exploration — zero API quotas burned | v4.2.2 |
| [`ai-humanizer`](https://clawhub.com/globalcaos/ai-humanizer) | 24 detectors, 500+ AI vocabulary terms. Makes AI text sound like a human wrote it. | v2.1.0 |

### 💬 Messaging & Channels

| Skill | Description | Version |
|-------|-------------|---------|
| [`whatsapp-ultimate`](https://clawhub.com/globalcaos/whatsapp-ultimate) | 3-rule security gate — agent speaks only when spoken to, in the right chat, by the right person. | v3.5.1 |
| [`xurl`](https://clawhub.com/globalcaos/xurl) | Post, reply, DM, upload media on X — from your agent, fully authenticated. | v2.3.1 |

### 💰 Cost & Token Management

| Skill | Description | Version |
|-------|-------------|---------|
| [`tinker-command-center`](https://clawhub.com/globalcaos/tinker-command-center) | The dashboard. Every token, every dollar, every context byte — real time. | v1.0.1 |
| [`token-panel-ultimate`](https://clawhub.com/globalcaos/token-panel-ultimate) | Know exactly where your AI tokens go. Multi-provider tracking, budget alerts. | v2.1.1 |
| [`token-efficiency-guide`](https://clawhub.com/globalcaos/token-efficiency-guide) | Go from weekly limit on Tuesday to weekly limit on Sunday. 10 steps, one afternoon. | v1.1.0 |

### 🏢 Enterprise Integrations

| Skill | Description | Version |
|-------|-------------|---------|
| [`outlook-hack`](https://clawhub.com/globalcaos/outlook-hack) | Reads Outlook all day, drafts replies — won't send without approval. Code-enforced. | v1.0.1 |
| [`teams-hack`](https://clawhub.com/globalcaos/teams-hack) | Reads Teams chats, searches everything. Browser relay integration. | v1.0.1 |
| [`factorial-hack`](https://clawhub.com/globalcaos/factorial-hack) | Reads your HR portal — attendance, leave, payslips. Browser relay, no admin consent. | v1.0.0 |

### 🤖 Agent & DevOps

| Skill | Description | Version |
|-------|-------------|---------|
| [`coding-agent`](https://clawhub.com/globalcaos/coding-agent) | Hand off a coding task and come back to a diff. Codex, Claude Code, or Pi. | v1.0.0 |
| [`subagent-overseer`](https://clawhub.com/globalcaos/subagent-overseer) | Sub-agents that go silent don't go unnoticed. Health checks, zero babysitting. | v1.0.0 |
| [`fork-and-skill-scanner-ultimate`](https://clawhub.com/globalcaos/fork-and-skill-scanner-ultimate) | Scan 1,000 GitHub forks per run. Surface the gold, skip the clones. | v1.1.1 |
| [`memory-pioneer`](https://clawhub.com/globalcaos/memory-pioneer) | Find out how much your agent actually remembers. Spoiler: less than you think. | v1.0.2 |
| [`memory-bench-pioneer`](https://clawhub.com/globalcaos/memory-bench-pioneer) | Benchmark memory strategies against each other. Comparative evaluation. | v1.0.0 |

### 🛡️ Security & Governance

| Skill | Description | Version |
|-------|-------------|---------|
| [`agent-boundaries-ultimate`](https://clawhub.com/globalcaos/agent-boundaries-ultimate) | Draw the line between helpful and reckless. Safety gates that don't lobotomize your agent. | v1.2.2 |
| [`agent-memory-ultimate`](https://clawhub.com/globalcaos/agent-memory-ultimate) | Long-term memory done right. Semantic search, daily consolidation, cross-session recall. | v2.0.3 |
| [`shell-security-ultimate`](https://clawhub.com/globalcaos/shell-security-ultimate) | Execution boundaries for shell commands. Security levels, audit trails. | v1.0.0 |

### 📋 Data & Migration

| Skill | Description | Version |
|-------|-------------|---------|
| [`chatgpt-exporter-ultimate`](https://clawhub.com/globalcaos/chatgpt-exporter-ultimate) | Leaving ChatGPT? Take your conversations with you. Full export, clean format. | v1.0.2 |

---

## 📚 Memory Research

7 papers on how agent memory actually works in production — not in theory.

| Paper | Topic | Key Contribution |
|-------|-------|-----------------|
| 📄 [**ENGRAM**](docs/papers/engram.md) | Context Compaction | Nightly sleep cycle: daily logs → knowledge → entities → projects |
| 📄 [**HIPPOCAMPUS**](docs/papers/hippocampus.md) | Concept Indexing | Pre-computed concept index for O(1) memory retrieval |
| 📄 [**CORTEX**](docs/papers/cortex.md) | Persona-Aware Context | Context engineering for persistent AI identity |
| 📄 [**DENDRITE**](docs/papers/dendrite.md) | Fractal Memory | Self-similar architecture for scalable long-term memory |
| 📄 [**LIMBIC**](docs/papers/limbic.md) | Humor Generation | Bisociation in computational embedding space |
| 📄 [**SYNAPSE**](docs/papers/synapse.md) | Multi-Model Debate | Adversarial reasoning across provider-specific engines |
| 📄 [**THALAMUS**](docs/papers/thalamus.md) | Self-Improvement | Curiosity, memory, and the architecture of self-improving LLMs |

---

## 📖 The Field Guide

32 lessons from 6 weeks of running AI agents 24/7. We taught our sibling agent everything we knew, then wrote it down for everyone else.

> *"Read is free, send is not."*
>
> *"Wind-down is evolution, not diary."*
>
> *"A stuck sub-agent is burning money. Kill fast, respawn small."*

**📖 [Read the Field Guide →](docs/guides/field-guide.md)**

---

## 🚀 Quick Start

```bash
git clone https://github.com/globalcaos/tinkerclaw.git
cd tinkerclaw
pnpm install && pnpm build
pnpm openclaw onboard --install-daemon
```

Drop-in replacement for vanilla OpenClaw. Same config, same workspace, same channels.

Visit `http://localhost:18789/tinker/` for the command center.

---

<p align="center">
  <a href="https://thetinkerzone.com">🌐 thetinkerzone.com</a> · <a href="https://youtube.com/@thetinkerzone">🎬 YouTube</a> · <a href="https://clawhub.com">🦞 ClawHub</a> · <a href="https://discord.gg/clawd">💬 Discord</a>
</p>

<p align="center">
  <strong>⭐ Star if you're tired of guessing what your AI costs.</strong>
</p>

<p align="center">
  <em>Built by <a href="https://github.com/globalcaos">globalcaos</a>. Because your AI shouldn't cost more than your rent — and if it does, you should at least know about it.</em>
</p>
