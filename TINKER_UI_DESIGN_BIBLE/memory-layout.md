---
file: memory-layout.md
purpose: Where memory lives under the workspace, who writes it, retention policy
audience: AI
last_verified: 2026-05-11
last_verified_commit: HEAD
single_owner: yes — directory map + writer + retention live here
see_also: topology.md (workspace symlinks), crons.md (writers), pii-boundary.md (everything under workspace/memory is PRIVATE)
---

# Memory layout — workspace directory map

All paths below are under `~/.openclaw/workspace/memory/` unless otherwise noted. This entire tree is PRIVATE (lives in jarvis-brain GitLab repo). It is NEVER symlinked into public tinkerclaw.

## Directory map

### `people/` — people-profile cards

- **Writer:** `tinkerclaw-people` plugin (via `people.update_consulted_at`) + the `people-profiles` cron (auto-generation from WhatsApp inbound).
- **Reader:** `tinkerclaw-people` plugin (`people.{resolve,read,list}` RPCs); auto-reply pipeline (sender-profile prefetch via `people-prefetch.ts`).
- **Layout:** `people/<slug>/profile.md` + aliases file.
- **Cardinality:** ~1014 aliases / ~1223 profile files (2026-05-04 snapshot).
- **Retention:** unbounded; consolidation cron removes stale alias mappings.

### `morning-briefings/`

- **Writer:** `morning-briefing` cron at 07:00; user `/new` flow may also append a user-pass.
- **Reader:** Tinker UI `/new` flow, user.
- **Layout:** `YYYY-MM-DD.md` (cumulative passes) + `YYYY-MM-DD-preflight.json` (preflight matrix).
- **Critical:** cron pass = audit; user `/new` = pass-1. See M8 in failures.md.

### `knowledge/`

- **Writer:** mostly hand (Jarvis adds knowledge files at user request).
- **Reader:** memorySearch retrieval, ad-hoc reads.
- **Notable files:** `INDEX.md`, `evolution-log.md`, `ripple-tracker.md`, `tinkerclaw-cc-bridge.md`, `tinkerclaw-people-plugin.md`, `tinkerclaw-whatsapp-plugin.md`, `wa-owner-prefix-invariant.md`, `whatsapp-strategy.md`, `cost-aware-model-routing.md`, `hermes-agent-analysis.md`, `operational-lessons.md`, `serra-projects-state.md`.

### `butler-log/`

- **Writer:** `life-butler` cron + user-facing butler interactions.
- **Reader:** morning-briefing cron (carryover), Jarvis context.
- **Layout:** `INDEX.md`, `butler-scope.md`, `dates-registry.md` (anniversaries / birthdays / flowers), `YYYY-MM-DD.md` per day.

### `online-presence/`

- **Writer:** `online-engagement` cron.
- **Reader:** morning-briefing (online income priority axis).
- **Layout:** `engagement-state.json` + `YYYY-MM-DD.md` daily.

### `security-reports/`

- **Writer:** `security-updates-check` cron.
- **Layout:** `META.md` + `YYYY-MM-DD-report.md` daily.

### `self-evolution/`

- **Writer:** `self-evolution` cron.
- **Layout:** `index.md`, `model-intelligence-state.json`, `YYYY-MM-DD.md` daily.

### `spiritual-tech/`

- **Writer:** `spiritual-tech` cron.
- **Layout:** `interests.md`, `ethics-codex.md`, `YYYY-MM-DD.md` daily.

### `whatsapp-summaries/`

- **Writer:** wind-down or related cron (TBD; confirm).
- **Layout:** `YYYY-MM-DD.md` per day.

### `consolidation-logs/`

- **Writer:** `cleaning-lady` (memory consolidation) cron.
- **Layout:** `YYYY-MM-DD.md` daily.

### `maintenance-reports/`

- **Writer:** `fork-scanner` cron + ad-hoc.
- **Layout:** `YYYY-MM-DD.md` + `YYYY-MM-DD-fork-sync.md` + `YYYY-MM-DD-wind-down.md`.

### `cron-receipts/`

- **Writer:** cron scheduler itself.
- **Layout:** `YYYY-MM-DD-<jobId>.json` per run.
- **Note:** this is a flat archive of run outcomes; the rolling `~/.openclaw/cron/runs/<jobId>.jsonl` is the live tail.

### `bugs/`

- **Writer:** Jarvis when documenting unresolved bug reports.
- **Layout:** `INDEX.md` + `BNNN-<slug>.md` files.

### `ai-research/`

- **Writer:** Jarvis tracking external AI development.
- **Layout:** `agent-oss-tracklist.json`, `fork-watchlist.json`, `fork-survey/YYYY-MM-DD.md`.

### `chat-profiles/`

- **Writer:** auto-reply pipeline writing per-chat config (chat-rhythm settings, response policy overrides).
- **Layout:** per chat-jid subdirectories.

### `shopping/`

- **Writer:** marketplace-watcher cron, ad-hoc.
- **Layout:** `watchlist-state.json`.

## Engram + compaction state

- `consolidation-state.json` — top-level pointer for the memory consolidation engine (engram pointer-mode, ENGRAM_POINTER_COMPACTION=1).
- See J1 (ENGRAM) and J14 (MNEMOSYNE) for the full memory-engine theory.

## Retention

- **Daily dirs** (`butler-log/YYYY-MM-DD.md`, `self-evolution/YYYY-MM-DD.md`, etc.) — retained indefinitely; cleaning-lady cron consolidates rather than deletes.
- **Cron receipts** — retained indefinitely as audit trail.
- **People profiles** — retained until explicitly archived. Stale aliases (no inbound > 90 days) flagged but not auto-deleted.
- **Knowledge files** — manual lifecycle.

## Writer ↔ reader summary

Writers are mostly crons + the auto-reply pipeline. Readers are mostly Jarvis context-injection at session start and memorySearch retrieval.

The single highest-leverage Reader is `agents.defaults.memorySearch` (Ollama embeddings + FTS hybrid). It indexes EVERYTHING under workspace/memory/ + sessions. Any new directory added under workspace/memory/ will be picked up automatically.

## Don't regress

- Never symlink workspace/memory/ subdirs into the public fork.
- Cron receipts MUST stay as flat JSON (parseable by `cron.lastRun` probe when wired).
- The consolidation-state.json schema is owned by ENGRAM (J1); changes must coordinate.

## Verify

```yaml
verify:
  - cmd: ls ~/.openclaw/workspace/memory/people | head -1 | wc -l
    expect: "integer > 0"
  - cmd: stat -c '%Y' ~/.openclaw/workspace/memory/morning-briefings/$(date +%Y-%m-%d).md 2>/dev/null
    expect: "recent (after today 07:00)" # confirms briefing cron ran
```
