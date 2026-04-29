# `jarvis-channel` — Claude Code plugin that talks to your OpenClaw gateway

Once installed, your local `claude` CLI gets:

- An **MCP server entry** pointed at your running OpenClaw gateway, so any tools the gateway exposes via MCP become callable from `claude`.
- Two **slash commands** (`/jarvis-status`, `/jarvis-send`) for talking to your gateway directly.

## Who this is for

Anyone running the **tinkerclaw fork** locally. You already need the source on disk for the gateway itself, so the install is just a symlink — no marketplace, no publish, no extra repo.

## Install

```bash
# 1. You already have the tinkerclaw repo cloned (that's what runs your gateway).
#    Confirm it's where you expect:
ls ~/src/tinkerclaw/claude-code-plugins/jarvis-channel/.claude-plugin/plugin.json

# 2. Make Claude Code's plugin cache directory:
mkdir -p ~/.claude/plugins/cache/manual

# 3. Symlink THIS plugin's source into the cache:
ln -s ~/src/tinkerclaw/claude-code-plugins/jarvis-channel \
      ~/.claude/plugins/cache/manual/jarvis-channel
```

That's the install. Claude Code's plugin loader walks `~/.claude/plugins/cache/*/*/` at startup and reads any `.claude-plugin/plugin.json` it finds. The symlink makes our source dir look like any other installed plugin.

`git pull` in `~/src/tinkerclaw` → restart `claude` → updates flow through automatically.

## Set the gateway token

Add to your `~/.bashrc` / `~/.zshrc`:

```bash
# Token from your running gateway:
export OPENCLAW_GATEWAY_TOKEN="$(grep -oE '"token":\s*"[^"]+' ~/.openclaw/openclaw.json | cut -d\" -f4 | head -1)"

# Optional overrides (defaults shown):
# export JARVIS_GATEWAY_URL="http://127.0.0.1:18789/mcp"
# export JARVIS_SESSION_KEY="agent:main:main"
# export JARVIS_AGENT_ID="main"
```

Restart your terminal so the env propagates, then start `claude`.

## Verify

In a `claude` session:

```
/jarvis-status
```

If you see a one-screen report of your gateway's health, primary model, and recent sessions — done. If you see "gateway not reachable", the gateway isn't running or the token is wrong.

## What you get

### MCP tools (auto-discovered)

The `.mcp.json` registers your openclaw gateway as an HTTP MCP server. Any tools your gateway exposes via MCP become callable from claude. The set is dynamic — only enabled OpenClaw plugins contribute tools. Typical examples:

- `jarvis_send_message`
- `jarvis_query_memory`
- `jarvis_calendar_events`
- `jarvis_reminders_add`
- `jarvis_recent_sessions`

### Slash commands

- **`/jarvis-status`** — gateway health + model + recent activity
- **`/jarvis-send <message>`** — drop a message into your Jarvis's primary session and report back what it says

## Architecture

```
[ claude CLI session ]
        │
        │  reads ~/.claude/plugins/cache/manual/jarvis-channel/.mcp.json
        ▼
[ MCP HTTP request ]
        │
        │  http://127.0.0.1:18789/mcp
        │  Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}
        ▼
[ openclaw gateway /mcp endpoint ]
        │
        ▼
[ your tools, your memory, your channels ]
```

The plugin is **just** a `.mcp.json` + two slash commands. The heavy lifting is on the gateway side; this plugin gives `claude` a stable URL and the right auth header.

## Troubleshooting

**`gateway not reachable`** — Run `curl -s http://127.0.0.1:18789/healthz`. If it fails, the gateway isn't running (`openclaw gateway start`). If it works but the slash command still fails, your token is missing or stale.

**`MCP server returned 401`** — `OPENCLAW_GATEWAY_TOKEN` isn't set or has changed. Re-export it from `~/.openclaw/openclaw.json`.

**`Tool not found: jarvis_*`** — That tool isn't in your gateway's MCP surface. Check `~/.openclaw/openclaw.json` plugins section. Each enabled plugin contributes its own tools.

**Plugin doesn't show up at all** — `claude --debug` should list it during startup. If it doesn't, the symlink target is wrong; check `ls ~/.claude/plugins/cache/manual/jarvis-channel/.claude-plugin/plugin.json` resolves.

**Symlink doesn't work on Windows** — Use `mklink /D` instead of `ln -s`, or copy the directory instead of symlinking it (you'll lose the auto-update-on-git-pull flow).

## Limitations

- **Single-host assumption.** Default URL is `127.0.0.1:18789`. For remote gateways set `JARVIS_GATEWAY_URL` to e.g. `http://your.tailscale.host:18789/mcp`. Auth is still single-token.
- **No streaming.** MCP HTTP is request/response. Streaming Jarvis reasoning back into your `claude` session isn't supported in this version.
- **Two separate brains.** Tools called via this plugin update your gateway's session, not your `claude` conversation. They're independent agents that can talk; this plugin is the bridge.

## License

Apache-2.0. Not affiliated with Anthropic.
