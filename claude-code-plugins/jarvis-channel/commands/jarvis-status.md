---
description: Show the current OpenClaw gateway state — provider, active model, memory stats, recent sessions.
---

Probe the user's running OpenClaw gateway and report a one-screen summary of:

1. Whether the gateway is responding (call `${JARVIS_GATEWAY_URL:-http://127.0.0.1:18789}/healthz`).
2. The active primary provider and model from the gateway's config.
3. Recent session activity (last 3 sessions, last activity timestamp).
4. Memory state if accessible (number of indexed chunks, last consolidation).

If the gateway isn't running, say so plainly and tell the user to run `openclaw gateway start`. Don't try to start it yourself.

Use the `jarvis` MCP server tools (already configured in `.mcp.json`) when available; fall back to plain `curl` to `/healthz` if MCP isn't reachable.

Keep the report under 12 lines. Lead with the most important thing (is it up?), then the model, then memory, then sessions.
