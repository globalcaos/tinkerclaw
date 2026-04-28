---
description: Send a message to your running Jarvis (OpenClaw gateway) as if it were a regular chat turn. Useful for delegating work from claude back to your gateway's primary agent.
arguments:
  - name: message
    description: The text to send to Jarvis. Quote multi-word messages.
    required: true
---

You are bridging this `claude` session into the user's running OpenClaw gateway.

The user wants to send `$ARGUMENTS` to their Jarvis (the long-running gateway agent) and report what comes back.

1. Call the `jarvis_send_message` tool from the `jarvis` MCP server with `text: $ARGUMENTS` and `sessionKey: ${JARVIS_SESSION_KEY:-agent:main:main}`.
2. Stream the reply back to the user. Quote-block the reply so it's clearly Jarvis speaking, not you.
3. If the MCP server isn't reachable, say so plainly. Don't fall back to a stub answer — the whole point of this command is the gateway.

Don't add commentary. Just deliver Jarvis's reply.
