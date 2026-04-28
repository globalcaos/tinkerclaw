# `@oscarserra/openclaw-cc-bridge`

An OpenClaw provider plugin that turns your **Claude Code subscription** into your gateway's primary model provider.

Instead of paying per-token for Anthropic API calls, this plugin spawns a real `claude` CLI subprocess per session and streams it through OpenClaw's provider abstraction. Your existing flat-rate Claude Code entitlement powers your gateway.

## What you need

1. An active **Claude Code subscription** (`claude` CLI installed and logged in — `~/.claude/.credentials.json` exists and is fresh).
2. **OpenClaw** ≥ 2026.4.25 running.
3. **Node 22+** on PATH (the `claude` binary needs it).

That's it. The plugin doesn't need an API key — your Claude Code OAuth token does the work.

## Install

```bash
openclaw plugins install @oscarserra/openclaw-cc-bridge
```

OpenClaw will fetch the package from npm, register it under the `claude-code` provider, and persist your install in `~/.openclaw/plugins/installed.json`.

To enable it as your primary provider, add to `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "claude-code/claude-opus-4-7",
        "fallbacks": []
      }
    }
  },
  "providers": {
    "claude-code": {
      "enabled": true
    }
  }
}
```

Restart the gateway:

```bash
openclaw gateway restart
```

## Verify it's working

```bash
openclaw chat "say SMOKE-OK"
```

If you see `SMOKE-OK` come back through the `claude-code/claude-opus-4-7` model, you're done.

## Configuration

Three optional settings in your `openclaw.json` under `plugins.entries.tinkerclaw-cc-bridge.config`:

| key               | default                                                | description                                                                                                                           |
| ----------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `binary`          | `claude` (PATH lookup)                                 | Absolute path to the claude CLI binary.                                                                                               |
| `cwd`             | `~/.openclaw/jarvis-workspace`                         | Working directory for each subprocess. Used for CLAUDE.md loading + transcript persistence.                                           |
| `disallowedTools` | `["Bash","Read","Write","Edit","Grep","Glob","Agent"]` | Tools to disable inside claude. OpenClaw runs its own tool loop, so we strip claude's.                                                |
| `warmOnBoot`      | `[]`                                                   | Session keys to pre-spawn on gateway start (e.g. `["agent:main:main"]`) — eliminates the ~10-second cold-start latency on first turn. |

## Models exposed

The plugin advertises three models matching what your subscription includes:

- `claude-code/claude-opus-4-7` — top reasoning, slower
- `claude-code/claude-sonnet-4-6` — balanced default
- `claude-code/claude-haiku-4-5` — fast, lightweight

Use them in `openclaw.json` model picker, agent defaults, or anywhere a `provider/model` slug is accepted.

## How it works (sketch)

1. Plugin registers a `claude-code` provider with OpenClaw at gateway boot.
2. Each gateway session gets a long-lived `claude` subprocess (one per `sessionKey`, kept warm until restart).
3. OpenClaw sends the user message to the subprocess via `claude --input-format stream-json`.
4. The subprocess streams back NDJSON events that the plugin shims into OpenClaw's `StreamingEvent` interface.
5. The result flows through your normal gateway routing, tools, hooks, memory, etc.

Tools are owned by OpenClaw — this plugin disables them inside claude so you don't get double execution.

## Authentication

The plugin reads `~/.claude/.credentials.json` directly (the same file `claude` itself uses). It validates the file exists and is fresh; refresh is handled by `claude` itself.

There's no API key. There's no credential to copy into OpenClaw's auth-profiles. If `claude` works in your terminal, this works in your gateway.

## Limitations

- **Single-user / personal use.** This is a gray-zone integration with a flat-rate subscription. Don't run this on a shared server with many users — that's not what your subscription covers.
- **Cold-start latency.** First message in a fresh session takes 8–12 seconds because the subprocess has to boot, load `CLAUDE.md`, and warm up. Use `warmOnBoot` to pre-spawn the sessions you care about.
- **No tool concurrency.** Turns within a single session are serialized to avoid OAuth-refresh races.
- **Tied to `claude` CLI version.** Pin your `claude` version. New CLI releases may change the stdin/stdout format; this plugin reverse-engineers it from the public `@anthropic-ai/claude-agent-sdk` TypeScript source.

## License

Apache-2.0. Use at your own risk. This package is not affiliated with Anthropic.

## See also

- The full Tinkerclaw fork (a Jarvis-style assistant built on OpenClaw + this plugin): https://github.com/oscarserra/tinkerclaw
- A companion Claude Code-side plugin (`jarvis-channel`) that lets your `claude` CLI talk back to your gateway: see `claude-code-plugins/jarvis-channel/` in the same repo.
