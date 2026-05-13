---
schema: "kit/1.0"
slug: "credential-rotation"
title: "Credential Rotation"
summary: "Safely rotate credentials — inventory, generate, deploy, verify, revoke old"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags: ["security", "rotate", "credentials", "keys", "tokens", "secrets", "rotate keys", "new token"]
tools: ["exec", "read", "grep", "edit"]
testedHarnesses: ["OpenClaw", "Claude Code"]
model:
  provider: "anthropic"
  name: "claude-opus-4-7"
  hosting: "cloud API — requires ANTHROPIC_API_KEY"
resolverHints:
  [
    {
      "match": "rotate | credentials | keys | tokens | secrets | rotate keys | new token",
      "load": ["kit.md"],
      "purpose": "Pick this kit for: rotate, credentials, keys, tokens, secrets, rotate keys, new token",
    },
  ]
---

## Goal

Rotate credentials with zero downtime, ensuring all consumers are updated before revoking old credentials.

## When to Use

- Scheduled credential rotation
- After suspected credential compromise
- When onboarding/offboarding team members
- After upstream merge that may have exposed credentials in diff

## Steps

### 1. Inventory

**Tools:** grep, read
**Done when:** All credential locations and consumers mapped

Map every location where the credential is stored or used:

- Auth profiles: `~/.openclaw/agents/main/agent/auth-profiles.json`
- Claude Code: `~/.claude/.credentials.json`
- Config files: `openclaw.json` env section
- Environment variables
- Other services using the same key

### 2. Generate New Credentials

**Tools:** exec
**Done when:** New credentials generated but NOT yet deployed

Generate new credentials from the provider:

- Anthropic API keys: console.anthropic.com
- OAuth tokens: managed by Claude Code single-writer (re-auth flow)
- Other API keys: respective provider dashboards

Do NOT revoke old credentials yet.

### 3. Deploy New Credentials

**Tools:** edit, exec
**Done when:** All consumers updated with new credentials

Update credentials in all locations identified in step 1:

- Primary location first (auth-profiles.json for OpenClaw)
- Secondary locations (openclaw.json env section)
- Clear in-memory caches (gateway restart needed)
- For OAuth: Claude Code handles refresh -- just restart gateway

### 4. Verify

**Tools:** exec
**Done when:** All services operational with new credentials

Test each consumer:

- Gateway health check (port 18792)
- Send a test message through each auth profile
- Verify model fallback chain works end-to-end
- Check that no service is still using old credentials

### 5. Revoke Old Credentials

**Tools:** exec
**Done when:** Old credentials revoked, final verification done

Only after ALL consumers are verified working:

- Revoke old API keys at the provider
- Clear `usageStats` in auth-profiles.json if resetting usage tracking
- Do a final round of testing after revocation
- Monitor logs for auth failures in the next hour

## Constraints

- NEVER revoke old credentials before new ones are verified
- Map ALL consumers before starting rotation
- Test each consumer individually, not just one
- For OAuth: Claude Code is the single writer for .credentials.json -- don't write directly

## Safety Notes

- Anthropic strict rotation invalidates old refresh token immediately -- single-writer pattern is critical
- 11+ write paths to auth-profiles.json exist -- merge-on-save guard in saveAuthProfileStore() prevents race conditions
- API spending cap only affects API key, NOT OAuth subscription
- After rotation, clear usageStats to reset billing tracking

## Failures Overcome

- **Revoke before verify:** Agent revokes old key before verifying new one works everywhere. Explicit step ordering prevents this.
- **Missed consumer:** Agent updates auth-profiles.json but not openclaw.json env section. Inventory step maps all locations.
- **OAuth race condition:** Multiple writers to auth-profiles.json with Anthropic strict rotation caused token invalidation. Merge-on-save guard now prevents stale overwrites.
