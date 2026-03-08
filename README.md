# 🔧 TinkerClaw

**Run OpenClaw with clear cost tracking, usable long-term memory, and less manual maintenance.**

<p align="center">
  <a href="https://github.com/openclaw/openclaw"><img src="https://img.shields.io/badge/fork%20of-OpenClaw-5865F2?style=for-the-badge" alt="Fork of OpenClaw"></a>
  <a href="https://github.com/globalcaos/tinkerclaw/commits/main"><img src="https://img.shields.io/badge/fork%20commits-262+-orange?style=for-the-badge" alt="262+ fork commits"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="MIT License"></a>
</p>

TinkerClaw adds a visual dashboard, nightly memory cleanup, and operator workflows on top of [OpenClaw](https://github.com/openclaw/openclaw). It stays close to upstream — existing configs and workspaces carry over with minimal changes.

If you already use OpenClaw and want better visibility into cost, context, and maintenance, start with the **[Field Guide →](docs/guides/field-guide.md)**

---

<!-- TODO: Annotated Tinker UI screenshot — context treemap with real data -->

## Visibility

Tinker UI shows why a session is getting expensive, bloated, or stuck.

- **Context treemap** — find what is consuming context
- **Response treemap** — see how much output is text, thinking, or tool use
- **Timeline** — spot the turn that bloated the session
- **Overseer graph** — catch stalled sub-agents early
- **Cost dashboard** — per-provider usage with rate-limit countdown

<!-- TODO: Annotated screenshot before publishing -->

---

## Memory

- **Nightly consolidation** turns raw session logs into cleaner project and knowledge files
- **Retrieval feedback** tracks whether search results were actually useful, and improves over time
- **Structured compaction** preserves decisions, tradeoffs, and open questions — not just summaries

One measured result: injected context reduced from 23.5KB to 12KB — 49% smaller with no quality loss.

---

## Maintenance

- **Nightly upstream sync** with conflict detection and fork-specific patch checks
- **Post-merge cleanup** detects workspace bloat and re-distills automatically
- **Wind-down loop** reviews sessions, encodes lessons, and updates prompts overnight

---

## Skills

20+ published to [ClawHub](https://clawhub.com), 60+ total in the workspace. Covers security, cost routing, messaging, memory, coding delegation, monitoring, and content tools. All installable with `clawhub install`.

---

## Quick Start

```bash
git clone https://github.com/globalcaos/tinkerclaw.git
cd tinkerclaw
pnpm install && pnpm build
pnpm openclaw onboard --install-daemon
```

---

<p align="center">
  Built in public by <a href="https://github.com/globalcaos">globalcaos</a>, on top of <a href="https://github.com/openclaw/openclaw">OpenClaw</a>.
</p>
