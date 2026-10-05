---
name: planner-hack
description: Read Microsoft Planner (inside Teams) tasks, plans and buckets via a LIVE Graph access token harvested from the shared Teams browser tab — no refresh token needed. Use when the user asks to see Planner tasks, a specific plan (e.g. "Divisió AI"), plan progress, or buckets for a Teams team/group. Read-only by design.
---

# Planner Hack

<why_this_matters>
The `teams-hack` / `outlook-hack` skills CANNOT read Planner: they have no Planner command, and modern Teams **encrypts** the MSAL refresh token in localStorage (`msal.2|…|refreshtoken|…` → `{id,nonce,data}`), so the refresh-token flow is dead. This skill sidesteps that: while a Teams tab is open, a **fresh Graph access token** sits in plaintext in localStorage. We read it through the OpenClaw browser relay and call Graph `/planner` directly.
</why_this_matters>

## Prerequisites

1. A **Teams tab open and shared** in the browser relay (Teams → Planner is ideal). Check with `node ~/src/tinkerclaw/scripts/br-relay.mjs GET /tabs`.
2. **Playwright live** in the gateway browser build — `GET /storage/local` must work. If it returns "Playwright is not available", the gateway needs the browser-plugin runtime deps restored + a restart (see memory `reference_browser_relay_access`).
3. Node 22+ (uses built-in `WebSocket` + `fetch`; no npm deps).

## Quick Start

```bash
planner token-status                 # confirm a live Graph token (scopes + TTL); never prints the token
planner groups                       # your group/team memberships (id | name)
planner plans                        # all your Planner plans (your own + group plans)
planner plans --group "DIVISIÓN AI"  # plans of one group (name substring or GUID)
planner tasks "Divisió AI"           # tasks of a plan, grouped by bucket, with % + checklist COUNT
planner tasks "Divisió AI" --full    # same, but with each task's BODY: description, checklist items, comments
planner details "Divisió AI" PROPOSTES   # full body of ONE task (description + checklist items + comments)
planner buckets "Divisió AI"         # just the bucket names
planner refresh                      # force re-read the token from the tab (ignore cache)
```

`tasks`/`buckets`/`details` accept a **plan name** (case-insensitive substring) or a **plan id**; `details` likewise resolves the task by name substring or id. Names resolve across your own plans and every group you belong to.

**`--full` / `details`** fetch each task's `…/details` (description, checklist item texts with checked state, attachment aliases) plus the conversation-thread **comments** (`/groups/{id}/threads/{threadId}/posts`, HTML stripped). `--full` is one extra Graph call per task (N+1) — fine for a ~20-task plan, slower for huge ones. The plain `tasks` view stays lightweight (counts only). Use `--full`/`details` when a title alone (e.g. "Codi?", "PROPOSTES") isn't self-explanatory — the meaning lives in the checklist items, not the title.

## How it works

1. `GET /tabs` (relay) → find the shared Teams tab's `targetId`.
2. `GET /storage/local {targetId}` → parse MSAL keys `msal.2|<uid>.<utid>|<env>|accesstoken|<clientid>|<realm>|<target>`; pick the value whose `aud=https://graph.microsoft.com`, `expiresOn` is in the future, and whose JWT `scp` contains `Tasks.Read*` (Teams first-party client `5e3ce6c0-2b1f-4285-8d4b-75ee78787346` mints one with `Tasks.ReadWrite` + `Group.Read.All`).
3. Cache it (chmod 600) at `~/.openclaw/credentials/planner-graph.json` with its expiry; reuse until ~2 min before expiry, then re-read from the tab.
4. Graph calls: `/me/memberOf` → group, `/groups/{id}/planner/plans` → plan, `/planner/plans/{id}/tasks` + `/buckets`. (`/me/planner/plans` alone misses group plans you're not a direct member of.)

## Known references (the operator's tenant)

- Tenant `f00f60b1-b967-4c0b-91ce-eb200dab0604`
- Group **"DIVISIÓN AI"** `bc49a0c4-37d7-4f36-832f-22329f4c350e` → plan **"Divisió AI"** `n1d7-bSx4Uuh-dVxxVI6gJcAFQsQ`

## Safety

- The localStorage dump holds **all** the user's access tokens; this tool keeps it in memory only, never writes it to disk, and never prints any token.
- The cached Graph token has `Tasks.ReadWrite`, but this skill is **read-only**. Creating/completing/modifying tasks writes to a shared company Planner — do that only with explicit per-action authorization, not from this skill.
