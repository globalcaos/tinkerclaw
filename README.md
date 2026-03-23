<p align="center">
  <img src="docs/assets/logo.png" alt="TinkerClaw" width="500">
</p>

<h1 align="center">TinkerClaw</h1>

<p align="center">
  <strong>The first AI agent that makes itself smarter every day.</strong><br>
  <em>It writes research papers about its own failures. Then it reads them. Then it improves.</em>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw"><img src="https://img.shields.io/badge/fork%20of-OpenClaw-5865F2?style=for-the-badge" alt="Fork of OpenClaw"></a>
  <a href="https://github.com/globalcaos/tinkerclaw/commits/main"><img src="https://img.shields.io/badge/hundreds%20of-fork%20commits-orange?style=for-the-badge" alt="Hundreds of fork commits"></a>
  <a href="#-published-skills"><img src="https://img.shields.io/badge/skills-22+-green?style=for-the-badge" alt="21+ skills"></a>
  <a href="#-every-paper-saves-you-tokens"><img src="https://img.shields.io/badge/papers-11-blueviolet?style=for-the-badge" alt="11 papers"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="MIT License"></a>
</p>

---

## The Singularity Point 🚀
### *Our agent rewrites its own brain after every conversation. Yours is still reading from a script.*

Your AI agent is as smart today as it was the day you installed it. Same mistakes. Same limitations. Same personality copy-pasted from a text file that never changes. Four months from now, it'll still be the same agent — just with a longer conversation history and a bigger bill.

**TinkerClaw's agent gets smarter every single day.**

Not in theory. Not "with fine-tuning." Right now, autonomously, while you sleep. It reviews what went wrong, rewrites its own instructions, and tomorrow's version is observably better than today's — like a chef who tastes the dish every night and adjusts the recipe 👨‍🍳. We didn't plan for this. We just kept fixing problems, writing papers about *why* they happened, feeding those papers back into the system — and at some point, the fixes started generating themselves.

This is the singularity point — where the agent's rate of self-improvement outpaces the rate of new problems. Every day, the gap widens.

---

## The Three Fears Everyone Has (And We Solved) 😤

### 1. "Why is my agent frozen again?" ⏳

You asked a simple question. Now you're staring at a spinning cursor for 45 seconds. A minute. Then the response arrives — but it forgot half of what you were working on. Sound familiar?

That's **compaction**. When the conversation gets too long, the agent panics and frantically summarizes older messages to stay under the token limit. Like a student cramming for an exam by tearing chapters out of the textbook 📖 — sure the book is lighter, but good luck passing the test.

Every time it compacts: **you wait** (flow broken), **it forgets** (context destroyed), and **you pay** (tokens burned to make it dumber). Every agent framework does this. They all think it's fine.

**We stopped compacting entirely.** By putting the agent on a diet 🥗 — only the context it actually needs arrives each turn, with memory that consolidates overnight like a brain during sleep 😴. Zero compaction events. No more waiting. No more forgetting.

### 2. "Where did all my money go?" 💸

You ran the agent for a week. The bill arrives. You can't explain 60% of the charges because you have **zero visibility** into what the agent was actually doing with your tokens. That tool result nobody asked for? 40K tokens. Those workspace files injected every turn? Another 15K. You're not overspending — you're **overloading**, and you can't see it happening.

**Tinker UI is a calorie counter for your AI's diet** 🍕 — real-time treemaps that show exactly what fills the context window, what each response costs, and where the waste patterns hide. Every bar is a turn. Every color is a cost. The spike at 14:02? That's the 40K-token tool result you can now prevent tomorrow.

### 3. "What if it breaks something? What if someone steals my data?" 🔐

Your agent has access to your files, your messages, your credentials. One wrong tool call and it deletes the file you've been editing for a week. One leaked API key and your accounts are compromised. Safety rules from a text file are like traffic laws for a self-driving car that can't see the road — technically correct, practically useless.

**Prudence networks are a pilot's checklist before takeoff** ✈️ — 10 neural networks trained on real catastrophic failures that learn to recognize danger the way a human learns to recognize a hot stove. Not rules to follow, but intuition to apply. And **AEGIS** provides absolute safety rails that can never be overridden — like the physical guardrails on a mountain road, no matter how confident the driver.

---

## The Proof 📊

| What you feel today | What TinkerClaw does about it |
|---|---|
| ⏳ Frozen cursor, broken flow | **Zero compaction** — context diet + overnight consolidation. Never waits, never forgets. |
| 💸 Mystery bills, hidden waste | **Tinker UI** — see every token, every cost. The agent learns what to stop doing. |
| 🔐 Fear of breakage and leaks | **Prudence + AEGIS** — neural safety + absolute guardrails. Learned from real disasters. |
| 🤖 Same mistakes on repeat | **15+ overnight crons** — self-improving instructions. Day 1 mediocre, day 30 expert. |
| 😐 Flat personality from a text file | **AMYGDALA** — 10 neural networks that learn personality from your corrections. Not rules. Adaptation. |
| 🔧 Shallow fixes, missed patterns | **Fractal reflection** — automatic depth climbing. Fixes the bug, then the system that produced the bug. |

**Eleven research papers.** Each one started as a real problem we hit running an agent 24/7. The €850 bill was the trigger. The end of compaction was the breakthrough. The singularity — where improvement compounds daily — is where we are now.

<p align="center">
  <img src="docs/assets/screenshot-3.png" alt="Token timeline — every bar is a turn, every color is a cost" width="750">
  <br>
  <em>Tinker UI: Every bar is a turn. Every color is a cost. The spike at 14:02? A 40K-token tool result nobody asked for.</em>
</p>

> The Tinker UI's token visualization was inspired by [Mission Control](https://github.com/crshdn/mission-control) (context anatomy dashboard) and [ClawMetry](https://github.com/vivekchand/clawmetry) (real-time agent observability). Both are excellent standalone tools for OpenClaw — we folded their ideas into a single embedded panel.

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

In 30 days, this process produced **14 autonomous improvements** to the agent's own processes — without a single human prompt ([CEREBELLUM paper](#-every-paper-saves-you-tokens)).

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

| Cron                        | What it does                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 🍷 **Wind Down**            | Like a glass of wine with the diary — reviews what worked and what didn't, improves its own instructions                                     |
| 😴 **Memory Consolidation** | Like REM sleep — turns raw daily logs into structured long-term memory. **49% context reduction** ([ENGRAM](#-every-paper-saves-you-tokens)) |
| 🧹 **Cleaning Lady**        | Controls disk usage, prunes stale context, keeps the workspace lean                                                                          |
| 🔍 **Auto-Evolution**       | Scouts AI news for improvements that can be applied directly to the system                                                                   |
| 📰 **Group Summary**        | Scans message groups, extracts what matters, discards noise                                                                                  |
| 🛒 **Opportunity Hunter**   | Browses marketplaces for deals matching your interests — a personal shopper that never sleeps                                                |
| 🤵 **Butler**               | Remembers birthdays, suggests gifts, tracks appointments. If it's been too long since you sent flowers, it mentions it — diplomatically      |

These are just the ones with personality. **15+ total crons**, each with its own logic and self-improvement capability.

---

### 📊 Every Paper Saves You Tokens

This isn't academic research — it's cost engineering. Every paper translates directly to fewer tokens consumed, better memory, and smarter decisions. The "Cumulative Saving" column shows the compounding effect — each layer builds on the previous ones.

| #   | Paper                                                                                   | What it solves                                                                    | Measured impact                                                                                       | Cumulative Saving |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | :---------------: |
| 1   | 📄 [**Total Recall**](docs/papers/total-recall/total-recall.md)                         | Event-navigated episodic memory — stores everything, retrieves what matters       | **49% fewer tokens** injected per turn, 94% recall over 847 compactions                               |     **~49%**      |
| 2   | 📄 [**Instant Recall**](docs/papers/instant-recall/instant-recall.md)                   | Pre-computed concept index for O(1) retrieval — no more brute-force search        | **8/10 benchmark score** — fewer retrieval misses = fewer re-fetches                                  |     **~55%**      |
| 3   | 📄 [**Fractal Reasoning**](docs/papers/fractal-reasoning/fractal-reasoning.md)          | Self-similar memory hierarchy — zoom in for detail, zoom out for patterns         | Hierarchical storage that scales without ballooning context                                           |     **~60%**      |
| 4   | 📄 [**Identity Persistence**](docs/papers/identity-persistence/identity-persistence.md) | The agent remembers who it is and who you are across sessions                     | Eliminates re-explanation overhead — no more "as an AI, I don't have context"                         |     **~65%**      |
| 5   | 📄 [**Sleep Consolidation**](docs/papers/sleep-consolidation/sleep-consolidation.md)    | Nightly self-improvement — the agent rewrites its own prompts while you sleep     | **14 autonomous improvements** in 30 days, compounding efficiency gains                               |     **~68%**      |
| 6   | 📄 [**Round Table**](docs/papers/round-table/round-table.md)                            | Multi-model adversarial debate — cognitive diversity as computational resource    | **8pp accuracy gain** on GPQA Diamond; cheaper models collaborating beat one expensive model guessing |     **~72%**      |
| 7   | 📄 [**Humor Embeddings**](docs/papers/humor-embeddings/humor-embeddings.md)             | Humor from embedding geometry — communication that's natural, not robotic         | Fewer clarification round-trips, more efficient human-agent interaction                               |     **~74%**      |
| 8   | 📄 [**Curiosity Motivation**](docs/papers/curiosity-motivation/curiosity-motivation.md) | Intrinsic motivation — the agent explores gaps before they become costly failures | Proactive knowledge acquisition reduces future retrieval failures                                     |     **~76%**      |
| 9   | 📄 [**Agent Security**](docs/papers/agent-security/agent-security.md)                   | Multi-layered security for autonomous agents — trust tiers, credential isolation  | Defense-in-depth prevents lateral movement; zero credential leaks in 8+ weeks                         |     **~78%**      |
| 10  | 📄 [**Corporate Swarm**](docs/papers/corporate-swarm/corporate-swarm.md)                | Multi-agent coordination — sub-agent orchestration for enterprise workflows       | Parallel task execution with oversight; deterministic completion tracking                             |     **~80%**      |
| 11  | 📄 [**Learned Intuition**](docs/papers/learned-intuition/learned-intuition.md)          | Live personality modulation + action gating — 10 neural networks that learn safety and personality from interaction | Self-correcting humor, voice consistency, fractal depth climbing; personality that adapts, not just follows rules |     **~82%**      |

**Reading order:** Top to bottom — from storing memories (1) to finding them instantly (2) to scaling them fractally (3) to maintaining identity (4) to improving overnight (5) to multi-model debate (6) to natural communication (7) to self-directed learning (8) to securing the system (9) to scaling across agents (10) to intuitive fast-path decisions (11).

**Combined effect:** From an agent that hit compaction every turn and cost €850/month to one that runs 24/7 with zero compaction events. The savings aren't a line item — they're the difference between an agent you can use and one you can't.

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

### 🌐 Web & CMS

| Skill                                                                    | What it does                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| [`wordpress-ultimate`](https://clawhub.ai/globalcaos/wordpress-ultimate) | Three env vars, one script — your agent manages your entire WordPress site. Draft-only safety included. |

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

Visit **`http://localhost:18789/tinker/`** for the command center. Click the **Tinker logo** or type **`/new`** to get your first morning briefing.

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

## What's Next

- **WhatsApp full history sync** — your agent will have context going back years, not just this week
- **LanceDB hybrid memory** — persistent, searchable, cross-session
- **The Tinker Zone YouTube tutorials** — because docs only get you so far

---

## Acknowledgments

TinkerClaw builds on [OpenClaw](https://github.com/openclaw/openclaw) and was inspired by the work of:

- **[Mission Control](https://github.com/crshdn/mission-control)** by crshdn — context anatomy dashboard and agent orchestration UI
- **[ClawMetry](https://github.com/vivekchand/clawmetry)** by vivekchand — real-time token observability for OpenClaw agents

Both are excellent standalone tools. We folded their ideas into a single embedded panel and went from there.

> **[OpenClaw upstream repository & docs](https://github.com/openclaw/openclaw)** · [Website](https://openclaw.ai) · [Docs](https://docs.openclaw.ai) · [Getting Started](https://docs.openclaw.ai/start/getting-started) · [FAQ](https://docs.openclaw.ai/help/faq)

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
