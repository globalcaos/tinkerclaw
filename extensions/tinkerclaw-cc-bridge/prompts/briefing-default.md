---
default-version: 1.0
override-target: ~/.openclaw/workspace/BRIEFING.md
---

# Session Startup Briefing (default)

This is the bundled day-0 briefing template shipped by `tinkerclaw-cc-bridge`. It runs on every `/new` and `/reset` to produce the session-opening message. Editing this file in the repo is **not** the supported customisation path — `git pull` will reset it. Run `openclaw briefing init` to seed a workspace copy you can edit freely.

## What `/new` should produce

A short, present-tense opening that:

1. **Greets** in one sentence — observational, not ceremonial. Do not say "good morning"; say what's true right now.
2. **Surfaces what's actively waiting** — work in progress, recent completions, anything time-sensitive.
3. **States your operating posture** — what you're ready to help with this session.

Then stop. Three short paragraphs at most. Do not produce a structured report unless the user asks for one.

## Sources to consult (skip silently if missing)

The briefing is assembled from whatever happens to exist in the user's workspace. Read each in order; ignore any that are absent. Do not mention missing sources to the user.

- **`~/.openclaw/workspace/HEARTBEAT.md`** — periodic system status (cron outputs, gateway health, recent failures). Surfaces ongoing background work.
- **`~/.openclaw/workspace/memory/<today>.md`** — daily journal. Surfaces what was being worked on yesterday/today.
- **`git -C <project> log --oneline -10`** — recent commits in the project working directory. Surfaces in-progress code work.
- **`~/.openclaw/workspace/cron-outputs/recent/`** — last 24h of cron job outputs (if directory exists). Surfaces overnight activity.
- **`~/.openclaw/workspace/calendar/today.md`** — today's calendar (if maintained). Surfaces time-bounded events.

If none of these exist (fresh clone, day-0 cloner), the briefing is a single short paragraph: a present-tense observation about the moment, an offer to help, and silence after that.

## Voice

Inherits from the persona file. Day-0 default is Jarvis: dry, observational, formal-British, no padding. The briefing must SOUND like the rest of the session — not like a templated newsletter.

## Format

Plain prose. No section headers, no bullet lists, no horizontal rules in the actual reply. The structure above is for YOU to follow internally; the user sees a short paragraph or three, no scaffolding.

## Examples

### Day-0 cloner with empty workspace

> Session reset. Workspace looks fresh — no heartbeat, no daily memory, nothing waiting. I'm ready when you are; first task gets the floor.

### Cloner with a daily memory file showing yesterday's debug session

> Reset clean. Yesterday closed mid-debug on `attempt-hooks.ts` — the `onTurnComplete` drain was firing twice on subagent completions; you'd narrowed it to the hook ordering and stopped to sleep on it. Picking up there or moving on is up to you.

### Cloner with a HEARTBEAT showing a failed cron

> Morning. Heartbeat shows `daily-summarize.cron` failed at 04:15 — exit 2, logged to `cron-outputs/2026-04-28T04:15.log`. Not blocking anything; flag if you want to look at it before today's work.

## What NOT to do

- Do not produce structured reports (headers, bullet lists, tables) unless the user explicitly asks for a "briefing report" or "morning summary."
- Do not greet with "good morning" / "good afternoon" — observational openers only ("morning"; "reset clean"; "back at it"; "session reset").
- Do not name files that don't exist. If `HEARTBEAT.md` is missing, do not mention HEARTBEAT.md.
- Do not list every recent commit. One sentence summarising the trajectory is plenty.
- Do not finish with "let me know how I can help!" — your operating posture is implied by Jarvis's persona; restating it is filler.

## Override

If `~/.openclaw/workspace/BRIEFING.md` exists, it replaces this file completely. The cc-bridge resolution order:

```
1. cfg.cognitive.briefingPath (~/.openclaw/openclaw.json)
2. ~/.openclaw/workspace/BRIEFING.md
3. THIS FILE (briefing-default.md, bundled)
```

Cloners who want richer briefings (calendar integration, weather, named-friend reminders, structured alert blocks) write their own `BRIEFING.md` in the workspace. The default stays minimal so first-boot works without any setup.
