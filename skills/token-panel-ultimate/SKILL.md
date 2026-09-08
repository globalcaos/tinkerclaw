---
name: token-panel-ultimate
version: 2.6.0
description: "Know exactly where your AI tokens go. Multi-provider tracking, budget alerts, and a local REST API—all in one dashboard. Provider credentials are supplied by you and sealed in the OS keychain, never passed on a command line; it reads no other application's credential store. Transcript parsing, live provider probing, and reading another tool's API-key variables are each opt-in and off by default. Only counts are stored — no prompts, no task titles. See Permissions, Data Flow & Consent."
metadata:
  openclaw:
    permissions:
      network:
        required: true
        scope: "Provider usage endpoints (Anthropic, OpenAI, Google, Manus) plus a REST API bound to 127.0.0.1:8765. Live rate-limit probing sends real billable requests and is off unless you pass --probe. No third-party telemetry."
      file_read:
        required: true
        scope: "Its own keychain entry (or warned owner-only 0600 fallback file); its own SQLite database and usage JSON files; and, ONLY with TOKEN_PANEL_READ_TRANSCRIPTS=1, local session transcripts under ~/.openclaw/agents. It reads no other application's credential store."
      file_write:
        required: true
        scope: "A local SQLite database of token COUNTS and opaque task ids, plus per-provider usage JSON. Created 0600 inside a 0700 directory. No prompts, message content or task titles are written."
      file_delete:
        required: true
        scope: "One path only: its own credential fallback file ~/.openclaw/data/token-panel/credentials, unlinked by --logout when the last provider is removed. The path is validated before deletion (absolute, inside $HOME, a regular file, not a symlink, owned by you, and beside a .token-panel-store marker this tool wrote). Nothing else is ever deleted; the SQLite database is not removed."
      env_read:
        required: true
        scope: "Namespaced TOKEN_PANEL_* variables (credentials, TOKEN_PANEL_API_TOKEN, TOKEN_PANEL_READ_TRANSCRIPTS, TOKEN_PANEL_ALLOW_PROVIDER_ENV). Generic provider variables belonging to other tools (OPENAI_API_KEY, ANTHROPIC_ADMIN_API_KEY, GEMINI_API_KEY, MANUS_API_KEY) are read ONLY with TOKEN_PANEL_ALLOW_PROVIDER_ENV=1. No .env files are scraped."
      process_exec:
        required: true
        scope: "The OS keychain helpers only: `secret-tool` (Linux) for store/lookup/clear, and `security` (macOS) for lookup/delete. Secrets are never passed as command-line arguments — macOS writes go through Security.framework, Linux writes go over stdin."
      credentials:
        required: true
        scope: "First-party provider API keys supplied by you, stored under token-panel-ultimate in the OS keychain. It never reads Claude Code, OpenClaw, browser, or other application credential stores. `--logout PROVIDER` clears every local store and prints the provider's server-side revoke URL."
    owner: kn7623hrcwt6rg73a67xw3wyx580asdw
    category: monitoring
    tags:
      - tokens
      - usage
      - budget
      - anthropic
      - openai
      - gemini
      - manus
      - dashboard
    license: MIT
    notes:
      security: "Runs a REST API bound to 127.0.0.1:8765. Its GET endpoints are unauthenticated and report your spend, so do not expose the port; every POST additionally requires X-Token-Panel-Token and is closed entirely unless TOKEN_PANEL_API_TOKEN is set. SQLite database is local, 0600 in a 0700 directory, and holds counts and opaque ids only. Credentials are ones you supply, sealed in the OS keychain. The systemd unit is a --user unit: it runs as you, never as root, and carries no hardcoded username."
---

# Token Panel Ultimate

> One of dozens of skills and plugins in **[TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — a self-improving OpenClaw fork that's been running 24/7 for months.

**One dashboard for every token you spend.** Anthropic, Gemini, OpenAI, Manus—tracked, stored, and queryable before the bill arrives.

**Part of [TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — real-time token tracking, self-improving crons, persistent cognitive memory. This is one piece of that stack; the repo has dozens more.

👉 **https://github.com/globalcaos/tinkerclaw**

_Clone it. Fork it. Break it. Make it yours._

## ⚠️ Permissions, Data Flow & Consent — read before installing

**What it does that a "dashboard" does not imply:**

- **It uses only credentials you supply to Token Panel itself.** `python3 secretstore.py --login
anthropic` reads the key from **stdin** and seals it in the OS keychain — never in a shell
  argument, so it cannot be picked up from your history or from another process reading command
  lines. The same command supports `openai`, `gemini` and `manus`. On macOS the write goes
  through Security.framework rather than `security add-generic-password -w`, precisely because
  that CLI form would place your key in this process's argv. `--logout PROVIDER` clears every
  local store and prints the provider's server-side revoke URL, because deleting a local copy is
  not revocation.
- **It reads no other application's credential store.** Not Claude Code's, not OpenClaw's, not a
  browser's. Versions up to 2.5.1 could borrow Claude Code's OAuth token behind an opt-in
  environment variable; **2.6.0 removes that path entirely** rather than gating it — a token
  issued to another application does not become this tool's to spend just because you set a
  variable. With no credential of its own, the Claude fetcher fails and tells you how to mint
  one.
- **It will not quietly use an API key you exported for something else.** `TOKEN_PANEL_*`
  variables are ours and are always honoured. Generic ones — `OPENAI_API_KEY`,
  `ANTHROPIC_ADMIN_API_KEY`, `GEMINI_API_KEY`, `MANUS_API_KEY` — belong to other tools and are
  read only if you set `TOKEN_PANEL_ALLOW_PROVIDER_ENV=1`.
- **It can parse your session transcripts**, which contain your prompts and replies in full.
  **Opt-in and off by default**: nothing is read unless `TOKEN_PANEL_READ_TRANSCRIPTS=1`, checked
  both by the collector and by the parser. Only token counts are extracted; message text is never
  written to the database or returned by the API.
- **Live rate-limit checks cost you money, so you have to ask for them.** OpenAI and Google
  publish remaining capacity only in responses to real requests, so `chatgpt-usage-fetch.py` and
  `gemini-usage-fetch.py` can send a 1-token request per model — billable, visible in your
  account activity. **Off by default**: without `--probe` they make no network call at all and
  report the documented caps.
- **It serves a REST API, and it is not read-only.** GET endpoints are unauthenticated and report
  your spend and quota — bind to localhost and do not expose the port. Every POST additionally
  requires `X-Token-Panel-Token` to match `TOKEN_PANEL_API_TOKEN`, and returns 403 for everything
  when that variable is unset.
- **It deletes exactly one file, and checks before it does.** `--logout` unlinks its own
  credential fallback file when the last provider is removed. That path must be absolute, inside
  `$HOME`, a regular file, not a symlink, owned by you, and sitting beside a `.token-panel-store`
  marker this tool wrote itself — otherwise it refuses. Your database is never deleted.

**What it stores:** counts and identifiers. Provider, model, token totals, cost, credit totals,
opaque task ids, statuses, timestamps. **No prompts, no message content, no task titles.**
Earlier versions kept a 200-character slice of each Manus task prompt and wrote task titles into
the usage JSON; 2.6.0 stops collecting both, and on first connect it blanks any prompt text a
previous version already stored.

**What it does NOT do:** no credential reuse, no browser-token extraction, no silent secrets
scraping, no `.env` reads, no message content in the database, no telemetry, no third-party
endpoint. If no OS keychain exists, the CLI warns on every use before falling back to an
owner-only `0600` file inside a `0700` directory. Database and usage files are created `0600`
inside a `0700` directory rather than inheriting an ambient umask. The local API allows CORS only
from localhost dashboard origins, not `*`.

**Diagnostics are off by default.** The browser widget logs nothing unless you set
`localStorage.BP_DEBUG = "1"` — including error paths, which can carry request URLs and response
bodies. Console output is readable by anything sharing the page.

**It runs as you, not as root.** The systemd unit is a `--user` unit with no `User=` line and no
machine's username baked in.

**Dependencies are pinned above known-vulnerable releases.** The floor for `fastapi` is
`0.109.1`; the previous `>=0.100.0` permitted a release affected by CVE-2024-24762.

## Why This Exists

You've checked your Anthropic console, squinted at the OpenAI dashboard, opened a Gemini tab, and still weren't sure where last Tuesday's $14 went. Token Panel Ultimate puts all four providers in one place so the answer is always one query away.

## What It Does

- **Multi-Provider Tracking** — Anthropic, Gemini, OpenAI, and Manus in a single SQLite database
- **Budget Alerts** — Set monthly limits per provider. Get warned before you overspend, not after
- **REST API** — Query usage programmatically on port 8765. Plug it into your own scripts or dashboards
- **Transcript Parsing** — Extracts token counts from OpenClaw session transcripts, opt-in via `TOKEN_PANEL_READ_TRANSCRIPTS=1`
- **Zero Dependencies** — SQLite storage. No Postgres, no Redis, no cloud account required
- **Runs as a Daemon** — Systemd service keeps it alive in the background

## Quick Start

```bash
pip install -r requirements.txt

# Give the dashboard a credential of its own (read from stdin, sealed in the keychain)
python3 secretstore.py --login anthropic
python3 secretstore.py --status

python3 api.py                    # http://127.0.0.1:8765
```

Remove a credential at any time — this clears every local store and prints the provider's
revoke URL:

```bash
python3 secretstore.py --logout anthropic
```

## Architecture

```
OpenClaw Plugin → Budget Collector API → SQLite DB (0600)
   (GET only)               ↓
                Transcripts (opt-in) / Provider APIs / Manus Tracker
```

## API Endpoints

| Method | Path                      | Auth      | Description                         |
| ------ | ------------------------- | --------- | ----------------------------------- |
| GET    | /status                   | none      | Overall budget status               |
| GET    | /budgets                  | none      | Current budget limits               |
| GET    | /summary/monthly          | none      | Monthly usage summary               |
| GET    | /summary/daily/{provider} | none      | Daily breakdown                     |
| POST   | /budgets                  | **token** | Set or update budget limits         |
| POST   | /usage                    | **token** | Record a usage event                |
| POST   | /manus/task               | **token** | Record a task (id, credits, status) |

**token** = `X-Token-Panel-Token` must match `TOKEN_PANEL_API_TOKEN`; with that variable unset,
every POST returns 403.

_Clone it. Fork it. Break it. Make it yours._

👉 Explore the full project: [github.com/globalcaos/tinkerclaw](https://github.com/globalcaos/tinkerclaw)
