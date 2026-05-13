---
file: topology.md
purpose: What runs where, what talks to what, what's bundled vs separate
audience: AI
last_verified: 2026-05-11
last_verified_commit: HEAD
single_owner: yes — process map, plugin inventory, channel inventory, workspace symlinks live here
see_also: flows.md (how they talk), config-shape.md (what configures them)
verify:
  - name: gateway listening on 18789
    cmd: ss -ltn 2>/dev/null | grep -q ':18789' || netstat -ltn 2>/dev/null | grep -q ':18789'
  - name: cc-bridge plugin loaded
    cmd: journalctl --user -u openclaw-gateway.service --since '15 minutes ago' --no-pager 2>&1 | grep -q 'tinkerclaw-cc-bridge'
  - name: workspace symlinks present (skills NOT symlinked per design)
    cmd: "[ -L ~/.openclaw/workspace/src ] || [ -d ~/.openclaw/workspace/src ]"
  - name: every fork-owned plugin dir uses the tinkerclaw- prefix
    cmd: bash -lc 'cd ~/src/tinkerclaw && violators=$(for d in extensions/*/; do d=${d%/}; if grep -q "FORK\|fork-owned\|@tinkerclaw" "$d/openclaw.plugin.json" "$d/index.ts" "$d/README.md" 2>/dev/null && [[ "$(basename $d)" != tinkerclaw-* ]]; then echo "$d"; fi; done); test -z "$violators" || (echo "fork plugins missing tinkerclaw- prefix: $violators"; exit 1)'
---

# Topology — components, ports, plugins, channels, symlinks

## Process map

| Process                | Port  | Purpose                                           | Source                                      |
| ---------------------- | ----- | ------------------------------------------------- | ------------------------------------------- |
| OpenClaw gateway       | 18789 | WebSocket gateway + HTTP routes + Control UI      | `dist/index.js gateway --port 18789`        |
| Tinker UI Vite dev     | 18790 | HMR-enabled webchat dev server                    | `cd tinker-ui && vite --port 18790`         |
| Browser relay + health | 18792 | extension WebSocket + CDP endpoint (Chrome relay) | gateway-internal                            |
| Browser control HTTP   | 18791 | `127.0.0.1` token-auth HTTP for browser commands  | gateway-internal                            |
| ClawMetry OTEL         | 4001  | traces + metrics endpoint                         | `~/src/clawmetry/` (separate process)       |
| Mission Control        | 4000  | dashboard (Docker)                                | `~/src/mission-control/` (separate process) |

**The gateway process is the central anchor.** Everything fork-side runs in-process under it: plugins, channel adapters, cron scheduler, the cc-bridge worker pool. Subprocesses are claude-cli per cc-bridge worker (re-parented to systemd via `--pipe`), whatsmeow-node binary for WhatsApp transport, and ephemeral exec tool processes.

## Plugin inventory

All fork plugins use the `tinkerclaw-` prefix in their plugin id, directory name, and openclaw.plugin.json. Four places this must match: `index.ts`, `openclaw.plugin.json`, dist-runtime manifest, openclaw.json config key.

| Plugin id                         | Purpose                                                                    | Hooks used                                                                       | Status                                        |
| --------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------- |
| `tinkerclaw-cc-bridge`            | drives claude-cli as a persistent subprocess provider for `claude-code`    | `registerProvider`, `registerPluginProviderConfigOverlay` (FORK 2026-05-10)      | DEPLOYED                                      |
| `tinkerclaw-whatsapp`             | whatsmeow-backed WA channel (replaces upstream baileys)                    | channel registration, monitor hook chain                                         | DEPLOYED                                      |
| `tinkerclaw-people`               | people-profile resolver (`people.{resolve,read,list,update_consulted_at}`) | RPC handlers                                                                     | DEPLOYED                                      |
| `tinkerclaw-prefrontal`           | orchestration observability (recipe-state, trail events)                   | `before_dispatch`, `agent_end`, `llm_input`, `llm_output` hooks                  | DEPLOYED                                      |
| `tinkerclaw-memory-enhancements`  | MNEMOSYNE — hippocampus index + compaction capture (J14)                   | `retrieval_pre`, `before_message_write`, `before_compaction`, `after_compaction` | partial (v0.1 scaffold)                       |
| `tinkerclaw-computational-humor`  | LIMBIC (J7)                                                                | hooks                                                                            | DEPLOYED                                      |
| `tinkerclaw-identity-persistence` | CORTEX (J4)                                                                | persona-state hooks                                                              | DEPLOYED                                      |
| `tinkerclaw-learned-intuition`    | AMYGDALA (J11) — rule-based fallback (ONNX models not present)             | hooks                                                                            | DEPLOYED (phase 1, observeOnly=false)         |
| `tinkerclaw-round-table`          | SYNAPSE (J6)                                                               | hooks                                                                            | FAILING to load (missing `@sinclair/typebox`) |
| `tinkerclaw-total-recall`         | ENGRAM (J1)                                                                | hooks                                                                            | FAILING to load (missing `@sinclair/typebox`) |

Plus core (non-tinkerclaw-prefixed): `auth-reload`, `browser`, `budget-panel`, `diagnostics-otel`.

Note: `hippocampus` → `tinkerclaw-hippocampus` and `tinker` → `tinkerclaw-tinker` as of 2026-05-13 cleanup.

**Open issue:** the `@sinclair/typebox` missing-module pattern is a recurring native-deps issue. See bible §11.x for the rule about `pnpm.onlyBuiltDependencies` getting wiped on upstream merges.

## Channel inventory

| Channel id            | Surface                 | Auth model                                           | Config key                                          |
| --------------------- | ----------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| webchat (Tinker UI)   | browser at 18790 (Vite) | token (`?token=…`)                                   | `channels.tinker` (implicit, via the tinker plugin) |
| whatsapp (DM + group) | whatsmeow subprocess    | linked-device session (`.openclaw/state/whatsmeow/`) | `channels.whatsapp`                                 |
| telegram              | bot HTTPS               | bot token                                            | `channels.telegram` (DISABLED at present)           |
| cron                  | gateway-internal        | scheduler                                            | `~/.openclaw/cron/jobs.json`                        |
| subagent              | gateway-internal RPC    | parent session inherits                              | `fork.subagents.spawn`                              |

**WhatsApp specifics:** the fork uses `tinkerclaw-whatsapp` exclusively. Upstream's baileys channel is not loaded. The delivery function is named `deliverWebReply` despite delivering to WhatsApp — historical name preserved across many call sites; do NOT rename without a coordinated update.

## Workspace symlink architecture (FORK 2026-04-09)

The runtime workspace is `~/.openclaw/workspace/`. Code directories under it are SYMLINKS into `~/src/tinkerclaw/`. There are 164 such symlinks. The non-symlinked directories under workspace are private state (memory/, agents/, channels/, etc.).

Rules:

- **Build from the fork only.** `cd ~/src/tinkerclaw && npx tsdown`. NEVER `tsdown` from `~/.openclaw/workspace` (wrong .git, will commit into jarvis-brain).
- **Skills stay real, not symlinked.** `workspace/skills/` lives in jarvis-brain (private). Promotion to public = copy to `~/src/tinkerclaw/skills/`.
- **Full restart for code changes.** SIGUSR1 (`openclaw-restart` no flag) doesn't re-import ES modules. `openclaw-restart --full` after dist changes.

Two git repos coexist:

- `~/src/tinkerclaw/.git` → public GitHub (`globalcaos/tinkerclaw`)
- `~/.openclaw/workspace/.git` → private GitLab (`globalcaos/jarvis-brain`)

The PII boundary between these two repos is critical. See `pii-boundary.md`.

## Sister processes (out-of-gateway)

| Process                | Purpose                                                        | Location                                                              |
| ---------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `whatsmeow-node`       | WhatsApp transport subprocess (spawned by tinkerclaw-whatsapp) | `node_modules/@whatsmeow-node/linux-x64/bin/`                         |
| `claude-cli`           | one subprocess per cc-bridge worker                            | `~/.claude/` install, spawned by cc-bridge with `--pipe` re-parenting |
| `ollama`               | local embedding model (mxbai-embed-large) for `memorySearch`   | `127.0.0.1:11434` (systemd)                                           |
| `chrome-relay` profile | persistent Chrome at `CDP=127.0.0.1:18792`                     | user-managed, attached-only                                           |

## External services (HTTPS)

Services called outbound by the gateway or its plugins over HTTPS.

| Service         | Protocol | Purpose                                     | Source file                                   | Base URL                     | Auth                                                       |
| --------------- | -------- | ------------------------------------------- | --------------------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| journeykits.ai  | HTTPS    | kit registry — search/get/install/publish   | `extensions/prefrontal/kit-rpcs.ts`           | `https://www.journeykits.ai` | `integrations.journey.apiKey` required for publish/private |
| Anthropic API   | HTTPS    | LLM inference (claude models via api key)   | `src/agents/auth-profiles/credential-file.ts` | `https://api.anthropic.com`  | `auth-profiles.json` api key                               |
| claude.ai OAuth | HTTPS    | OAuth2 refresh for cli-gm / cli-sv profiles | `src/agents/auth-profiles/credential-file.ts` | `https://claude.ai`          | refresh_token in `.credentials-*.json`                     |

## File-system layout snapshot

```
~/src/tinkerclaw/                        # fork code (public)
  TINKER_UI_DESIGN_BIBLE/                # the bible (this directory)
  src/                                   # gateway source
  extensions/tinkerclaw-*/               # fork plugins
  tinker-ui/                             # Tinker UI Vite app
  dist/                                  # built gateway (committed for runtime)

~/.openclaw/                             # runtime state (mostly private)
  openclaw.json                          # config
  workspace/                             # symlinks into fork + private memory
    skills/                              # real (not symlinked) — private
    memory/                              # private
  agents/main/sessions/                  # session store + transcripts
  cc-bridge/session-map.json             # cc-bridge ↔ claude-cli mapping
  cron/jobs.json + runs/                 # cron registry + receipts
  data/                                  # databases (whatsapp-history.db, etc.) + tinker-ui snapshot probe

~/Documents/AI_reports/Papers/J*/        # J-series papers (public-ish)
```

## Auto-generation

This file can be partially auto-generated:

- Plugin inventory from `find dist/extensions -name openclaw.plugin.json`
- Channel inventory from `openclaw.json` `channels.*` keys
- Port map from `dist/index.js` greps + `openclaw.json` `diagnostics.otel.endpoint` etc.

The prose explaining boundaries and rules stays hand-written.
