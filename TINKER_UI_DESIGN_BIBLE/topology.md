---
file: topology.md
purpose: What runs where, what talks to what, what's bundled vs separate
audience: AI
last_verified: 2026-06-04
last_verified_commit: 24237e0cd22
single_owner: yes — process map, plugin inventory, channel inventory, workspace symlinks, fork RPC-bundle registration live here
see_also: flows.md (how they talk), config-shape.md (what configures them), probes.md (how to call the RPCs)
verify:
  - name: gateway listening on 18789
    cmd: ss -ltn 2>/dev/null | grep -q ':18789' || netstat -ltn 2>/dev/null | grep -q ':18789'
  - name: cc-bridge plugin discoverable + manifest valid
    cmd: |
      manifest=~/src/tinkerclaw/dist-runtime/extensions/tinkerclaw-cc-bridge/openclaw.plugin.json
      stub=~/src/tinkerclaw/dist-runtime/extensions/tinkerclaw-cc-bridge/index.js
      [ -f "$manifest" ] || { echo "missing $manifest"; exit 1; }
      [ -f "$stub" ] || { echo "missing $stub"; exit 1; }
      grep -q '"id":\s*"tinkerclaw-cc-bridge"' "$manifest" || { echo "manifest id mismatch"; exit 1; }
      python3 -c "import json,sys; m=json.load(open('$manifest')); a=m.get('activation',{}); ps=a.get('onProviders',[]); sys.exit(0 if 'claude-code' in ps else 1)" || { echo "manifest missing activation.onProviders containing 'claude-code' — cc-bridge is lazy-loaded; this gates activation"; exit 1; }
      echo "tinkerclaw-cc-bridge manifest + stub discoverable, lazy-activation wired to claude-code"
  - name: workspace symlinks present (skills NOT symlinked per design)
    cmd: "[ -L ~/.openclaw/workspace/src ] || [ -d ~/.openclaw/workspace/src ]"
  - name: every fork-owned plugin dir uses the tinkerclaw- prefix
    cmd: bash -lc 'cd ~/src/tinkerclaw && violators=$(for d in extensions/*/; do d=${d%/}; if grep -q "FORK\|fork-owned\|@tinkerclaw" "$d/openclaw.plugin.json" "$d/index.ts" "$d/README.md" 2>/dev/null && [[ "$(basename $d)" != tinkerclaw-* ]]; then echo "$d"; fi; done); test -z "$violators" || (echo "fork plugins missing tinkerclaw- prefix: $violators"; exit 1)'
  - name: U4 fork.strategy.switch.list RPC registered + answers (no params)
    cmd: python3 -c 'import subprocess; r=subprocess.run(["openclaw","gateway","call","fork.strategy.switch.list"],capture_output=True,text=True); assert "\"ok\"" in r.stdout, r.stdout[-400:]'
  - name: U6 fork.skill.search RPC registered + answers (query required)
    cmd: python3 -c 'import subprocess; r=subprocess.run(["openclaw","gateway","call","fork.skill.search","--params","{\"query\":\"x\",\"k\":1}"],capture_output=True,text=True); assert "\"ok\"" in r.stdout, r.stdout[-400:]'
  - name: SS3 fork.skill.put RPC + semantic fork.skill.search wired (resolveSkillEmbedFn, DRY with the consolidation cron)
    cmd: grep -q '"fork.skill.put"' ~/src/tinkerclaw/src/fork/skill-rpc.ts && grep -q "resolveSkillEmbedFn" ~/src/tinkerclaw/src/fork/skill-rpc.ts
  - name: SS3 single-owner — prefrontal.recipe.compose lives in the prefrontal extension, NOT topology's fork bundles
    cmd: grep -q '"prefrontal.recipe.compose"' ~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/recipe-rpcs.ts && ! grep -q "prefrontal.recipe.compose" ~/src/tinkerclaw/src/gateway/server-methods.ts
  - name: U3 fork.memory.search RPC registered + answers (query required, temporalMode)
    cmd: python3 -c 'import subprocess; r=subprocess.run(["openclaw","gateway","call","fork.memory.search","--params","{\"query\":\"x\",\"temporalMode\":\"current\"}"],capture_output=True,text=True); assert "\"ok\"" in r.stdout, r.stdout[-400:]'
  - name: U7/U9/U10 new component files present on disk
    cmd: python3 -c 'import glob,os; b=os.path.expanduser("~/src/tinkerclaw"); reqd=["extensions/tinkerclaw-round-table/src/orchestrator-api.ts","extensions/tinkerclaw-prefrontal/cc-skills-bridge.ts","src/agents/pi-extensions/link-builder-runtime.ts","src/fork/reasoning-runtime.ts"]; miss=[p for p in reqd if not os.path.isfile(os.path.join(b,p))]; assert not miss, "missing: "+str(miss)'
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

| Plugin id                         | Purpose                                                                                                                                                                                                                                    | Hooks used                                                                       | Status                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------- |
| `tinkerclaw-cc-bridge`            | drives claude-cli as a persistent subprocess provider for `claude-code`. `combinedSystemPrompt` includes the ethical-rules block (FORK 2026-05-21) between persona and narration.                                                          | `registerProvider`, `registerPluginProviderConfigOverlay` (FORK 2026-05-10)      | DEPLOYED                                      |
| `tinkerclaw-whatsapp`             | whatsmeow-backed WA channel (replaces upstream baileys)                                                                                                                                                                                    | channel registration, monitor hook chain                                         | DEPLOYED                                      |
| `tinkerclaw-people`               | people-profile resolver (`people.{resolve,read,list,update_consulted_at}`)                                                                                                                                                                 | RPC handlers                                                                     | DEPLOYED                                      |
| `tinkerclaw-control-panel`        | task store + Today card / Exec HUD panel (v3.5 — 2026-05-22; `task_axis.parent_id` two-level hierarchy, `axes.add/update` accept `parent_id`, Todoist scrub one-shot migration). See `tinker-ui.md` §5.68, `config-shape.md` schema notes. | RPC handlers (`control-panel.*`), HUD render via Tinker UI                       | DEPLOYED (v3.5)                               |
| `tinkerclaw-prefrontal`           | orchestration observability (recipe-state, trail events)                                                                                                                                                                                   | `before_dispatch`, `agent_end`, `llm_input`, `llm_output` hooks                  | DEPLOYED                                      |
| `tinkerclaw-memory-enhancements`  | MNEMOSYNE — hippocampus index + compaction capture (J14)                                                                                                                                                                                   | `retrieval_pre`, `before_message_write`, `before_compaction`, `after_compaction` | partial (v0.1 scaffold)                       |
| `tinkerclaw-computational-humor`  | LIMBIC (J7)                                                                                                                                                                                                                                | hooks                                                                            | DEPLOYED                                      |
| `tinkerclaw-identity-persistence` | CORTEX (J4)                                                                                                                                                                                                                                | persona-state hooks                                                              | DEPLOYED                                      |
| `tinkerclaw-learned-intuition`    | AMYGDALA (J11) v3.1 — AEGIS rules enforced pre-execution (cc-bridge PreToolUse hook + native `{block}`) + k-NN novelty ASK channel + clause-cosine incongruity; legacy 5-net ensemble retired (legacyEnsemble=false)                       | hooks + cc-bridge `--settings` PreToolUse hook                                   | DEPLOYED (v3.1, AEGIS on, novelty observe)    |
| `tinkerclaw-round-table`          | SYNAPSE (J6)                                                                                                                                                                                                                               | hooks                                                                            | FAILING to load (missing `@sinclair/typebox`) |
| `tinkerclaw-total-recall`         | ENGRAM (J1)                                                                                                                                                                                                                                | hooks                                                                            | FAILING to load (missing `@sinclair/typebox`) |

Plus core (non-tinkerclaw-prefixed): `auth-reload`, `browser`, `budget-panel`, `diagnostics-otel`.

Note: `hippocampus` → `tinkerclaw-hippocampus` and `tinker` → `tinkerclaw-tinker` as of 2026-05-13 cleanup.

**Open issue:** the `@sinclair/typebox` missing-module pattern is a recurring native-deps issue. See bible §11.x for the rule about `pnpm.onlyBuiltDependencies` getting wiped on upstream merges.

## Fork RPC bundles (gateway server-methods)

All fork RPCs are spread into `coreGatewayHandlers` in `src/gateway/server-methods.ts` (one `...handlersObject` per bundle, same pattern as upstream). Each bundle is a `GatewayRequestHandlers` map whose string keys ARE the wire method names. This optic owns the registration map; `probes.md` owns how to call each one; `config-shape.md` owns the config keys that gate them.

The OSS-harness upgrade wave (develop `06f8647fdc` on top of `70ad58e45d`) added/extended these fork bundles. The full upgrade roadmap is `docs/notes/2026-05-30-papers-coverage-and-oss-roadmap.md` Part 3 in the jarvis-icu repo.

| Bundle export                 | Import path (`src/…`)                       | Wire methods                                                                             | Upgrade                | Status                                                        |
| ----------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------- |
| `forkSubagentsHandlers`       | `fork/subagents-rpc.js`                     | `fork.subagents.spawn`                                                                   | —                      | DEPLOYED                                                      |
| `forkPrefrontalStateHandlers` | `fork/prefrontal-state-rpc.js`              | prefrontal recipe-state + trail events                                                   | —                      | DEPLOYED                                                      |
| `forkCuriosityHandlers`       | `fork/curiosity-rpc.js`                     | `fork.curiosity.logGap`, `fork.curiosity.topGaps`, `fork.curiosity.resolveGap`           | U2 (J8)                | DEPLOYED                                                      |
| `forkOverseerHandlers`        | `fork/overseer-runtime.js`                  | overseer activate/deactivate/status                                                      | —                      | DEPLOYED                                                      |
| `forkReasoningHandlers`       | `fork/reasoning-runtime.js`                 | `fork.reasoning.search`                                                                  | U10 (J3↔J13)           | DEPLOYED (RPC registered; runs a model — NOT in verify suite) |
| `forkStrategyHandlers`        | `gateway/server-methods/engram-strategy.js` | `fork.strategy.switch.list`, `fork.strategy.switch.apply`, `fork.strategy.switch.review` | U4 (J5)                | DEPLOYED + VERIFIED-LIVE                                      |
| `forkSkillHandlers`           | `fork/skill-rpc.js`                         | `fork.skill.search` (semantic, SS3), `fork.skill.recordOutcome`, `fork.skill.put` (SS3)  | U6 (J5+J2) · SS3 (J16) | DEPLOYED + VERIFIED-LIVE                                      |
| `forkMemoryHandlers`          | `fork/memory-rpc.js`                        | `fork.memory.search` (+ `fork.engram.consolidate.run`)                                   | U3 (J2+J14)            | DEPLOYED + VERIFIED-LIVE                                      |

**Param contracts (verify-relevant gotcha).** `fork.strategy.switch.list` takes NO params → returns `{ok:true,decisions:[]}` on an empty failure-state map. But `fork.skill.search` and `fork.memory.search` REQUIRE a `query` param — calling them with no params returns `GatewayClientRequestError: '…': 'query' required` (rc=1), NOT `{ok:true}`. So the verify blocks pass `--params '{"query":"x",…}'`. `fork.memory.search` additionally threads `temporalMode` (`current` | `as-of`) / `asOfTime` into manager-search for point-in-time recall (the U3 bi-temporal read path; the supersede WRITE path is owned by `lifecycles.md`/ENGRAM). The CLI prints a config-warnings banner to stderr (stale `whatsapp`/`telegram` plugin entries) before the JSON on stdout — assert a substring of stdout, never parse the whole stream.

**SS3 — `forkSkillHandlers` gained `fork.skill.put`; `fork.skill.search` went semantic (develop `24237e0cd22`).** `forkSkillHandlers` now exports a THIRD method, `fork.skill.put` — the Voyager deposit RPC (`lib.put` was previously unexposed, so depositing a reusable skill was unimplementable via RPC). It is caller-driven (`prefrontal.recipe.compose` + the consolidation path call it). **Param-contract gotcha (the deposit gate fails CLOSED):** unlike search (which gates on a missing `query`), `fork.skill.put` gates on a malformed _skill object_ — a skill with an empty `name` or zero `steps` returns `INVALID_REQUEST` (rc=1, NOT `{ok:true}`); `promote:true` additionally requires a measured `candidateRate` and applies `clearsPromotionBar()` (a J16 live-margin bar — mean + 1σ of the library's current `successRate` distribution, never a frozen N; non-clearing returns `{ok:false,promoted:false}`). A valid deposit is reversible/idempotent for free (never-delete archive + same-name version-bump). And `fork.skill.search` now resolves an in-process embed fn via `resolveSkillEmbedFn` (`src/memory/engram/skill-embed.ts`, the SAME path the consolidation cron uses — DRY) → batched-embed + cosine ranking, keyword fallback only when no provider. **Single-owner boundary (do not duplicate here):** `prefrontal.recipe.compose` (compose-from-library) is registered in the prefrontal extension's `recipe-rpcs.ts`, NOT spread into `coreGatewayHandlers` in `src/gateway/server-methods.ts` — so it is NOT a fork bundle and stays OUT of this table; the `prefrontal.recipe.*` family + the `invoke skill:` directive behavior are owned by `subagents-and-recipes.md`.

**Dead-code trap (U7 7D/7G).** `extensions/tinkerclaw-round-table/src/orchestrator-api.ts` calls two gateway RPCs that DO NOT EXIST yet: `agent.getBillingState` (7D budget clamp) and `plugins.getOrchestrator` (7G external orchestrator load). Both degrade gracefully — billing clamp becomes a no-op and `getOrchestrator(id)` falls back to the built-in `raacOrchestrator`. These bind only once those host RPCs land. Registered as a dead-code trap; full registry in `config-shape.md`.

## New components (06f8647fdc — OSS-harness upgrade wave)

These are new source modules/registries that are NOT plugins (no `openclaw.plugin.json`) — they are libraries/runtimes wired into existing plugins or the embedded-runner. Listed here for the component map; behavior/intent lives in the cited optic.

| Component                 | Path                                     | Role                                                                                                                                                                                                                                                                 | see also                                                                       |
| ------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `orchestrator-api.ts`     | `extensions/tinkerclaw-round-table/src/` | U7: `DebateOrchestrator` iface + built-in `raacOrchestrator` + `getOrchestrator(id)` + `setExternalOrchestratorLoader`. Round-table speaker-select ext.                                                                                                              | flows.md (debate flow), config-shape.md (`orchestratorId`)                     |
| `cc-skills-bridge.ts`     | `extensions/tinkerclaw-prefrontal/`      | U11: external recipe acquisition — `SKILL.md → RecipeSpec` (`validateRecipeSpec` + `buildRecipeMd`); local fallback for `recipe.search` when Journey unreachable.                                                                                                    | subagents-and-recipes.md                                                       |
| `link-builder-runtime.ts` | `src/agents/pi-extensions/`              | U9 (A-MEM): per-session [[wikilink]]/backlink registry. `setLinkBuilderRuntime(sessionManager, builder)` registered at the session-setup site `src/agents/embedded-agent-runner/extensions.ts:176`, beside `setIngestionRuntime` (169).                              | memory-layout.md (link-index JSONL)                                            |
| `reasoning-runtime.ts`    | `src/fork/`                              | U10 (ToT/LATS): per-session reasoning registry — `setReasoningRuntime`/`getReasoningRuntime`, tri-state `getReasoningMode` (`none`\|`tree`\|`lats`), `runReasoningSearch`, plus the `forkReasoningHandlers` RPC bundle and `maybeRunThoughtSearch` pre-prompt entry. | tool-loop.md (pre-prompt search), config-shape.md (`fork.cognitive.reasoning`) |

Per-session registries (U9 link-builder, U10 reasoning) follow the existing `setIngestionRuntime` pattern: a module-level `Map<sessionManager, runtime>` set at embedded-runner session setup, read fire-and-forget from `onTurnComplete`. They are NOT gateway RPCs themselves (except `reasoning-runtime` which ALSO exports the `forkReasoningHandlers` RPC bundle above).

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
| journeykits.ai  | HTTPS    | kit registry — search/get/install/publish   | `extensions/prefrontal/recipe-rpcs.ts`        | `https://www.journeykits.ai` | `integrations.journey.apiKey` required for publish/private |
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
