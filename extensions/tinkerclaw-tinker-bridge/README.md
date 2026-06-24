# `tinkerclaw-tinker-bridge`

> ⚠️ **Fork-only — not for general installation.**
>
> This plugin scripts the `claude` CLI's stream-json interface to drive your gateway off your Claude Code subscription. Anthropic's ToS for the subscription is silent on this exact pattern, but it lives in the gray zone and we don't want to invite a ToS update that breaks it.
>
> The package stays `"private": true` and `publishToNpm: false`. It's not on npm. If you cloned this fork to use it, that's fine — single-user personal use is the intended scope. Don't redistribute.

## What it does (briefly)

Spawns a long-lived `claude` subprocess per gateway session and shims its NDJSON stream into OpenClaw's `StreamingEvent` interface. Your existing `~/.claude/.credentials.json` OAuth powers the model. No API key.

## What it needs

1. Active `claude` CLI install + login.
2. OpenClaw gateway running (this fork).
3. Node 22+.

## Configuration

Optional knobs in `openclaw.json` under `plugins.entries.tinkerclaw-tinker-bridge.config`:

| key               | default                                                | description                                                                            |
| ----------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `binary`          | `claude` (PATH)                                        | Absolute path to the claude CLI binary.                                                |
| `cwd`             | `~/.openclaw/jarvis-workspace`                         | Working dir for each subprocess. Used for CLAUDE.md loading + transcript persistence.  |
| `disallowedTools` | `["Bash","Read","Write","Edit","Grep","Glob","Agent"]` | Tools to disable inside claude (OpenClaw runs its own tool loop).                      |
| `warmOnBoot`      | `[]`                                                   | Session keys to pre-spawn at gateway start (eliminates ~10s cold-start on first turn). |

## Models

`claude-code/claude-opus-4-7`, `claude-code/claude-sonnet-4-6`, `claude-code/claude-haiku-4-5` — matches your subscription tier.

## Why fork-only

- **ToS gray zone.** Subscription-driven scripted use is not explicitly endorsed; mass-distributing a tool that does this could trigger Anthropic's response.
- **Cold-start cost.** Each new session spawns a subprocess. Doesn't scale to many users.
- **OAuth refresh races.** Single-user serialization works; multi-user would need a refresh-token coordinator that doesn't exist yet.

If Anthropic ever endorses Channels for this use case, we'd ship a proper public plugin then. Until then, fork-only.

## License

Apache-2.0 source, but: see warning above re. distribution.
