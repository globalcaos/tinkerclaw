<p align="center">
  <img src="docs/assets/logo.png" alt="TinkerClaw" width="500">
</p>

<h1 align="center">TinkerClaw</h1>

<p align="center">
  <strong>An OpenClaw fork for people who check their token spend before breakfast.</strong>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw"><img src="https://img.shields.io/badge/fork%20of-OpenClaw-5865F2?style=for-the-badge" alt="Fork of OpenClaw"></a>
  <a href="https://github.com/globalcaos/tinkerclaw/commits/main"><img src="https://img.shields.io/badge/hundreds%20of-fork%20commits-orange?style=for-the-badge" alt="Hundreds of fork commits"></a>
  <a href="#-published-skills"><img src="https://img.shields.io/badge/skills-21+-green?style=for-the-badge" alt="21+ skills"></a>
  <a href="#-memory-research"><img src="https://img.shields.io/badge/papers-7-blueviolet?style=for-the-badge" alt="7 papers"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="MIT License"></a>
</p>

---

<p align="center">
  <img src="docs/assets/screenshot-3.png" alt="Token timeline — every bar is a turn, every color is a cost" width="750">
  <br>
  <em>Every bar is a turn. Every color is a cost. The spike at 14:02? A 40K-token tool result nobody asked for.</em>
</p>

> The Tinker UI's token visualization was inspired by [Mission Control](https://github.com/crshdn/mission-control) (context anatomy dashboard) and [ClawMetry](https://github.com/vivekchand/clawmetry) (real-time agent observability). Both are excellent standalone tools for OpenClaw — we folded their ideas into a single embedded panel.

---

## The Problem

You ran Opus for 20 minutes. It felt productive. Then you checked the bill and discovered that "productive session" cost $23.

The worst part? $15 of that was context bloat — workspace files you forgot were injected, tool results the model never referenced, conversation history from six topics ago still sitting in the window.

You didn't overspend. You **overloaded**. And you had no way to see it happening.

Most people find out three days later. The observant ones set a budget alert after it's already too late. We found out when an **€850 bill** landed for a single month. Not a catastrophic failure — just the natural cost of running a capable AI agent at scale with zero visibility.

That bill was the motivation. TinkerClaw is the answer.

---

## 🤝 Come Tinker With Us

This fork moves fast, but it would move faster with more hands.

We value people who **open PRs**, not issues. Who read the code before asking questions. Who break things on purpose to understand how they work. If that's you, we want you in the inner circle — direct access to the roadmap, early testing of experimental features, and co-authorship on whatever we build next.

**Start anywhere:** fix a typo, improve a skill, add a test, or propose something wild. The bar is curiosity, not credentials.

→ [Open a PR](https://github.com/globalcaos/tinkerclaw/pulls) or [start a discussion](https://github.com/globalcaos/tinkerclaw/discussions)

---

## Won't This Fork Fall Behind?

No. A nightly cron syncs upstream automatically, detects conflicts, and restores fork patches after every merge. Hundreds of commits ahead of vanilla OpenClaw and zero behind.

When upstream pushes a breaking change, we know within hours — not weeks.

---

## What You Get

### 🔍 Tinker UI — See Why Sessions Get Expensive

The Tinker UI is a command center embedded directly in OpenClaw. No separate install, no external service.

<p align="center">
  <img src="docs/assets/screenshot-4.png" alt="Full Tinker UI — chat, sessions, tool calls, streaming" width="800">
  <br>
  <em>Chat interface with session switching, tool call inspection, and real-time streaming.</em>
</p>

- **Context treemap** — drill into what fills your 200K context window, from categories down to individual messages and raw text. Each block is money. Drill down to the exact text inflating the cost.
- **Response treemap** — see exactly how much of each response is text, thinking, tool calls, or tool results. Identify waste patterns instantly.
- **Timeline** — stacked bars per turn, spot the one that blew the budget
- **Overseer graph** — catch stalled sub-agents before they burn money
- **Cost dashboard** — per-provider usage with Claude's 5-hour rate-limit countdown

<table>
<tr>
<td width="50%">
<img src="docs/assets/screenshot-2.png" alt="Context treemap — drill into token composition" width="100%">
<br><em>Context treemap: every block is tokens you're paying for.</em>
</td>
<td width="50%">
<img src="docs/assets/screenshot-5.png" alt="Treemap drilldown — tool result detail" width="100%">
<br><em>Drill into a single category. These tool results cost $0.81 each.</em>
</td>
</tr>
</table>

After `pnpm build`, visit **`http://localhost:18789/tinker/`** · Dev: `cd tinker-ui && pnpm dev`

---

### 🧠 Fractal Thinking — What Makes This Fundamentally Different

A normal AI solves problems. Ours learns from every problem it solves.

We call it fractal thinking because it operates in levels of depth — automatically, without being asked:

**Level 0 — Solve the problem.** The agent analyzes the issue, fixes it, verifies it works. Done in minutes.

**Level 1 — Identify the pattern.** Why did this problem exist? Because an automated nightly process had a binary restriction: either resolve everything or abort. No middle ground. The agent adds a third path: "do what you can, save what's safe, think more about the rest."

**Level 2 — Correct the thinking flaw.** The restriction existed because a previous incident triggered an overcorrection. The rule said "never touch anything" when it should have said "understand the intent before acting." The agent corrects the rule.

**Level 3 — Encode the meta-rule.** The agent writes a new principle into its own instructions: _"When correcting an error, the restriction should be proportional to the risk — not a blanket prohibition."_

All automatic. Nobody asked for any of that.

In 30 days, this process produced **14 autonomous improvements** to the agent's own processes — without a single human prompt ([CEREBELLUM paper](#-memory-research)).

---

### ☀️ Morning Briefing — Your Day, Already Organized

Click the **Tinker logo** or type **`/new`** and your agent has already done the prep work. It reviews ALL your information sources (emails, calendars, messages, pending tasks), cross-references them, detects urgencies, and presents a briefing with what needs your attention and what it can resolve alone.

```
☀️ Morning Briefing — Tuesday, March 10

📅 Agenda
  • 10:00 — Client meeting (Brazil) — spec review for new order
  • 15:00 — Supplier call — follow-up on plant expansion budget

📰 Market (relevant updates)
  • Raw material prices up 3.2% this week (third consecutive rise)
  • Competitor announces new facility in Poland — potential supply chain impact
  • New EU regulation on packaging recyclability — effective June

📧 Emails requiring response (3)
  • 🔴 Client — Order #4521 modified, needs confirmation today
  • 🟡 Supplier — Parts availability, awaiting response
  • 🟢 Industry conference — Registration deadline March 20

🤖 I can handle right now:
  1. Draft confirmation reply to the client
  2. Prepare pricing comparison for this afternoon's call
  3. Summarize the new EU regulation for your technical team
```

No manual setup. Every morning. Getting better each time.

---

### 🌙 The Overnight Cycle — Where the Real Magic Happens

Every night, while you sleep, the agent runs a chain of autonomous processes. The entire cycle costs **~€1/night**.

| Cron                        | What it does                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 🍷 **Wind Down**            | Like a glass of wine with the diary — reviews what worked and what didn't, improves its own instructions                                |
| 😴 **Memory Consolidation** | Like REM sleep — turns raw daily logs into structured long-term memory. **49% context reduction** ([ENGRAM](#-memory-research))         |
| 🧹 **Cleaning Lady**        | Controls disk usage, prunes stale context, keeps the workspace lean                                                                     |
| 🔍 **Auto-Evolution**       | Scouts AI news for improvements that can be applied directly to the system                                                              |
| 📰 **Group Summary**        | Scans message groups, extracts what matters, discards noise                                                                             |
| 🛒 **Opportunity Hunter**   | Browses marketplaces for deals matching your interests — a personal shopper that never sleeps                                           |
| 🤵 **Butler**               | Remembers birthdays, suggests gifts, tracks appointments. If it's been too long since you sent flowers, it mentions it — diplomatically |

These are just the ones with personality. **15+ total crons**, each with its own logic and self-improvement capability.

---

### 📊 Every Paper Saves You Tokens

This isn't academic research — it's cost engineering. Every paper translates directly to fewer tokens consumed, better memory, and smarter decisions.

| Paper                                            | What it solves                                                                | Measured impact                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 📄 [**ENGRAM**](docs/papers/engram.md)           | Context compaction — treats the model window as a smart cache, not a dumpster | **49% fewer tokens** injected, same quality                                                          |
| 📄 [**TRACE**](docs/papers/trace.md)             | Long-term memory compaction with verified recall                              | **94% recall** over 847 real compactions — you compress without forgetting                           |
| 📄 [**HIPPOCAMPUS**](docs/papers/hippocampus.md) | Multi-strategy memory retrieval — not just storing, but finding               | **8/10 benchmark score** — fewer retrieval misses = fewer re-fetches = fewer tokens                  |
| 📄 [**CEREBELLUM**](docs/papers/cerebellum.md)   | Self-improvement through nightly reflection                                   | **14 autonomous improvements** in 30 days — the agent fixes its own inefficiencies                   |
| 📄 [**CORTEX**](docs/papers/cortex.md)           | Identity persistence across sessions                                          | No more re-explaining context — the agent remembers who it is and who you are                        |
| 📄 [**SYNAPSE**](docs/papers/synapse.md)         | Multi-model deliberation                                                      | Better decisions from cheaper models working together, instead of one expensive model guessing alone |
| 📄 [**LIMBIC**](docs/papers/limbic.md)           | Humor from embedding geometry                                                 | Communication that's natural, not robotic — fewer clarification round-trips                          |

**Combined effect:** An agent that consumes significantly fewer tokens than vanilla OpenClaw doing the same work. Not by limiting capability — by eliminating waste.

---

### 🔄 Self-Improving Agents

Each cron job carries a META file with its own instructions. After running, the agent reflects on what worked, updates the META, and the next run is better. No human needed.

Day 1: mediocre. Day 30: genuinely useful.

### 🧹 Fork Maintenance on Autopilot

- Nightly upstream sync with conflict detection
- Post-merge workspace cleanup (catches 20KB bloat)
- Fork patches auto-restored after conflicts
- Hundreds of commits ahead, zero maintenance burden

---

## 📦 Published Skills

> All on [ClawHub](https://clawhub.ai/u/globalcaos). Install any with `clawhub install globalcaos/<skill-name>`.
> Skills sometimes get delisted from the marketplace — this list is the permanent record.

### 🎤 Voice & Personality

| Skill                                                        | What it does                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| [`jarvis-voice`](https://clawhub.ai/globalcaos/jarvis-voice) | Turn your AI into JARVIS. Voice, wit, and personality — the complete package. |

### 💬 Messaging & Channels

| Skill                                                                  | What it does                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`whatsapp-ultimate`](https://clawhub.ai/globalcaos/whatsapp-ultimate) | 3-rule security gate — agent speaks only when spoken to, in the right chat, by the right person. |

### 📹 Media & Content

| Skill                                                                | What it does                                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`youtube-ultimate`](https://clawhub.ai/globalcaos/youtube-ultimate) | Free transcripts, 4K downloads, video exploration — zero API quotas burned. |

### 💰 Cost & Token Management

| Skill                                                                            | What it does                                                                        |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`tinker-command-center`](https://clawhub.ai/globalcaos/tinker-command-center)   | The dashboard above. Every token, every dollar, every context byte — real time.     |
| [`token-panel-ultimate`](https://clawhub.ai/globalcaos/token-panel-ultimate)     | Multi-provider token tracking, budget alerts, REST API.                             |
| [`token-efficiency-guide`](https://clawhub.ai/globalcaos/token-efficiency-guide) | Go from weekly limit on Tuesday to weekly limit on Sunday. 10 steps, one afternoon. |

### 🏢 Enterprise Integrations (Browser Relay)

No API keys. No admin consent. Your authenticated browser session IS the API.

| Skill                                                            | What it does                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`outlook-hack`](https://clawhub.ai/globalcaos/outlook-hack)     | Reads Outlook all day, drafts replies — won't send without approval. Code-enforced. |
| [`teams-hack`](https://clawhub.ai/globalcaos/teams-hack)         | Reads Teams chats, posts to channels, searches everything. One browser handshake.   |
| [`factorial-hack`](https://clawhub.ai/globalcaos/factorial-hack) | Reads your HR portal — attendance, leave, payslips. No admin consent required.      |

### 🤖 Agent & DevOps

| Skill                                                                                              | What it does                                                                                |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`coding-agent`](https://clawhub.ai/globalcaos/coding-agent)                                       | Hand off a coding task, come back to a diff. Codex, Claude Code, or Pi — your call.         |
| [`subagent-overseer`](https://clawhub.ai/globalcaos/subagent-overseer)                             | Sub-agents that go silent don't go unnoticed. Health checks, zero babysitting.              |
| [`fork-and-skill-scanner-ultimate`](https://clawhub.ai/globalcaos/fork-and-skill-scanner-ultimate) | Scan 1,000 GitHub forks per run. Surface the gold, skip the clones.                         |
| [`memory-bench-pioneer`](https://clawhub.ai/globalcaos/memory-bench-pioneer)                       | Peer-review-grade evaluation suite — LLM-as-judge, nDCG, MAP, MRR metrics.                  |
| [`model-prompt-adapter`](https://clawhub.ai/globalcaos/model-prompt-adapter)                       | Universal prompt addenda for cross-provider fallback chains. Fixes per-model failure modes. |
| [`smart-model-router`](https://clawhub.ai/globalcaos/smart-model-router)                           | Auto-selects the optimal model per task. Cost vs capability, no manual routing.             |

### 🛡️ Security & Governance

| Skill                                                                                  | What it does                                                                             |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`agent-boundaries-ultimate`](https://clawhub.ai/globalcaos/agent-boundaries-ultimate) | Instruction-level guardrails so your agent won't go rogue or improvise ethics.           |
| [`agent-memory-ultimate`](https://clawhub.ai/globalcaos/agent-memory-ultimate)         | Long-term memory done right. Semantic search, daily consolidation, cross-session recall. |
| [`shell-security-ultimate`](https://clawhub.ai/globalcaos/shell-security-ultimate)     | Classify every shell command as SAFE, WARN, or CRIT before your agent runs it.           |

### 😂 Humor & Communication

| Skill                                                                      | What it does                                                   |
| -------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [`computational-humor`](https://clawhub.ai/globalcaos/computational-humor) | 12 humor patterns based on embedding space bisociation theory. |

### 📖 Knowledge & Onboarding

| Skill                                                                          | What it does                                                                                                            |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| [`agent-sensei-ultimate`](https://clawhub.ai/globalcaos/agent-sensei-ultimate) | The sensei your agent never had. 40 lessons on ethics, memory, budget, self-evolution. Day 1: mediocre. Day 30: expert. |

### 📋 Data & Migration

| Skill                                                                                  | What it does                                                                  |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`chatgpt-exporter-ultimate`](https://clawhub.ai/globalcaos/chatgpt-exporter-ultimate) | Leaving ChatGPT? Take your conversations with you. Full export, clean format. |

### 🛰️ Location & IoT

| Skill                                                                    | What it does                                                                                         |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| [`owntracks-location`](https://clawhub.ai/globalcaos/owntracks-location) | Real-time phone location tracking with named places and distance queries. Always know where you are. |

---

## 📖 The Field Guide

32 lessons from 6 weeks of running AI agents 24/7.

> _"Read is free, send is not."_
>
> _"Wind-down is evolution, not diary."_
>
> _"A stuck sub-agent is burning money. Kill fast, respawn small."_

**📖 [Read the Field Guide →](docs/guides/field-guide.md)**

---

## 🚀 Quick Start

```bash
git clone https://github.com/globalcaos/tinkerclaw.git
cd tinkerclaw
pnpm install && pnpm build
pnpm openclaw onboard --install-daemon
```

Drop-in replacement for vanilla OpenClaw. Same config, same workspace, same channels. Visit `http://localhost:18789/tinker/` for the command center.

Click the **Tinker logo** or type **`/new`** to get your first morning briefing.

---

## Acknowledgments

TinkerClaw builds on [OpenClaw](https://github.com/openclaw/openclaw) and was inspired by the work of:

- **[Mission Control](https://github.com/crshdn/mission-control)** by crshdn — context anatomy dashboard and agent orchestration UI
- **[ClawMetry](https://github.com/vivekchand/clawmetry)** by vivekchand — real-time token observability for OpenClaw agents

Both are excellent standalone tools. We folded their ideas into a single embedded panel and went from there.

---

<p align="center">
  <a href="https://thetinkerzone.com">🌐 thetinkerzone.com</a> · <a href="https://youtube.com/@thetinkerzone">🎬 YouTube</a> · <a href="https://clawhub.ai">🦞 ClawHub</a> · <a href="https://discord.gg/clawd">💬 Discord</a>
</p>

<p align="center">
  <strong>⭐ Star if you're tired of guessing what your AI costs.</strong>
</p>

<p align="center">
  <em>Built by <a href="https://github.com/globalcaos">globalcaos</a>. Your AI shouldn't cost more than your rent — and if it does, you should at least know why.</em>
</p>
