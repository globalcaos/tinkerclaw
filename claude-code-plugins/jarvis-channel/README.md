# `jarvis-channel` — a Claude Code plugin that connects to your OpenClaw gateway

This plugin lives on the **Claude Code side**. It lets your local `claude` CLI talk to a running OpenClaw gateway — pulling memory, querying calendar/reminders/etc through the gateway's MCP surface, and delegating work back to your long-lived Jarvis agent.

If you're looking for the OpenClaw-side plugin (the one that lets your gateway _use_ Claude Code as a model provider), that's `@oscarserra/openclaw-cc-bridge`. They're complementary — install both for a full round-trip setup.

## What you need

1. A running **OpenClaw gateway** on `localhost:18789` (or set `JARVIS_GATEWAY_URL`).
2. **Claude Code** CLI (`claude` on PATH).
3. Your gateway token in env: `OPENCLAW_GATEWAY_TOKEN=...`. Find it in your `~/.openclaw/openclaw.json` or via `openclaw gateway token show`.

## Install

### Option A — via plugin marketplace (when published)

```bash
/plugin install jarvis-channel@oscarserra-marketplace
```

### Option B — manual symlink (recommended while we're alpha)

```bash
git clone https://github.com/oscarserra/tinkerclaw ~/src/tinkerclaw 2>/dev/null || true
mkdir -p ~/.claude/plugins/cache/manual
ln -s ~/src/tinkerclaw/claude-code-plugins/jarvis-channel ~/.claude/plugins/cache/manual/jarvis-channel
```

Then in your shell config (`~/.bashrc`, `~/.zshrc`, etc.):

```bash
export OPENCLAW_GATEWAY_TOKEN="$(grep -oE '"token":\s*"[^"]+' ~/.openclaw/openclaw.json | cut -d\" -f4 | head -1)"
# Optional overrides:
# export JARVIS_GATEWAY_URL="http://127.0.0.1:18789/mcp"
# export JARVIS_SESSION_KEY="agent:main:main"
# export JARVIS_AGENT_ID="main"
```

Restart `claude`. The plugin auto-loads on next session start.

## Verify

In a `claude` session:

```
/jarvis-status
```

You should see your gateway's health, primary model, and recent activity. If you see `gateway not reachable`, the token is wrong or the gateway isn't running.

## What it gives you

### MCP tools (auto-discovered by claude)

The plugin's `.mcp.json` registers the openclaw gateway as an HTTP MCP server. Claude can then call any tool the gateway exposes through MCP. Out of the box that includes (depending on your enabled OpenClaw plugins):

- `jarvis_send_message` — drop a message into your gateway's primary session
- `jarvis_query_memory` — search your indexed memory store
- `jarvis_calendar_events` — read upcoming events (if calendar plugin is set up)
- `jarvis_reminders_add` — push a reminder (if reminders plugin is set up)
- `jarvis_recent_sessions` — list active gateway sessions
- … plus whatever else your gateway loads

What's actually available depends on which OpenClaw plugins you have installed. The MCP server reflects them dynamically.

### Slash commands

- **`/jarvis-status`** — one-screen gateway state check
- **`/jarvis-send <message>`** — delegate work back to your Jarvis (returns its reply quoted)

More to come (`/jarvis-pull-memory`, `/jarvis-recent-context`) once the gateway-MCP surface stabilizes.

## How it works

```
[ claude CLI session ]
        │
        │  MCP HTTP (stdio: false)
        ▼
[ ~/.claude/plugins/.../jarvis-channel/.mcp.json ]
        │
        │  http://127.0.0.1:18789/mcp
        │  Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}
        ▼
[ openclaw gateway MCP endpoint ]
        │
        ▼
[ your tools, your memory, your channels ]
```

The plugin is essentially **a thin pre-configured MCP-server entry plus two slash commands**. The heavy lifting is on the gateway side; this plugin just gives `claude` a stable URL to reach it and translates the auth headers.

## Troubleshooting

**`gateway not reachable`** — Check `curl -s http://127.0.0.1:18789/healthz`. If that fails, your gateway isn't running. Run `openclaw gateway start`. If it succeeds but the slash command still fails, your token is wrong.

**`MCP server returned 401`** — `OPENCLAW_GATEWAY_TOKEN` is missing or stale. Re-export it from `~/.openclaw/openclaw.json`.

**`Tool not found: jarvis_*`** — That tool isn't exposed by your gateway's MCP surface. Check your `~/.openclaw/openclaw.json` plugins section. The MCP surface is dynamic — only enabled OpenClaw plugins appear.

**Plugin doesn't auto-load** — Make sure the symlink target exists and `claude --debug` shows it being scanned. Claude Code reads `~/.claude/plugins/cache/*/jarvis-channel/.claude-plugin/plugin.json`.

## Limitations (alpha)

- **Single-host assumption.** This plugin assumes your gateway is on `127.0.0.1:18789`. Remote gateways (Tailscale, VPN, etc.) work too — set `JARVIS_GATEWAY_URL=http://your.host:18789/mcp`. But the auth model is still single-token; multi-tenant setups need the pairing flow instead.
- **No streaming.** MCP HTTP is request/response. Streaming Jarvis reasoning back into your `claude` session would need an MCP streaming spec or a custom WS client. v0.1 just blocks on the final answer.
- **No write-back to claude state.** Tools called via this plugin update your gateway's session, not your `claude` conversation. They're separate brains; this plugin is the bridge.

## License

Apache-2.0. Not affiliated with Anthropic.

## See also

- **OpenClaw side**: `@oscarserra/openclaw-cc-bridge` — install on your gateway so it can use your Claude Code subscription as primary provider. Round-trip: claude → gateway → claude (via cc-bridge) → result.
- **Full Jarvis**: <https://github.com/oscarserra/tinkerclaw> — the complete personal-assistant stack this plugin lives in.
