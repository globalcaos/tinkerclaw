# Fork Setup Guide

How to replicate the full globalcaos OpenClaw fork stack from scratch.

## Prerequisites

- **Node.js 22+** (with npm or pnpm)
- **Python 3.8+** (for ClawMetry diagnostics)
- **Git**

## Quick Start

```bash
git clone https://github.com/globalcaos/clawdbot-moltbot-openclaw.git
cd clawdbot-moltbot-openclaw
bash scripts/fork-setup.sh
```

The setup script handles: dependencies → build → ClawMetry → config check → skills inventory → gateway status.

## Stack Overview

| Component | Port  | Purpose                         | How to start                                                                                         |
| --------- | ----- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Gateway   | 18789 | OpenClaw core (AI agent engine) | `nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &` |
| ClawMetry | 4001  | OTEL diagnostics dashboard      | `nohup clawmetry --port 4001 --data-dir ~/.openclaw --no-debug > /tmp/clawmetry.log 2>&1 &`          |

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

### 3. Install ClawMetry (diagnostics)

```bash
pip3 install --user clawmetry
```

Start it:

```bash
nohup clawmetry --port 4001 --data-dir ~/.openclaw --no-debug > /tmp/clawmetry.log 2>&1 &
```

Verify: open `http://localhost:4001` — you should see the observability dashboard.

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

| Problem                                         | Fix                                                |
| ----------------------------------------------- | -------------------------------------------------- |
| `npm install` ENOTEMPTY                         | `rm -rf node_modules && npm install`               |
| A2UI bundle fails                               | `npx tsdown` (skip A2UI, gateway works without it) |
| `Cannot find package '@aws-sdk/client-bedrock'` | `npm install` didn't complete — rerun              |
| `dotenv` not found                              | `npm install dotenv`                               |
| Gateway "already running"                       | `pkill -9 -f openclaw-gateway` then restart        |
| ClawMetry not starting                          | Check Python 3: `pip3 install --user clawmetry`    |
