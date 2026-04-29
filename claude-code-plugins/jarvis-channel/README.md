# `jarvis-channel` — a Claude Code plugin that talks to your OpenClaw gateway

This plugin lives on the **Claude Code side**. Once installed, your local `claude` CLI gets:

- An **MCP server entry** pointed at your running OpenClaw gateway, so any tools the gateway exposes via MCP become callable from `claude`.
- Two **slash commands** (`/jarvis-status`, `/jarvis-send`) for talking to your gateway directly.

It's the mirror image of the openclaw-side cc-bridge. They're independent — install one, both, or neither.

---

## How Claude Code finds plugins (the bit that confused you)

Claude Code does NOT scan arbitrary paths. It only loads plugins from one of two places:

1. **`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`** — installed via `/plugin install ...`. Marketplaces are git repos that Claude clones. The plugin author ships a `marketplace.json` manifest at the root of their repo; users add the marketplace, then install plugins from it.
2. **A local symlink under `~/.claude/plugins/cache/`** — the dev/manual path. Claude Code's plugin loader walks the cache dir at startup and reads any `.claude-plugin/plugin.json` it finds, regardless of whether a marketplace registered it.

The directory `claude-code-plugins/jarvis-channel/` inside the **tinkerclaw repo** is just the **source** of the plugin. Nothing happens automatically — you have to either set up the tinkerclaw repo as a marketplace (path A) or symlink the subdirectory into Claude's cache (path B).

I'll describe both.

---

## Install — path A (marketplace, recommended once published)

If you've published a marketplace manifest for tinkerclaw (see `MARKETPLACE.md` at the repo root for setup), users run:

```
/plugin marketplace add globalcaos/tinkerclaw
/plugin install jarvis-channel@globalcaos
```

Claude Code clones tinkerclaw to `~/.claude/plugins/cache/globalcaos/tinkerclaw/<version>/`, reads the marketplace manifest, finds `jarvis-channel`, and registers its `.mcp.json` + slash commands.

This is the cleanest user experience but requires you to publish the marketplace manifest first.

## Install — path B (symlink, alpha-friendly)

For now, while we're alpha and the marketplace isn't published yet:

```bash
# 1. Have the tinkerclaw repo somewhere on disk:
git clone https://github.com/globalcaos/tinkerclaw ~/src/tinkerclaw

# 2. Make the cache dir Claude scans:
mkdir -p ~/.claude/plugins/cache/manual

# 3. Symlink THIS subdirectory (jarvis-channel/) into the cache:
ln -s ~/src/tinkerclaw/claude-code-plugins/jarvis-channel \
      ~/.claude/plugins/cache/manual/jarvis-channel

# 4. Confirm the structure Claude expects:
ls ~/.claude/plugins/cache/manual/jarvis-channel/.claude-plugin/plugin.json
# Should print: ~/.claude/plugins/cache/manual/jarvis-channel/.claude-plugin/plugin.json
```

That symlink is the actual mechanism. Claude Code starts up → walks `~/.claude/plugins/cache/*/*/` → finds `manual/jarvis-channel/.claude-plugin/plugin.json` → registers the plugin. The fact that it's a symlink to a subdir of your tinkerclaw clone is invisible to Claude Code; it just sees a plugin directory.

If you `git pull` in `~/src/tinkerclaw`, the symlinked plugin updates automatically. Restart `claude` to pick up changes.

---

## Then set the gateway token

Either install path requires the gateway token in the env where `claude` runs. Add to your `~/.bashrc` / `~/.zshrc`:

```bash
# Token from your running gateway:
export OPENCLAW_GATEWAY_TOKEN="$(grep -oE '"token":\s*"[^"]+' ~/.openclaw/openclaw.json | cut -d\" -f4 | head -1)"

# Optional overrides (defaults shown):
# export JARVIS_GATEWAY_URL="http://127.0.0.1:18789/mcp"
# export JARVIS_SESSION_KEY="agent:main:main"
# export JARVIS_AGENT_ID="main"
```

Restart your terminal so the new env propagates, then start `claude`.

---

## Verify it's wired up

In a `claude` session:

```
/jarvis-status
```

If you see a one-screen report of your gateway's health, primary model, and recent sessions — done. If you see "gateway not reachable", the gateway isn't running or the token is wrong.

---

## What you get

### MCP tools (auto-discovered)

The `.mcp.json` registers your openclaw gateway as an HTTP MCP server. Any tools your gateway exposes via MCP become callable from claude. Out of the box (depending on which OpenClaw plugins you have enabled):

- `jarvis_send_message`
- `jarvis_query_memory`
- `jarvis_calendar_events`
- `jarvis_reminders_add`
- `jarvis_recent_sessions`
- … plus whatever your gateway loads

The MCP surface is dynamic — only enabled OpenClaw plugins appear. If a tool is missing, check your `~/.openclaw/openclaw.json`.

### Slash commands

- **`/jarvis-status`** — gateway health + model + recent activity
- **`/jarvis-send <message>`** — drop a message into your Jarvis's primary session and report back what it says

---

## Architecture

```
[ claude CLI session ]
        │
        │  reads ~/.claude/plugins/cache/*/jarvis-channel/.mcp.json
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

This plugin is **just** the `.mcp.json` + the two slash commands. The heavy lifting is on the gateway side; this plugin gives `claude` a stable URL and the right auth header.

---

## Troubleshooting

**`gateway not reachable`** — Run `curl -s http://127.0.0.1:18789/healthz`. If it fails, the gateway isn't running (`openclaw gateway start`). If it works but the slash command still fails, your token is missing or stale.

**`MCP server returned 401`** — `OPENCLAW_GATEWAY_TOKEN` isn't set or has changed. Re-export it from `~/.openclaw/openclaw.json`.

**`Tool not found: jarvis_*`** — That tool isn't in your gateway's MCP surface. Check `~/.openclaw/openclaw.json` plugins section. Each enabled plugin contributes its own tools.

**Plugin doesn't show up at all** — Make sure the symlink target exists and `claude --debug` lists it during startup. If you used path A, run `/plugin list` to see what's loaded.

**Symlink fails on Windows** — Use `mklink /D` instead of `ln -s`, or stick to path A.

---

## Limitations (alpha)

- **Single-host assumption.** Default URL is `127.0.0.1:18789`. For remote gateways, set `JARVIS_GATEWAY_URL` to e.g. `http://your.tailscale.host:18789/mcp`. Auth is still single-token; multi-tenant setups need the pairing flow on the gateway side.
- **No streaming.** MCP HTTP is request/response. Streaming Jarvis reasoning back into your `claude` session isn't supported in this version.
- **Two separate brains.** Tools called via this plugin update your gateway's session, not your `claude` conversation. They're independent agents that can talk; this plugin is the bridge.

---

## License

Apache-2.0. Not affiliated with Anthropic.

## See also

- The full Jarvis stack: <https://github.com/globalcaos/tinkerclaw>
- Marketplace setup for path A: see `MARKETPLACE.md` at the repo root once published.
