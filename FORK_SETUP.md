# Tinkerclaw Fork Setup Guide

> **For agents:** Read this file completely before taking any action. This is your onboarding guide for the Tinkerclaw fork of OpenClaw. Follow each section in order. Ask your human operator for confirmation before making changes to auth credentials or systemd services.

## The git-pull contract: personalize in the workspace, never in the repo

The repo (`~/src/tinkerclaw/`) is upstream's. `git pull` will rewrite it. Your persona, briefing, recipes, and any prompt overrides go in `~/.openclaw/workspace/` — outside the repo, where `git pull` cannot reach.

The bundled defaults at `extensions/tinkerclaw-tinker-bridge/{personas,prompts}/` are what you get on day 0: JARVIS persona, working briefing on `/new`, full grandma-proof tool narration. They work without any setup. To make Jarvis your own, drop a file at `~/.openclaw/workspace/SOUL.md` (overrides the persona) or `~/.openclaw/workspace/BRIEFING.md` (overrides the briefing template). The gateway always prefers your workspace file over the bundled default; `git pull` keeps refreshing the bundle without ever touching your override.

Resolution order for every overridable prompt:

```
1. Explicit config in ~/.openclaw/openclaw.json   (outside repo)
2. ~/.openclaw/workspace/<file>                   (outside repo)
3. extensions/tinkerclaw-tinker-bridge/.../<file>     (in repo, bundled default)
```

See `TINKER_UI_DESIGN_BIBLE.md` §5.76 for the full contract, the "Sam test" (fresh-clone day-0 experience) and the "Day-90 test" (existing user `git pull` safety).

## What This Fork Adds

Tinkerclaw is a personal AI assistant fork of OpenClaw with cognitive extensions:

- **Total Recall** (ENGRAM) — episodic memory with SQLite + full-text (word) retrieval
- **Learned Intuition** (AMYGDALA) — neural safety gate (ONNX or rule-based fallback)
- **Fractal Reflection** — post-turn self-reflection framework
- **Identity Persistence** — persona consistency across sessions
- **Computational Humor** — humor calibration system
- **Round Table** — multi-perspective reasoning
- **Prefrontal** — autonomous orchestration with live call tree UI
- **Budget Panel** — live token usage tracking with rate limit header capture
- **Tinker UI** — custom webchat with model panel, session management, thinking indicators

## Step 0: Clone the Repo

```bash
git clone https://github.com/globalcaos/tinkerclaw.git ~/src/tinkerclaw
cd ~/src/tinkerclaw
git remote add upstream https://github.com/openclaw/openclaw.git
```

## Prerequisites

### Required

- **Node.js 22.14+** (Node 24 recommended)
- **pnpm 10.32+**: `npm install -g pnpm@10.32.1`
- **At least one LLM provider** — Anthropic API key, OpenAI API key, Google AI key, or Ollama

### Optional (but recommended)

- **Ollama** — for local embeddings (semantic memory search). Without it, memory search works on words only.
  - Install: https://ollama.ai
  - Start: `ollama serve` (runs on http://127.0.0.1:11434)
  - No need to pull a model by hand: after the build, `openclaw embedder fit --pull` measures this machine and downloads the model that fits it, if any ([4e. Memory search](#4e-memory-search-embeddings))
- **Claude Code** — for OAuth credential sync (if using Anthropic Claude Max subscription)

## Step 1: Install Dependencies

```bash
cd ~/src/tinkerclaw
pnpm install
```

Verify native deps built:

```bash
ls node_modules/better-sqlite3/build/Release/better_sqlite3.node
```

If missing: `pnpm rebuild better-sqlite3 opusscript`

Install the `openclaw` CLI globally:

```bash
pnpm link --global
```

Verify: `which openclaw` should point to your repo's `openclaw.mjs`.

Install Tinker UI dependencies:

```bash
cd tinker-ui && pnpm install && cd ..
```

## Step 2: Apply Fork Wiring

After every `git pull` from upstream, the fork patches must be re-applied:

```bash
node ~/.openclaw/fork-scripts/apply-fork-wiring.mjs
```

If `~/.openclaw/fork-scripts/` doesn't exist yet, bootstrap it:

```bash
mkdir -p ~/.openclaw/fork-scripts
# The scripts live in ~/.openclaw/fork-scripts/, not in the repo's scripts/ dir.
# Copy from an existing install, or ask the fork maintainer for the latest versions.
# Required files: apply-fork-wiring.mjs, merge-guardian.sh, safe-cron-merge.sh
```

Then verify:

```bash
bash ~/.openclaw/fork-scripts/merge-guardian.sh
```

All checks should show green. Warnings about missing fork directories (`src/memory/cortex`, `src/memory/limbic`) are expected if those subsystems haven't been created yet.

## Step 3: Build

```bash
node scripts/tsdown-build.mjs
node scripts/runtime-postbuild.mjs
node scripts/build-stamp.mjs
```

Warnings about `[MISSING_EXPORT]` are pre-existing from upstream and safe to ignore. The build should end without fatal errors.

## Step 4: Initial Configuration

### 4a. Run Onboarding (fresh install only)

```bash
openclaw onboard
```

This creates `~/.openclaw/openclaw.json` with model providers, auth, and basic config. Follow the prompts.

### 4b. Fork-Specific Config

After onboarding, add these fork-specific settings to `~/.openclaw/openclaw.json`:

**Memory slot** — switch from upstream's `memory-core` to Total Recall:

```json
{
  "plugins": {
    "slots": {
      "memory": "tinkerclaw-total-recall"
    }
  }
}
```

**Total Recall** (add to `plugins.entries`):

```json
{
  "plugins": {
    "entries": {
      "tinkerclaw-total-recall": {
        "enabled": true,
        "config": {
          "budgetTokens": 2000
        }
      }
    }
  }
}
```

Total Recall finds past events by word search (full-text search over its event store), so it needs no embedding model. Its `embeddingProvider` and `embeddingModel` keys are ignored, and configs that still set them keep loading. Semantic memory search is chosen per machine: see [4e. Memory search](#4e-memory-search-embeddings).

**Learned Intuition** (optional, defaults are fine):

```json
{
  "plugins": {
    "entries": {
      "tinkerclaw-learned-intuition": {
        "enabled": true,
        "config": {
          "phase": 1,
          "observeOnly": true
        }
      }
    }
  }
}
```

Phase 1 with `observeOnly: true` means it logs safety evaluations but never blocks actions. Safe for onboarding. The ONNX neural networks are optional — without them, a rule-based fallback gate runs automatically. No GPU required.

### 4c. Auth Profiles

Your `~/.openclaw/agents/main/agent/auth-profiles.json` was created by onboarding. Verify it has at least one working provider:

```bash
openclaw agent --to self --session-id test -m "reply PONG"
```

If you get PONG back, auth is working.

**For Anthropic OAuth (Claude Max subscription):** As of April 2026, Anthropic has disabled OAuth for third-party API access. Use an API key from console.anthropic.com instead, or wait for OAuth restoration. If using Claude Code's OAuth token, the fork can sync it — but API calls will be rejected until Anthropic re-enables OAuth.

### 4d. WhatsApp (optional)

```bash
openclaw channels login --channel whatsapp
```

Scan the QR code with your phone. Then add your phone number to the allowlist in `openclaw.json`:

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "selfChatMode": true,
      "allowFrom": ["+1234567890"]
    }
  }
}
```

### 4e. Memory search (embeddings)

Memory search always works on words. An embedding model adds a vector search that also finds a note phrased differently from the question, and its CPU cost varies a lot from one machine to the next. So the model is chosen by measuring each machine, and the choice can be none.

If you installed with `scripts/setup.sh`, its step 4d ("Memory search fit") already measured this machine, after asking whether it may download a model. On a manual install, run the fit once the build (Step 3) is done, with Ollama running if you use it:

```bash
openclaw embedder fit --pull   # measure this machine, download the model that fits (if any)
openclaw embedder status       # what memory search uses here now
```

The fit picks one embedding model, or none. With none, memory search works on words only and still indexes new notes. A model is downloaded only with your yes. `--pull` gives that yes up front. Without it, the fit asks in a terminal, naming the model and its download size, and downloads nothing when no terminal is attached. The choice is stored for this machine only, in `~/.openclaw/memory/embedder-fit.json`, and `openclaw.json` is never edited.

`openclaw doctor --fix` measures again. The gateway also measures by itself, in the background and at idle, when it starts and finds no measurement yet or finds the machine changed: a different CPU, more or less RAM, a new CPU quota, a GPU, or a model from the fit's list pulled or removed in Ollama. A background measurement never downloads a model.

Ollama is optional. Without it, memory search runs on words. To add it later, install it (https://ollama.ai), then run `openclaw embedder fit --pull`.

The fit picks a remote embedding provider (OpenAI, Gemini and others) only after an explicit yes, because your memory text would leave the machine. An API key in your config is not that yes. In a terminal the fit asks when a key exists and no local model fits, and the question says how much text would be sent and what it may cost. Otherwise, say yes with `openclaw embedder fit --allow-remote <provider>`. The yes stays recorded until `openclaw embedder fit --allow-remote none` takes it back.

To pin a model, set the provider and the model yourself:

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "provider": "ollama",
        "model": "granite-embedding:278m"
      }
    }
  }
}
```

The fit never changes a pinned provider; it only proposes. When the pin fails one of its checks, `openclaw doctor` and `openclaw embedder status` name the check and what the fit would choose instead. To hand the choice back to the fit:

```bash
openclaw config unset agents.defaults.memorySearch.provider
openclaw config unset agents.defaults.memorySearch.model
```

On a slow machine the chosen model can start "dormant until demand": it starts embedding your notes in the background only once real memory searches come often enough to repay the CPU. Until then, search answers from words, plus any vectors already in the index. A pinned model is never put to sleep this way.

Reference numbers, measured 2026-10-29 on a Raspberry Pi 5 with Ollama 0.40.11 in a 2-CPU container: one private corpus of 100 memory files, 40 frozen queries (30 English, 10 Spanish or Catalan), hybrid search = 0.7 cosine + 0.3 BM25 over an OR of keywords. Tokens/s is embedding speed on that board. R@5 (hybrid search for the models, words alone in the last row) is the share of queries whose target file came back in the top five.

| Model                      | Download | Tokens/s | R@5   |
| -------------------------- | -------- | -------- | ----- |
| granite-embedding:30m      | 62 MB    | 338      | 0.850 |
| granite-embedding:278m     | 562 MB   | 167      | 0.975 |
| mxbai-embed-large          | 669 MB   | 96       | 0.900 |
| Word search alone (FTS-OR) | none     | n/a      | 0.625 |

On that board the fit picks granite-embedding:30m. The 278m model finds more, but it needs about twice the CPU for the same text, and there its extra recall pays for that only when memory is searched very often. On a GPU the extra cost drops to seconds a day (an estimate, no GPU was measured), and the fit steps up to granite-embedding:278m.

mxbai-embed-large, which earlier versions of this guide recommended, is the slowest of the three. If you already pulled it, the fit uses it only when it passes the checks on your machine and neither granite model is installed, and it then proposes pulling granite-embedding:30m (62 MB). The fit keeps its own copy of these numbers, with their sources, in `EMBEDDER_LADDER` (`src/fork/embedder-fit.ts`).

## Step 5: Persona Setup

### 5a. SOUL.md — Your Agent's Identity

Edit `~/.openclaw/workspace/SOUL.md` with your agent's name, personality, and behavioral guidelines. This is NOT Jarvis — define your own agent identity.

Key sections to customize:

- Agent name and personality traits
- Communication style preferences
- Behavioral rules and safety constraints
- Knowledge domains and expertise areas

### 5b. SESSION.md (optional)

If you want a session prompt that loads on every `/new` command, create `~/.openclaw/workspace/SESSION.md`. This is the thin dispatcher that reads BRIEFING.md and runs pre-checks.

### 5c. BRIEFING.md (optional)

Daily briefing pipeline. Create `~/.openclaw/workspace/BRIEFING.md` if you want morning briefing automation.

## Step 5.5: Structural Crons — turn on the self-maintenance

This is the step most people never find, because until 2026-09-08 there was nothing to find:
the nightly jobs that make this fork maintain itself lived only in one machine's private cron
store. They now ship with the repo, in `extensions/tinkerclaw-tinker-bridge/crons/`.

Seven jobs: a nightly reflection on your day, memory consolidation, an AI-field scan, a
read-only security sweep, an agent-OSS survey, workspace hygiene, and a model-rank refresh. Full descriptions and the
safety rules every routine follows are in that directory's `README.md`.

```bash
pnpm tinker:crons -- --list       # what ships, and what you already have
pnpm tinker:crons                 # install the missing ones, switched ON
pnpm tinker:crons -- --disabled   # install them, switched off
```

`scripts/setup.sh` asks once during a fresh install and defaults to **on**, so a fresh clone
behaves like a mature one. The cost is stated in the question rather than hidden behind a safe
default: each job wakes an agent on a schedule and spends model tokens on your account, roughly
one euro a night for the whole cycle. Switch any of them off with `openclaw cron disable <id>`
(`openclaw cron list --all` to find the id — note `--all`, since plain `list` hides disabled
jobs).

The seeder is idempotent and safe to re-run after every `git pull`; that is how you pick up
jobs added upstream later. It needs a running gateway, and says so plainly if one is missing.

To customise a routine without fighting `git pull`, copy it to
`~/.openclaw/workspace/crons/<id>/routine.md` and edit it there — the same workspace-overrides-
repo contract as `SOUL.md`, resolved in that order at run time.

## Step 6: Voice / TTS (optional)

The fork supports multiple TTS providers. Configure in `openclaw.json`:

```json
{
  "messages": {
    "tts": {
      "provider": "edge",
      "voice": "en-GB-RyanNeural"
    }
  }
}
```

Providers: `edge` (free, no key), `elevenlabs` (requires API key), `openai` (requires API key), `sherpa-onnx` (local, requires model download).

For sherpa-onnx local TTS:

```bash
# Download a voice model (e.g., Piper en_GB alan medium)
mkdir -p ~/.openclaw/tools/sherpa-onnx-tts/models
# Follow sherpa-onnx docs for model installation
```

## Step 7: Systemd Services (optional, Linux)

For auto-start on boot:

**Gateway service** (`~/.config/systemd/user/openclaw-gateway.service`):

```ini
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/%u/src/tinkerclaw
ExecStart=/usr/local/bin/openclaw-gateway
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

**Tinker UI service** (`~/.config/systemd/user/tinker-ui.service`):

```ini
[Unit]
Description=Tinker UI (Vite dev server for OpenClaw webchat)
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/%u/src/tinkerclaw/tinker-ui
ExecStart=/usr/bin/env pnpm vite --port 18790
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Enable:

```bash
systemctl --user daemon-reload
systemctl --user enable --now openclaw-gateway tinker-ui
```

## Step 8: Verify Everything

**If using systemd (Step 7):**

```bash
systemctl --user start openclaw-gateway
journalctl --user -u openclaw-gateway --since '1 min ago' | grep -E 'listening|error|missing'
# Expected: "listening on ws://127.0.0.1:18789"
```

**If running manually (no systemd):**

```bash
openclaw gateway start
# Wait ~30s for startup
```

**Then verify:**

```bash
# Check plugins loaded
journalctl --user -u openclaw-gateway --since '1 min ago' | grep -E 'ready|loaded|registered'

# Test LLM
openclaw agent --to self --session-id verify -m "reply PONG"

# Open Tinker UI
# http://localhost:18790 (if Vite dev server running)
# or http://localhost:18789/tinker/ (gateway-served)
```

## After Upstream Merges

Every time you pull upstream changes:

```bash
git pull upstream main
node ~/.openclaw/fork-scripts/apply-fork-wiring.mjs   # Re-apply fork patches
bash ~/.openclaw/fork-scripts/merge-guardian.sh         # Verify wiring
pnpm install                                            # Install new deps
node scripts/tsdown-build.mjs && node scripts/runtime-postbuild.mjs && node scripts/build-stamp.mjs
pnpm rebuild better-sqlite3 opusscript                  # Rebuild native deps if needed
openclaw gateway restart                                # Restart gateway
```

## Troubleshooting

### "missing scope: operator.admin" on all WS calls

The `isOperatorUiClient()` function doesn't recognize Tinker UI. Run `apply-fork-wiring.mjs` — it patches `message-channel.ts` to include `WEBCHAT_UI`.

### WhatsApp "rootCfg is not defined" crash

Upstream merge wiped the `rootCfg` initialization. Run `apply-fork-wiring.mjs` — it patches `accounts.ts`.

### Usage graphs stuck at old percentage

The OAuth usage API may be disabled. The fork captures usage from response headers (`anthropic-ratelimit-unified-5h-utilization`). If no successful API call has been made, the graphs show cached data. The budget-panel ignores file data older than 7 days.

### "Exploration required" blocks all tools

The prefrontal exploration gate has case-sensitive tool names. Run `apply-fork-wiring.mjs` or check `extensions/prefrontal/exploration-gate.ts` — tool names must include both PascalCase (`Read`) and lowercase (`read`) variants.

### learned-intuition "missing register/activate export"

The plugin uses the old function-style `definePluginEntry`. It should use `definePluginEntry({ id, name, register(api) {} })`. This is fixed in the fork — if it regresses, check `extensions/tinkerclaw-learned-intuition/index.ts`.

### ONNX models not available

The learned-intuition extension falls back to rule-based heuristics automatically. No action needed. ONNX models are optional and stored in `models/amygdala/` (not checked into git).

### No GPU available

Everything runs on CPU:

- **Embeddings**: `openclaw embedder fit` measures what this CPU can sustain and picks a model that fits it, or none (word search only). See [4e. Memory search](#4e-memory-search-embeddings).
- **ONNX runtime**: Automatically falls back from CUDA to CPU
- **Cloud embeddings**: only after an explicit yes (`openclaw embedder fit --allow-remote <provider>`), because memory text would leave the machine

## Architecture Reference

### Port Map

| Port  | Service                     |
| ----- | --------------------------- |
| 18789 | Gateway (WebSocket + HTTP)  |
| 18790 | Tinker UI (Vite dev server) |
| 18791 | Browser control             |
| 18792 | Health check                |
| 11434 | Ollama (if running)         |

### Key Directories

| Path                                               | Purpose                                   |
| -------------------------------------------------- | ----------------------------------------- |
| `~/.openclaw/openclaw.json`                        | Main config                               |
| `~/.openclaw/agents/main/agent/auth-profiles.json` | API keys and OAuth tokens                 |
| `~/.openclaw/workspace/`                           | Agent workspace (SOUL.md, memory, skills) |
| `~/.openclaw/credentials/whatsapp/`                | WhatsApp session data                     |
| `~/.openclaw/engram/`                              | Total Recall episodic memory stores       |
| `~/.openclaw/cognitive/`                           | Cross-extension shared state              |
| `~/.openclaw/fork-scripts/`                        | Merge automation scripts                  |
| `~/src/tinkerclaw/extensions/`                     | Fork extension source code                |
| `~/src/tinkerclaw/tinker-ui/`                      | Webchat UI source                         |

### Fork Extensions

| Extension                       | Purpose                     | Requires                                    |
| ------------------------------- | --------------------------- | ------------------------------------------- |
| tinkerclaw-total-recall         | Episodic memory             | Nothing extra (recall is word search)       |
| tinkerclaw-learned-intuition    | Safety gate                 | ONNX models (optional, rule-based fallback) |
| tinkerclaw-fractal-reflection   | Post-turn reflection        | Nothing extra                               |
| tinkerclaw-identity-persistence | Persona consistency         | Nothing extra                               |
| tinkerclaw-computational-humor  | Humor calibration           | Nothing extra                               |
| tinkerclaw-round-table          | Multi-perspective reasoning | Nothing extra                               |
| prefrontal                      | Autonomous orchestration    | Nothing extra                               |
| budget-panel                    | Usage tracking              | OAuth token or response headers             |
| tinker                          | Webchat UI extension        | Nothing extra                               |
| auth-reload                     | Credential hot-reload       | Nothing extra                               |
