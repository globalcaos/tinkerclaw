# Prefrontal

> Autonomous orchestration with live agent topology, effort routing, anti-goldplating, and CORF trigger.

**Paper:** J13 — PREFRONTAL: Compounded Intelligence
**Status:** Production (deployed 6+ months)
**Vanilla OpenClaw:** Yes — drop-in installation

## What It Does

Acts as the executive control layer for the entire agent system. It tracks every running subagent in a live force-directed topology graph, routes tasks to models by effort tier (cheap for simple, expensive for complex), guards against over-engineered responses (anti-goldplating), fires clarifying questions before expensive work starts (forcing questions), and triggers a structured CORF debate when the agent is stuck in a denial loop. A live call tree is available at `GET /api/prefrontal/tree` and via the Tinker UI.

## What it can do, and what is off by default

Prefrontal is an executive control layer. It runs with more authority than a
typical plugin:

- It registers a `before_tool_call` hook. The exploration gate, the denial
  tracker and the permission hooks can each refuse a tool call.
- It prepends text (anti-goldplating rules, forcing questions, matched recipe
  steps) to agent prompts via `before_prompt_build`.
- Effort routing (`autoRoute`, on by default) can move a task to a different
  model tier, which changes cost and which provider sees the prompt.
- It serves `/api/prefrontal` (gateway-authenticated): the live call tree,
  including session keys and tool names.

### Gateway methods

Every method below is registered with scope `operator.admin`, so only an
admin-scoped gateway client can call it. `prefrontal.kit.*` names are aliases
of the matching `prefrontal.recipe.*` methods. Names in the table omit the
`prefrontal.` prefix.

| Method                                                                      | What it does                                                                                                                                                                                                                                          | Default                                       |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `recipe.list`, `recipe.read`, `recipe.match`, `recipe.search`, `recipe.get` | Read recipes. `read` accepts a `path` only if it is a `.md` file inside the recipe directories (symlinks resolved). `search` and `get` query JourneyKits (`search` falls back to the local catalog).                                                  | on                                            |
| `recipe.run`                                                                | Runs a recipe. Steps spawn subagents through the gateway with `operator.admin` scope, the same authority an admin operator has; in a TinkerClaw checkout a step may start `node scripts/openclaw-spawn-subagent.mjs` with fixed arguments (no shell). | on                                            |
| `recipe.author`, `recipe.compose`                                           | Write recipe files in this plugin's own `recipes/` directory (a snapshot is kept for rollback).                                                                                                                                                       | on                                            |
| `recipe.optimize`                                                           | Reads the plan archive and proposes step rewrites for a recipe. Only proposes.                                                                                                                                                                        | on                                            |
| `recipe.applyProposal`, and the apply step of `recipe.optimize`             | Asks a subagent (LLM) to rewrite a recipe and writes the result to disk. Only recipes marked `authoredBy: jarvis-*` are changed; a snapshot is kept and a rewrite that fails validation is dropped.                                                   | **off** — env `RECIPE_AUTOAPPLY_ENABLED=true` |
| `recipe.install` with `skillMd`                                             | Converts a SKILL.md you pass in into a local recipe. No network.                                                                                                                                                                                      | on                                            |
| `recipe.install` with a `kitRef`                                            | Downloads recipe files from JourneyKits into `~/.openclaw/workspace/kits/`.                                                                                                                                                                           | **off** — `marketplace.allowRemoteInstall`    |
| `recipe.publish`                                                            | Uploads a local recipe to JourneyKits with `integrations.journey.apiKey`.                                                                                                                                                                             | **off** — `marketplace.allowPublish`          |
| `recipe.orchestrate`                                                        | Evaluates a caller-supplied JavaScript function body inside the gateway process, with the gateway's privileges (not sandboxed). It can spawn subagents in parallel or pipelines.                                                                      | **off** — `orchestration.allowScripts`        |
| `plan.set`, `plan.step`, `plan.get`, `plan.close`                           | Read and write plan-board state.                                                                                                                                                                                                                      | on                                            |
| `topology`, `tree`, `status`, `metrics`, `flags`                            | Read-only views: the agent topology graph and call tree (session keys, tool names), plugin status and file paths, FAAR task metrics, resolved feature flags.                                                                                          | on                                            |
| `config`                                                                    | Returns the merged `prefrontal` config section (monitor intervals and similar). It does not include `integrations.journey.apiKey` or other openclaw.json sections.                                                                                    | on                                            |
| `thalamusDefaults`                                                          | Reads, or with `{ tier, model }` sets, the default model for one Thalamus bias band (`low` / `medium` / `high`) in `~/.openclaw/thalamus-tier-defaults.json`; `model: null` clears it. Set from the model picker's right-click menu.                  | on                                            |
| `routes`                                                                    | Reads the last run's rows from `~/.openclaw/orca-routes.jsonl`, a file written by an external ORCA conductor. Returns an empty list if the file is absent.                                                                                            | on                                            |
| `orcaBias`                                                                  | With no params, reads `~/.openclaw/orca-bias.json`. With `biasIdx`, writes that file: the value is clamped to an integer 0–6 plus a timestamp. The path is fixed; the caller cannot choose it.                                                        | on                                            |

A disabled method returns an error naming the key that enables it:

```json
{
  "plugins": {
    "entries": {
      "tinkerclaw-prefrontal": {
        "config": {
          "orchestration": { "allowScripts": true },
          "marketplace": { "allowPublish": true, "allowRemoteInstall": true }
        }
      }
    }
  }
}
```

### Files it reads and writes

| Path                                                                                     | Contents                                                                                                                                                        |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.openclaw/prefrontal-state.json` (or `persistPath`)                                   | Topology snapshot, restored on start                                                                                                                            |
| `~/.openclaw/workspace/state/prefrontal/plans/`                                          | Plan board                                                                                                                                                      |
| `~/.openclaw/workspace/state/prefrontal/recovery.json`                                   | Crash-recovery state, read and deleted on start (owner-only)                                                                                                    |
| `~/.openclaw/recipe-vars.json`                                                           | Recipe variables, including values you mark secret; file mode 600, secrets masked in every emitted event                                                        |
| `recipes/` (in the plugin folder), `~/.openclaw/recipes/`, `~/.openclaw/workspace/kits/` | Authored, edited, bridged and downloaded recipes                                                                                                                |
| `.recipe-archive/` (next to the plugin's `recipes/` folder)                              | Snapshots taken before a recipe is rewritten                                                                                                                    |
| `~/.openclaw/orca-bias.json`                                                             | Written by `orcaBias` (one integer and a timestamp), read by `orcaBias`                                                                                         |
| `~/.openclaw/orca-routes.jsonl`                                                          | Read-only, by `routes`                                                                                                                                          |
| `~/.openclaw/engram/`                                                                    | Read for recipe fitness during matching and `recipe.run`; `recipe.run` appends recipe-attribution events to the session's event store there                     |
| `~/.openclaw/hooks/` (or `hooks.allowedRoots`)                                           | Permission-hook scripts, executed only when `hooks.enabled` is true. Each hook's stdin is passed through an owner-only temp file that is deleted after the call |

When `OPENCLAW_HOME` is set, this plugin treats it as the `.openclaw` directory
itself. That applies to the recovery file, `recipe-vars.json` and the
`recipes/` overlay. The other paths above stay under `~/.openclaw`.

### Environment switches

| Variable                                              | Effect                                                                                                                                                                                    | Default             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `RECIPE_AUTOAPPLY_ENABLED=true`                       | `recipe.applyProposal` and `recipe.optimize` write LLM-generated rewrites to recipe files (see above)                                                                                     | off (propose only)  |
| `PREFRONTAL_SEMANTIC_MATCH_ENABLED=true`              | Recipe matching also compares embeddings, computed by the gateway's `fork.prefrontal.embed` method (your configured memory-search provider). If it fails, matching falls back to keywords | off (keywords only) |
| `PREFRONTAL_EFFORT_BIAS=aggressive` or `conservative` | Effort routing moves non-trivial tasks one model tier up or down                                                                                                                          | neutral             |

### Permission hooks — opt-in, allowlisted, fail-closed

`hooks.before_tool` runs scripts you configure before matching tool calls.
They run as your user, so they are off unless `hooks.enabled` is true:

| Constraint             | Behaviour                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Opt-in**             | Nothing executes unless `hooks.enabled: true`. Defining a hook is not consent to run it; if you define hooks without enabling them, the plugin logs a warning and approves everything.                                          |
| **No shell**           | `script` must be a path to an executable FILE, run via `execFile` with `shell: false`. A command string like `"echo hi \| tee /tmp/x"` is refused, not executed — there is no metacharacter, pipeline or interpolation surface. |
| **Path allowlist**     | The script's real path (symlinks resolved) must sit inside `hooks.allowedRoots`, default `~/.openclaw/hooks`. A symlink pointing outside an allowed root is rejected rather than followed.                                      |
| **Not world-writable** | A script that is group- or world-writable is refused.                                                                                                                                                                           |
| **Least privilege**    | Hooks receive only `PATH`, `HOME` and `LANG`. They do **not** inherit the gateway environment, which holds the gateway auth token and provider API keys.                                                                        |
| **Fail closed**        | A hook that times out, exits non-zero, is misconfigured or emits invalid JSON **denies** the call.                                                                                                                              |

A hook reads a JSON payload (`{tool, args, sessionKey}`) on stdin and writes
`{"decision":"approve"}` or `{"decision":"deny","feedback":"why"}` on stdout.

```json
{
  "hooks": {
    "enabled": true,
    "allowedRoots": ["~/.openclaw/hooks"],
    "before_tool": [{ "tool": "Bash", "script": "~/.openclaw/hooks/gate-bash.sh", "timeout": 5000 }]
  }
}
```

Because hooks fail closed, a hook that matches `"*"` and cannot run will deny
every tool call. Test a new hook against a single tool first.

## Install

1. Copy this folder to `~/.openclaw/workspace/extensions/prefrontal/`
2. Add to `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["tinkerclaw-prefrontal"],
    "entries": {
      "tinkerclaw-prefrontal": {
        "enabled": true,
        "config": {
          "autoRoute": true,
          "maxConcurrentWorkers": 8,
          "monitorIntervalMs": 120000,
          "staleThresholdMs": 180000,
          "guardianStaleThresholdMs": 300000,
          "effortRouting": {
            "minimal": ["ollama/qwen3:latest"],
            "standard": ["anthropic/claude-haiku-4-5"],
            "maximum": ["anthropic/claude-sonnet-4-6"]
          },
          "featureFlags": {
            "explorationGate": true,
            "antiGoldplating": true,
            "forcingQuestions": true,
            "effortRouting": true,
            "corf": true,
            "faarTracking": true
          }
        }
      }
    }
  }
}
```

3. Restart gateway

## Configuration

| Key                              | Default  | Description                                                    |
| -------------------------------- | -------- | -------------------------------------------------------------- |
| `enabled`                        | `true`   | Enable or disable the plugin                                   |
| `autoRoute`                      | `true`   | Automatically route tasks to models by effort tier             |
| `maxConcurrentWorkers`           | `8`      | Maximum parallel subagent workers                              |
| `monitorIntervalMs`              | `120000` | How often the monitor checks for stuck agents (ms)             |
| `staleThresholdMs`               | `180000` | Time before an agent is marked stale (ms)                      |
| `guardianStaleThresholdMs`       | `300000` | Time before guardian triggers recovery (ms)                    |
| `effortRouting`                  | —        | Model lists per effort tier (`minimal`, `standard`, `maximum`) |
| `model`                          | —        | Primary model for Prefrontal analysis                          |
| `summaryModel`                   | —        | Model for topology summary generation                          |
| `pollIntervalMs`                 | `5000`   | Session store enrichment poll interval (ms)                    |
| `chatMinIntervalMs`              | `30000`  | Minimum interval for chat status broadcasts (ms)               |
| `chatMaxIntervalMs`              | `180000` | Maximum interval for chat status broadcasts (ms)               |
| `persistPath`                    | —        | Path to persist topology state across restarts                 |
| `featureFlags`                   | —        | Object to enable/disable individual subsystems                 |
| `hooks.enabled`                  | `false`  | Run the scripts in `hooks.before_tool` (see above)             |
| `orchestration.allowScripts`     | `false`  | Enable `prefrontal.recipe.orchestrate`                         |
| `marketplace.allowPublish`       | `false`  | Enable `prefrontal.recipe.publish`                             |
| `marketplace.allowRemoteInstall` | `false`  | Enable JourneyKits downloads in `prefrontal.recipe.install`    |

## Dependencies

- Required: none — all subsystems degrade gracefully when their dependencies are absent
- Optional: All other cognitive plugins benefit from Prefrontal's orchestration. Session store enrichment requires the fork's `src/gateway/session-utils.js` but falls back silently on vanilla OpenClaw.

## How It Works

Prefrontal hooks into subagent lifecycle events (`subagent_spawned`, `subagent_ended`), LLM input/output, tool calls, and `agent_end` to maintain a live `TopologyStore` graph of all running agents. A background monitor polls for stale/stuck agents and broadcasts markdown status updates to the Tinker UI via `ChatEmitter`. Six independent subsystems are gated by feature flags: the Exploration Gate prevents redundant work before a task starts; Anti-Goldplating injects a conciseness prompt when it detects over-engineering patterns; Forcing Questions fires clarifying prompts before high-effort work; Effort Router validates that the model tier matches the task complexity; CORF Trigger detects denial-loop patterns and initiates a structured debate; FAAR Tracker logs task completion quality for long-term improvement. The HTTP handler serves the live call tree at `GET /api/prefrontal/tree`. Topology state is persisted on shutdown and reloaded on restart. Crash recovery state is read from `~/.openclaw/workspace/state/prefrontal/recovery.json` and cleared on startup.

## Changelog

- 0.2.0 — `recipe.orchestrate`, `recipe.publish` and JourneyKits `recipe.install` are off by default behind `orchestration.allowScripts` / `marketplace.allowPublish` / `marketplace.allowRemoteInstall`; `recipe.read` only reads `.md` files inside the recipe directories; every gateway method (recipe, kit, plan, topology, status, routes, orcaBias, tree, config, metrics, flags) pinned to `operator.admin`; README lists every method, file and environment switch; crash-recovery file moved from `/tmp/prefrontal/` to the owner-only state dir; permission hooks are opt-in (`hooks.enabled`), run via `execFile` without a shell from an allowlisted root, and fail closed.
- 0.1.0 — Initial ClawHub release.
