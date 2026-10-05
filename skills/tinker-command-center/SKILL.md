---
name: tinker-command-center
version: 1.0.4
description: "Stop guessing what your AI costs. Tinker shows every token, every dollar, every context byte of your OpenClaw gateway in real time. Documentation-only skill: the dashboard itself is part of the publisher's own TinkerClaw repo (github.com/globalcaos/tinkerclaw), installed from a pinned commit."
metadata:
  openclaw:
    requires:
      bins: [git, node, pnpm]
    notes:
      security: "This skill ships no code. It documents how to build Tinker from the publisher's own repository, github.com/globalcaos/tinkerclaw, pinned to commit 88f6f45e0ffe59810177a8b63cb329c22d5d93d3 and installed with the committed pnpm-lock.yaml. Tinker is a local web UI served by your own OpenClaw gateway under /tinker/. It is not read-only: it is a full chat client, and its gateway plugin has HTTP endpoints that read and write local files. At the pinned commit two of them, /tinker/api/kit-content (read) and /tinker/api/save-file (write), check the path with a string prefix test and do not normalize '..', so they can reach any file your user account can. With the default gateway settings every /tinker/ request needs the gateway token as an Authorization Bearer header. With gateway.controlUi.dangerouslyDisableDeviceAuth=true, only the page itself, /api/seat and /api/ui-state check the token; the file, kit, media, mute and context-anatomy endpoints answer without it. See What it touches."
---

# Tinker Command Center

> **Your $200 Opus session didn't have to happen.** Tinker shows you exactly where every token goes — before the bill arrives.

## Changelog

- **1.0.4** — Corrected What it touches to match the pinned code: kit-content/save-file are not confined (no `..` normalization), which endpoints skip the token when `dangerouslyDisableDeviceAuth` is on, the login page is behind the Bearer gate in default mode, and the two differing `onlyBuiltDependencies` lists.
- **1.0.3** — Install now pins the publisher's own repo to an exact commit and uses the committed lockfile; the Tinker UI build step is spelled out (root `pnpm build` does not build it); removed the inaccurate "read-only" and "no data leaves your machine" claims and the stale architecture paths and line count, replaced by a factual What it touches section.

## The Problem

Running Opus through OpenClaw, a single deep conversation can burn **$20+ in tokens** with no warning. You check your provider dashboard days later and wonder what happened.

That's not a billing problem. That's a visibility problem.

## What Tinker Does

Tinker is a **real-time command center** on top of your OpenClaw gateway. It shows what fills your context window, what each response costs, and where your budget stands — live.

### 🗺️ Context Treemap

Interactive squarified treemap of your context window: system prompt sections, conversation history, tool results. Drill down from categories → messages → raw text.

### 📊 Response Treemap

Same visualization for model output: text vs thinking vs tool calls, per LLM call within a run.

### 💰 Live Cost Tracking

Per-provider token usage, daily and monthly estimates, and the 5-hour Claude rate-limit window with a countdown.

### ⚠️ Budget Alerts

Set a monthly limit. Get warned at 70%, 90%, and 100%.

### 🔄 Multi-Call Run View

When your agent loops through tools, each call's context and cost is broken out individually.

### 💬 Full Chat Interface

A complete webchat with session switching, inline tool-call inspection and real-time streaming. It sends messages, so it is a working client, not just a monitor.

## Pricing Reference

List prices Tinker uses for estimates (per 1M tokens, at time of writing):

| Model                 | Input      | Output     |
| --------------------- | ---------- | ---------- |
| Claude Opus 4 / 4.5   | **$15.00** | **$75.00** |
| Claude Sonnet 4 / 3.5 | $3.00      | $15.00     |
| Claude Haiku 3.5      | $0.80      | $4.00      |
| Gemini 3 Pro          | $1.25      | $5.00      |
| Gemini 2 Flash        | $0.10      | $0.40      |

## Install

This skill contains only this document. Tinker is a bundled plugin in **TinkerClaw, the publisher's own OpenClaw fork** ([github.com/globalcaos/tinkerclaw](https://github.com/globalcaos/tinkerclaw)). The commands below check out one exact, immutable commit rather than a moving branch, so what you build is what that commit contains; review it there before building.

```bash
# The publisher's own repo, pinned to an exact commit
git clone https://github.com/globalcaos/tinkerclaw.git tinkerclaw
cd tinkerclaw
git checkout --detach 88f6f45e0ffe59810177a8b63cb329c22d5d93d3
git rev-parse HEAD   # must print 88f6f45e0ffe59810177a8b63cb329c22d5d93d3

# Install exactly the committed lockfile
pnpm install --frozen-lockfile

# Build the gateway, then the Tinker UI (the root build does not include it)
pnpm build
pnpm --filter tinker-ui build
```

`pnpm install` runs the repo's own `preinstall`/`postinstall`/`prepare` scripts from `package.json` (package-manager check, bundled-plugin setup, and pointing `core.hooksPath` at `git-hooks/`). Dependency build scripts are limited by the `onlyBuiltDependencies` allowlists; the commit has two that differ (`pnpm-workspace.yaml` adds `@napi-rs/canvas`, `package.json` adds `@tloncorp/tlon-skill`).

Access: Tinker is served at `http://localhost:18789/tinker/`. With default gateway settings the gateway rejects any `/tinker/` request (including `/tinker/login`) that lacks `Authorization: Bearer <gateway token>`, so a plain browser tab gets 401. The browser login flow works only when `gateway.controlUi.dangerouslyDisableDeviceAuth` is `true`; see What it touches for what that opens. Development server: `cd tinker-ui && pnpm dev` → `http://localhost:18790/tinker/`.

## What it touches

All of this is in the pinned commit, in `extensions/tinkerclaw-tinker/index.ts` and `tinker-ui/`.

- **Network:** the browser UI connects only to your own gateway (HTTP + WebSocket on the gateway port, 18789 by default). Tinker adds no external service; chat messages you send are handled by your gateway like any other chat.
- **Auth, default settings:** the route is registered `auth: "gateway"`, so every `/tinker/` request needs the gateway token as a Bearer header.
- **Auth, `dangerouslyDisableDeviceAuth: true`:** the route is registered `auth: "plugin"`. Only the HTML page, `/api/seat` and `/api/ui-state` check the token (header or login cookie). These answer without it: `/api/kit-content`, `/api/save-file`, `/api/media`, the generic `/api/*?path=` file reader, `/api/jarvis-mute`, and `/api/context-anatomy/*` (recorded prompts and responses). The last two also send `Access-Control-Allow-Origin: *`.
- **Reads:** the context-anatomy SQLite data. `/api/media` and the generic `/api/*` reader resolve the real path and allow only `~/.openclaw`, `~/src/tinkerclaw`, `~/src/jarvis-icu`, `~/Documents`, `~/Downloads`, `~/Desktop`, `~/Pictures` (files up to 512 KB for the reader). `/api/kit-content` is meant for `~/src/tinkerclaw` and `~/.openclaw/workspace/kits`, but it checks an absolute path by string prefix without normalizing it, so `~/src/tinkerclaw/../../<anything>` passes and any readable file up to 512 KB is returned.
- **Writes:** per-seat UI state and operator records under `~/.openclaw`; the mute flag at `~/.openclaw/data/jarvis-muted.json`. `/api/save-file` is meant for `~/src/tinkerclaw`, `~/.openclaw/workspace/kits` and `~/.openclaw/recipes`, but it has the same prefix check without normalization, so a `..` path writes any file your user can write.

## Layout (at the pinned commit)

```
tinker-ui/                         ← Vite + Lit app
├── src/app.ts                     ← Main shell: sidebar, panels, WebSocket client
├── src/panels/context-treemap.ts  ← What fills your context window
├── src/panels/response-treemap.ts ← What each response costs
├── src/panels/context-timeline.ts ← Context usage over time
├── index.html
└── vite.config.ts                 ← base /tinker/, dev port 18790

extensions/tinkerclaw-tinker/      ← OpenClaw plugin: serves tinker-ui/dist under /tinker/
├── index.ts
└── openclaw.plugin.json
```

---

_Built by [globalcaos](https://github.com/globalcaos) · [TinkerClaw](https://github.com/globalcaos/tinkerclaw)_
