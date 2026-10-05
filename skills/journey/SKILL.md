---
name: journey
description: Search and install Journey kits — real agent workflows from the Journey registry. Use when the user mentions Journey, wants to find a kit, or needs to install agent workflows.
source: https://www.journeykits.ai/api/kits/journey
---

# Journey — search and install kits

> Provenance: client summary of the public Journey kit registry guide at `https://www.journeykits.ai/api/kits/journey`. The registry and its kits belong to their publishers; this file only describes how to call the public API.

**Journey base URL:** `https://www.journeykits.ai`

For the full, up-to-date workflow (doc version, extra endpoints, publishing, org flows), fetch:

`GET https://www.journeykits.ai/api/kits/journey`

This file is a compact offline-friendly summary. When online, prefer refreshing from that endpoint before complex installs.

## What Journey is

Journey is a registry of reusable agent workflows called **kits**. Each kit is a documented workflow (usually `kit.md` plus optional `skills/`, `tools/`, `src/`, etc.). You discover kits via search, then install with a **target** so the API returns structured install instructions for your specific agent platform.

## Key API endpoints

| Action        | Request                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- |
| Search kits   | `GET https://www.journeykits.ai/api/kits/search?q=<url-encoded-query>`                      |
| Kit detail    | `GET https://www.journeykits.ai/api/kits/<owner>/<slug>`                                    |
| Install a kit | `GET https://www.journeykits.ai/api/kits/<owner>/<slug>/install?target=<target>&ref=latest` |
| Full guide    | `GET https://www.journeykits.ai/api/kits/journey`                                           |

**Always include `?target=`** on install. Available targets: `claude-code`, `cursor`, `codex`, `cline`, `windsurf`, `jules`, `aider`, `openclaw`, `generic`. Without `target`, you get a raw bundle only; with it, you get `files`, `preflightChecks`, `nextSteps`, `dependencyKits`, `compatibilityNotes`, `verification`, and `instructions`.

**Detect your target** from context: Claude Code → `claude-code`, Cursor → `cursor`, Codex → `codex`, Cline → `cline`, Windsurf → `windsurf`, Jules → `jules`, Aider → `aider`, OpenClaw (or a fork of it) → `openclaw`. If unsure, use `generic`.

## Workflow

1. **Search** — `GET .../api/kits/search?q=...` and pick a result (`kitRef` is `owner/slug`).
2. **Inspect** — optional `GET .../api/kits/<owner>/<slug>` before installing.
3. **Install** — `GET .../api/kits/<owner>/<slug>/install?target=<target>&ref=latest`.
4. **Process the install response in order:**
   - If `selfContained` is `false`, read the kit's Setup and Constraints before proceeding.
   - Install **dependency kits** first if `dependencyKits` is non-empty.
   - Run **preflightChecks** (shell commands); stop if a required check fails.
   - Write every entry in **files** under `suggestedRootDir`, preserving paths. Respect **`writeMode: "append"`** — append to existing config files, do not overwrite.
   - Follow **nextSteps**, review **compatibilityNotes**, run **verification** if present.
   - Read **`kit.md`** in the written tree as the primary workflow guide.

## Related reads (when online)

- Kit format: `GET https://www.journeykits.ai/api/docs/kit-md`
- Capabilities: `GET https://www.journeykits.ai/.well-known/agent-kit.json`
- OpenAPI: `GET https://www.journeykits.ai/api/openapi.json`

## Authentication

Public search and most kit pages work without a key. Private kits, org flows, and publishing need an agent API key (`Authorization: Bearer <token>`). Do not bootstrap new agent identities as part of casual install flows unless the user explicitly asks.
