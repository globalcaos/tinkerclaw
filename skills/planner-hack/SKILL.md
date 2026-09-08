---
name: planner-hack
description: Read Microsoft Planner (inside Teams) tasks, plans and buckets via a LIVE Graph access token harvested from the shared Teams browser tab — no refresh token needed. Use when the user asks to see Planner tasks, a specific plan, plan progress, or buckets for a Teams team/group. Read-only by design.
---

# Planner Hack

<why_this_matters>
The `teams-hack` / `outlook-hack` skills cannot read Planner: they have no Planner command, and modern Teams **encrypts** the MSAL refresh token in localStorage, so the refresh-token flow is dead. This skill sidesteps that: while a Teams tab is open, a **fresh Graph access token** sits in plaintext in localStorage. We read it through the browser relay and call Graph `/planner` directly.
</why_this_matters>

## Prerequisites

1. A **Teams tab open and shared** in the browser relay (Teams → Planner is ideal).
2. Playwright live in the gateway browser build — `GET /storage/local` must work.
3. Node 22+ (built-in `WebSocket` + `fetch`; no npm deps).

## Quick Start

```bash
node {baseDir}/scripts/planner.mjs token-status
node {baseDir}/scripts/planner.mjs groups
node {baseDir}/scripts/planner.mjs plans
node {baseDir}/scripts/planner.mjs plans --group "<group name or GUID>"
node {baseDir}/scripts/planner.mjs tasks "<plan name>"
node {baseDir}/scripts/planner.mjs tasks "<plan name>" --full
node {baseDir}/scripts/planner.mjs buckets "<plan name>"
node {baseDir}/scripts/planner.mjs refresh
```

`tasks` / `buckets` / `details` accept a **plan name** (case-insensitive substring) or a **plan id**.
Do not hard-code tenant, group, or plan GUIDs in this skill — resolve them live from Graph.

## How it works

1. Find the shared Teams tab.
2. Read MSAL access-token keys from that tab's localStorage; pick the Graph token whose `aud` is `https://graph.microsoft.com` and whose scopes include `Tasks.Read*`.
3. Cache it (mode 600) at `~/.openclaw/credentials/planner-graph.json` with its expiry; reuse until ~2 min before expiry, then re-read from the tab.
4. Graph calls: `/me/memberOf` → group, `/groups/{id}/planner/plans` → plan, `/planner/plans/{id}/tasks` + `/buckets`.

## Safety

- The localStorage dump holds **all** of the user's access tokens; this tool keeps it in memory only, never writes the dump to disk, and never prints any token.
- The cached Graph token may have `Tasks.ReadWrite`, but this skill is **read-only**. Creating, completing, or modifying tasks writes to a shared company Planner — do that only with explicit per-action authorization, not from this skill.
