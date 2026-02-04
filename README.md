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

**Skills**
- `youtube-ultimate` — Transcripts, search, download (no API key!)
- `google-sheets` — Workspace integration
- `healthcheck` — System security audits

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
