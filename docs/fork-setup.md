# Fork Setup Guide

How to replicate the full globalcaos OpenClaw fork stack from scratch.

## Prerequisites

- **Node.js 22+** (with npm or pnpm)
- **Python 3.10+** with `venv` (for ClawMetry)
- **Git** + **GitHub CLI** (`gh`)

## Quick Start

```bash
git clone https://github.com/globalcaos/clawdbot-moltbot-openclaw.git
cd clawdbot-moltbot-openclaw
bash scripts/fork-setup.sh
```

The setup script handles: dependencies → build → companion tools (ClawMetry + Mission Control) → config check → skills inventory → gateway status.

## Stack Overview

| Component       | Port  | Repo                         | Purpose                           |
| --------------- | ----- | ---------------------------- | --------------------------------- |
| Gateway         | 18789 | (this repo)                  | OpenClaw core (AI agent engine)   |
| ClawMetry       | 4001  | `globalcaos/clawmetry`       | Real-time observability dashboard |
| Mission Control | 4000  | `globalcaos/mission-control` | Task orchestration & sub-agent UI |

All three run locally. ClawMetry and Mission Control are companion repos cloned into `~/src/` alongside this fork.

## Step-by-Step Manual Setup

### 1. Install dependencies

```bash
cd ~/src/clawdbot-moltbot-openclaw
pnpm install    # or: npm install
```

If `npm install` fails with `ENOTEMPTY` on `bun-types`:

```bash
rm -rf node_modules
npm install
```

### 2. Build

```bash
pnpm build      # or: npm run build
```

If A2UI bundle fails (missing `tsc` for lit renderer), the main build (`tsdown`) usually succeeds and the gateway runs fine without A2UI:

```bash
npx tsdown
```

### 3. Clone companion tools

Both tools live in `~/src/` as separate git repos with their own upstream tracking.

#### ClawMetry (real-time observability dashboard)

```bash
cd ~/src
git clone https://github.com/globalcaos/clawmetry.git
cd clawmetry
git remote add upstream https://github.com/vivekchand/clawmetry.git
pip3 install -r requirements.txt   # or: pip install flask
```

Start it:

```bash
cd ~/src/clawmetry
nohup python3 dashboard.py --port 4001 --data-dir ~/.openclaw --no-debug > /tmp/clawmetry.log 2>&1 &
```

Verify: open `http://localhost:4001`

#### Mission Control (task orchestration UI)

```bash
cd ~/src
git clone https://github.com/globalcaos/mission-control.git
cd mission-control
git remote add upstream https://github.com/crshdn/mission-control.git
npm install
```

Start it:

```bash
cd ~/src/mission-control
npm run dev   # or: nohup npm run dev > /tmp/mission-control.log 2>&1 &
```

Verify: open `http://localhost:4000`

### 4. Configure diagnostics in OpenClaw

Run the setup script with the flag:

```bash
bash scripts/fork-setup.sh --apply-diagnostics
```

Or manually add to `~/.openclaw/openclaw.json`:

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4001",
      "serviceName": "openclaw",
      "traces": true,
      "metrics": true,
      "logs": false,
      "sampleRate": 1
    }
  },
  "plugins": {
    "entries": {
      "diagnostics-otel": {
        "enabled": true
      }
    }
  }
}
```

### 5. Start the gateway

```bash
nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
```

Verify:

```bash
tail -n 30 /tmp/openclaw-gateway.log
```

### 6. Skills

50+ skills available in `workspace/skills/`. Install from ClawHub:

```bash
clawhub install <skill-name>
```

Notable skills:

- **ai-humanizer** — detect and rewrite AI-generated text
- **nano-banana-pro** — image generation with Gemini
- **coding-agent** — delegate to Claude Code / Codex
- **subagent-overseer** — zero-token filesystem-based sub-agent monitoring
- **outlook-hack** — read Outlook email via browser relay (no API key needed)
- **factorial-hack** — HR queries via browser relay
- **teams-hack** — read Teams chats via browser relay

## Updating

```bash
cd ~/src/clawdbot-moltbot-openclaw
git pull origin main
npm install        # or pnpm install
npm run build      # or pnpm build
# Restart gateway:
pkill -9 -f openclaw-gateway || true
nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
```

## Troubleshooting

| Problem                                         | Fix                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `npm install` ENOTEMPTY                         | `rm -rf node_modules && npm install`                                                      |
| A2UI bundle fails                               | `npx tsdown` (skip A2UI, gateway works without it)                                        |
| `Cannot find package '@aws-sdk/client-bedrock'` | `npm install` didn't complete — rerun                                                     |
| `dotenv` not found                              | `npm install dotenv`                                                                      |
| Gateway "already running"                       | `pkill -9 -f openclaw-gateway` then restart                                               |
| ClawMetry not starting                          | `cd ~/src/clawmetry && python3 dashboard.py --port 4001`                                  |
| Mission Control not starting                    | `cd ~/src/mission-control && npm install && npm run dev`                                  |
| Python venv needed (Debian/Ubuntu)              | `sudo apt install python3-venv` then `python3 -m venv .venv && source .venv/bin/activate` |
