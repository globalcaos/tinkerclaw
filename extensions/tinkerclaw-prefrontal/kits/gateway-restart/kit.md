---
schema: "kit/1.0"
slug: "gateway-restart"
title: "Gateway Restart"
summary: "Safely restart the OpenClaw gateway — check sessions, graceful stop, verify"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags: ["operations", "restart", "gateway", "reload", "bounce", "restart gateway"]
tools: ["exec", "read"]
testedHarnesses: ["OpenClaw", "Claude Code"]
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
  notes: |
    FULLY SERIAL — operational safety. Each step takes <10s; spawn overhead
    (~2-5s) would dominate any fan-out gain. Pre-check (0) must confirm no
    active LLM sessions before stopping. Graceful Stop (1) must succeed before
    Start & Verify (2) can meaningfully run. Post-check (3) requires a live
    gateway from step 2. Step index: 0=Pre-check, 1=Graceful Stop,
    2=Start & Verify, 3=Post-check.
model:
  provider: "anthropic"
  name: "claude-opus-4-7"
  hosting: "cloud API — requires ANTHROPIC_API_KEY"
resolverHints:
  [
    {
      "match": "restart | gateway | reload | bounce | restart gateway",
      "load": ["kit.md"],
      "purpose": "Pick this kit for: restart, gateway, reload, bounce, restart gateway",
    },
  ]
---

## Goal

Restart the OpenClaw gateway without losing active sessions or data.

## When to Use

- After backend code changes (tsdown rebuild)
- After Tinker UI rebuild (gateway caches index.html in memory)
- After config changes to openclaw.json
- After credential rotation
- Recovery from crash or hang

## Steps

### 1. Pre-check

**Tools:** exec
**Done when:** No active LLM sessions, state captured

Check for active LLM sessions before restarting. NEVER force-kill during an active response. Check if the gateway is responding (`curl localhost:18792` health check). Note current uptime for comparison after restart.

### 2. Graceful Stop

**Tools:** exec
**Done when:** Gateway process stopped cleanly

Use `openclaw-restart` (sends SIGUSR1, 1-second restart) for routine restarts. Use `openclaw-restart --full` only for code changes that require full process restart. Never `kill -9` unless the process is truly hung.

### 3. Start & Verify

**Tools:** exec
**Done when:** Gateway responding, all services connected

Wait for gateway to boot. Check health endpoint (`localhost:18792`). Verify WebSocket on port 18789. Check that WhatsApp reconnects. Verify OAuth tokens are valid (gateway restart refreshes them).

### 4. Post-check

**Tools:** exec
**Done when:** All integrations operational

Verify Tinker UI loads correctly (port 18790). Check that model fallback chain is operational. Confirm no crash loops in logs. Known non-fatal warnings to ignore: `plugins.allow is empty`, `http route registration missing or invalid auth`.

## Constraints

- ALWAYS check for active LLM sessions before restarting
- Use `openclaw-restart` (SIGUSR1) by default, not full restart
- Full restart (`--full`) only for code changes
- Never force-kill during active response

## Safety Notes

- Gateway caches `index.html` in memory -- Tinker UI changes require restart
- After credential sync changes, verify OAuth token is picked up
- WhatsApp reconnection may take 10-30 seconds after restart

## Failures Overcome

- **Force-kill during response:** Gateway killed mid-response, user sees NO_REPLY. Pre-check for active sessions prevents this.
- **Stale index.html:** Tinker UI rebuilt but gateway still serves cached version. Full restart required after UI changes.
- **OAuth token lost:** Restart cleared in-memory token but file had stale refresh token. Claude Code single-writer pattern now prevents this.
