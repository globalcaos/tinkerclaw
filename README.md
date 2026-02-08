# 🦞 OpenClaw — Tinker Fork

> **A personal AI assistant that talks, listens, and stays ahead.**
>
> Actively maintained fork with safety patches, voice-first interaction, and a maker spirit.

<p align="center">
  <a href="https://github.com/openclaw/openclaw"><strong>📦 Upstream</strong></a> ·
  <a href="https://docs.openclaw.ai"><strong>📚 Docs</strong></a> ·
  <a href="https://www.youtube.com/@TheTinkerZone-o7t"><strong>📺 The Tinker Zone</strong></a> ·
  <a href="https://discord.gg/clawd"><strong>💬 Discord</strong></a>
</p>

---

## Why Tinker Fork?

The upstream OpenClaw is excellent. This fork is for **tinkerers** who want:

🔧 **Bleeding edge** — Security patches and features before upstream releases  
🗣️ **Voice-first** — Local TTS/STT, no cloud required  
🤖 **Multi-AI** — Claude + Gemini + Manus with unified cost tracking  
📖 **AI-assisted setup** — Just ask your assistant to help configure itself  

**Watch us build it:** [The Tinker Zone](https://www.youtube.com/@TheTinkerZone-o7t) on YouTube

---

## What's Different?

| | Upstream | Tinker Fork |
|--|----------|-------------|
| **Updates** | Stable releases | Rolling + cherry-picked PRs |
| **Voice** | ElevenLabs (cloud) | Local sherpa-onnx + Whisper |
| **Models** | Single provider | Claude → Gemini failover + Manus |
| **Costs** | Per-provider | Unified tracking (beta) |
| **UI** | Feature-rich | Minimal, info-dense |

---

## Improvements Included

**Security** (cherry-picked)
- DNS rebinding protection
- Zip path traversal fix  
- WebSocket origin validation
- Smart router v2

**Features**
- WhatsApp full history sync
- Voice interface with `jarvis` command
- Budget-aware AI (knows its own costs)
- Minimal webchat UI

**Skills** — See [Published Skills](#-published-skills) below

---

## 📦 Published Skills

Skills developed in this fork, available on [ClawHub](https://clawhub.com):

| Skill | Description | Install |
|-------|-------------|---------|
| [**agent-memory-ultimate**](https://clawhub.com/skill/agent-memory-ultimate) | Complete memory system for AI agents. Human-like architecture with daily logs, sleep consolidation, SQLite + FTS5, importers for WhatsApp/ChatGPT/VCF. | `clawhub install agent-memory-ultimate` |
| [**agent-boundaries-ultimate**](https://clawhub.com/skill/agent-boundaries-ultimate) | Privacy, security, and ethical boundaries. Evolves beyond Asimov's Three Laws for digital agents. OPSEC, authorization, inter-agent etiquette. Community contributions welcome. | `clawhub install agent-boundaries-ultimate` |
| [**shell-security-ultimate**](https://clawhub.com/skill/shell-security-ultimate) | Security-first command execution. Classifies commands by risk level (SAFE→CRITICAL), enforces transparency. Explains coded vs prompted behaviors. | `clawhub install shell-security-ultimate` |
| [**whatsapp-ultimate**](https://clawhub.com/skill/whatsapp-ultimate) | Full WhatsApp integration. Messaging, media, polls, stickers, voice notes, group management, and persistent searchable history with SQLite. | `clawhub install whatsapp-ultimate` |
| [**youtube-ultimate**](https://clawhub.com/skill/youtube-ultimate) | The most comprehensive YouTube skill. FREE transcripts (zero API quota!), search with filters, batch video details, comments, downloads. | `clawhub install youtube-ultimate` |

### Contributing to Skills

We learn from community experience. To contribute lessons to `agent-boundaries-ultimate`:

1. Open an issue with label `community-lesson`
2. Use the template in [CONTRIBUTE.md](skills/agent-boundaries-ultimate/CONTRIBUTE.md)
3. Accepted lessons are credited and added to next release

---

## Quick Start

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

Then just ask: *"Help me set up WhatsApp"* — your AI knows how.

---

## Join The Tinker Zone

🎥 **YouTube:** [@TheTinkerZone-o7t](https://www.youtube.com/@TheTinkerZone-o7t) — Build with us  
🛠️ **GitHub:** Issues & PRs welcome  
💬 **Discord:** [discord.gg/clawd](https://discord.gg/clawd)

---

## Credits

Built on [OpenClaw](https://github.com/openclaw/openclaw) by Peter Steinberger and community.  
Tinker Fork by Oscar Serra + JarvisOne 🤖

*For full docs: [docs.openclaw.ai](https://docs.openclaw.ai)*
