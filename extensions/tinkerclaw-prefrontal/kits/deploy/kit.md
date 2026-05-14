---
schema: "kit/1.0"
slug: "deploy"
title: "Deploy"
summary: "Build, deploy, and verify — pre-flight checks, build, deploy, verify, rollback plan"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags: ["operations", "deploy", "release", "ship", "push to prod", "go live"]
tools: ["exec", "read", "grep"]
testedHarnesses: ["OpenClaw", "Claude Code"]
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
  notes: |
    FULLY SERIAL — safety contract. Pre-flight (0) must pass before Build (1);
    Build must succeed before Deploy (2); Deploy must complete before Verify (3);
    Verify must confirm health before Rollback Plan (4) is documented.
    Never run Deploy before tests pass; never skip Verify. Step index:
    0=Pre-flight, 1=Build, 2=Deploy, 3=Verify, 4=Rollback Plan.
model:
  provider: "anthropic"
  name: "claude-opus-4-7"
  hosting: "cloud API — requires ANTHROPIC_API_KEY"
resolverHints:
  [
    {
      "match": "deploy | release | ship | push to prod | go live",
      "load": ["kit.md"],
      "purpose": "Pick this kit for: deploy, release, ship, push to prod, go live",
    },
  ]
---

## Goal

Deploy changes safely with verification at each stage and a clear rollback path.

## When to Use

- Deploying new features or fixes
- Releasing a new version
- Applying configuration changes to production

## Steps

### 1. Pre-flight

**Tools:** exec, read
**Done when:** All checks pass, rollback plan documented

Verify clean working tree. Run full test suite. Check that all fork patches are intact (run merge-guardian). Document the current state for rollback (`git log -1 --format=%H`). List what's changing and what it affects.

### 2. Build

**Tools:** exec
**Done when:** Clean build with no warnings

Clear caches (`rm -rf dist/.cache node_modules/.cache`). Run `pnpm install` (deps may have changed). Run `pnpm build`. Verify no TypeScript errors. Check bundle size for unexpected growth.

### 3. Deploy

**Tools:** exec
**Done when:** New version running

For gateway: use `openclaw-restart` (SIGUSR1) or `--full` for code changes. For Tinker UI: build completes, gateway restart picks up new cached index.html. For config changes: edit file, restart gateway.

### 4. Verify

**Tools:** exec
**Done when:** All services operational, no errors in logs

Check health endpoint (port 18792). Verify WebSocket (port 18789). Check Tinker UI loads (port 18790). Monitor logs for errors in first 2 minutes. Test the specific feature that was deployed.

### 5. Rollback Plan

**Done when:** Documented and ready if needed

If issues found:

- `git checkout <previous-hash> -- <affected-files>` for targeted rollback
- `git revert HEAD` for full rollback
- Rebuild and restart
- Verify rollback restores previous behavior

## Constraints

- Never deploy without running tests first
- Never deploy during active user sessions (check first)
- Always have a rollback plan before deploying
- Monitor logs for at least 2 minutes after deploy

## Safety Notes

- Gateway caches index.html -- UI changes need full restart
- pnpm build uses cache -- clear it for reliable builds
- OAuth tokens refresh on restart -- verify auth works after deploy

## Failures Overcome

- **Deploy without tests:** Agent deploys a "simple change" that breaks something unexpected. Pre-flight tests are mandatory.
- **No rollback path:** Deploy goes wrong, scramble to figure out previous state. Capturing the commit hash before deploy enables instant rollback.
- **Cache poisoning:** Build cache serves stale code, "deployed" change doesn't take effect. Cache clearing is now mandatory before build.
