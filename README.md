<div align="center">

# 🧠 The Tinker Fork — OpenClaw Enhanced

**Compaction is not memory. It's time AI agents learned the difference.**

Every AI agent today handles long conversations the same way: when context gets too long, compress it. Throw away the details. Hope the summary is good enough. That's not memory — that's _amnesia with extra steps_.

This fork replaces compaction with **cognitive memory** — a system that organizes, retrieves, and consolidates knowledge the way humans do. The result: **60-80% fewer tokens per session**, because the agent loads only what it needs instead of everything it has.

[![Built on OpenClaw](https://img.shields.io/badge/built%20on-OpenClaw-blue?logo=github)](https://github.com/openclaw/openclaw)
[![Skills on ClawHub](https://img.shields.io/badge/skills-14%20published-purple)](https://clawhub.com)
[![Downloads](https://img.shields.io/badge/downloads-5%2C400%2B-green)](https://clawhub.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[ClawHub Skills](https://clawhub.com) · [Memory Architecture Proposal](https://github.com/openclaw/openclaw/issues/13991) · [Research Papers](docs/papers/)

</div>

---

## 💡 The Insight

Compaction treats context like a cache — when it's full, evict. But persistent AI agents don't need a bigger cache. They need **memory**: the ability to store knowledge once, organize it by type, and retrieve precisely what's relevant for the current task.

Humans don't re-read their entire diary before answering a question. They _recall_. This fork gives AI agents the same capability.

---

## 🧠 From Compaction to Cognition

A full memory architecture built on **SQLite + sqlite-vec + FTS5** that replaces brute-force context loading with intelligent retrieval.

| Compaction (Before)                     | Cognitive Memory (After)                     |
| --------------------------------------- | -------------------------------------------- |
| Loads entire workspace files every turn | Semantic search loads only relevant snippets |
| Context grows until forcibly compressed | Rolling window with topic-aware retrieval    |
| Summaries lose detail and nuance        | 4 memory types preserve structure            |
| No memory between sessions              | Persistent store across sessions and days    |
| Token usage scales with workspace size  | Token usage scales with **query relevance**  |

### The Token Math

Whatever your usage pattern — Claude Max, API, or any provider — the savings are proportional:

- **Typical workspace context per turn:** 15-25K tokens (loading MEMORY.md, TOOLS.md, daily logs, project files)
- **With cognitive retrieval:** 2-5K tokens (only the snippets that match the current task)
- **Reduction: 60-80% per turn**, compounding over every interaction

Over 50 turns in a day, that's the difference between burning your rate limit by mid-afternoon and running comfortably all day. Over a month, it's the difference between needing a higher tier and staying on your current one.

### The Architecture

| Component                 | What It Does                                                                |
| ------------------------- | --------------------------------------------------------------------------- |
| **4 Memory Types**        | Episodic, semantic, procedural, strategic — structured like human cognition |
| **Spreading Activation**  | +23% accuracy on multi-hop reasoning benchmarks                             |
| **RAPTOR Hierarchies**    | Zoom in/out across abstraction levels                                       |
| **Nightly Consolidation** | Clustering, decay, deduplication — automatic maintenance                    |
| **Cross-Agent Sharing**   | Memory sharing between agents with sensitivity gates                        |
| **Local ONNX Embeddings** | ~30ms per embedding, fully offline, zero API cost                           |

📄 [Full architecture proposal →](https://github.com/openclaw/openclaw/issues/13991)

### Research Papers

The theoretical foundations behind this fork's memory system:

| Paper                                                      | Codename        | Description                                                                                      |
| ---------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| 📄 [Agent Memory](docs/papers/agent-memory.md)             | **CORTEX**      | Cognitive memory architecture for persistent AI agents — from daily logs to spreading activation |
| 📄 [Context Compaction](docs/papers/context-compaction.md) | **ENGRAM**      | Why lossy compaction fails and how structured memory eliminates the need for it                  |
| 📄 [Humor Embeddings](docs/papers/humor-embeddings.md)     | **LIMBIC**      | Embedding space bisociation theory — computational humor for AI agents                           |
| 📄 [Multi-Model Debate](docs/papers/synapse.md)            | **SYNAPSE**     | Multi-model deliberation protocol — cognitive diversity through structured disagreement          |
| 📄 [Concept Index](docs/papers/hippocampus.md)             | **HIPPOCAMPUS** | Two-tier retrieval index — episodic anchors + semantic consolidation for O(1) recall             |

---

## 🤖 Autonomous Memory Maintenance

The agent doesn't just store memories — it **maintains** them. A nightly consolidation cycle runs automatically:

1. **Extract** — Daily interactions compressed into knowledge files (entities, topics, opinions, lessons)
2. **Decay** — Unused memories lose relevance weight over time, keeping retrieval sharp
3. **Deduplicate** — Overlapping memories merged, contradictions flagged
4. **Index** — Updated knowledge graphs and RAPTOR hierarchies

This is the key difference from flat-file memory: it doesn't just accumulate — it _organizes_. Like sleep consolidation in the human brain, the overnight cycle is where raw experience becomes structured knowledge.

---

## 🛡️ Security by Code, Not by Documentation

The operating doctrine: **if you can enforce it with code, don't rely on documentation.**

- **Email send-blocking**: The agent reads Outlook and creates drafts — but `fetch()` is intercepted to block all send endpoints. Not a prompt rule. A code-enforced gate.
- **Shell command classification**: Every command rated SAFE → CRITICAL before execution. Dangerous commands blocked automatically.
- **Privacy code of conduct**: Inter-agent communication requires human-authorized channels only.
- **Persona drift detection**: SyncScore protocol measures personality consistency and corrects before the agent loses its voice.

---

## 🎙️ Voice — Fully Offline

JARVIS-inspired metallic TTS via sherpa-onnx. Speaks through your speakers. Purple italic transcripts in webchat. No cloud API, no latency, no cost.

---

## 📦 Published Skills

All available on [ClawHub](https://clawhub.com). Install any skill with `clawhub install <name>`.

### Memory & Intelligence

| Skill                                                                                    | Description                                                                                                    |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 🧠 [agent-memory-ultimate](https://clawhub.com/globalcaos/agent-memory-ultimate)         | Cognitive memory with vector search, knowledge graphs, RAPTOR hierarchy. The core of the 60-80% token savings. |
| 🛡️ [agent-boundaries-ultimate](https://clawhub.com/globalcaos/agent-boundaries-ultimate) | AI safety, security boundaries, privacy, ethics, OPSEC. Beyond Asimov's Three Laws.                            |
| 😄 [ai-humor-ultimate](https://clawhub.com/globalcaos/ai-humor-ultimate)                 | 12 humor patterns for AI agents based on embedding space bisociation theory.                                   |
| 🧪 [memory-pioneer](https://clawhub.com/globalcaos/memory-pioneer)                       | Benchmark your agent's memory. Contribute anonymized scores to open research.                                  |

### Communication & Messaging

| Skill                                                                    | Description                                                                         |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 💬 [whatsapp-ultimate](https://clawhub.com/globalcaos/whatsapp-ultimate) | Full WhatsApp: messages, media, polls, voice notes, reactions, FTS5 history search. |
| 📧 [outlook-hack](https://clawhub.com/globalcaos/outlook-hack)           | Outlook email via browser session. Read, search, draft. Send blocked by code.       |

### Media & Content

| Skill                                                                                    | Description                                                              |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 🎬 [youtube-ultimate](https://clawhub.com/globalcaos/youtube-ultimate)                   | FREE transcripts (zero API quota), 4K download, comments, batch details. |
| 📤 [chatgpt-exporter-ultimate](https://clawhub.com/globalcaos/chatgpt-exporter-ultimate) | Export ALL ChatGPT conversations instantly, including Projects.          |
| 🎙️ [jarvis-voice](https://clawhub.com/globalcaos/jarvis-voice)                           | JARVIS-style offline TTS. Metallic effects, purple transcripts.          |

### Operations & Security

| Skill                                                                                                | Description                                                         |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 🔒 [shell-security-ultimate](https://clawhub.com/globalcaos/shell-security-ultimate)                 | Command risk classification (SAFE → CRITICAL). Audit logging.       |
| 📊 [token-panel-ultimate](https://clawhub.com/globalcaos/token-panel-ultimate)                       | Track usage across Claude, ChatGPT, Gemini, Manus. One dashboard.   |
| 💰 [token-efficiency-guide](https://clawhub.com/globalcaos/token-efficiency-guide)                   | Go from weekly limit on Tuesday to weekly limit on Sunday.          |
| 🔍 [fork-and-skill-scanner-ultimate](https://clawhub.com/globalcaos/fork-and-skill-scanner-ultimate) | Scan 1,000 GitHub forks per run. Surface the gold, skip the clones. |
| 👁️ [subagent-overseer](https://clawhub.com/globalcaos/subagent-overseer)                             | Pull-based sub-agent monitor. Zero tokens. Pure bash + /proc.       |

---

## ⚡ Staying Current

This fork syncs with upstream **several times per week**, always within days of the latest release. All upstream features and fixes included, enhanced features layered on top.

---

## Getting Started

```bash
# Install OpenClaw
npm install -g openclaw@latest

# Clone this fork for enhanced features
git clone https://github.com/globalcaos/clawdbot-moltbot-openclaw.git
cd clawdbot-moltbot-openclaw
pnpm install
```

For full setup instructions, see the [upstream documentation](https://docs.openclaw.ai).

---

## Links

|                |                                                              |
| -------------- | ------------------------------------------------------------ |
| 🌐 **Website** | [thetinkerzone.com](https://thetinkerzone.com)               |
| 📺 **YouTube** | [@TheTinkerZone](https://www.youtube.com/@TheTinkerZone-o7t) |

---

## License

MIT — same as upstream. See [LICENSE](LICENSE).

Built on [OpenClaw](https://github.com/openclaw/openclaw). All credit to the upstream team for the incredible foundation.

For upstream features, setup, channels, and platform docs, see the [upstream README](https://github.com/openclaw/openclaw#readme).
